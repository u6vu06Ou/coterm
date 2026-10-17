import { describe, expect, it } from "vitest";
import { appSettingsSchema } from "../../src/shared/schema";
import { mergeAppSettingsPatch } from "../../src/shared/settings-patch";

describe("voice settings migration contract", () => {
  it("upgrades legacy voice settings without enabling desktop capture", () => {
    const parsed = appSettingsSchema.parse({ voice: { enabled: false, lang: "zh-TW" } });
    expect(parsed.voice).toEqual({
      enabled: false,
      lang: "zh-TW",
      sttLanguageMode: "auto",
      responseLanguage: "zh-TW",
      sttUrl: "",
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
    });
  });

  it("rejects non-http STT URLs and blank model ids", () => {
    expect(() => appSettingsSchema.parse({
      voice: { enabled: true, lang: "zh-TW", sttUrl: "file:///tmp/audio", sttModel: "whisper-1" },
    })).toThrow();
    expect(() => appSettingsSchema.parse({
      voice: { enabled: true, lang: "zh-TW", sttUrl: "http://127.0.0.1:8000", sttModel: " " },
    })).toThrow();
  });
});

describe("browser superpowers flags contract (Phase 7, work order §14)", () => {
  it("enables the Beta P0 tier but leaves unfinished P1 opt-in for existing installs", () => {
    expect(appSettingsSchema.parse({}).browser).toEqual({ superpowersP0: true, superpowersP1: true });
    expect(appSettingsSchema.parse({ browserNetwork: { mode: "block" } }).browser.superpowersP0).toBe(true);
    expect(appSettingsSchema.parse({ browser: { superpowersP0: false } }).browser).toEqual({ superpowersP0: false, superpowersP1: true });
  });

  it("patch semantics: flipping one flag deep-merges and keeps the other (#60)", () => {
    const base = appSettingsSchema.parse({});
    expect(mergeAppSettingsPatch(base, { browser: { superpowersP0: false } }).browser).toEqual({ superpowersP0: false, superpowersP1: true });
    expect(mergeAppSettingsPatch(base, { browser: {} }).browser).toEqual(base.browser);
  });
});
