// Public #16 fixture: desktop fit counted the tile padding as usable rows/cols.
//
// Root cause: @xterm/addon-fit 0.11.0 proposeDimensions() reads
//   getComputedStyle(parentElement).height / .width
// and subtracts ONLY the terminal element's own padding — never the parent's.
// This app sets a global `* { box-sizing: border-box }` (styles.css:184), so
// `.xterm-host`'s computed height/width INCLUDE its `6px 8px 3px` padding.
// On a tile whose content remainder absorbs the padding, xterm got granted one
// more row (and 1-2 more columns) than the visible area can paint; the extra
// row renders into the padding and is cut by `.xterm-host { overflow: hidden }`.
// Fullscreen TUIs (?1049h) repaint every cell absolutely, so the last painted
// row lands flush at the clipped bottom edge — the reported truncation.
//
// Fix: terminal-fit's proposeTileGrid measures the host CONTENT box (padding
// subtracted) before dividing by the cell size, and TerminalDock's desktop fit
// path goes through fitTerminalToHost instead of FitAddon.fit().
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";
import {
  proposeTileGrid,
  readTerminalCellMetrics,
  XTERM_FALLBACK_SCROLLBAR_WIDTH,
} from "../../src/renderer/src/components/terminal-fit";

// Mirrors @xterm/addon-fit 0.11.0 proposeDimensions verbatim (dist/addon-fit.js):
// parent border-box size minus the ELEMENT's padding (0 in this app) only.
function fitAddonRows({
  borderBoxHeight,
  cellHeight,
}: {
  borderBoxHeight: number;
  cellHeight: number;
}): number {
  const availableHeight = borderBoxHeight; // element padding is 0 on .xterm
  return Math.max(1, Math.floor(availableHeight / cellHeight));
}

describe("public #16 — host padding must not count as terminal rows/cols", () => {
  it("reproduces the bug math: FitAddon grants one clipped row on a padded, border-box host", () => {
    // 4-tile 2x2 desktop: clientHeight 410px, 6px+3px vertical padding,
    // 17px cells → content box is 401px.
    const borderBoxHeight = 410;
    const cellHeight = 17;
    // FitAddon: floor(410/17)=24 rows, but only floor(401/17)=23 fully fit —
    // row 24 paints 7px into the bottom padding and gets clipped in half.
    expect(fitAddonRows({ borderBoxHeight, cellHeight })).toBe(24);
    const grid = proposeTileGrid({
      hostClientHeight: borderBoxHeight,
      hostClientWidth: 800,
      paddingTop: 6,
      paddingBottom: 3,
      paddingLeft: 8,
      paddingRight: 8,
      scrollbarWidth: 0,
      cellWidth: 9,
      cellHeight,
    });
    expect(grid).not.toBeNull();
    expect(grid!.rows).toBe(23);
    // Every granted row is guaranteed fully inside the visible content box.
    expect(grid!.rows * cellHeight).toBeLessThanOrEqual(borderBoxHeight - 9);
  });

  it("subtracts horizontal padding too (right-edge clipping came from the same bug)", () => {
    const grid = proposeTileGrid({
      hostClientHeight: 400,
      hostClientWidth: 810, // content box: 810 - 16 = 794
      paddingTop: 6,
      paddingBottom: 3,
      paddingLeft: 8,
      paddingRight: 8,
      scrollbarWidth: 0,
      cellWidth: 9,
      cellHeight: 17,
    });
    expect(grid!.cols).toBe(88); // floor(794/9), NOT floor(810/9)=90
    expect(grid!.cols * 9).toBeLessThanOrEqual(794);
  });

  it("reserves xterm's fallback scrollbar width like FitAddon does", () => {
    const withoutSb = proposeTileGrid({
      hostClientHeight: 400,
      hostClientWidth: 794 + XTERM_FALLBACK_SCROLLBAR_WIDTH,
      paddingTop: 0,
      paddingBottom: 0,
      paddingLeft: 0,
      paddingRight: 0,
      scrollbarWidth: XTERM_FALLBACK_SCROLLBAR_WIDTH,
      cellWidth: 9,
      cellHeight: 17,
    });
    const withSb = proposeTileGrid({
      hostClientHeight: 400,
      hostClientWidth: 794 + XTERM_FALLBACK_SCROLLBAR_WIDTH,
      paddingTop: 0,
      paddingBottom: 0,
      paddingLeft: 0,
      paddingRight: 0,
      scrollbarWidth: 0,
      cellWidth: 9,
      cellHeight: 17,
    });
    expect(withoutSb!.cols).toBe(88);
    expect(withSb!.cols).toBeGreaterThan(withoutSb!.cols);
  });

  it("never overshoots the content box regardless of remainder (1 row max slack of padding)", () => {
    // Sweep heights: for every host, granted rows must fit inside the content box.
    for (let h = 200; h <= 500; h += 7) {
      const grid = proposeTileGrid({
        hostClientHeight: h,
        hostClientWidth: 800,
        paddingTop: 6,
        paddingBottom: 3,
        paddingLeft: 8,
        paddingRight: 8,
        scrollbarWidth: 0,
        cellWidth: 9,
        cellHeight: 17,
      });
      expect(grid!.rows * 17, `host height ${h}`).toBeLessThanOrEqual(h - 9);
    }
  });

  it("mirrors FitAddon clamps: minimum 2 cols / 1 row, null on unusable cell metrics", () => {
    const grid = proposeTileGrid({
      hostClientHeight: 0,
      hostClientWidth: 0,
      paddingTop: 6,
      paddingBottom: 3,
      paddingLeft: 8,
      paddingRight: 8,
      scrollbarWidth: 0,
      cellWidth: 9,
      cellHeight: 17,
    });
    expect(grid).toEqual({ cols: 2, rows: 1 });
    expect(
      proposeTileGrid({
        hostClientHeight: 400,
        hostClientWidth: 800,
        paddingTop: 0,
        paddingBottom: 0,
        paddingLeft: 0,
        paddingRight: 0,
        scrollbarWidth: 0,
        cellWidth: 0,
        cellHeight: 17,
      }),
    ).toBeNull();
  });
});

describe("public #16 — TerminalDock wiring", () => {
  const dockSource = readFileSync("src/renderer/src/components/TerminalDock.tsx", "utf8");

  it("every desktop fit goes through fitTerminalToHost (content-box measure), not FitAddon.fit()", () => {
    expect(dockSource).toContain("fitTerminalToHost(terminal, host)");
    // Desktop canvas/PTY sizing must not call fit.fit() anymore.
    expect(dockSource).not.toMatch(/[^a-zA-Z]fit\.fit\(\)/);
  });

  it("the browser-only proposeDimensions call (remote rows fallback) is retained", () => {
    expect(dockSource).toContain("fit?.proposeDimensions()?.rows");
  });

  it("private cell-metric reads go through readTerminalCellMetrics (throwing-getter guard)", () => {
    // xterm's RenderService.dimensions is a THROWING getter during WebGL
    // teardown (renderer.error 2026-10-09); no module outside terminal-fit may
    // re-implement the raw probe.
    expect(dockSource).not.toContain("_renderService?.dimensions");
  });
});

describe("readTerminalCellMetrics — xterm's throwing dimensions getter", () => {
  it("returns undefined instead of throwing while the WebGL renderer is torn down", () => {
    // Mirrors the real failure: _renderer.value is undefined mid-teardown and
    // the dimensions getter dereferences it, so even ?. chains throw.
    const tearingDownTerminal = {
      _core: {
        _renderService: {
          get dimensions(): never {
            throw new TypeError("Cannot read properties of undefined (reading 'dimensions')");
          },
        },
      },
    } as unknown as Terminal;
    expect(() => readTerminalCellMetrics(tearingDownTerminal)).not.toThrow();
    expect(readTerminalCellMetrics(tearingDownTerminal)).toBeUndefined();
  });

  it("returns the live cell metrics when the renderer is healthy", () => {
    const liveTerminal = {
      _core: { _renderService: { dimensions: { css: { cell: { width: 9, height: 17 } } } } },
    } as unknown as Terminal;
    expect(readTerminalCellMetrics(liveTerminal)).toEqual({ width: 9, height: 17 });
  });

  it("returns undefined when the private core or render service is absent", () => {
    expect(readTerminalCellMetrics({} as unknown as Terminal)).toBeUndefined();
    expect(readTerminalCellMetrics({ _core: {} } as unknown as Terminal)).toBeUndefined();
  });
});
