import type {
  AgentApiAgentIdentity,
  AgentApiPendingInteraction,
  AgentApiSemanticSource,
  AgentApiSemanticTaskState,
  AgentApiSemanticTurnState,
  AgentApiSessionSemanticState,
} from "@shared/types";

const SOURCE_RANK: Record<AgentApiSemanticSource, number> = {
  "provider-event": 4,
  "native-transcript": 3,
  "agent-detector": 2,
  "screen-fallback": 1,
};

const UNKNOWN_IDENTITY: AgentApiAgentIdentity = {
  harness: "unknown",
  backend: "unknown",
  model: null,
  profile: null,
};

const EMPTY_TASK: AgentApiSemanticTaskState = {
  summary: null,
  phase: null,
  source: null,
  confidence: 0,
};

const EMPTY_TURN: AgentApiSemanticTurnState = {
  status: null,
  summary: null,
  finalText: null,
  completedAt: null,
  source: null,
  confidence: 0,
};

interface DomainStamp {
  observedAtMs: number;
  source: AgentApiSemanticSource | null;
}

interface InternalEntry {
  state: AgentApiSessionSemanticState;
  identityAtMs: number;
  task: DomainStamp;
  turn: DomainStamp;
  pendingAtMs: number;
}

export interface SemanticProjectionMeta {
  source: AgentApiSemanticSource;
  confidence: number;
  observedAt?: string | number | Date;
}

export type SemanticStateListener = (
  state: AgentApiSessionSemanticState,
  previous: AgentApiSessionSemanticState | null,
) => void;

/**
 * Memory-only semantic authority. It stores bounded meaning, never raw PTY or
 * full transcripts. Source precedence breaks ties; a newer observation may
 * advance a field, while a stale observation can never roll it backwards.
 */
export class SessionSemanticStore {
  private readonly entries = new Map<string, InternalEntry>();
  private readonly listeners = new Set<SemanticStateListener>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  get(terminalId: string): AgentApiSessionSemanticState | null {
    const entry = this.entries.get(terminalId);
    return entry ? cloneState(entry.state) : null;
  }

  list(): AgentApiSessionSemanticState[] {
    return [...this.entries.values()].map((entry) => cloneState(entry.state));
  }

  onChanged(listener: SemanticStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  ensure(terminalId: string): AgentApiSessionSemanticState {
    return cloneState(this.ensureInternal(terminalId).state);
  }

  updateIdentity(
    terminalId: string,
    identity: AgentApiAgentIdentity,
    observedAt: string | number | Date = this.now(),
  ): boolean {
    const entry = this.ensureInternal(terminalId);
    const atMs = toMs(observedAt, this.now());
    if (atMs < entry.identityAtMs) return false;
    const previous = cloneState(entry.state);
    entry.identityAtMs = atMs;
    entry.state.identity = { ...identity };
    this.touchAndEmit(entry, previous, atMs);
    return true;
  }

  updateTask(
    terminalId: string,
    patch: Partial<Pick<AgentApiSemanticTaskState, "summary" | "phase">>,
    meta: SemanticProjectionMeta,
  ): boolean {
    const entry = this.ensureInternal(terminalId);
    const atMs = toMs(meta.observedAt, this.now());
    if (!canReplace(entry.task, meta.source, atMs)) return false;
    const previous = cloneState(entry.state);
    entry.task = { source: meta.source, observedAtMs: atMs };
    entry.state.task = {
      summary: patch.summary === undefined ? entry.state.task.summary : patch.summary,
      phase: patch.phase === undefined ? entry.state.task.phase : patch.phase,
      source: meta.source,
      confidence: clampConfidence(meta.confidence),
    };
    this.touchAndEmit(entry, previous, atMs);
    return true;
  }

  updateLastTurn(
    terminalId: string,
    patch: Partial<Pick<AgentApiSemanticTurnState, "status" | "summary" | "finalText" | "completedAt">>,
    meta: SemanticProjectionMeta,
  ): boolean {
    const entry = this.ensureInternal(terminalId);
    const atMs = toMs(meta.observedAt, this.now());
    if (!canReplace(entry.turn, meta.source, atMs)) return false;
    const previous = cloneState(entry.state);
    entry.turn = { source: meta.source, observedAtMs: atMs };
    entry.state.lastTurn = {
      status: patch.status === undefined ? entry.state.lastTurn.status : patch.status,
      summary: patch.summary === undefined ? entry.state.lastTurn.summary : patch.summary,
      finalText: patch.finalText === undefined ? entry.state.lastTurn.finalText : patch.finalText,
      completedAt: patch.completedAt === undefined ? entry.state.lastTurn.completedAt : patch.completedAt,
      source: meta.source,
      confidence: clampConfidence(meta.confidence),
    };
    this.touchAndEmit(entry, previous, atMs);
    return true;
  }

  setPendingInteraction(
    terminalId: string,
    pendingInteraction: AgentApiPendingInteraction | null,
    observedAt: string | number | Date = this.now(),
  ): boolean {
    const entry = this.ensureInternal(terminalId);
    const atMs = toMs(observedAt, this.now());
    if (atMs < entry.pendingAtMs) return false;
    const previous = cloneState(entry.state);
    entry.pendingAtMs = atMs;
    entry.state.pendingInteraction = pendingInteraction ? clonePending(pendingInteraction) : null;
    this.touchAndEmit(entry, previous, atMs);
    return true;
  }

  clear(terminalId: string): void {
    const entry = this.entries.get(terminalId);
    if (!entry) return;
    const previous = cloneState(entry.state);
    this.entries.delete(terminalId);
    for (const listener of this.listeners) listener({ ...previous, pendingInteraction: null }, previous);
  }

  private ensureInternal(terminalId: string): InternalEntry {
    const existing = this.entries.get(terminalId);
    if (existing) return existing;
    const nowMs = this.now();
    const created: InternalEntry = {
      state: {
        terminalId,
        identity: { ...UNKNOWN_IDENTITY },
        task: { ...EMPTY_TASK },
        lastTurn: { ...EMPTY_TURN },
        pendingInteraction: null,
        updatedAt: new Date(nowMs).toISOString(),
      },
      identityAtMs: 0,
      task: { observedAtMs: 0, source: null },
      turn: { observedAtMs: 0, source: null },
      pendingAtMs: 0,
    };
    this.entries.set(terminalId, created);
    return created;
  }

  private touchAndEmit(entry: InternalEntry, previous: AgentApiSessionSemanticState, atMs: number): void {
    entry.state.updatedAt = new Date(Math.max(this.now(), atMs)).toISOString();
    const next = cloneState(entry.state);
    for (const listener of this.listeners) listener(next, previous);
  }
}

export function semanticSourceRank(source: AgentApiSemanticSource): number {
  return SOURCE_RANK[source];
}

function canReplace(current: DomainStamp, nextSource: AgentApiSemanticSource, nextAtMs: number): boolean {
  if (nextAtMs < current.observedAtMs) return false;
  if (nextAtMs > current.observedAtMs) return true;
  if (!current.source) return true;
  return SOURCE_RANK[nextSource] >= SOURCE_RANK[current.source];
}

function toMs(value: string | number | Date | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : fallback;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clonePending(value: AgentApiPendingInteraction): AgentApiPendingInteraction {
  return { ...value, options: value.options.map((option) => ({ ...option })) };
}

function cloneState(value: AgentApiSessionSemanticState): AgentApiSessionSemanticState {
  return {
    ...value,
    identity: { ...value.identity },
    task: { ...value.task },
    lastTurn: { ...value.lastTurn },
    pendingInteraction: value.pendingInteraction ? clonePending(value.pendingInteraction) : null,
  };
}
