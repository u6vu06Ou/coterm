/**
 * Central rate limiter for streaming dictation preview uploads.
 *
 * Strictly below 20 RPM (one request every ≥3.1 seconds).  Handles 429
 * backoff and AbortSignal cancellation.  Pure logic — no fetch, no DOM;
 * the coordinator injects the actual transcription call.
 */

export interface RateLimitOptions {
  /** Minimum interval between requests in ms.  Default 3_100 → ~19.3 RPM. */
  minIntervalMs?: number;
  /** Max retries on 429. Preview sessions default to zero: pause immediately. */
  maxRetries?: number;
  /** Base backoff for 429 in ms. */
  baseBackoffMs?: number;
}

export type RateLimitStatus = "ok" | "rate-limited" | "aborted" | "error";

export interface RateLimitResult {
  status: RateLimitStatus;
  text: string;
  /** Milliseconds waited before the request fired (for diagnostics). */
  waitedMs: number;
  retries: number;
}

export type TranscribeFn = (audio: ArrayBuffer, signal: AbortSignal) => Promise<string>;

/**
 * Sliding-window rate limiter with 429 exponential backoff.
 *
 * The coordinator calls `schedule()` with a preview WAV; the limiter waits
 * until the minimum interval has elapsed since the last accepted request,
 * then invokes `transcribe`.  On 429 it backs off and retries up to
 * `maxRetries` before returning `rate-limited`.
 */
export class PreviewRateLimiter {
  private lastRequestAt = Number.NEGATIVE_INFINITY;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;

  constructor(opts: RateLimitOptions = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? 3_100;
    this.maxRetries = opts.maxRetries ?? 0;
    this.baseBackoffMs = opts.baseBackoffMs ?? 2_000;
  }

  /** True if at least `minIntervalMs` has passed since the last accepted request. */
  canRequestNow(now = Date.now()): boolean {
    return now - this.lastRequestAt >= this.minIntervalMs;
  }

  /** Remaining ms until the next request is allowed. */
  msUntilNextRequest(now = Date.now()): number {
    return Math.max(0, this.lastRequestAt + this.minIntervalMs - now);
  }

  /**
   * Schedule a preview transcription.  Waits for the rate-limit window,
   * then calls `transcribe(audio, signal)`.  On HTTP 429 (signalled by the
   * transcribe fn throwing `RateLimitError`), backs off and retries.
   */
  async schedule(
    audio: ArrayBuffer,
    transcribe: TranscribeFn,
    signal: AbortSignal,
    now = Date.now,
    sleep: (ms: number) => Promise<void> = defaultSleep,
  ): Promise<RateLimitResult> {
    let retries = 0;
    let waitedMs = 0;

    // Initial rate-limit wait
    const initialWait = this.msUntilNextRequest(now());
    if (initialWait > 0) {
      await sleep(initialWait);
      waitedMs += initialWait;
    }
    if (signal.aborted) return { status: "aborted", text: "", waitedMs, retries: 0 };

    while (true) {
      this.lastRequestAt = now();
      try {
        const text = await transcribe(audio, signal);
        return { status: "ok", text, waitedMs, retries };
      } catch (error) {
        if (signal.aborted) return { status: "aborted", text: "", waitedMs, retries };
        if (error instanceof RateLimitError && retries < this.maxRetries) {
          retries++;
          const backoff = this.baseBackoffMs * Math.pow(2, retries - 1);
          await sleep(backoff);
          waitedMs += backoff;
          if (signal.aborted) return { status: "aborted", text: "", waitedMs, retries };
          continue;
        }
        if (error instanceof RateLimitError) {
          return { status: "rate-limited", text: "", waitedMs, retries };
        }
        return { status: "error", text: "", waitedMs, retries };
      }
    }
  }

  /** Reset internal state (e.g. when a new session starts). */
  reset(): void {
    this.lastRequestAt = Number.NEGATIVE_INFINITY;
  }
}

/** Thrown by the transcribe fn when the server returns 429. */
export class RateLimitError extends Error {
  constructor(message = "Rate limited (429)") {
    super(message);
    this.name = "RateLimitError";
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
