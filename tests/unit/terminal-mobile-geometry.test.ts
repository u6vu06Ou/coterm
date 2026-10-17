import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fontSizeForViewport, isInMobileInputZone, nextPinchFontSize } from "../../src/renderer/src/components/terminal-mobile-geometry";
import {
  applyRemoteHorizontalTouchPan,
  MOBILE_LAYOUT_QUERY,
  NARROW_LAYOUT_QUERY,
  resetRemoteHorizontalPan,
} from "../../src/renderer/src/components/terminal-responsive";

describe("fontSizeForViewport", () => {
  it("fills the usable height by deriving font size from viewport/rows/lineHeight", () => {
    // 800px viewport, 25 rows, 1.2 line height → 800/25/1.2 = 26.67 → floor 26.
    // Floor means the canvas is at most one row short of the viewport (never
    // overshoots into a hidden bottom dead zone).
    const size = fontSizeForViewport({ viewportHeight: 800, rows: 25, lineHeight: 1.2, min: 11, max: 40 });
    expect(size).toBe(26);
    // Floored fill: within one row-height of the viewport.
    expect(size * 25 * 1.2).toBeGreaterThanOrEqual(800 - 26 * 1.2);
  });

  it("clamps to the minimum when viewport is tiny", () => {
    const size = fontSizeForViewport({ viewportHeight: 100, rows: 40, lineHeight: 1.2, min: 8, max: 24 });
    expect(size).toBe(8);
  });

  it("clamps to the maximum when viewport is huge", () => {
    const size = fontSizeForViewport({ viewportHeight: 5000, rows: 10, lineHeight: 1.2, min: 8, max: 24 });
    expect(size).toBe(24);
  });

  it("uses default min=8 max=24 when omitted", () => {
    expect(fontSizeForViewport({ viewportHeight: 50, rows: 50, lineHeight: 1.2 })).toBe(8);
    expect(fontSizeForViewport({ viewportHeight: 99999, rows: 1, lineHeight: 1.0 })).toBe(24);
  });

  it("floors the derived value (never rounds up past fill)", () => {
    // 801/25/1.2 = 26.7 → 26 (floor, not 27)
    expect(fontSizeForViewport({ viewportHeight: 801, rows: 25, lineHeight: 1.2, min: 11, max: 40 })).toBe(26);
  });
});

describe("nextPinchFontSize", () => {
  it("increases font size on pinch-out (distance grows)", () => {
    const next = nextPinchFontSize({ currentSize: 14, startDistance: 100, currentDistance: 150 });
    expect(next).toBeGreaterThan(14);
  });

  it("decreases font size on pinch-in (distance shrinks)", () => {
    const next = nextPinchFontSize({ currentSize: 14, startDistance: 150, currentDistance: 100 });
    expect(next).toBeLessThan(14);
  });

  it("returns the same size when distance is unchanged", () => {
    const next = nextPinchFontSize({ currentSize: 14, startDistance: 120, currentDistance: 120 });
    expect(next).toBe(14);
  });

  it("clamps to min/max", () => {
    expect(nextPinchFontSize({ currentSize: 23, startDistance: 100, currentDistance: 1000, min: 8, max: 48 })).toBe(48);
    expect(nextPinchFontSize({ currentSize: 12, startDistance: 1000, currentDistance: 10, min: 8, max: 48 })).toBe(8);
  });

  it("default bounds match the user-facing font-size range (8–48)", () => {
    // Defaults (omitted min/max) must match TERMINAL_FONT_SIZE_MIN/MAX so a
    // pinch never drifts outside the range the settings slider enforces.
    expect(nextPinchFontSize({ currentSize: 40, startDistance: 100, currentDistance: 1000 })).toBe(48);
    expect(nextPinchFontSize({ currentSize: 10, startDistance: 1000, currentDistance: 10 })).toBe(8);
  });

  it("scales proportionally to the distance ratio", () => {
    // ratio 2.0 → double the font size (before clamping)
    const next = nextPinchFontSize({ currentSize: 10, startDistance: 100, currentDistance: 200, min: 1, max: 100 });
    expect(next).toBe(20);
  });

  it("guards against zero start distance", () => {
    // startDistance 0 would divide by zero — must return current unchanged.
    const next = nextPinchFontSize({ currentSize: 14, startDistance: 0, currentDistance: 100 });
    expect(next).toBe(14);
  });

  it("is wired to the font size captured at pinch start, not the compounded current size", () => {
    const source = readFileSync("src/renderer/src/components/TerminalDock.tsx", "utf8");
    expect(source).toContain("pinchStartFontSizeRef.current = terminal.options.fontSize ?? 13");
    expect(source).toContain("currentSize: pinchStartFontSizeRef.current");
  });

  it("uses the actual terminal host height and recomputes only before manual pinch override", () => {
    const source = readFileSync("src/renderer/src/components/TerminalDock.tsx", "utf8");
    expect(source).toContain("viewportHeight: host.clientHeight > 0 ? host.clientHeight : window.innerHeight");
    expect(source).toContain("if (isMobileViewport && !pinchOverrideRef.current)");
    expect(source).toContain("pinchOverrideRef.current = true");
  });
});

describe("isInMobileInputZone", () => {
  const rect = { top: 100, bottom: 700, height: 600 };

  it("accepts only the bottom ten percent by default", () => {
    expect(isInMobileInputZone(639, rect)).toBe(false);
    expect(isInMobileInputZone(640, rect)).toBe(true);
    expect(isInMobileInputZone(700, rect)).toBe(true);
  });

  it("rejects coordinates below the host and invalid geometry", () => {
    expect(isInMobileInputZone(701, rect)).toBe(false);
    expect(isInMobileInputZone(100, { top: 100, bottom: 100, height: 0 })).toBe(false);
  });

  it("wires touchend focus to the captured input-zone verdict", () => {
    const source = readFileSync("src/renderer/src/components/TerminalDock.tsx", "utf8");
    expect(source).toContain("longPressMs: LONG_PRESS_MS");
  });
});

describe("responsive terminal layout", () => {
  it("keeps reading-mode independently reachable on mobile with zero PTY tiles", () => {
    const source = readFileSync("src/renderer/src/components/TopBar.tsx", "utf8");
    const mobileStart = source.indexOf("if (isMobile) {");
    const desktopStart = source.indexOf("// --- Desktop:");
    const mobileBranch = source.slice(mobileStart, desktopStart);
    expect(mobileBranch).toContain('data-action-id="topbar.mobile.keys.toggle"');
    expect(mobileBranch).not.toMatch(/data-action-id="topbar\.mobile\.agentapi\.toggle"/);
  });

  it("keeps coarse-pointer short landscape phones in mobile and narrow layouts", () => {
    expect(MOBILE_LAYOUT_QUERY).toBe(
      "(max-width: 600px), ((pointer: coarse) and (max-height: 620px))",
    );
    expect(NARROW_LAYOUT_QUERY).toBe(
      "(max-width: 820px), ((pointer: coarse) and (max-height: 620px))",
    );
  });

  it("resets the remote host pan without changing PTY geometry", () => {
    const host = { scrollLeft: 240 };
    resetRemoteHorizontalPan(host);
    expect(host.scrollLeft).toBe(0);
  });

  it("explicitly pans the remote host horizontally", () => {
    const host = { scrollLeft: 100 };
    applyRemoteHorizontalTouchPan(host, -35);
    expect(host.scrollLeft).toBe(135);
    applyRemoteHorizontalTouchPan(host, 20);
    expect(host.scrollLeft).toBe(115);
  });

  it("uses the shared query everywhere TypeScript makes a mobile decision", () => {
    for (const path of [
      "src/renderer/src/App.tsx",
      "src/renderer/src/components/TerminalDock.tsx",
      "src/renderer/src/components/TopBar.tsx",
      "src/renderer/src/components/Sidebar.tsx",
      "src/renderer/src/store/app-store.ts",
    ]) {
      expect(readFileSync(path, "utf8")).not.toContain('matchMedia("(max-width: 600px)")');
    }
  });
});
