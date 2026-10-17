export type MobileTerminalGesture = "open-composer" | "scroll" | "pan" | "pinch" | "long-press" | "noop";

export interface MobileTerminalGestureInput {
  start: { x: number; y: number };
  end: { x: number; y: number };
  durationMs: number;
  pointerCount: number;
  startedInInputZone: boolean;
  selectionActive: boolean;
  scrollThresholdPx?: number;
  longPressMs?: number;
}

/** Pure tap/pan classifier; it never focuses xterm or changes PTY geometry. */
export function classifyMobileTerminalGesture(input: MobileTerminalGestureInput): MobileTerminalGesture {
  if (input.pointerCount >= 2) return "pinch";
  if (input.selectionActive) return "noop";
  const dx = input.end.x - input.start.x;
  const dy = input.end.y - input.start.y;
  const threshold = input.scrollThresholdPx ?? 8;
  if (Math.abs(dx) > threshold && Math.abs(dx) >= Math.abs(dy)) return "pan";
  if (Math.abs(dy) > threshold) return "scroll";
  if (input.durationMs >= (input.longPressMs ?? 450)) return "long-press";
  if (input.startedInInputZone) return "open-composer";
  return "noop";
}
