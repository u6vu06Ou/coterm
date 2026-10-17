import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/headless";
import { DecModeTracker } from "../../src/main/terminal/dec-modes";

const ANSI = {
  enterAlt: "\x1b[?1049h",
  exitAlt: "\x1b[?1049l",
  mouse: "\x1b[?1002h\x1b[?1006h",
  mouseOff: "\x1b[?1006l",
  bracketedPaste: "\x1b[?2004h",
  hideCursor: "\x1b[?25l",
};

describe("DecModeTracker", () => {
  it("produces an empty preamble when no tracked mode was seen", () => {
    const tracker = new DecModeTracker();
    tracker.ingest("plain shell output\r\nprompt> ");
    expect(tracker.preamble()).toBe("");
  });

  it("reconstructs alt-screen + mouse reporting + bracketed paste", () => {
    const tracker = new DecModeTracker();
    tracker.ingest(`${ANSI.bracketedPaste}${ANSI.enterAlt}${ANSI.mouse}frame-1`);
    expect(tracker.isEnabled(1049)).toBe(true);
    expect(tracker.isEnabled(1006)).toBe(true);
    const preamble = tracker.preamble();
    expect(preamble).toContain("\x1b[?1049h");
    expect(preamble).toContain("\x1b[?1002h");
    expect(preamble).toContain("\x1b[?1006h");
    expect(preamble).toContain("\x1b[?2004h");
  });

  it("keeps modes across ring-sized output (state is not part of the ring)", () => {
    const tracker = new DecModeTracker();
    tracker.ingest(`${ANSI.enterAlt}${ANSI.mouse}`);
    for (let i = 0; i < 1000; i++) tracker.ingest(`frame-${i}\r\n`);
    expect(tracker.preamble()).toContain("\x1b[?1049h");
  });

  it("drops a mode from the preamble once reset", () => {
    const tracker = new DecModeTracker();
    tracker.ingest(`${ANSI.enterAlt}${ANSI.mouse}`);
    tracker.ingest(`${ANSI.mouseOff}${ANSI.exitAlt}`);
    const preamble = tracker.preamble();
    expect(preamble).not.toContain("1049h");
    expect(preamble).not.toContain("1006h");
    expect(preamble).toContain("\x1b[?1002h");
  });

  it("parses a sequence split across chunk boundaries", () => {
    const tracker = new DecModeTracker();
    tracker.ingest("partial frame \x1b[?104");
    tracker.ingest("9h rest");
    expect(tracker.isEnabled(1049)).toBe(true);
  });

  it("parses multiple modes in one sequence (?1;?25 style semicolon lists)", () => {
    const tracker = new DecModeTracker();
    tracker.ingest("\x1b[?1002;1006h");
    expect(tracker.isEnabled(1002)).toBe(true);
    expect(tracker.isEnabled(1006)).toBe(true);
  });

  it("tracks default-on modes being disabled (hide cursor) as `l` resets", () => {
    const tracker = new DecModeTracker();
    tracker.ingest(ANSI.hideCursor);
    expect(tracker.preamble()).toBe("\x1b[?25l");
  });

  it("ignores non-private and non-tracked sequences without noise", () => {
    const tracker = new DecModeTracker();
    tracker.ingest("\x1b[2J\x1b[H\x1b[?1036h\x1b]0;title\x07normal");
    expect(tracker.preamble()).toBe("");
  });

  it("preamble re-enters the alt buffer for a late-hydrating client (#47 layer 1)", async () => {
    // A fullscreen TUI frame emitted after the ring evicted the mode bytes:
    // mid-alt-screen repaint with no ?1049h in it.
    const frame = "\x1b[1;1Hfullscreen frame\x1b[2;1Hmore";
    const tracker = new DecModeTracker();
    tracker.ingest(`${ANSI.bracketedPaste}${ANSI.enterAlt}${ANSI.mouse}${frame}`);
    // Ring tail lost the mode-setting prefix; snapshot replay = preamble + tail.
    const replayed = tracker.preamble() + frame;
    const fresh = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    await new Promise<void>((resolve) => fresh.write(replayed, resolve));
    expect(fresh.buffer.active.type).toBe("alternate");
    expect(fresh.modes.bracketedPasteMode).toBe(true);
    expect(fresh.modes.mouseTrackingMode).not.toBe("none");
    // Control: replaying the raw tail alone leaves the client in normal mode.
    const bare = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    await new Promise<void>((resolve) => bare.write(frame, resolve));
    expect(bare.buffer.active.type).toBe("normal");
    expect(bare.modes.mouseTrackingMode).toBe("none");
    fresh.dispose();
    bare.dispose();
  });
});
