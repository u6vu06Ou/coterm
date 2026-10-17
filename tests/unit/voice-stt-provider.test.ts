import { describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../src/shared/types";
import {
  VoiceSttProviderRegistry,
  type VoiceSttProvider,
  type VoiceSttProviderRequest,
} from "../../src/main/voice/live/voice-stt-provider";

const voiceSettings = {
  enabled: true,
  lang: "zh-TW",
  sttLanguageMode: "auto",
  responseLanguage: "zh-TW",
  sttUrl: "https://example.invalid",
  sttModel: "whisper-1",
  sttApiKey: "",
  streamingDictation: true,
  live: {
    enabled: true,
    provider: "cascade",
    serverUrl: "ws://127.0.0.1:7880",
    apiKey: "",
    apiSecret: "",
    ttsVoice: "zh-TW-HsiaoChenNeural",
    geminiApiKey: "",
    geminiModel: "gemini-3.1-flash-live-preview",
  },
} satisfies AppSettings["voice"];

function request(): VoiceSttProviderRequest {
  return {
    audio: new ArrayBuffer(4),
    mimeType: "audio/webm",
    language: "auto",
    settings: voiceSettings,
  };
}

describe("VoiceSttProviderRegistry", () => {
  it("uses the preferred provider when available", async () => {
    const cloudTranscribe = vi.fn(async () => ({ text: "cloud" }));
    const local: VoiceSttProvider = {
      id: "local-transcribe-cpp",
      isAvailable: () => true,
      transcribe: vi.fn(async () => ({ text: "local" })),
    };
    const cloud: VoiceSttProvider = {
      id: "existing-cloud",
      isAvailable: () => true,
      transcribe: cloudTranscribe,
    };
    const registry = new VoiceSttProviderRegistry([cloud, local]);
    await expect(registry.transcribe(request(), "local-transcribe-cpp")).resolves.toEqual({ text: "local" });
    expect(cloudTranscribe).not.toHaveBeenCalled();
  });

  it("falls back only when the preferred provider is unavailable", async () => {
    const local: VoiceSttProvider = {
      id: "local-transcribe-cpp",
      isAvailable: () => false,
      transcribe: vi.fn(async () => ({ text: "local" })),
    };
    const cloud: VoiceSttProvider = {
      id: "existing-cloud",
      isAvailable: () => true,
      transcribe: vi.fn(async () => ({ text: "cloud" })),
    };
    const registry = new VoiceSttProviderRegistry([local, cloud]);
    await expect(registry.transcribe(request(), "local-transcribe-cpp")).resolves.toEqual({ text: "cloud" });
  });

  it("does not silently fall back after a selected provider starts processing audio", async () => {
    const cloudTranscribe = vi.fn(async () => ({ text: "cloud" }));
    const local: VoiceSttProvider = {
      id: "local-transcribe-cpp",
      isAvailable: () => true,
      transcribe: vi.fn(async () => { throw new Error("local failed"); }),
    };
    const cloud: VoiceSttProvider = {
      id: "existing-cloud",
      isAvailable: () => true,
      transcribe: cloudTranscribe,
    };
    const registry = new VoiceSttProviderRegistry([local, cloud]);
    await expect(registry.transcribe(request(), "local-transcribe-cpp")).rejects.toThrow("local failed");
    expect(cloudTranscribe).not.toHaveBeenCalled();
  });
});
