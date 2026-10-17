// Phase 3 (work order §8): main-owned, event-driven, metadata-only Agent API
// WorldState layer. AgentApiStateService subscribes to the EXISTING signals —
// ptyStateChanged, terminalListChanged, terminalExit, AttentionCenter changes,
// dock layout selection — and keeps one snapshot per visible session.
//
// Hard rules from §8.3:
//   - NO polling timers (no setInterval anywhere in this file)
//   - fast intents never read PTY text / transcripts and never call an LLM —
//     this module has no dependency that could do either
//   - event bursts are coalesced for consumers, but the last state always wins
//   - 8-pane rollup p95 target < 100 ms (the snapshot path is O(n) over at
//     most 8 dock tiles; see tests/unit/agentapi-state-service.test.ts)

import type { AppEventBus } from "./event-bus";
import type { PtyState, PtyStateSource, PtyStateChanged, DockLayout, AttentionNotification } from "@shared/types";

export type AgentApiLocale = "zh-TW" | "zh-CN" | "en-US";

// §8.1 authority (retry): the ONLY focus-adjacent signal that exists in the
// main process today is the dock layout's selectedTerminalId. Dock focus is
// renderer-owned and emits no event yet, so the snapshot deliberately
// expresses `selected` only. A separate `focused` field is NOT shipped —
// aliasing it to selected would fabricate an authority we do not have.
// Phase 6: the shapes live in @shared/types so the IPC/live-socket surface
// and this service can never drift apart; aliases keep existing imports.
import type { AgentApiDisplayState, AgentApiSessionWorldState } from "@shared/types";
export type { AgentApiDisplayState, AgentApiSessionWorldState };

export type AgentApiFastIntentKind =
  | "needs-attention"
  | "status-overview"
  | "has-issue"
  | "running-count";

export const AGENTAPI_DISPLAY_LABELS: Record<AgentApiLocale, Record<AgentApiDisplayState, string>> = {
  "zh-TW": {
    starting: "啟動中",
    running: "運行中",
    "waiting-input": "等待輸入",
    approval: "待批准",
    blocked: "阻塞",
    error: "錯誤",
    done: "完成",
    idle: "閒置",
    exited: "已停止",
  },
  "zh-CN": {
    starting: "启动中",
    running: "运行中",
    "waiting-input": "等待输入",
    approval: "待批准",
    blocked: "阻塞",
    error: "错误",
    done: "完成",
    idle: "空闲",
    exited: "已停止",
  },
  "en-US": {
    starting: "Starting",
    running: "Running",
    "waiting-input": "Waiting for input",
    approval: "Awaiting approval",
    blocked: "Blocked",
    error: "Error",
    done: "Done",
    idle: "Idle",
    exited: "Stopped",
  },
};

// §8.2 attention priority: approval first, then waiting input, error, blocked.
const ATTENTION_PRIORITY: Record<string, number> = {
  approval_required: 0,
  waiting_input: 1,
  error: 2,
  blocked: 3,
};

const DEFAULT_IDLE_THRESHOLD_MS = 60_000;

interface SessionEntry {
  terminalId: string;
  projectId: string;
  displayName: string;
  agentProfile: string | null;
  canonicalState: PtyState;
  source: PtyStateSource;
  lifecycleStatus: "running" | "exited";
  lastTransitionAtMs: number;
  scrollbackMode: "normal" | "alternate-screen" | null;
}

export interface AgentApiTerminalSource {
  dashboardSnapshot(): Array<{
    info: {
      id: string;
      projectId: string;
      title: string;
      status: "running" | "exited";
      agentProfile: string | null;
      startedAt: string;
    };
    ptyState: PtyState;
  }>;
  getPtyStateSource(terminalId: string): PtyStateSource | null;
  getScrollbackMode(terminalId: string): "normal" | "alternate-screen" | null;
}

export interface AgentApiAttentionSource {
  list(): AttentionNotification[];
  onAttentionChanged(callback: (notification: AttentionNotification) => void): () => void;
}

export interface AgentApiDockSource {
  getDockLayout(): Promise<DockLayout>;
  onLayoutChanged(callback: (layout: DockLayout) => void): () => void;
}

export interface AgentApiProjectSource {
  listProjects(): Array<{ id: string; name: string }>;
}

export interface AgentApiStateServiceDeps {
  events: AppEventBus;
  terminals: AgentApiTerminalSource;
  attention: AgentApiAttentionSource;
  dock: AgentApiDockSource;
  projects: AgentApiProjectSource;
  now?: () => number;
  idleThresholdMs?: number;
}

/**
 * Deterministic fast-intent classification. Conservative: anything
 * ambiguous returns null so the (later, deep-path) supervisor handles it —
 * the fast path must never guess.
 */
export function classifyAgentApiFastIntent(text: string): AgentApiFastIntentKind | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;
  // Count first: "現在有幾個在運行" also matches "運行" of status-overview.
  if (/幾個|多少個/.test(normalized) && /運行|在跑|running/.test(normalized)) return "running-count";
  if (/how many/.test(normalized) && /running|alive|active/.test(normalized)) return "running-count";
  // Issue sweep: explicit error/blocked/approval vocabulary.
  if (/有沒有|是否有|任何/.test(normalized) && /錯誤|阻塞|待批准|批准/.test(normalized)) return "has-issue";
  if (/any (errors?|blocked|approvals?)/.test(normalized)) return "has-issue";
  // Needs attention: "哪個視窗需要我" family.
  if (/需要我|要我|需要處理|需要注意/.test(normalized)) return "needs-attention";
  if (/needs? (me|my attention)|which (window|pane|terminal|session)s? needs?/.test(normalized)) {
    return "needs-attention";
  }
  // Status overview: "哪個視窗在跑什麼狀態".
  if (/在跑什麼|什麼狀態|狀態如何|目前狀態|各個視窗.*狀態/.test(normalized)) return "status-overview";
  if (/what('s| is).*(running|status)|status of/.test(normalized)) return "status-overview";
  return null;
}

export class AgentApiStateService {
  private readonly deps: AgentApiStateServiceDeps;
  private readonly now: () => number;
  private readonly idleThresholdMs: number;
  private readonly entries = new Map<string, SessionEntry>();
  private readonly attentionByTerminal = new Map<string, string>();
  private readonly projectNames = new Map<string, string>();
  private selectedTerminalId: string | null = null;
  private dockTerminalIds = new Set<string>();
  private readonly listeners = new Set<(state: AgentApiSessionWorldState[]) => void>();
  private emitScheduled = false;
  private projectNamesDirty = true;
  private readonly disposers: Array<() => void> = [];

  constructor(deps: AgentApiStateServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.idleThresholdMs = deps.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;

    const onState = (change: PtyStateChanged): void => {
      this.onPtyStateChanged(change);
    };
    const onList = (): void => {
      this.resyncFromSource();
    };
    const onExit = (payload: { terminalId: string }): void => {
      this.onTerminalExit(payload.terminalId);
    };
    deps.events.on("ptyStateChanged", onState);
    deps.events.on("terminalListChanged", onList);
    deps.events.on("terminalExit", onExit);
    this.disposers.push(() => deps.events.off("ptyStateChanged", onState));
    this.disposers.push(() => deps.events.off("terminalListChanged", onList));
    this.disposers.push(() => deps.events.off("terminalExit", onExit));

    const onAttention = (): void => {
      this.refreshAttentionMap();
      this.scheduleEmit();
    };
    this.disposers.push(deps.attention.onAttentionChanged(onAttention));
    this.disposers.push(
      deps.dock.onLayoutChanged((layout) => {
        this.applyDockLayout(layout);
        this.scheduleEmit();
      }),
    );

    this.refreshAttentionMap();
    this.resyncFromSource();
  }

  /** One async pull at boot so selection/focus is correct before any event. */
  async start(): Promise<void> {
    this.applyDockLayout(await this.deps.dock.getDockLayout());
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose();
    this.listeners.clear();
  }

  /** Consumers (panel / voice coordinator) get burst-coalesced snapshots. */
  onWorldChanged(callback: (state: AgentApiSessionWorldState[]) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * The full world snapshot. O(8) worst case — no PTY text, no LLM, no disk.
   * Entries not in the dock layout and not live are dropped on resync; the
   * world state only describes sessions the user can actually see.
   */
  getWorldState(): AgentApiSessionWorldState[] {
    if (this.projectNamesDirty) this.refreshProjectNames();
    const nowMs = this.now();
    const out: AgentApiSessionWorldState[] = [];
    for (const entry of this.entries.values()) {
      const ageMs = Math.max(0, nowMs - entry.lastTransitionAtMs);
      out.push({
        terminalId: entry.terminalId,
        projectId: entry.projectId,
        displayName: entry.displayName,
        projectLabel: this.projectNames.get(entry.projectId) ?? "",
        agentProfile: entry.agentProfile,
        canonicalState: entry.canonicalState,
        lifecycleStatus: entry.lifecycleStatus,
        displayState: this.deriveDisplayState(entry, ageMs),
        source: entry.source,
        attentionNotificationId: this.attentionByTerminal.get(entry.terminalId) ?? null,
        lastTransitionAt: new Date(entry.lastTransitionAtMs).toISOString(),
        ageMs,
        selected: entry.terminalId === this.selectedTerminalId,
        scrollbackMode: entry.scrollbackMode,
      });
    }
    return out;
  }

  /** Sessions needing a human, in §8.2 priority order, then newest first. */
  attentionOrdered(): AgentApiSessionWorldState[] {
    return this.getWorldState()
      .filter((session) => session.displayState in { approval: 1, "waiting-input": 1, error: 1, blocked: 1 })
      .sort((a, b) => {
        const priorityDiff = ATTENTION_PRIORITY[a.canonicalState]! - ATTENTION_PRIORITY[b.canonicalState]!;
        return priorityDiff !== 0 ? priorityDiff : b.lastTransitionAt.localeCompare(a.lastTransitionAt);
      });
  }

  /**
   * §8.2 fast intents: fixed templates over the world state. This method is
   * the whole answer path — it cannot read a transcript or reach a model.
   */
  answerFastIntent(kind: AgentApiFastIntentKind, locale: AgentApiLocale = "zh-TW"): string {
    const labels = AGENTAPI_DISPLAY_LABELS[locale];
    const zh = locale !== "en-US";
    const simplified = locale === "zh-CN";
    const state = this.getWorldState();
    const name = (session: AgentApiSessionWorldState): string =>
      session.displayName || session.projectLabel || session.terminalId.slice(0, 8);

    if (kind === "running-count") {
      const running = state.filter((session) => session.displayState === "running").length;
      const starting = state.filter((session) => session.displayState === "starting").length;
      return zh
        ? (simplified
          ? `目前有 ${running} 个窗口在运行${starting > 0 ? `，${starting} 个启动中` : ""}。`
          : `目前有 ${running} 個視窗在運行${starting > 0 ? `，${starting} 個啟動中` : ""}。`)
        : `${running} window(s) running${starting > 0 ? `, ${starting} starting` : ""}.`;
    }

    if (kind === "needs-attention" || kind === "has-issue") {
      const attention = this.attentionOrdered();
      if (attention.length === 0) {
        return zh
          ? (simplified ? "目前没有窗口需要您处理。" : "目前沒有視窗需要您處理。")
          : "Nothing needs your attention right now.";
      }
      const list = attention
        .map((session) => `${name(session)}（${labels[session.displayState]}）`)
        .join(zh ? "、" : ", ");
      return zh
        ? (simplified
          ? `有 ${attention.length} 个窗口需要您处理：${list}。`
          : `有 ${attention.length} 個視窗需要您處理：${list}。`)
        : `${attention.length} window(s) need you: ${list}.`;
    }

    // status-overview
    if (state.length === 0) {
      return zh
        ? (simplified ? "目前没有任何窗口。" : "目前沒有任何視窗。")
        : "No windows right now.";
    }
    const lines = state
      .map((session) => `${name(session)}（${labels[session.displayState]}）`)
      .join(zh ? "、" : ", ");
    return zh
      ? (simplified ? `各窗口状态：${lines}。` : `各視窗狀態：${lines}。`)
      : `Window states: ${lines}.`;
  }

  private deriveDisplayState(entry: SessionEntry, ageMs: number): AgentApiDisplayState {
    if (entry.lifecycleStatus === "exited") return "exited";
    switch (entry.canonicalState) {
      case "starting": return "starting";
      case "running": return "running";
      case "waiting_input": return "waiting-input";
      case "approval_required": return "approval";
      case "blocked": return "blocked";
      case "error": return "error";
      case "done": return ageMs >= this.idleThresholdMs ? "idle" : "done";
    }
  }

  private onPtyStateChanged(change: PtyStateChanged): void {
    const existing = this.entries.get(change.terminalId);
    if (existing) {
      existing.canonicalState = change.state;
      existing.source = change.source;
      existing.lastTransitionAtMs = this.now();
    } else {
      // A terminal we have not synced yet (should be rare: resync happens on
      // terminalListChanged first) — upsert a minimal metadata entry.
      this.entries.set(change.terminalId, {
        terminalId: change.terminalId,
        projectId: change.projectId,
        displayName: "",
        agentProfile: null,
        canonicalState: change.state,
        source: change.source,
        lifecycleStatus: "running",
        lastTransitionAtMs: this.now(),
        scrollbackMode: this.deps.terminals.getScrollbackMode(change.terminalId),
      });
      this.projectNamesDirty = true;
    }
    // The state machine can re-classify an alt-screen transition; keep the
    // mode fresh on every change.
    const existing2 = this.entries.get(change.terminalId);
    if (existing2) existing2.scrollbackMode = this.deps.terminals.getScrollbackMode(change.terminalId);
    this.scheduleEmit();
  }

  private onTerminalExit(terminalId: string): void {
    const entry = this.entries.get(terminalId);
    if (!entry) return;
    entry.lifecycleStatus = "exited";
    entry.lastTransitionAtMs = this.now();
    // PtyManager deletes exited terminals, so scrollback mode is no longer
    // queryable — freeze the last known value.
    this.scheduleEmit();
  }

  private resyncFromSource(): void {
    if (this.projectNamesDirty) this.refreshProjectNames();
    const live = new Map(
      this.deps.terminals.dashboardSnapshot().map((snapshot) => [snapshot.info.id, snapshot]),
    );
    for (const [id, snapshot] of live) {
      const existing = this.entries.get(id);
      const base: SessionEntry = existing ?? {
        terminalId: id,
        projectId: snapshot.info.projectId,
        displayName: snapshot.info.title,
        agentProfile: snapshot.info.agentProfile,
        canonicalState: snapshot.ptyState,
        source: this.deps.terminals.getPtyStateSource(id) ?? "process",
        lifecycleStatus: snapshot.info.status,
        lastTransitionAtMs: Date.parse(snapshot.info.startedAt) || this.now(),
        scrollbackMode: this.deps.terminals.getScrollbackMode(id),
      };
      base.displayName = snapshot.info.title;
      base.agentProfile = snapshot.info.agentProfile;
      base.scrollbackMode = this.deps.terminals.getScrollbackMode(id);
      this.entries.set(id, base);
    }
    // Prune: gone from live dashboard AND no dock tile AND already exited.
    for (const [id, entry] of this.entries) {
      if (!live.has(id) && !this.dockTerminalIds.has(id) && entry.lifecycleStatus === "exited") {
        this.entries.delete(id);
      }
    }
    this.scheduleEmit();
  }

  private applyDockLayout(layout: DockLayout): void {
    this.selectedTerminalId = layout.selectedTerminalId;
    this.dockTerminalIds = new Set(layout.tiles.map((tile) => tile.terminalId));
    this.projectNamesDirty = true;
    // A terminal that lost its tile and already exited no longer belongs in
    // the world state.
    for (const [id, entry] of this.entries) {
      if (!this.dockTerminalIds.has(id) && entry.lifecycleStatus === "exited") {
        this.entries.delete(id);
      }
    }
  }

  private refreshAttentionMap(): void {
    this.attentionByTerminal.clear();
    for (const notification of this.deps.attention.list()) {
      this.attentionByTerminal.set(notification.terminalId, notification.id);
    }
  }

  private refreshProjectNames(): void {
    this.projectNames.clear();
    for (const project of this.deps.projects.listProjects()) {
      this.projectNames.set(project.id, project.name);
    }
    this.projectNamesDirty = false;
  }

  // Burst coalescing (§8.3): a storm of state events yields one consumer
  // notification per microtask-ish window; the snapshot itself is always
  // current because entries update synchronously on every event.
  private scheduleEmit(): void {
    if (this.emitScheduled || this.listeners.size === 0) return;
    this.emitScheduled = true;
    setTimeout(() => {
      this.emitScheduled = false;
      const state = this.getWorldState();
      for (const listener of this.listeners) listener(state);
    }, 8);
  }
}
