export const DEFAULT_TERMINAL_WHEEL_MULTIPLIER = 0.6;
export const TERMINAL_WHEEL_IDLE_MS = 150;
// Per-event cap on synthesized SGR wheel reports / alt-screen arrows (flood guard).
export const MAX_SYNTH_WHEEL_EVENTS = 10;

const FALLBACK_CELL_HEIGHT_PX = 16;
// Chromium/WebKitGTK commonly report one physical notch as 100 CSS pixels.
// With the default 16–20px row height, the 0.6 multiplier below maps that to
// about three rows. deltaMode=1 (Firefox) already reports a notch as 3 DOM
// lines, so one DOM line maps to one row at the default multiplier — the same
// ≈3 rows per notch, scaled by the user's multiplier like pixel input.
const LINE_MODE_NOTCH_SCALE = 1 / DEFAULT_TERMINAL_WHEEL_MULTIPLIER;

export interface TerminalWheelMapperState {
  residualLines: number;
  direction: -1 | 0 | 1;
  lastEventTimeMs?: number;
}

export interface TerminalWheelDeltaInput {
  deltaY: number;
  deltaMode: number;
  cellHeightPx: number;
  rows: number;
  multiplier?: number;
  nowMs: number;
}

export interface TerminalWheelDeltaResult {
  lines: number;
  state: TerminalWheelMapperState;
}

export function initialTerminalWheelMapperState(): TerminalWheelMapperState {
  return { residualLines: 0, direction: 0 };
}

/**
 * Pure wheel-to-row mapping. Normalized pixels are divided by the live cell
 * height; no OS/xterm acceleration or magnitude-dependent curve is applied.
 * Sub-row movement survives between events. A fresh gesture is the exception:
 * its first non-zero event emits at least one row so a single gentle notch (or
 * an isolated tiny touchpad event) can never be swallowed.
 */
export function consumeTerminalWheelDelta(
  input: TerminalWheelDeltaInput,
  previous: TerminalWheelMapperState,
): TerminalWheelDeltaResult {
  if (!Number.isFinite(input.deltaY) || input.deltaY === 0) {
    return { lines: 0, state: previous };
  }

  const cellHeightPx = Number.isFinite(input.cellHeightPx) && input.cellHeightPx > 0
    ? input.cellHeightPx
    : FALLBACK_CELL_HEIGHT_PX;
  const rows = Number.isFinite(input.rows) && input.rows > 0 ? input.rows : 1;
  const multiplier = Number.isFinite(input.multiplier) && (input.multiplier ?? 0) > 0
    ? input.multiplier!
    : DEFAULT_TERMINAL_WHEEL_MULTIPLIER;

  // Normalize every DOM unit to CSS pixels first (pixel=0, line=1, page=2).
  const deltaPx = input.deltaMode === 1
    ? input.deltaY * cellHeightPx
    : input.deltaMode === 2
      ? input.deltaY * rows * cellHeightPx
      : input.deltaY;
  let deltaLines = (deltaPx / cellHeightPx) * multiplier;
  if (input.deltaMode === 1) deltaLines *= LINE_MODE_NOTCH_SCALE;

  const direction = Math.sign(input.deltaY) as -1 | 1;
  const directionChanged = previous.direction !== 0 && previous.direction !== direction;
  const residualLines = directionChanged || !Number.isFinite(previous.residualLines)
    ? 0
    : previous.residualLines;
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : 0;
  const idle = previous.lastEventTimeMs === undefined
    || !Number.isFinite(previous.lastEventTimeMs)
    || nowMs - previous.lastEventTimeMs >= TERMINAL_WHEEL_IDLE_MS
    || nowMs < previous.lastEventTimeMs;
  const total = residualLines + deltaLines;
  let lines = Math.trunc(total);
  let nextResidual = total - lines;

  if (idle && lines === 0) {
    lines = direction;
    // Promote the entire isolated sub-row delta to the guaranteed first row.
    // Do not leave an opposite-sign remainder that would make the next event
    // look like a direction reversal or charge for this row a second time.
    nextResidual = 0;
  }

  return {
    lines: Object.is(lines, -0) ? 0 : lines,
    state: { residualLines: nextResidual, direction, lastEventTimeMs: nowMs },
  };
}
