import { describe, expect, it } from "vitest";
import { calculateImeAnchor } from "../../src/renderer/src/components/terminal-ime-position";

describe("calculateImeAnchor", () => {
  // All rects use { left, top, width, height } in screen px. cursorRect is the
  // cursor cell's rendered rect (relative to viewport). hostRect is the visible
  // terminal host rect. scroll = { x, y } is the host's internal scroll offset
  // (how far the remote PTY canvas is panned). candidateSize = { width, height }
  // of the IME candidate window to clamp inside the host.

  it("places the anchor at the cursor when the cursor is fully visible", () => {
    const anchor = calculateImeAnchor({
      cursorRect: { left: 100, top: 200, width: 8, height: 16 },
      hostRect: { left: 0, top: 0, width: 400, height: 600 },
      scroll: { x: 0, y: 0 },
      candidateSize: { width: 120, height: 40 },
    });
    expect(anchor.left).toBe(100);
    expect(anchor.top).toBe(200); // pinned ON the cursor cell top, not below it
  });

  it("accounts for host horizontal scroll and returns content-local coordinates", () => {
    // Cursor content coordinate 630 with scrollLeft=250 appears at x=380.
    // A 120px candidate must clamp to visible x=280, which is content x=530.
    const anchor = calculateImeAnchor({
      cursorRect: { left: 630, top: 200, width: 8, height: 16 },
      hostRect: { left: 0, top: 0, width: 400, height: 600 },
      scroll: { x: 250, y: 0 },
      candidateSize: { width: 120, height: 40 },
    });
    expect(anchor.left).toBe(530);
    expect(anchor.left - 250 + 120).toBeLessThanOrEqual(400);
  });

  it("keeps the anchor on the cursor cell under vertical scroll", () => {
    const anchor = calculateImeAnchor({
      cursorRect: { left: 100, top: 780, width: 8, height: 16 },
      hostRect: { left: 0, top: 0, width: 400, height: 600 },
      scroll: { x: 0, y: 250 },
      candidateSize: { width: 120, height: 40 },
    });
    // Visible cursor top is 530; pinned to the cell → content top 780.
    expect(anchor.top).toBe(780);
  });

  it("clamps the candidate to the right edge so it never overflows the host", () => {
    // Cursor near the right edge: left=380, candidate width 120 → would end at
    // 500, but host right edge is 400. Clamp so candidate fits.
    const anchor = calculateImeAnchor({
      cursorRect: { left: 380, top: 200, width: 8, height: 16 },
      hostRect: { left: 0, top: 0, width: 400, height: 600 },
      scroll: { x: 0, y: 0 },
      candidateSize: { width: 120, height: 40 },
    });
    expect(anchor.left).toBe(280); // 400 - 120 = 280
    expect(anchor.left + 120).toBeLessThanOrEqual(400);
  });

  it("stays pinned on the cursor cell near the bottom edge (no above/below flip)", () => {
    // Flipping per-update was the source of the vertical jitter; the preview is
    // a one-cell-tall inline box, so it must sit on the cursor even at 580.
    const anchor = calculateImeAnchor({
      cursorRect: { left: 100, top: 580, width: 8, height: 16 },
      hostRect: { left: 0, top: 0, width: 400, height: 600 },
      scroll: { x: 0, y: 0 },
      candidateSize: { width: 120, height: 40 },
    });
    expect(anchor.top).toBe(580);
  });

  it("never returns a negative left (cursor at origin stays at origin)", () => {
    const anchor = calculateImeAnchor({
      cursorRect: { left: 0, top: 200, width: 8, height: 16 },
      hostRect: { left: 0, top: 0, width: 400, height: 600 },
      scroll: { x: 0, y: 0 },
      candidateSize: { width: 120, height: 40 },
    });
    expect(anchor.left).toBe(0);
  });

  it("offsets by hostRect.left/top when the host is not at viewport origin", () => {
    // Host is offset (e.g. sidebar takes left 200px). cursorRect is in viewport
    // coords; the anchor returned should be in viewport coords too (cursor already
    // includes the offset), so the anchor tracks the cursor directly.
    const anchor = calculateImeAnchor({
      cursorRect: { left: 300, top: 220, width: 8, height: 16 },
      hostRect: { left: 200, top: 20, width: 400, height: 600 },
      scroll: { x: 0, y: 0 },
      candidateSize: { width: 120, height: 40 },
    });
    expect(anchor.left).toBe(300);
    expect(anchor.top).toBe(220);
  });

  it("clamps relative to hostRect origin when host is offset", () => {
    // Host left=200, width=400 → right edge at 600. Cursor at left=580, candidate
    // width 120 → would end at 700 > 600. Clamp to 600-120=480.
    const anchor = calculateImeAnchor({
      cursorRect: { left: 580, top: 220, width: 8, height: 16 },
      hostRect: { left: 200, top: 20, width: 400, height: 600 },
      scroll: { x: 0, y: 0 },
      candidateSize: { width: 120, height: 40 },
    });
    expect(anchor.left).toBe(480);
    expect(anchor.left + 120).toBeLessThanOrEqual(600);
  });
});
