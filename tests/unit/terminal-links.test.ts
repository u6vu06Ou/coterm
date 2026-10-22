import { describe, expect, it } from "vitest";
import { classifyTerminalPath, findTerminalLinks, findTerminalPaths, lineTextAndColumnMap, linkRangeForMatch, multiRowLinkRangeForMatch, multiRowTextAndColumnMap, normalizeTerminalPath, WEB_URL_REGEX, type TerminalCellLike, type TerminalLogicalRow } from "../../src/renderer/src/components/terminal-links";

const cell = (chars: string, width: number): TerminalCellLike => ({ chars, width });
// A line of plain single-width characters as buffer cells.
const narrowCells = (s: string): TerminalCellLike[] => [...s].map((ch) => cell(ch, 1));
// xterm stores a wide char as a width-2 cell followed by an empty width-0 one.
const wideCells = (ch: string): TerminalCellLike[] => [cell(ch, 2), cell("", 0)];

describe("terminal path links (C2)", () => {
  it("matches absolute Windows paths with an extension", () => {
    const found = findTerminalPaths("wrote D:\\proj\\out.png and C:/tmp/report.pdf done");
    expect(found.map((m) => m.path)).toEqual(["D:\\proj\\out.png", "C:/tmp/report.pdf"]);
  });

  it("reports the correct start index for range mapping", () => {
    const text = "see C:\\a\\b.txt";
    const matches = findTerminalPaths(text);
    expect(matches).toHaveLength(1);
    const m = matches[0]!;
    expect(text.slice(m.index, m.index + m.path.length)).toBe("C:\\a\\b.txt");
  });

  it("stops at surrounding punctuation and quotes", () => {
    expect(findTerminalPaths("(C:\\a\\b.log)").map((m) => m.path)).toEqual(["C:\\a\\b.log"]);
    expect(findTerminalPaths('"D:\\x\\y.json"').map((m) => m.path)).toEqual(["D:\\x\\y.json"]);
  });

  it("ignores relative paths, bare words, and URLs", () => {
    expect(findTerminalPaths("./rel/path.txt src/foo.ts")).toEqual([]);
    expect(findTerminalPaths("https://example.com/a.png")).toEqual([]);
  });

  it("routes previewable extensions to the artifact panel, others external", () => {
    expect(classifyTerminalPath("C:\\a.png")).toBe("artifact");
    expect(classifyTerminalPath("C:\\a.MD")).toBe("artifact");
    expect(classifyTerminalPath("C:\\a.zip")).toBe("external");
    expect(classifyTerminalPath("C:\\a.exe")).toBe("external");
  });

  it("matches file:// URIs with %20-encoded spaces and decodes them", () => {
    const text = "see file:///D:/Coterm/.review/STATUS.md here";
    const matches = findTerminalPaths(text);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.path).toBe("file:///D:/Coterm/.review/STATUS.md");
    expect(normalizeTerminalPath(matches[0]!.path)).toBe("D:/Coterm/.review/STATUS.md");
  });

  it("does not double-match the drive-letter fragment inside a file:// URI", () => {
    const found = findTerminalPaths("file:///D:/Coterm/.review/STATUS.md");
    expect(found).toHaveLength(1);
  });

  it("classifies a decoded file:// URI by its extension", () => {
    const p = normalizeTerminalPath("file:///D:/Coterm/.review/STATUS.md");
    expect(classifyTerminalPath(p)).toBe("artifact");
  });

  it("leaves bare paths unchanged and does not decode stray % in real filenames", () => {
    expect(normalizeTerminalPath("C:\\proj\\out.png")).toBe("C:\\proj\\out.png");
    expect(normalizeTerminalPath("D:\\a%b\\c.txt")).toBe("D:\\a%b\\c.txt");
  });

  it("matches bare absolute paths containing spaces (project root has a space)", () => {
    expect(findTerminalPaths("wrote D:\\Coterm\\out.png done").map((m) => m.path))
      .toEqual(["D:\\Coterm\\out.png"]);
    expect(findTerminalPaths("see C:\\Users\\User\\my notes.txt here").map((m) => m.path))
      .toEqual(["C:\\Users\\User\\my notes.txt"]);
  });

  it("does not let a space-containing path bleed into trailing prose", () => {
    // The first .ext ends the match; trailing words are not swallowed.
    const found = findTerminalPaths("D:\\Coterm\\out.png and some prose");
    expect(found).toHaveLength(1);
    expect(found[0]!.path).toBe("D:\\Coterm\\out.png");
  });

  it("returns the printed text length separately from the resolved path", () => {
    // Relative paths resolve to a longer absolute target; the range must be
    // sized from the PRINTED text, not the resolved path.
    const found = findTerminalPaths("open ./src/a.ts now", "D:\\proj");
    expect(found).toHaveLength(1);
    expect(found[0]!.path).toBe("D:/proj/src/a.ts");
    expect(found[0]!.index).toBe(5);
    expect(found[0]!.length).toBe("./src/a.ts".length);
  });

  it("matches underscore directory and file names", () => {
    expect(findTerminalPaths("saved C:\\a\\my_file.png done").map((m) => m.path))
      .toEqual(["C:\\a\\my_file.png"]);
    expect(findTerminalPaths("see D:\\my_dir\\out.md ok").map((m) => m.path))
      .toEqual(["D:\\my_dir\\out.md"]);
  });

  it("decodes git octal CJK path escapes into a previewable artifact", () => {
    // git (core.quotepath on, its default) escapes each UTF-8 BYTE and prints
    // Windows paths with forward slashes: 台 = U+53F0 = E5 8F B0 -> \345 \217 \260.
    const text = 'M "D:/proj/\\345\\217\\260.txt"';
    const found = findTerminalPaths(text);
    expect(found).toHaveLength(1);
    const normalized = normalizeTerminalPath(found[0]!.path);
    expect(normalized).toBe("D:/proj/台.txt");
    expect(classifyTerminalPath(normalized)).toBe("artifact");
  });

  it("keeps the full path when a folder segment contains a dot", () => {
    // The non-greedy regex truncates to D:\proj.v (external); the forward
    // walk must reach the real file for the preview to open.
    const found = findTerminalPaths("wrote D:\\proj.v2\\report.md done");
    expect(found).toHaveLength(1);
    expect(found[0]!.path).toBe("D:\\proj.v2\\report.md");
    expect(classifyTerminalPath(found[0]!.path)).toBe("artifact");
    expect(found[0]!.length).toBe("D:\\proj.v2\\report.md".length);
  });

  it("does not extend a previewable path into trailing prose", () => {
    // b.md already classifies artifact, so the walk never runs; and a dotted
    // version token after it ("1.5") is never swallowed.
    const found = findTerminalPaths("wrote D:\\a\\b.md at 1.5 pm");
    expect(found).toHaveLength(1);
    expect(found[0]!.path).toBe("D:\\a\\b.md");
  });
});

describe("terminal link cell-column mapping (underline alignment)", () => {
  it("maps a plain ASCII line 1:1", () => {
    const text = "see C:\\a\\b.txt end";
    const map = lineTextAndColumnMap(narrowCells(text));
    expect(map.text).toBe(text);
    const m = findTerminalPaths(map.text)[0]!;
    // 1-based, end inclusive: the 10-char path at string index 4 -> cols 5-14.
    expect(linkRangeForMatch(map, m.index, m.length)).toEqual({ startX: 5, endX: 14 });
  });

  it("covers the full line end when the match runs to the last character", () => {
    const map = lineTextAndColumnMap(narrowCells("C:\\a\\b.txt"));
    const m = findTerminalPaths(map.text)[0]!;
    expect(linkRangeForMatch(map, m.index, m.length)).toEqual({ startX: 1, endX: 10 });
  });

  it("shifts the range right past wide CJK characters (the misalignment bug)", () => {
    // Two wide chars before the path: 4 cells but only 2 string indexes. The
    // old index-based math put the underline two columns too far LEFT.
    const cells = [...wideCells("寫"), ...wideCells("好"), ...narrowCells(" D:\\out.png")];
    const map = lineTextAndColumnMap(cells);
    expect(map.text).toBe("寫好 D:\\out.png");
    const m = findTerminalPaths(map.text)[0]!;
    // Columns: 寫=0-1, 好=2-3, space=4, path=5-14.
    expect(linkRangeForMatch(map, m.index, m.length)).toEqual({ startX: 6, endX: 15 });
  });

  it("extends the end of the range over wide characters inside the path", () => {
    const cells = [...narrowCells("D:\\"), ...wideCells("中"), ...narrowCells("\\b.txt")];
    const map = lineTextAndColumnMap(cells);
    expect(map.text).toBe("D:\\中\\b.txt");
    const m = findTerminalPaths(map.text)[0]!;
    // 9 narrow + 1 wide = 11 cells total: cols 1-11.
    expect(linkRangeForMatch(map, m.index, m.length)).toEqual({ startX: 1, endX: 11 });
  });

  it("handles a surrogate-pair emoji before the path", () => {
    const cells = [cell("✅", 2), cell("", 0), ...narrowCells(" D:\\a.txt")];
    const map = lineTextAndColumnMap(cells);
    expect(map.text).toBe("✅ D:\\a.txt");
    const m = findTerminalPaths(map.text)[0]!;
    // emoji=cols 0-1, space=2, path=3-10 (8 cells).
    expect(linkRangeForMatch(map, m.index, m.length)).toEqual({ startX: 4, endX: 11 });
  });

  it("treats blank buffer cells as one space column, like translateToString", () => {
    const cells = [cell("a", 1), cell("", 1), ...narrowCells("D:\\x.txt")];
    const map = lineTextAndColumnMap(cells);
    expect(map.text).toBe("a D:\\x.txt");
    const m = findTerminalPaths(map.text)[0]!;
    expect(linkRangeForMatch(map, m.index, m.length)).toEqual({ startX: 3, endX: 10 });
  });

  it("sizes a relative-path link from the printed text, not the long resolved path", () => {
    const map = lineTextAndColumnMap(narrowCells("open ./src/a.ts now"));
    const m = findTerminalPaths(map.text, "D:\\proj")[0]!;
    expect(m.path.length).toBeGreaterThan(m.length);
    // Printed "./src/a.ts" at index 5 -> cols 6-15 (was often drawn past it).
    expect(linkRangeForMatch(map, m.index, m.length)).toEqual({ startX: 6, endX: 15 });
  });
});

describe("wrapped path links (multi-row ranges)", () => {
  it("joins a 2-row wrapped path across the wide-char gap cell", () => {
    // 14-col pane: the wide 寬 did not fit after "my", so xterm leaves the
    // last cell unused and prints 寬 at the start of the next row. That blank
    // must not become a space mid-path.
    const rows = [
      { cells: [...narrowCells("wrote D:\\a\\my"), cell("", 1)], row: 0, continues: true },
      { cells: [...wideCells("寬"), ...narrowCells(".png")], row: 1, continues: false },
    ];
    const map = multiRowTextAndColumnMap(rows);
    expect(map.text).toBe("wrote D:\\a\\my寬.png");
    const m = findTerminalPaths(map.text)[0]!;
    expect(m.index).toBe(6);
    expect(m.length).toBe(12);
    const range = multiRowLinkRangeForMatch(map, m.index, m.length);
    expect(range).toEqual({ start: { x: 7, y: 1 }, end: { x: 6, y: 2 } });
    // The underline covers fragments on BOTH buffer rows.
    expect(range.start.y <= 1 && 1 <= range.end.y).toBe(true);
    expect(range.start.y <= 2 && 2 <= range.end.y).toBe(true);
  });

  it("wraps a narrow path across two rows without a gap", () => {
    const rows = [
      { cells: narrowCells("wrote D:\\a\\b.t"), row: 0, continues: true },
      { cells: narrowCells("xt"), row: 1, continues: false },
    ];
    const map = multiRowTextAndColumnMap(rows);
    expect(map.text).toBe("wrote D:\\a\\b.txt");
    const m = findTerminalPaths(map.text)[0]!;
    expect(m.index).toBe(6);
    expect(m.length).toBe(10);
    expect(multiRowLinkRangeForMatch(map, m.index, m.length)).toEqual({
      start: { x: 7, y: 1 },
      end: { x: 2, y: 2 },
    });
  });

  it("wraps an underscored path across three rows and stops before prose", () => {
    const rows = [
      { cells: narrowCells("wrote D:\\a\\b\\c"), row: 0, continues: true },
      { cells: narrowCells("d\\my_file.txt "), row: 1, continues: true },
      { cells: narrowCells("here"), row: 2, continues: false },
    ];
    const map = multiRowTextAndColumnMap(rows);
    expect(map.text).toBe("wrote D:\\a\\b\\cd\\my_file.txt here");
    const m = findTerminalPaths(map.text)[0]!;
    expect(m.index).toBe(6);
    expect(m.length).toBe("D:\\a\\b\\cd\\my_file.txt".length);
    const range = multiRowLinkRangeForMatch(map, m.index, m.length);
    expect(range).toEqual({ start: { x: 7, y: 1 }, end: { x: 13, y: 2 } });
    // The link does not reach the words after the path.
    expect(range.start.y <= 2 && 2 <= range.end.y).toBe(true);
  });

  it("keeps real trailing blanks on a non-continuing row", () => {
    const rows = [
      { cells: [...narrowCells("C:\\a\\b.txt"), cell("", 1), cell("", 1), cell("", 1), cell("", 1)], row: 0, continues: false },
    ];
    const map = multiRowTextAndColumnMap(rows);
    expect(map.text).toBe("C:\\a\\b.txt    ");
    const m = findTerminalPaths(map.text)[0]!;
    expect(multiRowLinkRangeForMatch(map, m.index, m.length)).toEqual({
      start: { x: 1, y: 1 },
      end: { x: 10, y: 1 },
    });
  });

  it("maps CJK characters directly before the drive letter", () => {
    const rows = [
      {
        cells: [...wideCells("存"), ...wideCells("到"), ...narrowCells("D:\\x\\y.png")],
        row: 0,
        continues: false,
      },
    ];
    const map = multiRowTextAndColumnMap(rows);
    expect(map.text).toBe("存到D:\\x\\y.png");
    const m = findTerminalPaths(map.text)[0]!;
    expect(m.index).toBe(2);
    expect(m.length).toBe(10);
    expect(multiRowLinkRangeForMatch(map, m.index, m.length)).toEqual({
      start: { x: 5, y: 1 },
      end: { x: 14, y: 1 },
    });
  });

  it("maps a full-width colon prefix before the drive letter", () => {
    const rows = [
      {
        cells: [
          ...wideCells("截"),
          ...wideCells("圖"),
          ...wideCells("："),
          ...narrowCells("D:\\a b\\c_d.png"),
        ],
        row: 0,
        continues: false,
      },
    ];
    const map = multiRowTextAndColumnMap(rows);
    expect(map.text).toBe("截圖：D:\\a b\\c_d.png");
    const m = findTerminalPaths(map.text)[0]!;
    expect(m.index).toBe(3);
    expect(m.length).toBe(14);
    expect(multiRowLinkRangeForMatch(map, m.index, m.length)).toEqual({
      start: { x: 7, y: 1 },
      end: { x: 20, y: 1 },
    });
  });

  it("maps an emoji directly before the drive letter", () => {
    const rows = [
      {
        cells: [cell("📸", 2), cell("", 0), ...narrowCells("D:\\a.png")],
        row: 0,
        continues: false,
      },
    ];
    const map = multiRowTextAndColumnMap(rows);
    expect(map.text).toBe("📸D:\\a.png");
    const m = findTerminalPaths(map.text)[0]!;
    expect(m.index).toBe(2);
    expect(m.length).toBe(8);
    expect(multiRowLinkRangeForMatch(map, m.index, m.length)).toEqual({
      start: { x: 3, y: 1 },
      end: { x: 10, y: 1 },
    });
  });

  it("matches a cell-walked line wrapped in full-width brackets", () => {
    const rows = [
      {
        cells: [...wideCells("（"), ...narrowCells("D:\\a\\b.png"), ...wideCells("）")],
        row: 0,
        continues: false,
      },
    ];
    const map = multiRowTextAndColumnMap(rows);
    expect(map.text).toBe("（D:\\a\\b.png）");
    const m = findTerminalPaths(map.text)[0]!;
    expect(m.index).toBe(1);
    expect(m.length).toBe(10);
    expect(multiRowLinkRangeForMatch(map, m.index, m.length)).toEqual({
      start: { x: 3, y: 1 },
      end: { x: 12, y: 1 },
    });
  });

  it("combines a CJK prefix with a wrapped long path", () => {
    const rows = [
      {
        cells: [...wideCells("存"), ...wideCells("到"), ...narrowCells("D:\\proj\\out\\n")],
        row: 0,
        continues: true,
      },
      { cells: narrowCells("otes_summary.md"), row: 1, continues: false },
    ];
    const map = multiRowTextAndColumnMap(rows);
    expect(map.text).toBe("存到D:\\proj\\out\\notes_summary.md");
    const m = findTerminalPaths(map.text)[0]!;
    expect(m.index).toBe(2);
    expect(m.length).toBe("D:\\proj\\out\\notes_summary.md".length);
    expect(multiRowLinkRangeForMatch(map, m.index, m.length)).toEqual({
      start: { x: 5, y: 1 },
      end: { x: 15, y: 2 },
    });
  });

  it("stops bare paths at full-width punctuation", () => {
    expect(findTerminalPaths("D:\\a\\b.png，然後").map((m) => m.path)).toEqual(["D:\\a\\b.png"]);
    expect(findTerminalPaths("D:\\a\\b.log。行").map((m) => m.path)).toEqual(["D:\\a\\b.log"]);
    expect(findTerminalPaths("（D:\\a\\b.png）").map((m) => m.path)).toEqual(["D:\\a\\b.png"]);
  });
});

describe("path detection tightening (only real paths get underlined)", () => {
  const CWD = "D:\\proj";

  it("links extension-less Windows absolute paths (drive + segments)", () => {
    expect(findTerminalPaths("cd D:\\workspace\\app").map((m) => m.path))
      .toEqual(["D:\\workspace\\app"]);
    expect(findTerminalPaths("cd D:/workspace/app").map((m) => m.path))
      .toEqual(["D:/workspace/app"]);
  });

  it("links UNC paths with and without an extension", () => {
    expect(findTerminalPaths("open \\\\nas\\share\\tool.exe").map((m) => m.path))
      .toEqual(["\\\\nas\\share\\tool.exe"]);
    expect(findTerminalPaths("open \\\\wsl$\\Ubuntu\\home\\me").map((m) => m.path))
      .toEqual(["\\\\wsl$\\Ubuntu\\home\\me"]);
  });

  it("links ~/ home-alias paths with and without an extension", () => {
    expect(findTerminalPaths("see ~/notes/todo.md").map((m) => m.path))
      .toEqual(["~/notes/todo.md"]);
    expect(findTerminalPaths("run ~/bin/tool").map((m) => m.path))
      .toEqual(["~/bin/tool"]);
  });

  it("links explicit ./ and ../ prefixes without requiring an extension", () => {
    expect(findTerminalPaths("cd ../shared", CWD).map((m) => m.path))
      .toEqual(["D:/shared"]);
    expect(findTerminalPaths("./bin/tool", CWD).map((m) => m.path))
      .toEqual(["D:/proj/bin/tool"]);
  });

  it("links relative paths with a separator and a file extension under the cwd", () => {
    const found = findTerminalPaths("edited src/components/TerminalDock.tsx", CWD);
    expect(found).toHaveLength(1);
    expect(found[0]!.path).toBe("D:/proj/src/components/TerminalDock.tsx");
  });

  it("never underlines words, sentences, table borders, URLs, versions, models, numbers, hashes or branch names", () => {
    const noise = [
      "hello world",
      "這是一段中文句子，沒有任何路徑。",
      "│ name │ size │",
      "┌──────┬──────┐",
      "https://example.com/a.png",
      "http://localhost:3000/x.ts",
      "v0.7.58",
      "my-glm",
      "claude-sonnet-4-6",
      "150.9k",
      "1M",
      "42",
      "3.14",
      "c2c8bb9",
      "feat/20261012-008-tess-spike",
      "user@host:/tmp/a.ts",
      "@scope/pkg/index.js",
    ];
    for (const text of noise) {
      expect(findTerminalPaths(text, CWD), text).toEqual([]);
      expect(findTerminalPaths(text), text).toEqual([]);
    }
  });
});

describe("path boundaries against CJK text and punctuation", () => {
  it("covers only the path when CJK punctuation hugs it (no extension)", () => {
    const found = findTerminalPaths("worktree「D:\\workspace\\app-desktop-wt\\008」，分支");
    expect(found).toHaveLength(1);
    expect(found[0]!.path).toBe("D:\\workspace\\app-desktop-wt\\008");
  });

  it("stops an extension-anchored path before trailing CJK prose", () => {
    expect(findTerminalPaths("檔案D:\\a\\b.ts已改").map((m) => m.path))
      .toEqual(["D:\\a\\b.ts"]);
  });

  it("ends an extension-less path where trailing CJK prose begins", () => {
    expect(findTerminalPaths("開啟D:\\workspace\\app執行中").map((m) => m.path))
      .toEqual(["D:\\workspace\\app"]);
  });

  it("ends a relative path where trailing CJK prose begins", () => {
    const found = findTerminalPaths("打開 src/foo.ts 完成", "D:\\proj");
    expect(found).toHaveLength(1);
    expect(found[0]!.path).toBe("D:/proj/src/foo.ts");
    expect(found[0]!.length).toBe("src/foo.ts".length);
  });

  it("does not absorb a CJK word glued onto an ASCII relative path", () => {
    // 開啟src/foo.ts reads as "open src/foo.ts" — conservative call: no link,
    // because an extension-less-anchored match cannot tell 開啟src (prose)
    // from 資料/夾 (a real CJK directory).
    expect(findTerminalPaths("開啟src/foo.ts執行中", "D:\\proj")).toEqual([]);
    // …but a CJK-prefixed path with a clean boundary still links.
    expect(findTerminalPaths("寫好 src/foo.ts", "D:\\proj").map((m) => m.path))
      .toEqual(["D:/proj/src/foo.ts"]);
  });

  it("strips surrounding backticks, quotes and full-width brackets", () => {
    expect(findTerminalPaths("`D:\\workspace\\app`").map((m) => m.path))
      .toEqual(["D:\\workspace\\app"]);
    expect(findTerminalPaths('"D:\\workspace\\app"').map((m) => m.path))
      .toEqual(["D:\\workspace\\app"]);
    expect(findTerminalPaths("（D:\\workspace\\app）").map((m) => m.path))
      .toEqual(["D:\\workspace\\app"]);
  });

  it("trims a sentence period after an extension-less path", () => {
    expect(findTerminalPaths("路徑是 D:\\workspace\\app.").map((m) => m.path))
      .toEqual(["D:\\workspace\\app"]);
  });
});

describe("wrapped and hard-newline path boundaries", () => {
  it("underlines both segments of an extension-less path wrapped across rows", () => {
    const rows = [
      { cells: narrowCells("wrote D:\\workspace\\ap"), row: 0, continues: true },
      { cells: narrowCells("p-desktop-wt"), row: 1, continues: false },
    ];
    const map = multiRowTextAndColumnMap(rows);
    expect(map.text).toBe("wrote D:\\workspace\\app-desktop-wt");
    const m = findTerminalPaths(map.text)[0]!;
    expect(m.path).toBe("D:\\workspace\\app-desktop-wt");
    expect(m.index).toBe(6);
    const range = multiRowLinkRangeForMatch(map, m.index, m.length);
    expect(range).toEqual({ start: { x: 7, y: 1 }, end: { x: 12, y: 2 } });
    // The underline touches both buffer rows.
    expect(range.start.y <= 1 && 1 <= range.end.y).toBe(true);
    expect(range.start.y <= 2 && 2 <= range.end.y).toBe(true);
  });

  it("never spans a hard newline (CR/LF is not a path character)", () => {
    const found = findTerminalPaths("D:\\a\\b\r\nnext D:\\c\\d.txt");
    expect(found.map((m) => m.path)).toEqual(["D:\\a\\b", "D:\\c\\d.txt"]);
  });

  it("maps an extension-less path after CJK columns to the right cells", () => {
    const cells = [
      ...wideCells("截"),
      ...wideCells("圖"),
      ...wideCells("："),
      ...narrowCells("D:\\workspace\\app"),
    ];
    const map = lineTextAndColumnMap(cells);
    expect(map.text).toBe("截圖：D:\\workspace\\app");
    const m = findTerminalPaths(map.text)[0]!;
    expect(m.index).toBe(3);
    expect(m.length).toBe(16);
    // 截=0-1,圖=2-3,：=4-5, path=cols 6-21.
    expect(linkRangeForMatch(map, m.index, m.length)).toEqual({ startX: 7, endX: 22 });
  });
});

describe("deep path in a dotted folder (built-app repro)", () => {

  const PATH =
    "D:\\Coterm\\.png-repro-scratch\\deep_folder_name\\another_sub_dir\\some_long_file_name_with_underscores_v2.png";

  it("matches a 100+ char path whose folder begins with a known extension", () => {
    const map = multiRowTextAndColumnMap([
      { cells: narrowCells(`wrote ${PATH}`), row: 0, continues: false },
    ]);
    const matches = findTerminalPaths(map.text);
    expect(matches.length).toBe(1);
    expect(matches[0]!.path).toBe(PATH);
  });

  it("historic case: dotted folder with an external-looking tail reaches the real file", () => {
    const matches = findTerminalPaths("wrote D:\\proj.v2\\report.md");
    expect(matches.map((m) => m.path)).toEqual(["D:\\proj.v2\\report.md"]);
  });

  it("sentence dot after the extension still ends the link", () => {
    const matches = findTerminalPaths("saved to C:\\a.png. Next");
    expect(matches.map((m) => m.path)).toEqual(["C:\\a.png"]);
  });

  it("sweeps a 36-col wrapped render at every start offset", () => {
    const COLS = 36;
    for (let prefixLen = 0; prefixLen <= COLS; prefixLen += 1) {
      const full = `${"w".repeat(prefixLen)} ${PATH}`;
      const rows: TerminalLogicalRow[] = [];
      for (let start = 0; start < full.length; start += COLS) {
        const chunk = full.slice(start, start + COLS);
        const atEnd = start + COLS >= full.length;
        rows.push({ cells: narrowCells(chunk), row: rows.length, continues: !atEnd });
      }
      const map = multiRowTextAndColumnMap(rows);
      expect(map.text, `join lossy at prefix ${prefixLen}`).toBe(full);
      const matches = findTerminalPaths(map.text);
      expect(matches.length, `match count at prefix ${prefixLen}`).toBe(1);
      expect(matches[0]!.path, `path at prefix ${prefixLen}`).toBe(PATH);
    }
  });

  it("sweeps with a wide CJK prose char straddling the pane edge", () => {
    const full = `${"x".repeat(35)}已 ${PATH}`;
    const rows = [
      { cells: [...narrowCells("x".repeat(35)), cell("", 1)], row: 0, continues: true },
      { cells: [...wideCells("已"), ...narrowCells(` ${PATH}`)], row: 1, continues: false },
    ];
    const map = multiRowTextAndColumnMap(rows);
    expect(map.text).toBe(full);
    const matches = findTerminalPaths(map.text);
    expect(matches.length).toBe(1);
    expect(matches[0]!.path).toBe(PATH);
  });
});

describe("web page / html file links", () => {
  const CWD = "D:\\proj";

  it("underlines absolute .html/.htm paths as previewable artifacts", () => {
    expect(findTerminalPaths("see D:\\docs\\guide.html done").map((m) => m.path))
      .toEqual(["D:\\docs\\guide.html"]);
    expect(classifyTerminalPath("D:\\docs\\guide.html")).toBe("artifact");
    expect(findTerminalPaths("see C:\\tmp\\page.htm ok").map((m) => m.path))
      .toEqual(["C:\\tmp\\page.htm"]);
    expect(classifyTerminalPath("C:\\tmp\\page.htm")).toBe("artifact");
  });

  it("underlines only the path part of an absolute path with #anchor or ?query", () => {
    const anchored = findTerminalPaths("open D:\\docs\\guide.html#install next");
    expect(anchored).toHaveLength(1);
    expect(anchored[0]!.path).toBe("D:\\docs\\guide.html");

    const queried = findTerminalPaths("open D:\\docs\\guide.html?tab=2 next");
    expect(queried).toHaveLength(1);
    expect(queried[0]!.path).toBe("D:\\docs\\guide.html");
  });

  it("underlines relative .html paths under the cwd, anchor/query excluded", () => {
    const plain = findTerminalPaths("open docs/guide.html now", CWD);
    expect(plain.map((m) => m.path)).toEqual(["D:/proj/docs/guide.html"]);

    const anchored = findTerminalPaths("open docs/guide.html#usage now", CWD);
    expect(anchored).toHaveLength(1);
    expect(anchored[0]!.path).toBe("D:/proj/docs/guide.html");
    expect(anchored[0]!.length).toBe("docs/guide.html".length);
  });

  it("underlines the path part of a file:/// URI and strips #anchor/?query on match", () => {
    const anchored = findTerminalPaths("see file:///D:/x/index.html#top here");
    expect(anchored).toHaveLength(1);
    expect(anchored[0]!.path).toBe("file:///D:/x/index.html");
    expect(normalizeTerminalPath(anchored[0]!.path)).toBe("D:/x/index.html");

    const queried = findTerminalPaths("see file:///D:/x/index.html?v=1 here");
    expect(queried).toHaveLength(1);
    expect(queried[0]!.path).toBe("file:///D:/x/index.html");

    // An encoded %23 inside the filename is still part of the path.
    const encoded = findTerminalPaths("see file:///D:/x/a%23b.html here");
    expect(encoded).toHaveLength(1);
    expect(normalizeTerminalPath(encoded[0]!.path)).toBe("D:/x/a#b.html");
  });
});

describe("real web URLs are never split into a file-path underline", () => {
  const CWD = "D:\\proj";

  it("matches nothing inside http(s) URLs, with or without a cwd", () => {
    const urls = [
      "https://github.com/kbwo/ccmanager",
      "https://github.com/kbwo/ccmanager/blob/main/README.md",
      "http://localhost:5173/index.html",
      "http://localhost/index.html",
      "http://127.0.0.1:43127/api",
      "https://example.com/docs/v1.2/guide.html",
      "https://example.com/a?x=1#top",
    ];
    for (const text of urls) {
      expect(findTerminalPaths(text), text).toEqual([]);
      expect(findTerminalPaths(text, CWD), text).toEqual([]);
    }
  });

  it("a markdown link to a web URL gets no partial path underline", () => {
    expect(findTerminalPaths("[text](https://example.com/docs/x.md)", CWD)).toEqual([]);
    expect(findTerminalPaths("[text]\uFF08https://example.com/a.html\uFF09", CWD)).toEqual([]);
  });

  it("a markdown link to a relative path still links the path", () => {
    const found = findTerminalPaths("[a](./docs/x.md)", CWD);
    expect(found).toHaveLength(1);
    expect(found[0]!.path).toBe("D:/proj/docs/x.md");
    expect(found[0]!.length).toBe("./docs/x.md".length);
  });

  it("a URL on the same line never steals the real path's span", () => {
    const found = findTerminalPaths("open https://example.com/a.png and D:\\a\\b.png done", CWD);
    expect(found).toHaveLength(1);
    expect(found[0]!.path).toBe("D:\\a\\b.png");
  });

  it("a URL wrapped across rows still yields no partial path underline", () => {
    const url = "https://example.com/some/really/long/path/to/guide.html";
    const COLS = 30;
    const rows: TerminalLogicalRow[] = [];
    for (let start = 0; start < url.length; start += COLS) {
      const chunk = url.slice(start, start + COLS);
      rows.push({ cells: narrowCells(chunk), row: rows.length, continues: start + COLS < url.length });
    }
    const map = multiRowTextAndColumnMap(rows);
    expect(map.text).toBe(url);
    expect(findTerminalPaths(map.text, CWD)).toEqual([]);
  });
});

describe("web URL regex (underline covers the full URL, punctuation/CJK ends it)", () => {
  const urlsIn = (text: string): string[] => text.match(WEB_URL_REGEX) ?? [];

  it("matches one link covering the full URL", () => {
    expect(urlsIn("see https://github.com/kbwo/ccmanager ok"))
      .toEqual(["https://github.com/kbwo/ccmanager"]);
    expect(urlsIn("see http://localhost:5173/index.html ok"))
      .toEqual(["http://localhost:5173/index.html"]);
    expect(urlsIn("see http://127.0.0.1:43127/api ok"))
      .toEqual(["http://127.0.0.1:43127/api"]);
  });

  it("keeps ?query and #anchor inside a web URL", () => {
    expect(urlsIn("https://example.com/a?x=1#top end"))
      .toEqual(["https://example.com/a?x=1#top"]);
  });

  it("trailing CJK letters and punctuation end the URL", () => {
    expect(urlsIn("https://example.com/a.png\u3002\u4E0B\u4E00\u884C"))
      .toEqual(["https://example.com/a.png"]);
    expect(urlsIn("\u53C3\u8003https://example.com/x\uFF0C\u8B1D\u8B1D"))
      .toEqual(["https://example.com/x"]);
    expect(urlsIn("https://example.com/a\u300D\uFF0Cbranch"))
      .toEqual(["https://example.com/a"]);
    expect(urlsIn("\uFF08https://example.com/a\uFF09"))
      .toEqual(["https://example.com/a"]);
  });

  it("trailing ASCII sentence punctuation ends the URL (mid-URL punctuation stays)", () => {
    // A trailing sentence comma/period/semicolon is prose, not URL — the
    // last-char class drops it. Mid-URL commas stay: a,b is legal in URLs.
    expect(urlsIn("see https://example.com/a,b next")).toHaveLength(1);
    expect(urlsIn("see https://example.com/a, next"))
      .toEqual(["https://example.com/a"]);
    expect(urlsIn("see https://example.com/a. next"))
      .toEqual(["https://example.com/a"]);
    expect(urlsIn("see https://example.com/a; next"))
      .toEqual(["https://example.com/a"]);
  });

  it("markdown link and backtick wrappers stay outside the span", () => {
    expect(urlsIn("[text](https://example.com/a)"))
      .toEqual(["https://example.com/a"]);
    expect(urlsIn("`https://example.com/a`"))
      .toEqual(["https://example.com/a"]);
  });

  it("a URL wrapped across rows is matched whole by the addon's joined text", () => {
    const url = "https://example.com/some/really/long/path/to/guide.html";
    const COLS = 30;
    const rows: TerminalLogicalRow[] = [];
    for (let start = 0; start < url.length; start += COLS) {
      const chunk = url.slice(start, start + COLS);
      rows.push({ cells: narrowCells(chunk), row: rows.length, continues: start + COLS < url.length });
    }
    expect(urlsIn(multiRowTextAndColumnMap(rows).text)).toEqual([url]);
  });

  it("never matches scheme-less words, emails, or scoped package names", () => {
    for (const text of ["example.com", "node.js", "index.html", "user@example.com", "@scope/pkg"]) {
      expect(urlsIn(text), text).toEqual([]);
    }
  });

  it("index.html alone without a separator has no file-path link either", () => {
    expect(findTerminalPaths("index.html", "D:\\proj")).toEqual([]);
    expect(findTerminalPaths("example.com node.js", "D:\\proj")).toEqual([]);
  });
});

describe("findTerminalLinks (unified URL + path scan)", () => {
  it("detects the hard-wrapped CJK-prefixed path from the user repro", () => {
    // Ink hard wrap: the rows are NOT isWrapped; TerminalDock's logical-line
    // walk marks them continues:true once rowHardWrapsInto fires, so the
    // matcher sees the joined text. Full-width colon ： separates the prefix.
    const first = "網站新入口：D:\\workspace\\trade\\MY_RESEARCH\\research\\strategy_observatory_20261021\\OBSE";
    const rows: TerminalLogicalRow[] = [
      { cells: [...wideCells("網"), ...wideCells("站"), ...wideCells("新"), ...wideCells("入"), ...wideCells("口"), ...wideCells("："), ...narrowCells("D:\\workspace\\trade\\MY_RESEARCH\\research\\strategy_observatory_20261021\\OBSE")], row: 0, continues: true },
      { cells: narrowCells("RVATORY_20261022.html"), row: 1, continues: false },
    ];
    const map = multiRowTextAndColumnMap(rows);
    expect(map.text).toBe(`${first}RVATORY_20261022.html`);
    const links = findTerminalLinks(map.text);
    expect(links).toHaveLength(1);
    expect(links[0]!.kind).toBe("path");
    expect(links[0]!.path).toBe("D:\\workspace\\trade\\MY_RESEARCH\\research\\strategy_observatory_20261021\\OBSERVATORY_20261022.html");
    // The range spans both buffer rows so xterm underlines & click-tests both.
    const range = multiRowLinkRangeForMatch(map, links[0]!.index, links[0]!.length);
    expect(range.start.y).toBe(1);
    expect(range.end.y).toBe(2);
    expect(range.start.x).toBe(13); // 6 wide chars = 12 columns, path starts col 13 (1-based)
    expect(range.end.x).toBe("RVATORY_20261022.html".length);
  });

  it("detects a hard-wrapped URL across rows and kinds it url", () => {
    const url = "https://example.com/reports/strategy_observatory_20261021/OBSERVATORY_20261022.html";
    const COLS = 30;
    const rows: TerminalLogicalRow[] = [];
    for (let start = 0; start < url.length; start += COLS) {
      rows.push({ cells: narrowCells(url.slice(start, start + COLS)), row: rows.length, continues: start + COLS < url.length });
    }
    const links = findTerminalLinks(multiRowTextAndColumnMap(rows).text);
    expect(links).toHaveLength(1);
    expect(links[0]!.kind).toBe("url");
    expect(links[0]!.path).toBe(url);
  });

  it("never double-matches a path-looking fragment inside a claimed URL", () => {
    const links = findTerminalLinks("open https://files.example.com/D:/work/out.html now");
    expect(links).toHaveLength(1);
    expect(links[0]!.kind).toBe("url");
  });

  it("keeps path and url links side by side on one line", () => {
    const links = findTerminalLinks("wrote D:\\proj\\out.md then https://example.com/x done");
    expect(links.map((l) => `${l.kind}:${l.path}`)).toEqual([
      "path:D:\\proj\\out.md",
      "url:https://example.com/x",
    ]);
  });
});
