import { describe, expect, it } from "vitest";
import { computeAgentBrowserWindowPlacement } from "../../src/main/browser/window-placement";
import type { PlacementDisplay, PlacementRect } from "../../src/main/browser/window-placement";

function rect(x: number, y: number, width: number, height: number): PlacementRect {
  return { x, y, width, height };
}

function display(id: number, workArea: PlacementRect): PlacementDisplay {
  return { id, workArea };
}

// Two 1920×1080 displays side by side at DPI 1. Primary at (0,0), secondary at
// (1920,0). workArea excludes a 48px taskbar at the bottom.
const PRIMARY = rect(0, 0, 1920, 1032);
const SECONDARY = rect(1920, 0, 1920, 1032);

describe("computeAgentBrowserWindowPlacement", () => {
  it("two displays, main window on the left → full second display", () => {
    const result = computeAgentBrowserWindowPlacement(
      [display(1, PRIMARY), display(2, SECONDARY)],
      rect(100, 100, 1200, 800), // center (700, 500) → inside PRIMARY
    );
    expect(result).toEqual({ x: 1920, y: 0, width: 1920, height: 1032 });
  });

  it("two displays, main window on the right → full first (left) display", () => {
    const result = computeAgentBrowserWindowPlacement(
      [display(1, PRIMARY), display(2, SECONDARY)],
      rect(2000, 100, 1200, 800), // center (2600, 500) → inside SECONDARY
    );
    expect(result).toEqual({ x: 0, y: 0, width: 1920, height: 1032 });
  });

  it("two displays: fills the workArea (taskbar excluded), never kiosk-fullscreen", () => {
    const result = computeAgentBrowserWindowPlacement(
      [display(1, PRIMARY), display(2, SECONDARY)],
      rect(100, 100, 1200, 800),
    );
    expect(result?.height).toBe(1032); // 1080 - 48 taskbar, not the full 1080
    expect(result?.y).toBe(0);
  });

  it("three displays, main on the middle → largest of the other two", () => {
    const left = rect(0, 0, 2560, 1400);
    const middle = rect(2560, 0, 1920, 1032);
    const right = rect(4480, 0, 1920, 1032);
    const result = computeAgentBrowserWindowPlacement(
      [display(1, left), display(2, middle), display(3, right)],
      rect(2600, 200, 1200, 800), // center (3200, 600) → inside middle
    );
    expect(result).toEqual({ x: 0, y: 0, width: 2560, height: 1400 }); // left is larger than right
  });

  it("two equally sized candidates → the rightmost display wins the tie", () => {
    const d1 = rect(0, 0, 1920, 1032);
    const d2 = rect(1920, 0, 1920, 1032);
    const d3 = rect(3840, 0, 3840, 2160); // holds the main window
    const result = computeAgentBrowserWindowPlacement(
      [display(1, d1), display(2, d2), display(3, d3)],
      rect(4000, 200, 1200, 800),
    );
    expect(result).toEqual({ x: 1920, y: 0, width: 1920, height: 1032 }); // d2, not d1
  });

  it("single display → ~55% × 80%, right edge, vertically centered", () => {
    const result = computeAgentBrowserWindowPlacement([display(1, PRIMARY)], rect(100, 100, 1200, 800));
    expect(result).toEqual({
      x: 1920 - Math.round(1920 * 0.55),
      y: Math.round((1032 - Math.round(1032 * 0.8)) / 2),
      width: Math.round(1920 * 0.55),
      height: Math.round(1032 * 0.8),
    });
    // Windowed, never fullscreen.
    expect(result!.width).toBeLessThan(PRIMARY.width);
    expect(result!.height).toBeLessThan(PRIMARY.height);
  });

  it("single display with empty main bounds → still windowed, not fullscreen", () => {
    const result = computeAgentBrowserWindowPlacement([display(1, PRIMARY)], null);
    expect(result?.width).toBe(Math.round(1920 * 0.55));
    expect(result?.height).toBe(Math.round(1032 * 0.8));
  });

  it("no displays → null", () => {
    expect(computeAgentBrowserWindowPlacement([], rect(0, 0, 800, 600))).toBeNull();
    expect(computeAgentBrowserWindowPlacement([], null)).toBeNull();
  });

  it("main window bounds null with two displays → conservative window on the largest display", () => {
    const small = rect(0, 0, 1280, 1000);
    const large = rect(1280, 0, 2560, 1400);
    const result = computeAgentBrowserWindowPlacement([display(1, small), display(2, large)], null);
    // Cannot locate "the other screen" → don't confidently cover one: windowed
    // size, right edge of the largest display's workArea.
    expect(result?.width).toBe(Math.round(2560 * 0.55));
    expect(result?.height).toBe(Math.round(1400 * 0.8));
    expect(result?.x).toBe(1280 + 2560 - Math.round(2560 * 0.55));
  });

  it("mixed DPI and negative coordinates: main on the laptop, browser on the external", () => {
    // 4K external at 200% scale placed left of and above a 1080p laptop at 100%.
    const laptop = rect(0, 1000, 1920, 1032); // 100% scale
    const external = rect(-3840, -1168, 3840, 2168); // 200% scale, taskbar excluded
    const result = computeAgentBrowserWindowPlacement(
      [display(1, laptop), display(2, external)],
      rect(200, 1200, 1400, 900), // center (900, 1650) → inside laptop
    );
    expect(result).toEqual({ x: -3840, y: -1168, width: 3840, height: 2168 });
  });

  it("main window center exactly on a shared workArea edge belongs to the right display", () => {
    // contains() is half-open: a center at x=1920 belongs to the display at x>=1920.
    const result = computeAgentBrowserWindowPlacement(
      [display(1, PRIMARY), display(2, SECONDARY)],
      rect(700, 100, 2440, 800), // center x = 700 + 1220 = 1920
    );
    // 1920 is the start of SECONDARY → SECONDARY holds the main window → place on PRIMARY.
    expect(result).toEqual({ x: 0, y: 0, width: 1920, height: 1032 });
  });
});
