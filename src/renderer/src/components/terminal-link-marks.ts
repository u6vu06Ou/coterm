// Persistent link underlines (xterm underlines links only while hovered).
//
// Every detected link (path or URL — the same matches the link provider
// returns) gets a thin absolutely-positioned ruler at the bottom of its cell
// run, so links are VISIBLY marked without hovering first. xterm 6's
// ILink.decorations and IDecorationOptions only cover hover behaviour and
// solid cell backgrounds — neither can paint an underline — so this is a DOM
// overlay over the .xterm-screen rect, rebuilt from the caller's scan at rAF
// cadence on write/scroll/resize. Marks are pointer-events:none, so hover,
// click-to-open and drag-select pass straight through to xterm.

import type { Terminal } from "@xterm/xterm";

export interface LinkMarkSegment {
  /** 0-based VIEWPORT row (0 = first visible row). */
  row: number;
  /** 0-based start cell column, inclusive. */
  startCol: number;
  /** 0-based end cell column, exclusive. */
  endCol: number;
}

const STYLE_ID = "coterm-link-underline-style";

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent =
    ".coterm-link-underlines{position:absolute;inset:0;pointer-events:none;z-index:6;overflow:hidden}" +
    // Mid-blue with translucency reads against both the dark (moon) and light
    // (sun) palettes; a fixed colour survives theme switches without a repaint.
    ".coterm-link-underline{position:absolute;pointer-events:none;box-sizing:border-box;border-bottom:1px solid rgba(88,155,255,.65)}";
  document.head.appendChild(style);
}

/**
 * Paints persistent underlines for the segments `scan` returns. `scan` must be
 * cheap (visible rows only) and side-effect free; it runs at most once per
 * animation frame. Returns a disposer that removes listeners and the overlay.
 */
export function installLinkUnderlineOverlay(
  terminal: Terminal,
  host: HTMLElement,
  scan: () => readonly LinkMarkSegment[],
): () => void {
  ensureStyle();
  // Absolute children resolve against the nearest positioned ancestor; pin the
  // host so the overlay never drifts onto an outer layout ancestor.
  if (getComputedStyle(host).position === "static") {
    host.style.position = "relative";
  }
  const container = document.createElement("div");
  container.className = "coterm-link-underlines";
  container.setAttribute("aria-hidden", "true");
  host.appendChild(container);

  let frame = 0;
  const paint = (): void => {
    frame = 0;
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen || !host.isConnected) return;
    const containerRect = container.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const cellWidth = screenRect.width / Math.max(1, terminal.cols);
    const cellHeight = screenRect.height / Math.max(1, terminal.rows);
    if (cellWidth <= 0 || cellHeight <= 0) return;
    const segments = scan();
    const fragment = document.createDocumentFragment();
    for (const seg of segments) {
      if (seg.endCol <= seg.startCol) continue;
      const mark = document.createElement("div");
      mark.className = "coterm-link-underline";
      mark.style.left = `${screenRect.left - containerRect.left + seg.startCol * cellWidth}px`;
      // Underline sits on the cell's bottom edge, 1px up so tall line heights
      // do not push it onto the row below.
      mark.style.top = `${screenRect.top - containerRect.top + (seg.row + 1) * cellHeight - 2}px`;
      mark.style.width = `${(seg.endCol - seg.startCol) * cellWidth}px`;
      mark.style.height = "2px";
      fragment.appendChild(mark);
    }
    container.replaceChildren(fragment);
  };
  const schedule = (): void => {
    if (frame !== 0) return;
    frame = requestAnimationFrame(paint);
  };
  const disposables = [
    terminal.onWriteParsed(schedule),
    terminal.onScroll(schedule),
    terminal.onResize(schedule),
  ];
  schedule();
  return () => {
    for (const disposable of disposables) disposable.dispose();
    if (frame !== 0) cancelAnimationFrame(frame);
    container.remove();
  };
}
