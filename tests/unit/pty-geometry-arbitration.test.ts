// PTY geometry ownership / dedupe rules (2026-10-23 half-blank pane fix).
//
// Reproduces the reported bug in miniature: a desktop tile fitted 187x42 and
// sent that once; a phone's rows-only claim then shrank the shared ConPTY to
// 187x24; the desktop xterm kept 42 visible rows while Claude Code redrew its
// alt-screen UI for 24 — the bottom of the pane stayed blank until the manual
// "refresh terminal" button (which happens to re-fit + re-send) ran.
//
// Covered rules:
//  1. Main-side arbitration: while the desktop window is visible+focused, a
//     remote claim that disagrees with the desktop's asserted grid is ignored
//     (no shrink, no grow). Desktop inactive → the claim applies.
//  2. Renderer-side dedupe: a resize is re-sent when the locally fitted grid
//     changed OR when main's reported grid diverged from what we last sent —
//     never skipped on a stale "last sent" cache.
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppOperations } from "../../src/main/core/app-operations";
import { AppEventBus } from "../../src/main/core/event-bus";
import {
  decideRemoteGeometryClaim,
  shouldSendTerminalResize,
  type PtyGridGeometry,
} from "../../src/shared/pty-geometry";

const DESKTOP: PtyGridGeometry = { cols: 187, rows: 42 };
const PHONE: PtyGridGeometry = { cols: 187, rows: 24 };

describe("decideRemoteGeometryClaim — remote rows claim vs desktop ownership", () => {
  it("ignores a no-change claim regardless of who owns the geometry", () => {
    const decision = decideRemoteGeometryClaim({
      claim: DESKTOP,
      current: DESKTOP,
      desktopAssertion: null,
      desktopActive: false,
    });
    expect(decision).toEqual({ kind: "ignore", reason: "no-change" });
  });

  it("applies a phone shrink when no desktop ever asserted the grid", () => {
    const decision = decideRemoteGeometryClaim({
      claim: PHONE,
      current: DESKTOP,
      desktopAssertion: null,
      desktopActive: true,
    });
    expect(decision).toEqual({ kind: "apply", geometry: PHONE });
  });

  it("rejects a phone shrink while the desktop window is active — the reported bug", () => {
    const decision = decideRemoteGeometryClaim({
      claim: PHONE,
      current: DESKTOP,
      desktopAssertion: { ...DESKTOP, at: Date.now() },
      desktopActive: true,
    });
    expect(decision).toEqual({ kind: "ignore", reason: "desktop-active" });
  });

  it("rejects a phone GROW too while the desktop is active (would clip the desktop pane instead of blanking it)", () => {
    const decision = decideRemoteGeometryClaim({
      claim: { cols: 187, rows: 60 },
      current: DESKTOP,
      desktopAssertion: { ...DESKTOP, at: Date.now() },
      desktopActive: true,
    });
    expect(decision.kind).toBe("ignore");
  });

  it("applies a phone claim that already matches the desktop assertion", () => {
    // The desktop assertion is truth; a claim agreeing with it is harmless.
    const decision = decideRemoteGeometryClaim({
      claim: DESKTOP,
      current: PHONE,
      desktopAssertion: { ...DESKTOP, at: Date.now() },
      desktopActive: true,
    });
    expect(decision).toEqual({ kind: "apply", geometry: DESKTOP });
  });

  it("applies a phone claim once the desktop window is no longer visible/focused", () => {
    const decision = decideRemoteGeometryClaim({
      claim: PHONE,
      current: DESKTOP,
      desktopAssertion: { ...DESKTOP, at: Date.now() - 60_000 },
      desktopActive: false,
    });
    expect(decision).toEqual({ kind: "apply", geometry: PHONE });
  });
});

describe("shouldSendTerminalResize — stale last-sent must never win over main's truth", () => {
  it("sends on first fit (nothing sent yet)", () => {
    expect(shouldSendTerminalResize({ lastSent: null, local: DESKTOP, external: null })).toBe(true);
  });

  it("sends when the locally fitted grid changed", () => {
    expect(shouldSendTerminalResize({ lastSent: DESKTOP, local: PHONE, external: DESKTOP })).toBe(true);
  });

  it("skips when nothing changed anywhere (idle focus events must not churn ConPTY)", () => {
    expect(shouldSendTerminalResize({ lastSent: DESKTOP, local: DESKTOP, external: DESKTOP })).toBe(false);
    // No external truth observed yet, local matches last sent: still a no-op.
    expect(shouldSendTerminalResize({ lastSent: DESKTOP, local: DESKTOP, external: null })).toBe(false);
  });

  it("RE-SENDS when main reports a different grid even though local === lastSent — the stale-cache bug", () => {
    // Desktop sent 187x42, a phone claim shrank the PTY to 187x24, and the
    // desktop frame did not change. local === lastSent, but main's truth
    // diverged: must re-send.
    expect(shouldSendTerminalResize({ lastSent: DESKTOP, local: DESKTOP, external: PHONE })).toBe(true);
  });
});

// ---- AppOperations integration: arbitration at the real RPC boundary ------

const TERMINAL_ID = "11111111-2222-4333-8444-555555555555";

function makeHarness(desktopActive: boolean) {
  const events = new AppEventBus();
  const resize = vi.fn();
  const terminal = { id: TERMINAL_ID, projectId: "p-1", cols: DESKTOP.cols, rows: DESKTOP.rows, status: "running" };
  const operations = new AppOperations({
    repository: {
      getProject: () => null,
      getSettings: () => ({}),
    },
    runs: { send: () => undefined, cancel: () => undefined, command: () => undefined },
    approvals: { resolve: () => undefined },
    council: { start: () => undefined, cancel: () => undefined },
    terminals: {
      get: (id: string) => (id === TERMINAL_ID ? terminal : null),
      resize,
    },
    attention: { list: () => [], resolve: () => undefined, onAttentionChanged: () => undefined },
    events,
    appVersion: "test",
    userDataPath: rootDir,
    tempPath: rootDir,
    isDesktopWindowActive: () => desktopActive,
  } as never);
  return { events, operations, resize, terminal };
}

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(process.env.TEMP ?? process.cwd(), "coterm-geom-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("AppOperations.requestTerminalGeometry — desktop owns the grid while active", () => {
  it("drops a phone shrink when the desktop window is visible+focused and asserted the grid", () => {
    const { operations, resize } = makeHarness(true);
    operations.resizeTerminal({ terminalId: TERMINAL_ID, ...DESKTOP });
    resize.mockClear();
    operations.requestTerminalGeometry({ terminalId: TERMINAL_ID, cols: PHONE.cols, rows: PHONE.rows });
    expect(resize).not.toHaveBeenCalled();
  });

  it("applies the same phone claim when the desktop window is not active", () => {
    const { operations, resize } = makeHarness(false);
    operations.resizeTerminal({ terminalId: TERMINAL_ID, ...DESKTOP });
    resize.mockClear();
    operations.requestTerminalGeometry({ terminalId: TERMINAL_ID, cols: PHONE.cols, rows: PHONE.rows });
    expect(resize).toHaveBeenCalledWith(TERMINAL_ID, PHONE.cols, PHONE.rows);
  });

  it("still no-ops a claim that matches the current grid (dedupe kept)", () => {
    const { operations, resize, terminal } = makeHarness(false);
    operations.requestTerminalGeometry({ terminalId: TERMINAL_ID, cols: terminal.cols, rows: terminal.rows });
    expect(resize).not.toHaveBeenCalled();
  });

  it("clamps the claim rows to the documented 8..160 band before arbitrating", () => {
    const { operations, resize } = makeHarness(false);
    operations.requestTerminalGeometry({ terminalId: TERMINAL_ID, cols: PHONE.cols, rows: 499 });
    expect(resize).toHaveBeenCalledWith(TERMINAL_ID, PHONE.cols, 160);
  });

  it("a desktop resizeTerminal re-assertion (focus return) wins again afterwards", () => {
    const { operations, resize } = makeHarness(false);
    // Phone takes over while the desktop is away.
    operations.requestTerminalGeometry({ terminalId: TERMINAL_ID, cols: PHONE.cols, rows: PHONE.rows });
    expect(resize).toHaveBeenCalledWith(TERMINAL_ID, PHONE.cols, PHONE.rows);
    resize.mockClear();
    // Desktop window refocuses → tile re-fits + re-sends its grid.
    operations.resizeTerminal({ terminalId: TERMINAL_ID, ...DESKTOP });
    expect(resize).toHaveBeenCalledWith(TERMINAL_ID, DESKTOP.cols, DESKTOP.rows);
  });

  it("forgets the desktop assertion once the terminal exits", () => {
    const { events, operations, resize, terminal } = makeHarness(true);
    operations.resizeTerminal({ terminalId: TERMINAL_ID, ...DESKTOP });
    resize.mockClear();
    // The constructor subscribed this same bus for terminalExit cleanup.
    events.emit("terminalExit", { terminalId: TERMINAL_ID, projectId: "p-1", exitCode: 0 });
    operations.requestTerminalGeometry({ terminalId: TERMINAL_ID, cols: PHONE.cols, rows: PHONE.rows });
    expect(resize).toHaveBeenCalledWith(TERMINAL_ID, terminal.cols, PHONE.rows);
  });
});
