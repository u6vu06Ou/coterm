// IME composition-view anchoring. The composition-view (xterm's inline preview
// of the in-progress 注音/candidate text) must sit exactly on the cursor cell so
// the first composed glyph aligns with the typing origin and the box never
// visually jumps while keystrokes stream in.
//
// Root-cause notes (2026-07-14):
//  - Jumping: the old impl recomputed top on every compositionupdate via a
//    candidateSize.height that could flip the box below<->above the cursor
//    across keystrokes. The composition-view is a single-line inline preview
//    one cell tall, so its Y must be pinned to cursorY*cellHeight for the whole
//    composition and never re-derived from a synthetic candidate height. We
//    now anchor Y to the cursor cell top (matching xterm's own
//    updateCompositionElements) and only clamp X.
//  - First-glyph eaten / offset: the box must start at the cursor cell's LEFT
//    edge (cursorX*cellWidth), not below/after it, so the first composed
//    character paints over the cursor cell exactly where typing began.

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ImeAnchorInput {
  cursorRect: Rect;
  hostRect: Rect;
  scroll: { x: number; y: number };
  // Kept for call-site compatibility; no longer drives vertical placement.
  candidateSize: { width: number; height: number };
}

export interface ImeAnchor {
  left: number;
  top: number;
}

// Pin the composition-view onto the cursor cell: left = cursor cell left
// (clamped so the preview never overflows the host's right edge), top = cursor
// cell top. Y is NOT reclamped per-update -- it tracks cursorY*cellHeight
// exactly like xterm's updateCompositionElements, so the box stays put while
// the IME streams keystrokes. All coordinates are host-local viewport-space.
export function calculateImeAnchor({
  cursorRect,
  hostRect,
  scroll,
  candidateSize,
}: ImeAnchorInput): ImeAnchor {
  const hostRight = hostRect.left + hostRect.width;

  const visibleCursorLeft = cursorRect.left - scroll.x;
  const visibleCursorTop = cursorRect.top - scroll.y;

  // Horizontal: clamp in visible-host coordinates so the preview box never
  // runs past the host's right edge (or left origin), then convert back into
  // the scrollable content coordinates expected by the inline `left` property.
  const maxLeft = hostRight - candidateSize.width;
  const visibleLeft = Math.min(visibleCursorLeft, Math.max(hostRect.left, maxLeft));
  const left = visibleLeft + scroll.x;

  // Vertical: pin to the cursor cell top. The composition-view is a single-line
  // preview one cell tall; placing it ON the cursor (not below) is what makes
  // the first composed glyph align with the typing origin. No below/above flip
  // -- flipping per-update was the source of the vertical jitter.
  const top = visibleCursorTop + scroll.y;

  return { left, top };
}
