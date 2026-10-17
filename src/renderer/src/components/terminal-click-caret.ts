// Click-to-move-caret: convert a target cell delta into the arrow-key escape
// sequence that moves the PTY cursor there. Mirrors xterm's altClickMovesCursor
// (MoveToCell.ts) but trimmed to the normal-buffer, non-mouse-tracking case.
// ponytail: ceiling — ignores wrapped-row short-cuts xterm uses (it counts
// cells across wraps); we just emit raw up/down then left/right, which readline
// CLIs (Claude Code multi-line) handle correctly. Upgrade to wrap-aware math if
// a CLI miscounts on wrapped lines.

const ESC = "\x1b";
const ARROW = { up: `${ESC}[A`, down: `${ESC}[B`, right: `${ESC}[C`, left: `${ESC}[D` };

export interface CellPos {
  x: number; // 0-based column
  y: number; // 0-based row within buffer.active
}

/**
 * Build the escape sequence to move from `from` to `to`.
 * Same row: left/right only. Cross row: up/down first, then left/right.
 * Returns "" when already at the target.
 */
export function moveToCellSequence(from: CellPos, to: CellPos): string {
  const dy = to.y - from.y;
  const dx = to.x - from.x;
  if (dy === 0 && dx === 0) return "";
  let seq = "";
  if (dy > 0) seq += ARROW.down.repeat(dy);
  else if (dy < 0) seq += ARROW.up.repeat(-dy);
  if (dx > 0) seq += ARROW.right.repeat(dx);
  else if (dx < 0) seq += ARROW.left.repeat(-dx);
  return seq;
}

// --- self-check (node this file) -------------------------------------------
function assertEq(actual: unknown, expected: unknown, name: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL ${name}\n  got:      ${a}\n  expected: ${e}`);
    process.exit(1);
  }
  console.log(`ok   ${name} -> ${a}`);
}

// Self-check: `npx tsx src/renderer/src/components/terminal-click-caret.ts`
// Guarded so importing the module in the renderer never runs the checks.
const isMain = typeof process !== "undefined"
  && process.argv[1]
  && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href;
if (isMain) {
  assertEq(
    moveToCellSequence({ x: 2, y: 5 }, { x: 5, y: 5 }),
    "\x1b[C\x1b[C\x1b[C",
    "same-row right 3",
  );
  assertEq(
    moveToCellSequence({ x: 7, y: 5 }, { x: 5, y: 5 }),
    "\x1b[D\x1b[D",
    "same-row left 2",
  );
  assertEq(
    moveToCellSequence({ x: 1, y: 3 }, { x: 5, y: 5 }),
    "\x1b[B\x1b[B\x1b[C\x1b[C\x1b[C\x1b[C",
    "cross-row down2 right4",
  );
  assertEq(moveToCellSequence({ x: 4, y: 4 }, { x: 4, y: 4 }), "", "no move");
  console.log("all self-checks passed");
}
