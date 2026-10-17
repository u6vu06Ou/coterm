// SessionWaitCoordinator — event-driven, cancellable wait primitive for the
// Agent API session wait endpoint (issue #4, extended by issue #61).
//
// The coordinator owns exactly one listener for each source event. Individual
// waits are records in `pending`, so adding 32 waits never adds 64 EventEmitter
// listeners (and never triggers MaxListenersExceededWarning).

import type { AppEventBus } from "./event-bus";
import { logger } from "./logger";
import type { PtyState, PtyStateChanged } from "@shared/types";

export type WaitOutcome = "matched" | "interrupted" | "timeout" | "closed" | "shutdown" | "match" | "stale";

export interface WaitMatch {
  /** The buffered line containing the regex hit (bounded by the scan window). */
  line: string;
  /** Character offset of the hit within output appended since the wait began. */
  offset: number;
}

export interface WaitResult {
  sessionId: string;
  targetState: PtyState | null;
  state: PtyState | null;
  outcome: WaitOutcome;
  observedAt: string;
  /** Present only when outcome === "match". */
  match?: WaitMatch;
}

export interface WaitOptions {
  terminalId: string;
  /** Optional when match/staleAfterMs is given; whichever condition resolves first wins. */
  targetState?: PtyState;
  stopOn: ReadonlySet<PtyState>;
  /** Internal deadline in milliseconds. The HTTP contract converts seconds. */
  timeoutMs: number;
  abortSignal?: AbortSignal;
  /** Regex tested against NEW scrollback output observed during the wait. */
  match?: RegExp;
  /** Resolve "stale" when no scrollback growth is seen for this many ms, counted from wait start. */
  staleAfterMs?: number;
}

export interface WaitCoordinatorLimits {
  perSession: number;
  global: number;
}

export const DEFAULT_WAIT_LIMITS: WaitCoordinatorLimits = {
  perSession: 4,
  global: 32,
};

export const WAIT_DEFAULT_TIMEOUT_SECONDS = 60;
export const WAIT_MIN_TIMEOUT_SECONDS = 1;
export const WAIT_MAX_TIMEOUT_SECONDS = 300;
export const WAIT_MIN_STALE_SECONDS = 1;
export const WAIT_MAX_STALE_SECONDS = 300;
export const WAIT_MAX_MATCH_PATTERN_CHARS = 512;

/** Bound the per-wait match scan buffer; bytes beyond it are dropped oldest-first. */
const MATCH_TEXT_MAX_CHARS = 512 * 1024;
/** Regex hits may span chunk boundaries; rescan this far back into prior output. */
const MATCH_SCAN_LOOKBACK = 8192;

interface PendingWait {
  terminalId: string;
  targetState: PtyState | undefined;
  stopOn: ReadonlySet<PtyState>;
  timer: NodeJS.Timeout | null;
  staleTimer: NodeJS.Timeout | null;
  staleAfterMs: number | undefined;
  match: RegExp | undefined;
  /** Output appended since wait start (trimmed to MATCH_TEXT_MAX_CHARS). */
  matchText: string;
  /** Absolute offset (in appended output) of matchText[0]. */
  matchBaseOffset: number;
  abortSignal: AbortSignal | undefined;
  onAbort: () => void;
  settle: (outcome: WaitOutcome, state: PtyState | null, match?: WaitMatch) => void;
  settled: boolean;
}

export type PtyStateReader = (terminalId: string) => PtyState | null;

export interface SessionWaitCoordinatorOptions {
  events: AppEventBus;
  readState: PtyStateReader;
  limits?: WaitCoordinatorLimits;
  now?: () => number;
  scheduleTimer?: (cb: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (handle: NodeJS.Timeout) => void;
}

export class SessionWaitCoordinator {
  private readonly events: AppEventBus;
  private readonly readState: PtyStateReader;
  private readonly limits: WaitCoordinatorLimits;
  private readonly now: () => number;
  private readonly scheduleTimer: (cb: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimer: (handle: NodeJS.Timeout) => void;
  private readonly pending = new Map<string, Set<PendingWait>>();
  private readonly onStateChanged: (change: PtyStateChanged) => void;
  private readonly onTerminalExit: (payload: { terminalId: string; projectId: string; exitCode: number }) => void;
  private readonly onTerminalData: (payload: {
    terminalId: string;
    projectId: string;
    data: string;
    replace?: boolean;
    force?: boolean;
    revision: number;
  }) => void;
  private shutdownFlag = false;

  constructor(options: SessionWaitCoordinatorOptions) {
    this.events = options.events;
    this.readState = options.readState;
    this.limits = options.limits ?? DEFAULT_WAIT_LIMITS;
    this.now = options.now ?? (() => Date.now());
    this.scheduleTimer = options.scheduleTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));

    this.onStateChanged = (change) => {
      const waits = this.pending.get(change.terminalId);
      if (!waits) return;
      for (const wait of [...waits]) {
        if (change.state === wait.targetState) {
          wait.settle("matched", change.state);
        } else if (wait.stopOn.has(change.state)) {
          wait.settle("interrupted", change.state);
        }
      }
    };
    this.onTerminalExit = (payload) => {
      const waits = this.pending.get(payload.terminalId);
      if (!waits) return;
      for (const wait of [...waits]) wait.settle("closed", null);
    };
    // Scrollback growth: re-arm stale timers and scan for content matches.
    this.onTerminalData = (payload) => {
      const waits = this.pending.get(payload.terminalId);
      if (!waits) return;
      for (const wait of [...waits]) {
        if (wait.settled) continue;
        if (wait.staleAfterMs !== undefined) this.armStaleTimer(wait);
        if (wait.match) this.scanForMatch(wait, payload.data, payload.replace === true);
      }
    };

    this.events.on("ptyStateChanged", this.onStateChanged);
    this.events.on("terminalExit", this.onTerminalExit);
    this.events.on("terminalData", this.onTerminalData);
  }

  isShutdown(): boolean {
    return this.shutdownFlag;
  }

  hasSession(terminalId: string): boolean {
    return this.readState(terminalId) !== null;
  }

  pendingFor(terminalId: string): number {
    return this.pending.get(terminalId)?.size ?? 0;
  }

  pendingTotal(): number {
    let total = 0;
    for (const waits of this.pending.values()) total += waits.size;
    return total;
  }

  wouldExceedLimits(terminalId: string): boolean {
    return this.pendingFor(terminalId) >= this.limits.perSession
      || this.pendingTotal() >= this.limits.global;
  }

  /**
   * Register synchronously, then re-read state. The coordinator listeners are
   * already installed by the constructor, and the post-registration snapshot
   * closes the read/register boundary without polling.
   */
  waitFor(options: WaitOptions): Promise<WaitResult> {
    const { terminalId, targetState, stopOn } = options;
    const timeoutMs = Math.max(1, options.timeoutMs);
    // Force a global flag so exec() honors lastIndex and re-scans from the
    // appended region instead of the buffer head on every chunk.
    const matchRegex = options.match
      ? new RegExp(
          options.match.source,
          options.match.flags.includes("g") ? options.match.flags : `${options.match.flags}g`,
        )
      : null;

    return new Promise<WaitResult>((resolve) => {
      const finishImmediately = (outcome: WaitOutcome, state: PtyState | null): void => {
        resolve(this.result(terminalId, targetState ?? null, outcome, state));
      };

      if (this.shutdownFlag) {
        finishImmediately("shutdown", this.readState(terminalId));
        return;
      }

      const current = this.readState(terminalId);
      if (current === null) {
        finishImmediately("closed", null);
        return;
      }
      if (targetState !== undefined && current === targetState) {
        finishImmediately("matched", current);
        return;
      }
      if (stopOn.has(current)) {
        finishImmediately("interrupted", current);
        return;
      }

      const wait: PendingWait = {
        terminalId,
        targetState,
        stopOn,
        timer: null,
        staleTimer: null,
        staleAfterMs: options.staleAfterMs,
        match: matchRegex ?? undefined,
        matchText: "",
        matchBaseOffset: 0,
        abortSignal: options.abortSignal,
        onAbort: () => undefined,
        settle: () => undefined,
        settled: false,
      };

      wait.settle = (outcome, state, match) => {
        if (wait.settled) return;
        wait.settled = true;
        if (wait.timer !== null) {
          this.clearTimer(wait.timer);
          wait.timer = null;
        }
        if (wait.staleTimer !== null) {
          this.clearTimer(wait.staleTimer);
          wait.staleTimer = null;
        }
        if (wait.abortSignal) {
          wait.abortSignal.removeEventListener("abort", wait.onAbort);
        }
        const waits = this.pending.get(terminalId);
        if (waits) {
          waits.delete(wait);
          if (waits.size === 0) this.pending.delete(terminalId);
        }
        logger.debug("web", "agent.session.wait.resolved", "Session wait resolved", {
          terminalId,
          outcome,
          state,
        });
        resolve(this.result(terminalId, targetState ?? null, outcome, state, match));
      };
      wait.onAbort = () => wait.settle("interrupted", this.readState(terminalId));

      let waits = this.pending.get(terminalId);
      if (!waits) {
        waits = new Set();
        this.pending.set(terminalId, waits);
      }
      waits.add(wait);

      if (wait.abortSignal) {
        wait.abortSignal.addEventListener("abort", wait.onAbort, { once: true });
        if (wait.abortSignal.aborted) {
          wait.onAbort();
          return;
        }
      }

      // Lost-wakeup guard: a transition between the first read and pending-map
      // registration is visible here, even if its event saw no pending wait.
      const recheck = this.readState(terminalId);
      if (recheck === null) {
        wait.settle("closed", null);
        return;
      }
      if (targetState !== undefined && recheck === targetState) {
        wait.settle("matched", recheck);
        return;
      }
      if (stopOn.has(recheck)) {
        wait.settle("interrupted", recheck);
        return;
      }

      wait.timer = this.scheduleTimer(
        () => wait.settle("timeout", this.readState(terminalId)),
        timeoutMs,
      );
      // Staleness counts from wait start (issue #61 scenario: a terminal that
      // has been quiet for hours resolves "stale" staleAfterSec after the
      // request arrives, not instantly).
      if (wait.staleAfterMs !== undefined) this.armStaleTimer(wait);
    });
  }

  private armStaleTimer(wait: PendingWait): void {
    if (wait.staleAfterMs === undefined) return;
    if (wait.staleTimer !== null) this.clearTimer(wait.staleTimer);
    wait.staleTimer = this.scheduleTimer(
      () => wait.settle("stale", this.readState(wait.terminalId)),
      wait.staleAfterMs,
    );
  }

  private scanForMatch(wait: PendingWait, data: string, replace: boolean): void {
    const regex = wait.match;
    if (!regex) return;
    if (replace) {
      // A replace event rebuilds the buffer; earlier appended output is gone.
      wait.matchText = "";
      wait.matchBaseOffset = 0;
    }
    wait.matchText += data;
    if (wait.matchText.length > MATCH_TEXT_MAX_CHARS) {
      const drop = wait.matchText.length - MATCH_TEXT_MAX_CHARS;
      wait.matchText = wait.matchText.slice(drop);
      wait.matchBaseOffset += drop;
    }
    const scanFrom = Math.max(0, wait.matchText.length - data.length - MATCH_SCAN_LOOKBACK);
    regex.lastIndex = scanFrom;
    const hit = regex.exec(wait.matchText);
    if (!hit) return;
    const lineStart = wait.matchText.lastIndexOf("\n", hit.index - 1) + 1;
    let lineEnd = wait.matchText.indexOf("\n", hit.index);
    if (lineEnd === -1) lineEnd = wait.matchText.length;
    const line = wait.matchText.slice(lineStart, lineEnd).replace(/\r$/, "");
    wait.settle("match", this.readState(wait.terminalId), {
      line,
      offset: wait.matchBaseOffset + hit.index,
    });
  }

  shutdown(): void {
    if (this.shutdownFlag) return;
    this.shutdownFlag = true;
    this.events.off("ptyStateChanged", this.onStateChanged);
    this.events.off("terminalExit", this.onTerminalExit);
    this.events.off("terminalData", this.onTerminalData);
    const waits = [...this.pending.values()].flatMap((set) => [...set]);
    for (const wait of waits) {
      wait.settle("shutdown", this.readState(wait.terminalId));
    }
  }

  private result(
    sessionId: string,
    targetState: PtyState | null,
    outcome: WaitOutcome,
    state: PtyState | null,
    match?: WaitMatch,
  ): WaitResult {
    return {
      sessionId,
      targetState,
      state,
      outcome,
      observedAt: new Date(this.now()).toISOString(),
      ...(match ? { match } : {}),
    };
  }
}
