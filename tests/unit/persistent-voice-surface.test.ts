import { describe, expect, it, vi } from "vitest";
import { PersistentVoiceSurface, parseVoiceSessionCommand } from "../../src/main/voice/live/persistent-voice-surface";

describe("PersistentVoiceSurface", () => {
  it("rejects raw-audio-shaped fields at the bounded control boundary", () => {
    expect(() => parseVoiceSessionCommand({ action: "start", audioBase64: "AAAA" })).toThrow("Raw audio");
  });

  it("bounds utterances and routes one command to the controller", async () => {
    const controller = {
      submitUtterance: vi.fn(async () => ({ text: "ok" })),
      get: vi.fn(() => ({ id: "vs-1", status: "speaking" })),
    } as never;
    const surface = new PersistentVoiceSurface(controller);
    const result = await surface.handle({ action: "utterance", voiceSessionId: "vs-1", text: "  hello  " });
    expect((controller as { submitUtterance: ReturnType<typeof vi.fn> }).submitUtterance).toHaveBeenCalledWith("vs-1", "hello");
    expect(result.turn).toEqual({ text: "ok" });
  });

  it("rejects oversized text instead of persisting it", () => {
    expect(() => parseVoiceSessionCommand({
      action: "utterance",
      voiceSessionId: "vs-1",
      text: "x".repeat(12_001),
    })).toThrow("utterance");
  });

  it("returns bounded fallback reason and diagnostics when realtime attach degrades", async () => {
    const session = {
      id: "vs-1",
      status: "listening",
      transport: "chunked",
    };
    const controller = {
      start: vi.fn(() => session),
      get: vi.fn(() => session),
    } as never;
    const surface = new PersistentVoiceSurface(controller, {
      attach: async () => null,
      fallbackReason: () => "LiveKit unavailable",
      diagnostics: () => ({
        voiceSessionId: "vs-1",
        updatedAtMs: 1,
        stages: { transport: { state: "chunked", atMs: 1, reasonCode: "live-unavailable" } },
      }),
    });
    const result = await surface.handle({ action: "start" });
    expect(result.live).toBeNull();
    expect(result.liveFallbackReason).toBe("LiveKit unavailable");
    expect(result.diagnostics?.stages.transport?.reasonCode).toBe("live-unavailable");
  });
});
