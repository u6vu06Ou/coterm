import { describe, expect, it } from "vitest";
import { buildCopyAllText, readerMessageLabel } from "../../src/renderer/src/components/terminal-reader/terminal-reader-state";
import type { TerminalTranscriptMessage } from "@shared/types";

const msg = (overrides: Partial<TerminalTranscriptMessage> & { text: string }): TerminalTranscriptMessage => ({
  role: "assistant",
  kind: "message",
  timestamp: null,
  ...overrides,
});

describe("readerMessageLabel", () => {
  it("uses the same UI labels as the conversation reader", () => {
    expect(readerMessageLabel(msg({ role: "user", text: "hi" }))).toBe("你");
    expect(readerMessageLabel(msg({ role: "system", text: "note" }))).toBe("系統");
    expect(readerMessageLabel(msg({ role: "assistant", provider: "codex", text: "done" }))).toBe("Codex");
    expect(readerMessageLabel(msg({ role: "assistant", provider: "claude", text: "done" }))).toBe("Agent");
  });

  it("prefers 回合摘要 for turn_summary regardless of provider", () => {
    expect(readerMessageLabel(msg({ role: "assistant", kind: "turn_summary", provider: "codex", text: "done" }))).toBe("回合摘要");
  });
});

describe("buildCopyAllText", () => {
  it("formats each message as '<label>:\\n<text>' joined by a blank line", () => {
    const messages = [
      msg({ id: "u1", role: "user", text: "第一題" }),
      msg({ id: "a1", role: "assistant", provider: "codex", kind: "turn_summary", text: "答案 A" }),
      msg({ id: "s1", role: "system", text: "結束" }),
    ];
    expect(buildCopyAllText(messages)).toBe("你:\n第一題\n\n回合摘要:\n答案 A\n\n系統:\n結束");
  });

  it("uses an agent label for assistant messages without codex provider", () => {
    const messages = [msg({ id: "a1", role: "assistant", provider: "claude", text: "line1\nline2" })];
    expect(buildCopyAllText(messages)).toBe("Agent:\nline1\nline2");
  });

  it("returns an empty string for an empty list", () => {
    expect(buildCopyAllText([])).toBe("");
  });

  it("keeps multi-paragraph message text verbatim between labels", () => {
    const messages = [
      msg({ id: "u1", role: "user", text: "q" }),
      msg({ id: "a1", role: "assistant", provider: "codex", text: "para1\n\npara2" }),
    ];
    // The message's own internal blank line stays; only block separators are "label:\n".
    expect(buildCopyAllText(messages)).toBe("你:\nq\n\nCodex:\npara1\n\npara2");
  });
});
