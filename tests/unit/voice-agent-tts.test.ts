// Phase 6 (§11.2): free OS/browser TTS layer. Sentence chunking, the
// muted/voiceless clean fallback, and abort-as-barge-in behaviour are pinned
// with injected fake synths — no jsdom speechSynthesis pretence.
import { describe, expect, it, vi } from "vitest";
import { appSettingsSchema } from "../../src/shared/schema";
import {
  resolveSpeechVoice,
  SPEECH_CHUNK_MAX_CHARS,
  speakSpeechText,
  splitSpeechSentences,
  ttsConfigFromSettings,
  type VoiceAgentTtsSynth,
} from "../../src/renderer/src/voice-agent/tts";

interface FakeUtterance {
  text: string;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

function makeSynth(voices: Array<{ voiceURI: string; name?: string; lang?: string }> = [
  { voiceURI: "v-default", name: "Default", lang: "zh-TW" },
  { voiceURI: "v-alt", name: "Alt", lang: "en-US" },
]) {
  const spoken: string[] = [];
  const pending: FakeUtterance[] = [];
  const synth: VoiceAgentTtsSynth & { cancelCount: number } = {
    cancelCount: 0,
    getVoices: () => voices,
    speak(utterance) {
      pending.push(utterance as FakeUtterance);
    },
    cancel() {
      this.cancelCount += 1;
    },
  };
  const createUtterance = (text: string): FakeUtterance => {
    spoken.push(text);
    return { text, onend: null, onerror: null };
  };
  return { synth, spoken, pending, createUtterance };
}

const CONFIG = { voiceUri: null, rate: 1, volume: 1, muted: false };

describe("splitSpeechSentences (§11.2 sentence chunks)", () => {
  it("splits zh terminators and keeps punctuation on the sentence", () => {
    expect(splitSpeechSentences("目前兩個在跑。有一個需要批准！")).toEqual([
      "目前兩個在跑。",
      "有一個需要批准！",
    ]);
  });

  it("splits en sentences but never decimals or abbreviations mid-number", () => {
    expect(splitSpeechSentences("Version 1.5 is up. Three panes are running.")).toEqual([
      "Version 1.5 is up.",
      "Three panes are running.",
    ]);
  });

  it("splits newlines and semicolons", () => {
    expect(splitSpeechSentences("line one\nline two；line three")).toEqual([
      "line one",
      "line two；",
      "line three",
    ]);
  });

  it("hard-caps runaway sentences at pause marks, then raw length", () => {
    const commas = Array.from({ length: 120 }, (_, index) => `片段${index}`).join("，");
    const chunks = splitSpeechSentences(commas);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(SPEECH_CHUNK_MAX_CHARS);
    const wall = "很".repeat(SPEECH_CHUNK_MAX_CHARS * 2 + 50);
    for (const chunk of splitSpeechSentences(wall)) {
      expect(chunk.length).toBeLessThanOrEqual(SPEECH_CHUNK_MAX_CHARS);
    }
  });

  it("returns [] for empty/whitespace input", () => {
    expect(splitSpeechSentences("")).toEqual([]);
    expect(splitSpeechSentences("  \n ")).toEqual([]);
  });
});

describe("ttsConfigFromSettings", () => {
  it("returns static defaults when settings carry no agentapi overrides (dead module)", () => {
    const defaults = appSettingsSchema.parse({});
    expect(ttsConfigFromSettings(defaults)).toEqual({
      voiceUri: null, rate: 1, volume: 1, muted: false,
    });
    expect(ttsConfigFromSettings(null).muted).toBe(false);
  });
});

describe("resolveSpeechVoice", () => {
  it("treats an empty voice list as unavailable (Chromium startup signal)", () => {
    const { synth } = makeSynth([]);
    expect(resolveSpeechVoice(synth, null)).toBeNull();
  });

  it("prefers the configured URI and falls back to the first voice", () => {
    const { synth } = makeSynth();
    expect(resolveSpeechVoice(synth, "v-alt")?.voiceURI).toBe("v-alt");
    expect(resolveSpeechVoice(synth, "missing")?.voiceURI).toBe("v-default");
    expect(resolveSpeechVoice(synth, null)?.voiceURI).toBe("v-default");
  });
});

describe("speakSpeechText", () => {
  it("starts the first sentence immediately and chains the rest", async () => {
    const { synth, spoken, pending, createUtterance } = makeSynth();
    const outcomePromise = speakSpeechText(synth, "第一句。第二句。第三句。", CONFIG, { createUtterance });
    // First chunk is speaking before the whole reply was even chunked-queued.
    expect(spoken).toEqual(["第一句。"]);
    pending[0]!.onend!();
    await Promise.resolve();
    expect(spoken).toEqual(["第一句。", "第二句。"]);
    pending[1]!.onend!();
    await Promise.resolve();
    pending[2]!.onend!();
    await expect(outcomePromise).resolves.toEqual({ spoken: true, cancelled: false });
    expect(synth.cancelCount).toBe(0);
  });

  it("muted returns the clean text fallback without touching the engine", async () => {
    const { synth, createUtterance } = makeSynth();
    await expect(
      speakSpeechText(synth, "不該出聲", { ...CONFIG, muted: true }, { createUtterance }),
    ).resolves.toEqual({ spoken: false, cancelled: false });
    expect(synth.cancelCount).toBe(0);
  });

  it("no usable voice returns the clean fallback (§11.2 no-voice path)", async () => {
    const { synth, createUtterance } = makeSynth([]);
    await expect(
      speakSpeechText(synth, "沒有聲音可用", CONFIG, { createUtterance }),
    ).resolves.toEqual({ spoken: false, cancelled: false });
  });

  it("declares an iOS playback session during speech and restores it after", async () => {
    const fakeSession = { type: "auto" };
    vi.stubGlobal("navigator", { audioSession: fakeSession });
    try {
      const { synth, pending, createUtterance } = makeSynth();
      const outcomePromise = speakSpeechText(synth, "要從喇叭出聲。", CONFIG, { createUtterance });
      expect(fakeSession.type).toBe("playback");
      pending[0]!.onend!();
      await expect(outcomePromise).resolves.toEqual({ spoken: true, cancelled: false });
      expect(fakeSession.type).toBe("auto");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("abort = barge-in: engine cancel drops current + queued sentences", async () => {
    const { synth, spoken, pending, createUtterance } = makeSynth();
    const controller = new AbortController();
    const outcomePromise = speakSpeechText(synth, "第一句。第二句。", CONFIG, {
      createUtterance,
      signal: controller.signal,
    });
    expect(spoken).toEqual(["第一句。"]);
    controller.abort();
    await expect(outcomePromise).resolves.toEqual({ spoken: true, cancelled: true });
    expect(synth.cancelCount).toBe(1);
    // The queued second sentence never starts after the abort.
    pending[0]!.onend?.();
    await Promise.resolve();
    expect(spoken).toEqual(["第一句。"]);
  });

  it("an aborted signal before speaking resolves cancelled immediately", async () => {
    const { synth, createUtterance } = makeSynth();
    const controller = new AbortController();
    controller.abort();
    await expect(
      speakSpeechText(synth, "第一句。", CONFIG, { createUtterance, signal: controller.signal }),
    ).resolves.toEqual({ spoken: false, cancelled: true });
  });

  it("engine errors degrade to the text fallback instead of hanging", async () => {
    const { synth, pending, createUtterance } = makeSynth();
    const outcomePromise = speakSpeechText(synth, "第一句。第二句。", CONFIG, { createUtterance });
    pending[0]!.onerror!();
    await expect(outcomePromise).resolves.toEqual({ spoken: false, cancelled: false });
  });
});
