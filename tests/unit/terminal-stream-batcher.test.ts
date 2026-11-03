import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTerminalStreamBatcher, MAX_PENDING_CHARS } from "../../src/renderer/src/components/terminal-stream-batcher";

describe("remote terminal stream batching", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("writes a fragmented terminal redraw once after the quiet period", () => {
    const write = vi.fn();
    const batcher = createTerminalStreamBatcher(write);
    batcher.push("\u001b[2J");
    batcher.push("complete frame");
    vi.advanceTimersByTime(47);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenCalledExactlyOnceWith("\u001b[2Jcomplete frame");
  });

  it("flushes the final pending redraw exactly once", () => {
    const write = vi.fn();
    const batcher = createTerminalStreamBatcher(write);
    batcher.push("final frame");
    batcher.flush();
    expect(write).toHaveBeenCalledExactlyOnceWith("final frame");
    vi.advanceTimersByTime(48);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("drops queued output when disposed", () => {
    const write = vi.fn();
    const batcher = createTerminalStreamBatcher(write);
    batcher.push("stale redraw");
    batcher.dispose();
    vi.advanceTimersByTime(48);
    expect(write).not.toHaveBeenCalled();
  });

  it("flushes immediately at the char cap so a never-quiet stream stays bounded (long-conversation stutter)", () => {
    const write = vi.fn();
    const batcher = createTerminalStreamBatcher(write);
    const chunk = "x".repeat(64 * 1024);
    // 5 chunks exceed the 256K-char cap without any quiet window: the cap flush
    // must fire synchronously, and after it the quiet timer restarts fresh.
    for (let i = 0; i < 5; i += 1) batcher.push(chunk);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0].length).toBeGreaterThanOrEqual(MAX_PENDING_CHARS);
    // Leftover tail (5*64K - 256K = 64K) still follows the quiet window.
    vi.advanceTimersByTime(48);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]![0].length).toBe(5 * 64 * 1024 - MAX_PENDING_CHARS);
  });

  it("dispose after a cap flush still drops everything", () => {
    const write = vi.fn();
    const batcher = createTerminalStreamBatcher(write);
    batcher.push("x".repeat(MAX_PENDING_CHARS)); // immediate flush
    batcher.push("tail");
    batcher.dispose();
    vi.advanceTimersByTime(1000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("flushes within the latency deadline under a never-quiet trickle (spinner every 20ms)", () => {
    const write = vi.fn();
    const batcher = createTerminalStreamBatcher(write);
    batcher.push("s"); // t=0: deadline armed for t=120, quiet window kept short
    for (let t = 20; t <= 100; t += 20) {
      vi.advanceTimersByTime(20);
      expect(write).not.toHaveBeenCalled(); // quiet window keeps being re-armed
      batcher.push("s");
    }
    vi.advanceTimersByTime(20); // t=120: hard deadline fires despite the trickle
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0]).toBe("s".repeat(6));
    // A fresh batch restarts both clocks from its own first chunk.
    batcher.push("a");
    vi.advanceTimersByTime(48); // quiet window alone flushes it now
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]![0]).toBe("a");
  });
});
