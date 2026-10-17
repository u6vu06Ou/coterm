import { AccessToken } from "livekit-server-sdk";
import {
  AudioFrame,
  AudioStream,
  AudioSource,
  ConnectionState,
  dispose as disposeRtc,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from "@livekit/rtc-node";
import { STT_LANG_CODE, STT_PROMPT } from "@shared/stt-language";
import { resolveTranscriptionUrl } from "@shared/transcription-url";
import type { LiveVoiceWorkerEvent } from "../live-voice-worker-bridge";
import { EDGE_TTS_SAMPLE_RATE, synthesizeEdgeTts } from "./edge-tts";
import { UtterancePipeline } from "./utterance-pipeline";

export interface DuplexEngineConfig {
  /** ws://127.0.0.1:7880 — the locally spawned server. */
  url: string;
  apiKey: string;
  apiSecret: string;
  room: string;
  voiceSessionId: string;
  sttUrl: string;
  sttModel: string;
  sttApiKey: string;
  sttLang?: string;
  ttsVoice: string;
}

export interface DuplexEngineDeps {
  emit: (event: LiveVoiceWorkerEvent) => void;
  fetchFn?: typeof fetch;
  synthesize?: typeof synthesizeEdgeTts;
  createRoom?: () => RoomLike;
  /**
   * Wraps the native AudioSource/LocalAudioTrack pair behind a tiny seam so
   * the engine is testable without loading @livekit/rtc-node FFI bindings.
   * Default publishes 10ms PCM frames paced by AudioSource.captureFrame.
   */
  createAudioSink?: (room: RoomLike) => Promise<AgentAudioSink | null>;
  now?: () => number;
}

export interface AgentAudioSink {
  publish(samples: Int16Array): Promise<void>;
  clear(): void;
  close(): Promise<void>;
}

/** Structural view of @livekit/rtc-node Room so tests can fake it. */
export interface RoomLike {
  on(event: string, listener: (...args: never[]) => void): unknown;
  connect(url: string, token: string): Promise<unknown>;
  disconnect(): Promise<void>;
  localParticipant: {
    publishTrack(track: unknown): Promise<unknown>;
  };
}

interface SpeakItem {
  text: string;
}

const HEALTH_INTERVAL_MS = 5_000;
const FRAME_SAMPLES_10MS = EDGE_TTS_SAMPLE_RATE / 100;
const MAX_SPEAK_QUEUE = 4;

/**
 * The voice worker's core: joins the local LiveKit room as `agent-*`, listens
 * to the `user-*` mic track, endpoints utterances (VAD → STT → event), and
 * speaks replies back (speak → Edge TTS → published PCM track).
 *
 * Raw audio never crosses the bridge — only speech-started/final-text/
 * transport/health metadata (work order §1.4).
 */
export class DuplexEngine {
  private readonly config: DuplexEngineConfig;
  private readonly deps: Required<Pick<DuplexEngineDeps, "emit" | "now">> & DuplexEngineDeps;
  private readonly pipeline: UtterancePipeline;
  private room: RoomLike | null = null;
  private audioSink: AgentAudioSink | null = null;
  private speaking = false;
  private speakQueue: SpeakItem[] = [];
  private speakLoopRunning = false;
  private speakAbort: AbortController | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private transportState: "connected" | "reconnecting" | "disconnected" = "disconnected";
  private micFrameCount = 0;
  private micMetricWindowStartedAt = 0;
  private micMetricFrames = 0;
  private micMetricRmsTotal = 0;
  private audioTrackPublished = false;

  constructor(config: DuplexEngineConfig, deps: DuplexEngineDeps) {
    this.config = config;
    this.deps = { now: Date.now, ...deps };
    this.pipeline = new UtterancePipeline({
      transcribe: ({ wav }) => this.transcribeClip(wav),
      onSpeechStarted: (atMs) => {
        this.emit({
          type: "stage",
          voiceSessionId: config.voiceSessionId,
          stage: "vad",
          state: "speech-started",
          atMs: this.deps.now(),
        });
        this.emit({ type: "user-speech-started", voiceSessionId: config.voiceSessionId, atMs });
      },
      onFinalUtterance: (text, atMs) =>
        this.emit({ type: "final-utterance", voiceSessionId: config.voiceSessionId, text, atMs }),
    });
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  async start(): Promise<void> {
    if (this.disposed) throw new Error("DuplexEngine already disposed.");
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
    this.emit({ type: "health", state: "ready", atMs: this.deps.now() });
    this.healthTimer = setInterval(() => {
      this.emit({
        type: "health",
        state: this.transportState === "connected" ? "ready" : "degraded",
        atMs: this.deps.now(),
        ...(this.transportState === "connected" ? {} : { reasonCode: `transport-${this.transportState}` }),
      });
    }, HEALTH_INTERVAL_MS);
    this.healthTimer.unref?.();
  }

  /** Queue one reply for speech. Serialized so replies never overlap. */
  speak(text: string): void {
    if (this.disposed || !text.trim()) return;
    if (this.speakQueue.length >= MAX_SPEAK_QUEUE) this.speakQueue.shift();
    this.speakQueue.push({ text: text.trim() });
    this.emit({
      type: "stage",
      voiceSessionId: this.config.voiceSessionId,
      stage: "tts",
      state: "queued",
      textLength: text.trim().length,
      atMs: this.deps.now(),
    });
    if (!this.speakLoopRunning) void this.runSpeakLoop();
  }

  /** Barge-in: drop queued replies and cut off whatever is playing. */
  stopSpeaking(): void {
    const hadSpeech = this.speaking || this.speakQueue.length > 0;
    this.speakQueue = [];
    this.speakAbort?.abort();
    this.audioSink?.clear();
    if (hadSpeech) {
      this.emit({
        type: "stage",
        voiceSessionId: this.config.voiceSessionId,
        stage: "tts",
        state: "cancelled",
        atMs: this.deps.now(),
      });
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stopSpeaking();
    if (this.healthTimer) clearInterval(this.healthTimer);
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
    const stream = new AudioStream(track, { sampleRate: 16_000, numChannels: 1, frameSizeMs: 10 });
    void this.consumeMic(stream);
  }

  private async consumeMic(stream: AudioStream): Promise<void> {
    try {
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || this.disposed) break;
        if (value) {
          this.recordMicFrame(value.data);
          this.pipeline.handleFrame({ data: value.data, sampleRate: value.sampleRate, channels: value.channels });
        }
      }
    } catch {
      // Track ended or room dropped mid-read — reconnect events surface it.
    }
  }

  private async transcribeClip(wav: Uint8Array): Promise<string | null> {
    const fetchFn = this.deps.fetchFn ?? fetch;
    const url = resolveTranscriptionUrl(this.config.sttUrl);
    const lang = this.config.sttLang?.trim() || "zh-TW";
    const form = new FormData();
    form.append("file", new Blob([toArrayBuffer(wav)], { type: "audio/wav" }), "utterance.wav");
    // Same dual-spelling as main/voice/transcribe.ts: a local
    // faster_whisper_server reads `model_name` and silently ignores `model`.
    const sttModel = this.config.sttModel.trim() || "whisper-1";
    form.append("model", sttModel);
    form.append("model_name", sttModel);
    form.append("response_format", "json");
    const languageCode = STT_LANG_CODE[lang];
    if (languageCode) form.append("language", languageCode);
    const prompt = STT_PROMPT[lang];
    if (prompt) form.append("prompt", prompt);
    const audioDurationMs = Math.max(0, ((wav.byteLength - 44) / 2 / 16_000) * 1000);
    this.emit({
      type: "stage",
      voiceSessionId: this.config.voiceSessionId,
      stage: "stt",
      state: "request",
      durationMs: audioDurationMs,
      atMs: this.deps.now(),
    });
    let response: Response;
    try {
      response = await fetchFn(url, {
        method: "POST",
        body: form,
        headers: this.config.sttApiKey ? { authorization: `Bearer ${this.config.sttApiKey}` } : {},
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      this.emit({
        type: "stage",
        voiceSessionId: this.config.voiceSessionId,
        stage: "stt",
        state: "failed",
        durationMs: audioDurationMs,
        reasonCode: "request-failed",
        atMs: this.deps.now(),
      });
      throw error;
    }
    if (!response.ok) {
      this.emit({
        type: "stage",
        voiceSessionId: this.config.voiceSessionId,
        stage: "stt",
        state: "failed",
        durationMs: audioDurationMs,
        reasonCode: `http-${response.status}`,
        atMs: this.deps.now(),
      });
      this.emit({ type: "health", state: "degraded", atMs: this.deps.now(), reasonCode: `stt-http-${response.status}` });
      throw new Error(`Speech-to-text server returned ${response.status}.`);
    }
    const body = (await response.json()) as { text?: unknown };
    const text = typeof body.text === "string" ? body.text : null;
    this.emit({
      type: "stage",
      voiceSessionId: this.config.voiceSessionId,
      stage: "stt",
      state: "final",
      durationMs: audioDurationMs,
      textLength: text?.trim().length ?? 0,
      atMs: this.deps.now(),
    });
    return text;
  }

  private async runSpeakLoop(): Promise<void> {
    this.speakLoopRunning = true;
    try {
      while (this.speakQueue.length > 0 && !this.disposed) {
        const item = this.speakQueue.shift()!;
        await this.speakOne(item.text);
      }
    } finally {
      this.speakLoopRunning = false;
    }
  }

  private async speakOne(text: string): Promise<void> {
    const synthesize = this.deps.synthesize ?? synthesizeEdgeTts;
    this.speakAbort = new AbortController();
    this.speaking = true;
    let firstChunk = true;
    let publishQueue: Promise<void> = Promise.resolve();
    try {
      await synthesize(text, {
        voice: this.config.ttsVoice,
        signal: this.speakAbort.signal,
        onChunk: (chunk) => {
          if (firstChunk) {
            firstChunk = false;
            this.emit({
              type: "stage",
              voiceSessionId: this.config.voiceSessionId,
              stage: "tts",
              state: "first-byte",
              atMs: this.deps.now(),
            });
          }
          publishQueue = publishQueue.then(() => this.publishPcm(chunk.pcm));
        },
      });
      await publishQueue;
      if (!this.speakAbort.signal.aborted) {
        this.emit({
          type: "stage",
          voiceSessionId: this.config.voiceSessionId,
          stage: "tts",
          state: "ended",
          atMs: this.deps.now(),
        });
      }
    } catch {
      // Interrupted (barge-in) or TTS unreachable — next turn retries.
      if (!this.speakAbort.signal.aborted) {
        this.emit({
          type: "stage",
          voiceSessionId: this.config.voiceSessionId,
          stage: "tts",
          state: "failed",
          reasonCode: "synthesis-failed",
          atMs: this.deps.now(),
        });
        this.emit({ type: "health", state: "degraded", atMs: this.deps.now(), reasonCode: "tts-turn-failed" });
      }
    } finally {
      this.speaking = false;
    }
  }

  private async publishPcm(pcm: Uint8Array): Promise<void> {
    if (this.disposed || this.speakAbort?.signal.aborted) return;
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
    for (let offset = 0; offset < samples.length; offset += FRAME_SAMPLES_10MS) {
      if (this.disposed || this.speakAbort?.signal.aborted) return;
      const slice = samples.subarray(offset, Math.min(offset + FRAME_SAMPLES_10MS, samples.length));
      const sink = await this.ensureAudioSink();
      if (!sink) return;
      // The default sink's publish paces at AudioSource playout rate, so
      // feeding 10ms frames back-to-back still lands at realtime cadence.
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
    if (sink && !this.audioTrackPublished) {
      this.audioTrackPublished = true;
      this.emit({
        type: "stage",
        voiceSessionId: this.config.voiceSessionId,
        stage: "tts",
        state: "track-published",
        atMs: this.deps.now(),
      });
    }
    return sink;
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

export async function createNativeAudioSink(room: RoomLike): Promise<AgentAudioSink> {
  const source = new AudioSource(EDGE_TTS_SAMPLE_RATE, 1);
  const track = LocalAudioTrack.createAudioTrack("agent-voice", source);
  try {
    await room.localParticipant.publishTrack(track);
  } catch (error) {
    await source.close().catch(() => undefined);
    throw error;
  }
  return {
    publish: (samples) => source.captureFrame(new AudioFrame(samples, EDGE_TTS_SAMPLE_RATE, 1, samples.length)),
    clear: () => source.clearQueue(),
    close: () => source.close(),
  };
}

export async function shutdownWorkerSideEffects(): Promise<void> {
  try {
    await disposeRtc();
  } catch {
    // ffi teardown must never block worker exit
  }
}

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}
