// Canonical PtyState helpers + legacy 3-state mapping.
// The wire type is canonical (schema.ts ptyStateSchema); old consumers that
// still expect "idle" | "shell-ready" | "llm-running" map via toLegacyPtyState.

import type { PtyState, PtyStateSource } from "./schema";

/** Legacy 3-state value used by the old getPtyState IPC + dashboard shape. */
export type LegacyPtyState = "idle" | "shell-ready" | "llm-running";

/** Attention states: a human needs to act. AttentionCenter files these only. */
export const ATTENTION_STATES: ReadonlySet<PtyState> = new Set([
  "waiting_input",
  "approval_required",
  "blocked",
  "error",
]);

export function isAttentionState(state: PtyState | null | undefined): boolean {
  return !!state && ATTENTION_STATES.has(state);
}

const SOURCE_AUTHORITY: Readonly<Record<PtyStateSource, number>> = {
  heuristic: 0,
  screen: 1,
  jev: 1, // model second opinion — same tier as the screen rules it refines
  osc: 2,
  broker: 3,
  provider: 3,
  process: 3,
};

/** Numeric reliability tier used when two sources compete for attention. */
export function ptyStateSourceAuthority(source: PtyStateSource | null | undefined): number {
  return source ? SOURCE_AUTHORITY[source] : -1;
}

/**
 * Low-reliability sources (heuristic ANSI/title/plain-agent parsing) must NEVER
 * overwrite or clear an existing attention state. A conservative agent-only
 * fallback may enter attention when richer OSC/provider signals are absent.
 * Exception: an `error` filed BY a screen/heuristic source may be retracted by
 * a screen/heuristic source — low-confidence evidence may undo itself when the
 * screen moves on. provider/broker/process-owned hard errors stay locked.
 * Returns true when `candidate` from `source` is allowed to replace `current`.
 */
export function canTransitionTo(
  current: PtyState | null,
  candidate: PtyState,
  source: PtyStateSource,
  currentSource?: PtyStateSource | null,
): boolean {
  if (current === null) return true;
  if (current === candidate) return false; // idempotent: no-op, caller decides
  const currentIsAttention = isAttentionState(current);
  if (currentIsAttention) {
    // A soft error filed by screen/activity evidence may be retracted by the
    // same low-reliability signals — the screen changed, so its verdict may too.
    // Hard sources (provider/broker/process, e.g. non-zero exit) stay locked.
    if (
      current === "error" &&
      (currentSource === "screen" || currentSource === "heuristic") &&
      (source === "screen" || source === "heuristic")
    ) {
      return true;
    }
    // Activity and screen parsing may enter attention, but never change or
    // clear an already-filed attention/error state. A richer signal or an
    // explicit human acknowledgement must own that transition.
    if (source === "heuristic" || source === "screen" || source === "jev") return false;
    // OSC cannot replace a provider/broker/process-owned hard state. Sources
    // in the same reliability tier may resolve one another.
    if (ptyStateSourceAuthority(source) < ptyStateSourceAuthority(currentSource)) return false;
  }
  return true;
}

/**
 * Map canonical state → legacy 3-state for old IPC consumers (getPtyState,
// TerminalDashboardEntry.ptyState, context-meter). Preserves the old contract:
//   llm-running = an agent/LLM is actively working
//   shell-ready  = prompt visible, idle
//   idle         = nothing yet / done
 */
export function toLegacyPtyState(state: PtyState | null | undefined): LegacyPtyState {
  switch (state) {
    case "running":
    case "starting":
      return "llm-running";
    case "waiting_input":
    case "approval_required":
    case "blocked":
      // Preserve the old three-state wire contract for callers that have not
      // migrated. Canonical consumers must use isAgentWorking/isInterruptible
      // so waiting-for-human is not presented or stopped as active compute.
      return "llm-running";
    case "error":
      return "llm-running";
    case "done":
    case null:
    case undefined:
      return "idle";
    default:
      return "shell-ready";
  }
}

/**
 * Ctrl+C / interrupt guard. Only an actively-running LLM may be interrupted.
 * Attention states (waiting_input/approval_required/blocked) must NEVER be
 * interrupted — the user's input or approval decision is the only exit.
 */
export function isInterruptible(state: PtyState | null | undefined): boolean {
  return state === "running";
}

/** Active computation predicate; attention/error states are not "running". */
export function isAgentWorking(state: PtyState | null | undefined): boolean {
  return state === "starting" || state === "running";
}
