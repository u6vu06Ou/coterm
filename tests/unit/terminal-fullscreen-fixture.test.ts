// Public #14 fixture: a fullscreen TUI (`?1049h`, CLAUDE_CODE_ALT_SCREEN_
// FULL_REPAINT-style whole-frame repaints) must not freeze the tab. Drives a
// headless xterm through the exact renderer contract points 20 times:
//   - keyboard input still routes to the SAME PTY while in the alt buffer
//   - wheel under mouse reporting is an SGR plan for the PTY (no local scroll)
//   - selection/copy is never disabled by the alt screen
//   - exiting the alt screen restores the normal buffer intact (no regression)
//   - the recovery pipeline replays an authoritative snapshot WITHOUT killing
//     the PTY (planRecovery is structurally kill-free; replay rehydrates the
//     DEC 1049 mode via the tracked preamble — not by restarting the agent)
import { describe, expect, it } from "vitest";
import xtermHeadless, { type Terminal as XtermTerminal } from "@xterm/headless";
import { DecModeTracker } from "../../src/main/terminal/dec-modes";
import { planRecovery } from "../../src/renderer/src/components/terminal-recovery";
import { terminalCopyText } from "@shared/value";
import {
  planTouchWheelEvents,
  shouldOpenReaderOnSwipe,
} from "../../src/renderer/src/components/terminal-touch-scroll";

const { Terminal } = xtermHeadless;
const CYCLES = 20;
const COLS = 80;
const ROWS = 24;

function writeAndFlush(term: XtermTerminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

// Keyboard entry point used by renderer attachCustomKeyEventHandler: xterm
// converts the keystroke into PTY-bound bytes; the dock writes them to
// info.id unconditionally (no alt-screen gating).
function typeAsUser(term: XtermTerminal, data: string): void {
  // Unopened headless terminals keep the core behind _core (same class the
  // renderer's opened xterm exposes as coreService).
  const core = (term as unknown as {
    coreService?: { triggerDataEvent(d: string): void };
    _core?: { coreService: { triggerDataEvent(d: string): void } };
  });
  const service = core.coreService ?? core._core?.coreService;
  if (!service) throw new Error("xterm core service unavailable");
  service.triggerDataEvent(data);
}

function screenText(term: XtermTerminal): string {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    lines.push(buf.getLine(i)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

describe("public #14 fullscreen/1049 fixture — 20 stable cycles", () => {
  it(
    "alt-screen enter/repaint/input/wheel/selection/recovery/exit keeps the tab live",
    async () => {
      for (let cycle = 0; cycle < CYCLES; cycle++) {
        const term = new Terminal({ allowProposedApi: true, cols: COLS, rows: ROWS, scrollback: 200 });
        const ptySink: string[] = [];
        term.onData((data) => ptySink.push(data));
        const decModes = new DecModeTracker();
        const ingest = async (data: string): Promise<void> => {
          decModes.ingest(data);
          await writeAndFlush(term, data);
        };

        // Phase A — normal-buffer baseline.
        const normalBaseline = `BASE_${cycle} $ `;
        await ingest(`${normalBaseline}\r\n`);
        expect(term.buffer.active.type).toBe("normal");

        // Phase B — enter fullscreen TUI + full-repaint frames (the ConPTY
        // workaround pattern: every frame repaints the whole screen).
        await ingest("\x1b[?1049h\x1b[?1002h\x1b[?1006h");
        expect(term.buffer.active.type).toBe("alternate");
        expect(decModes.isEnabled(1049)).toBe(true);
        for (let frame = 0; frame < 3; frame++) {
          await ingest(`\x1b[2J\x1b[HTUI_${cycle}_FRAME_${frame}\r\nstatus: working`);
        }

        // Keyboard: bytes must reach the same PTY sink, alt screen or not.
        const sinkBefore = ptySink.length;
        typeAsUser(term, "k");
        expect(ptySink.length).toBe(sinkBefore + 1);
        expect(ptySink[ptySink.length - 1]).toBe("k");

        // Wheel: mouse-reporting TUI gets SGR wheel events to the PTY; the
        // reader-overlay fallback stays closed while the app owns the mouse.
        expect(planTouchWheelEvents(3)).toEqual({ button: 4, action: 1, count: 3 });
        expect(planTouchWheelEvents(-2)).toEqual({ button: 4, action: 0, count: 2 });
        expect(
          shouldOpenReaderOnSwipe({
            readerOpen: false,
            bufferType: term.buffer.active.type,
            baseY: term.buffer.active.baseY,
            deltaY: -100,
            thresholdPx: 40,
            mouseReportingActive: true,
          }),
        ).toBe(false);

        // Selection/copy stay enabled on the alt screen: the copy handler is
        // buffer-agnostic (no alt-screen gating anywhere in the copy path) —
        // it forwards whatever xterm's selection holds. xterm's own selection
        // service is DOM-only, so the fixture asserts the copy contract and
        // that the alt content (the selection source) is intact.
        const frameText = `TUI_${cycle}_FRAME_2`;
        expect(screenText(term)).toContain(frameText);
        expect(
          terminalCopyText({ key: "c", ctrlKey: true, shiftKey: false }, frameText),
        ).toBe(frameText);

        // Recovery does not kill the PTY: the plan is structurally kill-free,
        // and a replace-replay rehydrates the alt mode instead of restarting.
        const steps = planRecovery("terminal-under-test");
        expect(steps.map((step) => step.kind).sort()).toEqual(
          ["remeasure", "request-authoritative-replay", "refresh-canvas", "restore-focus-scroll"].sort(),
        );
        const sinkBeforeRecovery = ptySink.length;
        const replayNormal = `${normalBaseline}\r\n`;
        const replayAlt = `\x1b[2J\x1b[HRECOVERY_${cycle}_ALT\r\nstatus: working`;
        term.reset();
        await writeAndFlush(term, replayNormal + decModes.preamble() + replayAlt);
        expect(term.buffer.active.type).toBe("alternate");
        expect(screenText(term)).toContain(`RECOVERY_${cycle}_ALT`);
        expect(ptySink.length).toBe(sinkBeforeRecovery); // nothing written to the PTY

        // Exit the TUI: the normal buffer is restored intact (regression check).
        await ingest("\x1b[?1002l\x1b[?1006l\x1b[?1049l");
        expect(term.buffer.active.type).toBe("normal");
        expect(decModes.isEnabled(1049)).toBe(false);
        expect(screenText(term)).toContain(normalBaseline);

        // Post-exit typing still routes to the PTY.
        typeAsUser(term, "\r");
        expect(ptySink[ptySink.length - 1]).toBe("\r");

        term.dispose();
      }
    },
    30_000,
  );

  it("recovery plan never contains a kill/dispose/close semantic", () => {
    const steps = planRecovery("any-terminal");
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(step.kind).not.toMatch(/kill|dispose|close|exit/iu);
    }
    // The replay step replaces renderer content only.
    const replay = steps.find((step) => step.kind === "request-authoritative-replay");
    expect(replay).toBeDefined();
    expect(replay!.replace).toBe(true);
  });
});
