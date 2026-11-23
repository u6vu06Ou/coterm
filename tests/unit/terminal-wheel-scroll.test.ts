// Linear wheel→row mapper contract (mouse wheel usability fix). Every plain
// wheel event in a PTY pane goes through consumeTerminalWheelDelta, so the
// invariants here are user-visible: sub-row touchpad motion must accumulate
// instead of vanishing, a fast burst must stay proportional, and a direction
// flip must not charge twice.
import { describe, expect, it } from "vitest";
import {
  consumeTerminalWheelDelta,
  DEFAULT_TERMINAL_WHEEL_MULTIPLIER,
  initialTerminalWheelMapperState,
  MAX_SYNTH_WHEEL_EVENTS,
  TERMINAL_WHEEL_IDLE_MS,
  type TerminalWheelMapperState,
} from "../../src/renderer/src/components/terminal-wheel-scroll";

const CELL = 18;
const ROWS = 40;

function step(
  state: TerminalWheelMapperState,
  deltaY: number,
  nowMs: number,
  opts: { deltaMode?: number; multiplier?: number; cellHeightPx?: number; rows?: number } = {},
) {
  return consumeTerminalWheelDelta(
    {
      deltaY,
      deltaMode: opts.deltaMode ?? 0,
      cellHeightPx: opts.cellHeightPx ?? CELL,
      rows: opts.rows ?? ROWS,
      multiplier: opts.multiplier ?? DEFAULT_TERMINAL_WHEEL_MULTIPLIER,
      nowMs,
    },
    state,
  );
}

describe("consumeTerminalWheelDelta", () => {
  it("is a no-op for zero / non-finite deltas and keeps state", () => {
    const start = initialTerminalWheelMapperState();
    expect(step(start, 0, 0).lines).toBe(0);
    expect(step(start, Number.NaN, 0).lines).toBe(0);
    expect(step(start, 0, 0).state).toBe(start);
  });

  it("maps one physical notch (100px, 18px cells) to about three rows", () => {
    const mapped = step(initialTerminalWheelMapperState(), -100, 0);
    expect(mapped.lines).toBe(-3);
  });

  it("guarantees at least one row for an isolated tiny event", () => {
    const mapped = step(initialTerminalWheelMapperState(), -2, 0);
    expect(mapped.lines).toBe(-1);
    // The whole sub-row delta was promoted, no opposite-sign remainder left.
    expect(mapped.state.residualLines).toBe(0);
  });

  it("accumulates sub-row touchpad deltas across a continuous gesture", () => {
    let state = initialTerminalWheelMapperState();
    let lines = 0;
    // 6px per event ≈ 0.2 row at 0.6×; after 15 events ≈ 3 rows.
    for (let i = 0; i < 15; i += 1) {
      const mapped = step(state, -6, 20 + i * 10);
      state = mapped.state;
      lines += mapped.lines;
    }
    expect(lines).toBe(-3);
  });

  it("stays proportional on a fast burst (no acceleration curve)", () => {
    const single = step(initialTerminalWheelMapperState(), -100, 0).lines;
    const burst = step(initialTerminalWheelMapperState(), -1000, 0).lines;
    // only truncation differs: 3 rows vs 33, no per-event acceleration.
    expect(single).toBe(-3);
    expect(burst).toBe(-33);
  });

  it("resets the remainder on a direction change", () => {
    let state = initialTerminalWheelMapperState();
    state = step(state, -6, 0).state; // first row promoted, residual 0
    state = step(state, -6, 10).state;
    // A reversal after the idle gap is a fresh gesture → guaranteed one row.
    const reversed = step(state, 6, 1000);
    expect(reversed.lines).toBe(1);
    expect(reversed.state.residualLines).toBe(0);
  });

  it("scales line-mode notches by the multiplier but not by cell height", () => {
    // deltaMode=1 reports 3 DOM lines per Firefox notch; at 0.6× that is one
    // row per DOM line, so a 3-line notch is 3 rows independent of cell size.
    const mapped = step(initialTerminalWheelMapperState(), -3, 0, { deltaMode: 1 });
    expect(mapped.lines).toBe(-3);
    const taller = step(initialTerminalWheelMapperState(), -3, 0, { deltaMode: 1, cellHeightPx: 40 });
    expect(taller.lines).toBe(-3);
  });

  it("treats page mode as whole viewports", () => {
    const mapped = step(initialTerminalWheelMapperState(), -1, 0, { deltaMode: 2 });
    // one page = rows * cellHeight px → rows * multiplier
    expect(mapped.lines).toBe(-Math.round(ROWS * DEFAULT_TERMINAL_WHEEL_MULTIPLIER));
  });

  it("honours the multiplier and falls back when it is invalid", () => {
    expect(step(initialTerminalWheelMapperState(), -100, 0, { multiplier: 1 }).lines).toBe(-5);
    expect(step(initialTerminalWheelMapperState(), -100, 0, { multiplier: 0 }).lines).toBe(-3);
  });

  it("falls back to a sane cell height and row count", () => {
    const mapped = step(initialTerminalWheelMapperState(), -100, 0, { cellHeightPx: 0, rows: 0 });
    expect(Number.isFinite(mapped.lines)).toBe(true);
    expect(mapped.lines).toBeLessThan(0);
  });

  it("marks the gesture idle after the timeout", () => {
    const first = step(initialTerminalWheelMapperState(), -6, 0);
    const next = step(first.state, -6, TERMINAL_WHEEL_IDLE_MS);
    expect(next.lines).toBe(-1);
  });

  it("exposes a capped synth-event bound and a default in range", () => {
    expect(MAX_SYNTH_WHEEL_EVENTS).toBeGreaterThan(0);
    expect(DEFAULT_TERMINAL_WHEEL_MULTIPLIER).toBeGreaterThanOrEqual(0.1);
    expect(DEFAULT_TERMINAL_WHEEL_MULTIPLIER).toBeLessThanOrEqual(3);
  });

  it("never returns negative zero", () => {
    expect(Object.is(step(initialTerminalWheelMapperState(), -1, 0).lines, -0)).toBe(false);
  });
});
