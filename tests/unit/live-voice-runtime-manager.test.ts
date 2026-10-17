import { describe, expect, it, vi } from "vitest";
import { LiveVoiceRuntimeManager, type LiveVoiceManagedProcess } from "../../src/main/voice/live/live-voice-runtime-manager";

function fakeProcess(): LiveVoiceManagedProcess & { exit(reason?: unknown): void } {
  let listener: ((reason?: unknown) => void) | null = null;
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    health: vi.fn(async () => true),
    onExit: (next) => { listener = next; return () => { listener = null; }; },
    exit: (reason) => listener?.(reason),
  };
}

describe("LiveVoiceRuntimeManager", () => {
  it("isolates worker crash as Voice degraded instead of throwing into Coterm", async () => {
    const server = fakeProcess();
    const worker = fakeProcess();
    const changes = vi.fn();
    const manager = new LiveVoiceRuntimeManager({ server, worker, onStateChanged: changes });
    await expect(manager.start()).resolves.toBe("ready");
    expect(() => worker.exit(new Error("worker crashed"))).not.toThrow();
    expect(manager.getState()).toBe("degraded");
    expect(changes).toHaveBeenCalledWith("degraded", "worker crashed");
  });

  it("contains startup failure and stops both optional processes safely", async () => {
    const server = fakeProcess();
    const worker = fakeProcess();
    worker.start = vi.fn(async () => { throw new Error("missing dependency"); });
    const manager = new LiveVoiceRuntimeManager({ server, worker });
    await expect(manager.start()).resolves.toBe("degraded");
    await expect(manager.stop()).resolves.toBeUndefined();
    expect(manager.getState()).toBe("stopped");
  });
});
