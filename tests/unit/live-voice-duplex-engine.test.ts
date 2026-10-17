import { describe, expect, it } from "vitest";
import {
  DuplexEngine,
  type AgentAudioSink,
  type DuplexEngineConfig,
  type RoomLike,
} from "../../src/main/voice/live/worker/duplex-engine";
import type { LiveVoiceWorkerEvent } from "../../src/main/voice/live/live-voice-worker-bridge";

const baseConfig: DuplexEngineConfig = {
  url: "ws://127.0.0.1:7880",
  apiKey: "test-key",
  apiSecret: "test-secret-that-is-long-enough-32",
  room: "voice-vs-1",
  voiceSessionId: "vs-1",
  sttUrl: "",
  sttModel: "whisper-1",
  sttApiKey: "",
  ttsVoice: "zh-TW-HsiaoChenNeural",
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

function makeFakeSink() {
  const published: Int16Array[] = [];
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
  let cleared = 0;
  let closed = false;
  return {
    sink,
    published,
    get cleared() { return cleared; },
    get closed() { return closed; },
  };
}

function makeEngine(overrides?: {
  room?: ReturnType<typeof makeFakeRoom>;
  sink?: ReturnType<typeof makeFakeSink>;
  synthesize?: (text: string, opts: { voice: string; signal?: AbortSignal; onChunk?: (c: { pcm: Uint8Array }) => void }) => Promise<void>;
}) {
  const room = overrides?.room ?? makeFakeRoom();
  const sink = overrides?.sink ?? makeFakeSink();
  const events: LiveVoiceWorkerEvent[] = [];
  const engine = new DuplexEngine(baseConfig, {
    emit: (event) => events.push(event),
    createRoom: () => room.room,
    createAudioSink: async () => sink.sink,
    ...(overrides?.synthesize ? { synthesize: overrides.synthesize } : {}),
  });
  return { engine, room, sink, events };
}

describe("DuplexEngine", () => {
  it("connects, emits transport connected and health ready on start", async () => {
    const { engine, events } = makeEngine();
    await engine.start();

    const transport = events.find((e) => e.type === "transport");
    expect(transport).toBeDefined();
    expect(transport!.type === "transport" && transport!.state).toBe("connected");
    expect(transport!.type === "transport" && transport!.voiceSessionId).toBe("vs-1");

    const health = events.find((e) => e.type === "health");
    expect(health).toBeDefined();
    expect(health!.type === "health" && health!.state).toBe("ready");

    await engine.dispose();
  });

  it("speak synthesizes text and publishes 240-sample PCM frames", async () => {
    const synthesized: { text: string; voice: string }[] = [];
    const { engine, sink, events } = makeEngine({
      synthesize: async (text, opts) => {
        synthesized.push({ text, voice: opts.voice });
        // 290 samples = 240 + 50 → two publish calls
        opts.onChunk?.({ pcm: new Uint8Array(290 * 2) });
      },
    });
    await engine.start();

    engine.speak("你好嗎");
    await new Promise((r) => setTimeout(r, 50));

    expect(synthesized.length).toBe(1);
    expect(synthesized[0]!.text).toBe("你好嗎");
    expect(synthesized[0]!.voice).toBe("zh-TW-HsiaoChenNeural");

    expect(sink.published.length).toBe(2);
    expect(sink.published[0]!.length).toBe(240);
    expect(sink.published[1]!.length).toBe(50);
    expect(events.some((event) => event.type === "stage" && event.stage === "tts" && event.state === "ended")).toBe(true);

    await engine.dispose();
  });

  it("stopSpeaking aborts the in-flight turn and clears the sink without degraded health", async () => {
    let sawAbort = false;
    const { engine, sink, events } = makeEngine({
      synthesize: async (_text, opts) => {
        opts.onChunk?.({ pcm: new Uint8Array(240 * 2) });
        await new Promise<void>((_resolve, reject) => {
          opts.signal?.addEventListener("abort", () => {
            sawAbort = true;
            reject(new Error("interrupted"));
          }, { once: true });
          // Never resolves on its own
        });
      },
    });
    await engine.start();

    engine.speak("長回覆");
    await new Promise((r) => setTimeout(r, 20));
    engine.stopSpeaking();
    await new Promise((r) => setTimeout(r, 50));

    expect(sawAbort).toBe(true);
    expect(sink.cleared).toBeGreaterThanOrEqual(1);
    const degraded = events.filter((e) => e.type === "health" && e.state === "degraded");
    expect(degraded.length).toBe(0);

    await engine.dispose();
  });

  it("ignores speak/dispose after dispose", async () => {
    const calls: string[] = [];
    const { engine } = makeEngine({
      synthesize: async (text) => {
        calls.push(text);
      },
    });
    await engine.start();
    await engine.dispose();
    // Must not throw and must not synthesize anything new
    engine.speak("不該出聲");
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(0);
  });

  it("emits transport event when the room reports a connection change", async () => {
    const fakeRoom = makeFakeRoom();
    const { engine, events } = makeEngine({ room: fakeRoom });
    await engine.start();

    fakeRoom.fire("connectionStateChanged", 2); // CONN_RECONNECTING
    const reconnecting = events.filter(
      (e) => e.type === "transport" && e.state === "reconnecting",
    );
    expect(reconnecting.length).toBe(1);

    await engine.dispose();
  });
});
