// Public #16: measure the host CONTENT box before granting rows/cols.
//
// @xterm/addon-fit 0.11.0 proposeDimensions() reads
// getComputedStyle(parentElement).height/width and subtracts only the terminal
// element's own padding — never the host's. Under this app's global
// `* { box-sizing: border-box }` (styles.css), `.xterm-host`'s computed size
// includes its `6px 8px 3px` padding, so FitAddon could grant one more row
// (and 1-2 more cols) than the visible area paints. The extra row renders
// into the padding and is clipped by `.xterm-host { overflow: hidden }` —
// fullscreen TUIs (?1049h repaint) exposed it as a chopped bottom row.
// Desktop sizing therefore routes through this module, which subtracts the
// host padding first.

import type { Terminal } from "@xterm/xterm";

// Mirrors @xterm/addon-fit's ViewportConstants.DEFAULT_SCROLL_BAR_WIDTH (14 in
// the 0.11.0 dist). The viewport keeps its own vertical scrollbar, so columns
// must reserve it exactly like FitAddon did — changing this would silently
// re-wrap every desktop terminal by a column.
export const XTERM_FALLBACK_SCROLLBAR_WIDTH = 14;

export interface TileGridMeasurement {
  /** host.clientWidth / clientHeight: content + padding, border excluded. */
  hostClientWidth: number;
  hostClientHeight: number;
  paddingTop: number;
  paddingBottom: number;
  paddingLeft: number;
  paddingRight: number;
  /** Reserved vertical-scrollbar width (FitAddon's width-side deduction). */
  scrollbarWidth: number;
  cellWidth: number;
  cellHeight: number;
}

export interface TileGrid {
  cols: number;
  rows: number;
}

/**
 * Pure sizing math. Guarantees `rows * cellHeight <= content height` (and cols
 * the same for width) so no granted row can ever paint into clipped padding.
 * Returns null when the cell metrics are not measurable yet (FitAddon does the
 * same when the render service reports 0-sized cells). Clamps mirror FitAddon:
 * minimum 2 cols / 1 row.
 */
export function proposeTileGrid(measurement: TileGridMeasurement): TileGrid | null {
  if (measurement.cellWidth <= 0 || measurement.cellHeight <= 0) return null;
  const availableHeight = Math.max(
    0,
    measurement.hostClientHeight - measurement.paddingTop - measurement.paddingBottom,
  );
  const availableWidth = Math.max(
    0,
    measurement.hostClientWidth
      - measurement.paddingLeft
      - measurement.paddingRight
      - measurement.scrollbarWidth,
  );
  return {
    cols: Math.max(2, Math.floor(availableWidth / measurement.cellWidth)),
    rows: Math.max(1, Math.floor(availableHeight / measurement.cellHeight)),
  };
}

/**
 * Read xterm's private cell metrics WITHOUT throwing. RenderService.dimensions
 * is a THROWING getter: it dereferences this._renderer.value.dimensions, and
 * during WebGL renderer teardown/switch _renderer.value is undefined, so even
 * `core?._renderService?.dimensions?.css?.cell` — optional chaining all the
 * way down — still throws "Cannot read properties of undefined (reading
 * 'dimensions')" (captured as renderer.error during the exclusive-toggle flow,
 * 2026-10-09). Every private-API dimensions read in the app must go through
 * this guard; it returns undefined while metrics are unavailable.
 */
export function readTerminalCellMetrics(
  terminal: Terminal,
): { width: number; height: number } | undefined {
  try {
    const core = (terminal as unknown as {
      _core?: {
        _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } };
      };
    })._core;
    return core?._renderService?.dimensions?.css?.cell;
  } catch {
    return undefined;
  }
}

/**
 * FitAddon.fit() replacement for DESKTOP tiles: same clear+resize semantics,
 * but measured against the host's content box (see the header comment). The
 * browser/mobile path never calls this — remote clients mirror the PTY's own
 * cols/rows 1:1 and pan instead of fitting.
 *
 * Returns true when the grid now matches the host (resize applied or already
 * equal); false when metrics were unavailable and nothing changed.
 */
export function fitTerminalToHost(terminal: Terminal, host: HTMLElement): boolean {
  const core = (terminal as unknown as {
    _core?: { _renderService?: { clear(): void } };
  })._core;
  const cell = readTerminalCellMetrics(terminal);
  if (!cell || cell.width === 0 || cell.height === 0) return false;
  const style = window.getComputedStyle(host);
  const px = (name: string): number => {
    const value = Number.parseFloat(style.getPropertyValue(name));
    return Number.isFinite(value) ? value : 0;
  };
  const options = terminal.options as {
    scrollback?: number;
    overviewRuler?: { width?: number };
  };
  const scrollbarWidth = options.scrollback === 0
    ? 0
    : options.overviewRuler?.width || XTERM_FALLBACK_SCROLLBAR_WIDTH;
  const grid = proposeTileGrid({
    hostClientWidth: host.clientWidth,
    hostClientHeight: host.clientHeight,
    paddingTop: px("padding-top"),
    paddingBottom: px("padding-bottom"),
    paddingLeft: px("padding-left"),
    paddingRight: px("padding-right"),
    scrollbarWidth,
    cellWidth: cell.width,
    cellHeight: cell.height,
  });
  if (!grid) return false;
  if (terminal.rows !== grid.rows || terminal.cols !== grid.cols) {
    core?._renderService?.clear();
    terminal.resize(grid.cols, grid.rows);
  }
  return true;
}
