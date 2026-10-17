import { describe, expect, it } from "vitest";
import {
  buildStopPayload,
  createRecoveryScheduler,
  type RecoveryStep,
  planRecovery,
} from "../../src/renderer/src/components/terminal-recovery";

describe("buildStopPayload (mobile STOP contract)", () => {
  it("emits exactly one \\x03 for the active terminal", () => {
    const payload = buildStopPayload("term-1");
    expect(payload.terminalId).toBe("term-1");
    expect(payload.data).toBe("\x03");
    expect(payload.data.length).toBe(1);
  });

  it("does not include a close or kill signal", () => {
    const payload = buildStopPayload("term-2");
    expect(payload.data).toBe("\x03");
    expect(payload.data).not.toContain("\r");
    expect(payload.data).not.toContain("\n");
    expect(payload.data).not.toContain("\x1b");
  });

  it("returns a terminalId-only stub when given empty id (no-op, not a crash)", () => {
    const payload = buildStopPayload("");
    expect(payload.terminalId).toBe("");
    expect(payload.data).toBe("\x03");
  });
});

describe("planRecovery (hard refresh pipeline)", () => {
  // Verdict gap 3: no-op steps (cancel-pending-render, restore-local-geometry)
  // must be REMOVED. Every step in the plan must correspond to a real executed
  // side effect, so tests verify actual behavior, not named no-ops.
  it("contains no no-op steps — every step is an executed action", () => {
    const steps = planRecovery("term-1");
    const kinds = steps.map((s) => s.kind);
    expect(kinds).not.toContain("cancel-pending-render");
    expect(kinds).not.toContain("restore-local-geometry");
  });

  it("produces the canonical ordered recovery steps (remeasure → replay → canvas → focus)", () => {
    const steps = planRecovery("term-1");
    const kinds = steps.map((s) => s.kind);
    expect(kinds).toEqual([
      "remeasure",
      "request-authoritative-replay",
      "refresh-canvas",
      "restore-focus-scroll",
    ]);
  });

  it("every step targets the requested terminal", () => {
    const steps = planRecovery("term-42");
    for (const step of steps) {
      expect(step.terminalId).toBe("term-42");
    }
  });

  it("the replay step is authoritative (replace, not append)", () => {
    const steps = planRecovery("term-1");
    const replay = steps.find((s) => s.kind === "request-authoritative-replay") as RecoveryStep & { replace?: boolean };
    expect(replay).toBeDefined();
    expect(replay.replace).toBe(true);
  });

  it("the canvas refresh step runs even with no new PTY bytes (refresh is not gated on output)", () => {
    const steps = planRecovery("term-1");
    const canvas = steps.find((s) => s.kind === "refresh-canvas");
    expect(canvas).toBeDefined();
    expect((canvas as RecoveryStep & { gatedOnOutput?: boolean }).gatedOnOutput).toBeFalsy();
  });

  it("remeasure is the first step, restore-focus-scroll is the last", () => {
    const steps = planRecovery("term-1");
    expect(steps[0]!.kind).toBe("remeasure");
    expect(steps[steps.length - 1]!.kind).toBe("restore-focus-scroll");
  });
});

describe("createRecoveryScheduler (coalesced reflow)", () => {
  // Verdict gap 2: sidebar/explorer/split/exclusive/orientation/manual refresh
  // must all converge on ONE coalesced scheduler. The scheduler records the
  // last reason so the caller can verify multiple triggers collapsed.
  it("coalesces multiple rapid schedules into a single run", async () => {
    const runs: string[] = [];
    const scheduler = createRecoveryScheduler(() => runs.push("run"), 20);
    scheduler.schedule("sidebar");
    scheduler.schedule("explorer");
    scheduler.schedule("split");
    scheduler.schedule("orientation");
    await new Promise((r) => setTimeout(r, 60));
    expect(runs).toEqual(["run"]);
  });

  it("records the last reason so callers can audit which trigger won", async () => {
    const seen: string[] = [];
    const scheduler = createRecoveryScheduler((reason) => seen.push(reason), 20);
    scheduler.schedule("sidebar");
    scheduler.schedule("explorer");
    scheduler.schedule("manual-refresh");
    await new Promise((r) => setTimeout(r, 60));
    // The final run reflects the latest trigger.
    expect(seen).toEqual(["manual-refresh"]);
  });

  it("cancel prevents a pending run from firing", async () => {
    const runs: string[] = [];
    const scheduler = createRecoveryScheduler(() => runs.push("run"), 20);
    scheduler.schedule("sidebar");
    scheduler.cancel();
    await new Promise((r) => setTimeout(r, 60));
    expect(runs).toEqual([]);
  });

  it("a later schedule after cancel still runs", async () => {
    const runs: string[] = [];
    const scheduler = createRecoveryScheduler(() => runs.push("run"), 20);
    scheduler.schedule("sidebar");
    scheduler.cancel();
    scheduler.schedule("exclusive");
    await new Promise((r) => setTimeout(r, 60));
    expect(runs).toEqual(["run"]);
  });
});
