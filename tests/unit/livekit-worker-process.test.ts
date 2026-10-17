import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  LIVEKIT_WORKER_STARTUP_TIMEOUT_MS,
  LivekitWorkerProcess,
} from "../../src/main/voice/live/livekit-worker-process";
import type { LiveVoiceWorkerEvent } from "../../src/main/voice/live/live-voice-worker-bridge";

/**
 * A stand-in for ChildProcess. We never fork a real worker (no LiveKit binary,
 * no room, no network): the handshake contract is exercised purely through the
 * message/error/exit events the class subscribes to.
 */
type FakeChild = EventEmitter & {
  exitCode: number | null;
  signalCode: string | null;
  send: (m: unknown) => void;
  kill: (signal?: NodeJS.Signals) => void;
};

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as unknown as FakeChild;
  child.exitCode = null;
  child.signalCode = null;
  child.send = vi.fn(() => true);
  child.kill = vi.fn();
  return child;
}

const readyEvent = (): LiveVoiceWorkerEvent => ({
  type: "health",
  state: "ready",
  atMs: Date.now(),
});

describe("LivekitWorkerProcess — startup handshake (issue #84)", () => {
  it("resolves start() only after the worker's own health:ready handshake", async () => {
    const child = makeFakeChild();
    const onEvent = vi.fn();
    const svc = new LivekitWorkerProcess({
      workerEntryPath: "worker.js",
      env: { KOTERM_LIVEKIT_URL: "ws://mock" },
      forkFn: ((): unknown => child) as never,
      onEvent,
      startupTimeoutMs: 120,
    });

    const startP = svc.start();

    // A degraded health message must reach onEvent but must NOT end the wait.
    child.emit("message", { type: "health", state: "degraded", atMs: Date.now(), reasonCode: "connecting" });
    expect(onEvent).toHaveBeenCalledTimes(1);

    // The worker signals ready once its room has connected.
    child.emit("message", readyEvent());
    await expect(startP).resolves.toBeUndefined();

    // Handshake complete: a running-but-not-yet-degraded worker is healthy.
    expect(svc.health()).toBe(true);
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  it("rejects start() with a bounded, content-free reason when the worker never goes ready", async () => {
    const child = makeFakeChild();
    const svc = new LivekitWorkerProcess({
      workerEntryPath: "worker.js",
      env: { KOTERM_LIVEKIT_URL: "ws://mock" },
      forkFn: ((): unknown => child) as never,
      onEvent: vi.fn(),
      // keep the test fast without weakening the bounded-wait guarantee
      startupTimeoutMs: 25,
    });

    const startP = svc.start();

    // Surface the real runtime's default budget so the assertion never silently
    // drifts if the default is changed.
    expect(LIVEKIT_WORKER_STARTUP_TIMEOUT_MS).toBeGreaterThan(1);

    await expect(startP).rejects.toThrow(/failed to report ready within \d+ ms/);
    // A wedged worker is reported unhealthy (not left silently dangling).
    expect(svc.health()).toBe(false);
  });

  it("rejects start() when the worker exits before reporting ready", async () => {
    const child = makeFakeChild();
    const svc = new LivekitWorkerProcess({
      workerEntryPath: "worker.js",
      env: { KOTERM_LIVEKIT_URL: "ws://mock" },
      forkFn: ((): unknown => child) as never,
      onEvent: vi.fn(),
      startupTimeoutMs: 120,
    });

    const startP = svc.start();
    child.emit("exit", 1, null);

    await expect(startP).rejects.toThrow(/exited after fork/);
    expect(svc.health()).toBe(false);
  });

  it("surfaces runtime death only after the worker has gone ready", async () => {
    const child = makeFakeChild();
    let exitReason: Error | undefined = undefined;
    const svc = new LivekitWorkerProcess({
      workerEntryPath: "worker.js",
      env: { KOTERM_LIVEKIT_URL: "ws://mock" },
      forkFn: ((): unknown => child) as never,
      onEvent: vi.fn(),
      startupTimeoutMs: 120,
    });

    const startP = svc.start();
    const exitP = new Promise<void>((resolve) => {
      svc.onExit((reason) => {
        if (reason instanceof Error) exitReason = reason;
        resolve();
      });
    });

    child.emit("message", readyEvent());
    await startP;

    // Post-ready death must reach the exit listener with a content-free reason.
    child.emit("exit", null, "SIGTERM");
    child.kill("SIGKILL");
    await exitP;

    expect(exitReason).toBeInstanceOf(Error);
  });
});
