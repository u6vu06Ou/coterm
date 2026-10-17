// VT snapshot — a main-owned @xterm/headless Terminal that emulates ConPTY
// output so region extraction sees the same visible lines the user sees.
//
// Why a real VT emulator (not an append-only line ring): Claude Code/Codex
// permission panels, spinners, and TUI redraws use \r overwrite + CSI cursor
// move + CSI K erase-line + alternate-screen enter/exit. An append-only ring
// would record every overwrite as a new line and never see the correct bottom.
// @xterm/headless is the same VT state machine the renderer uses (@xterm/xterm
// v6), so main and renderer agree on what "visible" means.
//
// Bounded: scrollback <= 200 (constructor), snapshot reads at most
// MAX_SNAPSHOT_LINES (80) lines and caps total output at MAX_SNAPSHOT_CHARS
// (16K). The user's renderer scroll position never participates — we read
// buffer.active (normal or alternate), not the viewport.

// @xterm/headless exposes CommonJS at its Node `main` entry. Electron's ESM
// loader cannot synthesize named exports from that file, so consume the CJS
// namespace through its default export (Vitest's bundler accepts this too).
import xtermHeadless, { type Terminal as XtermTerminal } from "@xterm/headless";
import {
  MAX_SNAPSHOT_CHARS,
  MAX_SNAPSHOT_LINES,
  type BufferSnapshot,
} from "./regions";

export const VT_SCROLLBACK = 200;
const { Terminal } = xtermHeadless;

// allowProposedApi is required to access .buffer (declared "experimental" in
// the typings). This is the documented headless escape hatch and is stable in
// practice for v6; the renderer uses the same buffer API.
const VT_OPTIONS = { allowProposedApi: true, scrollback: VT_SCROLLBACK } as const;

export class VtSnapshot {
  private readonly vt: XtermTerminal;
  private title = "";

  constructor(cols: number, rows: number) {
    this.vt = new Terminal({ ...VT_OPTIONS, cols, rows });
    this.vt.onTitleChange((t) => {
      this.title = t;
    });
  }

  // write(data, callback): the callback fires after the buffer reflects the
  // write. Callers that need to read the buffer MUST do so inside the callback
  // (issue §1: "write(data, callback) 後才讀 buffer.active").
  write(data: string, callback?: () => void): void {
    this.vt.write(data, callback);
  }

  resize(cols: number, rows: number): void {
    this.vt.resize(cols, rows);
  }

  // Snapshot the active buffer (normal or alternate — xterm switches
  // buffer.active automatically on ?1049h/l). Reads the bottom
  // MAX_SNAPSHOT_LINES lines, trims trailing whitespace per line, and drops
  // trailing empty lines so regions start from real content.
  snapshot(): BufferSnapshot {
    const buf = this.vt.buffer.active;
    const total = buf.length;
    const start = Math.max(0, total - MAX_SNAPSHOT_LINES);
    const lines: string[] = [];
    for (let i = start; i < total; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : "");
    }
    // Drop trailing empty lines (they are not "bottom content").
    while (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    return { lines, title: this.title };
  }

  // Bounded snapshot for the 8-pane worst case: cap total chars so a single
  // pane cannot dominate memory. Used by the engine when it needs a defensive
  // copy; the VT itself is already bounded by scrollback=200.
  boundedSnapshot(): BufferSnapshot {
    const snap = this.snapshot();
    let total = 0;
    const trimmed: string[] = [];
    for (let i = snap.lines.length - 1; i >= 0; i--) {
      const line = snap.lines[i];
      if (line === undefined) continue;
      total += line.length + 1;
      if (total > MAX_SNAPSHOT_CHARS) break;
      trimmed.unshift(line);
    }
    return { lines: trimmed, title: snap.title };
  }

  dispose(): void {
    this.vt.dispose();
  }
}
