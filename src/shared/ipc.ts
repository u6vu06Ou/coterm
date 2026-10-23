import type {
  AgentFileActivity,
  AgentOption,
  AppSettings,
  AppSettingsPatch,
  ClaudeHistoryListInput,
  ClaudeHistoryReadInput,
  ClaudeHistorySession,
  ClaudeHistoryTranscript,
  WorktreeRegistryActivity,
  ArtifactReadInput,
  ArtifactWriteInput,
  ArtifactPreview,
  ArtifactTokenInput,
  BrowserArtifactInput,
  BrowserArtifactSaved,
  SpreadsheetModel,
  PresentationModel,
  ApprovalResolveInput,
  UserInputResolveInput,
  Attachment,
  AttachmentSaveInput,
  UploadSaveInput,
  BootstrapData,
  CommandResult,
  Conversation,
  ContinueConversationInput,
  ConversationModelInput,
  ConversationStateInput,
  ConversationSummaryInput,
  CouncilInput,
  CreateConversationInput,
  CreateProjectInput,
  Diagnostics,
  GlobalSearchInput,
  GlobalSearchResult,
  MessageInput,
  NormalizedEvent,
  Project,
  ProjectHistorySession,
  ProjectStateInput,
  ReorderProjectsInput,
  ProjectDeleteInput,
  ProviderRefreshInput,
  ProviderStatus,
  RenameProjectInput,
  RenameConversationInput,
  TerminalCreateInput,
  TerminalCommandInput,
  TerminalIdInput,
  TerminalInfo,
  TerminalRenameInput,
  TerminalSetLabelInput,
  TerminalMarkAgentInput,
  TerminalResizeInput,
  TerminalSetNativeSessionIdInput,
  TerminalWorkspaceSaveInput,
  TerminalWorkspaceState,
  TerminalSessionInfo,
  TerminalTranscript,
  TerminalWriteInput,
  WorkspaceEntry,
  WorkspaceListInput,
  WorkspaceSearchInput,
  WorkspaceSearchResult,
  WorkspacePathInput,
  WorkspaceRenameInput,
  WorkspaceCreateInput,
  WorkspaceDuplicateInput,
  DockLayout,
  DockOpenTileInput,
  DockCloseTileInput,
  DockSelectTileInput,
  DockSetLayoutInput,
  DockSetExclusiveInput,
  DockReorderTileInput,
  PtyState,
  TerminalKeepaliveState,
  TerminalKeepaliveSetInput,
  AttentionNotification,
  AttentionResolveInput,
  UsageSnapshot,
  SystemActivity,
  AgentApiWorkflow,
  AgentApiWorkflowCreate,
  AgentApiWorkflowStep,
  Worktree,
  WorktreeCreateInput,
  WorktreeListInput,
  WorktreeIdInput,
  WorktreeMergeInput,
  WorktreeBindSessionInput,
  WorktreeResumeInput,
  Checkpoint,
  CheckpointDiff,
  CheckpointListInput,
  CheckpointIdInput,
  CheckpointDiffInput,
  CheckpointRestorePreviewInput,
  CheckpointRestorePreview,
  CheckpointRestoreInput,
  CheckpointHunkRestoreInput,
  CheckpointUndoInput,
  CheckpointCreateExplicitInput,
  AgentApiSessionWorldState,
  AgentApiSessionSemanticState,
  AgentApiVoiceTurnInput,
  AgentApiVoiceTurnResult,
  VoiceSessionCommand,
  VoiceSessionCommandResult,
} from "./types";
import type { BrowserDocument, BrowserLocator, BrowserPageInfo, BrowserSearchResult, BrowserSessionInfo, BrowserSnapshot, BrowserActionResult } from "./browser-types";
import type { BrowserSessionCreateInput } from "./browser-schema";

// --- Terminal dashboard entry (aggregated PTY + dock state) -----------------
// Produced by AppOperations.getTerminalDashboard(); consumed by the renderer
// (SettingsPanel / dashboard view). Combines PtyManager.dashboardSnapshot()
// with DockLayout weight/selection so the renderer gets a single flat array.
export interface TerminalDashboardEntry {
  id: string;
  pid: number;
  projectId: string;
  cwd: string;
  profile: string;
  agentProfile: string | null;
  title: string;
  ptyState: PtyState;
  weight: number;
  selected: boolean;
  isAgent: boolean;
  ownedByAgentApi: boolean;
  /** Last completed command (OSC 633 rich lifecycle), or null if none yet. */
  lastCommand: CommandResult | null;
}

export type UiActionSurface = "desktop" | "web" | "mobile-web";

export interface UiActionRecordInput {
  /** Stable, non-content identifier from data-action-id; ui.unidentified until migrated. */
  actionId: string;
  surface: UiActionSurface;
  identified: boolean;
  controlType: "button" | "link" | "input" | "select" | "textarea" | "role-button" | "other";
  interaction: "click" | "change" | "submit" | "pointerdown" | "doubleclick" | "mousedown" | "keyboard";
}

export interface RendererErrorReportInput {
  /** Error message only. Never terminal output, conversation text, or detection evidence (logging A.2). */
  message: string;
  /** Truncated stack (main clamps to ~4KB); renderer truncates before send. */
  stack?: string;
  /** Short non-content origin tag, e.g. "window.error" | "artifact-preview". */
  source: string;
}

// --- Live socket (WS) message shape ----------------------------------------
// The live socket broadcasts dock layout changes to every connected client
// (web/mobile, and the desktop renderer as a second transport alongside IPC).
// Message shape:
//   { type: "dockLayout", payload: DockLayout }
// Initial state is delivered on connect (mirrors terminalListChanged).
// Content (PTY output) continues to flow via the existing `terminalData`
// message type; only layout/selection fractions sync here.

export const IPC = {
  bootstrap: "app:bootstrap",
  settingsGet: "settings:get",
  settingsSet: "settings:set",
  diagnostics: "app:diagnostics",
  diagnosticsExport: "app:diagnostics:export",
  backupCreate: "backup:create",
  backupRestore: "backup:restore",
  backupRestoreRelaunch: "backup:restore:relaunch",
  workspacePick: "workspace:pick",
  workspaceList: "workspace:list",
  workspaceSearch: "workspace:search",
  workspaceRename: "workspace:rename",
  workspaceCreateFile: "workspace:create-file",
  workspaceCreateDirectory: "workspace:create-directory",
  workspaceDelete: "workspace:delete",
  workspaceDuplicate: "workspace:duplicate",
  workspaceReveal: "workspace:reveal",
  workspaceOpenExternal: "workspace:open-external",
  search: "search:global",
  sessionIndexStatus: "session-index:status",
  attachmentSave: "attachment:save",
  uploadSave: "upload:save",
  attachmentsList: "attachments:list",
  attachmentDelete: "attachment:delete",
  artifactRead: "artifact:read",
  artifactWrite: "artifact:write",
  artifactReveal: "artifact:reveal",
  artifactOpenExternal: "artifact:open-external",
  artifactWorkbookRead: "artifact:workbook-read",
  artifactPresentationRead: "artifact:presentation-read",
  browserArtifactOpen: "browser-artifact:open",
  // Push: a browser screenshot landed on disk and is readable via artifactRead.
  browserArtifactSaved: "browser-artifact:saved",
  browserSessionCreate: "browser:session:create",
  browserSessionList: "browser:session:list",
  browserSessionClose: "browser:session:close",
  browserPageNew: "browser:page:new",
  browserPageList: "browser:page:list",
  browserPageClose: "browser:page:close",
  browserPageSelect: "browser:page:select",
  browserNavigate: "browser:navigate",
  browserBack: "browser:back",
  browserForward: "browser:forward",
  browserReload: "browser:reload",
  browserStop: "browser:stop",
  browserSnapshot: "browser:snapshot",
  browserClick: "browser:click",
  browserClickCoordinates: "browser:click-coordinates",
  browserFill: "browser:fill",
  browserType: "browser:type",
  browserPress: "browser:press",
  browserExtract: "browser:extract",
  browserSaveExtraction: "browser:save-extraction",
  browserSearchIndex: "browser:search-index",
  browserScreenshot: "browser:screenshot",
  // Local renderer-only: mint a one-time secret handle for the agent browser.
  // Deliberately absent from the web RPC allowlist (routes.ts) — raw secrets
  // can never travel over HTTP/MCP.
  browserSecretIssue: "browser:secret:issue",
  // IPC-only composition (not a registry entry): opens a local file (via the
  // previewLocalFile loopback route) or an http(s) URL in the popped-out headed
  // agent browser. Deliberately absent from the browser-action registry — that
  // surface travels over HTTP/MCP; agents reach this only through window.aiTerminal
  // (desktop) or the authenticated /api/rpc surface (web/mobile link clicks).
  browserOpenInAgent: "browser:open-in-agent",
  projectsCreate: "projects:create",
  projectsRename: "projects:rename",
  projectsPin: "projects:pin",
  projectsReorder: "projects:reorder",
  projectsArchive: "projects:archive",
  conversationsCreate: "conversations:create",
  conversationsContinue: "conversations:continue",
  conversationsRename: "conversations:rename",
  conversationsArchive: "conversations:archive",
  conversationsDelete: "conversations:delete",
  conversationsEvents: "conversations:events",
  projectSessions: "projects:sessions",
  conversationsSummarize: "conversations:summarize",
  conversationsModel: "conversations:model",
  conversationsSession: "conversations:session",
  claudeHistoryList: "claude-history:list",
  claudeHistoryRead: "claude-history:read",
  claudeHistoryAdopt: "claude-history:adopt",
  messageSend: "message:send",
  messageCancel: "message:cancel",
  terminalCommand: "terminal:command",
  approvalResolve: "approval:resolve",
  userInputResolve: "user-input:resolve",
  councilStart: "council:start",
  councilCancel: "council:cancel",
  providersRefresh: "providers:refresh",
  terminalCreate: "terminal:create",
  terminalWrite: "terminal:write",
  voiceTranscribe: "voice:transcribe",
  voiceWarmup: "voice:warmup",
  voiceDiag: "voice:diag",
  terminalResize: "terminal:resize",
  terminalRequestGeometry: "terminal:request-geometry",
  terminalRename: "terminal:rename",
  terminalSetLabel: "terminal:set-label",
  terminalMarkAgent: "terminal:mark-agent",
  terminalSetNativeSessionId: "terminal:set-native-session-id",
  terminalWorkspaceGet: "terminal:workspace:get",
  terminalWorkspaceSave: "terminal:workspace:save",
  terminalTranscriptGet: "terminal:transcript:get",
  terminalSessionInfoGet: "terminal:session-info:get",
  terminalKill: "terminal:kill",
  terminalList: "terminal:list",
  terminalPtyState: "terminal:pty-state",
  terminalKeepaliveSet: "terminal:keepalive:set",
  terminalExportHandoff: "terminal:export-handoff",
  terminalKeepaliveList: "terminal:keepalive:list",
  terminalDashboard: "terminal:dashboard",
  terminalLastCommand: "terminal:last-command",
  terminalRefresh: "terminal:refresh",
  agentLauncherDir: "agent:launcher-dir",
  projectDelete: "project:delete",
  event: "stream:event",
  terminalData: "terminal:data",
  terminalExit: "terminal:exit",
  terminalListChanged: "terminal:list-changed",
  // Per-terminal ConPTY geometry push (desktop re-assertion signal, see
  // shared/pty-geometry.ts). Desktop-only consumer; not forwarded over WS.
  terminalGeometryChanged: "terminal:geometry-changed",
  terminalCommandFinished: "terminal:command-finished",
  // --- Agent Attention Center ----------------------------------------------
  // ptyStateChanged: generic, carries ALL canonical state transitions (push).
  // attentionChanged: only attention notifications (need-a-human), push.
  // attentionList/resolve: inbox RPC. WS reconnect replays unresolved metadata.
  ptyStateChanged: "terminal:pty-state-changed",
  attentionList: "attention:list",
  attentionResolve: "attention:resolve",
  attentionChanged: "attention:changed",
  usageGet: "usage:get",
  systemActivityGet: "system-activity:get",
  agentFileActivityGet: "agent-file-activity:get",
  worktreeRegistryGet: "worktree-registry:get",
  usageChanged: "usage:changed",
  // --- AgentApi fixed claude-local-main -> codex-local-main workflow ---------------------
  agentapiCreate: "agentapi:create",
  agentapiGet: "agentapi:get",
  agentapiResume: "agentapi:resume",
  agentapiPause: "agentapi:pause",
  agentapiCancel: "agentapi:cancel",
  // --- Phase 6: AgentApi voice agent / panel -------------------------------
  // World snapshot RPC + push (metadata only). Voice turn: utterance in, a
  // redacted spoken-safe answer out; interrupt cancels/circuit-preserves.
  // transcribeVoiceAgent ships audio over the authenticated web surface for
  // mobile; the STT key never leaves the main process.
  agentapiWorldSnapshot: "agentapi:world-snapshot",
  agentapiWorldChanged: "agentapi:world-changed",
  agentapiSemanticState: "agentapi:semantic-state",
  agentapiVoiceTurn: "agentapi:voice-turn",
  agentapiVoiceInterrupt: "agentapi:voice-interrupt",
  liveVoiceSession: "voice:live-session",
  transcribeVoiceAgent: "voice:agent-transcribe",
  appQuit: "app:quit",
  uiActionRecord: "ui-action:record",
  reportRendererError: "app:report-renderer-error",
  dockGetLayout: "dock:get-layout",
  dockOpenTile: "dock:open-tile",
  dockCloseTile: "dock:close-tile",
  dockSelectTile: "dock:select-tile",
  dockSetLayout: "dock:set-layout",
  dockSetExclusive: "dock:set-exclusive",
  // Drag a tile to a new slot inside the dock (桌機拖曳排序, 1.5.47 board).
  dockReorderTile: "dock:reorder-tile",
  dockLayoutChanged: "dock:layout-changed",
  // Hot model registry (stage 1): pushed when settings.customProfiles changes.
  // Carries the derived agent option list so pickers rebuild without restart.
  profilesChanged: "profiles:changed",
  // --- A — Worktree sandbox + trusted resume ------------------------------
  worktreeCreate: "worktree:create",
  worktreeList: "worktree:list",
  worktreeGet: "worktree:get",
  worktreeDiffSummary: "worktree:diff-summary",
  worktreeMerge: "worktree:merge",
  worktreeAbort: "worktree:abort",
  worktreeCleanup: "worktree:cleanup",
  worktreeBindSession: "worktree:bind-session",
  worktreeResume: "worktree:resume",
  // --- B — Checkpoint / undo-redo rail ------------------------------------
  checkpointList: "checkpoint:list",
  checkpointGet: "checkpoint:get",
  checkpointDiff: "checkpoint:diff",
  checkpointRestorePreview: "checkpoint:restore-preview",
  checkpointRestore: "checkpoint:restore",
  checkpointRestoreHunk: "checkpoint:restore-hunk",
  checkpointUndo: "checkpoint:undo",
  checkpointRedo: "checkpoint:redo",
  checkpointCreateExplicit: "checkpoint:create-explicit",
} as const;

/**
 * Prefix on the voice:transcribe rejection when Settings has no speech-to-text
 * server URL, so the renderer can say "configure a server" instead of "network
 * error". Electron wraps the message, hence a substring marker.
 */
export const NO_SERVER_CODE = "VOICE_NO_SERVER";

export interface AiTerminalApi {
  /** True on web/mobile clients (browser-api proxy). Desktop (Electron preload) does not set this. */
  readonly isBrowser?: boolean;
  /** Isolated Playwright-only voice engine seam; never enabled by normal launches. */
  readonly voiceTestHarness?: boolean;
  /** Desktop-only: real on-disk path of a picked/dropped File (Electron webUtils). Browser clients omit it. */
  getPathForFile?(file: File): string;
  /** Desktop-only privacy-safe interaction audit; browser clients may omit it. */
  recordUiAction?(input: UiActionRecordInput): Promise<void>;
  /** Desktop-only renderer→main error sink (coterm.log); browser clients may omit it. Content limits per RendererErrorReportInput. */
  reportRendererError?(input: RendererErrorReportInput): Promise<void>;
  quitApp(): Promise<void>;
  bootstrap(): Promise<BootstrapData>;
  getSettings(): Promise<AppSettings>;
  // #60: deep-partial patch semantics; a full AppSettings is a valid patch.
  setSettings(settings: AppSettingsPatch): Promise<AppSettings>;
  diagnostics(): Promise<Diagnostics>;
  exportDiagnostics(): Promise<string | null>;
  createBackup(): Promise<string | null>;
  restoreBackup(): Promise<string | null>;
  pickWorkspace(): Promise<string | null>;
  listWorkspace(input: WorkspaceListInput): Promise<WorkspaceEntry[]>;
  searchWorkspaceEntries(input: WorkspaceSearchInput): Promise<WorkspaceSearchResult[]>;
  renameWorkspaceEntry(input: WorkspaceRenameInput): Promise<WorkspaceEntry>;
  createWorkspaceFile(input: WorkspaceCreateInput): Promise<WorkspaceEntry>;
  createWorkspaceDirectory(input: WorkspaceCreateInput): Promise<WorkspaceEntry>;
  deleteWorkspaceEntry(input: WorkspacePathInput): Promise<void>;
  duplicateWorkspaceEntry(input: WorkspaceDuplicateInput): Promise<WorkspaceEntry>;
  revealWorkspaceEntry(input: WorkspacePathInput): Promise<void>;
  openWorkspaceEntryExternal(input: WorkspacePathInput): Promise<void>;
  search(input: GlobalSearchInput): Promise<GlobalSearchResult[]>;
  sessionIndexStatus(): Promise<{ syncing: boolean; lastCompletedAt: string | null }>;
  saveAttachment(input: AttachmentSaveInput): Promise<Attachment>;
  saveUpload(input: UploadSaveInput): Promise<{ localPath: string }>;
  listAttachments(conversationId: string): Promise<Attachment[]>;
  deleteAttachment(attachmentId: string): Promise<void>;
  readArtifact(input: ArtifactReadInput): Promise<ArtifactPreview>;
  readArtifactWorkbook(input: ArtifactTokenInput): Promise<SpreadsheetModel>;
  readArtifactPresentation(input: ArtifactTokenInput): Promise<PresentationModel>;
  openBrowserArtifact(input: BrowserArtifactInput): Promise<ArtifactPreview>;
  onBrowserArtifactSaved(callback: (artifact: BrowserArtifactSaved) => void): () => void;
  createBrowserSession(input?: BrowserSessionCreateInput): Promise<BrowserSessionInfo>;
  listBrowserSessions(): Promise<BrowserSessionInfo[]>;
  closeBrowserSession(sessionId: string): Promise<void>;
  newBrowserPage(input: { sessionId: string; url?: string }): Promise<BrowserPageInfo>;
  listBrowserPages(sessionId: string): Promise<BrowserPageInfo[]>;
  closeBrowserPage(input: { sessionId: string; pageId: string }): Promise<void>;
  selectBrowserPage(input: { sessionId: string; pageId: string }): Promise<BrowserPageInfo>;
  navigateBrowser(input: { pageId: string; url: string; waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit" }): Promise<BrowserPageInfo>;
  browserBack(pageId: string): Promise<BrowserPageInfo>;
  browserForward(pageId: string): Promise<BrowserPageInfo>;
  browserReload(pageId: string): Promise<BrowserPageInfo>;
  browserStop(pageId: string): Promise<void>;
  snapshotBrowser(input: { pageId: string; mode?: "compact" | "full" | "interactive"; includeBoundingBoxes?: boolean; maxChars?: number }): Promise<BrowserSnapshot>;
  clickBrowser(input: { pageId: string; target: BrowserLocator; returnSnapshot?: boolean }): Promise<BrowserActionResult>;
  clickBrowserCoordinates(input: { pageId: string; x: number; y: number; coordinateSpace: "viewport" | "document" | "screenshot"; snapshotId: string; screenshotWidth?: number; screenshotHeight?: number; returnSnapshot?: boolean }): Promise<BrowserActionResult>;
  fillBrowser(input: { pageId: string; target: BrowserLocator; value?: string; secretRef?: string; returnSnapshot?: boolean }): Promise<BrowserActionResult>;
  typeBrowser(input: { pageId: string; target: BrowserLocator; text: string; returnSnapshot?: boolean }): Promise<BrowserActionResult>;
  pressBrowser(input: { pageId: string; target: BrowserLocator; key: string; returnSnapshot?: boolean }): Promise<BrowserActionResult>;
  extractBrowser(input: { pageId: string; format: "json" | "markdown" | "text"; maxChars?: number }): Promise<BrowserDocument | string>;
  saveBrowserExtraction(input: { pageId: string; format: "json" | "markdown" | "text"; projectId: string; destinationPath?: string }): Promise<string>;
  searchBrowserIndex(input: { projectId: string; query: string; host?: string; crawlId?: string; limit?: number }): Promise<BrowserSearchResult[]>;
  screenshotBrowser(input: { pageId: string; fullPage?: boolean }): Promise<string>;
  openInAgentBrowser(target: string): Promise<{ ok: boolean; error?: string }>;
  // B4 (§12.2): the human types a secret locally and gets an opaque one-time
  // handle to hand to an agent (fill secretRef). The value never crosses IPC
  // in the other direction and is never logged or persisted.
  issueBrowserSecret(input: { value: string; ttlMs?: number }): Promise<{ handle: string; expiresInMs: number }>;
  writeArtifact(input: ArtifactWriteInput): Promise<void>;
  revealArtifact(input: ArtifactReadInput): Promise<void>;
  openArtifactExternal(input: ArtifactReadInput): Promise<void>;
  createProject(input: CreateProjectInput): Promise<Project>;
  renameProject(input: RenameProjectInput): Promise<Project>;
  pinProject(input: ProjectStateInput): Promise<Project>;
  reorderProjects(input: ReorderProjectsInput): Promise<Project[]>;
  archiveProject(input: ProjectStateInput): Promise<Project>;
  deleteProject(input: ProjectDeleteInput): Promise<void>;
  createConversation(input: CreateConversationInput): Promise<Conversation>;
  continueConversationWithProvider(input: ContinueConversationInput): Promise<Conversation>;
  renameConversation(input: RenameConversationInput): Promise<Conversation>;
  archiveConversation(input: ConversationStateInput): Promise<Conversation>;
  deleteConversation(conversationId: string): Promise<void>;
  listEvents(conversationId: string): Promise<NormalizedEvent[]>;
  listProjectSessions(projectId: string): Promise<ProjectHistorySession[]>;
  getConversationSession(conversationId: string): Promise<{ nativeSessionId: string | null } | null>;
  summarizeConversation(input: ConversationSummaryInput): Promise<Conversation>;
  setConversationClaudeModel(input: ConversationModelInput): Promise<Conversation>;
  listClaudeHistory(input: ClaudeHistoryListInput): Promise<ClaudeHistorySession[]>;
  readClaudeHistory(input: ClaudeHistoryReadInput): Promise<ClaudeHistoryTranscript>;
  adoptClaudeHistory(input: ClaudeHistoryReadInput): Promise<Conversation>;
  sendMessage(input: MessageInput): Promise<{ turnId: string }>;
  cancelMessage(turnId: string): Promise<void>;
  runTerminalCommand(input: TerminalCommandInput): Promise<void>;
  resolveApproval(input: ApprovalResolveInput): Promise<void>;
  resolveUserInput(input: UserInputResolveInput): Promise<void>;
  startCouncil(input: CouncilInput): Promise<{ turnGroupId: string; turnId: string }>;
  cancelCouncil(turnGroupId: string): Promise<void>;
  /** Omitted input reads the TTL cache; `{force:true}` is the 重探钮. */
  refreshProviders(input?: ProviderRefreshInput): Promise<ProviderStatus[]>;
  createTerminal(input: TerminalCreateInput): Promise<TerminalInfo>;
  writeTerminal(input: TerminalWriteInput): Promise<void>;
  /** In-memory E2E oracle; undefined in normal desktop/browser surfaces. */
  getVoiceTestWrites?(): Array<{ terminalId: string; data: string }>;
  transcribeVoice(input: { audio: ArrayBuffer; mimeType: string; lang: string }): Promise<{ text: string }>;
  warmVoice?(): Promise<void>;
  /** Renderer voice failures otherwise stay invisible to main logs. Stage codes and coarse detail only — never transcripts. */
  voiceDiag?(input: { stage: string; detail?: string }): Promise<void>;
  resizeTerminal(input: TerminalResizeInput): Promise<void>;
  /**
   * AT-158: remote client names the geometry it is looking at; main decides
   * and applies a rows-only ConPTY resize. Desktop tiles reclaim on refit.
   */
  requestTerminalGeometry(input: TerminalResizeInput): Promise<void>;
  renameTerminal(input: TerminalRenameInput): Promise<TerminalInfo>;
  /** 1.5.45 warroom band: set (or clear, with label: null) the top-edge colour. */
  setTerminalLabel(input: TerminalSetLabelInput): Promise<TerminalInfo>;
  markTerminalAgent(input: TerminalMarkAgentInput): Promise<TerminalInfo>;
  setTerminalNativeSessionId(input: TerminalSetNativeSessionIdInput): Promise<void>;
  killTerminal(input: TerminalIdInput): Promise<void>;
  listTerminals(projectId: string): Promise<TerminalInfo[]>;
  getPtyState(terminalId: string): Promise<PtyState | null>;
  /** Pane-header keepalive control (official claude/codex profiles only). */
  setTerminalKeepalive(input: TerminalKeepaliveSetInput): Promise<TerminalKeepaliveState>;
  /**
   * Pane-header handoff export (official claude/codex profiles only): main
   * compresses the session via the local free-model proxy into a markdown
   * handoff doc, writes it under <userData>/handoffs/, copies it to the
   * clipboard, and returns metadata only.
   */
  exportTerminalHandoff(terminalId: string): Promise<{
    ok: boolean;
    path?: string;
    chars?: number;
    model?: string;
    source?: "transcript" | "scrollback";
    /** true = the transcript was a "newest file" guess — maybe another
     *  window's session of the same project (renderer must say so). */
    approximate?: boolean;
    error?: string;
  }>;
  listTerminalKeepalives(): Promise<TerminalKeepaliveState[]>;
  getLastCommand(terminalId: string): Promise<CommandResult | null>;
  /** Directory holding generated per-profile launcher shims (#51), or null. */
  getAgentLauncherDir(): Promise<string | null>;
  getTerminalDashboard(): Promise<TerminalDashboardEntry[]>;
  getTerminalWorkspace(projectId: string): Promise<TerminalWorkspaceState>;
  getTerminalTranscript(terminalId: string): Promise<TerminalTranscript>;
  /** Pane-header "Session 資訊" block: profile, native id, absolute transcript
   *  path (resolver-backed, follows /clear/hops), pid, resume command. Null
   *  for plain shells. */
  getTerminalSessionInfo(terminalId: string): Promise<TerminalSessionInfo | null>;
  refreshTerminal(terminalId: string): Promise<void>;
  saveTerminalWorkspace(input: TerminalWorkspaceSaveInput): Promise<void>;
  onEvent(callback: (event: NormalizedEvent) => void): () => void;
  onTerminalData(callback: (payload: {
    terminalId: string;
    data: string;
    replace?: boolean;
    force?: boolean;
    revision: number;
  }) => void): () => void;
  onTerminalExit(callback: (payload: { terminalId: string; exitCode: number }) => void): () => void;
  onTerminalListChanged(callback: (payload: { projectId: string; projectIds?: string[] }) => void): () => void;
  /** Per-terminal ConPTY geometry push after an applied resize. Desktop
   *  panes use it to re-assert their fitted grid when another client resized
   *  the shared PTY meanwhile. Desktop-only (absent on the web client). */
  onTerminalGeometryChanged(callback: (payload: { terminalId: string; projectId: string; cols: number; rows: number }) => void): () => void;
  onTerminalCommand(callback: (payload: { terminalId: string; projectId: string; result: CommandResult }) => void): () => void;
  // --- Agent Attention Center ----------------------------------------------
  // listAttention: unresolved + recently-resolved inbox (metadata only).
  // resolveAttention: mark a notification resolved (user acted on it).
  // onPtyStateChanged: ALL canonical state transitions (desktop ring/badge).
  // onAttentionChanged: only need-a-human notifications (mobile push channel).
  listAttention(): Promise<AttentionNotification[]>;
  resolveAttention(input: AttentionResolveInput): Promise<void>;
  onPtyStateChanged(callback: (payload: { terminalId: string; projectId: string; state: PtyState; previousState: PtyState | null; source: string }) => void): () => void;
  onAttentionChanged(callback: (notification: AttentionNotification) => void): () => void;
  // --- Global usage HUD (paid accounts) -----------------------------------
  // getUsageSnapshot: current Claude 5h/7d + Codex 7d snapshot (main-owned).
  // onUsageChanged: pushed every 10s when the snapshot changes.
  getUsageSnapshot(): Promise<UsageSnapshot>;
  // Sidebar machine pulse (sunmoon): CPU/RAM + agent-written files since launch. Polled.
  getSystemActivity(): Promise<SystemActivity>;
  // Click-to-expand file list under the pulse (2026-10-06): per-file path/size/kind, capped 500. Polled while open.
  getAgentFileActivity(input?: { limit?: number }): Promise<AgentFileActivity>;
  // Session worktree registry (2026-10-12): read-only list of git worktrees created this session. Polled while open.
  getWorktreeRegistry(): Promise<WorktreeRegistryActivity>;
  onUsageChanged(callback: (snapshot: UsageSnapshot) => void): () => void;
  // --- AgentApi fixed orchestrator -----------------------------------------
  createAgentApiWorkflow(input: AgentApiWorkflowCreate): Promise<AgentApiWorkflow>;
  getAgentApiWorkflow(id: string): Promise<{ workflow: AgentApiWorkflow; steps: AgentApiWorkflowStep[] }>;
  resumeAgentApiWorkflow(id: string): Promise<AgentApiWorkflow>;
  pauseAgentApiWorkflow(id: string): Promise<AgentApiWorkflow>;
  cancelAgentApiWorkflow(id: string): Promise<AgentApiWorkflow>;
  // --- Phase 6: AgentApi voice agent / panel (desktop IPC + mobile RPC) ----
  /** Metadata-only world snapshot pull (panel hydrate). */
  getAgentApiWorldSnapshot(): Promise<AgentApiSessionWorldState[]>;
  /** Burst-coalesced world-state push (main-owned). */
  onAgentApiWorldChanged(callback: (sessions: AgentApiSessionWorldState[]) => void): () => void;
  /** Refresh and return one terminal's bounded/redacted semantic state. */
  getAgentApiSemanticState(terminalId: string): Promise<AgentApiSessionSemanticState | null>;
  /** One voice turn: utterance in, egress-redacted answer out. Fast-path
   * turns never touch the supervisor. */
  /** Returns null when the turn was interrupted/superseded before answering
   * (barge-in); the caller then silently drops the result. */
  agentapiVoiceTurn(input: AgentApiVoiceTurnInput): Promise<AgentApiVoiceTurnResult | null>;
  /** Barge-in button: bump epoch + abort the in-flight supervisor turn. */
  interruptAgentApiVoice(): Promise<{ epoch: number; aborted: boolean }>;
  /** Durable logical Live Voice call control. Raw audio is not part of this
   * protocol; final STT text and lifecycle metadata only. */
  liveVoiceSession(input: VoiceSessionCommand): Promise<VoiceSessionCommandResult>;
  /** Mobile/audio-over-HTTP seam: audio bytes go to main, the STT key never
   * leaves main. Desktop keeps the binary `transcribeVoice` channel; both
   * surfaces are driven by the same coordinator contract. */
  transcribeVoiceAgent(input: { audioBase64: string; mimeType: string; lang: string }): Promise<{ text: string }>;
  // --- Dock layout (terminal-first overhaul) ------------------------------
  // Main process is the single source of truth for the dock. Every mutation
  // returns the new DockLayout; onDockLayout pushes updates to the renderer.
  getDockLayout(): Promise<DockLayout>;
  openTile(input: DockOpenTileInput): Promise<DockLayout>;
  closeTile(input: DockCloseTileInput): Promise<DockLayout>;
  selectTile(input: DockSelectTileInput): Promise<DockLayout>;
  setDockLayout(input: DockSetLayoutInput): Promise<DockLayout>;
  setExclusive(input: DockSetExclusiveInput): Promise<DockLayout>;
  reorderTile(input: DockReorderTileInput): Promise<DockLayout>;
  onDockLayout(callback: (layout: DockLayout) => void): () => void;
  // Hot model registry (stage 1): full agent option list pushed when the
  // active profile table changes (settings.customProfiles write).
  onProfilesChanged(callback: (options: AgentOption[]) => void): () => void;
  // --- A — Worktree sandbox + trusted resume ------------------------------
  createWorktree(input: WorktreeCreateInput): Promise<Worktree>;
  listWorktrees(input: WorktreeListInput): Promise<Worktree[]>;
  getWorktree(input: WorktreeIdInput): Promise<Worktree | null>;
  worktreeDiffSummary(input: WorktreeIdInput): Promise<{ worktreeId: string; branch: string; baseRef: string; diffStat: string; commits: string; dirty: boolean }>;
  mergeWorktree(input: WorktreeMergeInput): Promise<Worktree>;
  abortWorktree(input: WorktreeIdInput): Promise<Worktree>;
  cleanupWorktree(input: WorktreeIdInput): Promise<void>;
  bindWorktreeSession(input: WorktreeBindSessionInput): Promise<void>;
  resumeWorktree(input: WorktreeResumeInput): Promise<{ command: string; worktree: Worktree }>;
  // --- B — Checkpoint / undo-redo rail ------------------------------------
  listCheckpoints(input: CheckpointListInput): Promise<Checkpoint[]>;
  getCheckpoint(input: CheckpointIdInput): Promise<Checkpoint | null>;
  checkpointDiff(input: CheckpointDiffInput): Promise<CheckpointDiff>;
  checkpointRestorePreview(input: CheckpointRestorePreviewInput): Promise<CheckpointRestorePreview>;
  restoreCheckpoint(input: CheckpointRestoreInput): Promise<Checkpoint>;
  restoreCheckpointHunk(input: CheckpointHunkRestoreInput): Promise<Checkpoint>;
  undoCheckpoint(input: CheckpointUndoInput): Promise<Checkpoint>;
  redoCheckpoint(input: CheckpointUndoInput): Promise<Checkpoint>;
  createExplicitCheckpoint(input: CheckpointCreateExplicitInput): Promise<Checkpoint>;
}
