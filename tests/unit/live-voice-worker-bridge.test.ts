import { describe, expect, it, vi } from "vitest";
import { LiveVoiceWorkerBridge, parseWorkerEvent } from "../../src/main/voice/live/live-voice-worker-bridge";

describe("LiveVoiceWorkerBridge", () => {
  it("accepts bounded control/final-text events", () => {
    const bridge = new LiveVoiceWorkerBridge();
    const listener = vi.fn();
    bridge.onEvent(listener);
    const event = bridge.accept({
      type: "final-utterance",
      voiceSessionId: "vs-1",
      text: "幫我 check Codex",
      detectedLanguage: "zh",
      atMs: 123,
    });
    expect(event.type).toBe("final-utterance");
    expect(listener).toHaveBeenCalledOnce();
  });

  it("rejects raw media fields from the control bridge", () => {
    expect(() => parseWorkerEvent({
      type: "final-utterance",
      voiceSessionId: "vs-1",
      text: "hello",
      audioBase64: "AAAA",
      atMs: 123,
    })).toThrow(/audio/i);
    expect(() => parseWorkerEvent({
      type: "user-speech-started",
      voiceSessionId: "vs-1",
      pcmBytes: [1, 2],
      atMs: 123,
    })).toThrow(/audio/i);
  });

  it("accepts structured pipeline diagnostics without transcript or audio payloads", () => {
    expect(parseWorkerEvent({
      type: "stage",
      voiceSessionId: "vs-1",
      stage: "stt",
      state: "final",
      textLength: 12,
      durationMs: 340,
      atMs: 999,
    })).toMatchObject({
      type: "stage",
      stage: "stt",
      state: "final",
      textLength: 12,
      durationMs: 340,
    });
    expect(() => parseWorkerEvent({
      type: "stage",
      voiceSessionId: "vs-1",
      stage: "worker-mic",
      state: "frames",
      pcm: [1, 2, 3],
      atMs: 999,
    })).toThrow(/audio/i);
  });
});
