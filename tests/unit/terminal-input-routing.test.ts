// #14 retry (review P2 ④): fullscreen wiring must be tested at the REAL
// production handlers — not only at standalone primitives. This suite drives
// the exact functions TerminalDock installs (routeCustomKey for
// attachCustomKeyEventHandler, routeCtrlWheelZoom for the ctrl+wheel zoom,
// executeRecoveryPlan for the recovery dispatch) through 20 fullscreen-style
// mount/unmount cycles (?1049h → full repaint → ?1049l) on a REAL headless
// xterm buffer, asserting input/wheel/copy/recovery wiring never degrades and
// the normal buffer is restored intact each round.
//
// Honest scope note: the keystroke→PTY byte conversion itself is xterm-core
// behavior (covered by the pty-manager/dec-mode fixtures); this test owns the
// Coterm-side routing contract. The original user-visible #14 freeze is a
// packaged-desktop symptom; packaged regression stays on the e2e checklist.
import { describe, expect, it } from "vitest";
import xtermHeadless, { type Terminal as XtermTerminal } from "@xterm/headless";
import {
  executeRecoveryPlan,
  routeCtrlWheelZoom,
  routeCustomKey,
  SOFT_NEWLINE_SEQ,
  type KeyRoutingActions,
  type RecoveryActions,
  type RoutedKeyEvent,
  type WheelZoomEvent,
} from "../../src/renderer/src/components/terminal-input-routing";
import { planRecovery } from "../../src/renderer/src/components/terminal-recovery";

const { Terminal } = xtermHeadless;
const CYCLES = 20;
const COLS = 80;
const ROWS = 24;

function writeAndFlush(term: XtermTerminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

function keyEvent(partial: Partial<RoutedKeyEvent>): RoutedKeyEvent {
  return {
    type: "keydown",
    key: "a",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...partial,
  };
}

function screenText(term: XtermTerminal): string {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
  return lines.join("\n");
}

interface RoutingProbe {
  actions: KeyRoutingActions;
  written: string[];
  copied: string[];
  selects: number;
  searchOpens: number;
  clearSelected: () => boolean;
}

function makeRoutingProbe(selection = "selected text"): RoutingProbe {
  const written: string[] = [];
  const copied: string[] = [];
  const probe: RoutingProbe = {
    actions: {
      isComposing: () => false,
      writeInput: (data) => written.push(data),
      clearSelectedInput: () => probe.clearSelected(),
      markClearNextDelete: () => undefined,
      selectAll: () => probe.selects++,
      openSearch: () => probe.searchOpens++,
      getSelection: () => selection,
      copyText: (text) => copied.push(text),
    },
    written,
    copied,
    selects: 0,
    searchOpens: 0,
    clearSelected: () => true,
  };
  return probe;
}

function makeWheelEvent(ctrlKey: boolean, deltaY: number): WheelZoomEvent & { prevented: number; stopped: number } {
  const event = {
    ctrlKey,
    deltaY,
    prevented: 0,
    stopped: 0,
    preventDefault() {
      event.prevented++;
    },
    stopPropagation() {
      event.stopped++;
    },
  };
  return event;
}

interface RecoveryProbe {
  actions: RecoveryActions;
  calls: string[];
}

function makeRecoveryProbe(): RecoveryProbe {
  const calls: string[] = [];
  return {
    calls,
    actions: {
      remeasure: () => calls.push("remeasure"),
      requestAuthoritativeReplay: (replace, reason) => calls.push(`replay:${replace}:${reason}`),
      refreshCanvas: () => calls.push("refresh"),
      restoreFocusScroll: () => calls.push("focus-scroll"),
    },
  };
}

describe("terminal input routing — production handlers (#14 retry)", () => {
  it("routing contract: pass-through, soft newline, copy, select-all, search", () => {
    const probe = makeRoutingProbe();
    // A plain printable key is forwarded to xterm (→ PTY bytes).
    expect(routeCustomKey(keyEvent({ key: "x" }), probe.actions)).toBe(true);
    // Shift+Enter and Ctrl+Enter write a soft newline, never submit.
    expect(routeCustomKey(keyEvent({ key: "Enter", shiftKey: true }), probe.actions)).toBe(false);
    expect(routeCustomKey(keyEvent({ key: "Enter", ctrlKey: true }), probe.actions)).toBe(false);
    expect(probe.written).toEqual([SOFT_NEWLINE_SEQ, SOFT_NEWLINE_SEQ]);
    // Bare Enter submits (xterm forwards \r).
    expect(routeCustomKey(keyEvent({ key: "Enter" }), probe.actions)).toBe(true);
    // Backspace with an active selection clear is consumed.
    expect(routeCustomKey(keyEvent({ key: "Backspace" }), probe.actions)).toBe(false);
    probe.clearSelected = () => false;
    expect(routeCustomKey(keyEvent({ key: "Backspace" }), probe.actions)).toBe(true);
    probe.clearSelected = () => true;
    // Ctrl+A selects all (no \x01 to the PTY); Ctrl+F opens search (no \x06).
    expect(routeCustomKey(keyEvent({ key: "a", ctrlKey: true }), probe.actions)).toBe(false);
    expect(probe.selects).toBe(1);
    expect(routeCustomKey(keyEvent({ key: "f", ctrlKey: true }), probe.actions)).toBe(false);
    expect(probe.searchOpens).toBe(1);
    // Ctrl+C copies the selection; without a selection it passes through (SIGINT).
    expect(routeCustomKey(keyEvent({ key: "c", ctrlKey: true }), probe.actions)).toBe(false);
    expect(probe.copied).toEqual(["selected text"]);
    const noSel = makeRoutingProbe("");
    expect(routeCustomKey(keyEvent({ key: "c", ctrlKey: true }), noSel.actions)).toBe(true);
  });

  it("printable char over a selection replaces only when the hook consumes it", () => {
    const replaced: string[] = [];
    const probe = makeRoutingProbe();
    probe.actions.replaceSelection = (char) => {
      replaced.push(char);
      return true;
    };
    // Consumed: the key never reaches xterm/PTY directly.
    expect(routeCustomKey(keyEvent({ key: "x" }), probe.actions)).toBe(false);
    expect(replaced).toEqual(["x"]);
    // Hook declining (no input-line selection) → plain passthrough.
    probe.actions.replaceSelection = () => false;
    expect(routeCustomKey(keyEvent({ key: "x" }), probe.actions)).toBe(true);
    // Modifier chords are never treated as replaceable text.
    probe.actions.replaceSelection = () => true;
    expect(routeCustomKey(keyEvent({ key: "x", ctrlKey: true }), probe.actions)).toBe(true);
    // Multi-char keys (IME "Process", arrows, etc.) skip the replace branch.
    expect(routeCustomKey(keyEvent({ key: "Process" }), probe.actions)).toBe(true);
    // Without the hook entirely, printable keys pass through (old behavior).
    expect(routeCustomKey(keyEvent({ key: "x" }), makeRoutingProbe().actions)).toBe(true);
  });

  it("ctrl+wheel font-zoom consumes; plain wheel is left to xterm", () => {
    let fontSize = 14;
    const actions = {
      getFontSize: () => fontSize,
      applyFontSize: (next: number) => {
        fontSize = next;
      },
    };
    const up = makeWheelEvent(true, -120);
    expect(routeCtrlWheelZoom(up, actions)).toBe(true);
    expect(fontSize).toBe(15);
    expect(up.prevented).toBe(1);
    expect(up.stopped).toBe(1);
    const down = makeWheelEvent(true, 120);
    routeCtrlWheelZoom(down, actions);
    expect(fontSize).toBe(14);
    // Zero-delta ctrl wheel still consumes (blocks Chromium page-zoom) but no zoom.
    const zero = makeWheelEvent(true, 0);
    routeCtrlWheelZoom(zero, actions);
    expect(fontSize).toBe(14);
    expect(zero.prevented).toBe(1);
    // Plain wheel is NOT ours — xterm scrolls natively.
    const plain = makeWheelEvent(false, -120);
    expect(routeCtrlWheelZoom(plain, actions)).toBe(false);
    expect(plain.prevented).toBe(0);
  });

  it("recovery plan executes all steps in order and is structurally kill-free", () => {
    const probe = makeRecoveryProbe();
    const steps = planRecovery("t1");
    // Kill-free contract: no plan step can name a kill/restart action — the
    // RecoveryActions interface has no such callback (compile-time), and the
    // runtime plan must not smuggle one in as a string either.
    for (const step of steps) {
      expect(step.kind).not.toMatch(/kill|restart|respawn/i);
    }
    executeRecoveryPlan(steps, "manual-refresh", probe.actions);
    expect(probe.calls).toEqual(["remeasure", "replay:true:manual-refresh", "refresh", "focus-scroll"]);
  });

  it(`${CYCLES} fullscreen mount/unmount cycles: input/wheel/copy/recovery wiring never degrades`, async () => {
    const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
    const probe = makeRoutingProbe();
    const recovery = makeRecoveryProbe();
    let fontSize = 14;
    const wheel = {
      getFontSize: () => fontSize,
      applyFontSize: (next: number) => {
        fontSize = next;
      },
    };
    await writeAndFlush(term, "shell-prompt$ whoami\r\n");
    for (let round = 0; round < CYCLES; round++) {
      // Mount: fullscreen TUI enters the alternate screen and repaints.
      await writeAndFlush(term, `\x1b[?1049h\x1b[2J\x1b[Hframe-${round}`);
      expect(term.buffer.active.type).toBe("alternate");
      // Input routing is invariant in the alt buffer: no alt-screen gating.
      expect(routeCustomKey(keyEvent({ key: "g" }), probe.actions)).toBe(true);
      expect(routeCustomKey(keyEvent({ key: "Enter", shiftKey: true }), probe.actions)).toBe(false);
      // Copy contract holds under fullscreen (selection never disabled).
      expect(routeCustomKey(keyEvent({ key: "c", ctrlKey: true }), probe.actions)).toBe(false);
      expect(routeCustomKey(keyEvent({ key: "a", ctrlKey: true }), probe.actions)).toBe(false);
      // Wheel zoom keeps working; font size path is the same one TerminalDock uses.
      routeCtrlWheelZoom(makeWheelEvent(true, -120), wheel);
      expect(fontSize).toBe(15);
      routeCtrlWheelZoom(makeWheelEvent(true, 120), wheel);
      expect(fontSize).toBe(14);
      // Recovery mid-fullscreen: replays authoritative bytes, never kills.
      recovery.calls.length = 0;
      executeRecoveryPlan(planRecovery("t1"), "manual-refresh", recovery.actions);
      expect(recovery.calls).toHaveLength(4);
      // Unmount: leave the alt screen; the normal buffer must come back intact.
      await writeAndFlush(term, "\x1b[?1049l");
      expect(term.buffer.active.type).toBe("normal");
      expect(screenText(term)).toContain("shell-prompt$ whoami");
    }
    // Totals prove the wiring ran every single round, not just once.
    expect(probe.written).toHaveLength(CYCLES);
    expect(probe.written.every((data) => data === SOFT_NEWLINE_SEQ)).toBe(true);
    expect(probe.copied).toHaveLength(CYCLES);
    expect(probe.selects).toBe(CYCLES);
    term.dispose();
  });
});
