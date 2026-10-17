import { describe, expect, it, vi } from "vitest";
import { SpeechArbiter, type SpeechRequest } from "../../src/renderer/src/voice-agent/speech-arbiter";
import type { TtsProvider, TtsVoice, VoiceAgentSpeechOutcome } from "../../src/renderer/src/voice-agent/tts";

function request(over: Partial<SpeechRequest>): SpeechRequest {
  return {
    id: over.id ?? crypto.randomUUID(),
    role: over.role ?? "session",
    text: over.text ?? "hello",
    priority: over.priority ?? "completed",
    interruptible: over.interruptible ?? true,
    createdAt: over.createdAt ?? 1000,
    ...over,
  };
}

function fakeProvider() {
  const pending: Array<{ text: string; resolve: (value: { spoken: boolean; cancelled: boolean }) => void; signal?: AbortSignal }> = [];
  const speak = vi.fn((text: string, _voice: TtsVoice | null, options: { rate: number; volume: number; signal?: AbortSignal }) =>
    new Promise<VoiceAgentSpeechOutcome>((resolve) => {
      pending.push({ text, resolve, ...(options.signal ? { signal: options.signal } : {}) });
      options.signal?.addEventListener("abort", () => resolve({ spoken: true, cancelled: true }), { once: true });
    }));
  const stop = vi.fn();
  const provider: TtsProvider = {
    id: "fake",
    listVoices: async (): Promise<TtsVoice[]> => [{ id: "a", name: "A" }, { id: "b", name: "B" }],
    speak,
    stop,
    capabilities: () => ({ supportsVoiceSelection: true, supportsRate: true, supportsVolume: true }),
  };
  return { provider, pending, speak, stop };
}

describe("SpeechArbiter", () => {
  it("plays one request at a time and selects role-specific voices", async () => {
    const { provider, pending, speak } = fakeProvider();
    const arbiter = new SpeechArbiter(provider, {
      now: () => 1000,
      profileFor: (role) => ({ voiceId: role === "supervisor" ? "a" : "b", rate: 1, volume: 1 }),
    });
    const first = arbiter.request(request({ id: "1", role: "session", text: "one" }));
    const second = arbiter.request(request({ id: "2", role: "supervisor", text: "two", priority: "user-interaction" }));
    await Promise.resolve();
    expect(pending.map((item) => item.text)).toEqual(["one"]);
    pending[0]!.resolve({ spoken: true, cancelled: false });
    await first.outcome;
    await Promise.resolve();
    expect(pending.map((item) => item.text)).toEqual(["one", "two"]);
    pending[1]!.resolve({ spoken: true, cancelled: false });
    await expect(second.outcome).resolves.toEqual({ spoken: true, cancelled: false });
    expect(speak).toHaveBeenNthCalledWith(1, "one", expect.objectContaining({ id: "b" }), expect.any(Object));
    expect(speak).toHaveBeenNthCalledWith(2, "two", expect.objectContaining({ id: "a" }), expect.any(Object));
  });

  it("prioritizes queued needs-input over completion", async () => {
    const { provider, pending } = fakeProvider();
    const arbiter = new SpeechArbiter(provider, { now: () => 1000, profileFor: () => ({ voiceId: null, rate: 1, volume: 1 }) });
    const current = arbiter.request(request({ id: "current", text: "current", priority: "completed" }));
    const completion = arbiter.request(request({ id: "completion", text: "completion", priority: "completed" }));
    const input = arbiter.request(request({ id: "input", text: "input", priority: "needs-input" }));
    await Promise.resolve();
    pending[0]!.resolve({ spoken: true, cancelled: false });
    await current.outcome;
    await Promise.resolve();
    expect(pending[1]!.text).toBe("input");
    pending[1]!.resolve({ spoken: true, cancelled: false });
    await input.outcome;
    await Promise.resolve();
    pending[2]!.resolve({ spoken: true, cancelled: false });
    await completion.outcome;
  });

  it("dedupes semantic keys inside the configured window", async () => {
    const { provider, pending, speak } = fakeProvider();
    const arbiter = new SpeechArbiter(provider, { now: () => 1000, profileFor: () => ({ voiceId: null, rate: 1, volume: 1 }) });
    const first = arbiter.request(request({ dedupeKey: "same" }));
    await Promise.resolve();
    const duplicate = arbiter.request(request({ dedupeKey: "same" }));
    await expect(duplicate.outcome).resolves.toEqual({ spoken: false, cancelled: false });
    pending[0]!.resolve({ spoken: true, cancelled: false });
    await first.outcome;
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it("barge-in cancels current speech and drops queued completion/progress", async () => {
    const { provider, stop } = fakeProvider();
    const arbiter = new SpeechArbiter(provider, { now: () => 1000, profileFor: () => ({ voiceId: null, rate: 1, volume: 1 }) });
    const current = arbiter.request(request({ id: "current", priority: "needs-input" }));
    const completion = arbiter.request(request({ id: "completion", priority: "completed" }));
    arbiter.request(request({ id: "progress", priority: "progress" }));
    await Promise.resolve();
    arbiter.bargeIn();
    await expect(current.outcome).resolves.toEqual({ spoken: true, cancelled: true });
    await expect(completion.outcome).resolves.toEqual({ spoken: false, cancelled: true });
    expect(stop).toHaveBeenCalled();
  });
});
