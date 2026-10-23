import type { AiTerminalApi } from "@shared/ipc";
import { appSettingsPatchSchema } from "@shared/schema";
import { mergeAppSettingsPatch } from "@shared/settings-patch";
import type {
  AppSettings,
  DockLayout,
  NormalizedEvent,
  ProviderStatus,
  TerminalInfo,
  TerminalKeepaliveState,
} from "@shared/types";

const projectId = "dc06a187-98d0-4c2e-aa74-d0607c3bb941";
const conversationId = "eec6452a-bbc2-4408-90c8-bcde0f8dff74";
const now = new Date().toISOString();

let settings: AppSettings = {
  theme: "dark",
  readingPreset: "2-halves",
  codeTheme: "auto",
  terminalTheme: "auto",
  locale: "zh-TW",
  defaultProvider: "claude-official",
  defaultShell: "powershell",
  terminalFontSize: 16,
  terminalFont: "default",
  claudeKeepaliveHours: 2,
  proxyUrl: "http://127.0.0.1:8787",
  customProfiles: {},
  permissionPreset: "ask",
  onboardingCompleted: true,
  defaultWorkspacePath: "D:\\Coterm",
  telemetry: false,
  searchIndexEnabled: true,
  agentDoneToast: true,
  restoreSessionOnLaunch: true,
  agentApi: { enabled: true, token: "", rateLimit: { terminalPerMinute: 30, browserPerMinute: 30 } },
  retention: { days: 30, pruneOnStart: false },
  browserApproval: { mode: "ask" },
  voice: {
    enabled: true,
    lang: "zh-TW",
    sttLanguageMode: "auto",
    responseLanguage: "zh-TW",
    sttUrl: "",
    sttModel: "whisper-1",
    sttApiKey: "",
    streamingDictation: true,
    live: {
      enabled: true,
      provider: "cascade",
      serverUrl: "ws://127.0.0.1:7880",
      apiKey: "",
      apiSecret: "",
      ttsVoice: "zh-TW-HsiaoChenNeural",
      geminiApiKey: "",
      geminiModel: "gemini-3.1-flash-live-preview",
    },
  },
  browserNetwork: { mode: "block", allowHosts: [] },
  browser: { superpowersP0: true, superpowersP1: true },
  agentBrowserWindow: "popout",
  agentBrowserFullAccess: false,
  checkpoint: { topbarButton: true },
  readingMode: { topbarButton: true },
  jev: { enabled: false, apiKey: "" },
  agentapi: { voiceAgent: true },
};

const providers: ProviderStatus[] = [
  provider("claude-official", "Claude Code official", true),
  provider("codex-official", "Codex official", true),
  provider("claude-local-long", "Local long", true),
  provider("claude-local-freeform", "Local freeform", true),
  provider("claude-local-main", "GLM Local Flash", true),
  provider("codex-local-long", "Local long", true),
  provider("council", "Council · 3 LLM", true),
];

let sequence = 6;
let terminalRevision = 0;
const eventListeners = new Set<(event: NormalizedEvent) => void>();
const terminalDataListeners = new Set<
  (payload: { terminalId: string; data: string; projectId?: string; revision: number }) => void
>();
const terminalExitListeners = new Set<
  (payload: { terminalId: string; exitCode: number; projectId?: string }) => void
>();
const terminalListChangedListeners = new Set<(payload: { projectId: string }) => void>();
const terminals: TerminalInfo[] = [];
const keepaliveStates = new Map<string, TerminalKeepaliveState>();

const events: NormalizedEvent[] = [
  event("4b8a462b-5259-49b9-bfec-904ccbcc8bd0", "user.message", "User message.", {
    text: "請整理這個專案的實作計畫，並先確認資料層是否適合平行執行。",
    profileId: "codex-official",
  }),
  event("4b8a462b-5259-49b9-bfec-904ccbcc8bd0", "plan.updated", "Codex updated the plan.", {
    plan: ["檢查資料模型", "驗證交易", "整理 UI"],
  }),
  event("4b8a462b-5259-49b9-bfec-904ccbcc8bd0", "command.started", "npm run test", {
    command: "npm run test",
  }),
  event("4b8a462b-5259-49b9-bfec-904ccbcc8bd0", "command.completed", "Tests passed.", {
    exitCode: 0,
  }),
  event("4b8a462b-5259-49b9-bfec-904ccbcc8bd0", "file.changed", "Updated storage transaction queue.", {
    changes: 3,
  }),
  event("4b8a462b-5259-49b9-bfec-904ccbcc8bd0", "artifact.created", "Coterm UI preview", {
    path: "D:\\Coterm\\.demo\\preview.png",
  }),
  event("4b8a462b-5259-49b9-bfec-904ccbcc8bd0", "assistant.final", "Codex completed.", {
    provider: "codex-official",
    text: "已完成第一輪檢查。資料層需要把平行寫入串行化，並在同一個交易內配置事件 sequence。這樣 Council 的三路結果即使同時回來，也不會產生重複順序。\n\n```ts\nawait database.transaction(() => appendEvent(event));\n```\n\n下一步可繼續驗證 Provider handoff 與終端恢復。",
    usage: { input_tokens: 1840, output_tokens: 426 },
  }),
];

export function installMockApi(): void {
  if (window.aiTerminal) return;
  if (new URLSearchParams(window.location.search).has("onboarding")) {
    settings = { ...settings, onboardingCompleted: false };
  }
  window.aiTerminal = createMockApi();
}

function createMockApi(): AiTerminalApi {
  return {
    quitApp: () => Promise.resolve(),
    // Phase 6 panel/voice stubs for the dev harness (no main process here).
    getAgentApiWorldSnapshot: () => Promise.resolve([]),
    onAgentApiWorldChanged: () => () => undefined,
    getAgentApiSemanticState: () => Promise.resolve(null),
    agentapiVoiceTurn: () => Promise.resolve(null),
    interruptAgentApiVoice: () => Promise.resolve({ epoch: 0, aborted: false }),
    liveVoiceSession: (input) => Promise.resolve({
      session: {
        id: "mock-live-voice",
        status: input.action === "end" ? "ended"
          : input.action === "mute" ? "muted"
            : input.action === "reconnecting" ? "reconnecting"
              : input.action === "utterance" ? "speaking"
                : "listening",
        startedAt: now,
        endedAt: input.action === "end" ? now : null,
        lastActiveAt: now,
        rollingSummary: "",
        currentTopic: null,
        activeTerminalId: null,
        transport: "mock",
        sttLanguageMode: "auto",
        responseLanguage: "zh-TW",
        revision: 1,
      },
      ...(input.action === "utterance" ? { turn: null } : {}),
    }),
    transcribeVoiceAgent: () => Promise.resolve({ text: "mock agent utterance" }),
    bootstrap: () =>
      Promise.resolve({
        projects: [
          {
            id: projectId,
            name: "Coterm",
            workspacePath: "D:\\Coterm",
            pinned: true,
            order: 0,
            archived: false,
            createdAt: now,
            updatedAt: now,
          },
        ],
        conversations: [
          {
            id: conversationId,
            projectId,
            name: "首輪產品建構",
            activeProvider: "codex-official",
            primaryProvider: "codex-official",
            claudeModel: "default",
            continuedFromConversationId: null,
            handoffSourceConversationId: null,
            archived: false,
            summary: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
        runningConversationIds: [],
        archivedProjects: [],
        archivedConversations: [],
        providers,
        appVersion: "1.0.0-dev",
        userDataPath: "D:\\Coterm\\.demo",
        startupAlerts: "",
      }),
    getSettings: () => Promise.resolve(settings),
    setSettings: (next) => {
      settings = mergeAppSettingsPatch(settings, appSettingsPatchSchema.parse(next));
      return Promise.resolve(settings);
    },
    diagnostics: () =>
      Promise.resolve({
        generatedAt: new Date().toISOString(),
        appVersion: "1.0.0-dev",
        platform: "win32",
        arch: "x64",
        providers,
        database: { path: "demo-memory.sqlite", schemaVersion: 2 },
        recentErrors: [],
      }),
    exportDiagnostics: () =>
      Promise.resolve("D:\\Coterm\\.demo\\diagnostics.json"),
    createBackup: () => Promise.resolve("D:\\Coterm\\.demo\\backup.sqlite"),
    restoreBackup: () => Promise.resolve("D:\\Coterm\\.demo\\backup.sqlite"),
    pickWorkspace: () => Promise.resolve("D:\\Coterm"),
    search: (input) => Promise.resolve(
      [
        {
          id: projectId,
          kind: "project" as const,
          title: "Coterm",
          snippet: "D:\\Coterm",
          projectId,
          conversationId: null,
          terminalId: null,
          nativeSessionId: null,
          projectName: null,
          updatedAt: null,
        },
        {
          id: conversationId,
          kind: "conversation" as const,
          title: "Coterm demo conversation",
          snippet: "Demo conversation event ledger",
          projectId,
          conversationId,
          terminalId: null,
          nativeSessionId: null,
          projectName: null,
          updatedAt: null,
        },
      ].filter((item) =>
        `${item.title} ${item.snippet}`.toLowerCase().includes(input.query.toLowerCase()),
      ),
    ),
    sessionIndexStatus: () => Promise.resolve({ syncing: false, lastCompletedAt: null }),
    listWorkspace: () => Promise.resolve([
      { name: "src", path: "D:\\Coterm\\src", type: "directory" as const, relativePath: "src" },
      { name: "package.json", path: "D:\\Coterm\\package.json", type: "file" as const, relativePath: "package.json" },
    ]),
    searchWorkspaceEntries: (input) => Promise.resolve([
      { name: "package.json", path: "D:\\Coterm\\package.json", relativePath: "package.json", type: "file" as const, score: input.query.toLowerCase().includes("package") ? 5 : 1 },
    ].filter((result) => result.name.toLowerCase().includes(input.query.toLowerCase().replace(/^ext:/, "")))),
    renameWorkspaceEntry: (input) => Promise.resolve({ name: input.newName, path: input.path, type: "file" as const, relativePath: input.newName }),
    createWorkspaceFile: (input) => Promise.resolve({ name: input.name, path: `${input.parentPath ?? "D:\\Coterm"}\\${input.name}`, type: "file" as const, relativePath: input.name }),
    createWorkspaceDirectory: (input) => Promise.resolve({ name: input.name, path: `${input.parentPath ?? "D:\\Coterm"}\\${input.name}`, type: "directory" as const, relativePath: input.name }),
    deleteWorkspaceEntry: () => Promise.resolve(),
    duplicateWorkspaceEntry: (input) => Promise.resolve({ name: `${input.path.split("\\").at(-1) ?? "copy"} copy`, path: `${input.path} copy`, type: "file" as const, relativePath: "copy" }),
    revealWorkspaceEntry: () => Promise.resolve(),
    openWorkspaceEntryExternal: () => Promise.resolve(),
    saveAttachment: (input) =>
      Promise.resolve({
        id: crypto.randomUUID(),
        conversationId: input.conversationId,
        name: input.name,
        mimeType: input.mimeType,
        localPath: `D:\\Coterm\\.demo\\${input.name}`,
        size: Math.ceil((input.dataBase64.length * 3) / 4),
        createdAt: new Date().toISOString(),
      }),
    saveUpload: (input) =>
      Promise.resolve({ localPath: `D:\\Coterm\\.demo\\uploads\\${input.name}` }),
    listAttachments: () => Promise.resolve([]),
    deleteAttachment: () => Promise.resolve(),
    readArtifact: () =>
      Promise.resolve({
        kind: "image" as const,
        mimeType: "image/svg+xml",
        path: "D:\\Coterm\\.demo\\artifact.svg",
        dataUrl:
          "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MDAiIGhlaWdodD0iMjQwIj48cmVjdCB3aWR0aD0iNDAwIiBoZWlnaHQ9IjI0MCIgcng9IjI0IiBmaWxsPSIjMTAyNTJjIi8+PGNpcmNsZSBjeD0iMjAwIiBjeT0iMTAwIiByPSI0MiIgZmlsbD0iIzY3ZGZiZSIvPjx0ZXh0IHg9IjIwMCIgeT0iMTgwIiBmaWxsPSIjZThmMGYyIiBmb250LXNpemU9IjE4IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj5BSSBUZXJtaW5hbCBBcnRpZmFjdDwvdGV4dD48L3N2Zz4=",
        size: 1024,
      }),
    readArtifactWorkbook: () => Promise.resolve({
      format: "xlsx" as const,
      limited: false,
      sheets: [{ name: "Sheet1", index: 0, rowCount: 2, columnCount: 2, truncated: false, cells: [
        { row: 0, column: 0, value: "Name" }, { row: 0, column: 1, value: "Value" },
        { row: 1, column: 0, value: "Demo" }, { row: 1, column: 1, value: 42 },
      ], mergedRanges: [] }],
    }),
    readArtifactPresentation: () => Promise.resolve({
      width: 1280,
      height: 720,
      limited: false,
      slides: [{ index: 0, elements: [{ kind: "text" as const, x: 40, y: 40, width: 800, height: 80, text: "Demo presentation" }] }],
    }),
    openBrowserArtifact: (input) => Promise.resolve({ kind: "browser" as const, mimeType: "text/uri-list" as const, path: input.url, size: 0 as const, url: input.url }),
    createBrowserSession: () => Promise.resolve({ id: crypto.randomUUID(), mode: "headless" as const, profileId: null, persistent: false, createdAt: new Date().toISOString(), status: "ready" as const, pages: [] }),
    openInAgentBrowser: (target) => Promise.resolve(target.trim().length > 0 ? { ok: true } : { ok: false, error: "empty target" }),
    listBrowserSessions: () => Promise.resolve([]),
    closeBrowserSession: () => Promise.resolve(),
    newBrowserPage: (input) => Promise.resolve({ id: crypto.randomUUID(), sessionId: input.sessionId, url: input.url ?? "about:blank", title: "", status: "ready" as const, active: true }),
    listBrowserPages: () => Promise.resolve([]),
    closeBrowserPage: () => Promise.resolve(),
    selectBrowserPage: () => Promise.resolve({ id: crypto.randomUUID(), sessionId: projectId, url: "about:blank", title: "", status: "ready" as const, active: true }),
    navigateBrowser: (input) => Promise.resolve({ id: input.pageId, sessionId: projectId, url: input.url, title: "", status: "ready" as const, active: true }),
    browserBack: () => Promise.resolve({ id: crypto.randomUUID(), sessionId: projectId, url: "about:blank", title: "", status: "ready" as const, active: true }),
    browserForward: () => Promise.resolve({ id: crypto.randomUUID(), sessionId: projectId, url: "about:blank", title: "", status: "ready" as const, active: true }),
    browserReload: () => Promise.resolve({ id: crypto.randomUUID(), sessionId: projectId, url: "about:blank", title: "", status: "ready" as const, active: true }),
    browserStop: () => Promise.resolve(),
    snapshotBrowser: () => Promise.resolve({ snapshotId: crypto.randomUUID(), pageId: crypto.randomUUID(), url: "about:blank", title: "", capturedAt: new Date().toISOString(), viewport: { width: 1280, height: 720, deviceScaleFactor: 1 }, scroll: { x: 0, y: 0 }, frames: [], refs: {}, format: "compact" as const }),
    clickBrowser: () => Promise.resolve({ ok: true, actionId: crypto.randomUUID(), pageId: crypto.randomUUID(), urlBefore: "about:blank", urlAfter: "about:blank", navigationOccurred: false, warnings: [] }),
    clickBrowserCoordinates: () => Promise.resolve({ ok: true, actionId: crypto.randomUUID(), pageId: crypto.randomUUID(), urlBefore: "about:blank", urlAfter: "about:blank", navigationOccurred: false, warnings: [] }),
    fillBrowser: () => Promise.resolve({ ok: true, actionId: crypto.randomUUID(), pageId: crypto.randomUUID(), urlBefore: "about:blank", urlAfter: "about:blank", navigationOccurred: false, warnings: [] }),
    typeBrowser: () => Promise.resolve({ ok: true, actionId: crypto.randomUUID(), pageId: crypto.randomUUID(), urlBefore: "about:blank", urlAfter: "about:blank", navigationOccurred: false, warnings: [] }),
    pressBrowser: () => Promise.resolve({ ok: true, actionId: crypto.randomUUID(), pageId: crypto.randomUUID(), urlBefore: "about:blank", urlAfter: "about:blank", navigationOccurred: false, warnings: [] }),
    extractBrowser: () => Promise.resolve({ version: 1 as const, source: { url: "about:blank", finalUrl: "about:blank", title: "", fetchedAt: new Date().toISOString(), contentType: "text/html" }, metadata: {}, headings: [], paragraphs: [], lists: [], tables: [], links: [], images: [], text: "" }),
    saveBrowserExtraction: () => Promise.resolve("D:\\Coterm\\.demo\\browser.md"),
    searchBrowserIndex: () => Promise.resolve([]),
    screenshotBrowser: () => Promise.resolve("data:image/png;base64,"),
    issueBrowserSecret: () => Promise.resolve({ handle: "secret://mock-handle", expiresInMs: 60_000 }),
    writeArtifact: () => Promise.resolve(),
    revealArtifact: () => Promise.resolve(),
    openArtifactExternal: () => Promise.resolve(),
    createProject: (input) =>
      Promise.resolve({
        id: crypto.randomUUID(),
        name: input.name,
        workspacePath: input.workspacePath,
        pinned: false,
        order: 0,
        archived: false,
        createdAt: now,
        updatedAt: now,
      }),
    renameProject: (input) =>
      Promise.resolve({
        id: input.projectId,
        name: input.name,
        workspacePath: "D:\\Coterm",
        pinned: true,
        order: 0,
        archived: false,
        createdAt: now,
        updatedAt: new Date().toISOString(),
      }),
    pinProject: (input) =>
      Promise.resolve({
        id: input.projectId,
        name: "Coterm",
        workspacePath: "D:\\Coterm",
        pinned: input.value,
        order: 0,
        archived: false,
        createdAt: now,
        updatedAt: new Date().toISOString(),
      }),
    reorderProjects: () => Promise.resolve([]),
    archiveProject: (input) =>
      Promise.resolve({
        id: input.projectId,
        name: "Coterm",
        workspacePath: "D:\\Coterm",
        pinned: true,
        order: 0,
        archived: input.value,
        createdAt: now,
        updatedAt: new Date().toISOString(),
      }),
    deleteProject: () => Promise.resolve(),
    createConversation: (input) =>
      Promise.resolve({
        id: crypto.randomUUID(),
        projectId: input.projectId,
        name: input.name,
        activeProvider: input.provider,
        primaryProvider: input.provider,
        claudeModel: "default" as const,
        continuedFromConversationId: null,
        handoffSourceConversationId: null,
        archived: false,
        summary: null,
        createdAt: now,
        updatedAt: now,
      }),
    continueConversationWithProvider: (input) =>
      Promise.resolve({
        id: crypto.randomUUID(),
        projectId,
        name: "Provider continuation",
        activeProvider: input.targetProvider,
        primaryProvider: input.targetProvider,
        claudeModel: "default" as const,
        continuedFromConversationId: input.sourceConversationId,
        handoffSourceConversationId: input.sourceConversationId,
        archived: false,
        summary: null,
        createdAt: now,
        updatedAt: new Date().toISOString(),
      }),
    renameConversation: (input) =>
      Promise.resolve({
        id: input.conversationId,
        projectId,
        name: input.name,
        activeProvider: "codex-official",
        primaryProvider: "codex-official",
        claudeModel: "default" as const,
        continuedFromConversationId: null,
        handoffSourceConversationId: null,
        archived: false,
        summary: null,
        createdAt: now,
        updatedAt: new Date().toISOString(),
      }),
    archiveConversation: (input) =>
      Promise.resolve({
        id: input.conversationId,
        projectId,
        name: "首輪產品建構",
        activeProvider: "codex-official",
        primaryProvider: "codex-official",
        claudeModel: "default" as const,
        continuedFromConversationId: null,
        handoffSourceConversationId: null,
        archived: input.value,
        summary: null,
        createdAt: now,
        updatedAt: new Date().toISOString(),
      }),
    deleteConversation: () => Promise.resolve(),
    summarizeConversation: (input) => {
      const updatedAt = new Date().toISOString();
      return Promise.resolve({
        id: input.conversationId,
        projectId,
        name: "Coterm session summary",
        activeProvider: "codex-official",
        primaryProvider: "codex-official",
        claudeModel: "default" as const,
        continuedFromConversationId: null,
        handoffSourceConversationId: null,
        archived: false,
        summary: {
          brief: "Development preview summary.",
          longTermGoal: "Keep the Coterm project moving toward its current goal.",
          recentSummary: "The latest conversation was summarized successfully.",
          updatedAt,
          partial: false,
        },
        createdAt: now,
        updatedAt,
      });
    },
    setConversationClaudeModel: (input) => Promise.resolve({
      id: input.conversationId,
      projectId,
      name: "Model session",
      activeProvider: "claude-official" as const,
      primaryProvider: "claude-official" as const,
      claudeModel: input.model,
      continuedFromConversationId: null,
      handoffSourceConversationId: null,
      archived: false,
      summary: null,
      createdAt: now,
      updatedAt: new Date().toISOString(),
    }),
    listClaudeHistory: () => Promise.resolve([]),
    readClaudeHistory: (input) => Promise.resolve({
      session: {
        key: input.key,
        projectId: input.projectId,
        title: "Claude history",
        updatedAt: now,
      },
      messages: [],
      truncated: false,
    }),
    adoptClaudeHistory: () => Promise.reject(new Error("No demo Claude history session.")),
    listEvents: () => Promise.resolve([...events]),
    listProjectSessions: (requestedProjectId) => Promise.resolve(
      requestedProjectId === projectId ? [{
        source: "coterm" as const,
        providerSessionId: crypto.randomUUID(),
        conversationId,
        projectId,
        conversationName: "首輪產品建構",
        profileId: "codex-official" as const,
        nativeSessionId: null,
        historyKey: null,
        sizeBytes: null,
        status: "idle" as const,
        summary: null,
        tokenTotals: null,
        conversationUpdatedAt: now,
        sessionUpdatedAt: now,
      }] : [],
    ),
    getConversationSession: () => Promise.resolve(null),
    sendMessage: (input) => {
      const turnId = crypto.randomUUID();
      emitEvent(
        event(turnId, "user.message", "User message.", {
          text: input.text,
          profileId: input.profileId,
        }),
      );
      setTimeout(() => {
        emitEvent(
          event(turnId, "assistant.progress", "Demo provider inspected the workspace.", {}),
        );
        emitEvent(
          event(turnId, "assistant.final", "Demo provider completed.", {
            provider: input.profileId,
            text: "這是開發預覽回覆。正式桌面版會由選定的 CLI provider 執行，事件仍使用相同的本機 ledger 呈現。",
          }),
        );
      }, 280);
      return Promise.resolve({ turnId });
    },
    cancelMessage: () => Promise.resolve(),
    runTerminalCommand: (input) => {
      const turnId = crypto.randomUUID();
      emitEvent(event(turnId, "user.message", `Coterm command: /${input.command}`, {
        text: `/${input.command}`,
        profileId: "coterm",
      }));
      emitEvent(event(turnId, "assistant.final", "Coterm command completed.", {
        provider: "coterm",
        text: `## Coterm ${input.command}\n\nDevelopment preview result.`,
      }));
      return Promise.resolve();
    },
    resolveApproval: () => Promise.resolve(),
    resolveUserInput: () => Promise.resolve(),
    startCouncil: (input) => {
      const turnGroupId = crypto.randomUUID();
      const turnId = crypto.randomUUID();
      emitEvent(event(turnId, "council.started", "Council started.", {}));
      setTimeout(() => {
        emitEvent(
          event(turnId, "assistant.final", "Council completed.", {
            provider: "council",
            text: `Council 已完成示範評估：${input.question}`,
          }),
        );
      }, 360);
      return Promise.resolve({ turnGroupId, turnId });
    },
    cancelCouncil: () => Promise.resolve(),
    refreshProviders: () => Promise.resolve(providers),
    createTerminal: (input) => {
      const terminal: TerminalInfo = {
        id: crypto.randomUUID(),
        projectId: input.projectId,
        profile: input.profile,
        title: input.title ?? "PowerShell",
        cwd: input.cwd,
        cols: 100,
        rows: 28,
        status: "running",
        startedAt: new Date().toISOString(),
        closedAt: null,
        lastExitCode: null,
        isAgent: input.isAgent ?? false,
        agentProfile: input.agentProfile ?? null,
        ownedByAgentApi: false,
        pid: 0,
        nativeSessionId: null,
        worktreeId: input.worktreeId ?? null,
        contextUsage: null,
      };
      terminals.push(terminal);
      setTimeout(() => {
        for (const listener of terminalDataListeners) {
          listener({
            terminalId: terminal.id,
            projectId: terminal.projectId,
            data: "PowerShell 7 · Coterm development preview\r\nPS D:\\Coterm> ",
            revision: ++terminalRevision,
          });
        }
      }, 80);
      return Promise.resolve(terminal);
    },
    transcribeVoice: () => Promise.resolve({ text: "mock dictation" }),
    writeTerminal: (input) => {
      for (const listener of terminalDataListeners) {
        const terminal = terminals.find((item) => item.id === input.terminalId);
        listener({
          terminalId: input.terminalId,
          data: input.data,
          revision: ++terminalRevision,
          ...(terminal ? { projectId: terminal.projectId } : {}),
        });
      }
      return Promise.resolve();
    },
    resizeTerminal: () => Promise.resolve(),
    // AT-158: e2e/dev harness — accept the phone geometry intent, no PTY to resize.
    requestTerminalGeometry: () => Promise.resolve(),
    renameTerminal: (input) => {
      const terminal = terminals.find((item) => item.id === input.terminalId);
      if (!terminal) return Promise.reject(new Error("Terminal not found."));
      terminal.title = input.title;
      return Promise.resolve({ ...terminal });
    },
    setTerminalLabel: (input) => {
      const terminal = terminals.find((item) => item.id === input.terminalId);
      if (!terminal) return Promise.reject(new Error("Terminal not found."));
      terminal.label = input.label;
      for (const listener of terminalListChangedListeners) listener({ projectId: terminal.projectId });
      return Promise.resolve({ ...terminal });
    },
    markTerminalAgent: (input) => {
      const terminal = terminals.find((item) => item.id === input.terminalId);
      if (!terminal) return Promise.reject(new Error("Terminal not found."));
      terminal.isAgent = true;
      terminal.agentProfile = input.agentProfile;
      return Promise.resolve({ ...terminal });
    },
    setTerminalNativeSessionId: (input) => {
      const terminal = terminals.find((item) => item.id === input.terminalId);
      if (terminal) terminal.nativeSessionId = input.nativeSessionId;
      return Promise.resolve();
    },
    killTerminal: (input) => {
      const index = terminals.findIndex((terminal) => terminal.id === input.terminalId);
      if (index >= 0) terminals.splice(index, 1);
      for (const listener of terminalExitListeners) {
        listener({ terminalId: input.terminalId, projectId, exitCode: 0 });
      }
      return Promise.resolve();
    },
    listTerminals: (requestedProjectId) =>
      Promise.resolve(terminals.filter((terminal) => terminal.projectId === requestedProjectId)),
    getPtyState: () => Promise.resolve("done" as const),
    // Keepalive mock: per-window in-memory map so the header +/- round-trips.
    exportTerminalHandoff: () => Promise.resolve({ ok: false as const, error: "mock_unavailable" }),
    setTerminalKeepalive: (input) => {
      const terminal = terminals.find((t) => t.id === input.terminalId) ?? null;
      const state: TerminalKeepaliveState = {
        terminalId: input.terminalId,
        profile: terminal?.agentProfile ?? null,
        eligible: Boolean(
          terminal?.isAgent &&
          (terminal.agentProfile === "claude-official" || terminal.agentProfile === "codex-official"),
        ),
        overrideHours: input.hours,
        effectiveHours: input.hours ?? settings.claudeKeepaliveHours,
        cooled: false,
      };
      keepaliveStates.set(input.terminalId, state);
      return Promise.resolve(state);
    },
    listTerminalKeepalives: () => Promise.resolve(Array.from(keepaliveStates.values())),
    getLastCommand: () => Promise.resolve(null),
    getAgentLauncherDir: () => Promise.resolve(null),
    getTerminalDashboard: () => Promise.resolve([]),
    listAttention: () => Promise.resolve([]),
    resolveAttention: () => Promise.resolve(),
    getUsageSnapshot: () => Promise.resolve({ claude5h: null, claude7d: null, codex7d: null, fetchedAt: 0 }),
    getSystemActivity: () => Promise.resolve({ cpuPercent: 12, memPercent: 48, memUsedBytes: 0, memTotalBytes: 0, agentFiles: 0, agentBytes: 0, watchedRoots: 0, since: Date.now() }),
    getAgentFileActivity: () => Promise.resolve({ files: [], total: 0 }),
    getWorktreeRegistry: () => Promise.resolve({ entries: [], baselineCount: 0, lastCheckedAt: null }),
    refreshTerminal: () => Promise.resolve(),
    getTerminalTranscript: () => Promise.resolve({ messages: [] }),
    getTerminalSessionInfo: (terminalId) => {
      const terminal = terminals.find((t) => t.id === terminalId && t.isAgent) ?? null;
      if (!terminal) return Promise.resolve(null);
      const provider = terminal.agentProfile?.startsWith("codex") ? ("codex" as const) : ("claude" as const);
      return Promise.resolve({
        terminalId,
        agentProfile: terminal.agentProfile,
        provider,
        nativeSessionId: terminal.nativeSessionId,
        cwd: terminal.cwd,
        pid: terminal.pid,
        model: null,
        transcriptPath: null,
        resumeCommand: terminal.nativeSessionId
          ? provider === "codex"
            ? `codex resume ${terminal.nativeSessionId}`
            : `claude --resume ${terminal.nativeSessionId}`
          : null,
      });
    },
    getTerminalWorkspace: (requestedProjectId) =>
      Promise.resolve({
        terminals: terminals.filter((terminal) => terminal.projectId === requestedProjectId),
        split: "single",
        activeId: terminals[0]?.id ?? null,
        secondaryId: null,
        scrollback: {},
        scrollbackRevision: {},
        restored: false,
      }),
    saveTerminalWorkspace: () => Promise.resolve(),
    onEvent: (callback) => subscribe(eventListeners, callback),
    onTerminalData: (callback) => subscribe(terminalDataListeners, callback),
    onTerminalExit: (callback) => subscribe(terminalExitListeners, callback),
    onTerminalListChanged: (callback) => subscribe(terminalListChangedListeners, callback),
    onTerminalGeometryChanged: () => () => undefined,
    onTerminalCommand: () => () => undefined,
    onPtyStateChanged: () => () => undefined,
    onAttentionChanged: () => () => undefined,
    onUsageChanged: () => () => undefined,
    onBrowserArtifactSaved: () => () => undefined,
    createAgentApiWorkflow: () => Promise.reject(new Error("AgentApi workflows are unavailable in mock mode.")),
    getAgentApiWorkflow: () => Promise.reject(new Error("AgentApi workflows are unavailable in mock mode.")),
    resumeAgentApiWorkflow: () => Promise.reject(new Error("AgentApi workflows are unavailable in mock mode.")),
    pauseAgentApiWorkflow: () => Promise.reject(new Error("AgentApi workflows are unavailable in mock mode.")),
    cancelAgentApiWorkflow: () => Promise.reject(new Error("AgentApi workflows are unavailable in mock mode.")),
    // --- Dock layout (terminal-first overhaul) ------------------------------
    getDockLayout: () => Promise.resolve(EMPTY_DOCK_LAYOUT),
    openTile: () => Promise.resolve(EMPTY_DOCK_LAYOUT),
    closeTile: () => Promise.resolve(EMPTY_DOCK_LAYOUT),
    selectTile: () => Promise.resolve(EMPTY_DOCK_LAYOUT),
    setDockLayout: () => Promise.resolve(EMPTY_DOCK_LAYOUT),
    setExclusive: () => Promise.resolve(EMPTY_DOCK_LAYOUT),
    reorderTile: () => Promise.resolve(EMPTY_DOCK_LAYOUT),
    onDockLayout: () => () => undefined,
    // Hot model registry (stage 1): the mock has no main process to push
    // profile changes; the store recomputes from the setSettings return value.
    onProfilesChanged: () => () => undefined,
    // --- A — Worktree sandbox + trusted resume ------------------------------
    createWorktree: () => Promise.reject(new Error("Worktree sandboxes are unavailable in mock mode.")),
    listWorktrees: () => Promise.resolve([]),
    getWorktree: () => Promise.resolve(null),
    worktreeDiffSummary: () => Promise.reject(new Error("Worktree sandboxes are unavailable in mock mode.")),
    mergeWorktree: () => Promise.reject(new Error("Worktree sandboxes are unavailable in mock mode.")),
    abortWorktree: () => Promise.reject(new Error("Worktree sandboxes are unavailable in mock mode.")),
    cleanupWorktree: () => Promise.resolve(),
    bindWorktreeSession: () => Promise.resolve(),
    resumeWorktree: () => Promise.reject(new Error("Worktree sandboxes are unavailable in mock mode.")),
    listCheckpoints: () => Promise.resolve([]),
    getCheckpoint: () => Promise.resolve(null),
    checkpointDiff: () => Promise.reject(new Error("Checkpoint rail is unavailable in mock mode.")),
    checkpointRestorePreview: () => Promise.reject(new Error("Checkpoint rail is unavailable in mock mode.")),
    restoreCheckpoint: () => Promise.reject(new Error("Checkpoint rail is unavailable in mock mode.")),
    restoreCheckpointHunk: () => Promise.reject(new Error("Checkpoint rail is unavailable in mock mode.")),
    undoCheckpoint: () => Promise.reject(new Error("Checkpoint rail is unavailable in mock mode.")),
    redoCheckpoint: () => Promise.reject(new Error("Checkpoint rail is unavailable in mock mode.")),
    createExplicitCheckpoint: () => Promise.reject(new Error("Checkpoint rail is unavailable in mock mode.")),
  };
}

const EMPTY_DOCK_LAYOUT: DockLayout = {
  tiles: [],
  selectedTerminalId: null,
  exclusiveTerminalId: null,
  rows: [],
  cols: [],
  ptyCols: 100,
  ptyRows: 28,
};

function provider(
  id: ProviderStatus["id"],
  label: string,
  installed: boolean,
): ProviderStatus {
  return {
    id,
    label,
    installed,
    authenticated: installed,
    online: installed,
    version: installed ? "dev" : null,
    detail: installed ? "Development preview" : "CLI not detected",
    capabilities: {
      sessions: installed,
      structuredEvents: installed,
      tools: installed,
      mcp: installed,
      skills: installed,
      images: installed,
      approvals: installed,
      tokenUsage: installed,
    },
  };
}

function event(
  turnId: string,
  type: NormalizedEvent["type"],
  summary: string,
  payload: Record<string, unknown>,
): NormalizedEvent {
  return {
    id: crypto.randomUUID(),
    conversationId,
    turnId,
    providerSessionId: null,
    turnGroupId: null,
    type,
    createdAt: new Date().toISOString(),
    sequence: sequence++,
    summary,
    payload,
  };
}

function emitEvent(value: NormalizedEvent): void {
  events.push(value);
  for (const listener of eventListeners) listener(value);
}

function subscribe<T>(listeners: Set<(value: T) => void>, callback: (value: T) => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}
