/**
 * Quiet-window stream batcher for remote (browser/mobile) xterm clients.
 *
 * codex-local-main streaming emits many small terminalData chunks per frame (spinner
 * redraws, token fragments). Writing each one forces a full xterm re-parse +
 * repaint — expensive on mobile WebViews and the root cause of high-speed
 * flicker. This batcher coalesces chunks until the stream goes quiet for
 * QUIET_MS, then issues a single terminal.write() with the joined buffer.
 *
 * Desktop keeps its existing requestAnimationFrame coalescing (tighter, tied
 * to the display refresh); this module is only used on the browser/mobile path.
 *
 * Contract:
 * - push(data): enqueue a chunk; (re)start the quiet timer.
 * - flush(): immediately write any pending chunks and cancel the timer. Called
 *   before a replace:true replay so buffered live data lands before the reset.
 * - dispose(): drop all pending output and cancel the timer. Called on tile
 *   unmount so stale chunks never write to a disposed Terminal.
 */
export interface TerminalStreamBatcher {
  push(data: string): void;
  flush(): void;
  dispose(): void;
}

export const QUIET_MS = 48;

// A continuous stream (spinner redrawing faster than QUIET_MS) never goes
// quiet, so a quiet-only batcher defers forever — output delayed by minutes
// and the joined buffer becomes a single giant write (the standby-stutter).
// Two bounded escapes, whichever comes first:
// - hard size cap past which we flush immediately (string.length = UTF-16
//   code units, so this counts CHARS, not bytes — kept honest in the name);
// - a hard LATENCY deadline from the first pending chunk (never reset), so a
//   never-quiet trickle still lands within MAX_LATENCY_MS.
export const MAX_PENDING_CHARS = 256 * 1024;
export const MAX_LATENCY_MS = 120;

export function createTerminalStreamBatcher(write: (data: string) => void): TerminalStreamBatcher {
  let pending: string[] = [];
  let pendingChars = 0;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    if (quietTimer !== null) {
      clearTimeout(quietTimer);
      quietTimer = null;
    }
    if (deadlineTimer !== null) {
      clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
    if (pending.length === 0) return;
    const chunk = pending.join("");
    pending = [];
    pendingChars = 0;
    write(chunk);
  };

  const push = (data: string): void => {
    pending.push(data);
    pendingChars += data.length;
    // Cap reached: flush NOW instead of restarting the quiet timer — the
    // stream is not quiet at all, and deferring further only grows the write.
    if (pendingChars >= MAX_PENDING_CHARS) {
      flush();
      return;
    }
    // Hard latency deadline from the FIRST chunk of this batch — deliberately
    // NOT restarted by later chunks, so a stream ticking faster than QUIET_MS
    // cannot starve the flush.
    if (deadlineTimer === null) deadlineTimer = setTimeout(flush, MAX_LATENCY_MS);
    if (quietTimer !== null) clearTimeout(quietTimer);
    quietTimer = setTimeout(flush, QUIET_MS);
  };

  const dispose = (): void => {
    if (quietTimer !== null) {
      clearTimeout(quietTimer);
      quietTimer = null;
    }
    if (deadlineTimer !== null) {
      clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
    pending = [];
    pendingChars = 0;
  };

  return { push, flush, dispose };
}
