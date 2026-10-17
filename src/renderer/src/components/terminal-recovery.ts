// Terminal recovery + STOP contract. Pure planning functions — the side
// effects (remeasure, request replay, refresh canvas, restore focus) are
// executed by the caller (TerminalDock) so this stays unit-testable.
// See design 2026-07-11 §4 (STOP) and §5 (refresh pipeline).

export interface StopPayload {
  terminalId: string;
  data: "\x03";
}

// STOP writes exactly one ETX (\x03) to the selected PTY. It does not close the
// tile, kill Coterm, or send any trailing byte. The literal type on `data`
// makes it a compile-time contract — only "\x03" satisfies it.
export function buildStopPayload(terminalId: string): StopPayload {
  return { terminalId, data: "\x03" };
}

export type RecoveryStepKind =
  | "remeasure"
  | "request-authoritative-replay"
  | "refresh-canvas"
  | "restore-focus-scroll";

export interface RecoveryStep {
  kind: RecoveryStepKind;
  terminalId: string;
  replace?: boolean;
  gatedOnOutput?: boolean;
}

// The hard-refresh pipeline. Refresh is NOT a scrollback request — it's a
// recovery sequence: remeasure, request an authoritative replace snapshot,
// force a canvas refresh, and restore focus/scroll anchoring. Every step
// corresponds to a real executed side effect (no named no-ops). The canvas
// refresh runs unconditionally (gatedOnOutput = false) so a refresh takes
// effect even when no new PTY bytes arrive.
export function planRecovery(terminalId: string): RecoveryStep[] {
  return [
    { kind: "remeasure", terminalId },
    { kind: "request-authoritative-replay", terminalId, replace: true },
    { kind: "refresh-canvas", terminalId, gatedOnOutput: false },
    { kind: "restore-focus-scroll", terminalId },
  ];
}

// #94: while a composition is live, a recovery run must not execute — replaying
// the buffer resets the cursor, so the next keydown primes the IME helper
// textarea and captures the composition anchor at (0,0), which pins the whole
// candidate box to the top-left corner until compositionend. Recovery requests
// raised mid-composition are therefore stashed (latest reason wins) and replayed
// once composition ends.
export interface ComposingGate {
  /** Run now when idle, otherwise stash and return false. */
  attempt: (reason: string) => boolean;
  /** Take the stashed reason, if any (clears it). */
  takeDeferred: () => string | null;
}

export function createComposingGate(
  isComposing: () => boolean,
  run: (reason: string) => void,
): ComposingGate {
  let deferred: string | null = null;
  return {
    attempt: (reason: string) => {
      if (isComposing()) {
        deferred = reason;
        return false;
      }
      run(reason);
      return true;
    },
    takeDeferred: () => {
      const reason = deferred;
      deferred = null;
      return reason;
    },
  };
}

// Coalesced recovery scheduler: multiple recovery requests within the window
// collapse into a single run. The runner receives the LATEST reason so the
// caller can audit which trigger won (sidebar/explorer/split/exclusive/
// orientation/manual-refresh all converge here — design §6). Returns a handle
// to cancel on unmount.
export interface RecoveryScheduler {
  schedule: (reason: string) => void;
  cancel: () => void;
}

export function createRecoveryScheduler(
  run: (reason: string) => void,
  coalesceMs = 80,
): RecoveryScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingReason = "";
  return {
    schedule: (reason: string) => {
      pendingReason = reason;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const reason = pendingReason;
        pendingReason = "";
        run(reason);
      }, coalesceMs);
    },
    cancel: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

// Single entry point TopBar (desktop + mobile) calls on Refresh. It schedules
// a coalesced recovery via the provided scheduler — never calls
// refreshTerminal directly. The scheduler's runner (owned by TerminalDock)
// executes planRecovery, which always includes the canvas-refresh step, so a
// Refresh takes effect even with no incoming PTY bytes (verdict gap 1).
export function requestTerminalRecovery(
  _terminalId: string,
  reason: string,
  scheduler: RecoveryScheduler,
): void {
  scheduler.schedule(reason);
}
