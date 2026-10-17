import { describe, expect, it } from "vitest";
import { parseTerminalTitles } from "../../src/renderer/src/components/terminal-title-parser";

describe("PTY title parsing", () => {
  it("keeps title escapes split at every byte boundary", () => {
    for (const ending of ["\x07", "\x1b\\"]) {
      const escape = `\x1b]0;hello${ending}`;
      for (let i = 1; i < escape.length; i++) {
        const first = parseTerminalTitles(escape.slice(0, i));
        expect(parseTerminalTitles(escape.slice(i), first.pending).titles).toEqual(["hello"]);
      }
    }
  });
  it("ignores ordinary output and accepts multiple complete titles", () => {
    expect(parseTerminalTitles("x".repeat(100000))).toEqual({ titles: [], pending: "" });
    expect(parseTerminalTitles("\x1b]0;one\x07\x1b]0;two\x07").titles).toEqual(["one", "two"]);
  });
});
