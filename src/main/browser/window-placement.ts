/**
 * Pure geometry for the agent-browser popout window (user request 2026-10-09).
 * Electron-free on purpose: `screen` is read by the wiring in main/index.ts and
 * passed in as plain rects, so this file is unit-testable without Electron.
 *
 * Contract:
 *  - ≥2 displays: place on the display that does NOT contain the center of the
 *    Coterm main window (terminal on one screen, agent browser on the other).
 *    Several candidates: largest workArea wins; tie → the rightmost.
 *  - 1 display (or when the main window cannot be located): a large window,
 *    NOT fullscreen — ~55% width × 80% height of the workArea, right edge,
 *    vertically centered — because other users may have only one monitor.
 *  - Never kiosk/F11 fullscreen: the caller applies the rect via
 *    --window-position/--window-size, which yields a normal OS window the user
 *    can still move or unmaximize.
 */

export interface PlacementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlacementDisplay {
  id: number | string;
  workArea: PlacementRect;
}

/** ~55% width × 80% height, right edge, vertically centered — never fullscreen. */
const WINDOWED_WIDTH_RATIO = 0.55;
const WINDOWED_HEIGHT_RATIO = 0.8;

function contains(rect: PlacementRect, point: { x: number; y: number }): boolean {
  return (
    point.x >= rect.x &&
    point.x < rect.x + rect.width &&
    point.y >= rect.y &&
    point.y < rect.y + rect.height
  );
}

function area(rect: PlacementRect): number {
  return rect.width * rect.height;
}

/** Largest workArea; tie → the display whose workArea starts further right. */
function pickDisplay(candidates: PlacementDisplay[]): PlacementDisplay {
  return candidates.reduce((best, current) => {
    const bestArea = area(best.workArea);
    const currentArea = area(current.workArea);
    if (currentArea !== bestArea) return currentArea > bestArea ? current : best;
    return current.workArea.x > best.workArea.x ? current : best;
  });
}

function windowedRect(workArea: PlacementRect): PlacementRect {
  const width = Math.round(workArea.width * WINDOWED_WIDTH_RATIO);
  const height = Math.round(workArea.height * WINDOWED_HEIGHT_RATIO);
  return {
    x: workArea.x + workArea.width - width,
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  };
}

export function computeAgentBrowserWindowPlacement(
  displays: PlacementDisplay[],
  mainWindowBounds: PlacementRect | null,
): PlacementRect | null {
  if (displays.length === 0) return null;

  const center = mainWindowBounds
    ? {
        x: mainWindowBounds.x + mainWindowBounds.width / 2,
        y: mainWindowBounds.y + mainWindowBounds.height / 2,
      }
    : null;

  // Displays that do NOT hold the main window's center. No main bounds (or the
  // center landing on no display at all) means we cannot say which screen is
  // "the other one" — fall back to all displays and the conservative windowed
  // size instead of confidently covering a whole screen.
  const excluded = center ? displays.filter((d) => !contains(d.workArea, center)) : [];
  const candidates = excluded.length > 0 ? excluded : [...displays];
  const target = pickDisplay(candidates);

  const multiDisplay = displays.length > 1 && excluded.length > 0;
  return multiDisplay
    ? { ...target.workArea }
    : windowedRect(target.workArea);
}
