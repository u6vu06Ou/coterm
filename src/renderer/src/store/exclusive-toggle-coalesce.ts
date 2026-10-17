/**
 * Issue #15 defensive coalescing for the exclusive (單一/展開) toggle.
 *
 * Each accepted toggle unmounts every grid XtermPane and remounts the target
 * (or vice versa), replaying scrollback. A rapid 展開→單一→展開 sequence can
 * queue many of those full rebuilds back-to-back. The repro attempt on the
 * v1.5 branch could not produce the reported multi-second hang (xterm's write
 * buffer yields internally), but the issue allows a defensive fallback: collapse
 * rapid toggles into the final requested state.
 *
 * Behavior: leading edge applies immediately; further requests inside the
 * window replace a single pending trailing request. The trailing fire is
 * skipped when the pending target equals the last applied value (net no-op).
 */
export interface ExclusiveToggleCoalescer {
  request(terminalId: string | null): void;
  /** Fire any pending trailing request immediately (used on teardown/tests). */
  flush(): void;
  dispose(): void;
}

export function createExclusiveToggleCoalescer(options: {
  windowMs?: number;
  apply: (terminalId: string | null) => void;
  onCoalesced?: (info: { coalescedCount: number; finalTarget: string | null }) => void;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}): ExclusiveToggleCoalescer {
  const windowMs = options.windowMs ?? 250;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;

  let lastApplied: string | null | undefined; // undefined = nothing applied yet
  let pending: string | null | undefined; // undefined = no pending trailing request
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastApplyAt = 0;
  let coalescedSinceLastApply = 0;

  const fire = (target: string | null): void => {
    lastApplied = target;
    lastApplyAt = Date.now();
    if (coalescedSinceLastApply > 0) {
      options.onCoalesced?.({ coalescedCount: coalescedSinceLastApply, finalTarget: target });
      coalescedSinceLastApply = 0;
    }
    options.apply(target);
  };

  const trailing = (): void => {
    timer = null;
    if (pending === undefined) return;
    const target = pending;
    pending = undefined;
    // Net no-op: rapid A→null→A (or null→A→null) inside the window collapses
    // back to the currently displayed state; applying it would trigger a full
    // pane remount for nothing.
    if (target === lastApplied) {
      if (coalescedSinceLastApply > 0) {
        options.onCoalesced?.({ coalescedCount: coalescedSinceLastApply, finalTarget: lastApplied ?? null });
        coalescedSinceLastApply = 0;
      }
      return;
    }
    fire(target);
  };

  return {
    request(terminalId: string | null): void {
      const now = Date.now();
      const inWindow = lastApplied !== undefined && now - lastApplyAt < windowMs;
      if (!inWindow) {
        fire(terminalId);
        return;
      }
      if (pending === undefined) {
        timer = setTimeoutFn(trailing, windowMs);
      } else {
        coalescedSinceLastApply += 1;
      }
      pending = terminalId;
    },
    flush(): void {
      if (timer) {
        clearTimeoutFn(timer);
        timer = null;
      }
      trailing();
    },
    dispose(): void {
      if (timer) {
        clearTimeoutFn(timer);
        timer = null;
      }
      pending = undefined;
      coalescedSinceLastApply = 0;
    },
  };
}
