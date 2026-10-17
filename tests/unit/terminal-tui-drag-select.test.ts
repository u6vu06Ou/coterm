import { describe, expect, it } from "vitest";
import { cellFromPoint, selectionSpan, shouldInterceptTuiMouseDown } from "../../src/renderer/src/components/terminal-tui-drag-select";

describe("TUI drag select geometry", () => {
  it("maps a point to a buffer cell, clamped to the grid", () => {
    const rect = { left: 100, top: 50, width: 800, height: 400 };
    expect(cellFromPoint(100, 50, rect, 80, 20, 0)).toEqual({ col: 0, row: 0 });
    expect(cellFromPoint(115, 75, rect, 80, 20, 10)).toEqual({ col: 1, row: 11 });
    expect(cellFromPoint(5000, 5000, rect, 80, 20, 0)).toEqual({ col: 79, row: 19 });
  });

  it("builds a select() span in either drag direction", () => {
    expect(selectionSpan({ col: 5, row: 1 }, { col: 2, row: 2 }, 80)).toEqual({ col: 5, row: 1, length: 78 });
    expect(selectionSpan({ col: 2, row: 2 }, { col: 5, row: 1 }, 80)).toEqual({ col: 5, row: 1, length: 78 });
    expect(selectionSpan({ col: 3, row: 0 }, { col: 3, row: 0 }, 80)).toEqual({ col: 3, row: 0, length: 1 });
  });
});

describe("shouldInterceptTuiMouseDown", () => {
  const base = { button: 0, hasModifier: false, mouseTracking: true, overLink: false };

  it("intercepts a plain left click inside a mouse-tracking TUI", () => {
    expect(shouldInterceptTuiMouseDown(base)).toBe(true);
  });

  it("passes through when the click is on a link (xterm-cursor-pointer)", () => {
    // v1.5.57 regression: swallowing the down/up pair kept xterm's Linkifier
    // from ever calling activate(), so clicking a file path in Claude Code /
    // Codex did nothing (no artifact panel).
    expect(shouldInterceptTuiMouseDown({ ...base, overLink: true })).toBe(false);
  });

  it("does nothing when the app is not tracking the mouse", () => {
    expect(shouldInterceptTuiMouseDown({ ...base, mouseTracking: false, overLink: false })).toBe(false);
    expect(shouldInterceptTuiMouseDown({ ...base, mouseTracking: false, overLink: true })).toBe(false);
  });

  it("ignores non-left buttons and modified clicks", () => {
    expect(shouldInterceptTuiMouseDown({ ...base, button: 2 })).toBe(false);
    expect(shouldInterceptTuiMouseDown({ ...base, hasModifier: true })).toBe(false);
  });
});
