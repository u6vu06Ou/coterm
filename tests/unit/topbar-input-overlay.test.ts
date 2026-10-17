import { describe, expect, it } from "vitest";
import {
  buildInputOverlayPayload,
  inputOverlayLineCount,
  shouldCommitOnKeyDown,
} from "../../src/renderer/src/components/topbar-logic";

describe("buildInputOverlayPayload — sendWithEnter toggle", () => {
  it("appends \\r when sendWithEnter is true", () => {
    expect(buildInputOverlayPayload("ls", true)).toEqual({ data: "ls\r" });
    expect(buildInputOverlayPayload("echo hi", true)).toEqual({ data: "echo hi\r" });
  });

  it("sends raw text (no \\r) when sendWithEnter is false", () => {
    expect(buildInputOverlayPayload("ls", false)).toEqual({ data: "ls" });
    expect(buildInputOverlayPayload("echo hi", false)).toEqual({ data: "echo hi" });
  });

  it("returns null for empty value (no write)", () => {
    expect(buildInputOverlayPayload("", true)).toBeNull();
    expect(buildInputOverlayPayload("", false)).toBeNull();
  });

  it("multiline value + sendWithEnter appends a single trailing \\r", () => {
    expect(buildInputOverlayPayload("line1\nline2", true)).toEqual({ data: "line1\nline2\r" });
  });
});

describe("inputOverlayLineCount — multiline warning", () => {
  it("returns 0 for empty input (no warning)", () => {
    expect(inputOverlayLineCount("")).toBe(0);
  });

  it("returns 1 for single-line input (no warning)", () => {
    expect(inputOverlayLineCount("ls")).toBe(1);
    expect(inputOverlayLineCount("echo hi")).toBe(1);
  });

  it("returns N for N-line input", () => {
    expect(inputOverlayLineCount("line1\nline2")).toBe(2);
    expect(inputOverlayLineCount("a\nb\nc")).toBe(3);
    expect(inputOverlayLineCount("a\nb\nc\nd\ne")).toBe(5);
  });
});

describe("shouldCommitOnKeyDown — IME + Ctrl/Cmd+Enter", () => {
  const enter = { key: "Enter", metaKey: false, ctrlKey: false };
  const ctrlEnter = { key: "Enter", metaKey: false, ctrlKey: true };
  const cmdEnter = { key: "Enter", metaKey: true, ctrlKey: false };
  const plainA = { key: "a", metaKey: false, ctrlKey: false };

  it("commits on Ctrl+Enter when NOT composing", () => {
    expect(shouldCommitOnKeyDown(ctrlEnter, false)).toBe(true);
  });

  it("commits on Cmd+Enter when NOT composing", () => {
    expect(shouldCommitOnKeyDown(cmdEnter, false)).toBe(true);
  });

  it("does NOT commit on plain Enter (no modifier)", () => {
    expect(shouldCommitOnKeyDown(enter, false)).toBe(false);
  });

  it("does NOT commit on non-Enter keys", () => {
    expect(shouldCommitOnKeyDown(plainA, false)).toBe(false);
  });

  it("does NOT commit during IME composition, even with Ctrl/Cmd+Enter", () => {
    // The IME owns Enter while composing a candidate — must not submit.
    expect(shouldCommitOnKeyDown(ctrlEnter, true)).toBe(false);
    expect(shouldCommitOnKeyDown(cmdEnter, true)).toBe(false);
  });
});
