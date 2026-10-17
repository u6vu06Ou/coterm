export interface ComposerViewport {
  width: number;
  height: number;
  offsetLeft: number;
  offsetTop: number;
}

export interface ComposerGeometry {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  keyboardInset: number;
}

export function calculateComposerGeometry(
  viewport: ComposerViewport,
  layoutHeight: number,
  // 0.32, not 0.45: the composer overlays the PTY, and the terminal above it is
  // what the user is reading while they type. A third of the visible viewport is
  // enough for a 2-row textarea plus the action row.
  maxHeightRatio = 0.32,
): ComposerGeometry {
  const width = Math.max(0, viewport.width);
  const height = Math.max(0, viewport.height);
  const bottom = viewport.offsetTop + height;
  return {
    left: viewport.offsetLeft,
    top: bottom,
    width,
    maxHeight: Math.max(120, Math.floor(height * maxHeightRatio)),
    keyboardInset: Math.max(0, layoutHeight - bottom),
  };
}

export function readComposerViewport(): ComposerViewport {
  const viewport = window.visualViewport;
  return {
    width: viewport?.width ?? window.innerWidth,
    height: viewport?.height ?? window.innerHeight,
    offsetLeft: viewport?.offsetLeft ?? 0,
    offsetTop: viewport?.offsetTop ?? 0,
  };
}
