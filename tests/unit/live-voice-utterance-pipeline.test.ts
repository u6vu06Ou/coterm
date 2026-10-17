import { describe, expect, it } from "vitest";
import { UtterancePipeline, type PcmFrame } from "../../src/main/voice/live/worker/utterance-pipeline";

// 10ms frames at 16kHz mono
const FRAME_RATE = 16_000;
const FRAME_SAMPLES = 160; // 10ms

function silenceFrame(): PcmFrame {
  return { data: new Int16Array(FRAME_SAMPLES), sampleRate: FRAME_RATE, channels: 1 };
}

function loudFrame(amplitude = 5000): PcmFrame {
  const data = new Int16Array(FRAME_SAMPLES).fill(amplitude);
  return { data, sampleRate: FRAME_RATE, channels: 1 };
}

interface CapturedCall {
  wav: Uint8Array;
  sampleRate: number;
}

function makePipeline(overrides?: {
  vad?: ConstructorParameters<typeof UtterancePipeline>[0]["vad"];
  rmsThreshold?: number;
  minUtteranceMs?: number;
  preRollMs?: number;
}) {
  const calls: CapturedCall[] = [];
  const transcripts: (string | null | Error)[] = [];
  const texts: { text: string; atMs: number }[] = [];
  const speechStarts: number[] = [];
  const errors: Error[] = [];

  let transcriptIndex = 0;
  const pipeline = new UtterancePipeline({
    // Short thresholds so a handful of 10ms frames can open/close an utterance.
    vad: { silenceMs: 300, minSpeechMs: 30, maxUtteranceMs: 45_000 },
    ...(overrides?.vad ? { vad: overrides.vad } : {}),
    ...(overrides?.rmsThreshold !== undefined ? { rmsThreshold: overrides.rmsThreshold } : {}),
    ...(overrides?.minUtteranceMs !== undefined ? { minUtteranceMs: overrides.minUtteranceMs } : {}),
    ...(overrides?.preRollMs !== undefined ? { preRollMs: overrides.preRollMs } : {}),
    transcribe: async ({ wav, sampleRate }) => {
      calls.push({ wav, sampleRate });
      const t = transcriptIndex < transcripts.length ? transcripts[transcriptIndex]! : null;
      transcriptIndex++;
      if (t instanceof Error) throw t;
      return t;
    },
    onSpeechStarted: (atMs) => speechStarts.push(atMs),
    onFinalUtterance: (text, atMs) => texts.push({ text, atMs }),
  });

  return {
    pipeline,
    calls,
    get transcriptCount() { return calls.length; },
    texts,
    speechStarts,
    errors,
    transcripts,
  };
}

describe("UtterancePipeline", () => {
  it("emits speech-started and final-utterance for silence→speech→silence", async () => {
    const { pipeline, calls, texts, speechStarts, transcripts } = makePipeline();
    transcripts.push("今天天氣很好");

    // Feed some silence
    for (let i = 0; i < 5; i++) pipeline.handleFrame(silenceFrame());
    // Speech for 500ms (50 frames, well above minUtteranceMs=250)
    for (let i = 0; i < 50; i++) pipeline.handleFrame(loudFrame());
    // Trailing silence triggers endpointing
    for (let i = 0; i < 40; i++) pipeline.handleFrame(silenceFrame());

    // Allow transcription queue to settle
    await new Promise((r) => setTimeout(r, 50));

    expect(speechStarts.length).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBe(1);
    expect(texts.length).toBe(1);
    expect(texts[0]!.text).toBe("今天天氣很好");

    // Verify the WAV has a proper RIFF header
    const wav = calls[0]!.wav;
    expect(String.fromCharCode(wav[0]!, wav[1]!, wav[2]!, wav[3]!)).toBe("RIFF");
    expect(wav.byteLength).toBeGreaterThan(44);
  });

  it("drops utterances shorter than minUtteranceMs", async () => {
    const { pipeline, calls } = makePipeline({ minUtteranceMs: 500 });

    for (let i = 0; i < 5; i++) pipeline.handleFrame(silenceFrame());
    // Only 200ms of speech — below 500ms minimum
    for (let i = 0; i < 20; i++) pipeline.handleFrame(loudFrame());
    for (let i = 0; i < 40; i++) pipeline.handleFrame(silenceFrame());

    await new Promise((r) => setTimeout(r, 50));
    expect(calls.length).toBe(0);
  });

  it("ignores null/empty transcripts without firing onFinalUtterance", async () => {
    const { pipeline, texts, transcripts } = makePipeline();
    transcripts.push(null);
    transcripts.push("  ");
    transcripts.push("實際文字");

    // Three silence→speech→silence cycles
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 5; i++) pipeline.handleFrame(silenceFrame());
      for (let i = 0; i < 50; i++) pipeline.handleFrame(loudFrame());
      for (let i = 0; i < 40; i++) pipeline.handleFrame(silenceFrame());
    }

    await new Promise((r) => setTimeout(r, 100));
    expect(texts.length).toBe(1);
    expect(texts[0]!.text).toBe("實際文字");
  });

  it("survives transcribe errors and still processes the next utterance", async () => {
    const { pipeline, texts, transcripts } = makePipeline();
    transcripts.push(new Error("STT unreachable") as unknown as null);
    transcripts.push("第二句");

    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 5; i++) pipeline.handleFrame(silenceFrame());
      for (let i = 0; i < 50; i++) pipeline.handleFrame(loudFrame());
      for (let i = 0; i < 40; i++) pipeline.handleFrame(silenceFrame());
    }

    await new Promise((r) => setTimeout(r, 100));
    expect(texts.length).toBe(1);
    expect(texts[0]!.text).toBe("第二句");
  });

  it("downmixes stereo frames before VAD", async () => {
    const { pipeline, calls, transcripts } = makePipeline();
    transcripts.push("立體聲測試");

    for (let i = 0; i < 5; i++) pipeline.handleFrame(silenceFrame());

    // Stereo: interleaved L R L R ...
    const stereoSpeech = new Int16Array(FRAME_SAMPLES * 2);
    for (let i = 0; i < stereoSpeech.length; i++) stereoSpeech[i] = 4000;
    for (let i = 0; i < 50; i++) {
      pipeline.handleFrame({ data: stereoSpeech, sampleRate: FRAME_RATE, channels: 2 });
    }
    for (let i = 0; i < 40; i++) pipeline.handleFrame(silenceFrame());

    await new Promise((r) => setTimeout(r, 50));
    expect(calls.length).toBe(1);
    // WAV should be mono (channels=1)
    const wav = calls[0]!.wav;
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getUint16(22, true)).toBe(1);
  });

  it("keeps a bounded pre-roll so the utterance starts before VAD opens", async () => {
    const { pipeline, calls, transcripts } = makePipeline({ preRollMs: 400 });
    transcripts.push("pre roll");
    for (let i = 0; i < 20; i++) pipeline.handleFrame(silenceFrame());
    for (let i = 0; i < 50; i++) pipeline.handleFrame(loudFrame());
    for (let i = 0; i < 40; i++) pipeline.handleFrame(silenceFrame());
    await new Promise((r) => setTimeout(r, 50));

    expect(calls).toHaveLength(1);
    const wav = calls[0]!.wav;
    const pcm = new Int16Array(wav.buffer, wav.byteOffset + 44, Math.floor((wav.byteLength - 44) / 2));
    expect(pcm[0]).toBe(0);
    expect(Array.from(pcm.slice(0, FRAME_SAMPLES * 10)).every((sample) => sample === 0)).toBe(true);
    expect(Array.from(pcm).some((sample) => sample !== 0)).toBe(true);
  });
});
