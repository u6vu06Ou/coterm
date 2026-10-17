import type { AppOperations } from "../core/app-operations";
import type { AgentApiOrchestrator } from "../core/agentapi-orchestrator";
import type { AgentApiStateService } from "../core/agentapi-state-service";
import type { AgentApiVoiceOrchestrator } from "../core/agentapi-voice-orchestrator";
import type { AgentSemanticProjector } from "../core/agentapi-semantic-projector";
import type { SessionSemanticStore } from "../core/session-semantic-store";
import type { AppSettings } from "@shared/types";
import { transcribeVoiceAgentClip } from "../voice/agent-transcribe";
import { getLauncherDir } from "../providers/agent-shims";
import type { PersistentVoiceSurface } from "../voice/live/persistent-voice-surface";

export const rpcMethods = [
  "bootstrap", "recordUiAction", "reportRendererError", "getSettings", "setSettings", "pickWorkspace", "createProject",
  "listWorkspace", "searchWorkspaceEntries", "renameWorkspaceEntry", "createWorkspaceFile", "createWorkspaceDirectory", "deleteWorkspaceEntry", "duplicateWorkspaceEntry", "revealWorkspaceEntry", "openWorkspaceEntryExternal", "search", "sessionIndexStatus", "saveAttachment", "saveUpload", "listAttachments", "deleteAttachment",
  "readArtifact", "readArtifactWorkbook", "readArtifactPresentation", "openBrowserArtifact", "createBrowserSession", "openInAgentBrowser", "listBrowserSessions", "closeBrowserSession", "newBrowserPage", "listBrowserPages", "closeBrowserPage", "selectBrowserPage", "navigateBrowser", "browserBack", "browserForward", "browserReload", "browserStop", "snapshotBrowser", "clickBrowser", "clickBrowserCoordinates", "fillBrowser", "typeBrowser", "pressBrowser", "extractBrowser", "saveBrowserExtraction", "searchBrowserIndex", "screenshotBrowser", "writeArtifact",
  "renameProject", "pinProject", "archiveProject",
  "createConversation", "renameConversation", "archiveConversation", "deleteConversation", "listEvents", "listProjectSessions", "getConversationSession",
  "continueConversationWithProvider",
  "summarizeConversation", "setConversationClaudeModel",
  "listClaudeHistory", "readClaudeHistory", "adoptClaudeHistory",
  "sendMessage", "cancelMessage", "runTerminalCommand", "resolveApproval", "resolveUserInput",
  "startCouncil", "cancelCouncil", "refreshProviders",
  "createTerminal", "writeTerminal", "resizeTerminal", "requestTerminalGeometry", "renameTerminal", "setTerminalLabel", "markTerminalAgent", "markTerminalAgentOwned", "setTerminalNativeSessionId", "getPtyState", "setTerminalKeepalive", "listTerminalKeepalives", "getAgentStateExplanation", "getLastCommand", "getTerminalDashboard",
  "killTerminal", "listTerminals", "getTerminalWorkspace", "saveTerminalWorkspace", "getTerminalTranscript",
  "getDockLayout", "openTile", "closeTile", "selectTile", "setDockLayout", "setExclusive",
  "listAttention", "resolveAttention", "getUsageSnapshot", "getSystemActivity", "getAgentFileActivity", "getWorktreeRegistry",
  // Phone/web +agent needs the shim dir too; without it the renderer falls back
  // to the inline env wall, which hard-wires LLM proxy and drops profile env
  // (claude-team opened from the phone silently ran on Qwen, 2026-10-06).
  "getAgentLauncherDir",
  "createAgentApiWorkflow", "getAgentApiWorkflow", "resumeAgentApiWorkflow", "pauseAgentApiWorkflow", "cancelAgentApiWorkflow",
  "createWorktree", "listWorktrees", "getWorktree", "worktreeDiffSummary", "mergeWorktree", "abortWorktree", "cleanupWorktree", "bindWorktreeSession", "resumeWorktree",
  "listCheckpoints", "getCheckpoint", "checkpointDiff", "checkpointRestorePreview", "restoreCheckpoint", "undoCheckpoint", "redoCheckpoint", "createExplicitCheckpoint",
  // Phase 6: voice agent / panel over the SAME authenticated surface — the
  // STT key and world state stay in main; mobile receives redacted text.
  "getAgentApiWorldSnapshot", "getAgentApiSemanticState", "agentapiVoiceTurn", "interruptAgentApiVoice", "liveVoiceSession", "transcribeVoiceAgent",
] as const;

export type RpcMethod = (typeof rpcMethods)[number];
export type WebOperations = Partial<Record<RpcMethod, (...args: unknown[]) => unknown>>;
const rpcMethodSet = new Set<string>(rpcMethods);

export function isRpcMethod(value: unknown): value is RpcMethod {
  return typeof value === "string" && rpcMethodSet.has(value);
}

export function bindWebOperations(
  operations: AppOperations,
  agentapi?: Pick<AgentApiOrchestrator, "create" | "get" | "resume" | "pause" | "cancel">,
  voiceSurface?: {
    agentapiState: Pick<AgentApiStateService, "getWorldState">;
    agentapiVoice: Pick<AgentApiVoiceOrchestrator, "turn" | "interrupt">;
    persistentVoice?: Pick<PersistentVoiceSurface, "handle">;
    agentapiSemantic?: {
      projector: Pick<AgentSemanticProjector, "refreshTranscript">;
      store: Pick<SessionSemanticStore, "get">;
    };
    getSettings: () => AppSettings;
  },
): WebOperations {
  return {
    bootstrap: () => operations.bootstrap(), recordUiAction: (input) => operations.recordUiAction(input),
    reportRendererError: (input) => operations.reportRendererError(input),
    getSettings: () => operations.getSettings(),
    pickWorkspace: () => operations.pickWorkspace(), createProject: (input) => operations.createProject(input),
    setSettings: (input) => operations.setSettings(input), listWorkspace: (input) => operations.listWorkspace(input), searchWorkspaceEntries: (input) => operations.searchWorkspaceEntries(input),
    renameWorkspaceEntry: (input) => operations.renameWorkspaceEntry(input),
    createWorkspaceFile: (input) => operations.createWorkspaceFile(input),
    createWorkspaceDirectory: (input) => operations.createWorkspaceDirectory(input),
    deleteWorkspaceEntry: (input) => operations.deleteWorkspaceEntry(input),
    duplicateWorkspaceEntry: (input) => operations.duplicateWorkspaceEntry(input),
    revealWorkspaceEntry: (input) => operations.revealWorkspaceEntry(input),
    openWorkspaceEntryExternal: (input) => operations.openWorkspaceEntryExternal(input),
    search: (input) => operations.search(input),
    sessionIndexStatus: () => operations.sessionIndexStatus(),
    saveAttachment: (input) => operations.saveAttachment(input), saveUpload: (input) => operations.saveUpload(input), listAttachments: (id) => operations.listAttachments(id),
    deleteAttachment: (id) => operations.deleteAttachment(id), readArtifact: (input) => operations.readArtifact(input),
    readArtifactWorkbook: (input) => operations.readArtifactWorkbook(input),
    readArtifactPresentation: (input) => operations.readArtifactPresentation(input),
    openBrowserArtifact: (input) => operations.openBrowserArtifact(input),
    createBrowserSession: (input) => operations.createBrowserSession(input),
    openInAgentBrowser: (input) => operations.openInAgentBrowser(input as { target: string }),
    listBrowserSessions: () => operations.listBrowserSessions(),
    closeBrowserSession: (input) => operations.closeBrowserSession(input),
    newBrowserPage: (input) => operations.newBrowserPage(input),
    listBrowserPages: (input) => operations.listBrowserPages(input),
    closeBrowserPage: (input) => operations.closeBrowserPage(input),
    selectBrowserPage: (input) => operations.selectBrowserPage(input),
    navigateBrowser: (input) => operations.navigateBrowser(input),
    browserBack: (input) => operations.browserBack(input),
    browserForward: (input) => operations.browserForward(input),
    browserReload: (input) => operations.browserReload(input),
    browserStop: (input) => operations.browserStop(input),
    snapshotBrowser: (input) => operations.snapshotBrowser(input),
    clickBrowser: (input) => operations.clickBrowser(input),
    clickBrowserCoordinates: (input) => operations.clickBrowserCoordinates(input),
    fillBrowser: (input) => operations.fillBrowser(input),
    typeBrowser: (input) => operations.typeBrowser(input),
    pressBrowser: (input) => operations.pressBrowser(input),
    extractBrowser: (input) => operations.extractBrowser(input),
    saveBrowserExtraction: (input) => operations.saveBrowserExtraction(input),
    searchBrowserIndex: (input) => operations.searchBrowserIndex(input),
    screenshotBrowser: (input) => operations.screenshotBrowser(input),
    writeArtifact: (input) => operations.writeArtifact(input), renameProject: (input) => operations.renameProject(input),
    pinProject: (input) => operations.pinProject(input), archiveProject: (input) => operations.archiveProject(input),
    createConversation: (input) => operations.createConversation(input),
    continueConversationWithProvider: (input) => operations.continueConversationWithProvider(input),
    renameConversation: (input) => operations.renameConversation(input),
    archiveConversation: (input) => operations.archiveConversation(input), deleteConversation: (input) => operations.deleteConversation(input), listEvents: (id) => operations.listEvents(id), listProjectSessions: (id) => operations.listProjectSessions(id), getConversationSession: (id) => operations.findProviderSession(id),
    summarizeConversation: (input) => operations.summarizeConversation(input),
    setConversationClaudeModel: (input) => operations.setConversationClaudeModel(input),
    listClaudeHistory: (input) => operations.listClaudeHistory(input),
    readClaudeHistory: (input) => operations.readClaudeHistory(input),
    adoptClaudeHistory: (input) => operations.adoptClaudeHistory(input),
    sendMessage: (input) => operations.sendMessage(input), cancelMessage: (id) => operations.cancelMessage(id),
    runTerminalCommand: (input) => operations.runTerminalCommand(input), resolveApproval: (input) => operations.resolveApproval(input),
    resolveUserInput: (input) => operations.resolveUserInput(input),
    startCouncil: (input) => operations.startCouncil(input), cancelCouncil: (id) => operations.cancelCouncil(id),
    refreshProviders: () => operations.refreshProviders(), createTerminal: (input) => operations.createTerminal(input),
    writeTerminal: (input) => operations.writeTerminal(input), resizeTerminal: (input) => operations.resizeTerminal(input), requestTerminalGeometry: (input) => operations.requestTerminalGeometry(input), getPtyState: (id) => operations.getPtyState(id), getAgentStateExplanation: (id) => operations.getAgentStateExplanation(id), getLastCommand: (id) => operations.getLastCommand(id), getTerminalDashboard: () => operations.getTerminalDashboard(),
    setTerminalKeepalive: (input) => operations.setTerminalKeepalive(input), listTerminalKeepalives: () => operations.listTerminalKeepalives(),
    renameTerminal: (input) => operations.renameTerminal(input), setTerminalLabel: (input) => operations.setTerminalLabel(input), markTerminalAgent: (input) => operations.markTerminalAgent(input), markTerminalAgentOwned: (input) => operations.markTerminalAgentOwned(input), setTerminalNativeSessionId: (input) => operations.setTerminalNativeSessionId(input), killTerminal: (input) => operations.killTerminal(input),
    listTerminals: (id) => operations.listTerminals(id),
    getTerminalWorkspace: (id) => operations.getTerminalWorkspace(id),
    getTerminalTranscript: (id) => operations.getTerminalTranscript(id),
    saveTerminalWorkspace: (input) => operations.saveTerminalWorkspace(input),
    getDockLayout: () => operations.getDockLayout(),
    openTile: (input) => operations.openTile(input),
    closeTile: (input) => operations.closeTile(input),
    selectTile: (input) => operations.selectTile(input),
    setDockLayout: (input) => operations.setDockLayout(input),
    setExclusive: (input) => operations.setExclusive(input),
    listAttention: () => operations.listAttention(),
    resolveAttention: (input) => operations.resolveAttention(input),
    getUsageSnapshot: () => operations.getUsageSnapshot(),
    getAgentLauncherDir: () => getLauncherDir(),
    getSystemActivity: () => operations.getSystemActivity(),
    getAgentFileActivity: (input?: unknown) => operations.getAgentFileActivity(input),
    getWorktreeRegistry: () => operations.getWorktreeRegistry(),
    ...(agentapi ? {
      createAgentApiWorkflow: (input: unknown) => agentapi.create(input),
      getAgentApiWorkflow: (id: unknown) => agentapi.get(requireWorkflowId(id)),
      resumeAgentApiWorkflow: (id: unknown) => agentapi.resume(requireWorkflowId(id)),
      pauseAgentApiWorkflow: (id: unknown) => agentapi.pause(requireWorkflowId(id)),
      cancelAgentApiWorkflow: (id: unknown) => agentapi.cancel(requireWorkflowId(id)),
    } : {}),
    ...(voiceSurface ? {
      getAgentApiWorldSnapshot: () => voiceSurface.agentapiState.getWorldState(),
      getAgentApiSemanticState: async (terminalId: unknown) => {
        if (typeof terminalId !== "string" || !terminalId || !voiceSurface.agentapiSemantic) return null;
        await voiceSurface.agentapiSemantic.projector.refreshTranscript(terminalId);
        return voiceSurface.agentapiSemantic.store.get(terminalId);
      },
      agentapiVoiceTurn: (input: unknown) =>
        voiceSurface.agentapiVoice.turn((input as { utterance?: unknown } | null)?.utterance),
      interruptAgentApiVoice: () => voiceSurface.agentapiVoice.interrupt(),
      liveVoiceSession: (input: unknown) => {
        if (!voiceSurface.persistentVoice) throw new Error("Persistent Live Voice is unavailable.");
        return voiceSurface.persistentVoice.handle(input);
      },
      // Mobile mic audio lands here (§11.5): bounded base64 payload, server
      // URL/model/key read from settings in main — never from the client.
      transcribeVoiceAgent: (input: unknown) => {
        const { voice } = voiceSurface.getSettings();
        return transcribeVoiceAgentClip(input, voice);
      },
    } : {}),
    createWorktree: (input) => operations.createWorktree(input),
    listWorktrees: (input) => operations.listWorktrees(input),
    getWorktree: (input) => operations.getWorktree(input),
    worktreeDiffSummary: (input) => operations.worktreeDiffSummary(input),
    mergeWorktree: (input) => operations.mergeWorktree(input),
    abortWorktree: (input) => operations.abortWorktree(input),
    cleanupWorktree: (input) => operations.cleanupWorktree(input),
    bindWorktreeSession: (input) => operations.bindWorktreeSession(input),
    resumeWorktree: (input) => operations.resumeWorktree(input),
    listCheckpoints: (input) => operations.listCheckpoints(input),
    getCheckpoint: (input) => operations.getCheckpoint(input),
    checkpointDiff: (input) => operations.checkpointDiff(input),
    checkpointRestorePreview: (input) => operations.checkpointRestorePreview(input),
    restoreCheckpoint: (input) => operations.restoreCheckpoint(input),
    undoCheckpoint: (input) => operations.undoCheckpoint(input),
    redoCheckpoint: (input) => operations.redoCheckpoint(input),
    createExplicitCheckpoint: (input) => operations.createExplicitCheckpoint(input),
  };
}

function requireWorkflowId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)) {
    throw new Error("Invalid AgentApi workflow ID.");
  }
  return value;
}
