import { Room, RoomEvent, Track } from "livekit-client";
import type { ConnectionState } from "livekit-client";
import type { VoiceSessionCommand, VoiceSessionCommandResult } from "@shared/types";

export interface LivekitDuplexTransport {
  connectionState(): ConnectionState;
  setMicrophoneMuted(muted: boolean): Promise<void>;
  disconnect(): Promise<void>;
}

export interface LivekitRendererStage {
  stage: "permission" | "room" | "mic-capture" | "publish" | "speaker";
  state: string;
  atMs: number;
  framesPerSecond?: number;
  rms?: number;
  reasonCode?: string;
}

export interface LivekitDuplexSessionDeps {
  url: string;
  token: string;
  voiceSessionId: string;
  /** IPC bridge into the main-process voice session controller. */
  sendCommand: (command: VoiceSessionCommand) => Promise<VoiceSessionCommandResult>;
  /** Speaker playback hook — tests observe playback without real audio. */
  playTrack?: (mediaStreamTrack: MediaStreamTrack) => () => void;
  /** Injectable room factory so unit tests and BDD can run without WebRTC. */
  createRoom?: () => Room;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  onDisconnected?: () => void;
  /** Metadata-only renderer sound-path diagnostics. Never include transcript,
   * token, URL, raw audio, or MediaStream objects. */
  onStage?: (stage: LivekitRendererStage) => void;
}

const DEFAULT_PLAY_TRACK = (
  mediaStreamTrack: MediaStreamTrack,
  onAutoplayBlocked?: () => void,
): (() => void) => {
  const element = document.createElement("audio");
  element.autoplay = true;
  element.srcObject = new MediaStream([mediaStreamTrack]);
  void element.play().catch(() => onAutoplayBlocked?.());
  return () => {
    element.pause();
    element.srcObject = null;
    element.remove();
  };
};

/**
 * Renderer side of the LiveKit duplex call: publishes the microphone, plays
 * the agent audio track, and reports transport changes back over the existing
 * liveVoiceSession IPC channel. Capture/STT stays in the worker; this module
 * only moves sound and session statuses.
 */
export class LivekitDuplexSession {
  private room: Room | null = null;
  private micTrack: MediaStreamTrack | null = null;
  private stopPlayback: (() => void) | null = null;
  private stopMicMeter: (() => void) | null = null;
  private stopped = false;

  constructor(private readonly deps: LivekitDuplexSessionDeps) {}

  async start(): Promise<LivekitDuplexTransport> {
    this.stopped = false;
    const room = this.deps.createRoom?.() ?? new Room({ adaptiveStream: false, dynacast: true });
    this.room = room;
    try {
    room.on(RoomEvent.TrackSubscribed, (_track, publication, participant) => {
      if (publication.kind !== Track.Kind.Audio) return;
      if (!participant.identity.startsWith("agent-")) return;
      this.stopPlayback?.();
      const mediaTrack = _track.mediaStreamTrack;
      if (!mediaTrack) return;
      this.stage("speaker", "subscribed");
      if (this.deps.playTrack) {
        this.stopPlayback = this.deps.playTrack(mediaTrack);
      } else {
        this.stopPlayback = DEFAULT_PLAY_TRACK(mediaTrack, () => this.stage("speaker", "autoplay-blocked", "autoplay-blocked"));
      }
      this.stage("speaker", "playing");
    });
    room.on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
      if (track.kind !== Track.Kind.Audio) return;
      if (!participant.identity.startsWith("agent-")) return;
      this.stopPlayback?.();
      this.stopPlayback = null;
      this.stage("speaker", "ended");
      // Agent TTS finished → the state machine leaves "speaking".
      void this.deps.sendCommand({ action: "reply-finished", voiceSessionId: this.deps.voiceSessionId });
    });
    room.on(RoomEvent.Reconnecting, () => {
      void this.deps.sendCommand({ action: "reconnecting", voiceSessionId: this.deps.voiceSessionId });
    });
    room.on(RoomEvent.Reconnected, () => {
      void this.deps.sendCommand({ action: "reconnected", voiceSessionId: this.deps.voiceSessionId, transport: "livekit" });
    });
    room.on(RoomEvent.Disconnected, () => {
      if (this.stopped) return;
      void this.deps.sendCommand({ action: "reconnecting", voiceSessionId: this.deps.voiceSessionId });
      this.deps.onDisconnected?.();
    });
    this.stage("room", "connecting");
    await room.connect(this.deps.url, this.deps.token);
    this.stage("room", "connected");
    const getUserMedia = this.deps.getUserMedia
      ?? ((constraints) => navigator.mediaDevices.getUserMedia(constraints));
    this.stage("permission", "requested");
    let mic: MediaStream;
    try {
      mic = await getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      this.stage("permission", "granted");
    } catch (error) {
      this.stage("permission", "denied", error instanceof DOMException ? error.name.toLowerCase() : "capture-failed");
      throw error;
    }
    this.micTrack = mic.getAudioTracks()[0] ?? null;
    if (!this.micTrack) throw new Error("No microphone track available for Live Voice.");
    this.stage("mic-capture", "track-ready");
    this.stopMicMeter = this.startMicMeter(mic);
    this.stage("publish", "publishing");
    await room.localParticipant.publishTrack(this.micTrack, { name: "user-mic" });
    this.stage("publish", "published");
      return this.transportView(room);
    } catch (error) {
      this.stage("room", "failed", "start-failed");
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  private stage(
    stage: LivekitRendererStage["stage"],
    state: string,
    reasonCode?: string,
    metrics?: { framesPerSecond?: number; rms?: number },
  ): void {
    this.deps.onStage?.({
      stage,
      state: state.slice(0, 48),
      atMs: Date.now(),
      ...(metrics?.framesPerSecond !== undefined ? { framesPerSecond: metrics.framesPerSecond } : {}),
      ...(metrics?.rms !== undefined ? { rms: metrics.rms } : {}),
      ...(reasonCode && /^[a-z0-9._-]{1,64}$/i.test(reasonCode) ? { reasonCode } : {}),
    });
  }

  private startMicMeter(stream: MediaStream): (() => void) | null {
    if (typeof window === "undefined") return null;
    const AudioContextCtor = window.AudioContext;
    if (!AudioContextCtor || typeof window.requestAnimationFrame !== "function") return null;
    let stopped = false;
    let frameCount = 0;
    let rmsTotal = 0;
    let windowStartedAt = performance.now();
    let raf = 0;
    let context: AudioContext | null = null;
    try {
      context = new AudioContextCtor();
      void context.resume().catch(() => undefined);
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const tick = (now: number): void => {
        if (stopped) return;
        analyser.getFloatTimeDomainData(samples);
        let squareSum = 0;
        for (let i = 0; i < samples.length; i += 1) {
          const value = samples[i] ?? 0;
          squareSum += value * value;
        }
        frameCount += 1;
        rmsTotal += Math.sqrt(squareSum / Math.max(1, samples.length));
        const elapsed = now - windowStartedAt;
        if (elapsed >= 1_000) {
          this.stage("mic-capture", "frames", undefined, {
            framesPerSecond: Math.round((frameCount * 100_000) / Math.max(1, elapsed)) / 100,
            rms: Math.round((rmsTotal / Math.max(1, frameCount)) * 10_000) / 10_000,
          });
          frameCount = 0;
          rmsTotal = 0;
          windowStartedAt = now;
        }
        raf = window.requestAnimationFrame(tick);
      };
      raf = window.requestAnimationFrame(tick);
    } catch {
      void context?.close().catch(() => undefined);
      return null;
    }
    return () => {
      stopped = true;
      if (raf) window.cancelAnimationFrame(raf);
      void context?.close().catch(() => undefined);
    };
  }

  private transportView(room: Room): LivekitDuplexTransport {
    return {
      connectionState: () => room.state,
      setMicrophoneMuted: async (muted) => {
        await room.localParticipant.setMicrophoneEnabled(!muted);
      },
      disconnect: () => this.stop(),
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopMicMeter?.();
    this.stopMicMeter = null;
    this.stopPlayback?.();
    this.stopPlayback = null;
    if (this.micTrack) {
      this.micTrack.stop();
      this.micTrack = null;
    }
    const room = this.room;
    this.room = null;
    if (room) await room.disconnect();
  }
}
