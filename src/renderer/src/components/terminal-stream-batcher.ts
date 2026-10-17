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

export function createTerminalStreamBatcher(write: (data: string) => void): TerminalStreamBatcher {
  let pending: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.length === 0) return;
    const chunk = pending.join("");
    pending = [];
    write(chunk);
  };

  const push = (data: string): void => {
    pending.push(data);
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, QUIET_MS);
  };

  const dispose = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pending = [];
  };

  return { push, flush, dispose };
}
