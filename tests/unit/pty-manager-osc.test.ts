import { describe, expect, it } from "vitest";
import { AppEventBus } from "../../src/main/core/event-bus";
import { PtyManager, sanitizeCommand } from "../../src/main/terminal/pty-manager";
import type { CommandResult } from "@shared/types";

const ESC = "\x1b";
const BEL = "\x07";
const osc633 = (code: string, arg?: string): string =>
  `${ESC}]${arg === undefined ? `633;${code}` : `633;${code};${arg}`}${BEL}`;

/**
 * Drive a PtyManager's internal OSC parser by writing marker bytes via the
 * public onData path. PtyManager.create spawns a real PTY; instead we exercise
 * the parser+state machine through the private _parseOsc by feeding markers
 * as if they arrived from the shell. We do this by creating a terminal and
 * then calling the (test-only) feed path: write() would hit a real PTY, so we
 * reach the parser through the event the manager emits.
 *
 * Simpler: instantiate PtyManager, create a terminal (real PTY on win32), then
 * directly invoke the parser pipeline by emitting a synthetic data chunk into
 * the manager's onData. But onData is wired to the real PTY. So we instead
 * test the state machine by feeding chunks through a tiny harness that mirrors
 * _parseOsc: parseOscChunk + _applyOscMarker. Since _applyOscMarker is
 * private, we drive it through the public surface: a fake PTY is overkill, so
 * we re-implement the feed by calling the manager's internal method via a
 * cast.
 */

// Access the private parser pipeline for unit testing without spawning a PTY.
type ManagedTerminalInternal = {
  oscCarry: string;
  shellCwd: string;
  lifecycle: { command: string; cwd: string; startedAt: string | null; hasPreExec: boolean } | null;
  lastCommand: CommandResult | null;
};

describe("PtyManager OSC lifecycle state machine", () => {
  it("builds a CommandResult only on a rich E+C+D lifecycle (exit 0)", () => {
    const events = new AppEventBus();
    const manager = new PtyManager(events);
    // Create a terminal without spawning where possible: PtyManager.create
    // spawns a real PTY. On non-win32 we skip; the state machine is platform-
    // independent so we test it via a direct managed-entry simulation.
    // Instead, build a minimal managed terminal by calling create on win32 and
    // feeding markers through the real onData by writing to the PTY is flaky.
    //
    // We test the pure state machine by reusing the exported parser + a local
    // reducer that mirrors _applyOscMarker. This is a white-box test of the
    // decision logic (the part that can fabricate or drop results).
    const state = simulateLifecycle([
      osc633("A"),
      osc633("B"),
      osc633("E", "ls -la"),
      osc633("C"),
      osc633("D", "0"),
    ]);
    expect(state.lastCommand).not.toBeNull();
    expect(state.lastCommand?.command).toBe("ls -la");
    expect(state.lastCommand?.exitCode).toBe(0);
    expect(state.lastCommand?.durationMs).toBeGreaterThanOrEqual(0);
    expect(state.lifecycle).toBeNull();
    manager.dispose();
  });

  it("records a non-zero exit code", () => {
    const state = simulateLifecycle([
      osc633("E", "git status"),
      osc633("C"),
      osc633("D", "1"),
    ]);
    expect(state.lastCommand?.exitCode).toBe(1);
    expect(state.lastCommand?.command).toBe("git status");
  });

  it("D with no code → exitCode null (not fabricated as 0)", () => {
    const state = simulateLifecycle([
      osc633("E", "echo hi"),
      osc633("C"),
      osc633("D"),
    ]);
    expect(state.lastCommand?.exitCode).toBeNull();
  });

  it("emits terminalCommand exactly once per lifecycle", () => {
    const { manager, terminalId } = makeManager();
    const events = (manager as unknown as { events: AppEventBus }).events;
    const emitted: CommandResult[] = [];
    events.on("terminalCommand", ({ result }) => emitted.push(result));
    feed(manager, terminalId, [
      osc633("E", "ls"),
      osc633("C"),
      osc633("D", "0"),
    ]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.command).toBe("ls");
    manager.dispose();
  });

  it("does not emit when E is missing (C+D only)", () => {
    const state = simulateLifecycle([
      osc633("C"),
      osc633("D", "0"),
    ]);
    expect(state.lastCommand).toBeNull();
  });

  it("does not emit when C is missing (E+D only)", () => {
    const state = simulateLifecycle([
      osc633("E", "ls"),
      osc633("D", "0"),
    ]);
    expect(state.lastCommand).toBeNull();
  });

  it("a new prompt start (A) clears an orphaned lifecycle", () => {
    // E arrives but no C/D; next prompt start must drop the stale lifecycle so
    // it can't leak into the next command.
    const state = simulateLifecycle([
      osc633("E", "stale-cmd"),
      osc633("A"), // new prompt — orphan cleared
      osc633("E", "fresh-cmd"),
      osc633("C"),
      osc633("D", "0"),
    ]);
    expect(state.lastCommand?.command).toBe("fresh-cmd");
  });

  it("uses the latest OSC 633 P;Cwd value for the next command", () => {
    const state = simulateLifecycle([
      osc633("P", "Cwd=D:\\next"),
      osc633("E", "Get-Location"),
      osc633("C"),
      osc633("D", "0"),
    ]);
    expect(state.lastCommand?.cwd).toBe("D:\\next");
  });

  it("does not create ledger noise for an empty accepted line", () => {
    const state = simulateLifecycle([
      osc633("E", ""),
      osc633("C"),
      osc633("D", "0"),
    ]);
    expect(state.lastCommand).toBeNull();
  });
});

describe("sanitizeCommand — privacy boundary", () => {
  it("redacts an api_key value before it reaches a CommandResult", () => {
    const safe = sanitizeCommand("curl -H api_key=super-secret-token-value https://x");
    expect(safe).not.toContain("super-secret-token-value");
    expect(safe).toContain("[REDACTED]");
  });

  it("caps an over-long command", () => {
    const safe = sanitizeCommand("x".repeat(10_000));
    expect(safe.length).toBeLessThanOrEqual(4_001);
    expect(safe.endsWith("…")).toBe(true);
  });
});

// --- Test harness -----------------------------------------------------------
// PtyManager.create spawns a real PTY. To unit-test the OSC state machine
// without a PTY, we insert a synthetic managed terminal into the Map and drive
// the private _parseOsc via a cast. This mirrors exactly what the real onData
// handler does, without depending on pwsh being installed.

interface ManagedTerminalFull extends ManagedTerminalInternal {
  info: { id: string; projectId: string; cwd: string };
}

function makeManager(): { manager: PtyManager; terminalId: string } {
  const events = new AppEventBus();
  const manager = new PtyManager(events);
  const id = "00000000-0000-4000-8000-000000000001";
  const managed: ManagedTerminalFull = {
    info: { id, projectId: "00000000-0000-4000-8000-000000000000", cwd: "D:\\proj" },
    oscCarry: "",
    shellCwd: "D:\\proj",
    lifecycle: null,
    lastCommand: null,
  };
  (manager as unknown as { terminals: Map<string, ManagedTerminalFull> }).terminals.set(id, managed);
  return { manager, terminalId: id };
}

function feed(manager: PtyManager, terminalId: string, chunks: string[]): void {
  const terminals = (manager as unknown as { terminals: Map<string, ManagedTerminalInternal> }).terminals;
  const parseOsc = (manager as unknown as {
    _parseOsc(t: ManagedTerminalInternal, data: string): void;
  })._parseOsc.bind(manager);
  const t = terminals.get(terminalId);
  if (!t) throw new Error("terminal not found in test harness");
  for (const chunk of chunks) parseOsc(t, chunk);
}

/**
 * Pure simulation of the lifecycle reducer for cases that don't need the event
 * bus. Mirrors PtyManager._applyOscMarker decision logic exactly (drives the
 * real method).
 */
function simulateLifecycle(chunks: string[]): {
  lastCommand: CommandResult | null;
  lifecycle: ManagedTerminalInternal["lifecycle"];
} {
  const { manager, terminalId } = makeManager();
  feed(manager, terminalId, chunks);
  const terminals = (manager as unknown as { terminals: Map<string, ManagedTerminalInternal> }).terminals;
  const state = terminals.get(terminalId)!;
  const result = { lastCommand: state.lastCommand, lifecycle: state.lifecycle };
  manager.dispose();
  return result;
}
