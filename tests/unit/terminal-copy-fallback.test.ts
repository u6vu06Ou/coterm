import { describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { cellAccurateSelectionText } from "../../src/renderer/src/components/terminal-copy";

function terminal(text: string, position: unknown, lines: string[] = []): Terminal {
  return {
    cols: 80,
    getSelection: () => text,
    getSelectionPosition: () => position,
    buffer: { active: {
      getNullCell: () => ({}),
      getLine: (y: number) => lines[y] === undefined ? undefined : ({
        length: lines[y]!.length,
        isWrapped: false,
        getCell: (x: number) => ({ getChars: () => lines[y]![x], getWidth: () => 1 }),
      }),
    } },
  } as unknown as Terminal;
}

describe("copy fallback never leaks row padding", () => {
  it("cleans an unavailable range without removing indentation or path spaces", () => {
    const source = "C:\\My Files\\report.txt    \r\n    nested  code   \r\n\r\nnext\u00a0\t";
    expect(cellAccurateSelectionText(terminal(source, undefined))).toBe(
      "C:\\My Files\\report.txt\n    nested  code\n\nnext",
    );
  });

  it("cleans when a selected buffer row disappeared during a repaint", () => {
    expect(cellAccurateSelectionText(terminal("first   \r\n  second   ", {
      start: { x: 0, y: 0 }, end: { x: 10, y: 1 },
    }))).toBe("first\n  second");
  });

  it("cleans when legacy chunks and current buffer wrap flags differ", () => {
    expect(cellAccurateSelectionText(terminal("a    b    ", {
      start: { x: 0, y: 0 }, end: { x: 5, y: 1 },
    }, ["a    ", "b    "]))).toBe("a    b");
  });
});
