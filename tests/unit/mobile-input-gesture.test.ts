import { describe, expect, it } from "vitest";
import { classifyMobileTerminalGesture } from "../../src/renderer/src/components/mobile/mobile-input-gesture";

const base = { start: { x: 10, y: 700 }, end: { x: 10, y: 700 }, durationMs: 80, pointerCount: 1, startedInInputZone: true, selectionActive: false };

describe("classifyMobileTerminalGesture", () => {
  it("opens only for a short bottom tap", () => expect(classifyMobileTerminalGesture(base)).toBe("open-composer"));
  it("preserves vertical and horizontal movement", () => {
    expect(classifyMobileTerminalGesture({ ...base, end: { x: 10, y: 650 } })).toBe("scroll");
    expect(classifyMobileTerminalGesture({ ...base, end: { x: 80, y: 700 } })).toBe("pan");
  });
  it("rejects pinch, long press, and active selection", () => {
    expect(classifyMobileTerminalGesture({ ...base, pointerCount: 2 })).toBe("pinch");
    expect(classifyMobileTerminalGesture({ ...base, durationMs: 500 })).toBe("long-press");
    expect(classifyMobileTerminalGesture({ ...base, selectionActive: true })).toBe("noop");
  });
});
