// C2: pure helpers for clickable file paths in terminal output. Kept DOM-free
// so the path matcher (a security-adjacent parser) is unit-testable without the
// xterm/React baggage of TerminalDock.

// Extensions readArtifact can preview (app-operations.ts) -> open the in-app
// artifact panel; anything else -> open externally via the main process.
export const ARTIFACT_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm", ".ogv", ".pdf",
  ".csv", ".md", ".markdown", ".html", ".htm", ".js", ".jsx", ".ts", ".tsx",
  ".json", ".css", ".py", ".ps1", ".sh", ".sql", ".yaml", ".yml", ".xml",
  ".svg", ".txt", ".log", ".diff", ".patch",
]);

// CJK sentence punctuation, full-width forms and curly quotes - never part of
// a path span, even though CJK LETTERS legitimately are (D:\中\b.txt).
// Excluding these is what stops a path from swallowing the CJK punctuation
// that encloses it (worktree「D:\...」，分支).
const EXCLUDED_SPAN = "\\u2018-\\u201F\\u3000-\\u303F\\uFF00-\\uFF65";

// Span class for EXTENSION-ANCHORED matches: whitespace stays allowed (this
// project's root `D:\Coterm` and many user paths have spaces; the
// trailing `.ext` is the boundary) but quotes/brackets/pipes/backticks,
// hard newlines (a hard newline ALWAYS ends a path - only soft-wraps join)
// and CJK sentence punctuation are excluded.
const EXT_SPAN_CLASS = `[^\\r\\n"'<>|()\`${EXCLUDED_SPAN}]`;

// Segment class for EXTENSION-LESS confident forms (bare absolute, UNC, ~/).
// Without a `.ext` boundary the span must be unambiguous, so only ASCII
// filename chars are allowed: no whitespace (a space here reads as the start
// of prose), no CJK letters (trailing text in another language ends the
// path), no sentence punctuation. The match's trailing dot run is trimmed
// separately, since the class includes '.' itself.
const SEGMENT_CLASS = "[A-Za-z0-9._~+#=%$&@-]";

// Absolute Windows path ending in a `.ext`. ponytail: drive-letter paths only
// (agent CLIs on this Windows app emit those); POSIX-absolute is not linked —
// it over-matches prose. The lookbehind rejects URL schemes (the `s:/` inside
// `https://`) — only a real drive letter (start-of-token, not preceded by a
// letter) qualifies. The trailing `.ext` is anchored at the token end: a
// lookahead requires a non-path character (or end of string) right after,
// otherwise a folder segment merely BEGINNING with a known extension (e.g.
// `.png-repro-scratch`) would truncate the match at that first dot. The third
// alternative keeps the sentence case working (`C:\a.png. Next` still links
// as `C:\a.png`: a dot followed by whitespace/end reads as a sentence period).
const TERMINAL_PATH_RE = new RegExp(
  `(?<![A-Za-z])[A-Za-z]:[\\\\/]${EXT_SPAN_CLASS}*?\\.[A-Za-z0-9]+(?=$|[^A-Za-z0-9._\\-\\\\/]|\\.(\\s|$))`,
  "g",
);

// file:// URI agent CLIs emit when the path contains spaces (e.g.
// file:///D:/Coterm/.review/STATUS.md). Kept separate from the bare-path
// regex so %20 stays intact for decodeURIComponent. Three slashes on Windows:
// file:/// + D:/... A raw `#`/`?` is a URI fragment/query delimiter (a real
// filename holding one must encode it as %23/%3F), so the span stops there —
// the link underlines the path part only and resolves correctly.
const FILE_URI_RE = /file:\/\/\/[^\s"'<>|()#?]+/g;

// Real web URLs. Passed to WebLinksAddon as { urlRegex } in TerminalDock.tsx
// (click -> external browser is the addon's existing job; only `file:///`
// URIs reroute to the in-app artifact panel). Same shape as the addon's own
// default — scheme + a body class + a stricter last-char class — but the
// body ALSO excludes CJK letters and CJK sentence punctuation: 參考https://x.io/a，好
// underlines only the URL, where the stock regex would swallow the trailing
// Chinese sentence. Trailing ASCII sentence punctuation (,.!?:) likewise ends
// the link, and the `(...)` / `[...](url)` / `\\`url\\`` brackets/quotes never
// enter the span. A single link covers the FULL URL — the file-path passes
// above never match inside it, so no fragment gets a second underline.
const WEB_URL_EXCLUDED =
  "\\s\"'!*(){}|\\\\\\^<>`" +
  EXCLUDED_SPAN +
  "\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\u3040-\\u30FF\\uAC00-\\uD7AF";
export const WEB_URL_REGEX = new RegExp(
  `https?:[/]{2}[^${WEB_URL_EXCLUDED}]*[^${WEB_URL_EXCLUDED}:,.!?~\\[\\];]`,
  "gi",
);

// Extension-less absolute Windows path (a DIRECTORY like D:\workspace\app, or
// a file with no dot). Confident by shape: drive letter + separator +
// ASCII-only segments. CJK text and punctuation abutting either end stop the
// match (「D:\a\b」，分支 links only D:\a\b). The lookbehind keeps the drive
// out of URLs and out of the middle of tokens.
const BARE_ABSOLUTE_PATH_RE = new RegExp(
  `(?<![A-Za-z0-9:\\\\/])[A-Za-z]:[\\\\/]${SEGMENT_CLASS}+(?:[\\\\/]${SEGMENT_CLASS}+)*`,
  "g",
);

// UNC path: \\server\share[\file[.ext]] — extension optional, same ASCII-only
// segments as bare absolutes. Requires at least a server and a share segment.
const UNC_PATH_RE = new RegExp(
  `(?<![A-Za-z0-9\\\\/])\\\\\\\\${SEGMENT_CLASS}+(?:[\\\\/]${SEGMENT_CLASS}+)+`,
  "g",
);

// Home-aliased path: ~/... or ~\... — extension optional. The alias is
// expanded to the real home directory main-side (path-policy expandHomeAlias)
// when the link is clicked.
const HOME_PATH_RE = new RegExp(
  `(?<![\\w.~%+\\-\\\\/:@#])~[\\\\/]${SEGMENT_CLASS}+(?:[\\\\/]${SEGMENT_CLASS}+)*`,
  "g",
);

// Relative path ending in a `.ext`: `./...`, `../...`, or `name/name...ext`.
// The extension (or an explicit ./ ../ prefix shape printed as such) is NOT
// optional here: an extension-less `feat/2026-branch` fragment is a branch
// name as often as it is a file, and there is no fs-stat IPC the renderer can
// consult synchronously (provideLinks is sync), so the conservative call is
// syntax-only. SEGMENTS may contain CJK letters but no ':' or '@' — excluding
// the colon plus the left-boundary lookbehind (previous char must not be a
// path/word char) is what keeps https://example.com/a.png, scp-style
// user@host:/x/y.ts and scoped npm names (@scope/pkg/x.js) from linking when
// a cwd is present. The lookbehind ALSO rejects CJK letters: an ASCII
// relative path glued onto a CJK word (開啟src/foo.ts = "open src/foo.ts")
// is prose, and without the CJK rejection the match would absorb the Chinese
// word into the underline (drive letters don't need this — the [A-Za-z]:
// anchor is distinctive enough that 檔案D:\a\b.ts still links).
// Only matched when findTerminalPaths is given a cwd to resolve against.
// POSIX or Windows separators.
const RELATIVE_LEFT_BOUNDARY =
  "(?<![\\w.~%+\\-\\\\/:@#\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\u3040-\\u30FF\\uAC00-\\uD7AF])";

// A relative span that fuses a CJK letter with an ASCII letter/digit in one
// token (開啟src = "open src") is prose glued onto a path, not a path. The
// lookbehind above only catches glue when a character PRECEDES the match; at
// line start nothing precedes it, so the span itself must be checked. The
// cost — real filenames like 資料v2 lose their relative link — is the
// conservative price of killing the 開啟src/foo.ts underlines.
const GLUED_CJK_ASCII_RE =
  /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯][A-Za-z0-9]|[A-Za-z0-9][㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/;
const RELATIVE_PATH_RE = new RegExp(
  `${RELATIVE_LEFT_BOUNDARY}(?:\\.{1,2}[\\\\/]|[^\\s"'<>|()\`:@${EXCLUDED_SPAN}]*[\\\\/])[^\\s"'<>|()\`:@${EXCLUDED_SPAN}]*?\\.[A-Za-z0-9]+(?=$|[^A-Za-z0-9._\\-\\\\/]|\\.(\\s|$))`,
  "g",
);

// Explicit `./x` / `../x` forms link without an extension: the leading dots
// make the intent unmistakable, unlike a bare `name/name` fragment (a branch
// name like feat/2026-fix is NOT a path). ASCII-only segments, same rule as
// bare absolutes. Requires a cwd to resolve against.
const RELATIVE_PREFIX_PATH_RE = new RegExp(
  `(?<![\\w.~%+\\-\\\\/:@#])\\.{1,2}[\\\\/]${SEGMENT_CLASS}+(?:[\\\\/]${SEGMENT_CLASS}+)*`,
  "g",
);

// Resolve a relative terminal path against the PTY's spawn cwd into an absolute
// Windows path. Renderer is browser-side (no node:path, no path-browserify dep),
// so this is a minimal hand-rolled resolve: normalize separators, split, drop
// `.`, pop on `..`, append the rest onto cwd.
// ponytail: ceiling — cwd is the PTY's SPAWN cwd (pty-manager writes it once at
// create, never updates on `cd`). If the user cd'd into a subdir, a `src/...`
// link resolves against the spawn root, not the current dir. Acceptable: agent
// CLIs run at project root. Upgrade path: query the PTY pid's live cwd via IPC.
export function resolveRelativePath(cwd: string, raw: string): string {
  const norm = raw.replace(/\\/g, "/");
  const parts = norm.split("/").filter((p) => p.length > 0);
  const stack = cwd.replace(/\\/g, "/").split("/").filter((p) => p.length > 0);
  // cwd like "D:/proj" -> ["D:", "proj"]; keep drive letter as-is.
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") { if (stack.length > 1) stack.pop(); continue; }
    stack.push(part);
  }
  const drive = stack[0];
  const rest = stack.slice(1).join("/");
  return rest ? `${drive}/${rest}` : `${drive}/`;
}

// git prints non-ASCII paths C-quoted, escaping each UTF-8 BYTE as \NNN, when
// core.quotepath is on — which is git's DEFAULT. So `git status` in a repo with
// a Chinese folder prints "D:\proj\345\217\260...\x.txt" instead of the real
// path, and the printed link used to resolve to a directory that does not exist
// (issue #88).
//
// Single pass on purpose: `\NNN` and `\\` are alternatives of ONE regex, so a
// backslash that came from unescaping `\\` can never be re-read as the start of
// an octal escape. Two chained String.replace calls get this wrong — `\\123`
// collapses to `\123` and then decodes as the single byte "S".
const GIT_ESCAPE_RE = /\\([0-7]{3})|\\\\/g;

/**
 * Decode git's octal path escaping. Returns the input unchanged when there is
 * nothing to decode, or when the result is not valid UTF-8 — git escapes byte
 * by byte, so a real non-UTF-8 (e.g. latin1) filename must survive untouched
 * rather than turn into replacement characters.
 */
export function decodeGitOctalEscapes(raw: string): string {
  if (!raw.includes("\\")) return raw;
  const latin1 = raw.replace(GIT_ESCAPE_RE, (_match, oct: string | undefined) =>
    oct === undefined ? "\\" : String.fromCharCode(parseInt(oct, 8)));
  if (latin1 === raw) return raw;
  try {
    // TextDecoder, not Buffer: this module runs in the renderer bundle
    // (browser context), where Buffer is undefined. fatal:true makes an invalid
    // byte sequence throw instead of silently producing U+FFFD, so the caller
    // keeps the original path for a genuinely non-UTF-8 filename.
    const bytes = new Uint8Array(latin1.length);
    for (let i = 0; i < latin1.length; i += 1) bytes[i] = latin1.charCodeAt(i) & 0xff;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return raw;
  }
}

// Normalize a matched terminal path to a real OS path the main process can
// stat. file:// URIs get decoded (%20 -> space); git C-quoted paths get their
// octal escapes decoded (issue #88); bare paths pass through. Decoding is
// scoped to those two shapes so a real filename containing '%' or a literal
// backslash escape is never misread. assertAllowedPath (path-policy.ts) does
// NOT decode, so this must happen renderer-side before
// openArtifact/openArtifactExternal.
export function normalizeTerminalPath(raw: string): string {
  if (raw.toLowerCase().startsWith("file:///")) {
    const stripped = raw.slice("file:///".length);
    try {
      return decodeURIComponent(stripped);
    } catch {
      return stripped;
    }
  }
  return decodeGitOctalEscapes(raw);
}

export function classifyTerminalPath(path: string): "artifact" | "external" {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return ARTIFACT_EXTS.has(ext) ? "artifact" : "external";
}

// A bare/relative path match stops at the FIRST `.ext` (non-greedy), so a
// dotted FOLDER segment truncates the match: `D:\proj.v2\report.md` matched
// as `D:\proj.v`, whose `.v` tail classified external and previewed nothing.
// Walk the match forward over further dots inside the same token until the
// tail is a previewable extension or the token ends; dotted folders then
// resolve to their real file. Two guards: only walk while the very next
// character is part of a name or a path separator (a space after `a.zip`
// never starts a walk), and stop the moment the span already classifies as
// an artifact so a real path is never extended into prose.
function extendBarePathSpan(text: string, start: number, end: number): number {
  let next = end;
  while (
    next < text.length &&
    /[A-Za-z0-9._-]|[\\/]/.test(text[next]!) &&
    classifyTerminalPath(text.slice(start, next)) !== "artifact"
  ) {
    const run = /^\S+/.exec(text.slice(next));
    const m = run && /\.[A-Za-z0-9]+/.exec(run[0]);
    if (!m) break;
    next += m.index + m[0].length;
  }
  return next;
}

export interface TerminalPathMatch {
  path: string;
  index: number;
  // UTF-16 code-unit length of the matched text ON THE LINE. Kept separate
  // from `path` because `path` may be a resolved absolute path longer than the
  // text actually printed (relative-match case). Link ranges must be sized
  // from the printed text, never from the resolved target.
  length: number;
}

// Extension-less matches (bare absolute / UNC / home) are greedy over a
// segment class that includes '.', so a sentence period right after such a
// path would be swallowed (`D:\a\b.`). Trim the trailing dot run; a trim that
// eats a whole segment (D:\a\.. -> D:\a\) leaves a dangling separator and is
// not a usable path — reject the span entirely in that case.
function trimExtLessSpan(span: string): string {
  const trimmed = span.replace(/\.+$/, "");
  return /[\\/]$/.test(trimmed) ? "" : trimmed;
}

export function findTerminalPaths(text: string, cwd?: string): TerminalPathMatch[] {
  const out: TerminalPathMatch[] = [];
  // Char ranges already claimed by an earlier (more confident) pass, so a
  // later regex doesn't re-match a substring of an already-linked span —
  // e.g. the drive-letter fragment inside a file:// URI, or a bare-absolute
  // match on a span the extension-anchored regex already claimed.
  const claimed: Array<[number, number]> = [];
  const tryClaim = (start: number, end: number): boolean => {
    if (claimed.some(([c0, c1]) => start < c1 && end > c0)) return false;
    claimed.push([start, end]);
    return true;
  };
  let m: RegExpExecArray | null;

  FILE_URI_RE.lastIndex = 0;
  while ((m = FILE_URI_RE.exec(text)) !== null) {
    if (tryClaim(m.index, m.index + m[0].length)) {
      out.push({ path: m[0], index: m.index, length: m[0].length });
    }
  }

  TERMINAL_PATH_RE.lastIndex = 0;
  while ((m = TERMINAL_PATH_RE.exec(text)) !== null) {
    const start = m.index;
    const end = extendBarePathSpan(text, start, start + m[0].length);
    if (!tryClaim(start, end)) continue;
    const printed = text.slice(start, end);
    out.push({ path: printed, index: start, length: printed.length });
  }

  // Extension-less forms (run AFTER the anchored passes so overlapping spans
  // are de-duplicated): UNC share, bare D:\... path, ~/... home alias.
  for (const re of [UNC_PATH_RE, BARE_ABSOLUTE_PATH_RE, HOME_PATH_RE]) {
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const printed = trimExtLessSpan(m[0]);
      if (printed.length === 0) continue;
      if (!tryClaim(m.index, m.index + printed.length)) continue;
      out.push({ path: printed, index: m.index, length: printed.length });
    }
  }

  if (cwd) {
    RELATIVE_PATH_RE.lastIndex = 0;
    while ((m = RELATIVE_PATH_RE.exec(text)) !== null) {
      const start = m.index;
      const end = extendBarePathSpan(text, start, start + m[0].length);
      const printedSpan = text.slice(start, end);
      if (GLUED_CJK_ASCII_RE.test(printedSpan)) continue;
      if (!tryClaim(start, end)) continue;
      out.push({ path: resolveRelativePath(cwd, printedSpan), index: start, length: printedSpan.length });
    }
    RELATIVE_PREFIX_PATH_RE.lastIndex = 0;
    while ((m = RELATIVE_PREFIX_PATH_RE.exec(text)) !== null) {
      const printed = trimExtLessSpan(m[0]);
      if (printed.length === 0) continue;
      if (GLUED_CJK_ASCII_RE.test(printed)) continue;
      if (!tryClaim(m.index, m.index + printed.length)) continue;
      out.push({
        path: resolveRelativePath(cwd, printed),
        index: m.index,
        length: printed.length,
      });
    }
  }
  // Stable output order: by position in the printed text.
  out.sort((a, b) => a.index - b.index);
  return out;
}

// ---------------------------------------------------------------------------
// String index -> terminal CELL COLUMN mapping.
//
// xterm's ILink.range.x counts terminal cells, but regexes over a line's text
// index JS string positions. The two diverge whenever a line holds anything
// wider or longer than one code unit per cell: CJK chars render as 2 cells
// while counting as 1 char, emoji count as 2 code units per visible glyph,
// and grapheme clusters bundle many code units into 1-2 cells. Mapping regex
// hits straight into the range used to shift the underline LEFT of the path
// (by one column per wide char), which is exactly the misaligned-underline
// bug. These helpers walk the line's cells so the range speaks columns.

// Structural shape of the two IBufferCell accessors the link provider needs.
// Kept dependency-free so unit tests never construct xterm objects.
export interface TerminalCellLike {
  chars: string;
  width: number;
}

export interface LineColumnMap {
  // The line's text (same content IBufferLine.translateToString(true) yields,
  // minus the trailing-space trim, which a path regex can never match inside).
  text: string;
  // indexToCol[i] = 0-based terminal column rendering text[i]; the final
  // sentinel entry (at text.length) is one column past the last character's
  // cells, i.e. the exclusive end column of the line's content.
  indexToCol: number[];
}

export function lineTextAndColumnMap(cells: readonly TerminalCellLike[]): LineColumnMap {
  let text = "";
  const indexToCol: number[] = [];
  let col = 0;
  for (const cell of cells) {
    // Width-0 cells are the invisible second half of a wide character; xterm's
    // translateToString jumps over them too (it advances by the wide cell's
    // width), so they contribute neither text nor columns.
    if (cell.width === 0) continue;
    // Blank buffer cells (no chars) read as a space, matching translateToString's
    // DEFAULT_WHITESPACE_CELL_CHARACTER. A path match can never contain one, but
    // getting this wrong would shift the columns of everything after it.
    const chars = cell.chars.length > 0 ? cell.chars : " ";
    for (let i = 0; i < chars.length; i += 1) indexToCol.push(col);
    text += chars;
    col += cell.width;
  }
  indexToCol.push(col);
  return { text, indexToCol };
}

/**
 * Convert a regex match span (string index + code-unit length into
 * LineColumnMap.text) into an xterm IBufferRange x-span: 1-based columns,
 * end inclusive. Never extends outside the line's occupied columns.
 */
export function linkRangeForMatch(
  map: LineColumnMap,
  index: number,
  length: number,
): { startX: number; endX: number } {
  const lastIndex = map.indexToCol.length - 1;
  const clamp = (value: number): number => Math.max(0, Math.min(value, lastIndex));
  const startCol = map.indexToCol[clamp(index)] ?? 0;
  // The sentinel/column where the NEXT character starts == exclusive 0-based
  // end == inclusive 1-based end column of the match.
  const endCol = map.indexToCol[clamp(index + length)] ?? startCol;
  return { startX: startCol + 1, endX: Math.max(startCol + 1, endCol) };
}

// ---------------------------------------------------------------------------
// Multi-row (soft-wrapped) line mapping.
//
// A long path wider than the pane soft-wraps across 2+ buffer rows; the
// continuation rows have IBufferLine.isWrapped === true. A provider that only
// reads one row underlines just that row's fragment and activates a truncated
// path. These helpers join the cells of the whole LOGICAL line so matches —
// and their xterm ILink ranges, whose start {x,y} and end {x,y} may sit on
// different rows (xterm supports that natively for both hover/click membership
// and underline rendering) — cover the full printed path.

export interface TerminalLogicalRow {
  cells: readonly TerminalCellLike[];
  // 0-based VIEWPORT row of this buffer row.
  row: number;
  // True when this row soft-wraps onto the following row (is a continued-below
  // row, not a continuation OF the previous one).
  continues: boolean;
}

// A row that continues onto the next one may end with an UNUSED cell: when a
// wide (2-column) character did not fit into the pane's last column, xterm
// leaves that cell unwritten and prints the character at the start of the next
// row. The real text has no gap there, so such a trailing blank must be
// dropped before the rows are joined — inserting it would put a bogus space
// mid-path. The ONLY signal for that case is the next row starting with a
// width-2 cell; trim at most the ONE trailing blank and only under that
// signal. Any other trailing blank is real state (a written space reads as
// ' ', a bare NULL cell stays ""), so it survives and correctly ends the join
// (matching xterm's own word-joining rule, which stops at a space in the last
// column).
function trimUnusedWrapGap(
  row: TerminalLogicalRow,
  next: TerminalLogicalRow | undefined,
): readonly TerminalCellLike[] {
  if (
    next !== undefined &&
    next.cells.length > 0 &&
    next.cells[0]!.width === 2 &&
    row.cells.length > 0 &&
    row.cells[row.cells.length - 1]!.chars.length === 0
  ) {
    return row.cells.slice(0, -1);
  }
  return row.cells;
}

export interface MultiRowColumnMap {
  // The whole logical line's text: rows joined with NO separator (a soft wrap
  // adds none) after dropping the unused trailing cells above.
  text: string;
  // indexToCol[i] = 0-based terminal column of text[i] on its row; final
  // sentinel entry (at text.length) mirrors LineColumnMap.
  indexToCol: number[];
  // indexToRow[i] = 0-based viewport row text[i] prints on; sentinel entry
  // mirrors the last row.
  indexToRow: number[];
  // indexToEndCol[i] = indexToCol[i] + that cell's width — the exclusive
  // 0-based end column of the cell containing text[i]. Needed so a match whose
  // last character is wide is underlined across BOTH its columns, and so a
  // match ending exactly at a row junction stays on the junction row instead
  // of crossing onto the continuation row.
  indexToEndCol: number[];
}

export function multiRowTextAndColumnMap(rows: readonly TerminalLogicalRow[]): MultiRowColumnMap {
  let text = "";
  const indexToCol: number[] = [];
  const indexToRow: number[] = [];
  const indexToEndCol: number[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    const cells = row.continues ? trimUnusedWrapGap(row, rows[i + 1]) : row.cells;
    let col = 0;
    for (const cell of cells) {
      // Same two rules as lineTextAndColumnMap: width-0 cells contribute
      // nothing (invisible second half of a wide char), blank cells read as
      // one space each (translateToString's DEFAULT_WHITESPACE_CELL_CHARACTER).
      if (cell.width === 0) continue;
      const chars = cell.chars.length > 0 ? cell.chars : " ";
      for (let i = 0; i < chars.length; i += 1) {
        indexToCol.push(col);
        indexToRow.push(row.row);
        indexToEndCol.push(col + cell.width);
      }
      text += chars;
      col += cell.width;
    }
  }
  // Sentinels: one entry at text.length speaking the line's end.
  const endCol = indexToEndCol.length > 0 ? indexToEndCol[indexToEndCol.length - 1]! : 0;
  const endRow = rows.length > 0 ? rows[rows.length - 1]!.row : 0;
  indexToCol.push(endCol);
  indexToRow.push(endRow);
  indexToEndCol.push(endCol);
  return { text, indexToCol, indexToRow, indexToEndCol };
}

/**
 * Convert a regex match span (string index + code-unit length into
 * MultiRowColumnMap.text) into an xterm ILink range whose start {x,y} and end
 * {x,y} may sit on different buffer rows: 1-based columns, 1-based rows, end
 * inclusive. Anchored on the LAST character of the match (via indexToEndCol)
 * so a wide last character is underlined across both its columns and a
 * junction-ending match does not cross onto the continuation row. On a
 * multi-row range the end column may sit numerically LEFT of the start
 * (xterm orders cells by y*cols + x), so ordering is only enforced for
 * same-row ranges.
 */
export function multiRowLinkRangeForMatch(
  map: MultiRowColumnMap,
  index: number,
  length: number,
): { start: { x: number; y: number }; end: { x: number; y: number } } {
  const lastTextIndex = map.indexToRow.length - 1;
  const clamp = (value: number): number => Math.max(0, Math.min(value, lastTextIndex));
  const firstIdx = clamp(index);
  const lastIdx = Math.max(firstIdx, clamp(index + length - 1));
  const startX = map.indexToCol[firstIdx]! + 1;
  const startY = map.indexToRow[firstIdx]! + 1;
  const endY = map.indexToRow[lastIdx]! + 1;
  let endX = Math.max(1, map.indexToEndCol[lastIdx]!);
  if (endY === startY) endX = Math.max(startX, endX);
  return {
    start: { x: startX, y: startY },
    end: { x: endX, y: endY },
  };
}
