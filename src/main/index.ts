import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { app, BrowserWindow, clipboard, Menu, Notification, screen, shell } from "electron";
import { AppEventBus } from "./core/event-bus";
import { resolveAppIdentity } from "./core/app-identity";
import { AgentDoneToastNotifier } from "./notify/agent-done-toast";
import { ensureAgentShims } from "./providers/agent-shims";
import { resolveCodexTeamTemplateDir } from "./providers/codex-team-setup";
import { ensureCotermAtSetup, resolveCotermAtTemplateDir } from "./providers/coterm-at-setup";
import { AppDatabase } from "./storage/database";
import { Repository } from "./storage/repository";
import { runStorageHousekeeping } from "./storage/housekeeping";
import { ApprovalBroker, type ApprovalSignalListener } from "./core/approval-broker";
import { ClaudeAdapter } from "./providers/claude-adapter";
import { buildActiveProfiles } from "./providers/profiles-config";
import { CodexAppServer } from "./providers/codex-app-server";
import { HandoffManager } from "./core/handoff-manager";
import { RunCoordinator } from "./core/run-coordinator";
import { CouncilScheduler } from "./providers/council-scheduler";
import { PtyManager } from "./terminal/pty-manager";
import { JevVerifier } from "./terminal/jev-verifier";
import { UsageMonitor } from "./terminal/usage-monitor";
import { ActivityMonitor } from "./terminal/activity-monitor";
import { WorktreeRegistry } from "./terminal/worktree-registry";
import { ContextBatteryMonitor } from "./terminal/context-meter";
import { codexProfileHomesFor } from "./providers/agent-shims";
import { registerIpc } from "./ipc/register-ipc";
import { startVoiceKeepalive } from "./voice/warmup";
import { safeErrorMessage } from "./security/redaction";
import { initLogger, logger, writeCrashLog } from "./core/logger";
import { AppOperations } from "./core/app-operations";
import { ConversationSummarizer } from "./core/conversation-summarizer";
import { TerminalHandoffService } from "./core/terminal-handoff-service";
import { AgentApiOrchestrator } from "./core/agentapi-orchestrator";
import { AgentApiProductionRuntime } from "./core/agentapi-production-runtime";
import { AgentApiStateService } from "./core/agentapi-state-service";
import { AgentApiVoiceOrchestrator } from "./core/agentapi-voice-orchestrator";
import { AgentSemanticProjector } from "./core/agentapi-semantic-projector";
import { SessionSemanticStore } from "./core/session-semantic-store";
import { PendingInteractionStore } from "./core/agentapi-pending-interaction-store";
import { ClaudeHistory } from "./core/claude-history";
import { SessionIndex } from "./core/session-index";
import { AttentionCenter } from "./core/attention-center";
import { AgentMailbox } from "./core/agent-mailbox";
import { SessionWaitCoordinator } from "./core/session-wait-coordinator";
import { WorktreeManager } from "./core/worktree-manager";
import { CheckpointManager } from "./core/checkpoint-manager";
import { createCloudflareAccessVerifier, createTailscaleVerifier, type AccessVerifier } from "./web/access-auth";
import { existsSync, readFileSync } from "node:fs";
import { readStoredWebConfig, readWebConfig } from "./web/web-config";
import { bindWebOperations } from "./web/routes";
import { startWebServer, type RunningWebServer } from "./web/web-server";
import { shouldOpenDesktop } from "./core/launch-mode";
import type { NormalizedEvent } from "../shared/types";
import { BrowserRuntimeManager } from "./browser/browser-runtime-manager";
import { computeAgentBrowserWindowPlacement } from "./browser/window-placement";
import { parseAllowedHosts } from "./browser/browser-policy";
import { BrowserApprovalService } from "./browser/browser-approval-service";
import { BrowserSecretVault } from "./browser/browser-secret-vault";
import { VoiceSessionRepository } from "./voice/live/voice-session-repository";
import { PersistentVoiceSessionController } from "./voice/live/persistent-voice-session-controller";
import { PersistentVoiceSurface } from "./voice/live/persistent-voice-surface";
import { LiveVoiceDuplexService } from "./voice/live/live-voice-duplex-service";

const SHUTDOWN_TIMEOUT_MS = 15_000;

// Channel identity (stable vs side-by-side Beta) decides userData, the
// remote-config dir, the default Agent API port, and the window/app name.
// Beta builds (any prerelease version, or COTERM_CHANNEL=beta) NEVER
// resolve to the stable "%APPDATA%\Coterm" dir — every channel-owned
// resource under userData (SQLite, settings, browser profiles, token) is
// isolated by this one decision.
const identity = resolveAppIdentity(app.getVersion());
app.setName(identity.productName);
// Windows toast notifications (agent done / needs-input) group under the app's
// AppUserModelId — without this, the Windows shell shows an unnamed host row.
app.setAppUserModelId(identity.appId);
if (process.env.COTERM_USER_DATA_DIR) {
  app.setPath("userData", process.env.COTERM_USER_DATA_DIR);
} else {
  app.setPath("userData", join(app.getPath("appData"), identity.userDataDirName));
}

let mainWindow: BrowserWindow | null = null;
let cleanupIpc: (() => Promise<void> | void) | null = null;
let database: AppDatabase | null = null;
let runs: RunCoordinator | null = null;
let council: CouncilScheduler | null = null;
let terminals: PtyManager | null = null;
let approvals: ApprovalBroker | null = null;
let webServer: RunningWebServer | null = null;
let usageMonitor: UsageMonitor | null = null;
let activityMonitor: ActivityMonitor | null = null;
let agentDoneToast: AgentDoneToastNotifier | null = null;
let worktreeRegistry: WorktreeRegistry | null = null;
let contextBattery: ContextBatteryMonitor | null = null;
let attentionCenter: AttentionCenter | null = null;
let agentMailbox: AgentMailbox | null = null;
let waitCoordinator: SessionWaitCoordinator | null = null;
let voiceKeepaliveStop: (() => void) | null = null;
let agentapi: AgentApiOrchestrator | null = null;
let agentapiReviewer: CodexAppServer | null = null;
let agentapiState: AgentApiStateService | null = null;
let agentapiSemanticProjector: AgentSemanticProjector | null = null;
let liveVoiceDuplex: LiveVoiceDuplexService | null = null;
let brokerSignalUnsubscribe: (() => void) | null = null;
let attentionEventListener: ((event: NormalizedEvent) => void) | null = null;
let eventBus: AppEventBus | null = null;
let quitting = false;
let dailySummary: (() => Promise<{ summarized: number; skipped: number; failed: number }>) | null = null;
let dailySummaryPending = false;
let browserRuntime: BrowserRuntimeManager | null = null;
let browserApproval: BrowserApprovalService | null = null;
let browserSecrets: BrowserSecretVault | null = null;

/**
 * Extra artifact-preview roots from `<userData>/artifact-roots.txt` (one absolute path per line,
 * `#` comments allowed). Read on demand so editing the file takes effect without a restart.
 */
function readArtifactRoots(): string[] {
  try {
    return readFileSync(join(app.getPath("userData"), "artifact-roots.txt"), "utf8")
      .split(/\r?\n/).map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
  } catch {
    return []; // absent file is the normal case
  }
}

process.on("unhandledRejection", (reason) => {
  logger.warn("app", "process.unhandledRejection", "Unhandled promise rejection", { reason: safeErrorMessage(reason) });
});
process.on("uncaughtException", (error) => {
  // identity already resolved at module top — userData is the channel-owned dir.
  writeCrashLog(error, app.getPath("userData"));
  logger.error("app", "process.uncaughtException", "Uncaught exception", { error: safeErrorMessage(error) });
  process.exit(1);
});

/** Opt-in frosted-glass window: env COTERM_GLASS=1 or an empty `<userData>/glass.flag` file. Windows 11 only. */
function glassEnabled(): boolean {
  if (process.platform !== "win32") return false;
  if (process.env.COTERM_GLASS === "1") return true;
  try {
    return existsSync(join(app.getPath("userData"), "glass.flag"));
  } catch {
    return false;
  }
}

async function createWindow(): Promise<void> {
  logger.audit("app", "window.create", "Window created");
  // No app code ever installs a menu, but Electron silently uses its DEFAULT
  // menu when none is set — and autoHideMenuBar only hides it VISUALLY. The
  // default View role keeps firing its accelerators, so a stray F11 (or a
  // terminal app that releases the key through) toggled the whole window into
  // native fullscreen, covering the Windows taskbar — the "occasional
  // fullscreen" bug. Remove the menu so F11/Ctrl+R/Ctrl+Plus/… are inert.
  Menu.setApplicationMenu(null);
  const e2eMobileViewport = process.env.COTERM_E2E_MOBILE_VIEWPORT === "1";
  const glass = glassEnabled();
  // 隱藏原生標題列：目前只在 glass 實驗模式啟用（一般版先維持原樣，記在 memory）
  const hiddenTitleBar = glass && !e2eMobileViewport;
  mainWindow = new BrowserWindow({
    width: e2eMobileViewport ? 390 : 1480,
    height: e2eMobileViewport ? 844 : 940,
    minWidth: e2eMobileViewport ? 320 : 1024,
    minHeight: e2eMobileViewport ? 480 : 700,
    backgroundColor: "#081016",
    // Windows：隱藏原生白色標題列，改由 app 自己的頂欄當標題列；右上角縮小/放大/關閉保留並上色
    ...(hiddenTitleBar
      ? {
          titleBarStyle: "hidden" as const,
          titleBarOverlay: { color: "#00000000", symbolColor: "#d4d4d4", height: 40 },
        }
      : {}),
    title: identity.productName,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      // Hidden E2E windows still need frames for real pointer/stability checks.
      ...(process.env.COTERM_E2E_HEADLESS === "1" ? { offscreen: true, backgroundThrottling: false } : {}),
      preload: join(__dirname, "../preload/index.cjs"),
      additionalArguments: [...(glass ? ["--coterm-glass=1"] : []), ...(hiddenTitleBar ? ["--coterm-titlebar=1"] : [])],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  const navigationContents = mainWindow.webContents;
  navigationContents.on("will-navigate", (event, url) => {
    // Recover the current renderer without permitting navigation elsewhere.
    if (url !== navigationContents.getURL()) event.preventDefault();
  });
  // Escape hatch (2026-10-09 png-click handoff): the app menu is removed
  // (Menu.setApplicationMenu(null)), so there is no built-in reload — register
  // Ctrl+Shift+R on the main window only as a last-resort renderer reload.
  // Prior grep found no other before-input-event handler in src (no collision).
  const mainWebContents = mainWindow.webContents;
  // Whole-UI zoom (sidebar, top bar, terminals alike) for small screens — e.g.
  // a laptop remoting into the 27" desktop sees every pixel shrunk. The menu
  // that normally owns Ctrl+Plus/Minus is removed, so handle them here and
  // remember the factor across restarts.
  const zoomFile = join(app.getPath("userData"), "ui-zoom.json");
  const ZOOM_STEPS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  let uiZoom = 1;
  try {
    const saved = Number((JSON.parse(readFileSync(zoomFile, "utf8")) as { factor?: unknown }).factor);
    if (Number.isFinite(saved) && saved >= ZOOM_STEPS[0]! && saved <= ZOOM_STEPS.at(-1)!) uiZoom = saved;
  } catch {
    // no saved zoom yet
  }
  const applyZoom = (factor: number): void => {
    uiZoom = factor;
    if (!mainWebContents.isDestroyed()) mainWebContents.setZoomFactor(factor);
    void writeFile(zoomFile, JSON.stringify({ factor })).catch(() => undefined);
  };
  mainWebContents.on("did-finish-load", () => mainWebContents.setZoomFactor(uiZoom));
  mainWebContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.control && input.shift && (input.key === "R" || input.key === "r")) {
      event.preventDefault();
      mainWebContents.reload();
      return;
    }
    if (!input.control || input.alt || input.meta) return;
    const code = input.code;
    if (code === "Equal" || code === "NumpadAdd") {
      event.preventDefault();
      applyZoom(ZOOM_STEPS.find((step) => step > uiZoom + 0.001) ?? uiZoom);
    } else if ((code === "Minus" && !input.shift) || code === "NumpadSubtract") {
      event.preventDefault();
      applyZoom([...ZOOM_STEPS].reverse().find((step) => step < uiZoom - 0.001) ?? uiZoom);
    } else if ((code === "Digit0" || code === "Numpad0") && !input.shift) {
      event.preventDefault();
      applyZoom(1);
    }
  });
  // A crashed or killed renderer leaves the window painting nothing while
  // main and every PTY stay alive (mobile keeps working) — and nothing was
  // logged. Record it and reload the page once the crash is real; capped so a
  // renderer that dies on load cannot spin. Metadata only (logging §A.2).
  const rendererReloads: number[] = [];
  mainWebContents.on("render-process-gone", (_event, details) => {
    logger.error("app", "app.renderer.gone", "Main window renderer process gone", {
      reason: details.reason,
      exitCode: details.exitCode,
    });
    if (details.reason === "clean-exit" || mainWebContents.isDestroyed()) return;
    const now = Date.now();
    while (rendererReloads.length && now - rendererReloads[0]! > 5 * 60_000) rendererReloads.shift();
    if (rendererReloads.length >= 3) return;
    rendererReloads.push(now);
    mainWebContents.reload();
  });
  mainWindow.on("unresponsive", () => {
    logger.warn("app", "app.renderer.unresponsive", "Main window renderer stopped responding");
  });
  mainWindow.on("responsive", () => {
    logger.info("app", "app.renderer.responsive", "Main window renderer responsive again");
  });
  if (glass) {
    mainWindow.webContents.on("dom-ready", () => {
      void mainWindow?.webContents.executeJavaScript('document.documentElement.dataset.glass="1"').catch(() => undefined);
    });
  }
  mainWindow.once("ready-to-show", () => {
    if (process.env.COTERM_E2E_HEADLESS !== "1") mainWindow?.show();
  });
  // HTML fullscreen (artifact viewers' requestFullscreen — presentation/video)
  // also swallows the taskbar, and if the fullscreen element unmounts without
  // the fullscreen session closing, the window can stay stuck fullscreen.
  // Log both directions so a recurrence is greppable in coterm.log; the
  // renderer-side unmount cleanup in the viewers exits the session cleanly.
  mainWindow.webContents.on("enter-html-full-screen", () => {
    logger.info("app", "window.fullscreen.html.enter", "Renderer entered HTML fullscreen");
  });
  mainWindow.webContents.on("leave-html-full-screen", () => {
    logger.info("app", "window.fullscreen.html.leave", "Renderer left HTML fullscreen");
  });
  mainWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow?.hide();
    logger.audit("app", "window.hide", "Window hidden on close");
  });
  mainWindow.once("closed", () => {
    mainWindow = null;
  });
  // Electron denies permission requests by default (no handler set), so desktop
  // dictation's getUserMedia died instantly — grant mic for OUR window only,
  // deny everything else (same as the default for the rest). Clipboard write is
  // also ours: drag-to-select inside full-screen agents copies on release, and
  // a denied write there was a silent "copied nothing".
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(webContents === mainWindow?.webContents && (permission === "media" || permission === "clipboard-sanitized-write"));
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

async function bootstrap(): Promise<void> {
  initLogger({ userDataDir: app.getPath("userData") });
  if (process.platform !== "win32") {
    logger.warn(
      "app",
      "app.bootstrap.platform",
      "Platform compatibility: Coterm is Windows-first. macOS/Linux support is experimental and untested.",
      { platform: process.platform },
    );
  }
  logger.info("app", "app.bootstrap", "Coterm bootstrap starting");
  // Codex Team config template dir from the bundling contract: packaged →
  // resources/codex-team, dev → tools/codex-team. ensureAgentShims renders the
  // bundled codex-team.config.toml.example from here.
  const codexTeamTemplateDir = resolveCodexTeamTemplateDir({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  const events = new AppEventBus();
  eventBus = events;
  database = new AppDatabase(join(app.getPath("userData"), "ai-terminal.sqlite"));
  await database.open();
  const repository = new Repository(database);
  // #51: refresh per-profile launcher shims + put their dir on PATH so the
  // launch command (and manual typing) is a single clean command, not an env wall.
  // Hot model registry: shims derive from the ACTIVE table so custom profiles
  // in settings get their own launcher on start.
  try {
    ensureAgentShims(app.getPath("userData"), repository.getSettings().proxyUrl, {
      profileTable: buildActiveProfiles(repository.getSettings().customProfiles),
      codexTeamTemplateDir,
    });
  } catch (error) {
    logger.warn("provider", "agent.shims.failed", "Agent launcher shim generation failed.", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  // Agent mail (cot CLI): ship the Claude skill + Codex AGENTS.md block that
  // teach panes how to mail each other. Best-effort; a user-edited copy wins.
  ensureCotermAtSetup({
    templateDir: resolveCotermAtTemplateDir({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    }),
  });
  await repository.recoverInterruptedRuns();
  approvals = new ApprovalBroker();
  const claude = new ClaudeAdapter(
    () => repository.getSettings().proxyUrl,
    approvals,
    // Hot model registry: getter (not snapshot) so each run resolves
    // DEFAULT_PROFILES ⊕ settings.customProfiles fresh from the DB.
    () => buildActiveProfiles(repository.getSettings().customProfiles),
  );
  const codex = new CodexAppServer(approvals);
  const codexCustomProfiles = () => repository.getSettings().customProfiles;
  const codexGlm = new CodexAppServer(approvals, "codex-local-main", () => repository.getSettings().proxyUrl, {}, codexCustomProfiles);
  const codexLocalMax = new CodexAppServer(approvals, "codex-local-max", () => repository.getSettings().proxyUrl, {}, codexCustomProfiles);
  const codexQwen = new CodexAppServer(approvals, "codex-local-long", () => repository.getSettings().proxyUrl, {}, codexCustomProfiles);
  const codexLocalLong2 = new CodexAppServer(approvals, "codex-local-long2", () => repository.getSettings().proxyUrl, {}, codexCustomProfiles);
  const handoffs = new HandoffManager(repository);
  council = new CouncilScheduler(repository, events, claude);
  // Cross-pane agent mail (@-mentions). Constructed before PtyManager so the
  // spawn hook can inject COTERM_MAIL_* env into every PTY; terminal accessors
  // are bound right after (late binding: PtyManager is created here).
  agentMailbox = new AgentMailbox({
    events,
    onPairPaused: (aId, bId) => {
      for (const terminalId of [aId, bId]) {
        const projectId = terminals?.get(terminalId)?.projectId;
        if (projectId) attentionCenter?.fileExternalNotification({ terminalId, projectId });
      }
    },
  });
  terminals = new PtyManager(
    events,
    repository.getSettings().claudeKeepaliveHours,
    app.getPath("userData"),
    {
      // #50/#51: production wiring for the cold-start hook — Phase 4
      // consumers (HUD/Agent API) subscribe on the bus; PtyManager also logs
      // `pty.coldstart` for the log sink.
      onColdStartTiming: (timing) => events.emit("coldStartTiming", timing),
      // Jev 注意力複判 — reads settings live, so toggling it needs no restart.
      jevVerifier: new JevVerifier(() => repository.getSettings().jev ?? null),
      agentMail: agentMailbox,
    },
  );
  agentMailbox.bind({
    getState: (terminalId) => terminals?.getPtyState(terminalId) ?? null,
    getScreenRuleId: (terminalId) => terminals?.getScreenRuleId(terminalId) ?? null,
    getContext: (terminalId) => {
      const info = terminals?.get(terminalId);
      return info
        ? { agentProfile: info.agentProfile, cwd: info.cwd, projectId: info.projectId }
        : null;
    },
    deliver: (terminalId, data) => {
      try {
        terminals?.write(terminalId, data, "automation");
        return true;
      } catch {
        return false;
      }
    },
  });
  await terminals.startAgentDetection();
  const summarizer = new ConversationSummarizer(repository, [claude]);
  dailySummary = () => summarizer.summarizeStale();
  const claudeHistory = new ClaudeHistory(join(app.getPath("home"), ".claude", "projects"));
  const sessionIndex = new SessionIndex(
    join(app.getPath("userData"), "session-index.db"),
    join(app.getPath("home"), ".claude", "projects"),
  );
  const storedConfigPath = join(process.env.LOCALAPPDATA ?? app.getPath("appData"), identity.configDirName, "remote-config.json");
  const storedConfig = process.env.COTERM_USER_DATA_DIR
    ? null
    : await readStoredWebConfig(storedConfigPath, process.env, identity.defaultWebPort);
  // Construct before AppOperations so its dependency is never undefined.
  // It subscribes immediately; later broker/provider bridges feed the same
  // PtyManager state chokepoint without guessing a terminal association.
  attentionCenter = new AttentionCenter({ userDataPath: app.getPath("userData"), events });
  await attentionCenter.load();
  // Session wait coordinator (issue #4): event-driven wait primitive for the
  // Agent API. Reads canonical PtyState from PtyManager; subscribes to the
  // shared event bus. Shutdown is hooked through the web server close path.
  waitCoordinator = new SessionWaitCoordinator({
    events,
    readState: (terminalId) => terminals?.getPtyState(terminalId) ?? null,
  });
  // Usage HUD monitor: constructed before AppOperations so its dependency is
  // never undefined. Started after the web server is wired (below) so the
  // first tick's emit reaches subscribed clients.
  usageMonitor = new UsageMonitor({ events });
  activityMonitor = new ActivityMonitor({ listRoots: () => terminals?.liveCwds() ?? [] });
  // Session worktree registry (2026-10-12): read-only baseline diff of
  // `git worktree list --porcelain` over project folders + live terminal cwds;
  // detects worktrees agents create (and forget) this session.
  worktreeRegistry = new WorktreeRegistry({
    listRoots: () => [
      ...repository.listProjects().map((project) => project.workspacePath),
      ...(terminals?.liveCwds() ?? []),
    ],
  });
  // #92: a getter, not a startup snapshot. The private-home set is derived from
  // the ACTIVE profile table (same predicate the shim writer uses), so a
  // profile hot-registered after launch is metered from its own CODEX_HOME at
  // the next poll instead of falling back to ~/.codex and losing its title.
  contextBattery = new ContextBatteryMonitor({
    terminals,
    codexProfileHomes: () => codexProfileHomesFor(
      app.getPath("userData"),
      buildActiveProfiles(repository.getSettings().customProfiles),
    ),
    getCustomProfiles: () => repository.getSettings().customProfiles,
    claudeTierCachePath: join(app.getPath("userData"), "claude-context-tiers.json"),
  });
  // Browser runtime is lazy: Chromium is not launched until an agent or user
  // creates a session. Renderer only sees typed IPC methods, never Playwright
  // Browser/Page objects.
  browserApproval = new BrowserApprovalService({
    broker: approvals,
    timeoutMs: 30_000,
    approvalModeProvider: () => repository.getSettings().browserApproval.mode,
    // Issue #93: every action that rides an existing session grant still gets
    // one audit line, so "the human was asked once" never means "nothing was
    // recorded". Metadata only — action, level, origin, session (logging §A.2).
    onAutoApprove: (request) => {
      logger.audit("security", "browser.approval.autoApproved", "Browser action auto-approved by session grant", {
        action: request.action,
        level: request.level,
        origin: request.origin,
        sessionId: request.sessionId,
      });
    },
    onGrant: (sessionId, request) => {
      logger.audit("security", "browser.approval.granted", "Browser session granted blanket approval", {
        sessionId,
        action: request.action,
        level: request.level,
        origin: request.origin,
      });
    },
  });
  browserSecrets = new BrowserSecretVault();
  // Browser network policy (issue #48): persisted settings are the source of
  // truth, but env vars (COTERM_BROWSER_ALLOW_PRIVATE / _ALLOW_HOSTS) still win
  // when set — they remain the escape hatch for headless/CI runs that never
  // touch the Settings UI. The provider is read on every navigation, so a
  // Settings toggle takes effect without a relaunch.
  const envAllowPrivate = process.env.COTERM_BROWSER_ALLOW_PRIVATE === "1";
  const envAllowHosts = parseAllowedHosts(process.env.COTERM_BROWSER_ALLOW_HOSTS);
  const browserPolicyProvider = (): { allowPrivateNetwork?: boolean; allowHosts?: ReadonlySet<string> } => {
    const settings = repository.getSettings().browserNetwork;
    const allowPrivateNetwork = envAllowPrivate || settings.mode === "allow-private";
    const allowHosts = envAllowHosts.size > 0
      ? envAllowHosts
      : new Set(settings.mode === "allow-hosts" ? settings.allowHosts : []);
    return { allowPrivateNetwork, allowHosts };
  };
  browserRuntime = new BrowserRuntimeManager({
    userDataPath: app.getPath("userData"),
    workspaceRoot: app.getPath("userData"),
    policyProvider: browserPolicyProvider,
    loopbackPort: () => webServer?.port ?? null,
    previewRoots: () => [...repository.listProjects().map((project) => project.workspacePath), app.getPath("temp"), app.getPath("userData")],
    requestApproval: (request) => browserApproval?.request(request) ?? Promise.resolve(false),
    // Issue #93: session-state plumbing both ways — the manager reports which
    // sessions are in no-questions mode, and tells the approval service when a
    // session closes so its grant is revoked with it.
    isSessionApprovalGranted: (sessionId) => browserApproval?.isSessionGranted(sessionId) === true,
    onSessionClosed: (sessionId) => browserApproval?.revokeSession(sessionId),
    // Agent browser popout (user request 2026-10-09): sessions the agent creates
    // WITHOUT an explicit mode run as a real Chromium window, placed away from
    // the Coterm main window. Placement is computed at launch time from
    // `screen` — the pure function in window-placement.ts stays Electron-free.
    popoutWindowProvider: () => repository.getSettings().agentBrowserWindow === "popout",
    windowPlacementProvider: () => {
      if (repository.getSettings().agentBrowserWindow !== "popout") return null;
      const displays = screen.getAllDisplays().map((display) => ({ id: display.id, workArea: display.workArea }));
      const main = mainWindow
        ? (() => { try { return mainWindow.getBounds(); } catch { return null; } })()
        : null;
      return computeAgentBrowserWindowPlacement(displays, main);
    },
    // Deliberate opt-in exception to the new-session-asks-again default: when
    // agentBrowserFullAccess is on, every NEW browser session starts in
    // no-questions mode via the #93 grantSession — no parallel bypass. secretRef
    // handles and download path containment are NOT affected.
    newSessionAutoGrantProvider: () => repository.getSettings().agentBrowserFullAccess === true,
    grantSession: (sessionId) => browserApproval?.grantSession(sessionId),
    // Phase 7 feature flags (work order §14): read live so a Settings toggle
    // gates superpower dispatch without a relaunch. Core browser actions (tier
    // undefined in the registry) are never gated.
    superpowersProvider: () => {
      const flags = repository.getSettings().browser;
      return { p0: flags.superpowersP0, p1: flags.superpowersP1 };
    },
    resolveSecret: (secretRef) => Promise.resolve(browserSecrets?.resolve(secretRef) ?? (() => { throw new Error("Secret is unavailable."); })()),
    // B4 (§12.2): one-time consumption for batchFill — the handle self-destructs on first use.
    consumeSecret: (secretRef) => Promise.resolve(browserSecrets?.consume(secretRef) ?? (() => { throw new Error("Secret is unavailable."); })()),
    onScreenshotSaved: (artifact) => events.emit("browserArtifactSaved", artifact),
  });
  const worktrees = new WorktreeManager({
    repository,
    terminals,
    userDataPath: app.getPath("userData"),
  });
  const checkpointer = new CheckpointManager({
    repository,
    terminals,
    userDataPath: app.getPath("userData"),
    worktrees,
  });
  runs = new RunCoordinator(repository, events, [claude, codex, codexGlm, codexLocalMax, codexQwen, codexLocalLong2], handoffs, checkpointer);
  // A — reconcile stale active worktrees (dir gone out of band) on boot.
  for (const w of repository.listActiveWorktrees()) {
    void worktrees.reconcile(w.id).catch((error) => {
      logger.warn("app", "worktree.reconcile.failed", "Worktree reconcile failed", {
        worktreeId: w.id,
        error: safeErrorMessage(error),
      });
    });
  }
  const operations = new AppOperations({
    repository,
    summarizer,
    claudeHistory,
    sessionIndex,
    runs,
    council,
    approvals,
    terminals,
    attention: attentionCenter,
    usage: usageMonitor,
    activity: activityMonitor,
    worktreeRegistry,
    events,
    appVersion: app.getVersion(),
    userDataPath: app.getPath("userData"),
    clipboardWrite: (text: string) => clipboard.writeText(text),
    tempPath: app.getPath("temp"),
    webServerPort: () => webServer?.port ?? null,
    artifactRoots: readArtifactRoots,
    workspaceShell: shell,
    remoteRoots: process.env.COTERM_REMOTE_ROOTS?.split(";").filter(Boolean) ?? storedConfig?.remoteRoots ?? [],
    worktrees,
    checkpointer,
    browser: browserRuntime,
    codexTeamTemplateDir,
  });
  // Agent done-toast (2026-10-14): native Windows notification when an agent
  // pane finishes a turn or needs a human. Subscribes to ptyStateChanged on
  // the shared bus — the same chokepoint AttentionCenter uses — so
  // pty-manager.ts stays untouched. Skips when the window is focused and the
  // pane is selected; the click focuses the window and selects the pane.
  agentDoneToast = new AgentDoneToastNotifier({
    events,
    getTerminal: (terminalId) => terminals?.get(terminalId) ?? null,
    isEnabled: () => repository.getSettings().agentDoneToast,
    isWindowFocused: () => {
      try {
        return mainWindow?.isFocused() === true;
      } catch {
        return false;
      }
    },
    getSelectedTerminalId: async () => (await operations.getDockLayout()).selectedTerminalId,
    getLastHumanSubmitAt: (terminalId) => terminals?.getLastHumanSubmitAt(terminalId) ?? null,
    showToast: (input) => {
      try {
        const toast = new Notification({ title: input.title, body: input.body, silent: true }); // the owner wants notifications without sound
        toast.on("click", () => {
          try {
            mainWindow?.show();
            mainWindow?.focus();
          } catch {
            // window gone between click and focus — ignore
          }
          void operations.selectTile({ terminalId: input.terminalId }).catch(() => undefined);
        });
        toast.show();
      } catch {
        // Notification API unavailable (e.g. headless CI) — never throw into
        // the state pipeline.
      }
    },
    focusAndSelect: (terminalId) => {
      try {
        mainWindow?.show();
        mainWindow?.focus();
      } catch {
        // window gone — ignore
      }
      void operations.selectTile({ terminalId }).catch(() => undefined);
    },
  });
  // Phase 3 (§8): event-driven, metadata-only AgentApi world state. Reads the
  // SAME chokepoints as the dashboard (PtyManager snapshots + AttentionCenter
  // + dock layout); never touches PTY text. Constructed after operations so
  // the dock source is never undefined.
  agentapiState = new AgentApiStateService({
    events,
    terminals,
    attention: attentionCenter,
    dock: {
      getDockLayout: () => operations.getDockLayout(),
      onLayoutChanged: (callback) => operations.onDockLayoutChanged(callback),
    },
    projects: repository,
  });
  await agentapiState.start();
  const agentapiSemanticStore = new SessionSemanticStore();
  const agentapiPendingStore = new PendingInteractionStore();
  agentapiSemanticProjector = new AgentSemanticProjector({
    events,
    worldState: agentapiState,
    semanticStore: agentapiSemanticStore,
    pendingStore: agentapiPendingStore,
    getTranscript: (terminalId) => operations.getTerminalTranscript(terminalId),
    getScreenText: (terminalId) => terminals?.getScreenSnapshot(terminalId) ?? null,
  });
  agentapiSemanticProjector.start();
  const terminalHandoffs = new TerminalHandoffService(repository, [claude], {
    getTerminal: (terminalId) => terminals?.get(terminalId) ?? null,
    getTranscript: (terminalId) => operations.getTerminalTranscript(terminalId),
    getScrollback: (terminalId, projectId) =>
      terminals?.snapshots(projectId).find((snapshot) => snapshot.info.id === terminalId)?.scrollback ?? "",
    getScrollbackMode: (terminalId) => terminals?.getScrollbackMode(terminalId) ?? null,
    getScreenText: (terminalId) => terminals?.getScreenSnapshot(terminalId) ?? null,
    getState: (terminalId) => terminals?.getPtyState(terminalId) ?? null,
    getStateExplanation: (terminalId) => terminals?.getAgentStateExplanation(terminalId) ?? null,
    getLastCommand: (terminalId) => terminals?.getLastCommand(terminalId) ?? null,
  }, { summaryWorkspacePath: app.getPath("temp") });
  agentapiReviewer = new CodexAppServer(
    approvals,
    "codex-local-main",
    () => repository.getSettings().proxyUrl,
    { forceReadOnly: true, denyApprovalRequests: true, requireLoopbackProxy: true },
    codexCustomProfiles,
  );
  agentapi = new AgentApiOrchestrator(repository, new AgentApiProductionRuntime({
    repository,
    operations,
    worktrees,
    waits: waitCoordinator,
    handoffs: terminalHandoffs,
    reviewer: agentapiReviewer,
  }));
  await agentapi.recover();
  // Phase 6 (§11): voice turn orchestrator — single route for desktop panel
  // and mobile audio alike. Fast paths never touch an LLM; relay intents
  // reuse the exact-once atomic write; every answer is redacted
  // in the orchestrator before it crosses the IPC boundary. The task-center
  // supervisor (deep-path LLM loop) was removed 2026-10-15, so its dep is
  // absent and summary/supervisor turns answer with the disabled text.
  const agentapiVoice = new AgentApiVoiceOrchestrator({
    worldState: agentapiState,
    pendingStore: agentapiPendingStore,
    sendToSession: (input) => operations.writeTerminal({
      terminalId: input.terminalId,
      data: `${input.message}\r`,
      source: "automation",
      clientMutationId: input.clientMutationId,
    }),
    getSettings: () => repository.getSettings(),
  });
  const persistentVoiceController = new PersistentVoiceSessionController({
    repository: new VoiceSessionRepository(database),
    agentapi: agentapiVoice,
  });
  // LiveKit duplex voice (work order 2026-08-16): the service owns the
  // server binary + voice worker; the surface asks it for join info on every
  // session start and silently degrades to chunked dictation on any failure.
  liveVoiceDuplex = new LiveVoiceDuplexService({
    userDataPath: app.getPath("userData"),
    workerEntryPath: join(__dirname, "live-voice-worker.mjs"),
    getSettings: () => repository.getSettings(),
    setSettings: (settings) => repository.setSettings(settings),
    controller: persistentVoiceController,
    logger: {
      info: (event, message, fields) => logger.info("voice", event, message, fields ?? {}),
      warn: (event, message, fields) => logger.warn("voice", event, message, fields ?? {}),
    },
  });
  const persistentVoice = new PersistentVoiceSurface(persistentVoiceController, liveVoiceDuplex);
  await operations.maybePruneOnStart();
  // Startup storage housekeeping (evaluation 2026-09-27 part B): DB backup
  // rotation + caps for app-owned dirs. Fire-and-forget so it never delays
  // boot; the first prune at startup already ran synchronously above.
  void runStorageHousekeeping({ ledgerPath: database.path, userDataPath: app.getPath("userData") })
    .then((summary) => logger.info("storage", "housekeeping", "Startup storage housekeeping completed", { ...summary }))
    .catch((error) =>
      logger.warn("storage", "housekeeping.failed", "Startup storage housekeeping failed", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  // Agent Attention Center: subscribes to ptyStateChanged (filed by PtyManager)
  // + ApprovalBroker signals (only when a real terminalId is present) +
  // NormalizedEvent from the adapter (only when payload carries terminalId).
  // Never guesses a terminal association from selected/project/cwd.
  brokerSignalUnsubscribe = approvals.onSignal((signal) => {
    if (!signal.context) return; // no terminalId → do NOT guess
    if (!("terminalId" in signal.context)) {
      emitBrowserApprovalEvent(events, signal);
      return;
    }
    const { terminalId, projectId } = signal.context;
    if (signal.state === "pending") {
      const state = signal.kind === "approval" ? "approval_required" : "waiting_input";
      terminals!.setPtyState(terminalId, state, "broker");
    } else {
      // resolved → clear the attention state back to running (broker source).
      terminals!.setPtyState(terminalId, "running", "broker");
      void projectId; // projectId carried by the ptyStateChanged event
    }
  });
  attentionEventListener = (event: NormalizedEvent): void => {
    // Only map when the adapter event payload explicitly carries a terminalId.
    // The interactive conversation path has no terminal — those events are
    // ignored here (they flow through the conversation ledger as before).
    const terminalId = event.payload?.terminalId;
    if (typeof terminalId !== "string") return;
    if (event.type === "approval.requested") {
      terminals!.setPtyState(terminalId, "approval_required", "provider");
    } else if (event.type === "user_input.requested") {
      terminals!.setPtyState(terminalId, "waiting_input", "provider");
    } else if (event.type === "approval.resolved" || event.type === "user_input.resolved") {
      terminals!.setPtyState(terminalId, "running", "provider");
    }
  };
  events.on("event", attentionEventListener);
  // Background-build the session FTS index 3s after boot so the first search
  // has something to hit without blocking startup. Errors are non-fatal.
  setTimeout(() => {
    repository.requestSearchIndexSync();
    void sessionIndex.sync(repository.listProjects()).catch((error) => {
      logger.warn("app", "sessionIndex.sync.startup.failed", "Startup session index sync failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, 3000);
  // Warm the Claude history metadata cache ~15s after boot so the first
  // project-history click is instant. Fire-and-forget: startup stays
  // unblocked and warm errors are non-fatal.
  setTimeout(() => {
    void claudeHistory.warm().catch((error) => {
      logger.warn("app", "claudeHistory.warm.startup.failed", "Startup history cache warm-up failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, 15000);
  cleanupIpc = registerIpc({
    repository,
    database,
    runs,
    council,
    approvals,
    terminals,
    events,
    operations,
    agentapi,
    agentapiState,
    agentapiVoice,
    persistentVoice,
    agentapiSemantic: { projector: agentapiSemanticProjector, store: agentapiSemanticStore },
    browserSecrets: browserSecrets ?? undefined,
  });
  // Voice keep-alive (2026-10-17): the local dictation server unloads its model
  // after five idle minutes, which ate the first 1–2 utterances after any few
  // quiet minutes. Ping it with 100ms of silence every four minutes so the
  // model stays loaded while Coterm runs. Loopback dictation server only —
  // the guard inside refuses every hosted/paid URL.
  voiceKeepaliveStop = startVoiceKeepalive({
    getTarget: () => {
      const { voice } = repository.getSettings();
      return { serverUrl: voice.sttUrl, model: voice.sttModel };
    },
  });
  // Agent API: generate+persist token on first run, write to userData for external tools.
  let agentSettings = repository.getSettings();
  if (!agentSettings.agentApi.token) {
    const token = randomUUID();
    agentSettings = await repository.setSettings({
      ...agentSettings,
      agentApi: { ...agentSettings.agentApi, token },
    });
  }
  try {
    await writeFile(
      join(app.getPath("userData"), "agent-api-token.txt"),
      agentSettings.agentApi.token,
      "utf8",
    );
  } catch (error) {
    logger.warn("app", "agentApi.tokenFile", "Failed to write agent API token file", { error: safeErrorMessage(error) });
  }
  const webConfig = storedConfig ?? readWebConfig(process.env, identity.defaultWebPort);
  // Prime the mailbox URL BEFORE listen: PTYs spawned during startup would
  // otherwise get COTERM_MAIL_TOKEN but no COTERM_MAIL_URL (the port passed to
  // startWebServer is deterministic — a bind failure throws, never re-ports).
  agentMailbox?.setBaseUrl(`http://127.0.0.1:${webConfig?.port ?? identity.defaultWebPort}`);
  // Issue #63: the agent API lives on the web server, so it must bind even with
  // no remote-access config — otherwise Settings→Agent API is a silent no-op.
  // Without remote config the RPC/renderer surface stays behind a deny-all
  // verifier (401); the loopback-only, token-gated agent routes work.
  const verifyAccess: AccessVerifier = webConfig
    ? (webConfig.authMode === "tailscale"
      ? createTailscaleVerifier(webConfig.allowedLogin)
      : createCloudflareAccessVerifier(webConfig.teamDomain, webConfig.audience))
    : () => Promise.reject(new Error("Remote access not configured."));
  try {
    webServer = await startWebServer({
      port: webConfig?.port ?? identity.defaultWebPort,
      allowedOrigin: webConfig?.origin ?? "self",
      ...(webConfig?.allowedHosts && webConfig.allowedHosts.length > 0
        ? { allowedHosts: webConfig.allowedHosts }
        : {}),
      verifyAccess,
      operations: bindWebOperations(operations, agentapi, {
        agentapiState,
        agentapiVoice,
        persistentVoice,
        agentapiSemantic: { projector: agentapiSemanticProjector, store: agentapiSemanticStore },
        getSettings: () => repository.getSettings(),
      }),
      rendererPath: join(__dirname, "../renderer"),
      events,
      getSettings: () => repository.getSettings(),
      dockLayout: {
        get: () => operations.getDockLayout(),
        subscribe: (cb) => operations.onDockLayoutChanged(cb),
      },
      attention: {
        list: () => operations.listAttention(),
        subscribe: (cb) => operations.onAttentionChanged(cb),
      },
      usage: {
        get: () => operations.getUsageSnapshot(),
        subscribe: (cb) => operations.onUsageChanged(cb),
      },
      agentapiWorld: {
        get: () => agentapiState?.getWorldState() ?? [],
        subscribe: (cb) => agentapiState?.onWorldChanged(cb) ?? (() => undefined),
      },
      ...(waitCoordinator ? { waitCoordinator } : {}),
      handoffService: terminalHandoffs,
      agentapi,
      ...(browserRuntime ? { browser: browserRuntime } : {}),
      ...(terminals ? { terminals } : {}),
      ...(agentMailbox ? { mailbox: agentMailbox } : {}),
    });
    agentMailbox?.setBaseUrl(`http://127.0.0.1:${webServer?.port ?? identity.defaultWebPort}`);
    logger.info("app", "agentApi.listening", "Agent API server listening", { port: webServer.port, remoteAccess: webConfig !== null });
  } catch (error) {
    logger.error("app", "agentApi.listen.failed", "Agent API server failed to start", { error: safeErrorMessage(error) });
  }
  if (shouldOpenDesktop(process.argv)) await createWindow();
  usageMonitor.start();
  activityMonitor.start();
  worktreeRegistry?.start();
  contextBattery?.start();
  if (process.argv.includes("--summarize-all") || dailySummaryPending) requestDailySummary();
}

function requestDailySummary(): void {
  if (!dailySummary) {
    dailySummaryPending = true;
    return;
  }
  dailySummaryPending = false;
  void dailySummary()
    .then((result) => logger.info("app", "app.dailySummary.completed", "Daily summary completed", { result: JSON.stringify(result) }))
    .catch((error: unknown) => logger.error("app", "app.dailySummary.failed", "Daily summary failed", { error: safeErrorMessage(error) }));
}

// Synthetic conversation id for browser approval events (AT-133). Browser
// approvals own no conversation; this id never matches a real conversation, so
// the dormant pane routing treats these events as a no-op there while the
// renderer approval dialog consumes them from the shared event stream.
const BROWSER_APPROVAL_CONVERSATION_ID = "00000000-0000-4000-8000-000000000133";

/**
 * Browser approval surfacing (AT-133): the broker emits browser-context
 * signals with requestId + a display payload; this turns them into
 * metadata-only approval.requested/ approval.resolved events. NEVER persisted
 * to the conversation ledger — emitted straight onto the bus (renderer + WS
 * clients consume; nothing inserts into `events`).
 */
function emitBrowserApprovalEvent(events: AppEventBus, signal: Parameters<ApprovalSignalListener>[0]): void {
  const context = signal.context;
  if (!context || "terminalId" in context) return; // only browser-context signals
  if (signal.kind !== "approval") return; // browser sessions never issue structured input requests
  const payload = signal.payload ?? {};
  const action = typeof payload.action === "string" ? payload.action : "action";
  const origin = context.origin;
  events.emit("event", {
    id: randomUUID(),
    conversationId: BROWSER_APPROVAL_CONVERSATION_ID,
    turnId: randomUUID(),
    providerSessionId: null,
    turnGroupId: null,
    type: signal.state === "pending" ? "approval.requested" : "approval.resolved",
    createdAt: new Date().toISOString(),
    sequence: 0,
    summary: signal.state === "pending"
      ? `Browser action "${action}" on ${origin} is waiting for approval.`
      : `Browser action "${action}" on ${origin} approval was resolved.`,
    payload: {
      browser: true,
      requestId: signal.requestId,
      action,
      origin,
      sessionId: context.sessionId,
      pageId: context.pageId,
      ...(typeof payload.level === "number" ? { level: payload.level } : {}),
      ...(typeof payload.locatorStrategy === "string" ? { locatorStrategy: payload.locatorStrategy } : {}),
      // evaluate script preview rides through so the dialog can show the code
      // being approved (script text only — never resolved secret values).
      ...(typeof payload.previewScript === "string" ? { previewScript: payload.previewScript, previewTruncated: payload.previewTruncated === true } : {}),
    },
  });
}

function registerLifecycle(): void {
  app.on("second-instance", (_event, argv) => {
    if (argv.includes("--summarize-all")) {
      requestDailySummary();
      return;
    }
    if (!mainWindow || mainWindow.isDestroyed()) {
      void createWindow().catch((error: unknown) => {
        logger.error("app", "app.window.reopenFailed", "Failed to reopen window", { error: safeErrorMessage(error) });
      });
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  void app.whenReady().then(() => {
    void bootstrap().catch((error: unknown) => {
      logger.error("app", "app.start.failed", "Coterm failed to start", { error: safeErrorMessage(error) });
      app.quit();
    });
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow().catch((error: unknown) => {
          logger.error("app", "app.window.recreateFailed", "Failed to recreate window", { error: safeErrorMessage(error) });
        });
      }
    });
  });

  // #96 (ime-freeze squad, main-side half): the renderer notices a lost WebGL
  // context and shows a per-pane degraded badge, but only for windows it owns.
  // If Chromium's whole GPU process dies, the compositor degrades for every
  // window at once and the renderer may see nothing at all — so record it here.
  // Metadata only (reason/exit code), matching logging §A.2.
  app.on("child-process-gone", (_event, details) => {
    if (details.type !== "GPU") return;
    logger.warn("app", "app.gpu.gone", "GPU process gone; compositing may be degraded", {
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });

  // A listener suppresses Electron's default quit so remote runs and PTYs stay alive.
  app.on("window-all-closed", () => undefined);

  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    logger.audit("app", "app.shutdown", "Shutdown initiated");
    const deadline = setTimeout(() => {
      logger.error("app", "app.shutdown.deadline", "Shutdown exceeded deadline; forcing exit");
      app.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    deadline.unref();
    void (async () => {
      try {
        // Stop accepting Agent API waits at the start of shutdown. Existing
        // waits resolve `shutdown`; any request racing the HTTP close gets 503.
        await agentapi?.shutdown();
        await liveVoiceDuplex?.stop();
        agentapiSemanticProjector?.dispose();
        agentapiSemanticProjector = null;
        waitCoordinator?.shutdown();
    await cleanupIpc?.();
    voiceKeepaliveStop?.();
    voiceKeepaliveStop = null;
    await webServer?.close();
    usageMonitor?.stop();
    activityMonitor?.stop();
    worktreeRegistry?.stop();
    contextBattery?.stop();
        if (attentionEventListener) eventBus?.off("event", attentionEventListener);
        brokerSignalUnsubscribe?.();
        approvals?.cancelAll();
        terminals?.dispose();
        agentapiState?.dispose();
        agentMailbox?.dispose();
        agentMailbox = null;
        agentDoneToast?.dispose();
        agentDoneToast = null;
        await attentionCenter?.dispose();
        await council?.dispose();
        await runs?.dispose();
        await agentapiReviewer?.dispose();
        await browserRuntime?.dispose();
        browserSecrets?.clear();
        await database?.closeWhenIdle();
      } catch (error) {
        logger.error("app", "app.shutdown.cleanupFailed", "Shutdown cleanup failed", { error: safeErrorMessage(error) });
      } finally {
        clearTimeout(deadline);
        app.quit();
      }
    })();
  });
}

if (app.requestSingleInstanceLock()) {
  registerLifecycle();
} else {
  app.quit();
}
