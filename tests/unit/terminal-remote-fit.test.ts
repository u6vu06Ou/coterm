import { describe, expect, it } from "vitest";
import {
  nextRemoteFitCorrectionFontSize,
  nextRemoteFitFontSize,
} from "../../src/renderer/src/components/terminal-remote-fit";

describe("remote fit font sizing", () => {
  it("keeps the configured size when the pane already fits it", () => {
    expect(nextRemoteFitFontSize({
      paneWidthPx: 1000,
      paneHeightPx: 600,
      cols: 80,
      rows: 24,
      cellWidthPx: 10,
      cellHeightPx: 20,
      measuredAtFontSize: 20,
      maxFontSize: 20,
    })).toBe(20);
  });

  it("shrinks proportionally when the width is the limiting dimension", () => {
    // cell 10px wide at 20px font → 800px grid; 600/800 = 0.75 → 20*0.75 = 15
    expect(nextRemoteFitFontSize({
      paneWidthPx: 600,
      paneHeightPx: 600,
      cols: 80,
      rows: 24,
      cellWidthPx: 10,
      cellHeightPx: 20,
      measuredAtFontSize: 20,
      maxFontSize: 20,
    })).toBe(15);
  });

  it("shrinks proportionally when the height is the limiting dimension", () => {
    // cell 20px tall at 20px font → 480px grid; 360/480 = 0.75 → 15
    expect(nextRemoteFitFontSize({
      paneWidthPx: 1000,
      paneHeightPx: 360,
      cols: 80,
      rows: 24,
      cellWidthPx: 10,
      cellHeightPx: 20,
      measuredAtFontSize: 20,
      maxFontSize: 20,
    })).toBe(15);
  });

  it("never returns a size larger than the configured maximum", () => {
    expect(nextRemoteFitFontSize({
      paneWidthPx: 5000,
      paneHeightPx: 3000,
      cols: 80,
      rows: 24,
      cellWidthPx: 10,
      cellHeightPx: 20,
      measuredAtFontSize: 20,
      maxFontSize: 16,
    })).toBe(16);
  });

  it("clamps at the minimum font size on a tiny pane", () => {
    expect(nextRemoteFitFontSize({
      paneWidthPx: 100,
      paneHeightPx: 50,
      cols: 80,
      rows: 24,
      cellWidthPx: 10,
      cellHeightPx: 20,
      measuredAtFontSize: 20,
      maxFontSize: 20,
    })).toBe(6);
  });

  it("normalizes a measurement taken at a previously-shrunk font and floats back up", () => {
    // cell measured while the fit had shrunk to 10px font; the roomy pane now
    // fits the grid at the configured 20 → return to 20, not stay at 10.
    expect(nextRemoteFitFontSize({
      paneWidthPx: 900,
      paneHeightPx: 500,
      cols: 80,
      rows: 24,
      cellWidthPx: 5,
      cellHeightPx: 10,
      measuredAtFontSize: 10,
      maxFontSize: 20,
    })).toBe(20);
  });

  it("returns null on an unmeasurable pane", () => {
    const base = {
      paneWidthPx: 600,
      paneHeightPx: 600,
      cols: 80,
      rows: 24,
      cellWidthPx: 10,
      cellHeightPx: 20,
      measuredAtFontSize: 20,
      maxFontSize: 20,
    };
    expect(nextRemoteFitFontSize({ ...base, paneWidthPx: 0 })).toBeNull();
    expect(nextRemoteFitFontSize({ ...base, paneHeightPx: Number.NaN })).toBeNull();
  });

  it("returns null when the cell size is unmeasurable", () => {
    expect(nextRemoteFitFontSize({
      paneWidthPx: 600,
      paneHeightPx: 600,
      cols: 80,
      rows: 24,
      cellWidthPx: 0,
      cellHeightPx: 20,
      measuredAtFontSize: 20,
      maxFontSize: 20,
    })).toBeNull();
  });

  it("returns null on a malformed grid", () => {
    expect(nextRemoteFitFontSize({
      paneWidthPx: 600,
      paneHeightPx: 600,
      cols: 0,
      rows: 24,
      cellWidthPx: 10,
      cellHeightPx: 20,
      measuredAtFontSize: 20,
      maxFontSize: 20,
    })).toBeNull();
  });
});

describe("remote fit correction pass", () => {
  it("stops with null when the re-measured grid already fits", () => {
    expect(nextRemoteFitCorrectionFontSize({
      paneWidthPx: 800,
      paneHeightPx: 480,
      cols: 80,
      rows: 24,
      cellWidthPx: 10,
      cellHeightPx: 20,
      currentFontSize: 20,
    })).toBeNull();
  });

  it("steps strictly smaller when the re-measured grid still overflows", () => {
    // 800px grid in a 784px pane → scale 0.98 → floor(20*0.98) = 19
    expect(nextRemoteFitCorrectionFontSize({
      paneWidthPx: 784,
      paneHeightPx: 480,
      cols: 80,
      rows: 24,
      cellWidthPx: 10,
      cellHeightPx: 20,
      currentFontSize: 20,
    })).toBe(19);
  });

  it("stops at the minimum font size", () => {
    expect(nextRemoteFitCorrectionFontSize({
      paneWidthPx: 300,
      paneHeightPx: 300,
      cols: 80,
      rows: 24,
      cellWidthPx: 20,
      cellHeightPx: 40,
      currentFontSize: 6,
    })).toBeNull();
  });

  it("never enlarges a font below the minimum", () => {
    expect(nextRemoteFitCorrectionFontSize({
      paneWidthPx: 784,
      paneHeightPx: 480,
      cols: 80,
      rows: 24,
      cellWidthPx: 10,
      cellHeightPx: 20,
      currentFontSize: 5,
    })).toBeNull();
  });

  it("returns null on an unmeasurable pane", () => {
    expect(nextRemoteFitCorrectionFontSize({
      paneWidthPx: 0,
      paneHeightPx: 480,
      cols: 80,
      rows: 24,
      cellWidthPx: 10,
      cellHeightPx: 20,
      currentFontSize: 20,
    })).toBeNull();
  });
});
