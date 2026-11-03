export interface ReaderViewportAnchor {
  messageIndex: number;
  localRatio: number;
  viewportAnchorRatio: number;
  fallbackScrollFraction: number;
}

export interface ReaderViewportAnchorInput {
  messageTops: number[];
  messageHeights: number[];
  containerTop: number;
  containerHeight: number;
  scrollTop: number;
  maxScroll: number;
}

export interface ReaderViewportRestoreInput {
  anchorTop: number;
  messageHeight: number;
  localRatio: number;
  containerTop: number;
  containerHeight: number;
  maxScroll: number;
  currentScrollTop: number;
  viewportAnchorRatio: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function captureReaderViewportAnchor(input: ReaderViewportAnchorInput): ReaderViewportAnchor {
  const usableHeight = input.containerHeight > 0 ? input.containerHeight : 1;
  const usableScroll = Number.isFinite(input.maxScroll) && input.maxScroll >= 0 ? input.maxScroll : 0;
  const fallbackScrollFraction = clamp01(input.scrollTop / usableScroll);

  if (input.messageTops.length === 0) {
    return { messageIndex: -1, localRatio: 0, viewportAnchorRatio: 0, fallbackScrollFraction };
  }

  const anchorY = input.containerTop + 0.5 * usableHeight;
  let chosen = -1;
  for (let index = 0; index < input.messageTops.length; index++) {
    if ((input.messageTops[index] ?? 0) <= anchorY) {
      chosen = index;
    } else {
      break;
    }
  }
  if (chosen < 0) chosen = 0;

  const selectedTop = input.messageTops[chosen] ?? anchorY;
  const messageHeight = Math.max(1, input.messageHeights[chosen] ?? 1);
  const localRatio = clamp01((anchorY - selectedTop) / messageHeight);
  return {
    messageIndex: chosen,
    localRatio,
    viewportAnchorRatio: 0.5,
    fallbackScrollFraction,
  };
}

export function restoreReaderViewportScrollTop(input: ReaderViewportRestoreInput): number {
  const usableHeight = input.containerHeight > 0 ? input.containerHeight : 1;
  const usableScroll = Number.isFinite(input.maxScroll) && input.maxScroll >= 0 ? input.maxScroll : 0;
  const localRatio = Number.isFinite(input.localRatio) ? clamp01(input.localRatio) : 0;
  const anchorDelta = input.anchorTop + localRatio * input.messageHeight - input.containerTop;
  const viewportOffset = clamp01(input.viewportAnchorRatio) * usableHeight;
  const nextScrollTop = input.currentScrollTop + anchorDelta - viewportOffset;
  return Math.min(usableScroll, Math.max(0, nextScrollTop));
}
