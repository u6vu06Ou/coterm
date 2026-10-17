// Private #50/#51: cold-start is measured in three metadata-only stages —
// profile resolve, PTY spawn, CLI first output. The hook payload must never
// carry the command line, cwd, or any env value.
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppEventBus } from "../../src/main/core/event-bus";
import { PtyManager, type ColdStartTiming } from "../../src/main/terminal/pty-manager";

describe.skipIf(process.platform !== "win32")("pty cold-start metadata timing", () => {
  let directory: string;
  let events: AppEventBus;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ai-terminal-coldstart-"));
    events = new AppEventBus();
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("reports resolve/spawn/first-output durations with no env or command", async () => {
    const timings: ColdStartTiming[] = [];
    const manager = new PtyManager(events, 2, undefined, {
      onColdStartTiming: (timing) => timings.push(timing),
    });
    try {
      const terminal = manager.create({
        projectId: "69bf5cf4-f48a-46d8-8c65-a77f049e07e8",
        profile: "cmd",
        cwd: directory,
        isAgent: false,
        agentProfile: null,
      });
      const timing = await new Promise<ColdStartTiming>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no first output within 25s")), 25_000);
        const poll = setInterval(() => {
          if (timings.length > 0) {
            clearTimeout(timer);
            clearInterval(poll);
            resolve(timings[0]!);
          }
        }, 25);
      });
      expect(timing.terminalId).toBe(terminal.id);
      expect(timing.profile).toBe("cmd");
      expect(timing.shellKind).toBe("cmd");
      expect(timing.resolveMs).toBeGreaterThanOrEqual(0);
      expect(timing.spawnMs).toBeGreaterThanOrEqual(0);
      expect(timing.firstOutputMs).toBeGreaterThanOrEqual(0);
      // Metadata-only contract: exactly these keys, nothing else.
      expect(Object.keys(timing).sort()).toEqual([
        "firstOutputMs",
        "profile",
        "resolveMs",
        "shellKind",
        "spawnMs",
        "terminalId",
      ]);
      // Exactly once per terminal.
      manager.write(terminal.id, "echo SECOND_OUTPUT_MARKER\r");
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(timings).toHaveLength(1);
      manager.kill(terminal.id);
    } finally {
      manager.dispose();
    }
  });

  it("the production bootstrap wiring (hook → bus event) delivers the timing", async () => {
    // Mirrors src/main/index.ts: the hook republishes onto the shared bus so
    // Phase 4 consumers never reach into PtyManager internals.
    const manager = new PtyManager(events, 2, undefined, {
      onColdStartTiming: (timing) => events.emit("coldStartTiming", timing),
    });
    try {
      const received = new Promise<{ terminalId: string; firstOutputMs: number }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("coldStartTiming not emitted within 25s")), 25_000);
        events.on("coldStartTiming", (timing) => {
          clearTimeout(timer);
          resolve(timing);
        });
      });
      const terminal = manager.create({
        projectId: "69bf5cf4-f48a-46d8-8c65-a77f049e07e8",
        profile: "cmd",
        cwd: directory,
        isAgent: false,
        agentProfile: null,
      });
      const timing = await received;
      expect(timing.terminalId).toBe(terminal.id);
      expect(timing.firstOutputMs).toBeGreaterThanOrEqual(0);
      manager.kill(terminal.id);
    } finally {
      manager.dispose();
    }
  });
});
