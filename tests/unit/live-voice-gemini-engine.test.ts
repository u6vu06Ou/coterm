import { describe, expect, it } from "vitest";
import { TrackKind } from "@livekit/rtc-node";
import {
  GeminiLiveEngine,
  type GeminiLiveEngineConfig,
  type GeminiMicFrame,
  type GeminiSocketLike,
  type MicStreamLike,
  type RoomLike,
} from "../../src/main/voice/live/worker/gemini-live-engine";
import type { AgentAudioSink } from "../../src/main/voice/live/worker/duplex-engine";
import type { LiveVoiceWorkerEvent } from "../../src/main/voice/live/live-voice-worker-bridge";

const baseConfig: GeminiLiveEngineConfig = {
  url: "ws://127.0.0.1:7880",
  apiKey: "test-key",
  apiSecret: "test-secret-that-is-long-enough-32",
  room: "voice-vs-1",
  voiceSessionId: "vs-1",
  geminiApiKey: "gemini-key",
  geminiModel: "gemini-3.1-flash-live-preview",
  responseLanguage: "zh-TW",
};

function makeFakeRoom() {
  const listeners = new Map<string, ((...args: never[]) => void)[]>();
  const room: RoomLike = {
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return room;
    },
    connect: async () => room,
    disconnect: async () => undefined,
    localParticipant: {
      publishTrack: async () => ({}),
    },
  };
  return {
    room,
    fire(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) {
        (listener as (...a: unknown[]) => void)(...args);
      }
    },
  };
}

function makeFakeSocket() {
  const listeners = new Map<string, ((...args: never[]) => void)[]>();
  const sent: unknown[] = [];
  let closed = false;
  const socket: GeminiSocketLike = {
    send: (data: string) => {
      sent.push(JSON.parse(data));
    },
    close: () => {
      if (closed) return;
      closed = true;
      for (const listener of listeners.get("close") ?? []) {
        (listener as (...a: unknown[]) => void)();
      }
    },
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      // the engine registers "open" synchronously inside its promise
      if (event === "open") {
        (listener as (...a: unknown[]) => void)();
      }
    },
  };
  return {
    socket,
    sent,
    get closed() { return closed; },
    fire(event: "message" | "close", ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) {
        (listener as (...a: unknown[]) => void)(...args);
      }
    },
  };
}

function makeFakeSink() {
  const published: Int16Array[] = [];
  let cleared = 0;
  let closed = false;
  const sink: AgentAudioSink = {
    publish: async (samples) => {
      published.push(new Int16Array(samples));
    },
    clear: () => {
      cleared += 1;
    },
    close: async () => {
      closed = true;
    },
  };
  return { sink, published, get cleared() { return cleared; }, get closed() { return closed; } };
}

/** Preset mic stream: feeds frames in order then ends. */
function makeFakeMicStream(frames: GeminiMicFrame[]): MicStreamLike {
  let index = 0;
  return {
    getReader: () => ({
      read: async () =>
        index < frames.length
          ? { done: false, value: frames[index++]! }
          : { done: true },
    }),
  };
}

function makeMicFrames(loudFrames: number, silentFrames: number): GeminiMicFrame[] {
  const frames: GeminiMicFrame[] = [];
  for (let i = 0; i < loudFrames; i += 1) {
    frames.push({ data: new Int16Array(160).fill(9_000), sampleRate: 16_000, channels: 1 });
  }
  for (let i = 0; i < silentFrames; i += 1) {
    frames.push({ data: new Int16Array(160), sampleRate: 16_000, channels: 1 });
  }
  return frames;
}

function makeEngine(overrides?: {
  micFrames?: GeminiMicFrame[];
}) {
  const room = makeFakeRoom();
  const socket = makeFakeSocket();
  const sink = makeFakeSink();
  const events: LiveVoiceWorkerEvent[] = [];
  const engine = new GeminiLiveEngine(baseConfig, {
    emit: (event) => events.push(event),
    createRoom: () => room.room,
    createAudioSink: async () => sink.sink,
    createSocket: () => socket.socket,
    createMicStream: () => makeFakeMicStream(overrides?.micFrames ?? []),
  });
  return { engine, room, socket, sink, events };
}

/** Simulate the room delivering the user's mic track. */
function startMic(room: ReturnType<typeof makeFakeRoom>): void {
  room.fire("trackSubscribed", { kind: TrackKind.KIND_AUDIO }, { id: 1 }, { identity: "user-vs-1" });
}

function base64Pcm(samples: number): string {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    buf.writeInt16LE(1_000, i * 2);
  }
  return buf.toString("base64");
}

describe("GeminiLiveEngine", () => {
  it("connects to the room, opens the Gemini session and sends a setup message", async () => {
    const { engine, socket, events } = makeEngine();
    await engine.start();

    const transport = events.find((e) => e.type === "transport");
    expect(transport).toBeDefined();
    expect(transport!.type === "transport" && transport!.state).toBe("connected");

    const setup = socket.sent.find((m) => "setup" in (m as Record<string, unknown>)) as
      | { setup: { model: string; inputAudioTranscription?: unknown; outputAudioTranscription?: unknown } }
      | undefined;
    expect(setup).toBeDefined();
    expect(setup!.setup.model).toBe("models/gemini-3.1-flash-live-preview");
    expect(setup!.setup.inputAudioTranscription).toBeDefined();
    expect(setup!.setup.outputAudioTranscription).toBeDefined();

    const health = events.find((e) => e.type === "health");
    expect(health).toBeDefined();
    expect(health!.type === "health" && health!.state).toBe("ready");

    await engine.dispose();
  });

  it("forwards VAD-bracketed mic audio and emits speech events", async () => {
    const micFrames = [...makeMicFrames(30, 120)];
    const { engine, room, socket, events } = makeEngine({ micFrames });
    await engine.start();
    startMic(room);
    await new Promise((r) => setTimeout(r, 50));

    expect(events.some((e) => e.type === "user-speech-started")).toBe(true);
    const activityStart = socket.sent.find((m) => "realtimeInput" in (m as Record<string, unknown>) &&
      "activityStart" in ((m as { realtimeInput: Record<string, unknown> }).realtimeInput));
    const activityEnd = socket.sent.find((m) => "realtimeInput" in (m as Record<string, unknown>) &&
      "activityEnd" in ((m as { realtimeInput: Record<string, unknown> }).realtimeInput));
    expect(activityStart).toBeDefined();
    expect(activityEnd).toBeDefined();

    const audioMessages = socket.sent.filter((m) => "realtimeInput" in (m as Record<string, unknown>) &&
      "audio" in ((m as { realtimeInput: Record<string, unknown> }).realtimeInput)) as
      Array<{ realtimeInput: { audio: { data: string; mimeType: string } } }>;
    expect(audioMessages.length).toBeGreaterThanOrEqual(12); // 150 frames / 10 per batch
    expect(audioMessages[0]!.realtimeInput.audio.mimeType).toBe("audio/pcm;rate=16000");
    expect(Buffer.from(audioMessages[0]!.realtimeInput.audio.data, "base64").byteLength).toBe(10 * 160 * 2);

    await engine.dispose();
  });

  it("publishes 24k reply PCM as 240-sample frames and flushes the turn transcripts", async () => {
    const micFrames = [...makeMicFrames(30, 120)];
    const { engine, room, socket, sink, events } = makeEngine({ micFrames });
    await engine.start();
    startMic(room);
    await new Promise((r) => setTimeout(r, 50));

    socket.fire("message", JSON.stringify({
      serverContent: { inputTranscription: { text: "台灣最高的山" } },
    }));
    socket.fire("message", JSON.stringify({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: base64Pcm(290), mimeType: "audio/pcm;rate=24000" } }] },
      },
    }));
    socket.fire("message", JSON.stringify({
      serverContent: { outputTranscription: { text: "是玉山。" } },
    }));
    socket.fire("message", JSON.stringify({
      serverContent: { turnComplete: true },
    }));
    await new Promise((r) => setTimeout(r, 80));

    expect(sink.published.length).toBe(2);
    expect(sink.published[0]!.length).toBe(240);
    expect(sink.published[1]!.length).toBe(50);

    const final = events.find((e) => e.type === "final-utterance");
    expect(final).toBeDefined();
    expect(final!.type === "final-utterance" && final!.text).toBe("台灣最高的山");
    const model = events.find((e) => e.type === "model-utterance");
    expect(model).toBeDefined();
    expect(model!.type === "model-utterance" && model!.text).toBe("是玉山。");
    expect(events.some((e) => e.type === "stage" && e.stage === "tts" && e.state === "first-byte")).toBe(true);
    expect(events.some((e) => e.type === "stage" && e.stage === "tts" && e.state === "ended")).toBe(true);

    await engine.dispose();
  });

  it("clears queued playout on barge-in and ignores supervisor speak commands", async () => {
    const { engine, sink, socket } = makeEngine();
    await engine.start();

    engine.speak("不該有聲音");
    socket.fire("message", JSON.stringify({
      serverContent: { modelTurn: { parts: [{ inlineData: { data: base64Pcm(240), mimeType: "audio/pcm;rate=24000" } }] } },
    }));
    await new Promise((r) => setTimeout(r, 30));
    expect(sink.published.length).toBe(1);

    socket.fire("message", JSON.stringify({ serverContent: { interrupted: true } }));
    expect(sink.cleared).toBeGreaterThanOrEqual(1);

    engine.stopSpeaking();
    expect(sink.cleared).toBeGreaterThanOrEqual(2);

    await engine.dispose();
  });

  it("does nothing further after dispose", async () => {
    const { engine, socket } = makeEngine();
    await engine.start();
    await engine.dispose();
    const sentBefore = socket.sent.length;
    engine.speak("x");
    engine.stopSpeaking();
    expect(socket.sent.length).toBe(sentBefore);
    expect(socket.closed).toBe(true);
  });
});
