import { create } from "zustand";
import { providerProfileIdSchema } from "@shared/schema";
import type {
  AppSettings,
  AppSettingsPatch,
  Attachment,
  BootstrapData,
  BrowserArtifactSaved,
  Conversation,
  DockLayout,
  NormalizedEvent,
  Project,
  ProviderProfileId,
  ProviderRefreshInput,
  ProviderStatus,
  PtyState,
  TerminalCommandName,
  TerminalKeepaliveState,
  Worktree,
  AgentOption,
} from "@shared/types";
import { deriveAgentOptions } from "@shared/agent-options";
import { estimateAgentCapacity } from "@shared/resource-estimate";
import { setAgentOptions } from "../components/interactive-agent";
import type { RecoveryScheduler } from "../components/terminal-recovery";
import { createExclusiveToggleCoalescer } from "./exclusive-toggle-coalesce";
import {
  EMPTY_READING_SLOTS,
  placeInReadingSlot,
  pruneReadingSlots,
  type ReadingSlotKey,
  type ReadingSlots,
} from "../components/reading-mode";
import { MOBILE_LAYOUT_QUERY } from "../components/terminal-responsive";
import { buildAgentLaunchWriteInput } from "../components/launch-write";

// --- Dormant conversation pane model ----------------------------------------
// The terminal-first overhaul moved the dock (terminal set + sizes + selection)
// into the main process as the single source of truth (see DockLayout). The
// conversation/chat backend is intentionally kept dormant — these slices still
// exist so conversation/council/summary actions compile and can be re-surfaced
// later, but they are no longer wired to the dock path.
export interface WorkspacePane {
  id: string;
  projectId: string | null;
  conversationId: string | null;
  selectedProvider: ProviderProfileId;
  events: NormalizedEvent[];
  runningTurnId: string | null;
  runningCouncilGroupId: string | null;
  loadToken: number;
  terminalId: string | null;
}

const EMPTY_DOCK: DockLayout = {
  tiles: [],
  selectedTerminalId: null,
  exclusiveTerminalId: null,
  rows: [],
  cols: [],
  ptyCols: 100,
  ptyRows: 28,
};

// #17: optimistic placeholder for "add project". Renderer-only id — the main
// process never sees it; it is swapped for the real project row as soon as
// the create IPC resolves (or removed on failure).
export const PENDING_PROJECT_PREFIX = "pending-project:";
export function isPendingProject(project: Pick<Project, "id">): boolean {
  return project.id.startsWith(PENDING_PROJECT_PREFIX);
}
function makePendingProject(name: string, workspacePath: string): Project {
  const now = new Date().toISOString();
  return {
    id: `${PENDING_PROJECT_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    workspacePath,
    pinned: false,
    archived: false,
    order: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * AT-133: browser approval prompt. Brokered level-2/3 built-in-browser actions
 * (upload / password fill / evaluate) arrive as metadata-only
 * approval.requested events (payload.browser === true) and are resolved through
 * the same IPC approvalResolve path as provider tool approvals.
 */
export interface BrowserApprovalPrompt {
  requestId: string;
  action: string;
  origin: string;
  level: number | null;
  locatorStrategy: string | null;
  sessionId: string;
  pageId: string;
  askedAt: string;
  /** Bounded evaluate script preview (script text only, never secrets); present only for evaluate requests. */
  previewScript?: string;
  previewTruncated?: boolean;
}

/**
 * Pure reduction of the shared event stream onto the pending-prompt list.
 * Only synthetic browser approval events are consumed; provider approvals that
 * flow through conversations (payload.browser absent) are left untouched.
 */
export function reduceBrowserApprovals(
  current: BrowserApprovalPrompt[],
  event: NormalizedEvent,
): BrowserApprovalPrompt[] {
  const payload = event.payload ?? {};
  if (payload.browser !== true || typeof payload.requestId !== "string") return current;
  if (event.type === "approval.requested") {
    const prompt: BrowserApprovalPrompt = {
      requestId: payload.requestId,
      action: typeof payload.action === "string" ? payload.action : "action",
      origin: typeof payload.origin === "string" ? payload.origin : "",
      level: typeof payload.level === "number" ? payload.level : null,
      locatorStrategy: typeof payload.locatorStrategy === "string" ? payload.locatorStrategy : null,
      sessionId: typeof payload.sessionId === "string" ? payload.sessionId : "",
      pageId: typeof payload.pageId === "string" ? payload.pageId : "",
      askedAt: event.createdAt,
      ...(typeof payload.previewScript === "string" ? { previewScript: payload.previewScript, previewTruncated: payload.previewTruncated === true } : {}),
    };
    // Replace on a repeated requestId rather than stacking duplicate dialogs.
    return [...current.filter((item) => item.requestId !== prompt.requestId), prompt];
  }
  if (event.type === "approval.resolved") {
    return current.filter((item) => item.requestId !== payload.requestId);
  }
  return current;
}

interface AppState {
  loading: boolean;
  error: string | null;
  /**
   * Resource soft-limit warning (2026-10-14): after a new terminal opens while
   * the machine is saturated (shared/resource-estimate.ts says 0 more panes
   * fit), a transient toast warns but the open is never blocked. Raw numbers —
   * localized at render time. Null when idle; auto-clears after a few seconds.
   */
  resourceNotice: { cpu: number | null; mem: number } | null;
  projects: Project[];
  conversations: Conversation[];
  runningConversationIds: string[];
  summarizingConversationIds: string[];
  summaryErrors: Record<string, string>;
  archivedProjects: Project[];
  archivedConversations: Conversation[];
  providers: ProviderStatus[];
  /** A probe round is in flight (drives the picker's 重探 spinner). */
  providersProbing: boolean;
  // Hot model registry (stage 1): the "＋" picker list. Built from
  // settings.customProfiles at bootstrap/updateSettings (fallback: the shared
  // built-in table) and live-updated via onProfilesChanged pushes from main.
  agentOptions: AgentOption[];
  settings: AppSettings | null;
  startupAlerts: string;
  /** Running build's version, straight from the packaged app (bootstrap). Shown
   *  in the sidebar brand so "which build is this?" is answerable at a glance
   *  instead of by asking an agent. Empty until bootstrap resolves. */
  appVersion: string;
  // --- Dock (terminal-first overhaul) -------------------------------------
  // Main process is authoritative; the renderer mirrors via onDockLayout.
  dockLayout: DockLayout;
  // --- Canonical PtyState projection (Issue #2) ---------------------------
  // Single renderer-owned source of truth for per-terminal PtyState. Hydrated
  // once from getTerminalDashboard and kept live via exactly one
  // onPtyStateChanged subscription in initialize(). TerminalDock + TopBar both
  // consume this map; neither subscribes independently. Selectors recompute
  // counts from the map on every read (no stored counters).
  ptyStates: Record<string, PtyState>;
  hydratePtyStates: () => Promise<void>;
  // --- Per-window keepalive (prompt cache) ----------------------------------
  // Mirror of main's ClaudeKeepaliveManager per-terminal state, hydrated once
  // and then updated by the header +/- actions. official-agent tiles read
  // effectiveHours to render the ⌛Nh control.
  terminalKeepalives: Record<string, TerminalKeepaliveState>;
  hydrateTerminalKeepalives: () => Promise<void>;
  setTerminalKeepaliveHours: (terminalId: string, hours: number | null) => Promise<void>;
  // --- Dormant conversation pane model (kept for chat backend, not surfaced)
  panes: WorkspacePane[];
  activePaneId: string;
  settingsOpen: boolean;
  explorerOpen: boolean;
  // C2 reveal-in-explorer: set when a terminal path link is clicked; the
  // ExplorerPanel expands its tree to that file. `at` guards against stale
  // requests firing on a LATER unrelated project switch (tile selection is
  // broadcast asynchronously, so the panel can momentarily show the previous
  // project when the click lands).
  explorerRevealRequest: { path: string; projectId: string; at: number } | null;
  artifactOpen: boolean;
  selectedArtifact: { path: string; title: string; projectId?: string } | null;
  // Browser screenshots pushed from main after they land in the browser cache
  // (issue #18). Session-only — newest first.
  browserArtifacts: BrowserArtifactSaved[];
  // AT-133: pending built-in-browser approval prompts (oldest first). The
  // BrowserApprovalDialog renders the head; resolveApproval routes the answer.
  browserApprovals: BrowserApprovalPrompt[];
  // --- B — Checkpoint rail (mutex with artifact rail) ---------------------
  checkpointOpen: boolean;
  // --- A — Worktree manager dialog ----------------------------------------
  worktrees: Worktree[];
  worktreeDialogOpen: boolean;
  worktreeDialogProjectId: string | null;
  worktreeBusyId: string | null;
  worktreeDiffById: Record<string, { diffStat: string; commits: string; dirty: boolean } | null>;
  worktreeError: string | null;
  openWorktreeDialog: (projectId: string) => Promise<void>;
  closeWorktreeDialog: () => void;
  refreshWorktreeDiff: (worktreeId: string) => Promise<void>;
  mergeWorktreeAction: (worktreeId: string) => Promise<void>;
  abortWorktreeAction: (worktreeId: string) => Promise<void>;
  cleanupWorktreeAction: (worktreeId: string) => Promise<void>;
  resumeWorktreeAction: (worktreeId: string) => Promise<void>;
  initialize: () => Promise<void>;
  // --- Dock action wrappers (RPC → main is authoritative) -----------------
  openTile: (projectId: string, agentProfile?: string) => Promise<DockLayout | null>;
  openSandboxAgent: (projectId: string, agentProfile: string) => Promise<DockLayout | null>;
  closeTile: (terminalId: string) => Promise<void>;
  selectTile: (terminalId: string) => Promise<void>;
  // --- Voice targeting pin (voicefix) -----------------------------------------
  // dockLayout.selectedTerminalId is main-owned and broadcast over WS — another
  // client (Agent API opening a tile) steals it mid-utterance. Voice dictation must
  // instead target the terminal THIS window's user last picked with a local
  // pointer gesture. WS-driven selection changes must NEVER touch this field;
  // only local gesture handlers (tile pointer-up, mobile tile select) call
  // noteLocalTileSelection. Renderer-local, in-memory only (per client window).
  lastLocalSelectedTerminalId: string | null;
  noteLocalTileSelection: (terminalId: string) => void;
  setDockLayout: (rows: number[], cols: number[][]) => Promise<void>;
  setExclusive: (terminalId: string | null) => Promise<void>;
  // Drag-reorder a tile inside the dock (桌機拖曳排序, 1.5.47 board). Main is
  // authoritative: it moves the tile inside tiles (rows/cols fractions are kept
  // as-is) and broadcasts the new layout to every client.
  reorderTile: (terminalId: string, toIndex: number) => Promise<void>;
  // --- Reading mode (閱讀模式, 1.5.44) --------------------------------------
  // Slot bookkeeping: renderer-local only, NEVER persisted, NEVER sent to
  // main. Entering hides the dock grid and shows the preset layout's empty
  // slots the user fills by dragging open session rows from the left sidebar
  // project area. Exiting restores the original layout for free because the
  // main-owned DockLayout was never mutated (spec 5乙: no ghosting, no
  // persistence — a restart always comes back in normal mode). Only the
  // chosen preset id routes through the settings patch (all other settings
  // fields untouched).
  readingModeActive: boolean;
  readingSlots: ReadingSlots;
  toggleReadingMode: () => void;
  /** Drag target: drop a terminal onto a specific slot (swap/replace rules). */
  placeReadingTerminal: (slot: ReadingSlotKey, terminalId: string) => void;
  /** Drop slots whose terminal left the dock (closed / zombie-reclaimed). */
  syncReadingSlots: (tileIds: ReadonlySet<string>) => void;
  /** Preset-picker popover visibility (one reading-mode button + popover grid). */
  readingPickerOpen: boolean;
  setReadingPickerOpen: (open: boolean) => void;
  // --- Dormant pane-centric actions (no-ops / thin shims) -----------------
  // Kept as no-ops because Sidebar/TopBar/App/ChatTimeline/Composer/ArtifactRail/
  // ExplorerPanel/LLMPickerDialog still import them. The integration phase will
  // rewire those consumers to the dock model.
  addPane: () => void;
  removePane: (paneId?: string) => void;
  setPaneCount: (count: number) => void;
  setActivePane: (paneId: string) => void;
  selectProject: (projectId: string, paneId?: string, terminalId?: string) => Promise<void>;
  selectConversation: (conversationId: string, paneId?: string) => Promise<void>;
  selectProvider: (provider: ProviderProfileId, paneId?: string) => void;
  setPaneTerminalId: (paneId: string, terminalId: string | null) => void;
  setConversationClaudeModel: (
    conversationId: string,
    model: Conversation["claudeModel"],
  ) => Promise<void>;
  adoptClaudeHistory: (projectId: string, key: string) => Promise<void>;
  createProject: () => Promise<void>;
  renameProject: (projectId: string, name: string) => Promise<void>;
  pinProject: (projectId: string, pinned: boolean) => Promise<void>;
  reorderProjects: (projectIds: string[]) => Promise<void>;
  archiveProject: (projectId: string) => Promise<void>;
  restoreProject: (projectId: string) => Promise<void>;
  deleteProject: (projectId: string) => Promise<void>;
  createConversation: (paneId?: string, provider?: ProviderProfileId) => Promise<void>;
  continueConversationWithProvider: (
    sourceConversationId: string,
    targetProvider: ProviderProfileId,
    paneId?: string,
  ) => Promise<void>;
  renameConversation: (conversationId: string, name: string) => Promise<void>;
  archiveConversation: (conversationId: string) => Promise<void>;
  restoreConversation: (conversationId: string) => Promise<void>;
  deleteConversation: (conversationId: string) => Promise<void>;
  summarizeConversation: (conversationId: string) => Promise<void>;
  clearSummaryError: (conversationId: string) => void;
  sendMessage: (text: string, attachments: Attachment[], paneId?: string, nativeWorkflow?: boolean) => Promise<boolean>;
  runTerminalCommand: (command: TerminalCommandName, paneId?: string) => Promise<void>;
  executeCouncil: (synthesis: string, paneId?: string) => Promise<void>;
  cancelRun: (paneId?: string) => Promise<void>;
  resolveApproval: (
    requestId: string,
    decision: "accept" | "acceptForSession" | "decline" | "cancel",
  ) => Promise<void>;
  resolveUserInput: (requestId: string, answers: Record<string, string[]> | null) => Promise<void>;
  saveAttachment: (file: File, paneId?: string) => Promise<Attachment>;
  deleteAttachment: (attachmentId: string) => Promise<void>;
  refreshProviders: (input?: ProviderRefreshInput) => Promise<void>;
  updateSettings: (settings: AppSettingsPatch) => Promise<void>;
  setSettingsOpen: (open: boolean) => void;
  setExplorerOpen: (open: boolean) => void;
  requestExplorerReveal: (path: string, projectId: string) => void;
  setArtifactOpen: (open: boolean) => void;
  openArtifact: (path: string, title: string, projectId?: string) => void;
  closeArtifact: () => void;
  setCheckpointOpen: (open: boolean) => void;
  clearError: () => void;
  setError: (error: string) => void;
  pickerState: { paneId: string; preselect?: ProviderProfileId; projectId?: string } | null;
  setPickerState: (state: { paneId: string; preselect?: ProviderProfileId; projectId?: string } | null) => void;
  // --- Terminal recovery registry (design §5/§6) --------------------------
  // Each XtermPane registers its coalesced recovery scheduler on mount; TopBar
  // (desktop + mobile) and layout-change triggers call requestTerminalRecovery
  // for the active terminal so all reflow paths converge on one scheduler.
  recoverySchedulers: Map<string, RecoveryScheduler>;
  registerRecoveryScheduler: (terminalId: string, scheduler: RecoveryScheduler) => () => void;
  requestTerminalRecovery: (terminalId: string, reason: string) => void;
}

let unsubscribeEvents: (() => void) | null = null;
let unsubscribeProjectOrder: (() => void) | null = null;
let unsubscribeDock: (() => void) | null = null;
let unsubscribeProfiles: (() => void) | null = null;
let unsubscribePtyState: (() => void) | null = null;
let unsubscribeBrowserArtifact: (() => void) | null = null;

// Model-list liveness is a fact with a shelf life, so it is re-read on a beat
// instead of only at launch: a proxy that went away reads 離線 within one tick
// and a route that came back reads 線上 again without a restart. Main holds the
// TTLs, so an idle tick is a cache read, not a probe storm; hidden windows skip.
const PROVIDER_POLL_MS = 60_000;
let providerPollTimer: ReturnType<typeof setInterval> | null = null;
let probing = false;
let pendingFocus: string[] | undefined;

function startProviderPoll(): void {
  if (providerPollTimer) return;
  providerPollTimer = setInterval(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    void useAppStore.getState().refreshProviders();
  }, PROVIDER_POLL_MS);
}

// Issue #15: coalesce rapid exclusive (單一/展開) toggles — see the setExclusive
// action below. Instantiated once per renderer; apply() defers the store lookup
// to call time (after create() has run).
async function applyExclusiveToggle(terminalId: string | null): Promise<void> {
  try {
    const layout = await window.aiTerminal.setExclusive({ terminalId });
    useAppStore.setState({ dockLayout: layout });
    requestSelectedTerminalRecovery(useAppStore.getState, "exclusive");
  } catch (error) {
    useAppStore.setState({ error: errorMessage(error) });
  }
}

const exclusiveToggleCoalescer = createExclusiveToggleCoalescer({
  apply: (terminalId) => {
    void applyExclusiveToggle(terminalId);
  },
});

// Resource soft-limit toast (2026-10-14): after a successful openTile, sample
// the same system activity the sidebar pulse shows and warn — never block —
// when the machine is saturated (capacity 0). Raw numbers ride the store and
// App.tsx localizes + auto-clears them; a second saturated open re-arms the
// timer so the toast stays visible while the user keeps opening panes.
const RESOURCE_NOTICE_MS = 6_000;
let resourceNoticeTimer: ReturnType<typeof setTimeout> | null = null;

function warnIfSaturated(openTerminals: number): void {
  void window.aiTerminal.getSystemActivity().then((activity) => {
    // A zero-total snapshot means "load unknown" (dev mock, monitor off) —
    // never warn on data we cannot trust.
    if (!activity || activity.memTotalBytes <= 0) return;
    const capacity = estimateAgentCapacity({
      cpuPercent: activity.cpuPercent,
      memUsedBytes: activity.memUsedBytes,
      memTotalBytes: activity.memTotalBytes,
      openTerminals,
      // 12, lockstep with DOCK_MAX_TILES (sidebar-sessions.ts) / MAX_TILES
      // (dock-layout.ts) / MAX_TERMINALS (agent-api.ts).
      maxTiles: 12,
    });
    if (capacity.recommendedMaxNewAgents > 0) return;
    useAppStore.setState({ resourceNotice: { cpu: activity.cpuPercent, mem: capacity.memPercent } });
    if (resourceNoticeTimer) clearTimeout(resourceNoticeTimer);
    resourceNoticeTimer = setTimeout(() => {
      resourceNoticeTimer = null;
      useAppStore.setState({ resourceNotice: null });
    }, RESOURCE_NOTICE_MS);
  }).catch(() => undefined);
}

export const useAppStore = create<AppState>((set, get) => ({
  loading: true,
  error: null,
  resourceNotice: null,
  projects: [],
  conversations: [],
  runningConversationIds: [],
  summarizingConversationIds: [],
  summaryErrors: {},
  archivedProjects: [],
  archivedConversations: [],
  providers: [],
  providersProbing: false,
  agentOptions: deriveAgentOptions(),
  settings: null,
  startupAlerts: "",
  appVersion: "",
  dockLayout: EMPTY_DOCK,
  lastLocalSelectedTerminalId: null,
  readingModeActive: false,
  readingSlots: EMPTY_READING_SLOTS,
  readingPickerOpen: false,
  ptyStates: {},
  terminalKeepalives: {},
  panes: [emptyPane("pane-1", "claude-official")],
  activePaneId: "pane-1",
  settingsOpen: false,
  explorerOpen: false,
  explorerRevealRequest: null,
  artifactOpen: false,
  selectedArtifact: null,
  browserArtifacts: [],
  browserApprovals: [],
  checkpointOpen: false,
  worktrees: [],
  worktreeDialogOpen: false,
  worktreeDialogProjectId: null,
  worktreeBusyId: null,
  worktreeDiffById: {},
  worktreeError: null,
  pickerState: null,

  async initialize() {
    set({ loading: true, error: null });
    try {
      const [bootstrap, settings, dockLayout] = await Promise.all([
        window.aiTerminal.bootstrap(),
        window.aiTerminal.getSettings(),
        window.aiTerminal.getDockLayout(),
      ]);
      const pane = bootstrapPane(bootstrap, settings);
      // Hot model registry (stage 1): derive the picker list from the seeded
      // settings, and keep the interactive-agent module table in sync (its
      // launch lookups read that table, not the store).
      const initialAgentOptions = deriveAgentOptions(settings.customProfiles);
      setAgentOptions(initialAgentOptions);
      set({
        projects: bootstrap.projects,
        conversations: bootstrap.conversations,
        runningConversationIds: bootstrap.runningConversationIds,
        archivedProjects: bootstrap.archivedProjects,
        archivedConversations: bootstrap.archivedConversations,
        providers: bootstrap.providers,
        agentOptions: initialAgentOptions,
        settings,
        startupAlerts: bootstrap.startupAlerts,
        appVersion: bootstrap.appVersion,
        dockLayout,
        panes: [pane],
        activePaneId: pane.id,
      });
      // 最近開過置頂: main bumps a project to the top when a terminal opens in
      // it and ships the new order on terminalListChanged. Apply it locally
      // (order = index) so the sidebar re-sorts on every client at once.
      unsubscribeProjectOrder?.();
      unsubscribeProjectOrder = window.aiTerminal.onTerminalListChanged((payload) => {
        const projectIds = payload.projectIds;
        if (!projectIds?.length) return;
        const rank = new Map(projectIds.map((id, index) => [id, index]));
        set((state) => ({
          projects: state.projects
            .map((project) => {
              const order = rank.get(project.id);
              return order === undefined ? project : { ...project, order };
            })
            .sort(projectManualOrder),
        }));
      });
      unsubscribeEvents?.();
      unsubscribeEvents = window.aiTerminal.onEvent((event) => {
        set((state) => {
          const provider = event.type === "assistant.final"
            ? providerProfileIdSchema.safeParse(event.payload.provider)
            : null;
          const attemptedProvider = event.type === "error"
            ? providerProfileIdSchema.safeParse(event.payload.attemptedProfile)
            : null;
          const activeProvider = event.type === "error"
            ? providerProfileIdSchema.safeParse(event.payload.activeProvider)
            : null;
          let panes = state.panes.map((current) => routeEvent(current, event));
          if (attemptedProvider?.success && activeProvider?.success) {
            panes = panes.map((pane) =>
              pane.conversationId === event.conversationId &&
              pane.selectedProvider === attemptedProvider.data
                ? { ...pane, selectedProvider: activeProvider.data }
                : pane,
            );
          }
          const source = state.conversations.find((item) => item.id === event.conversationId);
          const terminal = isTerminalEvent(event);
          const runningConversationIds = event.type === "user.message"
            ? [...new Set([...state.runningConversationIds, event.conversationId])]
            : terminal
              ? state.runningConversationIds.filter((id) => id !== event.conversationId)
              : state.runningConversationIds;
          const conversations = state.conversations.map((conversation) =>
            conversation.id === event.conversationId
              ? {
                  ...conversation,
                  updatedAt: event.createdAt,
                  ...(provider?.success ? { activeProvider: provider.data } : {}),
                }
              : conversation,
          ).sort(newestFirst);
          const projects = source
            ? state.projects.map((project) =>
              project.id === source.projectId ? { ...project, updatedAt: event.createdAt } : project,
            ).sort(projectManualOrder)
            : state.projects;
          return {
            panes,
            conversations,
            projects,
            runningConversationIds,
            browserApprovals: reduceBrowserApprovals(state.browserApprovals, event),
          };
        });
      });
      // Subscribe to dock layout pushes from main (the single source of truth).
      // setDockLayout is idempotent: if the RPC already returned the same layout,
      // this is a no-op; otherwise it applies the authoritative update.
      unsubscribeDock?.();
      unsubscribeDock = window.aiTerminal.onDockLayout((layout) => {
        set({ dockLayout: layout });
      });
      // Hot model registry (stage 1): main pushes the derived agent option
      // list whenever another window / web client saves settings. This window's
      // own saves recompute in updateSettings; this push covers the rest.
      // Empty/garbage payloads keep the previous list (built-in fallback).
      unsubscribeProfiles?.();
      unsubscribeProfiles = window.aiTerminal.onProfilesChanged((options) => {
        if (!Array.isArray(options) || options.length === 0) return;
        setAgentOptions(options);
        set({ agentOptions: options });
      });
      // Canonical PtyState projection (Issue #2): exactly ONE dashboard hydrate
      // + exactly ONE onPtyStateChanged subscription lives in the renderer, here
      // in the store. TerminalDock and TopBar consume state.ptyStates instead of
      // each subscribing. Push mirrors every transition; hydrate seeds the
      // initial snapshot for tiles that exist before the first push.
      unsubscribePtyState?.();
      await get().hydratePtyStates();
      // Keepalive mirror: one hydrate; the header +/- actions own later writes.
      await get().hydrateTerminalKeepalives();
      unsubscribePtyState = window.aiTerminal.onPtyStateChanged((payload) => {
        set((state) => ({
          ptyStates: { ...state.ptyStates, [payload.terminalId]: payload.state },
        }));
      });
      // Browser screenshot artifacts (issue #18): main pushes after the PNG
      // lands in the browser cache. Open the rail with the image selected so a
      // shot an agent just took appears without the user hunting for it.
      // Agent browser popout (user request 2026-10-09): under "popout" the agent
      // browser lives in its own real window, so DON'T yank the experience into
      // the sidebar (no auto-open, no forced selection) — the shot still lands
      // in the rail and stays openable manually. The event carries no
      // sessionId, so gating on the setting is the pragmatic discriminator.
      unsubscribeBrowserArtifact?.();
      unsubscribeBrowserArtifact = window.aiTerminal.onBrowserArtifactSaved((artifact) => {
        set((state) => {
          const nextArtifacts = [artifact, ...state.browserArtifacts].slice(0, 24);
          if (state.settings?.agentBrowserWindow === "popout") {
            return { browserArtifacts: nextArtifacts };
          }
          const selectedTile = state.dockLayout.tiles.find(
            (tile) => tile.terminalId === state.dockLayout.selectedTerminalId,
          );
          const projectId = selectedTile?.projectId ?? state.projects[0]?.id;
          return {
            browserArtifacts: nextArtifacts,
            artifactOpen: true,
            checkpointOpen: false,
            selectedArtifact: {
              path: artifact.path,
              title: artifact.title || artifact.path.split(/[\\/]/).at(-1) || "Screenshot",
              ...(projectId ? { projectId } : {}),
            },
          };
        });
      });
      if (pane.conversationId) {
        const events = await window.aiTerminal.listEvents(pane.conversationId);
        set((state) => ({
          panes: state.panes.map((current) =>
            current.id === pane.id && current.conversationId === pane.conversationId
              ? { ...current, events: mergeEvents(events, current.events) }
              : current,
          ),
        }));
      }
      void get().refreshProviders();
      startProviderPoll();
    } catch (error) {
      set({ error: errorMessage(error) });
    } finally {
      set({ loading: false });
    }
  },

  // --- Dock action wrappers --------------------------------------------------
  // Each awaits the RPC and sets state.dockLayout to the returned layout.
  // The onDockLayout push will also arrive — set is idempotent (same reference
  // shape, React/zustand will skip re-render if value is structurally equal).
  async openTile(projectId, agentProfile) {
    try {
      const layout = await window.aiTerminal.openTile({ projectId, agentProfile });
      set({ dockLayout: layout });
      // Soft resource warning AFTER the open succeeds — the heuristic counts
      // the pane the user just added, so opening one tile too many still shows
      // the toast for that tile.
      warnIfSaturated(layout.tiles.length);
      return layout;
    } catch (error) {
      set({ error: errorMessage(error) });
      return null;
    }
  },

  // A — create a worktree sandbox, then open a tile inside it with the agent
  // profile. The tile's cwd becomes the worktree path (main-process enforces).
  async openSandboxAgent(projectId, agentProfile) {
    let worktreeId: string | null = null;
    try {
      const worktree = await window.aiTerminal.createWorktree({ projectId });
      worktreeId = worktree.id;
      const layout = await window.aiTerminal.openTile({ projectId, agentProfile, worktreeId: worktree.id });
      set({ dockLayout: layout });
      return layout;
    } catch (error) {
      if (worktreeId) {
        await window.aiTerminal.cleanupWorktree({ worktreeId }).catch(() => undefined);
      }
      set({ error: errorMessage(error) });
      return null;
    }
  },

  async closeTile(terminalId) {
    try {
      const layout = await window.aiTerminal.closeTile({ terminalId });
      set({ dockLayout: layout });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  async selectTile(terminalId) {
    try {
      const layout = await window.aiTerminal.selectTile({ terminalId });
      set({ dockLayout: layout });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  async reorderTile(terminalId, toIndex) {
    try {
      const layout = await window.aiTerminal.reorderTile({ terminalId, toIndex });
      set({ dockLayout: layout });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  // Synchronous renderer-local pin, deliberately NOT on the selectTile IPC
  // round trip: a "click tile A then immediately tap talk" race must still lock
  // A even before the main-owned broadcast selection has landed.
  noteLocalTileSelection(terminalId) {
    set({ lastLocalSelectedTerminalId: terminalId });
  },

  // Enter resets the slots empty on purpose (spec: enter = picking mode with
  // two empty candidates); exit also clears them so a later re-entry never
  // resurrects stale ids.
  // f1b bug 1: if the dock was in exclusive (solo) view when entering, the exit
  // rendered the solo branch again — reading as "退出只剩第一扇". Entering
  // reading suspends solo (main-owned exclusive cleared); exit always returns
  // to the full grid. Issue-#15 coalescer already guards bursts.
  toggleReadingMode() {
    const entering = !get().readingModeActive;
    if (entering && get().dockLayout.exclusiveTerminalId) {
      exclusiveToggleCoalescer.request(null);
    }
    // Entering opens the preset-picker popover (one button + thumbnails);
    // exiting unmounts the dock, so close it explicitly for state hygiene.
    set({
      readingModeActive: entering,
      readingSlots: EMPTY_READING_SLOTS,
      readingPickerOpen: entering,
    });
  },

  setReadingPickerOpen(open) {
    set({ readingPickerOpen: open });
  },

  placeReadingTerminal(slot, terminalId) {
    set({ readingSlots: placeInReadingSlot(get().readingSlots, slot, terminalId) });
  },

  syncReadingSlots(tileIds) {
    const next = pruneReadingSlots(get().readingSlots, tileIds);
    if (next !== get().readingSlots) set({ readingSlots: next });
  },

  async setDockLayout(rows, cols) {
    try {
      const layout = await window.aiTerminal.setDockLayout({ rows, cols });
      set({ dockLayout: layout });
      requestSelectedTerminalRecovery(get, "split-layout");
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  // Issue #15: a rapid 展開→單一→展開 sequence would otherwise queue one full
  // pane remount + scrollback replay per click. Coalesce: first toggle applies
  // immediately, later toggles inside a 250ms window collapse into the final
  // target. This is the issue-sanctioned defensive measure (the multi-second
  // hang itself did not reproduce in tests/e2e/issue-15-layout-toggle-hang).
  setExclusive(terminalId) {
    exclusiveToggleCoalescer.request(terminalId);
    return Promise.resolve();
  },

  // --- Dormant pane-centric actions (no-ops / thin shims) -------------------
  // The dock is now authoritative. These are kept as no-ops because
  // Sidebar/TopBar/App/ChatTimeline/Composer/ArtifactRail/ExplorerPanel/
  // LLMPickerDialog still import them. The integration phase will rewire
  // those consumers to the dock model.
  addPane() {
    // No-op: dock layout is owned by main. Use openTile(projectId) instead.
  },

  removePane() {
    // No-op: dock layout is owned by main. Use closeTile(terminalId) instead.
  },

  setPaneCount() {
    // No-op: dock layout is owned by main. Tile count is driven by openTile/closeTile.
  },

  setActivePane(_paneId) {
    // No-op: selection is owned by main. Use selectTile(terminalId) instead.
  },

  async selectProject(_projectId, _paneId, _terminalId) {
    // No-op: project selection no longer resets the dock. The sidebar "+"
    // calls openTile(projectId) to create a PTY at that folder.
  },

  async selectConversation(_conversationId, _paneId) {
    // No-op: conversation list is removed from the UI. Chat backend stays
    // dormant; the dock path does not call it.
  },

  selectProvider(_provider, _paneId) {
    // No-op: provider selection is per-conversation and the conversation UI
    // is dormant. Kept for Composer/LLMPickerDialog imports.
  },

  setPaneTerminalId(_paneId, _terminalId) {
    // No-op: terminal identity is owned by the dock (DockTile.terminalId).
  },

  async setConversationClaudeModel(conversationId, model) {
    try {
      const conversation = await window.aiTerminal.setConversationClaudeModel({
        conversationId,
        model,
      });
      set((state) => ({
        conversations: state.conversations.map((item) =>
          item.id === conversation.id ? conversation : item,
        ),
      }));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  async adoptClaudeHistory(projectId, key) {
    try {
      const conversation = await window.aiTerminal.adoptClaudeHistory({ projectId, key });
      set((state) => ({
        conversations: [conversation, ...state.conversations.filter((item) => item.id !== conversation.id)],
      }));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  async createProject() {
    try {
      const workspacePath = await window.aiTerminal.pickWorkspace();
      if (!workspacePath) return;
      // ponytail: normalize path (Windows path comparison is case-insensitive
      // and backslash/slash interchangeable). A pending placeholder for the
      // same workspace means the real record is already on its way.
      const normalized = workspacePath.replace(/\\/g, "/").toLowerCase();
      const existing = get().projects.find(
        (p) => p.workspacePath.replace(/\\/g, "/").toLowerCase() === normalized,
      );
      if (existing) {
        if (isPendingProject(existing)) return;
        // Reuse existing project — open its tile and close sidebar on mobile.
        void get().openTile(existing.id);
        // ponytail: mirrors Sidebar.tsx closeSidebarOnMobile; not shared because
        // it's a one-liner DOM toggle and only these two call sites exist.
        if (window.matchMedia(MOBILE_LAYOUT_QUERY).matches) {
          document.querySelector<HTMLElement>(".sidebar-brand .sidebar-toggle")?.click();
        }
        return;
      }
      const name = workspacePath.split(/[\\/]/).filter(Boolean).at(-1) ?? "Workspace";
      // #17: the create IPC can block for 10-20s on a large ledger (the sql.js
      // database is persisted wholesale on every transaction, so a create sits
      // in the serialized transaction queue behind full-DB exports + disk
      // writes). Render a placeholder immediately for instant feedback, then
      // swap in the real project when the IPC resolves.
      const placeholder = makePendingProject(name, workspacePath);
      set((state) => ({
        projects: [placeholder, ...state.projects],
      }));
      try {
        const project = await window.aiTerminal.createProject({ name, workspacePath });
        set((state) => ({
          projects: state.projects.map((item) => (item.id === placeholder.id ? project : item)),
        }));
      } catch (error) {
        // Creation failed — drop the placeholder so the list never shows a
        // ghost project, and surface the error as usual.
        set((state) => ({
          projects: state.projects.filter((item) => item.id !== placeholder.id),
          error: errorMessage(error),
        }));
      }
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  async renameProject(projectId, name) {
    try {
      const project = await window.aiTerminal.renameProject({ projectId, name });
      set((state) => ({
        projects: state.projects.map((item) => (item.id === project.id ? project : item)),
      }));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  async pinProject(projectId, pinned) {
    try {
      const project = await window.aiTerminal.pinProject({ projectId, value: pinned });
      set((state) => ({
        projects: state.projects
          .map((item) => (item.id === project.id ? project : item))
          .sort(projectManualOrder),
      }));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  async reorderProjects(projectIds) {
    try {
      const projects = await window.aiTerminal.reorderProjects({ projectIds });
      set({ projects: projects.sort(projectManualOrder) });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  async archiveProject(projectId) {
    try {
      const archived = await window.aiTerminal.archiveProject({ projectId, value: true });
      set((state) => {
        const projects = state.projects.filter((item) => item.id !== projectId);
        const conversations = state.conversations.filter((item) => item.projectId !== projectId);
        const movedConversations = state.conversations.filter((item) => item.projectId === projectId);
        return {
          projects,
          conversations,
          archivedProjects: [archived, ...state.archivedProjects],
          archivedConversations: [...movedConversations, ...state.archivedConversations],
        };
      });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  async restoreProject(projectId) {
    try {
      const project = await window.aiTerminal.archiveProject({ projectId, value: false });
      set((state) => {
        const restoredConversations = state.archivedConversations.filter(
          (item) => item.projectId === projectId && !item.archived,
        );
        return {
          projects: [project, ...state.projects],
          conversations: [...restoredConversations, ...state.conversations],
          archivedProjects: state.archivedProjects.filter((item) => item.id !== projectId),
          archivedConversations: state.archivedConversations.filter(
            (item) => item.projectId !== projectId || item.archived,
          ),
        };
      });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  async deleteProject(projectId) {
    try {
      await window.aiTerminal.deleteProject({ projectId });
      set((state) => ({
        projects: state.projects.filter((item) => item.id !== projectId),
        conversations: state.conversations.filter((item) => item.projectId !== projectId),
      }));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  async createConversation(_paneId, _provider) {
    // No-op in the dock path: conversation creation is not surfaced in the
    // terminal-first UI. Chat backend stays dormant.
  },

  async continueConversationWithProvider(_sourceConversationId, _targetProvider, _paneId) {
    // No-op in the dock path: conversation continuation is not surfaced.
  },

  async renameConversation(conversationId, name) {
    try {
      const conversation = await window.aiTerminal.renameConversation({ conversationId, name });
      set((state) => ({
        conversations: state.conversations.map((item) => item.id === conversation.id ? conversation : item),
      }));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  async archiveConversation(conversationId) {
    try {
      const archived = await window.aiTerminal.archiveConversation({ conversationId, value: true });
      set((state) => ({
        conversations: state.conversations.filter((item) => item.id !== archived.id),
        archivedConversations: [archived, ...state.archivedConversations],
      }));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  async restoreConversation(conversationId) {
    const archived = get().archivedConversations.find((item) => item.id === conversationId);
    if (!archived || !get().projects.some((project) => project.id === archived.projectId)) {
      set({ error: "Restore the parent project first." });
      return;
    }
    try {
      const conversation = await window.aiTerminal.archiveConversation({
        conversationId,
        value: false,
      });
      set((state) => ({
        conversations: [conversation, ...state.conversations],
        archivedConversations: state.archivedConversations.filter(
          (item) => item.id !== conversationId,
        ),
      }));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  async deleteConversation(conversationId) {
    try {
      await window.aiTerminal.deleteConversation(conversationId);
      set((state) => ({
        archivedConversations: state.archivedConversations.filter(
          (item) => item.id !== conversationId,
        ),
        conversations: state.conversations.filter((item) => item.id !== conversationId),
      }));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  async summarizeConversation(conversationId) {
    if (get().summarizingConversationIds.includes(conversationId)) return;
    set((state) => {
      const summaryErrors = { ...state.summaryErrors };
      delete summaryErrors[conversationId];
      return {
        summaryErrors,
        summarizingConversationIds: [...state.summarizingConversationIds, conversationId],
      };
    });
    try {
      const conversation = await window.aiTerminal.summarizeConversation({ conversationId });
      set((state) => ({
        conversations: state.conversations.map((item) =>
          item.id === conversation.id ? conversation : item,
        ),
      }));
    } catch (error) {
      set((state) => ({
        summaryErrors: { ...state.summaryErrors, [conversationId]: errorMessage(error) },
      }));
    } finally {
      set((state) => ({
        summarizingConversationIds: state.summarizingConversationIds.filter(
          (id) => id !== conversationId,
        ),
      }));
    }
  },

  clearSummaryError(conversationId) {
    set((state) => {
      const summaryErrors = { ...state.summaryErrors };
      delete summaryErrors[conversationId];
      return { summaryErrors };
    });
  },

  sendMessage(_text, _attachments, _paneId, _nativeWorkflow = false) {
    // No-op in the dock path: message sending is not surfaced in the
    // terminal-first UI. Chat backend stays dormant.
    return Promise.resolve(false);
  },

  async runTerminalCommand(_command, _paneId) {
    // No-op in the dock path: terminal commands are not surfaced.
  },

  async executeCouncil(_synthesis, _paneId) {
    // No-op in the dock path: council execution is not surfaced.
  },

  async cancelRun(_paneId) {
    // No-op in the dock path: run cancellation is not surfaced.
  },

  async resolveApproval(requestId, decision) {
    try {
      await window.aiTerminal.resolveApproval({ requestId, decision });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  async resolveUserInput(requestId, answers) {
    try {
      await window.aiTerminal.resolveUserInput({ requestId, answers });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  saveAttachment(_file, _paneId) {
    // No-op in the dock path: attachments are per-conversation and the
    // conversation UI is dormant.
    return Promise.reject(new Error("Attachments are not available in the terminal-first UI."));
  },

  async deleteAttachment(attachmentId) {
    try {
      await window.aiTerminal.deleteAttachment(attachmentId);
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  async refreshProviders(input) {
    // Main owns the TTL cache: an input-less call is a cheap cache read, only
    // {force:true} (the 重探钮) actually bumps past it. Concurrent callers
    // share the one in-flight round.
    if (probing) {
      pendingFocus = input?.focus ?? pendingFocus;
      return;
    }
    probing = true;
    set({ providersProbing: true });
    try {
      set({ providers: await window.aiTerminal.refreshProviders(input) });
    } catch (error) {
      set({ error: errorMessage(error) });
    } finally {
      probing = false;
      set({ providersProbing: false });
      if (pendingFocus) {
        const focus = pendingFocus;
        pendingFocus = undefined;
        void get().refreshProviders({ focus });
      }
    }
  },

  async updateSettings(settings) {
    // #60: draft state for mid-typing values lives in SettingsPanel; this
    // action only receives committable patches. Main applies deep-partial
    // patch semantics, so absent fields are never reset.
    try {
      const saved = await window.aiTerminal.setSettings(settings);
      // Hot model registry (stage 1): the saved settings (not the patch) is
      // the source of truth for the picker list. main also broadcasts
      // profilesChanged; the local recompute wins no data race because both
      // derive from the same repository snapshot.
      const options = deriveAgentOptions(saved.customProfiles);
      setAgentOptions(options);
      set({ settings: saved, agentOptions: options });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setExplorerOpen: (explorerOpen) => {
    set({ explorerOpen });
    requestSelectedTerminalRecovery(get, "explorer");
  },
  requestExplorerReveal: (path, projectId) => {
    set({ explorerRevealRequest: { path, projectId, at: Date.now() } });
    get().setExplorerOpen(true);
  },
  setArtifactOpen(artifactOpen) {
    // Mutex: opening the artifact rail closes the checkpoint rail (both are
    // right-side asides and would overlap). Closing does not auto-open the other.
    set({
      artifactOpen,
      selectedArtifact: artifactOpen ? get().selectedArtifact : null,
      ...(artifactOpen ? { checkpointOpen: false } : {}),
    });
  },
  openArtifact(path, title, projectId) {
    set({
      artifactOpen: true,
      checkpointOpen: false,
      selectedArtifact: projectId
        ? { path, title, projectId }
        : { path, title },
    });
  },
  closeArtifact: () => set({ selectedArtifact: null }),
  setCheckpointOpen(checkpointOpen) {
    set({
      checkpointOpen,
      ...(checkpointOpen ? { artifactOpen: false, selectedArtifact: null } : {}),
    });
  },
  // --- A — Worktree manager dialog ----------------------------------------
  // Load-on-open + refresh-after-action. No polling: worktree ops are low-frequency
  // and the user is looking at the dialog when acting. hasRunningTerminal comes
  // from the backend (WorktreeManager.list fills it) so the renderer never guesses
  // terminal state.
  async openWorktreeDialog(projectId) {
    set({
      worktreeDialogOpen: true,
      worktreeDialogProjectId: projectId,
      worktreeError: null,
      worktreeDiffById: {},
    });
    try {
      const worktrees = await window.aiTerminal.listWorktrees({ projectId });
      set({ worktrees });
    } catch (error) {
      set({ worktrees: [], worktreeError: errorMessage(error) });
    }
  },
  closeWorktreeDialog() {
    set({
      worktreeDialogOpen: false,
      worktreeDialogProjectId: null,
      worktrees: [],
      worktreeDiffById: {},
      worktreeError: null,
      worktreeBusyId: null,
    });
  },
  async refreshWorktreeDiff(worktreeId) {
    set({ worktreeBusyId: worktreeId, worktreeError: null });
    try {
      const summary = await window.aiTerminal.worktreeDiffSummary({ worktreeId });
      set((state) => ({
        worktreeDiffById: { ...state.worktreeDiffById, [worktreeId]: {
          diffStat: summary.diffStat,
          commits: summary.commits,
          dirty: summary.dirty,
        } },
      }));
    } catch (error) {
      set({ worktreeError: errorMessage(error) });
    } finally {
      set({ worktreeBusyId: null });
    }
  },
  async mergeWorktreeAction(worktreeId) {
    set({ worktreeBusyId: worktreeId, worktreeError: null });
    try {
      await window.aiTerminal.mergeWorktree({ worktreeId, confirm: true });
      await reloadWorktrees(get, set);
    } catch (error) {
      set({ worktreeError: errorMessage(error) });
    } finally {
      set({ worktreeBusyId: null });
    }
  },
  async abortWorktreeAction(worktreeId) {
    set({ worktreeBusyId: worktreeId, worktreeError: null });
    try {
      await window.aiTerminal.abortWorktree({ worktreeId });
      await reloadWorktrees(get, set);
    } catch (error) {
      set({ worktreeError: errorMessage(error) });
    } finally {
      set({ worktreeBusyId: null });
    }
  },
  async cleanupWorktreeAction(worktreeId) {
    set({ worktreeBusyId: worktreeId, worktreeError: null });
    try {
      await window.aiTerminal.cleanupWorktree({ worktreeId });
      await reloadWorktrees(get, set);
    } catch (error) {
      set({ worktreeError: errorMessage(error) });
    } finally {
      set({ worktreeBusyId: null });
    }
  },
  async resumeWorktreeAction(worktreeId) {
    set({ worktreeBusyId: worktreeId, worktreeError: null });
    try {
      const state = get();
      const projectId = state.worktreeDialogProjectId;
      if (!projectId) throw new Error("No project selected.");
      // Resume needs a live terminal bound to this worktree (the main process
      // re-validates the binding). TerminalInfo carries worktreeId, so find the
      // running terminal pointing at this sandbox.
      const terminals = await window.aiTerminal.listTerminals(projectId);
      const bound = terminals.find((t) => t.worktreeId === worktreeId && t.status === "running");
      if (!bound) throw new Error("No live terminal is bound to this worktree.");
      const resumed = await window.aiTerminal.resumeWorktree({ worktreeId, terminalId: bound.id });
      // IPC returns an allowlist-rebuilt command; it does not write to the PTY.
      // The UI owns the final explicit injection + Enter into the already-bound
      // terminal after every backend binding/profile/cwd check has passed.
      // #50/#51 retry: ALL agent launch paths share buildAgentLaunchWriteInput
      // so exactly-one-Enter holds here too (was a raw `${command}\r` bypass).
      await window.aiTerminal.writeTerminal(buildAgentLaunchWriteInput(bound.id, resumed));
      await reloadWorktrees(get, set);
    } catch (error) {
      set({ worktreeError: errorMessage(error) });
    } finally {
      set({ worktreeBusyId: null });
    }
  },
  clearError: () => set({ error: null }),
  setError: (error: string) => set({ error }),
  setPickerState: (state) => set({ pickerState: state }),
  recoverySchedulers: new Map(),
  registerRecoveryScheduler: (terminalId, scheduler) => {
    get().recoverySchedulers.set(terminalId, scheduler);
    return () => {
      const map = get().recoverySchedulers;
      if (map.get(terminalId) === scheduler) map.delete(terminalId);
    };
  },
  requestTerminalRecovery: (terminalId, reason) => {
    get().recoverySchedulers.get(terminalId)?.schedule(reason);
  },
  async hydratePtyStates() {
    try {
      const entries = await window.aiTerminal.getTerminalDashboard();
      const next: Record<string, PtyState> = {};
      for (const entry of entries) next[entry.id] = entry.ptyState;
      set((state) => ({ ptyStates: { ...next, ...state.ptyStates } }));
    } catch {
      // Dashboard is best-effort; push subscription will still keep state live.
    }
  },
  async hydrateTerminalKeepalives() {
    try {
      const states = await window.aiTerminal.listTerminalKeepalives();
      const next: Record<string, TerminalKeepaliveState> = {};
      for (const entry of states) next[entry.terminalId] = entry;
      set((state) => ({ terminalKeepalives: { ...next, ...state.terminalKeepalives } }));
    } catch {
      // Best-effort mirror; header actions still work and re-sync on click.
    }
  },
  async setTerminalKeepaliveHours(terminalId, hours) {
    const state = await window.aiTerminal.setTerminalKeepalive({ terminalId, hours });
    set((current) => ({
      terminalKeepalives: { ...current.terminalKeepalives, [state.terminalId]: state },
    }));
  },
}));

function requestSelectedTerminalRecovery(
  get: () => AppState,
  reason: string,
): void {
  const terminalId = get().dockLayout.selectedTerminalId;
  if (terminalId) get().requestTerminalRecovery(terminalId, reason);
}

function emptyPane(id: string, selectedProvider: ProviderProfileId): WorkspacePane {
  return {
    id,
    projectId: null,
    conversationId: null,
    selectedProvider,
    events: [],
    runningTurnId: null,
    runningCouncilGroupId: null,
    loadToken: 0,
    terminalId: null,
  };
}

function bootstrapPane(_bootstrap: BootstrapData, settings: AppSettings): WorkspacePane {
  // Always start with a single empty pane (no project, no conversation) so the
  // user lands on a clean shell and picks a project / launches an agent.
  // Applies to first run, desktop, web, and mobile entry alike.
  return emptyPane("pane-1", settings.defaultProvider);
}

export function routeEvent(pane: WorkspacePane, event: NormalizedEvent): WorkspacePane {
  if (pane.conversationId !== event.conversationId) return pane;
  const terminal = isTerminalEvent(event);
  const events = mergeEvents(pane.events, [event]);
  const turnCompleted = events.some((current) =>
    current.turnId === event.turnId && isTerminalEvent(current),
  );
  return {
    ...pane,
    events,
    runningTurnId: event.type === "user.message"
      ? turnCompleted
        ? pane.runningTurnId === event.turnId ? null : pane.runningTurnId
        : event.turnId
      : terminal && (pane.runningTurnId === event.turnId || event.payload?.terminal === true)
        ? null
        : pane.runningTurnId,
    runningCouncilGroupId:
      terminal && (
        (event.turnGroupId && pane.runningCouncilGroupId === event.turnGroupId) ||
        event.payload?.terminal === true
      )
        ? null
        : pane.runningCouncilGroupId,
  };
}

function isTerminalEvent(event: NormalizedEvent): boolean {
  return (
    event.type === "assistant.final" ||
    event.type === "error" ||
    event.type === "council.cancelled" ||
    // Cancelled turns end with a "warning" carrying terminal: true. Plain mid-run
    // warnings (e.g. Codex context compaction) lack the flag and stay non-terminal.
    event.payload?.terminal === true
  );
}

function newestFirst(left: { updatedAt: string }, right: { updatedAt: string }): number {
  return right.updatedAt.localeCompare(left.updatedAt);
}

function projectManualOrder(left: Project, right: Project): number {
  return Number(right.pinned) - Number(left.pinned) || left.order - right.order || left.id.localeCompare(right.id);
}

const MAX_PANE_EVENTS = 2000;

function mergeEvents(loaded: NormalizedEvent[], live: NormalizedEvent[]): NormalizedEvent[] {
  const merged = new Map(loaded.map((event) => [event.id, event]));
  for (const event of live) merged.set(event.id, event);
  const sorted = [...merged.values()].sort((left, right) => left.sequence - right.sequence);
  // Tail-trim: keep the most recent K events. High-signal events
  // (user.message / assistant.final / tool.completed / error) are normally in
  // the tail of an active conversation, so a plain slice preserves them.
  return sorted.length > MAX_PANE_EVENTS ? sorted.slice(-MAX_PANE_EVENTS) : sorted;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function reloadWorktrees(
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
): Promise<void> {
  const projectId = get().worktreeDialogProjectId;
  if (!projectId) return;
  try {
    const worktrees = await window.aiTerminal.listWorktrees({ projectId });
    set({ worktrees, worktreeDiffById: {} });
  } catch (error) {
    set({ worktreeError: errorMessage(error) });
  }
}
