/**
 * Remote web-desktop font-fit math. Pure — no DOM, no xterm, no store, so the
 * rules stay unit-testable.
 *
 * A remote browser mirrors the shared PTY grid (cols x rows) 1:1 and must
 * NEVER resize that PTY (letting remotes drive geometry caused the
 * 2026-08-12 rollback). On a remote pane smaller than the host's grid the
 * only lever left is the remote's own font size: shrink it until the whole
 * grid fits the pane, with no clipping and no horizontal scrolling.
 *
 * Invariants every caller must respect:
 * - The fit only shrinks when needed and never enlarges past the configured
 *   size; a large pane simply gets the configured font back (float-up).
 * - Cell size is normalized per font unit, so a measurement taken at a
 *   previously-shrunk font still predicts the grid correctly at any size.
 * - The post-apply correction pass is strictly decreasing — it can never
 *   loop, and callers run at most one correction pass anyway.
 */

/** Never shrink the remote font below this; past it the grid is unreadable. */
export const REMOTE_FIT_FONT_SIZE_MIN = 6;

const positive = (value: number): boolean => Number.isFinite(value) && value > 0;

export interface RemoteFitFontSizeInput {
  /** Remote pane budget: client size minus padding, in px. */
  paneWidthPx: number;
  paneHeightPx: number;
  /** Host grid the remote mirrors 1:1. */
  cols: number;
  rows: number;
  /** One cell measured at `measuredAtFontSize`, in px. */
  cellWidthPx: number;
  cellHeightPx: number;
  /** Font size (px value) the cell measurement was taken at. */
  measuredAtFontSize: number;
  /** Configured font size — the hard ceiling. */
  maxFontSize: number;
  minFontSize?: number;
}

/**
 * Font size the remote pane should apply so the whole host grid fits its
 * pane. Returns null on any unmeasurable input (hidden pane, zero cell, bad
 * grid) — callers keep the previous font instead of guessing, the same
 * fail-closed shape as touchMouseCell.
 */
export function nextRemoteFitFontSize(input: RemoteFitFontSizeInput): number | null {
  const minFontSize = input.minFontSize ?? REMOTE_FIT_FONT_SIZE_MIN;
  if (!positive(input.paneWidthPx) || !positive(input.paneHeightPx)) return null;
  if (!positive(input.cols) || !positive(input.rows)) return null;
  if (!positive(input.cellWidthPx) || !positive(input.cellHeightPx)) return null;
  if (!positive(input.measuredAtFontSize)) return null;
  if (!positive(input.maxFontSize)) return null;
  // px-per-font-unit cancels the measurement font out, so the grid at the
  // configured size is predictable even if the cell was measured at a font
  // the fit itself had previously shrunk.
  const cellWidthPerUnit = input.cellWidthPx / input.measuredAtFontSize;
  const cellHeightPerUnit = input.cellHeightPx / input.measuredAtFontSize;
  const gridWidthAtMax = input.cols * cellWidthPerUnit * input.maxFontSize;
  const gridHeightAtMax = input.rows * cellHeightPerUnit * input.maxFontSize;
  const scale = Math.min(
    1,
    input.paneWidthPx / gridWidthAtMax,
    input.paneHeightPx / gridHeightAtMax,
  );
  // floor() keeps the picked size inside the pane from the linear model; the
  // one correction pass covers the renderer's real (rounding) cell size.
  const fitted = Math.floor(input.maxFontSize * scale);
  return Math.min(input.maxFontSize, Math.max(minFontSize, fitted));
}

export interface RemoteFitCorrectionInput {
  /** Remote pane budget: client size minus padding, in px. */
  paneWidthPx: number;
  paneHeightPx: number;
  /** Host grid the remote mirrors 1:1. */
  cols: number;
  rows: number;
  /** One cell RE-measured at `currentFontSize` after the font was applied. */
  cellWidthPx: number;
  cellHeightPx: number;
  currentFontSize: number;
  minFontSize?: number;
}

/**
 * One correction pass after the fitted font was applied: if the re-measured
 * grid still overflows the pane, step strictly smaller; when it fits — or no
 * strictly smaller step exists (at the minimum) — stop with null. Never
 * returns a size >= currentFontSize, so even repeated calls terminate.
 */
export function nextRemoteFitCorrectionFontSize(input: RemoteFitCorrectionInput): number | null {
  const minFontSize = input.minFontSize ?? REMOTE_FIT_FONT_SIZE_MIN;
  if (!positive(input.paneWidthPx) || !positive(input.paneHeightPx)) return null;
  if (!positive(input.cols) || !positive(input.rows)) return null;
  if (!positive(input.cellWidthPx) || !positive(input.cellHeightPx)) return null;
  if (!positive(input.currentFontSize)) return null;
  const gridWidthPx = input.cols * input.cellWidthPx;
  const gridHeightPx = input.rows * input.cellHeightPx;
  if (gridWidthPx <= input.paneWidthPx && gridHeightPx <= input.paneHeightPx) return null;
  const scale = Math.min(
    1,
    input.paneWidthPx / gridWidthPx,
    input.paneHeightPx / gridHeightPx,
  );
  const stepped = Math.max(minFontSize, Math.floor(input.currentFontSize * scale));
  return stepped < input.currentFontSize ? stepped : null;
}
