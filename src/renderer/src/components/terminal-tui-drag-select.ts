import type { Terminal } from "@xterm/xterm";
import { xtermTriggerMouseEvent } from "./terminal-touch-scroll";
import { cleanTerminalCopy } from "@shared/value";
import { hardWrapAwareSelectionText } from "./terminal-copy";

/**
 * 全螢幕 agent（Claude Code / Codex）會開滑鼠追蹤：xterm 把左鍵拖曳整段轉給
 * 程式，自己不選字，只有按住 Shift 拖才會出現藍色框選——一般人不會知道
 * （2026-10-03 maintainer：「框選看不到藍色」）。這裡讓「直接拖」也能選字：
 * 拖超過幾個像素就由我們用 xterm 的 select() 畫出藍色選取。
 *
 * 另一半的坑：xterm 只要「送任何滑鼠回報給程式」就當成使用者輸入，順手把
 * 選取清掉。Claude Code 開的是「游標一動就回報」模式，所以就算 Shift 拖出了
 * 藍框，滑鼠一移開就消失——這才是「看得到一瞬間又不見」。所以：
 *   - 左鍵按下先扣住不送；沒拖動就放開＝點擊，補送一組按下/放開給程式。
 *   - 拖動＝選字，按下、移動、放開都不送給程式。
 *   - 畫面上有選取時，單純移動游標（沒按鍵）也不回報，選取才留得住。
 *   - 例外：游標停在超連結上（點檔案路徑要開 artifact 面板）整段放行給
 *     xterm，不扣住——扣住會擋掉 Linkifier 的 mousedown/mouseup，link 點不動。
 */

const DRAG_THRESHOLD_PX = 5;

export interface Cell {
  col: number;
  row: number;
}

/** 起點到終點（含）在 xterm.select(col,row,length) 的參數；length 跨行連續計數。 */
export function selectionSpan(a: Cell, b: Cell, cols: number): { col: number; row: number; length: number } {
  const ia = a.row * cols + a.col;
  const ib = b.row * cols + b.col;
  const start = ia <= ib ? a : b;
  return { col: start.col, row: start.row, length: Math.abs(ib - ia) + 1 };
}

export function cellFromPoint(
  x: number,
  y: number,
  rect: { left: number; top: number; width: number; height: number },
  cols: number,
  rows: number,
  viewportY: number,
): Cell {
  const cellW = rect.width / Math.max(1, cols);
  const cellH = rect.height / Math.max(1, rows);
  const col = Math.min(cols - 1, Math.max(0, Math.floor((x - rect.left) / cellW)));
  const row = Math.min(rows - 1, Math.max(0, Math.floor((y - rect.top) / cellH)));
  return { col, row: viewportY + row };
}

export interface TuiMouseDownContext {
  button: number;
  /** shift/alt/ctrl/meta 任一個按住。 */
  hasModifier: boolean;
  /** 程式開了滑鼠回報（terminal.modes.mouseTrackingMode !== "none"）。 */
  mouseTracking: boolean;
  /** 游標停在超連結上——xterm 停在 link 上時會在 .xterm-screen 加
   *  xterm-cursor-pointer class（Linkifier._linkHover）。 */
  overLink: boolean;
}

/**
 * 按下左鍵要不要攔下來自己處理（扣住＝之後可能拖成選字）。
 * 唯二放行：(a) 有修飾鍵／非左鍵（Shift 拖曳是 xterm 原生框選），
 * (b) 按在超連結上——攔住會把 xterm Linkifier 的 mousedown/mouseup 擋掉，
 * 檔案路徑點了不會開 artifact 面板（v1.5.57 regression，2026-10-07 修）。
 * 放行 link 點擊＝回到攔截器出現之前的行為：link 啟動，點擊同時照舊回報給程式。
 */
export function shouldInterceptTuiMouseDown(context: TuiMouseDownContext): boolean {
  if (context.button !== 0 || context.hasModifier) return false;
  if (!context.mouseTracking) return false;
  if (context.overLink) return false;
  return true;
}

/**
 * 拖完自動複製（Claude Code 原本自己的拖曳選字也是放開就複製、右下角提示
 * 「copied N chars」；改成我們接手後要保留同樣的手感）。
 */
export function installTuiDragSelect(
  terminal: Terminal,
  host: HTMLElement,
  onCopied?: (chars: number) => void,
): () => void {
  let start: { x: number; y: number; cell: Cell; viewRow: number } | null = null;
  let dragging = false;

  const tracking = (): boolean => terminal.modes.mouseTrackingMode !== "none";

  const cellAt = (event: MouseEvent): Cell | null => {
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) return null;
    return cellFromPoint(event.clientX, event.clientY, screen.getBoundingClientRect(), terminal.cols, terminal.rows, terminal.buffer.active.viewportY);
  };

  const swallow = (event: MouseEvent): void => {
    event.stopImmediatePropagation();
    event.preventDefault();
  };

  const replayClick = (event: MouseEvent): void => {
    if (!start) return;
    const base = { col: start.cell.col, row: start.viewRow, x: event.clientX, y: event.clientY, button: 0, ctrl: false, alt: false, shift: false };
    xtermTriggerMouseEvent(terminal, { ...base, action: 1 });
    xtermTriggerMouseEvent(terminal, { ...base, action: 0 });
  };

  const onMove = (event: MouseEvent): void => {
    if (!start) {
      // 有選取時的單純滑過：不回報，否則 xterm 會把選取清掉。
      if (event.buttons === 0 && terminal.hasSelection() && tracking() && host.contains(event.target as Node)) {
        event.stopImmediatePropagation();
      }
      return;
    }
    swallow(event);
    if (!dragging && Math.hypot(event.clientX - start.x, event.clientY - start.y) < DRAG_THRESHOLD_PX) return;
    dragging = true;
    const end = cellAt(event);
    if (!end) return;
    const span = selectionSpan(start.cell, end, terminal.cols);
    terminal.select(span.col, span.row, span.length);
  };

  const onUp = (event: MouseEvent): void => {
    if (!start || event.button !== 0) return;
    swallow(event);
    if (!dragging) replayClick(event);
    else {
      const text = cleanTerminalCopy(hardWrapAwareSelectionText(terminal));
      if (text) {
        void navigator.clipboard.writeText(text).then(() => onCopied?.(Array.from(text).length), () => undefined);
      }
    }
    start = null;
    dragging = false;
  };

  const onDown = (event: MouseEvent): void => {
    const overLink = host.querySelector(".xterm-cursor-pointer") !== null;
    if (!shouldInterceptTuiMouseDown({
      button: event.button,
      hasModifier: event.shiftKey || event.altKey || event.ctrlKey || event.metaKey,
      mouseTracking: tracking(),
      overLink,
    })) return;
    const cell = cellAt(event);
    if (!cell) return;
    swallow(event);
    // 新的一次按下：清掉上一段選取（追蹤模式下 xterm 不會自己清）。
    if (terminal.hasSelection()) terminal.clearSelection();
    start = { x: event.clientX, y: event.clientY, cell, viewRow: cell.row - terminal.buffer.active.viewportY };
    dragging = false;
  };

  host.addEventListener("mousedown", onDown, true);
  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("mouseup", onUp, true);
  return () => {
    host.removeEventListener("mousedown", onDown, true);
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("mouseup", onUp, true);
  };
}
