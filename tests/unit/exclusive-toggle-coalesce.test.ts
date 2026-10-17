// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExclusiveToggleCoalescer } from "../../src/renderer/src/store/exclusive-toggle-coalesce";

describe("createExclusiveToggleCoalescer (issue #15 defensive debounce)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies the first request immediately (leading edge)", () => {
    const applied: Array<string | null> = [];
    const coalescer = createExclusiveToggleCoalescer({ apply: (t) => applied.push(t) });
    coalescer.request("t1");
    expect(applied).toEqual(["t1"]);
    coalescer.dispose();
  });

  it("collapses a rapid toggle burst into the final target only", () => {
    const applied: Array<string | null> = [];
    const coalesced: Array<{ coalescedCount: number; finalTarget: string | null }> = [];
    const coalescer = createExclusiveToggleCoalescer({
      apply: (t) => applied.push(t),
      onCoalesced: (info) => coalesced.push(info),
    });
    // 展開→單一(1)→展開→單一(2) all inside the window: only the leading t1 and
    // the trailing final target survive; the middle remounts never happen.
    coalescer.request("t1");
    coalescer.request(null);
    coalescer.request("t2");
    coalescer.request(null);
    expect(applied).toEqual(["t1"]);
    vi.advanceTimersByTime(300);
    expect(applied).toEqual(["t1", null]);
    expect(coalesced).toEqual([{ coalescedCount: 2, finalTarget: null }]);
    coalescer.dispose();
  });

  it("skips the trailing apply when the burst nets back to the current state", () => {
    const applied: Array<string | null> = [];
    const coalescer = createExclusiveToggleCoalescer({ apply: (t) => applied.push(t) });
    coalescer.request("t1"); // leading: enters exclusive t1
    coalescer.request(null); // user taps 展開
    coalescer.request("t1"); // then back to 單一 within the window — net no-op
    vi.advanceTimersByTime(300);
    expect(applied).toEqual(["t1"]);
    coalescer.dispose();
  });

  it("applies requests outside the window immediately again", () => {
    const applied: Array<string | null> = [];
    const coalescer = createExclusiveToggleCoalescer({ apply: (t) => applied.push(t) });
    coalescer.request("t1");
    vi.advanceTimersByTime(300);
    coalescer.request(null);
    expect(applied).toEqual(["t1", null]);
    coalescer.dispose();
  });

  it("flush fires the pending trailing request immediately", () => {
    const applied: Array<string | null> = [];
    const coalescer = createExclusiveToggleCoalescer({ apply: (t) => applied.push(t) });
    coalescer.request("t1");
    coalescer.request("t2");
    coalescer.flush();
    expect(applied).toEqual(["t1", "t2"]);
    // The timer must not fire a second apply afterwards.
    vi.advanceTimersByTime(500);
    expect(applied).toEqual(["t1", "t2"]);
    coalescer.dispose();
  });

  it("dispose drops the pending trailing request", () => {
    const applied: Array<string | null> = [];
    const coalescer = createExclusiveToggleCoalescer({ apply: (t) => applied.push(t) });
    coalescer.request("t1");
    coalescer.request("t2");
    coalescer.dispose();
    vi.advanceTimersByTime(500);
    expect(applied).toEqual(["t1"]);
  });
});
