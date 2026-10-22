import type { z } from "zod";
import type { CodexProfileSpec } from "./codex-profiles";
import type {
  appSettingsSchema,
  appSettingsPatchSchema,
  claudeHistoryListInputSchema,
  claudeHistoryReadInputSchema,
  claudeHistorySessionSchema,
  claudeHistoryTranscriptSchema,
  artifactReadInputSchema,
  artifactWriteInputSchema,
  artifactPreviewSchema,
  artifactTokenInputSchema,
  browserArtifactInputSchema,
  spreadsheetCellSchema,
  spreadsheetSheetSchema,
  spreadsheetModelSchema,
  presentationElementSchema,
  presentationSlideSchema,
  presentationModelSchema,
  approvalResolveInputSchema,
  userInputResolveInputSchema,
  attachmentSaveInputSchema,
  uploadSaveInputSchema,
  attachmentSchema,
  bootstrapDataSchema,
  conversationSchema,
  continueConversationInputSchema,
  conversationModelInputSchema,
  conversationSummaryInputSchema,
  conversationStateInputSchema,
  councilInputSchema,
  createConversationInputSchema,
  createProjectInputSchema,
  diagnosticsSchema,
  globalSearchInputSchema,
  globalSearchResultSchema,
  handoffPacketSchema,
  terminalHandoffPacketSchema,
  terminalHandoffRequestSchema,
  agentapiWorkflowStateSchema,
  agentapiReviewResultSchema,
  agentapiWorkflowOutcomeSchema,
  agentapiWorkflowCreateSchema,
  agentapiWorkflowSchema,
  agentapiStepKindSchema,
  agentapiStepStatusSchema,
  agentapiWorkflowStepSchema,
  messageInputSchema,
  normalizedEventSchema,
  projectSchema,
  projectHistorySessionSchema,
  projectStateInputSchema,
  reorderProjectsInputSchema,
  deleteProjectInputSchema,
  providerProfileIdSchema,
  providerProbeSourceSchema,
  providerProbeStateSchema,
  providerRefreshInputSchema,
  providerSessionSchema,
  providerStatusSchema,
  renameProjectInputSchema,
  renameConversationInputSchema,
  terminalCreateInputSchema,
  terminalCommandInputSchema,
  terminalCommandNameSchema,
  terminalIdInputSchema,
  terminalInfoSchema,
  usageSlotSchema,
  usageSnapshotSchema,
  terminalRenameInputSchema,
  terminalMarkAgentInputSchema,
  terminalLabelSchema,
  terminalSetLabelInputSchema,
  terminalResizeInputSchema,
  terminalSetNativeSessionIdInputSchema,
  terminalWorkspaceSaveInputSchema,
  terminalWorkspaceStateSchema,
  terminalWriteInputSchema,
  workspaceEntrySchema,
  workspaceListInputSchema,
  workspaceSearchInputSchema,
  workspaceSearchResultSchema,
  workspacePathInputSchema,
  workspaceRenameInputSchema,
  workspaceCreateInputSchema,
  workspaceDuplicateInputSchema,
  dockTileSchema,
  dockLayoutSchema,
  dockOpenTileInputSchema,
  dockCloseTileInputSchema,
  dockSelectTileInputSchema,
  dockSetLayoutInputSchema,
  dockSetExclusiveInputSchema,
  dockReorderTileInputSchema,
  commandResultSchema,
  ptyStateSchema,
  ptyStateSourceSchema,
  agentStateExplanationSchema,
  ptyStateChangedSchema,
  terminalKeepaliveStateSchema,
  terminalKeepaliveSetInputSchema,
  browserArtifactSavedSchema,
  attentionNotificationSchema,
  attentionResolveInputSchema,
  worktreeSchema,
  worktreeStatusSchema,
  worktreePermissionsPresetSchema,
  worktreeCreateInputSchema,
  worktreeListInputSchema,
  worktreeIdInputSchema,
  worktreeMergeInputSchema,
  worktreeBindSessionInputSchema,
  worktreeResumeInputSchema,
  checkpointPhaseSchema,
  checkpointKindSchema,
  checkpointStatusSchema,
  checkpointSchema,
  checkpointFileChangeSchema,
  checkpointDiffSchema,
  checkpointListInputSchema,
  checkpointIdInputSchema,
  checkpointDiffInputSchema,
  checkpointRestorePreviewInputSchema,
  checkpointRestorePreviewSchema,
  checkpointRestoreInputSchema,
  checkpointHunkRestoreInputSchema,
  checkpointRestoreRecordSchema,
  checkpointUndoInputSchema,
  checkpointCreateExplicitInputSchema,
} from "./schema";

export const MYQWEN_MODEL = "my-qwen";
// 2026-09-09: aligned to the backend real ceiling (262,144, probed via
// /v1/models), then pulled back to 255,000 to respect the proxy layering rule:
// client compact 216,750 (85% of 255,000) < llm-proxy clamp ~219,545 < the
// gateway wall 262,144. At 262,144 the 85% trigger (222,822) sat ABOVE the
// clamp, so the proxy silently trimmed oldest turns before Claude Code could
// auto-compact (the 2026-08-10 WORKORDER_proxy_ctx_honesty amnesia mode).
export const MYQWEN_CLAUDE_CONTEXT_WINDOW = 255_000;
export const MYQWEN_CLAUDE_AUTO_COMPACT_WINDOW = 255_000;
export const MYQWEN_CLAUDE_AUTO_COMPACT_PERCENT = 85;
export const MYQWEN_CODEX_CONTEXT_WINDOW = 190_000;
export const MYQWEN_CODEX_MAX_OUTPUT_TOKENS = 32_768;
export const MYQWEN_CODEX_AUTO_COMPACT_TOKEN_LIMIT = 170_000;
export const MYQWEN_CODEX_AUTO_COMPACT_TOKEN_LIMIT_SCOPE = "total";

// my-glm-flash (free proxy gateway, alias "my-glm-flash"). NO native vision
// (proxy transcribes images through Qwen). Gateway sizing is in flux (friend
// still tuning the vLLM/LiteLLM wall); do NOT change these constants without a
// live probe of the gateway -- see llm-proxy.py MODEL_CTX_LIMIT for truth.
export const MYGLM_MODEL = "my-glm-flash";
export const MYGLM_CLAUDE_CONTEXT_WINDOW = 200_000;
export const MYGLM_CLAUDE_AUTO_COMPACT_WINDOW = 200_000;
export const MYGLM_CLAUDE_AUTO_COMPACT_PERCENT = 85;
export const MYGLM_CODEX_CONTEXT_WINDOW = 170_000;
export const MYGLM_CODEX_MAX_OUTPUT_TOKENS = 32_768;
export const MYGLM_CODEX_AUTO_COMPACT_TOKEN_LIMIT = 150_000;
export const MYGLM_CODEX_AUTO_COMPACT_TOKEN_LIMIT_SCOPE = "total";
export const MYGLMMAX_MODEL = "my-glm-max";

// --- Hot model registry (stage 1): agent picker option table -----------------
// Single shared source for the "＋" picker list. The renderer falls back to
// this static table before any push arrives; main derives the live list from
// BUILTIN ⊕ settings.customProfiles (see shared/agent-options.ts) and pushes
// it over IPC/WS as `profilesChanged`. Grouping/paid/free judgments use these
// DATA fields (harness/local), never id prefixes or enum exhaustiveness.
export interface AgentOption {
  id: string;
  /** Picker display name. */
  label: string;
  /** Terminal tab title for claude-harness launches; falls back to label. */
  title?: string | undefined;
  /** claude --model value for the generic claude-harness launch path. */
  model?: string | undefined;
  /** true = free/proxy-routed group; false = paid/official (PAID column). */
  local: boolean;
  harness: "claude" | "codex" | "other";
  /**
   * Stage 2 (codex half): resolved codex wiring spec, attached to codex- /
   * claude-harness entries whose registry entry yields one. Secrets-free
   * (no baseUrl/authToken) — see shared/codex-profiles.ts.
   */
  codex?: CodexProfileSpec | undefined;
  /**
   * Omitted from the picker but still resolvable by id, so restored tiles,
   * the summarizer fallback and council seats that reference it keep working.
   */
  hidden?: boolean | undefined;
}

export const BUILTIN_AGENT_OPTIONS: readonly AgentOption[] = [
  { id: "claude-local-long2", label: "claude-local-long2", title: "Qwen Local", model: MYQWEN_MODEL, local: true, harness: "claude" },
  { id: "codex-local-long2", label: "codex-local-long2", local: true, harness: "codex" },
  { id: "claude-local-main", label: "claude-local-main", title: "GLM Local Flash", model: MYGLM_MODEL, local: true, harness: "claude" },
  // claude-local-long / codex-local-long route to the same upstream as the my-qwen pair
  // (proxy maps claude-3-5-sonnet-latest -> my-qwen-flash), so they are
  // duplicates in the picker. Hidden, not removed — see AgentOption.hidden.
  { id: "claude-local-long", label: "claude-local-long", title: "Qwen", model: "claude-3-5-sonnet-latest", local: true, harness: "claude", hidden: true },
  { id: "claude-local-freeform", label: "claude-local-long uncensored", title: "Qwen uncensored", model: "claude-haiku-4-5-20251001", local: true, harness: "claude" },
  { id: "codex-local-main", label: "codex-local-main", local: true, harness: "codex" },
  { id: "codex-local-max", label: "codex-local-max", title: "GLM Local Max", local: true, harness: "codex" },
  { id: "codex-local-long", label: "codex-local-long", local: true, harness: "codex", hidden: true },
  { id: "gemini", label: "Gemini CLI", local: true, harness: "other" },
  { id: "claude-official", label: "Claude", local: false, harness: "claude" },
  { id: "codex-official", label: "Codex", local: false, harness: "codex" },
  // Codex Team (#100): official paid Codex lead driving free worker models via
  // the codex-team MCP bridge. configProfile lives in the codex tables.
  { id: "codex-team", label: "Codex Team", local: false, harness: "codex" },
];

export type AppSettings = z.infer<typeof appSettingsSchema>;
export type AppSettingsPatch = z.infer<typeof appSettingsPatchSchema>;
export type ClaudeHistoryListInput = z.infer<typeof claudeHistoryListInputSchema>;
export type ClaudeHistoryReadInput = z.infer<typeof claudeHistoryReadInputSchema>;
export type ClaudeHistorySession = z.infer<typeof claudeHistorySessionSchema>;
export type ClaudeHistoryTranscript = z.infer<typeof claudeHistoryTranscriptSchema>;
export type ArtifactReadInput = z.infer<typeof artifactReadInputSchema>;
export type ArtifactWriteInput = z.infer<typeof artifactWriteInputSchema>;
export type ArtifactPreview = z.infer<typeof artifactPreviewSchema>;
export type ArtifactTokenInput = z.infer<typeof artifactTokenInputSchema>;
export type BrowserArtifactInput = z.infer<typeof browserArtifactInputSchema>;
export type SpreadsheetCell = z.infer<typeof spreadsheetCellSchema>;
export type SpreadsheetSheet = z.infer<typeof spreadsheetSheetSchema>;
export type SpreadsheetModel = z.infer<typeof spreadsheetModelSchema>;
export type PresentationElement = z.infer<typeof presentationElementSchema>;
export type PresentationSlide = z.infer<typeof presentationSlideSchema>;
export type PresentationModel = z.infer<typeof presentationModelSchema>;
export type ApprovalResolveInput = z.infer<typeof approvalResolveInputSchema>;
export type UserInputResolveInput = z.infer<typeof userInputResolveInputSchema>;
export type Attachment = z.infer<typeof attachmentSchema>;
export type AttachmentSaveInput = z.infer<typeof attachmentSaveInputSchema>;
export type UploadSaveInput = z.infer<typeof uploadSaveInputSchema>;
export type BootstrapData = z.infer<typeof bootstrapDataSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type ContinueConversationInput = z.infer<typeof continueConversationInputSchema>;
export type ConversationModelInput = z.infer<typeof conversationModelInputSchema>;
export type ConversationSummaryInput = z.infer<typeof conversationSummaryInputSchema>;
export type ConversationStateInput = z.infer<typeof conversationStateInputSchema>;
export type CouncilInput = z.infer<typeof councilInputSchema>;
export type CreateConversationInput = z.infer<typeof createConversationInputSchema>;
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;
export type Diagnostics = z.infer<typeof diagnosticsSchema>;
export type GlobalSearchInput = z.infer<typeof globalSearchInputSchema>;
export type GlobalSearchResult = z.infer<typeof globalSearchResultSchema>;
export type HandoffPacket = z.infer<typeof handoffPacketSchema>;
export type TerminalHandoffPacket = z.infer<typeof terminalHandoffPacketSchema>;
export type TerminalHandoffRequest = z.infer<typeof terminalHandoffRequestSchema>;
export type AgentApiWorkflowState = z.infer<typeof agentapiWorkflowStateSchema>;
export type AgentApiReviewResult = z.infer<typeof agentapiReviewResultSchema>;
export type AgentApiWorkflowOutcome = z.infer<typeof agentapiWorkflowOutcomeSchema>;
export type AgentApiWorkflowCreate = z.infer<typeof agentapiWorkflowCreateSchema>;
export type AgentApiWorkflow = z.infer<typeof agentapiWorkflowSchema>;
export type AgentApiStepKind = z.infer<typeof agentapiStepKindSchema>;
export type AgentApiStepStatus = z.infer<typeof agentapiStepStatusSchema>;
export type AgentApiWorkflowStep = z.infer<typeof agentapiWorkflowStepSchema>;
export type MessageInput = z.infer<typeof messageInputSchema>;
export type NormalizedEvent = z.infer<typeof normalizedEventSchema>;
export type Project = z.infer<typeof projectSchema>;
export type ProjectHistorySession = z.infer<typeof projectHistorySessionSchema>;
export type ProjectStateInput = z.infer<typeof projectStateInputSchema>;
export type ReorderProjectsInput = z.infer<typeof reorderProjectsInputSchema>;
export type ProjectDeleteInput = z.infer<typeof deleteProjectInputSchema>;
export type ProviderProfileId = z.infer<typeof providerProfileIdSchema>;
export type ProviderSession = z.infer<typeof providerSessionSchema>;
export type ProviderProbeSource = z.infer<typeof providerProbeSourceSchema>;
export type ProviderProbeState = z.infer<typeof providerProbeStateSchema>;
export type ProviderRefreshInput = z.infer<typeof providerRefreshInputSchema>;
export type ProviderStatus = z.infer<typeof providerStatusSchema>;
export type RenameProjectInput = z.infer<typeof renameProjectInputSchema>;
export type RenameConversationInput = z.infer<typeof renameConversationInputSchema>;
export type TerminalCreateInput = z.infer<typeof terminalCreateInputSchema>;
export type TerminalCommandInput = z.infer<typeof terminalCommandInputSchema>;
export type TerminalCommandName = z.infer<typeof terminalCommandNameSchema>;
export type TerminalIdInput = z.infer<typeof terminalIdInputSchema>;
export type TerminalInfo = z.infer<typeof terminalInfoSchema>;
export type UsageSlot = z.infer<typeof usageSlotSchema>;
export type UsageSnapshot = z.infer<typeof usageSnapshotSchema>;
/** Sidebar machine pulse (sunmoon skin): CPU/RAM load + agent-written files since launch. */
export interface SystemActivity {
  cpuPercent: number | null;
  memPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
  agentFiles: number;
  agentBytes: number;
  watchedRoots: number;
  since: number;
}
/** One file shown in the click-to-expand "本次產出" list (2026-10-06 maintainer). */
export type AgentFileKind = "created" | "modified";
export interface AgentFileEntry {
  path: string;
  /**
   * Size the monitor first saw this session (baseline for the per-row growth
   * delta): 0 for created files, the size at first sight for modified ones
   * (2026-10-12 maintainer — find where the fat data is).
   */
  baselineSize: number;
  size: number;
  mtimeMs: number;
  kind: AgentFileKind;
}
/** listFiles() output: capped largest-first entries + uncapped count. */
export interface AgentFileActivity {
  files: AgentFileEntry[];
  total: number;
}
/**
 * One git worktree created after Coterm started (read-only registry shown in
 * the pulse panel, 2026-10-12 maintainer — agents leave parallel worktrees behind).
 */
export interface WorktreeRegistryEntry {
  path: string;
  /** Branch the worktree was on at the last scan; null = detached HEAD. */
  branch: string | null;
  /** When the registry first saw it this session. */
  firstSeenAt: number;
  /** When it was last present in `git worktree list`. */
  lastSeenAt: number;
  /** No longer on disk (removed/pruned during this session). */
  removed: boolean;
  /** Uncommitted changes; null = unknown (git failed or already removed). */
  dirty: boolean | null;
}
/** WorktreeRegistry.list() output: session-created worktrees, newest first. */
export interface WorktreeRegistryActivity {
  entries: WorktreeRegistryEntry[];
  /** Worktrees that already existed at app start (not session-created). */
  baselineCount: number;
  /** Last successful scan; null = no scan finished yet. */
  lastCheckedAt: number | null;
}
export type TerminalRenameInput = z.infer<typeof terminalRenameInputSchema>;
export type TerminalMarkAgentInput = z.infer<typeof terminalMarkAgentInputSchema>;
export type TerminalLabel = z.infer<typeof terminalLabelSchema>;
export type TerminalSetLabelInput = z.infer<typeof terminalSetLabelInputSchema>;
export type TerminalSetNativeSessionIdInput = z.infer<typeof terminalSetNativeSessionIdInputSchema>;
export type TerminalResizeInput = z.infer<typeof terminalResizeInputSchema>;
export type TerminalWorkspaceSaveInput = z.infer<typeof terminalWorkspaceSaveInputSchema>;
export type TerminalWorkspaceState = z.infer<typeof terminalWorkspaceStateSchema>;
export type TranscriptProvider = "claude" | "codex" | "unsupported" | "unknown";
export type TranscriptStatus = "ready" | "pending" | "empty" | "unsupported" | "not_found" | "ambiguous" | "error";
export type TerminalTranscriptMessage = {
  /** Optional for backward-compatible handoff fixtures; service responses always set it. */
  id?: string;
  role: "user" | "assistant" | "system";
  kind?: "message" | "turn_summary" | "notice";
  text: string;
  timestamp: string | null;
  provider?: TranscriptProvider;
  model?: string | null;
  /**
   * Claude only: true when this assistant record ended its turn
   * (stop_reason "end_turn"). The final-only reader keeps every such reply,
   * because replies to dropped background notifications / teammate messages
   * sit back-to-back with the one before them and would otherwise collapse
   * into the last of the run.
   */
  endsTurn?: boolean;
};
export type TerminalTranscript = {
  terminalId?: string;
  status?: TranscriptStatus;
  provider?: TranscriptProvider;
  sessionBinding?: "native-id" | "cwd-start-time" | "none";
  messages: TerminalTranscriptMessage[];
  updatedAt?: string;
  stale?: boolean;
  reasonCode?: string;
};
/**
 * Metadata for the pane-header "Session 資訊" block (2026-10-23): everything
 * another agent needs to pick THIS session up — profile, native id, absolute
 * transcript path (resolved by the shared session-file resolver, so it
 * follows /clear + /resume hops), and a copy-ready resume command.
 */
export interface TerminalSessionInfo {
  terminalId: string;
  agentProfile: string | null;
  provider: TranscriptProvider;
  /** The id of the session file the agent is writing right now (follows rebinds). */
  nativeSessionId: string | null;
  cwd: string;
  /** OS pid of the PTY process (0 when unknown). */
  pid: number;
  model: string | null;
  /** Absolute native transcript path; null while unresolved/ambiguous. */
  transcriptPath: string | null;
  /** Shell command that resumes this session from its cwd; null when unknown. */
  resumeCommand: string | null;
}
export type TerminalWriteInput = z.infer<typeof terminalWriteInputSchema>;
export type WorkspaceEntry = z.infer<typeof workspaceEntrySchema>;
export type WorkspaceListInput = z.infer<typeof workspaceListInputSchema>;
export type WorkspaceSearchInput = z.infer<typeof workspaceSearchInputSchema>;
export type WorkspaceSearchResult = z.infer<typeof workspaceSearchResultSchema>;
export type WorkspacePathInput = z.infer<typeof workspacePathInputSchema>;
export type WorkspaceRenameInput = z.infer<typeof workspaceRenameInputSchema>;
export type WorkspaceCreateInput = z.infer<typeof workspaceCreateInputSchema>;
export type WorkspaceDuplicateInput = z.infer<typeof workspaceDuplicateInputSchema>;

// --- Dock layout (terminal-first overhaul) ---------------------------------
// Main process owns the dock; renderer/web/mobile are mirrors. See
// docs/superpowers/specs/2026-06-28-terminal-first-overhaul-design.md.
export type DockTile = z.infer<typeof dockTileSchema>;
export type DockLayout = z.infer<typeof dockLayoutSchema>;
export type DockOpenTileInput = z.infer<typeof dockOpenTileInputSchema>;
export type DockCloseTileInput = z.infer<typeof dockCloseTileInputSchema>;
export type DockSelectTileInput = z.infer<typeof dockSelectTileInputSchema>;
export type DockSetLayoutInput = z.infer<typeof dockSetLayoutInputSchema>;
export type DockSetExclusiveInput = z.infer<typeof dockSetExclusiveInputSchema>;
export type DockReorderTileInput = z.infer<typeof dockReorderTileInputSchema>;

// --- Structured shell integration (OSC 133/633) -----------------------------
export type CommandResult = z.infer<typeof commandResultSchema>;

// --- Agent Attention Center (canonical PtyState + notifications) ------------
export type PtyState = z.infer<typeof ptyStateSchema>;
export type PtyStateSource = z.infer<typeof ptyStateSourceSchema>;
export type AgentStateExplanation = z.infer<typeof agentStateExplanationSchema>;
export type PtyStateChanged = z.infer<typeof ptyStateChangedSchema>;
export type TerminalKeepaliveState = z.infer<typeof terminalKeepaliveStateSchema>;
export type TerminalKeepaliveSetInput = z.infer<typeof terminalKeepaliveSetInputSchema>;
export type BrowserArtifactSaved = z.infer<typeof browserArtifactSavedSchema>;
export type AttentionNotification = z.infer<typeof attentionNotificationSchema>;
export type AttentionResolveInput = z.infer<typeof attentionResolveInputSchema>;

// --- A — Worktree sandbox + trusted resume ---------------------------------
export type Worktree = z.infer<typeof worktreeSchema>;
export type WorktreeStatus = z.infer<typeof worktreeStatusSchema>;
export type WorktreePermissionsPreset = z.infer<typeof worktreePermissionsPresetSchema>;
export type WorktreeCreateInput = z.infer<typeof worktreeCreateInputSchema>;
export type WorktreeListInput = z.infer<typeof worktreeListInputSchema>;
export type WorktreeIdInput = z.infer<typeof worktreeIdInputSchema>;
export type WorktreeMergeInput = z.infer<typeof worktreeMergeInputSchema>;
export type WorktreeBindSessionInput = z.infer<typeof worktreeBindSessionInputSchema>;
export type WorktreeResumeInput = z.infer<typeof worktreeResumeInputSchema>;

// --- B — Checkpoint / diff / undo-redo rail ---------------------------------
export type CheckpointPhase = z.infer<typeof checkpointPhaseSchema>;
export type CheckpointKind = z.infer<typeof checkpointKindSchema>;
export type CheckpointStatus = z.infer<typeof checkpointStatusSchema>;
export type Checkpoint = z.infer<typeof checkpointSchema>;
export type CheckpointFileChange = z.infer<typeof checkpointFileChangeSchema>;
export type CheckpointDiff = z.infer<typeof checkpointDiffSchema>;
export type CheckpointListInput = z.infer<typeof checkpointListInputSchema>;
export type CheckpointIdInput = z.infer<typeof checkpointIdInputSchema>;
export type CheckpointDiffInput = z.infer<typeof checkpointDiffInputSchema>;
export type CheckpointRestorePreviewInput = z.infer<typeof checkpointRestorePreviewInputSchema>;
export type CheckpointRestorePreview = z.infer<typeof checkpointRestorePreviewSchema>;
export type CheckpointRestoreInput = z.infer<typeof checkpointRestoreInputSchema>;
export type CheckpointHunkRestoreInput = z.infer<typeof checkpointHunkRestoreInputSchema>;
export type CheckpointRestoreRecord = z.infer<typeof checkpointRestoreRecordSchema>;
export type CheckpointUndoInput = z.infer<typeof checkpointUndoInputSchema>;
export type CheckpointCreateExplicitInput = z.infer<typeof checkpointCreateExplicitInputSchema>;

// --- Terminal dashboard (aggregated PTY + dock state) ------------------------
// Re-exported from ipc.ts so the renderer can consume dashboard data via
// @shared/types without importing ipc.ts directly.
export type { TerminalDashboardEntry } from "./ipc";

// --- Phase 6: AgentApi voice agent / panel -----------------------------------
// Metadata-only world snapshot entries cross the IPC boundary to the
// AgentApiPanel and the shared desktop/mobile voice coordinator. They mirror
// AgentApiStateService's shape exactly (main re-exports these aliases so the
// service and the IPC surface can never drift apart).
export type AgentApiDisplayState =
  | "starting"
  | "running"
  | "waiting-input"
  | "approval"
  | "blocked"
  | "error"
  | "done"
  | "idle"
  | "exited";

export interface AgentApiSessionWorldState {
  terminalId: string;
  projectId: string;
  displayName: string;
  projectLabel: string;
  agentProfile: string | null;
  canonicalState: PtyState;
  lifecycleStatus: "running" | "exited";
  displayState: AgentApiDisplayState;
  source: PtyStateSource;
  attentionNotificationId: string | null;
  lastTransitionAt: string;
  ageMs: number;
  selected: boolean;
  scrollbackMode: "normal" | "alternate-screen" | null;
}

// Semantic state is deliberately separate from AgentApiSessionWorldState.
// WorldState remains metadata-only; these memory-only records carry bounded,
// redacted meaning projected from provider/transcript/detector signals.
export type AgentApiSemanticSource =
  | "provider-event"
  | "native-transcript"
  | "agent-detector"
  | "screen-fallback";

export interface AgentApiAgentIdentity {
  harness: "claude-code" | "codex-cli" | "powershell" | "shell" | "unknown";
  backend: "anthropic" | "openai" | "qwen" | "glm" | "unknown";
  model: string | null;
  profile: string | null;
}

export interface AgentApiSemanticTaskState {
  summary: string | null;
  phase: string | null;
  source: AgentApiSemanticSource | null;
  confidence: number;
}

export interface AgentApiSemanticTurnState {
  status: "running" | "completed" | "failed" | null;
  summary: string | null;
  finalText: string | null;
  completedAt: string | null;
  source: AgentApiSemanticSource | null;
  confidence: number;
}

export interface AgentApiPendingInteractionOption {
  id: string;
  label: string;
  description?: string;
}

export interface AgentApiPendingInteraction {
  id: string;
  terminalId: string;
  nativeSessionId?: string | null;
  turnId?: string | null;
  type: "question" | "choice" | "approval";
  prompt: string;
  options: AgentApiPendingInteractionOption[];
  source: AgentApiSemanticSource;
  createdAt: string;
}

export interface AgentApiSessionSemanticState {
  terminalId: string;
  identity: AgentApiAgentIdentity;
  task: AgentApiSemanticTaskState;
  lastTurn: AgentApiSemanticTurnState;
  pendingInteraction: AgentApiPendingInteraction | null;
  updatedAt: string;
}

// Voice turn routing provenance: "fast" = deterministic template over the
// world state (never touches the supervisor/LLM), "summary" = bounded-brief
// fan-in synthesis, "relay" = deterministic unique-target send, "supervisor"
// = bounded tool loop over the narrow gateway.
export type AgentApiVoiceTurnSource = "fast" | "relay" | "summary" | "supervisor";

export interface AgentApiVoiceTurnClarificationCandidate {
  terminalId: string;
  title: string;
  projectLabel: string;
  displayState: AgentApiDisplayState;
}

// `text` is ALWAYS egress-redacted in main before crossing the boundary: the
// renderer may display and SPEAK it as-is (no key/token/secret path leaves).
export interface AgentApiVoiceTurnResult {
  epoch: number;
  text: string;
  source: AgentApiVoiceTurnSource;
  spoken: boolean;
  targetTerminalId: string | null;
  targetTitle: string | null;
  clarification: { candidates: AgentApiVoiceTurnClarificationCandidate[] } | null;
}

export interface AgentApiVoiceTurnInput {
  // The recognised user utterance (finalised STT text); never raw audio.
  utterance: string;
}

// --- Persistent Live Voice --------------------------------------------------
// The logical VoiceSession outlives any one realtime room / WebRTC connection.
// Raw audio is intentionally absent from every persisted/shared type.
export type VoiceSttLanguageMode = "auto" | "zh-TW" | "zh-CN" | "en-US";
export type VoiceResponseLanguage = "zh-TW" | "zh-CN" | "en-US";

export type VoiceSessionStatus =
  | "starting"
  | "listening"
  | "user-speaking"
  | "thinking"
  | "speaking"
  | "muted"
  | "reconnecting"
  | "ended"
  | "error";

export interface VoiceSessionRecord {
  id: string;
  status: VoiceSessionStatus;
  startedAt: string;
  endedAt: string | null;
  lastActiveAt: string;
  rollingSummary: string;
  currentTopic: string | null;
  activeTerminalId: string | null;
  transport: string;
  sttLanguageMode: VoiceSttLanguageMode;
  responseLanguage: VoiceResponseLanguage;
  revision: number;
}

export type VoiceTurnRole = "user" | "agentapi" | "system";
export type VoiceTurnSource = AgentApiVoiceTurnSource | "narration";

export interface VoiceTurnRecord {
  id: string;
  voiceSessionId: string;
  role: VoiceTurnRole;
  text: string;
  source: VoiceTurnSource;
  terminalId: string | null;
  createdAt: string;
}

export interface VoiceContextSnapshot {
  voiceSessionId: string;
  rollingSummary: string;
  recentTurns: VoiceTurnRecord[];
  currentTopic: string | null;
  activeTerminalId: string | null;
}

export type VoicePipelineStageKey =
  | "permission"
  | "room"
  | "mic-capture"
  | "publish"
  | "speaker"
  | "transport"
  | "worker-subscribe"
  | "worker-mic"
  | "vad"
  | "stt"
  | "turn"
  | "tts";

export interface VoicePipelineStageRecord {
  state: string;
  atMs: number;
  frameCount?: number;
  framesPerSecond?: number;
  rms?: number;
  durationMs?: number;
  textLength?: number;
  reasonCode?: string;
}

/** One bounded metadata-only snapshot per active logical voice session. Raw
 * audio, transcript bodies, tokens, URLs, and PTY content cannot be expressed. */
export interface VoicePipelineSnapshot {
  voiceSessionId: string;
  updatedAtMs: number;
  stages: Partial<Record<VoicePipelineStageKey, VoicePipelineStageRecord>>;
}

/** Bounded control protocol for the logical Live Voice call. Raw audio is
 * intentionally impossible to express in this union. */
export type VoiceSessionCommand =
  | { action: "start"; sttLanguageMode?: VoiceSttLanguageMode; responseLanguage?: VoiceResponseLanguage; transport?: string }
  | { action: "get"; voiceSessionId: string }
  | { action: "resume"; voiceSessionId: string; transport?: string }
  | { action: "speech-started"; voiceSessionId: string }
  | { action: "utterance"; voiceSessionId: string; text: string }
  | { action: "reply-finished"; voiceSessionId: string }
  | { action: "mute"; voiceSessionId: string }
  | { action: "unmute"; voiceSessionId: string }
  | { action: "reconnecting"; voiceSessionId: string }
  | { action: "reconnected"; voiceSessionId: string; transport?: string }
  | { action: "end"; voiceSessionId: string };

export interface VoiceSessionCommandResult {
  session: VoiceSessionRecord;
  turn?: AgentApiVoiceTurnResult | null;
  // LiveKit duplex join material, only present on `start`. `null` means the
  // caller should stay on the chunked MediaRecorder fallback.
  live?: { url: string; token: string } | null;
  /** Safe, bounded explanation when realtime promotion failed. Never contains
   * credentials, transcript text, or raw media. */
  liveFallbackReason?: string | null;
  diagnostics?: VoicePipelineSnapshot | null;
}
