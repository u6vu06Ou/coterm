import { describe, expect, it } from "vitest";
import {
  compactProgressText,
  isNativeWorkflowIntent,
  terminalCopyText,
  cleanTerminalCopy,
  userInputAnswers,
} from "../../src/shared/value";

describe("validated UI behavior", () => {
  it("collapses runaway provider blank lines without removing paragraphs", () => {
    expect(compactProgressText("first\n\n\n\n\nsecond\n\nthird"))
      .toBe("first\n\nsecond\n\nthird");
  });

  it.each([
    ["claude-local-main", "ultracode research", true],
    ["claude-local-long", "/goal keep working", true],
    ["claude-official", "/deep-research compare", true],
    ["codex-official", "ultracode research", false],
    ["claude-local-main", "explain ultracode", false],
  ] as const)("detects native Workflow intent for %s", (provider, text, expected) => {
    expect(isNativeWorkflowIntent(provider, text)).toBe(expected);
  });

  it("copies selected terminal text but preserves Ctrl+C interrupt without a selection", () => {
    expect(terminalCopyText({ key: "c", ctrlKey: true, shiftKey: false }, "selected"))
      .toBe("selected");
    expect(terminalCopyText({ key: "C", ctrlKey: true, shiftKey: true }, "selected"))
      .toBe("selected");
    expect(terminalCopyText({ key: "c", ctrlKey: true, shiftKey: false }, ""))
      .toBeNull();
  });

  it("strips row padding and the hanging indent of wrapped agent paragraphs", () => {
    expect(cleanTerminalCopy("first line   \n  second line  \n  third")).toBe("first line\nsecond line\nthird");
    // Code keeps its relative indentation when the first row is indented too.
    expect(cleanTerminalCopy("  if (x) {\n    y();\n  }")).toBe("  if (x) {\n    y();\n  }");
    // Relative indentation under an unindented first line survives the dedent.
    expect(cleanTerminalCopy("steps:\n  - a\n    - b")).toBe("steps:\n- a\n  - b");
    expect(cleanTerminalCopy("one\r\n\r\n  two")).toBe("one\n\ntwo");
  });

  it("builds structured answers from selected options and Other text", () => {
    expect(userInputAnswers(
      { approach: ["Agent SDK"], notes: [] },
      { approach: "", notes: "Keep Qwen workflows" },
    )).toEqual({ approach: ["Agent SDK"], notes: ["Keep Qwen workflows"] });
  });
});
