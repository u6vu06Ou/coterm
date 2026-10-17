import { describe, expect, it } from "vitest";
import {
  activeTurnTick,
  layoutTurnTicks,
  ticksEqual,
  TURN_RAIL_MIN_GAP,
} from "../../src/renderer/src/components/terminal-reader/terminal-reader-turns";

describe("layoutTurnTicks", () => {
  it("returns empty for no entries or no scroll range", () => {
    expect(layoutTurnTicks([], 1000, 400)).toEqual([]);
    expect(layoutTurnTicks([{ index: 0, offset: 0 }], 400, 400)).toEqual([]);
    expect(layoutTurnTicks([{ index: 0, offset: 0 }], 300, 400)).toEqual([]);
  });

  it("places a single turn proportionally", () => {
    const ticks = layoutTurnTicks([{ index: 0, offset: 300 }], 1400, 400);
    // maxScroll = 1000
    expect(ticks).toEqual([{ firstIndex: 0, lastIndex: 0, pos: 0.3 }]);
  });

  it("places multiple turns at their proportional offsets", () => {
    const ticks = layoutTurnTicks(
      [
        { index: 0, offset: 0 },
        { index: 2, offset: 500 },
        { index: 5, offset: 1000 },
      ],
      1400,
      400,
    );
    expect(ticks).toEqual([
      { firstIndex: 0, lastIndex: 0, pos: 0 },
      { firstIndex: 2, lastIndex: 2, pos: 0.5 },
      { firstIndex: 5, lastIndex: 5, pos: 1 },
    ]);
  });

  it("clamps offsets beyond the scroll range", () => {
    const ticks = layoutTurnTicks(
      [
        { index: 0, offset: -50 },
        { index: 1, offset: 99999 },
      ],
      1400,
      400,
    );
    expect(ticks).toEqual([
      { firstIndex: 0, lastIndex: 0, pos: 0 },
      { firstIndex: 1, lastIndex: 1, pos: 1 },
    ]);
  });

  it("skips malformed entries", () => {
    const ticks = layoutTurnTicks(
      [
        { index: -1, offset: 100 },
        { index: 0, offset: Number.NaN },
        { index: 1, offset: 200 },
      ],
      1400,
      400,
    );
    expect(ticks).toEqual([{ firstIndex: 1, lastIndex: 1, pos: 0.2 }]);
  });

  it("merges ticks closer than the minimum gap", () => {
    // maxScroll = 1000, minGap default 0.02 → 20px in rail space.
    const ticks = layoutTurnTicks(
      [
        { index: 0, offset: 100 }, // pos 0.10
        { index: 1, offset: 110 }, // pos 0.11 → within gap of 0.10, clusters
        { index: 2, offset: 105 }, // pos 0.105 → still within gap, same cluster
        { index: 3, offset: 400 }, // pos 0.40 → separate tick
      ],
      1400,
      400,
    );
    expect(ticks).toEqual([
      { firstIndex: 0, lastIndex: 2, pos: 0.1 },
      { firstIndex: 3, lastIndex: 3, pos: 0.4 },
    ]);
  });

  it("clusters relative to the merged tick's position, not the previous entry", () => {
    // After clustering, the comparison anchor stays at the cluster's first pos.
    const ticks = layoutTurnTicks(
      [
        { index: 0, offset: 0 }, // pos 0
        { index: 1, offset: 25 }, // pos 0.025 → gap 0.025 >= 0.02, new tick
      ],
      1400,
      400,
    );
    expect(ticks).toEqual([
      { firstIndex: 0, lastIndex: 0, pos: 0 },
      { firstIndex: 1, lastIndex: 1, pos: 0.025 },
    ]);
  });

  it("honors a caller-supplied min gap", () => {
    const ticks = layoutTurnTicks(
      [
        { index: 0, offset: 0 },
        { index: 1, offset: 100 },
      ],
      1400,
      400,
      0.2,
    );
    expect(ticks).toEqual([{ firstIndex: 0, lastIndex: 1, pos: 0 }]);
  });

  it("exposes the default min gap constant", () => {
    expect(TURN_RAIL_MIN_GAP).toBeGreaterThan(0);
    expect(TURN_RAIL_MIN_GAP).toBeLessThan(0.1);
  });
});

describe("activeTurnTick", () => {
  const ticks = layoutTurnTicks(
    [
      { index: 0, offset: 0 },
      { index: 1, offset: 500 },
      { index: 2, offset: 1000 },
    ],
    1400,
    400,
  );
  // [pos 0, pos 0.5, pos 1]

  it("returns -1 when there is nothing to highlight", () => {
    expect(activeTurnTick([], 100, 1400, 400)).toBe(-1);
    expect(activeTurnTick(ticks, 0, 400, 400)).toBe(-1);
  });

  it("selects the last tick at or above the scroll fraction", () => {
    expect(activeTurnTick(ticks, 0, 1400, 400)).toBe(0);
    expect(activeTurnTick(ticks, 250, 1400, 400)).toBe(0);
    expect(activeTurnTick(ticks, 500, 1400, 400)).toBe(1);
    expect(activeTurnTick(ticks, 900, 1400, 400)).toBe(1);
    expect(activeTurnTick(ticks, 1000, 1400, 400)).toBe(2);
  });

  it("treats the exact boundary position as reached", () => {
    // scrollTop fraction equals tick pos → that tick is active.
    expect(activeTurnTick(ticks, 499, 1400, 400)).toBe(0);
    expect(activeTurnTick(ticks, 501, 1400, 400)).toBe(1);
  });

  it("always returns a valid index at the top of the list", () => {
    const sparse = layoutTurnTicks([{ index: 0, offset: 800 }], 1400, 400);
    expect(activeTurnTick(sparse, 0, 1400, 400)).toBe(0);
  });
});

describe("ticksEqual", () => {
  it("compares length and values with a small tolerance", () => {
    const a = [{ firstIndex: 0, lastIndex: 0, pos: 0.3 }];
    expect(ticksEqual(a, [{ firstIndex: 0, lastIndex: 0, pos: 0.3 + 0.0005 }])).toBe(true);
    expect(ticksEqual(a, [{ firstIndex: 0, lastIndex: 0, pos: 0.31 }])).toBe(false);
    expect(ticksEqual(a, [{ firstIndex: 0, lastIndex: 1, pos: 0.3 }])).toBe(false);
    expect(ticksEqual(a, [])).toBe(false);
    expect(ticksEqual([], [])).toBe(true);
  });
});
