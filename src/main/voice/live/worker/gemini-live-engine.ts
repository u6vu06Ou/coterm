import { AccessToken } from "livekit-server-sdk";
import WebSocket from "ws";
import {
  AudioStream,
  ConnectionState,
  Room,
  RoomEvent,
  TrackKind,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from "@livekit/rtc-node";
import type { LiveVoiceWorkerEvent } from "../live-voice-worker-bridge";
import { createNativeAudioSink } from "./duplex-engine";
import type { AgentAudioSink, RoomLike } from "./duplex-engine";
import { UtterancePipeline } from "./utterance-pipeline";

export type { AgentAudioSink, RoomLike } from "./duplex-engine";

export interface GeminiLiveEngineConfig {
  /** ws://127.0.0.1:7880 — the locally spawned LiveKit server (transport only). */
  url: string;
  apiKey: string;
  apiSecret: string;
  room: string;
  voiceSessionId: string;
  /** Google AI Studio key. Arrives via worker env only; never logged. */
  geminiApiKey: string;
  /** e.g. gemini-3.1-flash-live-preview. */
  geminiModel: string;
  /** zh-TW / zh-CN / en-US — drives the system instruction. */
  responseLanguage: string;
}

/** Structural view of the `ws` WebSocket for test injection. */
export interface GeminiSocketLike {
  send(data: string): void;
  close(): void;
  on(event: "open" | "message" | "close" | "error", listener: (...args: never[]) => void): void;
}

/** One decoded mic frame as consumed from the LiveKit track. */
export interface GeminiMicFrame {
  data: Int16Array;
  sampleRate: number;
  channels: number;
}

export interface MicStreamLike {
  getReader(): { read(): Promise<{ done: boolean; value?: GeminiMicFrame }> };
}

export interface GeminiLiveEngineDeps {
  emit: (event: LiveVoiceWorkerEvent) => void;
  createRoom?: () => RoomLike;
  createAudioSink?: (room: RoomLike) => Promise<AgentAudioSink | null>;
  createSocket?: (url: string) => GeminiSocketLike;
  createMicStream?: (track: RemoteTrack) => MicStreamLike;
  now?: () => number;
}

const GEMINI_WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/" +
  "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const HEALTH_INTERVAL_MS = 5_000;
const FRAME_SAMPLES_10MS = 240; // 10ms at the 24kHz reply clock, same as Edge TTS playout
const MIC_BATCH_FRAMES = 10;     // forward 100ms of mic per realtime audio message
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 2_000;

const SYSTEM_INSTRUCTION: Record<string, string> = {
  "zh-TW": "你是語音助理。用繁體中文口語回答，簡短自然，一次最多兩三句。",
  "zh-CN": "你是语音助理。用简体中文口语回答，简短自然，一次最多两三句。",
  "en-US": "You are a voice assistant. Answer in spoken-style English, briefly and naturally.",
};

/**
 * Gemini Live provider for Live Voice: same LiveKit room plumbing as
 * DuplexEngine, but the brain is a single Gemini Live API session
 * (speech-to-speech). Local VAD (via the shared UtterancePipeline) brackets
 * each user turn with activityStart/activityEnd — the framing mode measured
 * fastest against gemini-3.1-flash-live-preview — and Gemini's 24kHz PCM
 * replies are published straight into the room.
 *
 * Raw audio never crosses the worker bridge — only speech metadata and
 * transcription text.
 */
export class GeminiLiveEngine {
  private readonly config: GeminiLiveEngineConfig;
  private readonly deps: Required<Pick<GeminiLiveEngineDeps, "emit" | "now">> & GeminiLiveEngineDeps;
  private room: RoomLike | null = null;
  private audioSink: AgentAudioSink | null = null;
  private socket: GeminiSocketLike | null = null;
  private socketOpen = false;
  private pipeline: UtterancePipeline | null = null;
  private micBatch = new Int16Array(0);
  private micBatchSamples = 0;
  private userText = "";
  private modelText = "";
  private replyStarted = false;
  private reconnectAttempts = 0;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private transportState: "connected" | "reconnecting" | "disconnected" = "disconnected";
  private micFrameCount = 0;
  private micMetricWindowStartedAt = 0;
  private micMetricFrames = 0;
  private micMetricRmsTotal = 0;

  constructor(config: GeminiLiveEngineConfig, deps: GeminiLiveEngineDeps) {
    this.config = config;
    this.deps = { now: Date.now, ...deps };
  }

  async start(): Promise<void> {
    if (this.disposed) throw new Error("GeminiLiveEngine already disposed.");
    const token = await this.signAgentToken();
    const room = (this.deps.createRoom?.() ?? new Room()) as RoomLike;
    this.room = room;

    room.on(RoomEvent.TrackSubscribed, (...raw) => {
      const [track, , participant] = raw as unknown as [RemoteTrack, RemoteTrackPublication, RemoteParticipant];
      this.handleTrackSubscribed(track, participant);
    });
    room.on(RoomEvent.ConnectionStateChanged, (...raw) => {
      const [state] = raw as unknown as [ConnectionState];
      this.mapConnectionState(state);
    });

    await room.connect(this.config.url, token);
    this.mapConnectionState(ConnectionState.CONN_CONNECTED);
    await this.openGeminiSession();

    this.healthTimer = setInterval(() => {
      const ready = this.transportState === "connected" && this.socketOpen;
      this.emit({
        type: "health",
        state: ready ? "ready" : "degraded",
        atMs: this.deps.now(),
        ...(ready ? {} : { reasonCode: this.transportState !== "connected" ? `transport-${this.transportState}` : "gemini-disconnected" }),
      });
    }, HEALTH_INTERVAL_MS);
    this.healthTimer.unref?.();
  }

  /** Same interface as DuplexEngine, but Gemini speaks for itself. */
  speak(_text: string): void {
    // The Gemini provider generates its own replies from the mic stream;
    // supervisor-injected text has no voice here.
  }

  /** Barge-in / stop button: drop queued playback. */
  stopSpeaking(): void {
    this.audioSink?.clear();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.closeSocket();
    this.pipeline?.reset();
    const room = this.room;
    this.room = null;
    if (room) {
      try {
        await room.disconnect();
      } catch {
        // disposing during a reconnect storm must not throw across ipc
      }
    }
    if (this.audioSink) {
      try {
        await this.audioSink.close();
      } catch {
        // source may already be closed with the room
      }
      this.audioSink = null;
    }
  }

  private emit(event: LiveVoiceWorkerEvent): void {
    try {
      this.deps.emit(event);
    } catch {
      // A dead ipc channel means main is gone — the worker will exit anyway.
    }
  }

  private async signAgentToken(): Promise<string> {
    const token = new AccessToken(this.config.apiKey, this.config.apiSecret, {
      identity: `agent-${this.config.voiceSessionId}`,
      ttl: 600,
    });
    token.addGrant({ room: this.config.room, roomJoin: true, canPublish: true, canSubscribe: true });
    return token.toJwt();
  }

  private mapConnectionState(state: ConnectionState): void {
    if (state === ConnectionState.CONN_CONNECTED) this.transportState = "connected";
    else if (state === ConnectionState.CONN_RECONNECTING) this.transportState = "reconnecting";
    else if (state === ConnectionState.CONN_DISCONNECTED) this.transportState = "disconnected";
    else return;
    this.emit({ type: "transport", voiceSessionId: this.config.voiceSessionId, state: this.transportState, atMs: this.deps.now() });
  }

  private handleTrackSubscribed(track: RemoteTrack, participant: RemoteParticipant): void {
    if (track.kind !== TrackKind.KIND_AUDIO) return;
    if (!participant?.identity?.startsWith("user-")) return;
    this.emit({
      type: "stage",
      voiceSessionId: this.config.voiceSessionId,
      stage: "worker-subscribe",
      state: "subscribed",
      atMs: this.deps.now(),
    });
    this.pipeline = new UtterancePipeline({
      // Gemini transcribes centrally; local STT is not part of this provider.
      transcribe: () => Promise.resolve(null),
      onFinalUtterance: () => undefined,
      onSpeechStarted: (atMs) => {
        this.emit({ type: "user-speech-started", voiceSessionId: this.config.voiceSessionId, atMs: this.deps.now() });
        this.emit({ type: "stage", voiceSessionId: this.config.voiceSessionId, stage: "vad", state: "speech-started", atMs });
        this.resetTurnState();
        this.audioSink?.clear(); // barge-in: drop the rest of the queued reply
        this.sendJson({ realtimeInput: { activityStart: {} } });
      },
      onSpeechEnded: () => {
        this.emit({ type: "stage", voiceSessionId: this.config.voiceSessionId, stage: "vad", state: "speech-ended", atMs: this.deps.now() });
        this.sendJson({ realtimeInput: { activityEnd: {} } });
      },
    });
    const stream = this.deps.createMicStream
      ? this.deps.createMicStream(track)
      : (new AudioStream(track, { sampleRate: 16_000, numChannels: 1, frameSizeMs: 10 }) as unknown as MicStreamLike);
    void this.consumeMic(stream);
  }

  private async consumeMic(stream: MicStreamLike): Promise<void> {
    try {
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || this.disposed) break;
        if (value) {
          this.recordMicFrame(value.data);
          this.pipeline?.handleFrame({ data: value.data, sampleRate: value.sampleRate, channels: value.channels });
          this.bufferMicForGemini(value.data);
          if (this.micBatchSamples >= MIC_BATCH_FRAMES * 160) this.flushMicBatch();
        }
      }
    } catch {
      // Track ended or room dropped mid-read — transport events surface it.
    }
  }

  private bufferMicForGemini(data: Int16Array): void {
    if (this.micBatchSamples === 0) this.micBatch = new Int16Array(MIC_BATCH_FRAMES * 160);
    this.micBatch.set(data.subarray(0, Math.max(0, MIC_BATCH_FRAMES * 160 - this.micBatchSamples)), this.micBatchSamples);
    this.micBatchSamples += data.length;
  }

  private flushMicBatch(): void {
    if (this.micBatchSamples <= 0) return;
    const slice = this.micBatch.subarray(0, this.micBatchSamples);
    const bytes = new Uint8Array(slice.length * 2);
    for (let i = 0; i < slice.length; i += 1) {
      const v = slice[i] ?? 0;
      bytes[i * 2] = v & 0xff;
      bytes[i * 2 + 1] = (v >> 8) & 0xff;
    }
    this.micBatchSamples = 0;
    this.sendJson({
      realtimeInput: {
        audio: {
          data: Buffer.from(bytes).toString("base64"),
          mimeType: "audio/pcm;rate=16000",
        },
      },
    });
  }

  private openGeminiSession(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = `${GEMINI_WS_BASE}?key=${this.config.geminiApiKey}`;
      const socket = (this.deps.createSocket ?? ((u: string): GeminiSocketLike => new WebSocket(u)))(url);
      this.socket = socket;
      const timeout = setTimeout(() => {
        if (!this.socketOpen) {
          this.closeSocket();
          reject(new Error("Gemini Live session did not open in time."));
        }
      }, 15_000);
      timeout.unref?.();
      socket.on("open", () => {
        clearTimeout(timeout);
        this.socketOpen = true;
        this.reconnectAttempts = 0;
        this.sendJson({
          setup: {
            model: this.geminiModelName(),
            generationConfig: { responseModalities: ["AUDIO"] },
            systemInstruction: {
              parts: [{ text: SYSTEM_INSTRUCTION[this.config.responseLanguage] ?? SYSTEM_INSTRUCTION["en-US"]! }],
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
          },
        });
        this.emit({ type: "health", state: "ready", atMs: this.deps.now() });
        resolve();
      });
      socket.on("message", (...raw) => {
        const first = raw[0] as unknown;
        const data = typeof first === "string" ? first : Buffer.from(first as ArrayBuffer).toString("utf8");
        try {
          this.handleGeminiMessage(JSON.parse(data));
        } catch {
          // A malformed or partial frame must not kill the session.
        }
      });
      socket.on("close", () => {
        const wasOpen = this.socketOpen;
        this.socketOpen = false;
        this.socket = null;
        clearTimeout(timeout);
        if (this.disposed) return;
        if (wasOpen) this.scheduleReconnect();
        else reject(new Error("Gemini Live session closed before opening."));
      });
      socket.on("error", () => {
        // close always follows; nothing to do here but avoid unhandled events.
      });
    });
  }

  private handleGeminiMessage(message: unknown): void {
    const root = message as {
      setupComplete?: unknown;
      serverContent?: {
        inputTranscription?: { text?: string };
        outputTranscription?: { text?: string };
        modelTurn?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> };
        interrupted?: boolean;
        turnComplete?: boolean;
      };
      goAway?: unknown;
    };
    if (root.goAway !== undefined) {
      this.emit({ type: "health", state: "degraded", atMs: this.deps.now(), reasonCode: "gemini-goaway" });
      return;
    }
    const sc = root.serverContent;
    if (!sc) return;
    if (typeof sc.inputTranscription?.text === "string") this.userText += sc.inputTranscription.text;
    if (typeof sc.outputTranscription?.text === "string") this.modelText += sc.outputTranscription.text;
    if (sc.interrupted) {
      // Server-side barge-in: drop anything still queued for playout.
      this.audioSink?.clear();
    }
    for (const part of sc.modelTurn?.parts ?? []) {
      const b64 = part.inlineData?.data;
      if (!b64) continue;
      const pcm = Buffer.from(b64, "base64");
      if (pcm.byteLength > 0) void this.publishPcm(new Uint8Array(pcm));
    }
    if (sc.turnComplete) this.flushTurn();
  }

  private flushTurn(): void {
    const userText = this.userText.trim();
    if (userText) {
      this.emit({
        type: "stage",
        voiceSessionId: this.config.voiceSessionId,
        stage: "stt",
        state: "final",
        atMs: this.deps.now(),
        textLength: userText.length,
      });
      this.emit({ type: "final-utterance", voiceSessionId: this.config.voiceSessionId, text: userText, atMs: this.deps.now() });
    }
    const modelText = this.modelText.trim();
    if (modelText) {
      this.emit({ type: "model-utterance", voiceSessionId: this.config.voiceSessionId, text: modelText, atMs: this.deps.now() });
    }
    if (this.replyStarted) {
      this.emit({
        type: "stage",
        voiceSessionId: this.config.voiceSessionId,
        stage: "tts",
        state: "ended",
        atMs: this.deps.now(),
      });
    }
    this.resetTurnState();
  }

  private resetTurnState(): void {
    this.userText = "";
    this.modelText = "";
    this.replyStarted = false;
  }

  private async publishPcm(pcm: Uint8Array): Promise<void> {
    if (this.disposed) return;
    if (!this.replyStarted) {
      this.replyStarted = true;
      this.emit({
        type: "stage",
        voiceSessionId: this.config.voiceSessionId,
        stage: "tts",
        state: "first-byte",
        atMs: this.deps.now(),
      });
    }
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
    for (let offset = 0; offset < samples.length; offset += FRAME_SAMPLES_10MS) {
      if (this.disposed) return;
      const slice = samples.subarray(offset, Math.min(offset + FRAME_SAMPLES_10MS, samples.length));
      const sink = await this.ensureAudioSink();
      if (!sink) return;
      await sink.publish(slice);
    }
  }

  private async ensureAudioSink(): Promise<AgentAudioSink | null> {
    if (this.audioSink) return this.audioSink;
    const room = this.room;
    if (!room) return null;
    const factory = this.deps.createAudioSink ?? createNativeAudioSink;
    const sink = await factory(room).catch(() => null);
    this.audioSink = sink;
    return sink;
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.emit({ type: "health", state: "degraded", atMs: this.deps.now(), reasonCode: "gemini-reconnect-exhausted" });
      return;
    }
    this.reconnectAttempts += 1;
    this.emit({ type: "health", state: "degraded", atMs: this.deps.now(), reasonCode: "gemini-reconnecting" });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed) return;
      this.openGeminiSession().catch(() => {
        // close handler already scheduled the next attempt
      });
    }, RECONNECT_DELAY_MS);
    this.reconnectTimer.unref?.();
  }

  private sendJson(payload: unknown): void {
    if (!this.socket || !this.socketOpen) return;
    try {
      this.socket.send(JSON.stringify(payload));
    } catch {
      // socket died mid-send; the close handler owns recovery
    }
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.socketOpen = false;
    if (socket) {
      try {
        socket.close();
      } catch {
        // already closed
      }
    }
  }

  private geminiModelName(): string {
    const model = this.config.geminiModel.trim();
    return model.startsWith("models/") ? model : `models/${model}`;
  }

  private recordMicFrame(data: Int16Array): void {
    const now = this.deps.now();
    if (this.micMetricWindowStartedAt === 0) this.micMetricWindowStartedAt = now;
    this.micFrameCount += 1;
    this.micMetricFrames += 1;
    this.micMetricRmsTotal += pcmRms(data);
    const elapsedMs = now - this.micMetricWindowStartedAt;
    if (elapsedMs < 1_000) return;
    this.emit({
      type: "stage",
      voiceSessionId: this.config.voiceSessionId,
      stage: "worker-mic",
      state: "frames",
      frameCount: this.micFrameCount,
      framesPerSecond: (this.micMetricFrames * 1000) / Math.max(1, elapsedMs),
      rms: this.micMetricRmsTotal / Math.max(1, this.micMetricFrames),
      atMs: now,
    });
    this.micMetricWindowStartedAt = now;
    this.micMetricFrames = 0;
    this.micMetricRmsTotal = 0;
  }
}

function pcmRms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}
