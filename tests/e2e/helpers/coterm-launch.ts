import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { AppDatabase } from "../../../src/main/storage/database";
import { Repository } from "../../../src/main/storage/repository";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

export interface LaunchedCoterm {
  app: ElectronApplication;
  page: Page;
  userData: string;
  logPath: string;
  close: () => Promise<void>;
}

export interface SeedOptions {
  theme?: "light" | "dark";
  onboardingCompleted?: boolean;
  defaultWorkspacePath?: string;
  agentApiEnabled?: boolean;
  voiceEnabled?: boolean;
  voiceSttUrl?: string;
  voiceSttModel?: string;
  voiceStreamingDictation?: boolean;
  agentapiVoiceAgent?: boolean;
  voiceTestHarness?: boolean;
  seedProject?: boolean;
  /** f2: additional project names (same workspace path). Default: just "TestProject". */
  projectNames?: string[];
  /** f2: provider sessions seeded so sidebar history has resumable rows. */
  seededSessions?: Array<{
    projectName?: string;
    title: string;
    profileId: string;
    nativeSessionId: string;
  }>;
  initScripts?: string[];
  mobileViewport?: boolean;
}

/**
 * Launch an isolated Coterm Electron app with a temp userData dir and seeded
 * settings. Mirrors the contract in ui-action-audit.spec.ts so every UI-action
 * scenario shares the same privacy-safe audit-log oracle.
 */
export async function launchCoterm(seed: SeedOptions = {}): Promise<LaunchedCoterm> {
  const userData = await mkdtemp(join(tmpdir(), "coterm-action-"));
  const database = new AppDatabase(join(userData, "ai-terminal.sqlite"));
  await database.open();
  const repository = new Repository(database);
  const base = repository.getSettings();
  const workspacePath = seed.defaultWorkspacePath ?? process.cwd();
  await repository.setSettings({
    ...base,
    ...(seed.theme ? { theme: seed.theme } : {}),
    onboardingCompleted: seed.onboardingCompleted ?? true,
    defaultWorkspacePath: workspacePath,
    // Checkpoint button defaults off since 1.5.50; e2e keeps auditing it.
    checkpoint: { ...base.checkpoint, topbarButton: true },
    // Reading-mode button defaults off since 1.5.59; e2e keeps auditing it.
    readingMode: { ...base.readingMode, topbarButton: true },
    agentApi: { ...base.agentApi, enabled: seed.agentApiEnabled ?? base.agentApi.enabled },
    voice: {
      ...base.voice,
      enabled: seed.voiceEnabled ?? base.voice.enabled,
      sttUrl: seed.voiceSttUrl ?? base.voice.sttUrl,
      sttModel: seed.voiceSttModel ?? base.voice.sttModel,
      streamingDictation: seed.voiceStreamingDictation ?? base.voice.streamingDictation,
    },
    agentapi: {
      ...base.agentapi,
      voiceAgent: seed.agentapiVoiceAgent ?? base.agentapi.voiceAgent,
    },
  });
  // Seed a project directly via the repository so scenarios that need a
  // project (sidebar/explorer/picker/terminal) don't have to drive the native
  // folder picker, which is unavailable in headless Electron E2E.
  if (seed.seedProject !== false) {
    await repository.createProject("TestProject", workspacePath);
    for (const name of seed.projectNames ?? []) {
      await repository.createProject(name, workspacePath);
    }
    // f2: sidebar session branches need provider sessions with native ids.
    for (const session of seed.seededSessions ?? []) {
      const projects = repository.listProjects();
      const project = projects.find((p) => p.name === (session.projectName ?? "TestProject"));
      if (!project) throw new Error(`seededSessions: project not found: ${session.projectName}`);
      const conversation = await repository.createConversation(project.id, session.title, session.profileId);
      const providerSession = await repository.getOrCreateProviderSession(conversation.id, session.profileId);
      await repository.updateProviderSession(providerSession.id, { nativeSessionId: session.nativeSessionId });
    }
  }
  database.close();

  const application = await electron.launch({
    executablePath: electronPath,
    args: [".", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      COTERM_USER_DATA_DIR: userData,
      // Offscreen rendering + backgroundThrottling off (COTERM_E2E_HEADLESS
      // branch in src/main/index.ts). A real headed E2E window stops receiving
      // BeginFrames as soon as any other window fully covers it — rAF never
      // fires and Playwright's visible/enabled/stable click wait hangs, flakily
      // under concurrent desktop use. Offscreen keeps frames flowing no matter
      // what is on the desktop; pointer clicks and screenshots still work.
      COTERM_E2E_HEADLESS: "1",
      ...(seed.mobileViewport ? { COTERM_E2E_MOBILE_VIEWPORT: "1" } : {}),
      ...(seed.voiceTestHarness ? { COTERM_E2E_VOICE_HARNESS: "1" } : {}),
      NODE_ENV: "production",
    },
  });

  // Init scripts run before any page script, so matchMedia can be overridden
  // before useIsMobile reads it (needed for the mobile-dock branch, which the
  // desktop BrowserWindow's minWidth:1024 would otherwise hide).
  if (seed.initScripts) {
    for (const script of seed.initScripts) {
      await application.context().addInitScript(script);
    }
  }

  const page = await application.firstWindow();
  const logPath = join(userData, "logs", "coterm.log");
  const close = async (): Promise<void> => {
    await application.close();
    // Chromium may release Network/Trust Tokens a few milliseconds after the
    // Electron process exits on Windows. Retry temp cleanup so a passed UI
    // scenario is not misreported as FAIL because of an antivirus/file lock.
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };

  return { app: application, page, userData, logPath, close };
}

/**
 * Read ui.action entries from the isolated coterm.log. Each entry is a
 * privacy-safe record: actionId, surface, controlType, interaction, identified.
 */
export async function readUiActions(path: string): Promise<Array<Record<string, unknown>>> {
  try {
    return (await readFile(path, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.msgCode === "ui.action");
  } catch {
    return [];
  }
}

export async function waitForAction(page: Page, actionId: string, state: "attached" | "visible" = "visible"): Promise<void> {
  const locator = page.locator(`[data-action-id="${actionId}"]`);
  if (state === "visible") {
    await locator.first().waitFor({ state: "visible" });
  } else {
    await locator.first().waitFor({ state: "attached" });
  }
}
