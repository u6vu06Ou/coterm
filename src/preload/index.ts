import { contextBridge, ipcRenderer, webUtils } from "electron";
// 旗標由主程序用 additionalArguments 傳入；<html> 一出現就設好（glass=液態玻璃、titlebar=隱藏原生標題列）
const flags: Array<[string, string]> = [["--coterm-glass=1", "glass"], ["--coterm-titlebar=1", "titlebar"]];
const active = flags.filter(([arg]) => process.argv.includes(arg));
if (active.length > 0) {
  const mark = (): boolean => {
    if (!document.documentElement) return false;
    for (const [, key] of active) document.documentElement.dataset[key] = "1";
    return true;
  };
  if (!mark()) {
    const mo = new MutationObserver(() => { if (mark()) mo.disconnect(); });
    mo.observe(document, { childList: true });
  }
}

import type { AiTerminalApi, RendererErrorReportInput, UiActionRecordInput } from "@shared/ipc";
import { IPC } from "@shared/ipc";
import type { BrowserSessionCreateInput } from "@shared/browser-schema";
import type { BrowserLocator } from "@shared/browser-types";
import type {
  AgentOption,
  AppSettingsPatch,
  ClaudeHistoryListInput,
  ClaudeHistoryReadInput,
  ApprovalResolveInput,
  UserInputResolveInput,
  ArtifactReadInput,
  ArtifactWriteInput,
  ArtifactPreview,
  ArtifactTokenInput,
  BrowserArtifactInput,
  BrowserArtifactSaved,
  SpreadsheetModel,
  PresentationModel,
  AttachmentSaveInput,
  UploadSaveInput,
  ContinueConversationInput,
  ConversationStateInput,
  ConversationModelInput,
  ConversationSummaryInput,
  CouncilInput,
  CreateConversationInput,
  CreateProjectInput,
  MessageInput,
  NormalizedEvent,
  ProjectStateInput,
  ReorderProjectsInput,
  RenameConversationInput,
  RenameProjectInput,
  TerminalCreateInput,
  TerminalCommandInput,
  TerminalIdInput,
  TerminalRenameInput,
  TerminalSetLabelInput,
  TerminalMarkAgentInput,
  TerminalResizeInput,
  TerminalSetNativeSessionIdInput,
  TerminalKeepaliveSetInput,
  TerminalWorkspaceSaveInput,
  TerminalWriteInput,
  WorkspaceListInput,
  WorkspaceSearchInput,
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
  AttentionNotification,
  AttentionResolveInput,
  UsageSnapshot,
  PtyState,
  AgentApiWorkflowCreate,
  AgentApiSessionWorldState,
  AgentApiSessionSemanticState,
  AgentApiVoiceTurnInput,
  VoiceSessionCommand,
  WorktreeCreateInput,
  WorktreeListInput,
  WorktreeIdInput,
  WorktreeMergeInput,
  WorktreeBindSessionInput,
  WorktreeResumeInput,
  CheckpointListInput,
  CheckpointIdInput,
  CheckpointDiffInput,
  CheckpointRestorePreviewInput,
  CheckpointRestoreInput,
  CheckpointHunkRestoreInput,
  CheckpointUndoInput,
  CheckpointCreateExplicitInput,
  CommandResult,
} from "@shared/types";

const voiceTestHarness = process.env.COTERM_E2E_VOICE_HARNESS === "1";
const voiceTestWrites: Array<{ terminalId: string; data: string }> = [];

const api: AiTerminalApi = {
  voiceTestHarness,
  recordUiAction: (input: UiActionRecordInput) => ipcRenderer.invoke(IPC.uiActionRecord, input),
  reportRendererError: (input: RendererErrorReportInput) =>
    ipcRenderer.invoke(IPC.reportRendererError, input),
  quitApp: () => ipcRenderer.invoke(IPC.appQuit),
  bootstrap: () => ipcRenderer.invoke(IPC.bootstrap),
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  setSettings: (settings: AppSettingsPatch) => ipcRenderer.invoke(IPC.settingsSet, settings),
  diagnostics: () => ipcRenderer.invoke(IPC.diagnostics),
  exportDiagnostics: () => ipcRenderer.invoke(IPC.diagnosticsExport),
  createBackup: () => ipcRenderer.invoke(IPC.backupCreate),
  restoreBackup: async () => {
    const source: unknown = await ipcRenderer.invoke(IPC.backupRestore);
    if (source !== null && typeof source !== "string") {
      throw new Error("Invalid backup restore response.");
    }
    if (source) ipcRenderer.send(IPC.backupRestoreRelaunch);
    return source;
  },
  pickWorkspace: () => ipcRenderer.invoke(IPC.workspacePick),
  listWorkspace: (input: WorkspaceListInput) => ipcRenderer.invoke(IPC.workspaceList, input),
  searchWorkspaceEntries: (input: WorkspaceSearchInput) => ipcRenderer.invoke(IPC.workspaceSearch, input),
  renameWorkspaceEntry: (input: WorkspaceRenameInput) => ipcRenderer.invoke(IPC.workspaceRename, input),
  createWorkspaceFile: (input: WorkspaceCreateInput) => ipcRenderer.invoke(IPC.workspaceCreateFile, input),
  createWorkspaceDirectory: (input: WorkspaceCreateInput) => ipcRenderer.invoke(IPC.workspaceCreateDirectory, input),
  deleteWorkspaceEntry: (input: WorkspacePathInput) => ipcRenderer.invoke(IPC.workspaceDelete, input),
  duplicateWorkspaceEntry: (input: WorkspaceDuplicateInput) => ipcRenderer.invoke(IPC.workspaceDuplicate, input),
  revealWorkspaceEntry: (input: WorkspacePathInput) => ipcRenderer.invoke(IPC.workspaceReveal, input),
  openWorkspaceEntryExternal: (input: WorkspacePathInput) => ipcRenderer.invoke(IPC.workspaceOpenExternal, input),
  search: (input) => ipcRenderer.invoke(IPC.search, input),
  sessionIndexStatus: () => ipcRenderer.invoke(IPC.sessionIndexStatus),
  saveAttachment: (input: AttachmentSaveInput) => ipcRenderer.invoke(IPC.attachmentSave, input),
  saveUpload: (input: UploadSaveInput) => ipcRenderer.invoke(IPC.uploadSave, input),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  listAttachments: (conversationId: string) =>
    ipcRenderer.invoke(IPC.attachmentsList, conversationId),
  deleteAttachment: (attachmentId: string) =>
    ipcRenderer.invoke(IPC.attachmentDelete, attachmentId),
  readArtifact: async (input: ArtifactReadInput) =>
    parseArtifactPreview(await ipcRenderer.invoke(IPC.artifactRead, input)),
  readArtifactWorkbook: async (input: ArtifactTokenInput) =>
    parseWorkbook(await ipcRenderer.invoke(IPC.artifactWorkbookRead, input)),
  readArtifactPresentation: async (input: ArtifactTokenInput) =>
    parsePresentation(await ipcRenderer.invoke(IPC.artifactPresentationRead, input)),
  openBrowserArtifact: async (input: BrowserArtifactInput) =>
    parseArtifactPreview(await ipcRenderer.invoke(IPC.browserArtifactOpen, input)),
  createBrowserSession: (input?: BrowserSessionCreateInput) => ipcRenderer.invoke(IPC.browserSessionCreate, input ?? {}),
  listBrowserSessions: () => ipcRenderer.invoke(IPC.browserSessionList),
  closeBrowserSession: (sessionId: string) => ipcRenderer.invoke(IPC.browserSessionClose, sessionId),
  newBrowserPage: (input: { sessionId: string; url?: string }) => ipcRenderer.invoke(IPC.browserPageNew, input),
  listBrowserPages: (sessionId: string) => ipcRenderer.invoke(IPC.browserPageList, sessionId),
  closeBrowserPage: (input: { sessionId: string; pageId: string }) => ipcRenderer.invoke(IPC.browserPageClose, input),
  selectBrowserPage: (input: { sessionId: string; pageId: string }) => ipcRenderer.invoke(IPC.browserPageSelect, input),
  navigateBrowser: (input: { pageId: string; url: string; waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit" }) => ipcRenderer.invoke(IPC.browserNavigate, input),
  browserBack: (pageId: string) => ipcRenderer.invoke(IPC.browserBack, pageId),
  browserForward: (pageId: string) => ipcRenderer.invoke(IPC.browserForward, pageId),
  browserReload: (pageId: string) => ipcRenderer.invoke(IPC.browserReload, pageId),
  browserStop: (pageId: string) => ipcRenderer.invoke(IPC.browserStop, pageId),
  snapshotBrowser: (input: { pageId: string; mode?: "compact" | "full" | "interactive"; includeBoundingBoxes?: boolean; maxChars?: number }) => ipcRenderer.invoke(IPC.browserSnapshot, input),
  clickBrowser: (input: { pageId: string; target: BrowserLocator; returnSnapshot?: boolean }) => ipcRenderer.invoke(IPC.browserClick, input),
  clickBrowserCoordinates: (input: { pageId: string; x: number; y: number; coordinateSpace: "viewport" | "document" | "screenshot"; snapshotId: string; screenshotWidth?: number; screenshotHeight?: number; returnSnapshot?: boolean }) => ipcRenderer.invoke(IPC.browserClickCoordinates, input),
  fillBrowser: (input: { pageId: string; target: BrowserLocator; value?: string; secretRef?: string; returnSnapshot?: boolean }) => ipcRenderer.invoke(IPC.browserFill, input),
  typeBrowser: (input: { pageId: string; target: BrowserLocator; text: string; returnSnapshot?: boolean }) => ipcRenderer.invoke(IPC.browserType, input),
  pressBrowser: (input: { pageId: string; target: BrowserLocator; key: string; returnSnapshot?: boolean }) => ipcRenderer.invoke(IPC.browserPress, input),
  extractBrowser: (input: { pageId: string; format: "json" | "markdown" | "text"; maxChars?: number }) => ipcRenderer.invoke(IPC.browserExtract, input),
  saveBrowserExtraction: (input: { pageId: string; format: "json" | "markdown" | "text"; projectId: string; destinationPath?: string }) => ipcRenderer.invoke(IPC.browserSaveExtraction, input),
  searchBrowserIndex: (input: { projectId: string; query: string; host?: string; crawlId?: string; limit?: number }) => ipcRenderer.invoke(IPC.browserSearchIndex, input),
  screenshotBrowser: (input: { pageId: string; fullPage?: boolean }) => ipcRenderer.invoke(IPC.browserScreenshot, input),
  issueBrowserSecret: (input: { value: string; ttlMs?: number }) => ipcRenderer.invoke(IPC.browserSecretIssue, input),
  openInAgentBrowser: (target: string) => ipcRenderer.invoke(IPC.browserOpenInAgent, { target }),
  writeArtifact: (input: ArtifactWriteInput) => ipcRenderer.invoke(IPC.artifactWrite, input),
  revealArtifact: (input: ArtifactReadInput) => ipcRenderer.invoke(IPC.artifactReveal, input),
  openArtifactExternal: (input: ArtifactReadInput) => ipcRenderer.invoke(IPC.artifactOpenExternal, input),
  createProject: (input: CreateProjectInput) => ipcRenderer.invoke(IPC.projectsCreate, input),
  renameProject: (input: RenameProjectInput) => ipcRenderer.invoke(IPC.projectsRename, input),
  pinProject: (input: ProjectStateInput) => ipcRenderer.invoke(IPC.projectsPin, input),
  reorderProjects: (input: ReorderProjectsInput) => ipcRenderer.invoke(IPC.projectsReorder, input),
  archiveProject: (input: ProjectStateInput) => ipcRenderer.invoke(IPC.projectsArchive, input),
  createConversation: (input: CreateConversationInput) =>
    ipcRenderer.invoke(IPC.conversationsCreate, input),
  continueConversationWithProvider: (input: ContinueConversationInput) =>
    ipcRenderer.invoke(IPC.conversationsContinue, input),
  renameConversation: (input: RenameConversationInput) =>
    ipcRenderer.invoke(IPC.conversationsRename, input),
  archiveConversation: (input: ConversationStateInput) =>
    ipcRenderer.invoke(IPC.conversationsArchive, input),
  deleteConversation: (conversationId: string) =>
    ipcRenderer.invoke(IPC.conversationsDelete, conversationId),
  listEvents: (conversationId: string) =>
    ipcRenderer.invoke(IPC.conversationsEvents, conversationId),
  listProjectSessions: (projectId: string) =>
    ipcRenderer.invoke(IPC.projectSessions, projectId),
  getConversationSession: (conversationId: string) =>
    ipcRenderer.invoke(IPC.conversationsSession, conversationId),
  summarizeConversation: (input: ConversationSummaryInput) =>
    ipcRenderer.invoke(IPC.conversationsSummarize, input),
  setConversationClaudeModel: (input: ConversationModelInput) =>
    ipcRenderer.invoke(IPC.conversationsModel, input),
  listClaudeHistory: (input: ClaudeHistoryListInput) =>
    ipcRenderer.invoke(IPC.claudeHistoryList, input),
  readClaudeHistory: (input: ClaudeHistoryReadInput) =>
    ipcRenderer.invoke(IPC.claudeHistoryRead, input),
  adoptClaudeHistory: (input: ClaudeHistoryReadInput) =>
    ipcRenderer.invoke(IPC.claudeHistoryAdopt, input),
  sendMessage: (input: MessageInput) => ipcRenderer.invoke(IPC.messageSend, input),
  cancelMessage: (turnId: string) => ipcRenderer.invoke(IPC.messageCancel, turnId),
  runTerminalCommand: (input: TerminalCommandInput) =>
    ipcRenderer.invoke(IPC.terminalCommand, input),
  resolveApproval: (input: ApprovalResolveInput) =>
    ipcRenderer.invoke(IPC.approvalResolve, input),
  resolveUserInput: (input: UserInputResolveInput) =>
    ipcRenderer.invoke(IPC.userInputResolve, input),
  startCouncil: (input: CouncilInput) => ipcRenderer.invoke(IPC.councilStart, input),
  cancelCouncil: (turnGroupId: string) => ipcRenderer.invoke(IPC.councilCancel, turnGroupId),
  refreshProviders: (input) => ipcRenderer.invoke(IPC.providersRefresh, input),
  createTerminal: (input: TerminalCreateInput) => ipcRenderer.invoke(IPC.terminalCreate, input),
  writeTerminal: (input: TerminalWriteInput) => {
    if (voiceTestHarness && input.source === "voice") {
      voiceTestWrites.push({ terminalId: input.terminalId, data: input.data });
    }
    return ipcRenderer.invoke(IPC.terminalWrite, input);
  },
  ...(voiceTestHarness
    ? { getVoiceTestWrites: () => voiceTestWrites.map((entry) => ({ ...entry })) }
    : {}),
  transcribeVoice: (input: { audio: ArrayBuffer; mimeType: string; lang: string }) =>
    ipcRenderer.invoke(IPC.voiceTranscribe, input),
  warmVoice: () => ipcRenderer.invoke(IPC.voiceWarmup),
  voiceDiag: (input: { stage: string; detail?: string }) =>
    ipcRenderer.invoke(IPC.voiceDiag, input),
  resizeTerminal: (input: TerminalResizeInput) => ipcRenderer.invoke(IPC.terminalResize, input),
  requestTerminalGeometry: (input: TerminalResizeInput) => ipcRenderer.invoke(IPC.terminalRequestGeometry, input),
  renameTerminal: (input: TerminalRenameInput) => ipcRenderer.invoke(IPC.terminalRename, input),
  setTerminalLabel: (input: TerminalSetLabelInput) => ipcRenderer.invoke(IPC.terminalSetLabel, input),
  markTerminalAgent: (input: TerminalMarkAgentInput) => ipcRenderer.invoke(IPC.terminalMarkAgent, input),
  setTerminalNativeSessionId: (input: TerminalSetNativeSessionIdInput) => ipcRenderer.invoke(IPC.terminalSetNativeSessionId, input),
  killTerminal: (input: TerminalIdInput) => ipcRenderer.invoke(IPC.terminalKill, input),
  listTerminals: (projectId: string) => ipcRenderer.invoke(IPC.terminalList, projectId),
  getPtyState: (terminalId: string) => ipcRenderer.invoke(IPC.terminalPtyState, terminalId),
  setTerminalKeepalive: (input: TerminalKeepaliveSetInput) => ipcRenderer.invoke(IPC.terminalKeepaliveSet, input),
  exportTerminalHandoff: (terminalId: string) => ipcRenderer.invoke(IPC.terminalExportHandoff, terminalId),
  listTerminalKeepalives: () => ipcRenderer.invoke(IPC.terminalKeepaliveList),
  getLastCommand: (terminalId: string) => ipcRenderer.invoke(IPC.terminalLastCommand, terminalId),
  getAgentLauncherDir: () => ipcRenderer.invoke(IPC.agentLauncherDir) as Promise<string | null>,
  getTerminalDashboard: () => ipcRenderer.invoke(IPC.terminalDashboard),
  listAttention: () => ipcRenderer.invoke(IPC.attentionList),
  resolveAttention: (input: AttentionResolveInput) => ipcRenderer.invoke(IPC.attentionResolve, input),
  getUsageSnapshot: () => ipcRenderer.invoke(IPC.usageGet),
  getSystemActivity: () => ipcRenderer.invoke(IPC.systemActivityGet),
  getAgentFileActivity: (input?: { limit?: number }) => ipcRenderer.invoke(IPC.agentFileActivityGet, input),
  getWorktreeRegistry: () => ipcRenderer.invoke(IPC.worktreeRegistryGet),
  refreshTerminal: (terminalId: string) => ipcRenderer.invoke(IPC.terminalRefresh, terminalId),
  deleteProject: (input: { projectId: string }) => ipcRenderer.invoke(IPC.projectDelete, input),
  getTerminalWorkspace: (projectId: string) =>
    ipcRenderer.invoke(IPC.terminalWorkspaceGet, projectId),
  getTerminalTranscript: (terminalId: string) =>
    ipcRenderer.invoke(IPC.terminalTranscriptGet, terminalId),
  getTerminalSessionInfo: (terminalId: string) =>
    ipcRenderer.invoke(IPC.terminalSessionInfoGet, terminalId),
  saveTerminalWorkspace: (input: TerminalWorkspaceSaveInput) =>
    ipcRenderer.invoke(IPC.terminalWorkspaceSave, input),
  onEvent: (callback: (event: NormalizedEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: NormalizedEvent) => callback(payload);
    ipcRenderer.on(IPC.event, listener);
    return () => ipcRenderer.removeListener(IPC.event, listener);
  },
  onTerminalData: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { terminalId: string; data: string; replace?: boolean; force?: boolean; revision: number },
    ) => callback(payload);
    ipcRenderer.on(IPC.terminalData, listener);
    return () => ipcRenderer.removeListener(IPC.terminalData, listener);
  },
  onTerminalExit: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { terminalId: string; exitCode: number },
    ) => callback(payload);
    ipcRenderer.on(IPC.terminalExit, listener);
    return () => ipcRenderer.removeListener(IPC.terminalExit, listener);
  },
  onTerminalListChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { projectId: string; projectIds?: string[] }) => callback(payload);
    ipcRenderer.on(IPC.terminalListChanged, listener);
    return () => ipcRenderer.removeListener(IPC.terminalListChanged, listener);
  },
  onTerminalGeometryChanged: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { terminalId: string; projectId: string; cols: number; rows: number },
    ) => callback(payload);
    ipcRenderer.on(IPC.terminalGeometryChanged, listener);
    return () => ipcRenderer.removeListener(IPC.terminalGeometryChanged, listener);
  },
  onTerminalCommand: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { terminalId: string; projectId: string; result: CommandResult },
    ) => callback(payload);
    ipcRenderer.on(IPC.terminalCommandFinished, listener);
    return () => ipcRenderer.removeListener(IPC.terminalCommandFinished, listener);
  },
  onPtyStateChanged: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { terminalId: string; projectId: string; state: PtyState; previousState: PtyState | null; source: string },
    ) => callback(payload);
    ipcRenderer.on(IPC.ptyStateChanged, listener);
    return () => ipcRenderer.removeListener(IPC.ptyStateChanged, listener);
  },
  onAttentionChanged: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      notification: AttentionNotification,
    ) => callback(notification);
    ipcRenderer.on(IPC.attentionChanged, listener);
    return () => ipcRenderer.removeListener(IPC.attentionChanged, listener);
  },
  onUsageChanged: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      snapshot: UsageSnapshot,
    ) => callback(snapshot);
    ipcRenderer.on(IPC.usageChanged, listener);
    return () => ipcRenderer.removeListener(IPC.usageChanged, listener);
  },
  onBrowserArtifactSaved: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      artifact: BrowserArtifactSaved,
    ) => callback(artifact);
    ipcRenderer.on(IPC.browserArtifactSaved, listener);
    return () => ipcRenderer.removeListener(IPC.browserArtifactSaved, listener);
  },
  createAgentApiWorkflow: (input: AgentApiWorkflowCreate) => ipcRenderer.invoke(IPC.agentapiCreate, input),
  getAgentApiWorkflow: (id: string) => ipcRenderer.invoke(IPC.agentapiGet, id),
  resumeAgentApiWorkflow: (id: string) => ipcRenderer.invoke(IPC.agentapiResume, id),
  pauseAgentApiWorkflow: (id: string) => ipcRenderer.invoke(IPC.agentapiPause, id),
  cancelAgentApiWorkflow: (id: string) => ipcRenderer.invoke(IPC.agentapiCancel, id),
  // --- Phase 6: AgentApi voice agent / panel -------------------------------
  getAgentApiWorldSnapshot: () => ipcRenderer.invoke(IPC.agentapiWorldSnapshot),
  onAgentApiWorldChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AgentApiSessionWorldState[]) => callback(payload);
    ipcRenderer.on(IPC.agentapiWorldChanged, listener);
    return () => ipcRenderer.removeListener(IPC.agentapiWorldChanged, listener);
  },
  getAgentApiSemanticState: (terminalId: string): Promise<AgentApiSessionSemanticState | null> =>
    ipcRenderer.invoke(IPC.agentapiSemanticState, terminalId),
  agentapiVoiceTurn: (input: AgentApiVoiceTurnInput) => ipcRenderer.invoke(IPC.agentapiVoiceTurn, input),
  interruptAgentApiVoice: () => ipcRenderer.invoke(IPC.agentapiVoiceInterrupt),
  liveVoiceSession: (input: VoiceSessionCommand) => ipcRenderer.invoke(IPC.liveVoiceSession, input),
  transcribeVoiceAgent: (input: { audioBase64: string; mimeType: string; lang: string }) =>
    ipcRenderer.invoke(IPC.transcribeVoiceAgent, input),
  // --- Dock layout (terminal-first overhaul) ------------------------------
  getDockLayout: () => ipcRenderer.invoke(IPC.dockGetLayout),
  openTile: (input: DockOpenTileInput) => ipcRenderer.invoke(IPC.dockOpenTile, input),
  closeTile: (input: DockCloseTileInput) => ipcRenderer.invoke(IPC.dockCloseTile, input),
  selectTile: (input: DockSelectTileInput) => ipcRenderer.invoke(IPC.dockSelectTile, input),
  setDockLayout: (input: DockSetLayoutInput) => ipcRenderer.invoke(IPC.dockSetLayout, input),
  setExclusive: (input: DockSetExclusiveInput) => ipcRenderer.invoke(IPC.dockSetExclusive, input),
  reorderTile: (input: DockReorderTileInput) => ipcRenderer.invoke(IPC.dockReorderTile, input),
  onDockLayout: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: DockLayout,
    ) => callback(payload);
    ipcRenderer.on(IPC.dockLayoutChanged, listener);
    return () => ipcRenderer.removeListener(IPC.dockLayoutChanged, listener);
  },
  // Hot model registry (stage 1): full agent option list pushed when the
  // active profile table changes; every picker rebuilds without a restart.
  onProfilesChanged: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      options: AgentOption[],
    ) => callback(options);
    ipcRenderer.on(IPC.profilesChanged, listener);
    return () => ipcRenderer.removeListener(IPC.profilesChanged, listener);
  },
  // --- A — Worktree sandbox + trusted resume ------------------------------
  createWorktree: (input: WorktreeCreateInput) => ipcRenderer.invoke(IPC.worktreeCreate, input),
  listWorktrees: (input: WorktreeListInput) => ipcRenderer.invoke(IPC.worktreeList, input),
  getWorktree: (input: WorktreeIdInput) => ipcRenderer.invoke(IPC.worktreeGet, input),
  worktreeDiffSummary: (input: WorktreeIdInput) => ipcRenderer.invoke(IPC.worktreeDiffSummary, input),
  mergeWorktree: (input: WorktreeMergeInput) => ipcRenderer.invoke(IPC.worktreeMerge, input),
  abortWorktree: (input: WorktreeIdInput) => ipcRenderer.invoke(IPC.worktreeAbort, input),
  cleanupWorktree: (input: WorktreeIdInput) => ipcRenderer.invoke(IPC.worktreeCleanup, input),
  bindWorktreeSession: (input: WorktreeBindSessionInput) => ipcRenderer.invoke(IPC.worktreeBindSession, input),
  resumeWorktree: (input: WorktreeResumeInput) => ipcRenderer.invoke(IPC.worktreeResume, input),
  // --- B — Checkpoint / undo-redo rail ------------------------------------
  listCheckpoints: (input: CheckpointListInput) => ipcRenderer.invoke(IPC.checkpointList, input),
  getCheckpoint: (input: CheckpointIdInput) => ipcRenderer.invoke(IPC.checkpointGet, input),
  checkpointDiff: (input: CheckpointDiffInput) => ipcRenderer.invoke(IPC.checkpointDiff, input),
  checkpointRestorePreview: (input: CheckpointRestorePreviewInput) => ipcRenderer.invoke(IPC.checkpointRestorePreview, input),
  restoreCheckpoint: (input: CheckpointRestoreInput) => ipcRenderer.invoke(IPC.checkpointRestore, input),
  restoreCheckpointHunk: (input: CheckpointHunkRestoreInput) => ipcRenderer.invoke(IPC.checkpointRestoreHunk, input),
  undoCheckpoint: (input: CheckpointUndoInput) => ipcRenderer.invoke(IPC.checkpointUndo, input),
  redoCheckpoint: (input: CheckpointUndoInput) => ipcRenderer.invoke(IPC.checkpointRedo, input),
  createExplicitCheckpoint: (input: CheckpointCreateExplicitInput) => ipcRenderer.invoke(IPC.checkpointCreateExplicit, input),
};

contextBridge.exposeInMainWorld("aiTerminal", api);

function parseArtifactPreview(value: unknown): ArtifactPreview {
  if (!value || typeof value !== "object") throw new Error("Invalid artifact preview response.");
  const preview = value as Record<string, unknown>;
  const kinds = ["image", "video", "pdf", "markdown", "html", "code", "text", "spreadsheet", "presentation", "browser", "unsupported"];
  if (
    !kinds.includes(String(preview.kind)) ||
    typeof preview.mimeType !== "string" ||
    typeof preview.path !== "string" ||
    typeof preview.size !== "number" ||
    preview.size < 0
  ) throw new Error("Invalid artifact preview response.");
  const binary = preview.kind === "image" || preview.kind === "video" || preview.kind === "pdf";
  const office = preview.kind === "spreadsheet" || preview.kind === "presentation";
  if (binary && typeof preview.dataUrl !== "string") {
    throw new Error("Artifact preview content is missing.");
  }
  if (!binary && !office && preview.kind !== "browser" && preview.kind !== "unsupported" && typeof preview.text !== "string") {
    throw new Error("Artifact preview content is missing.");
  }
  if (preview.kind === "spreadsheet" && typeof preview.workbookToken !== "string") throw new Error("Spreadsheet preview token is missing.");
  if (preview.kind === "presentation" && typeof preview.presentationToken !== "string") throw new Error("Presentation preview token is missing.");
  if (preview.kind === "browser" && typeof preview.url !== "string") throw new Error("Browser artifact URL is missing.");
  return preview as ArtifactPreview;
}

function parseWorkbook(value: unknown): SpreadsheetModel {
  if (!value || typeof value !== "object" || !Array.isArray((value as { sheets?: unknown }).sheets)) throw new Error("Invalid workbook preview response.");
  return value as SpreadsheetModel;
}

function parsePresentation(value: unknown): PresentationModel {
  if (!value || typeof value !== "object" || !Array.isArray((value as { slides?: unknown }).slides)) throw new Error("Invalid presentation preview response.");
  return value as PresentationModel;
}
