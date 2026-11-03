import { describe, expect, it } from "vitest";
import {
  captureReaderViewportAnchor,
  restoreReaderViewportScrollTop,
} from "../../src/renderer/src/components/terminal-reader/terminal-reader-viewport";

describe("terminal reader viewport", () => {
  it("pins a zoom to the first visible message", () => {
    const anchor = captureReaderViewportAnchor({
      messageTops: [0, 104],
      messageHeights: [180, 180],
      containerTop: 20,
      containerHeight: 120,
      scrollTop: 180,
      maxScroll: 360,
    });

    expect(anchor).toEqual({
      messageIndex: 0,
      localRatio: 0.4444444444444444,
      viewportAnchorRatio: 0.5,
      fallbackScrollFraction: 0.5,
    });
  });

  it("restores the same visual position after text reflows", () => {
    const scrollTop = restoreReaderViewportScrollTop({
      anchorTop: 132,
      messageHeight: 180,
      localRatio: 0.5,
      containerTop: 20,
      containerHeight: 100,
      maxScroll: 360,
      viewportAnchorRatio: 0.5,
      currentScrollTop: 0,
    });

    expect(scrollTop).toBe(152);
  });

  it("keeps restored positions inside the scrolled conversation", () => {
    expect(restoreReaderViewportScrollTop({
      anchorTop: 500,
      messageHeight: 180,
      localRatio: 0.5,
      containerTop: 0,
      containerHeight: 100,
      maxScroll: 360,
      viewportAnchorRatio: 0.4,
      currentScrollTop: 0,
    })).toBe(360);
  });
});
