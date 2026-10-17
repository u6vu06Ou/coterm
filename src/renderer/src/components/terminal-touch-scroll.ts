const FALLBACK_CELL_HEIGHT_PX = 16;

/** Swipe-axis bias (#57): only a swipe within ~17° of straight up/down
   (|dx| < 0.3 * |dy|) scrolls; everything flatter counts as a sideways pan.
   0.6 (~31°) still let diagonal thumb arcs scroll on a phone (2026-10-06). */
export const SWIPE_AXIS_HORIZONTAL_RATIO = 0.3;

/** Don't judge the axis from the first few pixels — a thumb's touch-down
   jitter is mostly vertical even on a sideways swipe. Wait until the finger
   has travelled this far before locking the axis. */
export const SWIPE_AXIS_DECIDE_PX = 14;

/**
 * Decide a swipe's axis from its cumulative displacement, biased toward
 * horizontal (horizontal wins ties and flatter slopes). Pure — the caller
 * evaluates this ONCE at the first threshold crossing and locks the verdict
 * for the whole gesture instead of re-deciding every move event (a per-event
 * 45° split let vertical drift hijack a sideways swipe mid-pan).
 */
export function classifySwipeAxis(dx: number, dy: number): "horizontal" | "vertical" {
  return Math.abs(dx) >= Math.abs(dy) * SWIPE_AXIS_HORIZONTAL_RATIO
    ? "horizontal"
    : "vertical";
}

export interface ScrollDeltaInput {
  residualPx: number;
  deltaPx: number;
  cellHeightPx: number;
}

export interface ScrollDeltaResult {
  lines: number;
  residualPx: number;
}

/** Convert pixel touch movement into whole xterm rows without discarding drift. */
export function consumeScrollDelta(input: ScrollDeltaInput): ScrollDeltaResult {
  const cellHeightPx = Number.isFinite(input.cellHeightPx) && input.cellHeightPx > 0
    ? input.cellHeightPx
    : FALLBACK_CELL_HEIGHT_PX;
  const residualPx = Number.isFinite(input.residualPx) ? input.residualPx : 0;
  const deltaPx = Number.isFinite(input.deltaPx) ? input.deltaPx : 0;
  const total = residualPx + deltaPx;
  const consumed = Math.trunc(total / cellHeightPx);
  const lines = Object.is(consumed, -0) ? 0 : consumed;
  return {
    lines,
    residualPx: total - lines * cellHeightPx,
  };
}

export function terminalCellHeight(host: HTMLElement, opts: { rows?: number } = {}): number {
  const rows = host.querySelector(".xterm-rows");
  const measured = (rows?.firstElementChild as HTMLElement | null)?.clientHeight ?? 0;
  if (Number.isFinite(measured) && measured > 0) return measured;
  // WebGL/canvas renderer keeps no .xterm-rows DOM — derive the row height from
  // the screen element instead. Without this, pinch-zoomed fonts still convert
  // touch pixels at a stale 16px/line (#53: wrong scroll speed after zoom).
  const screen = host.querySelector<HTMLElement>(".xterm-screen");
  if (screen && typeof opts.rows === "number" && opts.rows > 0) {
    const derived = screen.clientHeight / opts.rows;
    if (Number.isFinite(derived) && derived > 0) return derived;
  }
  return FALLBACK_CELL_HEIGHT_PX;
}

export interface ReaderSwipeInput {
  readerOpen: boolean;
  bufferType: string;
  baseY: number;
  deltaY: number;
  thresholdPx: number;
  /** App enabled mouse reporting (?1000/1002/1003h): swipes are encoded as SGR
     wheel events back to the PTY instead, so the reader is not needed (#47). */
  mouseReportingActive: boolean;
}

/** Alt-screen TUIs (fullscreen apps) repaint in place, so nothing scrolls out
   the top, baseY stays 0, and swipe-scroll is a silent no-op. A deliberate
   upward swipe there means "show me more" → open the reader overlay instead. */
export function shouldOpenReaderOnSwipe(input: ReaderSwipeInput): boolean {
  if (input.readerOpen) return false;
  if (input.mouseReportingActive) return false;
  const noScrollback = input.bufferType === "alternate" || input.baseY <= 0;
  return noScrollback && input.deltaY < -Math.abs(input.thresholdPx);
}

export interface TouchWheelPlan {
  /** xterm wheel encoding: button 4 = wheel; action 0 = up, 1 = down — the
     same values xterm's own wheel handler feeds triggerMouseEvent. */
  button: 4;
  action: 0 | 1;
  count: number;
}

/**
 * Map consumed touch scroll lines to synthesized wheel events (#47 layer 2).
 * `lines` follows scrollLines sign: positive = toward bottom/newer = wheel
 * down (action 1); negative = toward top/older = wheel up (action 0).
 * Count is capped so one fling can't enqueue an unbounded burst.
 */
export function planTouchWheelEvents(lines: number): TouchWheelPlan | null {
  const count = Math.min(Math.trunc(Math.abs(lines)), 64);
  if (!Number.isFinite(count) || count <= 0) return null;
  return { button: 4, action: lines > 0 ? 1 : 0, count };
}

// --- xterm mouse-service compat (6.0 coreMouseService → 6.1 mouseStateService) ---
// All of these touch private xterm APIs; probe both names. If neither exists,
// callers fall back to local behavior (no wheel injection into mouse-reporting TUIs).

export interface XtermMouseEventShape {
  col: number; row: number; x: number; y: number;
  button: number; action: number; ctrl: boolean; alt: boolean; shift: boolean;
}

interface XtermCoreMouseApi {
  coreMouseService?: { areMouseEventsActive?: boolean; triggerMouseEvent?: (e: XtermMouseEventShape) => unknown };
  mouseStateService?: { areMouseEventsActive?: boolean };
  _mouseService?: { _triggerMouseEvent?: (e: XtermMouseEventShape) => unknown };
}

function probeXtermCore(terminal: unknown): XtermCoreMouseApi | undefined {
  try {
    return (terminal as { _core?: XtermCoreMouseApi })._core;
  } catch {
    return undefined;
  }
}

export function xtermMouseReportingActive(terminal: unknown): boolean {
  const core = probeXtermCore(terminal);
  return (core?.mouseStateService?.areMouseEventsActive ?? core?.coreMouseService?.areMouseEventsActive) === true;
}

/** Feed a synthesized wheel event into xterm's own encoding path. Returns false
    when mouse reporting is off or the private API is absent. */
export function xtermTriggerMouseEvent(terminal: unknown, event: XtermMouseEventShape): boolean {
  // NaN/Infinity coordinates are never encodable: xterm's own bounds checks are
  // all comparisons, which NaN sails through, and the event would serialize the
  // literal string "NaN" into the PTY (AT-156: stray `;NaN;NaNM` at the shell).
  if (!Number.isFinite(event.col) || !Number.isFinite(event.row)) return false;
  const core = probeXtermCore(terminal);
  if (!xtermMouseReportingActive(terminal)) return false;
  const legacy = core?.coreMouseService?.triggerMouseEvent;
  const owner = legacy ? core?.coreMouseService : core?._mouseService;
  const trigger = legacy ?? core?._mouseService?._triggerMouseEvent;
  if (!trigger || !owner) return false;
  try {
    return trigger.call(owner, event) !== false;
  } catch {
    return false;
  }
}

export interface TouchCellInput {
  clientX: number;
  clientY: number;
  rectLeft: number;
  rectTop: number;
  hostWidth: number;
  cols: number;
  rows: number;
  cellHeight: number;
}

/**
 * Map a touch point to a terminal cell for synthesized mouse reports (AT-156).
 * Returns null when no trustworthy mapping exists: an unmeasured host
 * (display:none / mid-fit 0 width) makes any column fiction, and the caller
 * must NOT send — the alternative is NaN/garbage coordinates serialized into
 * the PTY as literal "NaN" SGR mouse bytes.
 */
export function touchMouseCell(input: TouchCellInput): { col: number; row: number } | null {
  if (!Number.isFinite(input.hostWidth) || input.hostWidth <= 0) return null;
  if (!Number.isFinite(input.clientX) || !Number.isFinite(input.clientY)
    || !Number.isFinite(input.rectLeft) || !Number.isFinite(input.rectTop)) return null;
  const cellHeight = Number.isFinite(input.cellHeight) && input.cellHeight > 0
    ? input.cellHeight
    : FALLBACK_CELL_HEIGHT_PX;
  const measuredWidth = input.cols > 0 ? input.hostWidth / input.cols : Number.NaN;
  // Same fallback shape as the legacy cols<=0 branch: derive a plausible column
  // width from the row height (terminal cells are taller than wide).
  const cellWidth = Number.isFinite(measuredWidth) && measuredWidth > 0
    ? measuredWidth
    : Math.max(1, cellHeight * 0.6);
  const col = Math.min(Math.max(0, Math.floor((input.clientX - input.rectLeft) / cellWidth)), input.cols - 1);
  const row = Math.min(Math.max(0, Math.floor((input.clientY - input.rectTop) / cellHeight)), input.rows - 1);
  if (!Number.isFinite(col) || !Number.isFinite(row) || col < 0 || row < 0) return null;
  return { col, row };
}

const MOUSE_NAN_GUARD_MARK = "__cotermMouseNaNGuarded";

/**
 * Last-line-of-defense patch over xterm's own triggerMouseEvent (AT-156 #3):
 * the upstream wheel/touch path (`getMouseReportCoords`) can yield NaN col/row
 * when CharMeasure returns 0/0 (display:none tiles, pinch re-measure, hydrate
 * race), and every internal bounds check is a comparison NaN sails through.
 * xterm 6.1.0-beta.302 keeps `_mouseService` alive across reset() (created in
 * the CoreService constructor, only re-bound on open), so an instance-level
 * patch after terminal.open() persists. Idempotent. Re-verify on any
 * @xterm/xterm upgrade — if upstream starts filtering NaN we can drop this.
 */
export function installXtermMouseNaNGuard(terminal: unknown): void {
  const core = probeXtermCore(terminal);
  if (!core) return;
  const seams: Array<{ owner: object; key: "triggerMouseEvent" | "_triggerMouseEvent" }> = [];
  if (core.coreMouseService && typeof core.coreMouseService.triggerMouseEvent === "function") {
    seams.push({ owner: core.coreMouseService, key: "triggerMouseEvent" });
  }
  if (core._mouseService && typeof core._mouseService._triggerMouseEvent === "function") {
    seams.push({ owner: core._mouseService, key: "_triggerMouseEvent" });
  }
  for (const { owner, key } of seams) {
    const target = owner as Record<string, unknown> & { [MOUSE_NAN_GUARD_MARK]?: boolean };
    if (target[MOUSE_NAN_GUARD_MARK]) continue;
    const original = target[key] as (e: XtermMouseEventShape) => unknown;
    target[key] = function guardedTriggerMouseEvent(this: unknown, e: XtermMouseEventShape) {
      if (!e || !Number.isFinite(e.col) || !Number.isFinite(e.row)) return false;
      return original.call(this, e);
    };
    target[MOUSE_NAN_GUARD_MARK] = true;
  }
}
