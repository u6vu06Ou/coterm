// Agent done-toast — native Windows desktop notification (bottom-right) when
// the agent pane a USER opened finishes a turn (working → done) or needs a
// human (working → attention). Pure decision logic in decideAgentToast (no
// electron import) so it unit-tests without the runtime; the
// AgentDoneToastNotifier class subscribes to ptyStateChanged on the
// AppEventBus — the same chokepoint AttentionCenter uses — so pty-manager.ts
// stays untouched.
//
// Rules:
// - 2026-10-15 owner rule: ONLY the main agent finishing a turn the user
//   started toasts. A done edge counts only when the user pressed Enter in
//   that pane AFTER the agent was already sitting idle (so the launch/resume
//   command of a restored session never counts) and that Enter has not been
//   used by an earlier settled done. Attention states never toast.
// - Only a transition into done/attention FROM a working state (starting /
//   running) fires. previous=null (spawn/hydrate) never fires.
// - Sub-agent protection (2026-10-14 user rule: sub-agent completions must NOT
//   toast the Windows desktop):
//   1. Agent-owned panes (opened through the agent API, ownedByAgentApi) never
//      toast — the user did not open them. The settle wait is armed only for
//      user-opened panes; fire-time re-derives the flag.
//   2. The canonical state flips working→done→working while a sub-agent or
//      background task finishes / between steps. A "done" toast therefore
//      fires only after the pane has STAYED done continuously for the settling
//      window (DONE_SETTLE_MS); any other state cancels the wait.
//   3. After a done toast, a brief wake-up (<MIN_WORKING_SPAN_MS of continuous
//      working before the next done edge) never re-arms — the main agent
//      printing some text then going idle must not produce repeated toasts.
//      Only a meaningful stretch counts as a new turn.
//   4. DONE_MIN_GAP_MS minimum gap between two done toasts per terminal.
// - Attention (waiting_input/approval_required/blocked/error) means a human is
//   needed, so it stays effectively immediate: a short ATTENTION_SETTLE_MS
//   window drops only bounces that resolve on their own within it.
// - One toast per turn: the per-turn flag clears when the pane next enters a
//   working state; the settle claim happens at fire time only.
// - 10s per-terminal cooldown, measured from the last ACTUAL toast — a
//   focused-skip must not eat the cooldown of a later turn.
// - Skip when the Coterm window is focused AND this terminal is the selected
//   one (the user is looking right at it). Notify otherwise.
// - Timers are injected (deps.setTimer/clearTimer, defaulting to the globals)
//   so tests run under fake timers; dispose() and the terminal-close
//   reconciliation cancel every pending settle wait.
// - Privacy (logging-api §A.2): the toast carries only the pane title + a
//   two-word body. No PTY output, no prompt, nothing that crossed the screen.

import type { AppEventBus } from "../core/event-bus";
import { shellTitle } from "@shared/terminal";
import { isAttentionState, isAgentWorking } from "@shared/pty-state";
import type { PtyState } from "@shared/schema";
import type { PtyStateChanged, TerminalInfo } from "@shared/types";

/** Per-terminal cooldown between two toasts, in ms. */
export const TOAST_COOLDOWN_MS = 10_000;
/** working→done must persist this long before the done toast fires. */
export const DONE_SETTLE_MS = 12_000;
/** working→attention persists this long; resolves sooner = dropped. */
export const ATTENTION_SETTLE_MS = 2_000;
/**
 * Sub-agent spam guard: after a done toast for a terminal, only a working
 * stretch of at least this length before the next done edge counts as a new
 * turn. Short wake-ups (< this) never re-arm the toast.
 */
export const MIN_WORKING_SPAN_MS = 20_000;
/** Minimum gap between two done toasts for the same terminal. */
export const DONE_MIN_GAP_MS = 60_000;

/** Injected so tests can shrink the windows; defaults to the constants above. */
export interface AgentToastTimings {
  doneSettleMs: number;
  attentionSettleMs: number;
  minWorkingSpanMs: number;
  doneMinGapMs: number;
}

export const DEFAULT_AGENT_TOAST_TIMINGS: AgentToastTimings = {
  doneSettleMs: DONE_SETTLE_MS,
  attentionSettleMs: ATTENTION_SETTLE_MS,
  minWorkingSpanMs: MIN_WORKING_SPAN_MS,
  doneMinGapMs: DONE_MIN_GAP_MS,
};

export type AgentToastKind = "done" | "attention";
export type AgentToastSkipReason =
  | "disabled"
  | "agent-owned"
  | "not-from-working"
  | "short-working"
  | "already-notified"
  | "cooldown"
  | "done-gap"
  | "focused-selected"
  | "no-user-turn";

export interface AgentToastDecision {
  notify: boolean;
  kind: AgentToastKind | null;
  reason: AgentToastSkipReason | "notify";
}

export interface AgentToastDecisionInput {
  isEnabled: boolean;
  windowFocused: boolean;
  /** The terminal this event belongs to is the selected pane. */
  isSelected: boolean;
  /**
   * The pane is itself a sub-agent: an external agent (Agent API) opened it through
   * the agent API. Such panes never toast.
   */
  ownedByAgentApi: boolean;
  /** A toast already fired for the current turn. */
  turnNotified: boolean;
  /** Epoch ms of the last ACTUAL toast for this terminal, null if never. */
  lastNotifyAt: number | null;
  /** Epoch ms of the last ACTUAL done toast, null if none. */
  lastDoneToastAt: number | null;
  /**
   * Length (ms) of the continuous working stretch that ended at this done
   * edge; null when unknown (never observed entering working — e.g. the app
   * started mid-turn, or an attention state ended the stretch). Sub-agent
   * spam short wake-ups carry a small span.
   */
  workingSpanMs: number | null;
  /** Whether an actual done toast already fired for this terminal. */
  doneToastFired: boolean;
  /** The user started this turn (Enter typed into an idle agent pane). */
  userTurn: boolean;
  previous: PtyState | null;
  next: PtyState;
  now: number;
  /** The settle/gap windows that shape the gates below. */
  timings: AgentToastTimings;
}

/**
 * Transition gate: only a working → (done | attention) edge is toastable.
 * previous=null (spawn/hydrate/screen defaults) never fires; done→done,
 * running→running source upgrades and attention→attention re-filings don't.
 */
export function isToastCandidate(
  previous: PtyState | null,
  next: PtyState,
): boolean {
  return isAgentWorking(previous) && (next === "done" || isAttentionState(next));
}

/**
 * The full toast decision. Pure — no electron, I/O or time (now is injected).
 * Order matters for the recorded reason, not for the outcome.
 */
export function decideAgentToast(input: AgentToastDecisionInput): AgentToastDecision {
  if (!input.isEnabled) {
    return { notify: false, kind: null, reason: "disabled" };
  }
  // Sub-agent panes (agent API open-world) never toast — the user did not
  // open them, their turns are the sub-agent's business, not the user's feed.
  if (input.ownedByAgentApi) {
    return { notify: false, kind: null, reason: "agent-owned" };
  }
  if (!isToastCandidate(input.previous, input.next) || input.next !== "done") {
    return { notify: false, kind: null, reason: "not-from-working" };
  }
  if (!input.userTurn) {
    return { notify: false, kind: null, reason: "no-user-turn" };
  }
  if (isAttentionState(input.next)) {
    // Attention stays effectively immediate — the notifier's short settle
    // window drops self-resolving bounces; no extra gate here.
  } else {
    // next === "done": a short wake-up after a previous done toast never
    // re-arms. Unknown span counts as unverified (could be a brief wake) and
    // is suppressed too — but only once a done toast actually fired; a fresh
    // pane with an unobserved working entry still toasts.
    if (
      input.doneToastFired &&
      (input.workingSpanMs === null || input.workingSpanMs < input.timings.minWorkingSpanMs)
    ) {
      return { notify: false, kind: null, reason: "short-working" };
    }
  }
  if (input.turnNotified) {
    return { notify: false, kind: null, reason: "already-notified" };
  }
  if (input.lastNotifyAt !== null && input.now - input.lastNotifyAt < TOAST_COOLDOWN_MS) {
    return { notify: false, kind: null, reason: "cooldown" };
  }
  if (
    input.lastDoneToastAt !== null &&
    input.now - input.lastDoneToastAt < input.timings.doneMinGapMs
  ) {
    return { notify: false, kind: null, reason: "done-gap" };
  }
  if (input.windowFocused && input.isSelected) {
    return { notify: false, kind: null, reason: "focused-selected" };
  }
  return {
    notify: true,
    kind: isAttentionState(input.next) ? "attention" : "done",
    reason: "notify",
  };
}

export type ToastTitleInfo = Pick<
  TerminalInfo,
  "isAgent" | "profile" | "cwd" | "title" | "agentSummaryTitle" | "ownedByAgentApi"
> & { agentHandle?: string | null | undefined };

/** Windows-agnostic cwd leaf ("D:\Coterm" → "Coterm"). */
function cwdBasename(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  return cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || null;
}

/**
 * After an agent exits, pwsh/cmd stamped a shell path in the window title —
 * that is not a summary. Mirrors the renderer's terminal-display-title rule.
 */
function shellExecutableName(title: string | null | undefined): string | null {
  const trimmed = title?.trim();
  if (!trimmed || !/^(?:[a-z]:)?[\\/]/i.test(trimmed)) return null;
  const leaf = trimmed.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  if (!/\.exe$/i.test(leaf) && !/^(?:pwsh|powershell|cmd|bash|wsl)$/i.test(leaf)) return null;
  return leaf.replace(/\.exe$/i, "") || null;
}

/** A title equal to the shell default or the bare "Claude Code" is no summary. */
function isPlaceholderSessionTitle(title: string | null | undefined): boolean {
  return Boolean(title && /^[^\p{L}\p{N}]*Claude Code$/iu.test(title.trim()));
}

/**
 * Toast title = the pane summary the header would show (agent summary / task
 * title), falling back to the cwd folder name for plain shells — plus the
 * agent mail handle when one exists (" · claude-1"). Composed main-side so no
 * renderer import leaks into the main process.
 */
export function agentToastTitle(info: ToastTitleInfo | null): string | null {
  if (!info) return null;
  const base = cwdBasename(info.cwd);
  let title: string | null = null;
  if (info.isAgent) {
    const shellDefault = shellTitle(info.profile);
    title =
      [info.agentSummaryTitle, info.title].find(
        (candidate) =>
          Boolean(
            candidate &&
            candidate !== shellDefault &&
            candidate !== base &&
            !isPlaceholderSessionTitle(candidate) &&
            !shellExecutableName(candidate),
          ),
      ) ?? null;
  }
  if (!title) title = base;
  if (!title) return null;
  const handle = info.agentHandle;
  return handle ? `${title} · ${handle}` : title;
}

export interface AgentToastShowInput {
  terminalId: string;
  title: string;
  body: string;
}

/** Click handling + clock injected so the class itself stays electron-free. */
export interface AgentDoneToastDeps {
  events: AppEventBus;
  /** TerminalInfo lookup for the toast title + agent-owned gate. Null =
   * generic title / unknown ownership. Structurally typed (ToastTitleInfo)
   * so any TerminalInfo identity works. */
  getTerminal: (terminalId: string) => ToastTitleInfo | null;
  isEnabled: () => boolean;
  isWindowFocused: () => boolean;
  getSelectedTerminalId: () => Promise<string | null>;
  /** Epoch ms of the user's last Enter in this pane (null = never). */
  getLastHumanSubmitAt: (terminalId: string) => number | null;
  showToast: (input: AgentToastShowInput) => void;
  /** Toast click → focus the window and select the pane (injected, testable). */
  focusAndSelect: (terminalId: string) => void;
  /** Timers injected so tests can fake the clock; defaults to the globals. */
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Settle/gap windows; defaults to DEFAULT_AGENT_TOAST_TIMINGS. */
  timings?: Partial<AgentToastTimings>;
}

/** One armed settle wait per terminal at most. */
interface ToastPending {
  kind: AgentToastKind;
  /** The working state the toastable edge came from. */
  previous: PtyState;
  /** The state the pane must still be in when the wait fires. */
  next: PtyState;
  /** Working-stretch length that ended at the edge (null = unknown). */
  workingSpanMs: number | null;
  handle: unknown;
}

interface TurnEntry {
  /** Last observed canonical state. */
  state: PtyState;
  notified: boolean;
  lastNotifyAt: number | null;
  /** Epoch ms when the current continuous working stretch began; null when
   * the pane is not working (or the entry was never observed working). */
  workingSince: number | null;
  doneToastFired: boolean;
  lastDoneToastAt: number | null;
  pending: ToastPending | null;
  /** First time the pane was seen idle (not working) - the agent was up. */
  readySince: number | null;
  /** The user Enter already spent by an earlier settled done. */
  consumedSubmitAt: number | null;
}

export class AgentDoneToastNotifier {
  private readonly timings: AgentToastTimings;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly turns = new Map<string, TurnEntry>();
  private readonly disposers: Array<() => void> = [];

  constructor(private readonly deps: AgentDoneToastDeps) {
    this.timings = { ...DEFAULT_AGENT_TOAST_TIMINGS, ...deps.timings };
    this.setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer =
      deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    const listener = (change: PtyStateChanged): void => {
      this.onStateChange(change);
    };
    deps.events.on("ptyStateChanged", listener);
    this.disposers.push(() => deps.events.off("ptyStateChanged", listener));
    // Terminal close (create/kill) / PTY exit → cancel the settle wait and
    // drop the tracked turn of terminals that no longer exist.
    const reconcile = (): void => {
      this.reconcileClosedTerminals();
    };
    deps.events.on("terminalListChanged", reconcile);
    deps.events.on("terminalExit", reconcile);
    this.disposers.push(() => {
      deps.events.off("terminalListChanged", reconcile);
      deps.events.off("terminalExit", reconcile);
    });
  }

  /** Toast click ≡ the injected focus-and-select action. */
  handleToastClick(terminalId: string): void {
    this.deps.focusAndSelect(terminalId);
  }

  /** Unsubscribe AND cancel every pending settle wait. */
  dispose(): void {
    for (const entry of this.turns.values()) this.clearEntryPending(entry);
    this.turns.clear();
    for (const disposer of this.disposers) disposer();
    this.disposers.length = 0;
  }

  private clearEntryPending(entry: TurnEntry): void {
    if (!entry.pending) return;
    this.clearTimer(entry.pending.handle);
    entry.pending = null;
  }

  private reconcileClosedTerminals(): void {
    for (const [terminalId, entry] of this.turns) {
      if (this.safeTerminal(terminalId) === null) {
        this.clearEntryPending(entry);
        this.turns.delete(terminalId);
      }
    }
  }

  private safeTerminal(terminalId: string): ToastTitleInfo | null {
    try {
      return this.deps.getTerminal(terminalId);
    } catch {
      return null;
    }
  }

  private onStateChange(change: PtyStateChanged): void {
    try {
      const now = Date.now();
      const entry = this.turns.get(change.terminalId) ?? this.blankEntry(change.state);
      this.turns.set(change.terminalId, entry);
      entry.state = change.state;
      if (!isAgentWorking(change.state) && entry.readySince === null) entry.readySince = now;

      if (isAgentWorking(change.state)) {
        // Sub-agent flip-back / next step: the pane did NOT stay done (or
        // attention) — cancel any settle wait, start a fresh working stretch,
        // and let a later genuinely-finished turn re-qualify.
        this.clearEntryPending(entry);
        if (entry.workingSince === null) entry.workingSince = now;
        entry.notified = false;
        return;
      }

      // Cheap synchronous pre-gates first — no async work for events that can
      // never toast. The full decision (focus/selected/ownership, which needs
      // the async dock lookup + terminal record) runs at settle-fire time.
      if (!this.safeEnabled()) return;

      // Keep a settle wait only while the pane is still in the state it was
      // armed for. Same-state bursts keep the original timer; any other move
      // (attention resolving into done, an error, …) breaks it.
      if (entry.pending && entry.pending.next !== change.state) {
        this.clearEntryPending(entry);
      }

      if (!isAgentWorking(change.previousState) || change.state !== "done") {
        // Not a working→X edge — nothing to arm. (done→done, hydrate,
        // attention→attention re-filings, …)
        return;
      }

      // working → done | attention: the only toastable edges. A duplicate /
      // delayed edge for the state already being waited on must not restart
      // the settle window.
      if (entry.pending && entry.pending.next === change.state) return;

      // Record how long the pane had been working before this edge — a brief
      // wake-up after a previous done toast must not re-arm (see
      // decideAgentToast's short-working gate).
      const workingSpanMs = entry.workingSince === null ? null : now - entry.workingSince;
      entry.workingSince = null;
      const kind: AgentToastKind = isAttentionState(change.state) ? "attention" : "done";
      const pending: ToastPending = {
        kind,
        // previous is verifiably a working state here (checked above —
        // non-working edges returned already).
        previous: change.previousState as PtyState,
        next: change.state,
        workingSpanMs,
        handle: this.setTimer(() => this.onSettleTimeout(change.terminalId, pending), kind === "attention" ? this.timings.attentionSettleMs : this.timings.doneSettleMs),
      };
      entry.pending = pending;
    } catch (error) {
      // A toast must never throw into the pty-state pipeline.
      // Intentionally non-logging: metadata-only failure, no PTY context.
      void error;
    }
  }

  private onSettleTimeout(terminalId: string, pending: ToastPending): void {
    const entry = this.turns.get(terminalId);
    if (!entry || entry.pending !== pending) return; // cancelled or superseded
    entry.pending = null;
    // Defensive: a missed cancellation must not toast a moved-on pane.
    if (entry.state !== pending.next) return;
    void this.decideAndToast(terminalId, entry, pending);
  }

  private async decideAndToast(terminalId: string, entry: TurnEntry, pending: ToastPending): Promise<void> {
    try {
      if (!this.safeEnabled()) return;
      // Claim the turn BEFORE the await: a second settle firing for the same
      // terminal while the dock lookup is in flight must not decide twice. A
      // stale claim is harmless — it clears on the next working state. The
      // snapshot below is provably false (the pending machinery is single per
      // terminal); the claimed value itself must NOT be passed or the pure
      // decision would see the claim as "already notified".
      const turnNotifiedBeforeClaim = entry.notified;
      entry.notified = true;
      const submitAt = this.safeLastHumanSubmitAt(terminalId);
      const userTurn =
        submitAt !== null &&
        entry.readySince !== null &&
        submitAt > entry.readySince &&
        (entry.consumedSubmitAt === null || submitAt > entry.consumedSubmitAt);
      // This settled done ends the user's turn whether or not it toasts.
      if (submitAt !== null) entry.consumedSubmitAt = submitAt;
      const selectedId = await this.safeSelectedTerminalId();
      const info = this.safeTerminal(terminalId);
      const decision = decideAgentToast({
        isEnabled: true,
        windowFocused: this.safeWindowFocused(),
        isSelected: selectedId === terminalId,
        ownedByAgentApi: info?.ownedByAgentApi === true,
        turnNotified: turnNotifiedBeforeClaim,
        lastNotifyAt: entry.lastNotifyAt,
        lastDoneToastAt: entry.lastDoneToastAt,
        workingSpanMs: pending.workingSpanMs,
        doneToastFired: entry.doneToastFired,
        userTurn,
        previous: pending.previous,
        next: pending.next,
        now: Date.now(),
        timings: this.timings,
      });
      if (!decision.notify) return;
      const title = agentToastTitle(info) ?? "Coterm";
      const body = decision.kind === "attention" ? "需要你處理" : "完成了";
      this.deps.showToast({ terminalId, title, body });
      const notifiedAt = Date.now();
      entry.lastNotifyAt = notifiedAt;
      if (decision.kind === "done") {
        entry.doneToastFired = true;
        entry.lastDoneToastAt = notifiedAt;
      }
    } catch (error) {
      // A toast must never throw into the pty-state pipeline.
      // Intentionally non-logging: metadata-only failure, no PTY context.
      void error;
    }
  }

  private blankEntry(state: PtyState): TurnEntry {
    return {
      state,
      notified: false,
      lastNotifyAt: null,
      workingSince: null,
      doneToastFired: false,
      lastDoneToastAt: null,
      pending: null,
      readySince: null,
      consumedSubmitAt: null,
    };
  }

  private safeEnabled(): boolean {
    try {
      return this.deps.isEnabled() === true;
    } catch {
      return false;
    }
  }

  private safeLastHumanSubmitAt(terminalId: string): number | null {
    try {
      return this.deps.getLastHumanSubmitAt(terminalId);
    } catch {
      return null;
    }
  }

  private safeWindowFocused(): boolean {
    try {
      return this.deps.isWindowFocused() === true;
    } catch {
      return false;
    }
  }

  private safeSelectedTerminalId(): Promise<string | null> {
    try {
      return this.deps.getSelectedTerminalId();
    } catch {
      return Promise.resolve(null);
    }
  }
}
