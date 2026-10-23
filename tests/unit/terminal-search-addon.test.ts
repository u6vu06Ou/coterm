// Backend contract for the pane Ctrl+F overlay (TerminalDock searchRef):
// drives a REAL @xterm/headless buffer through @xterm/addon-search to pin
// down what a pane search can and cannot see.
//   - normal buffer: matches land anywhere in the full scrollback (incl. CJK)
//   - alternate screen (DEC 1049, agent panes): the buffer holds only the
//     visible screen — scrollback matches return FALSE. That asymmetry is
//     exactly why the dock reroutes alt-screen search to the reader
//     (planPaneSearchTarget), and these cases must keep holding.
import { describe, expect, it } from "vitest";
import xtermHeadless, { type Terminal as XtermTerminal } from "@xterm/headless";
import { SearchAddon } from "@xterm/addon-search";

const { Terminal } = xtermHeadless;
const COLS = 80;
const ROWS = 10;

function writeAndFlush(term: XtermTerminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

// SearchAddon is typed against @xterm/xterm's ITerminal; the headless
// terminal implements the same search-relevant runtime surface (buffer/
// movement). The DOM-only selection API is absent headless, so no-op it —
// found-match SELECTION is not what's being tested, the match result is.
function loadSearch(term: XtermTerminal): SearchAddon {
  const host = term as unknown as Record<string, unknown>;
  host.getSelectionPosition = () => undefined;
  host.getSelection = () => "";
  host.hasSelection = () => false;
  host.select = () => undefined;
  host.clearSelection = () => undefined;
  const addon = new SearchAddon();
  term.loadAddon(addon as unknown as Parameters<XtermTerminal["loadAddon"]>[0]);
  return addon;
}

describe("SearchAddon as the pane search backend", () => {
  it("normal buffer: finds text that has scrolled out of view", async () => {
    const term = new Terminal({ allowProposedApi: true, cols: COLS, rows: ROWS, scrollback: 500 });
    const search = loadSearch(term);
    await writeAndFlush(term, "NEEDLE_SCROLLBACK here\r\n");
    for (let i = 0; i < 50; i++) await writeAndFlush(term, `filler line ${i}\r\n`);
    await writeAndFlush(term, "prompt> ");
    // The marker sits deep in scrollback, far above the viewport.
    expect(term.buffer.active.baseY).toBeGreaterThan(10);
    expect(search.findNext("NEEDLE_SCROLLBACK")).toBe(true);
    expect(search.findNext("NEEDLE_ABSENT")).toBe(false);
  });

  it("normal buffer: finds CJK text and text beside wide chars", async () => {
    const term = new Terminal({ allowProposedApi: true, cols: COLS, rows: ROWS, scrollback: 500 });
    const search = loadSearch(term);
    await writeAndFlush(term, "第一行：你好世界，測試 hello 世界\r\nprompt> ");
    expect(search.findNext("你好")).toBe(true);
    expect(search.findNext("hello 世界")).toBe(true);
  });

  it("alternate screen: visible text matches, scrollback does not (the reported bug)", async () => {
    const term = new Terminal({ allowProposedApi: true, cols: COLS, rows: ROWS, scrollback: 500 });
    const search = loadSearch(term);
    await writeAndFlush(term, "NORMAL_ONLY_MARKER\r\n");
    for (let i = 0; i < 30; i++) await writeAndFlush(term, `filler ${i}\r\n`);
    // Enter the fullscreen TUI (DEC 1049) exactly like an agent pane.
    await writeAndFlush(term, "\x1b[?1049h\x1b[2J\x1b[HALT_VISIBLE_MARKER\r\nstatus: working");
    expect(term.buffer.active.type).toBe("alternate");
    // The alternate buffer holds just the screen — no scrollback lines.
    expect(term.buffer.active.baseY).toBe(0);
    expect(term.buffer.active.length).toBe(ROWS);
    expect(search.findNext("ALT_VISIBLE_MARKER")).toBe(true);
    expect(search.findNext("NORMAL_ONLY_MARKER")).toBe(false);
    // Leaving the alt screen restores the normal buffer AND its searchability.
    await writeAndFlush(term, "\x1b[?1049l");
    expect(term.buffer.active.type).toBe("normal");
    expect(search.findNext("NORMAL_ONLY_MARKER")).toBe(true);
  });
});
