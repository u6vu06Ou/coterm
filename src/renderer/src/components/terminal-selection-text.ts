// Selection → clipboard text, built from BUFFER CELLS instead of
// terminal.getSelection().
//
// Why: getSelection() emits whole buffer rows and only trims a row against its
// "trimmed length", which counts program-written spaces. Agent TUIs (Claude
// Code / Codex) paint every row to the pane width to clear it, so those padding
// spaces survive — the user's paste then carried a run of blanks at each row
// end (and a newline in the middle of a TUI-wrapped path). v1.5.73 patched only
// the hard-wrap joins, so soft-wrapped (isWrapped) rows still glued their
// padding in.
//
// Rules here (all pure, unit-tested):
// - trailing blank cells are dropped on every row that does NOT continue (that
//   is row padding, never text);
// - a soft-wrapped row (xterm isWrapped) joins the next row with NO separator:
//   the terminal only ever breaks a FULL row, so a soft-wrapped row has no
//   padding to drop and whatever blanks it ends with are content (a word
//   separator included);
// - a hard-wrapped row (TUI printed the wrap itself) joins the same way, but
//   both edges are trimmed — its padding and continuation indent are the TUI's
//   own layout;
// - every other row boundary keeps a real "\n";
// - a selection ending at column 0 of its last row adds no trailing newline;
// - wide CJK chars occupy two cells (lead + invisible width-0 tail): the lead
//   emits its character once, the tail emits nothing — never a space;
// - a range boundary landing on a wide char's tail includes the lead char.

export interface SelectionTextCell {
  /** Buffer cell text; "" for an untouched/blank cell or a wide char's tail. */
  chars: string;
  /** 0 = invisible tail of a wide char, 1 normal, 2 wide lead. */
  width: number;
}

export interface SelectionTextRow {
  cells: readonly SelectionTextCell[];
  /** Selected columns, 0-based, end EXCLUSIVE. Already ordered (start <= end). */
  startX: number;
  endX: number;
  /** The next selected row continues this one via xterm soft wrap. */
  softWrapsNext: boolean;
  /** The next selected row continues this one via a TUI hard wrap. */
  hardWrapsNext: boolean;
}

const TRAILING_BLANKS = /[ \t\u00a0]+$/u;
const LEADING_BLANKS = /^[ \t\u00a0]+/u;

/**
 * Text of one row's selected cell span, wide-char correct.
 * `trimTrailing` drops trailing blanks. Off for a soft-wrapped row: the terminal
 * breaks only a full row, so its edge blanks are content (a word separator); on
 * a hard-wrapped row they are the TUI's own padding.
 */
function rowText(row: SelectionTextRow, trimTrailing: boolean): string {
  const { cells } = row;
  let start = Math.max(0, row.startX);
  const end = Math.min(row.endX, cells.length);
  // Landing on a wide char's invisible tail: back up onto its lead cell so the
  // character is included instead of turning into a phantom blank.
  if (start > 0 && cells[start]?.width === 0) start -= 1;
  let text = "";
  for (let x = start; x < end; ) {
    const cell = cells[x];
    if (!cell) break;
    if (cell.width === 0) {
      x += 1;
      continue;
    }
    text += cell.chars.length > 0 ? cell.chars : " ";
    x += cell.width;
  }
  return trimTrailing ? text.replace(TRAILING_BLANKS, "") : text;
}

/**
 * Rebuilds the selected text. Joins soft/hard wrapped neighbours without a
 * separator; keeps every other boundary as a real newline.
 *
 * Only a HARD wrap has its continuation indent stripped: that indent is the
 * TUI's layout for a row it printed itself. A soft wrap is the terminal breaking
 * a full row at a cell boundary, where the next row's leading blanks are real
 * content (indented code, aligned columns).
 */
export function selectionTextFromRows(rows: readonly SelectionTextRow[]): string {
  const joinsNext = (i: number): boolean => {
    const row = rows[i];
    return row !== undefined && (row.softWrapsNext || row.hardWrapsNext);
  };
  const texts = rows.map((row, i) => {
    // A double-width glyph cannot fit in the last remaining column. xterm
    // leaves that cell unwritten and wraps the glyph; it is not a text space.
    // Written spaces and the continuation's actual indentation stay intact.
    const lastCell = row.cells[row.cells.length - 1];
    const wideWrapGap = row.softWrapsNext && row.endX >= row.cells.length &&
      lastCell?.width === 1 && lastCell.chars === "" && rows[i + 1]?.cells[0]?.width === 2;
    return rowText(wideWrapGap ? { ...row, endX: row.endX - 1 } : row, !row.softWrapsNext);
  });
  let out = "";
  for (let i = 0; i < rows.length; i += 1) {
    let text = texts[i]!;
    if (i > 0 && rows[i - 1]!.hardWrapsNext) text = text.replace(LEADING_BLANKS, "");
    if (i === rows.length - 1) out += text;
    else if (joinsNext(i)) out += text;
    else out += text + "\n";
  }
  // A selection that ends at column 0 of its last row selects nothing there:
  // drop the newline that row contributed instead of pasting a blank line.
  if (rows.length > 1 && texts[rows.length - 1] === "") out = out.replace(/\n$/, "");
  return out;
}
