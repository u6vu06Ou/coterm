// Mobile terminal geometry helpers. Pure functions — no DOM, no xterm, no PTY
// resize. Mobile pinch zoom changes ONLY the local xterm font/visual scale; it
// never calls resizeTerminal (the shared ConPTY geometry is the main process's
// source of truth — see design 2026-07-11 §2).

export interface ViewportFontSizeInput {
  viewportHeight: number;
  rows: number;
  lineHeight: number;
  min?: number;
  max?: number;
}

// Derive the font size that makes the terminal canvas fill the usable height:
// fontSize * rows * lineHeight ≈ viewportHeight. Floor so we never overshoot
// (overshoot = content taller than viewport = bottom dead zone hidden behind
// the soft keyboard). Clamped to [min, max].
// NOTE: min defaults to 8 (matches TERMINAL_FONT_SIZE_MIN so a tiny viewport
// can still shrink to the user floor), but max stays 24 — this is the
// auto-fill ceiling, NOT the user-facing cap. A phone filling its height
// should not jump to 48px just because the row count is tiny.
export function fontSizeForViewport({
  viewportHeight,
  rows,
  lineHeight,
  min = 8,
  max = 24,
}: ViewportFontSizeInput): number {
  const safeRows = rows > 0 ? rows : 1;
  const safeLineHeight = lineHeight > 0 ? lineHeight : 1;
  const derived = Math.floor(viewportHeight / (safeRows * safeLineHeight));
  return Math.min(max, Math.max(min, derived));
}

export interface PinchFontSizeInput {
  currentSize: number;
  startDistance: number;
  currentDistance: number;
  min?: number;
  max?: number;
}

// Scale the font proportionally to the two-pointer distance ratio. Pinch-out
// (distance grows) → larger font; pinch-in → smaller. Returns the SAME size
// when distance is unchanged, and guards against divide-by-zero on a
// zero-length start distance (returns currentSize unchanged).
export function nextPinchFontSize({
  currentSize,
  startDistance,
  currentDistance,
  min = 8,
  max = 48,
}: PinchFontSizeInput): number {
  if (startDistance <= 0) return currentSize;
  const ratio = currentDistance / startDistance;
  const next = Math.round(currentSize * ratio);
  return Math.min(max, Math.max(min, next));
}

export interface MobileInputZoneRect {
  top: number;
  bottom: number;
  height: number;
}

/** Only the bottom tenth of the visible PTY is a tap-to-type affordance. */
export function isInMobileInputZone(
  clientY: number,
  rect: MobileInputZoneRect,
  fraction = 0.1,
): boolean {
  if (rect.height <= 0 || fraction <= 0) return false;
  const zoneHeight = Math.min(rect.height, rect.height * fraction);
  return clientY >= rect.bottom - zoneHeight && clientY <= rect.bottom;
}
