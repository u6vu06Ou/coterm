import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../../src/main/storage/database";
import { Repository } from "../../src/main/storage/repository";

const STT_URL = "http://127.0.0.1:8765/v1/audio/transcriptions";
const STT_KEY = "unit-test-placeholder-stt-key";

describe("settings patch transaction (#60)", () => {
  let directory: string;
  let database: AppDatabase;
  let repository: Repository;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "coterm-settings-patch-"));
    database = new AppDatabase(join(directory, "state.sqlite"));
    await database.open();
    repository = new Repository(database);
    await repository.updateSettings({
      voice: {
        enabled: true,
        lang: "zh-TW",
        sttUrl: STT_URL,
        sttModel: "whisper-large-v3",
        sttApiKey: STT_KEY,
      },
    });
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("theme patch preserves the complete voice block", async () => {
    await repository.updateSettings({ theme: "light" });
    expect(repository.getSettings().voice).toEqual({
      enabled: true,
      lang: "zh-TW",
      sttLanguageMode: "auto",
      responseLanguage: "zh-TW",
      sttUrl: STT_URL,
      sttModel: "whisper-large-v3",
      sttApiKey: STT_KEY,
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
    expect(repository.getSettings().theme).toBe("light");
  });

  it("nested voice.lang patch preserves URL/model/key", async () => {
    await repository.updateSettings({ voice: { lang: "en-US" } });
    const { voice } = repository.getSettings();
    expect(voice.lang).toBe("en-US");
    expect(voice.sttUrl).toBe(STT_URL);
    expect(voice.sttModel).toBe("whisper-large-v3");
    expect(voice.sttApiKey).toBe(STT_KEY);
  });

  it("legacy full payload without voice keeps stored voice settings", async () => {
    const legacy = repository.getSettings() as unknown as Record<string, unknown>;
    delete legacy.voice;
    legacy.locale = "en-US";
    await repository.updateSettings(legacy);
    const settings = repository.getSettings();
    expect(settings.locale).toBe("en-US");
    expect(settings.voice.sttUrl).toBe(STT_URL);
    expect(settings.voice.sttApiKey).toBe(STT_KEY);
  });

  it("only an explicit empty key clears sttApiKey; absence preserves it", async () => {
    await repository.updateSettings({ voice: { enabled: false } });
    expect(repository.getSettings().voice.sttApiKey).toBe(STT_KEY);
    await repository.updateSettings({ voice: { sttApiKey: "" } });
    expect(repository.getSettings().voice.sttApiKey).toBe("");
    expect(repository.getSettings().voice.sttUrl).toBe(STT_URL);
  });

  it("two concurrent disjoint patches both apply without clobbering", async () => {
    await Promise.all([
      repository.updateSettings({ voice: { sttModel: "large-v3-turbo" } }),
      repository.updateSettings({ retention: { days: 90 } }),
    ]);
    const settings = repository.getSettings();
    expect(settings.voice.sttModel).toBe("large-v3-turbo");
    expect(settings.retention.days).toBe(90);
    expect(settings.voice.sttApiKey).toBe(STT_KEY);
  });

  it("rejects an invalid patch and leaves stored settings untouched", async () => {
    await expect(repository.updateSettings({ voice: { sttUrl: "ftp://nope" } }))
      .rejects.toThrow();
    expect(repository.getSettings().voice.sttUrl).toBe(STT_URL);
  });

  it("persists merged settings across a database reload", async () => {
    await repository.updateSettings({ voice: { sttModel: "reloaded-model" } });
    database.close();
    database = new AppDatabase(join(directory, "state.sqlite"));
    await database.open();
    repository = new Repository(database);
    expect(repository.getSettings().voice.sttModel).toBe("reloaded-model");
    expect(repository.getSettings().voice.sttApiKey).toBe(STT_KEY);
  });
});
