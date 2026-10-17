import { describe, expect, it } from "vitest";
import { calculateComposerGeometry } from "../../src/renderer/src/components/mobile/mobile-composer-geometry";

describe("calculateComposerGeometry", () => {
  it("anchors to the visible viewport and accounts for keyboard inset", () => {
    expect(calculateComposerGeometry({ width: 390, height: 500, offsetLeft: 4, offsetTop: 12 }, 844)).toEqual({
      left: 4,
      top: 512,
      width: 390,
      maxHeight: 160,
      keyboardInset: 332,
    });
  });
});
