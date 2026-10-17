import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppEventBus } from "../../src/main/core/event-bus";
import type { PtyManagerHooks } from "../../src/main/terminal/pty-manager";

/**
 * PTY output coalescer (2026-09-27): buffer incoming chunks per terminal and
 * flush them as one burst so downstream (detection, IPC forward, WS broadcast)
 * runs once per flush instead of once per chunk.
 *
 * The fake PTY exercises the REAL create()/onData/write wiring — no real
 * ConPTY and no hand-built terminal fixture.
 */
interface FakePtyLike {
  pid: number;
  write(data: string): void;
  kill(): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number }) => void): { dispose(): void };
  emitData(data: string): void;
  emitExit(exitCode: number): void;
}

vi.mock("@lydell/node-pty", () => {
  class FakePty implements FakePtyLike {
    pid = 42424;
    killed = false;
    private dataCallbacks: Array<(data: string) => void> = [];
    private exitCallbacks: Array<(e: { exitCode: number }) => void> = [];
    write(): void {}
    kill(): void { this.killed = true; }
    resize(): void {}
    onData(cb: (data: string) => void): { dispose(): void } {
      this.dataCallbacks.push(cb);
      return { dispose() {} };
    }
    onExit(cb: (e: { exitCode: number }) => void): { dispose(): void } {
      this.exitCallbacks.push(cb);
      return { dispose() {} };
    }
    emitData(data: string): void {
      for (const cb of this.dataCallbacks) cb(data);
    }
    emitExit(exitCode: number): void {
      for (const cb of this.exitCallbacks) cb({ exitCode });
    }
  }
  const fakes: FakePty[] = [];
  return {
    spawn: (): FakePty => {
      const fake = new FakePty();
      fakes.push(fake);
      return fake;
    },
    __fakes: fakes,
  };
});

import * as pty from "@lydell/node-pty";
import { PtyManager } from "../../src/main/terminal/pty-manager";

const fakes = (pty as unknown as { __fakes: Array<FakePtyLike & { killed: boolean }> }).__fakes;

type RecordedEvent =
  | { type: "terminalData"; terminalId: string; data: string; revision: number }
  | { type: "terminalExit"; terminalId: string; exitCode: number };

function lastFake(): FakePtyLike {
  return fakes[fakes.length - 1]!;
}

/** Narrow to a terminalData recording or fail the test (expect() does not narrow). */
function expectData(event: RecordedEvent): { terminalId: string; data: string; revision: number } {
  if (event.type !== "terminalData") throw new Error(`expected terminalData, got ${event.type}`);
  return event;
}

/** Narrow to a terminalExit recording or fail the test. */
function expectExit(event: RecordedEvent): { terminalId: string; exitCode: number } {
  if (event.type !== "terminalExit") throw new Error(`expected terminalExit, got ${event.type}`);
  return event;
}

function makeHarness(opts: { outputFlushMs?: number } = {}) {
  const hooks: PtyManagerHooks = {};
  if (opts.outputFlushMs !== undefined) hooks.outputFlushMs = opts.outputFlushMs;
  const bus = new AppEventBus();
  const manager = new PtyManager(bus, 2, undefined, hooks);
  const recorded: RecordedEvent[] = [];
  bus.on("terminalData", (message) => {
    recorded.push({ type: "terminalData", terminalId: message.terminalId, data: message.data, revision: message.revision });
  });
  bus.on("terminalExit", (message) => {
    recorded.push({ type: "terminalExit", terminalId: message.terminalId, exitCode: message.exitCode });
  });
  return {
    events: recorded,
    create: (info?: { isAgent?: boolean; agentProfile?: string | null }): string => {
      const created = manager.create({
        projectId: "proj-test",
        profile: "pwsh",
        cwd: process.cwd(),
        isAgent: info?.isAgent ?? false,
        agentProfile: info?.agentProfile ?? null,
      });
      return created.id;
    },
    write: (terminalId: string, data: string): void => manager.write(terminalId, data, "human"),
  };
}

describe("pty-manager output coalescer", () => {
  let harness: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    harness = makeHarness();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("buffers a burst into one in-order, lossless emission (FIFO)", () => {
    vi.useFakeTimers();
    const id = harness.create();
    const fake = lastFake();
    const chunks = ["A1", "B2", "C3", "D4", "E5"];
    for (const chunk of chunks) fake.emitData(chunk);

    // No synchronous flush expected inside the 16ms window.
    expect(harness.events).toHaveLength(0);

    vi.advanceTimersByTime(20);

    expect(harness.events).toHaveLength(1);
    const flushed = expectData(harness.events[0]!);
    expect(flushed.terminalId).toBe(id);
    expect(flushed.data).toBe("A1B2C3D4E5");
    expect(flushed.revision).toBe(1);
  });

  it("flushes synchronously once the pending window reaches the size cap", () => {
    vi.useFakeTimers();
    const cap = makeHarness();
    const id = cap.create();
    const fake = lastFake();
    const chunk = "x".repeat(20_480);
    fake.emitData(chunk);
    expect(cap.events).toHaveLength(0);
    fake.emitData(chunk);
    fake.emitData(chunk);
    fake.emitData(chunk); // 81,920 chars >= the 65,536-char cap

    expect(cap.events).toHaveLength(1);
    const flushed = expectData(cap.events[0]!);
    expect(flushed.terminalId).toBe(id);
    expect(flushed.data).toBe(chunk.repeat(4));
    expect(flushed.revision).toBe(1);
    // Reached synchronously: no timer advance happened at all.
  });

  it("flushes immediately on the first chunk after user input (echo latency)", () => {
    vi.useFakeTimers();
    const id = harness.create();
    const fake = lastFake();

    harness.write(id, "hello");

    // The echo chunk arrives BEFORE the 16ms timer fires: it must flush
    // synchronously rather than wait for the window.
    fake.emitData("echo: hello");
    expect(harness.events).toHaveLength(1);
    const echoFlush = expectData(harness.events[0]!);
    expect(echoFlush.data).toBe("echo: hello");
  });

  it("flushes trailing output before terminalExit (flush-first on exit)", () => {
    vi.useFakeTimers();
    const slow = makeHarness({ outputFlushMs: 120 });
    slow.create();
    const fake = lastFake();
    fake.emitData("final: partial output");

    fake.emitExit(0);

    expect(slow.events).toHaveLength(2);
    const flushed = expectData(slow.events[0]!);
    const exit = expectExit(slow.events[1]!);
    expect(flushed.data).toBe("final: partial output");
    expect(exit.exitCode).toBe(0);
  });
});
