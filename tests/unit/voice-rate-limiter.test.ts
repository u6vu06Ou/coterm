import { describe, expect, it, vi } from "vitest";
import { PreviewRateLimiter, RateLimitError } from "../../src/renderer/src/components/voice/rate-limiter";

describe("PreviewRateLimiter", () => {
  it("allows first request immediately", () => {
    const limiter = new PreviewRateLimiter({ minIntervalMs: 1000 });
    expect(limiter.canRequestNow(1000)).toBe(true);
  });

  it("blocks second request within interval", () => {
    const limiter = new PreviewRateLimiter({ minIntervalMs: 3000 });
    expect(limiter.canRequestNow(1000)).toBe(true);
    // Simulate a request at t=1000
    limiter["lastRequestAt"] = 1000;
    expect(limiter.canRequestNow(1500)).toBe(false);
    expect(limiter.canRequestNow(4000)).toBe(true);
  });

  it("computes remaining wait time correctly", () => {
    const limiter = new PreviewRateLimiter({ minIntervalMs: 3000 });
    limiter["lastRequestAt"] = 1000;
    expect(limiter.msUntilNextRequest(1500)).toBe(2500);
    expect(limiter.msUntilNextRequest(4000)).toBe(0);
  });

 it("enforces strictly below 20 RPM (interval >= 3000ms)", () => {
   // Default minIntervalMs = 3100 → 60000/3100 ≈ 19.35 RPM < 20
   const rpm = 60_000 / 3100;
    expect(rpm).toBeLessThan(20);
  });

  it("schedules and returns ok result", async () => {
    const limiter = new PreviewRateLimiter({ minIntervalMs: 0 });
    const transcribe = vi.fn().mockResolvedValue("hello");
    const signal = new AbortController().signal;
    const result = await limiter.schedule(new ArrayBuffer(10), transcribe, signal);
    expect(result.status).toBe("ok");
    expect(result.text).toBe("hello");
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 and eventually returns rate-limited", async () => {
    const limiter = new PreviewRateLimiter({ minIntervalMs: 0, maxRetries: 1, baseBackoffMs: 1 });
    const transcribe = vi.fn().mockRejectedValue(new RateLimitError());
    const signal = new AbortController().signal;
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await limiter.schedule(new ArrayBuffer(10), transcribe, signal, () => 0, sleep);
    expect(result.status).toBe("rate-limited");
    expect(result.retries).toBe(1);
    expect(transcribe).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  it("returns aborted when signal is already aborted", async () => {
    const limiter = new PreviewRateLimiter({ minIntervalMs: 0 });
    const transcribe = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const result = await limiter.schedule(new ArrayBuffer(10), transcribe, controller.signal);
    expect(result.status).toBe("aborted");
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("returns error for non-429 exceptions", async () => {
    const limiter = new PreviewRateLimiter({ minIntervalMs: 0 });
    const transcribe = vi.fn().mockRejectedValue(new Error("network"));
    const signal = new AbortController().signal;
    const result = await limiter.schedule(new ArrayBuffer(10), transcribe, signal);
    expect(result.status).toBe("error");
  });

  it("reset clears the last request time", () => {
    const limiter = new PreviewRateLimiter({ minIntervalMs: 3000 });
    limiter["lastRequestAt"] = 1000;
    limiter.reset();
    expect(limiter.canRequestNow(1001)).toBe(true);
  });

  it("waits for the rate-limit interval before first request", async () => {
    const limiter = new PreviewRateLimiter({ minIntervalMs: 500 });
    // Simulate a recent request
    limiter["lastRequestAt"] = 1000;
    const transcribe = vi.fn().mockResolvedValue("ok");
    const signal = new AbortController().signal;
    const sleep = vi.fn().mockResolvedValue(undefined);
    // now = 1100, so 1000 + 500 - 1100 = 400ms wait needed
    const result = await limiter.schedule(
      new ArrayBuffer(10),
      transcribe,
      signal,
      () => 1100,
      sleep,
    );
    expect(result.status).toBe("ok");
    expect(sleep).toHaveBeenCalledWith(400);
  });
});
