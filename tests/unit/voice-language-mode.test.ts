import { afterEach, describe, expect, it, vi } from "vitest";
import { appSettingsSchema } from "../../src/shared/schema";
import { transcribeVoice } from "../../src/main/voice/transcribe";
import { buildVoiceVocabulary } from "../../src/main/voice/live/voice-vocabulary";

afterEach(() => vi.unstubAllGlobals());

describe("live voice language mode", () => {
  it("defaults to auto STT + zh-TW response", () => {
    const settings = appSettingsSchema.parse({});
    expect(settings.voice.sttLanguageMode).toBe("auto");
    expect(settings.voice.responseLanguage).toBe("zh-TW");
    expect(settings.voice.lang).toBe("zh-TW");
  });

  it("auto STT sends neither a fixed language hint nor a hard Chinese prompt", async () => {
    const captured: { body?: FormData } = {};
    vi.stubGlobal("fetch", vi.fn(async (_url: URL, init?: RequestInit) => {
      captured.body = init?.body as FormData;
      return new Response(JSON.stringify({ text: "check Codex Kimi" }), { status: 200 });
    }));
    await transcribeVoice({
      audio: new Uint8Array([1, 2, 3]).buffer,
      mimeType: "audio/webm",
      lang: "auto",
      serverUrl: "http://127.0.0.1:8765/v1/audio/transcriptions",
      model: "whisper-1",
    });
    expect(captured.body?.get("language")).toBeNull();
    expect(captured.body?.get("prompt")).toBeNull();
  });

  it("preserves provider-reported detected language without inventing one", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: "hello", language: "en" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: "hello" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const common = {
      audio: new Uint8Array([1]).buffer,
      mimeType: "audio/webm",
      lang: "auto",
      serverUrl: "http://127.0.0.1:8765/v1/audio/transcriptions",
      model: "whisper-1",
    } as const;
    expect((await transcribeVoice(common)).detectedLanguage).toBe("en");
    expect(await transcribeVoice(common)).not.toHaveProperty("detectedLanguage");
  });

  it("builds a bounded engineering vocabulary", () => {
    const vocabulary = buildVoiceVocabulary(["codex-local-big", "HyperMesh", ...Array.from({ length: 100 }, (_, i) => `project-${i}`)]);
    expect(vocabulary).toContain("Codex");
    expect(vocabulary).toContain("RBE2");
    expect(vocabulary.length).toBeLessThanOrEqual(64);
  });
});
