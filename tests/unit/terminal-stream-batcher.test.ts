import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTerminalStreamBatcher } from "../../src/renderer/src/components/terminal-stream-batcher";

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
});
