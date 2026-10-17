import { useCallback, useEffect, useRef, useState } from "react";
import { NO_SERVER_CODE } from "@shared/ipc";
import { PcmCapture, CAPTURE_SAMPLE_RATE } from "./voice/pcm-capture";
import {
  RateLimitError,
  StreamingDictationCoordinator,
  type StreamingState,
} from "./voice/streaming-coordinator";

export type VoiceError =
  | "no-mic-permission"
  | "no-speech"
  | "network"
  | "not-supported"
  | "no-stt-server"
  | "stt-auth"
  | "aborted";

// Renderer voice failures never surface in coterm.log (main only sees the
// upload), so a desktop dictation breakage was undiagnosable remotely. Report
// stage codes + coarse detail to main; transcripts never cross this channel.
function reportVoiceDiag(stage: string, detail?: string): void {
  void window.aiTerminal.voiceDiag?.(detail === undefined ? { stage } : { stage, detail });
}

export interface VoiceSttEngine {
  start(lang: string): number | void;
  stop(): void;
  cancel?(): void;
  onResult(cb: (text: string, isFinal: boolean, generation?: number) => void): void;
  onError(cb: (err: VoiceError) => void): void;
  onEnd?(cb: () => void): void;
  onState?(cb: (state: StreamingState) => void): void;
  setStreamingPreviewEnabled?(enabled: boolean): void;
  isSupported(): boolean;
  /**
   * True when the transcript only exists after stop() — server-side STT uploads
   * the clip on release, so the controller must keep the session open past
   * stop() instead of invalidating it the way it does for streaming engines.
   */
  finalizesAfterStop?: boolean;
}

/** Keep transcript text intact while making browser variants comparable. */
export function normalizeVoiceFinal(text: string): string {
  return text.normalize("NFC").trim().replace(/\s+/gu, " ");
}

export function voiceFinalFingerprint(text: string): string {
  return normalizeVoiceFinal(text);
}

export interface VoiceCommitRecord {
  text: string;
  sessionId: number | undefined;
  at: number;
}

/** Last renderer-side guard for engines that are swapped or misbehave. */
export function shouldCommitVoiceFinal(
  previous: VoiceCommitRecord | null,
  text: string,
  sessionId: number | undefined,
  now = Date.now(),
  legacyWindowMs = 1_000,
): boolean {
  const normalized = normalizeVoiceFinal(text);
  if (!normalized || !previous || previous.text !== normalized) return Boolean(normalized);
  if (sessionId !== undefined && previous.sessionId === sessionId) return false;
  return sessionId !== undefined || now - previous.at >= legacyWindowMs;
}

// ponytail: webkitSpeechRecognition has no TS types in lib.dom; declare minimal shape.
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string; isFinal?: boolean }>>; resultIndex: number }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

function createRecognition(): SpeechRecognitionLike | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

/** Join recognition segments: a space only between two Latin/digit edges,
   nothing between CJK (Chinese has no inter-word spaces). */
export function joinVoiceSegments(parts: string[]): string {
  let out = "";
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    if (out && /[A-Za-z0-9]$/u.test(out) && /^[A-Za-z0-9]/u.test(part)) out += " ";
    out += part;
  }
  return out;
}

/** Hard ceiling for one tap-to-talk session on the browser engine. */
export const WEB_SPEECH_MAX_SESSION_MS = 180_000;
/** After stop(), wait this long for the browser's last final before giving up
   and committing whatever we already heard. */
export const WEB_SPEECH_FINALIZE_GRACE_MS = 2_500;
const WEB_SPEECH_FATAL_ERRORS: Record<string, VoiceError> = {
  "not-allowed": "no-mic-permission",
  "service-not-allowed": "no-mic-permission",
  "audio-capture": "no-mic-permission",
  "network": "network",
  "language-not-supported": "not-supported",
};

/**
 * Browser/mobile dictation (Web Speech).
 *
 * One tap-to-talk session spans many recognition runs: Chrome ends a
 * non-continuous run at the first pause, so while the user is still talking
 * we restart it and keep collecting finals. The transcript is committed once,
 * after stop(): finals + any trailing interim (2026-10-06 — long sentences
 * lost everything after the first breath, and a tap mid-sentence dropped the
 * in-flight words because stop() closed the session before the browser
 * delivered them).
 */
export class WebSpeechEngine implements VoiceSttEngine {
  readonly finalizesAfterStop = true;
  private recognition: SpeechRecognitionLike | null;
  private resultCb: ((text: string, isFinal: boolean, generation?: number) => void) | null = null;
  private errorCb: ((err: VoiceError) => void) | null = null;
  private endCb: (() => void) | null = null;
  private generation = 0;
  private sessionGeneration = 0;
  private sessionOpen = false;
  private holding = false;
  private lang = "";
  private segments: string[] = [];
  private interim = "";
  private runError: string | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private finalizeTimer: ReturnType<typeof setTimeout> | null = null;

  // Per-run duplicate guard. Keep the index guard as a cheap first filter, but
  // do not rely on it for identity: iOS/WebKit and Chromium can replay the same
  // final with a reset or different resultIndex.
  private committedFinals = new Set<string>();
  private lastFinalIndex = -1;

  constructor() {
    this.recognition = createRecognition();
  }

  isSupported(): boolean {
    // ponytail: webkitSpeechRecognition needs Google's cloud API key to
    // actually run. Mobile/browser Chromium ships one; Electron desktop does
    // not, so start() fires onerror(network) instantly → button flashes red
    // and snaps back. Desktop uses Win+H (Windows built-in voice typing,
    // same IME-text-into-textarea path) instead. Hide the dead button there.
    if (!window.aiTerminal.isBrowser) return false;
    return this.recognition !== null;
  }

  start(lang: string): number | void {
    if (!this.recognition) return;
    if (this.sessionOpen) this.cancel();
    this.lang = lang;
    this.sessionGeneration = ++this.generation;
    this.sessionOpen = true;
    this.holding = true;
    this.segments = [];
    this.interim = "";
    this.maxTimer = setTimeout(() => this.stop(), WEB_SPEECH_MAX_SESSION_MS);
    this.startRun();
    return this.sessionGeneration;
  }

  stop(): void {
    if (!this.sessionOpen || !this.holding) return;
    this.holding = false;
    this.clearMaxTimer();
    try {
      this.recognition?.stop();
    } catch {
      // swallow
    }
    // onend normally finalizes; this covers a browser that never fires it.
    this.finalizeTimer = setTimeout(() => this.finalize(), WEB_SPEECH_FINALIZE_GRACE_MS);
  }

  cancel(): void {
    if (!this.sessionOpen) return;
    this.closeSession();
    try {
      this.recognition?.stop();
    } catch {
      // swallow
    }
  }

  onResult(cb: (text: string, isFinal: boolean, generation?: number) => void): void {
    this.resultCb = cb;
  }

  onError(cb: (err: VoiceError) => void): void {
    this.errorCb = cb;
  }

  onEnd(cb: () => void): void {
    this.endCb = cb;
  }

  private startRun(): void {
    const r = this.recognition;
    if (!r) return;
    const runGeneration = ++this.generation;
    r.lang = this.lang;
    r.continuous = false;
    r.interimResults = true;
    this.committedFinals.clear();
    this.lastFinalIndex = -1;
    this.runError = null;
    const live = (): boolean => this.sessionOpen && this.generation === runGeneration;
    r.onresult = (e) => {
      if (!live()) return;
      let interim = "";
      let final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const row = e.results[i];
        if (!row) continue;
        const transcript = row[0]?.transcript ?? "";
        if (row[0]?.isFinal) {
          if (i <= this.lastFinalIndex) continue;
          this.lastFinalIndex = i;
          const fingerprint = voiceFinalFingerprint(transcript);
          if (!fingerprint || this.committedFinals.has(fingerprint)) continue;
          this.committedFinals.add(fingerprint);
          final += transcript;
        } else interim += transcript;
      }
      if (final) {
        this.segments.push(final);
        this.interim = "";
      } else if (interim) this.interim = interim;
      else return;
      const preview = joinVoiceSegments([...this.segments, this.interim]);
      if (preview) this.resultCb?.(preview, false, this.sessionGeneration);
    };
    r.onerror = (e) => {
      if (!live()) return;
      this.runError = e.error;
    };
    r.onend = () => {
      if (!live()) return;
      const fatal = this.runError ? WEB_SPEECH_FATAL_ERRORS[this.runError] : undefined;
      if (fatal) {
        this.finalize(fatal);
        return;
      }
      if (this.holding) {
        // A pause (or "no-speech") ended this run while the user is still
        // talking — keep listening. A run that ended on an interim keeps it.
        if (this.interim) {
          this.segments.push(this.interim);
          this.interim = "";
        }
        this.startRun();
        return;
      }
      this.finalize();
    };
    try {
      r.start();
    } catch {
      // start() throws if already started; swallow.
    }
  }

  /** Commit everything heard (finals + trailing interim) exactly once. */
  private finalize(fatal?: VoiceError): void {
    if (!this.sessionOpen) return;
    const text = joinVoiceSegments([...this.segments, this.interim]);
    const sessionGeneration = this.sessionGeneration;
    this.closeSession();
    if (text) {
      this.resultCb?.(text, true, sessionGeneration);
      this.endCb?.();
      return;
    }
    this.errorCb?.(fatal ?? "no-speech");
  }

  private closeSession(): void {
    this.sessionOpen = false;
    this.holding = false;
    this.generation += 1;
    this.segments = [];
    this.interim = "";
    this.clearMaxTimer();
    if (this.finalizeTimer) { clearTimeout(this.finalizeTimer); this.finalizeTimer = null; }
  }

  private clearMaxTimer(): void {
    if (this.maxTimer) { clearTimeout(this.maxTimer); this.maxTimer = null; }
  }
}

/**
 * Desktop dictation: record locally, upload the clip on release, get text back.
 *
 * Web Speech needs Google's cloud key that Electron does not ship, so the
 * desktop build has had no dictation at all — this adds it by talking to a
 * whisper server (see main/voice/transcribe.ts). Browser/mobile keeps Web
 * Speech, which works there.
 */
export class WhisperEngine implements VoiceSttEngine {
  readonly finalizesAfterStop = true;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private samples: Float32Array<ArrayBuffer> | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private peakRms = 0;
  private generation = 0;
  private lang = "zh-TW";
  private resultCb: ((text: string, isFinal: boolean, generation?: number) => void) | null = null;
  private errorCb: ((err: VoiceError) => void) | null = null;
  private endCb: (() => void) | null = null;
  private stateCb: ((state: StreamingState) => void) | null = null;
  private streamingPreviewEnabled = false;
  private readonly previewCapture: PcmCapture;
  private readonly previewCoordinator: StreamingDictationCoordinator;

  constructor(options: { streamingPreview?: boolean } = {}) {
    this.streamingPreviewEnabled = options.streamingPreview === true;
    this.previewCapture = new PcmCapture({
      onPcm: (samples) => this.previewCoordinator.feedPcm(samples),
      onError: () => this.pausePreviewWithoutBreakingFinal(),
    });
    this.previewCoordinator = new StreamingDictationCoordinator({
      transcribe: async (audio, signal) => {
        if (signal.aborted) throw new Error("aborted");
        try {
          const { text } = await window.aiTerminal.transcribeVoice({
            audio,
            mimeType: "audio/wav",
            lang: this.lang,
          });
          if (signal.aborted) throw new Error("aborted");
          return text;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/\b429\b/u.test(message)) throw new RateLimitError();
          throw error;
        }
      },
      onPartial: (text, generation) => this.resultCb?.(text, false, generation),
      onStateChange: (state) => this.stateCb?.(state),
    });
  }

  isSupported(): boolean {
    // The browser build keeps Web Speech; this engine is the desktop half.
    // Deliberately does NOT check whether a server is configured — an invisible
    // button teaches nothing, a button that says "no server configured" does.
    if (window.aiTerminal.isBrowser) return false;
    return typeof MediaRecorder !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
  }

  start(lang: string): number {
    this.lang = lang;
    this.peakRms = 0;
    const generation = ++this.generation;
    void window.aiTerminal.warmVoice?.().catch(() => undefined);
    if (this.streamingPreviewEnabled) this.previewCoordinator.start(generation);
    void this.begin(generation);
    return generation;
  }

  stop(): void {
    this.clearLevelTimer();
    if (this.streamingPreviewEnabled) {
      this.previewCapture.stop();
      this.previewCoordinator.stopForFinal();
    }
    const recorder = this.recorder;
    this.recorder = null;
    if (recorder && recorder.state !== "inactive") {
      this.stateCb?.("finalizing");
      recorder.stop(); // → onstop → finish()
    } else {
      // Released before the mic came up: cancel the pending begin() and close out.
      this.generation += 1;
      if (this.streamingPreviewEnabled) this.previewCoordinator.cancel();
      this.endCb?.();
    }
    this.scheduleStreamRelease();
  }

  onResult(cb: (text: string, isFinal: boolean, generation?: number) => void): void { this.resultCb = cb; }
  onError(cb: (err: VoiceError) => void): void { this.errorCb = cb; }
  onEnd(cb: () => void): void { this.endCb = cb; }
  onState(cb: (state: StreamingState) => void): void { this.stateCb = cb; }
  setStreamingPreviewEnabled(enabled: boolean): void { this.streamingPreviewEnabled = enabled; }

  private async begin(generation: number): Promise<void> {
    try {
      if (this.releaseTimer) { clearTimeout(this.releaseTimer); this.releaseTimer = null; }
      const stream = await this.ensureStream();
      if (generation !== this.generation) return; // released while the mic was opening
      // A suspended AudioContext leaves the analyser reading zeros, which the
      // silence gate then drops as "no speech" — resume after the async gap.
      if (this.context?.state === "suspended") await this.context.resume();
      if (generation !== this.generation) return;
      this.chunks = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (event) => { if (event.data.size > 0) this.chunks.push(event.data); };
      recorder.onstop = () => { void this.finish(generation, recorder.mimeType); };
      this.recorder = recorder;
      recorder.start();
      this.levelTimer = setInterval(() => this.sampleLevel(), 100);
      this.maxDurationTimer = setTimeout(() => this.stop(), MAX_RECORDING_MS);
      if (this.streamingPreviewEnabled && this.context && this.sourceNode) {
        void this.previewCapture.start(this.context, this.sourceNode);
      }
    } catch (error) {
      if (generation === this.generation) {
        reportVoiceDiag("begin-failed", error instanceof Error ? error.name : "unknown");
        if (this.streamingPreviewEnabled) this.previewCoordinator.completeFinal(false);
        this.errorCb?.("no-mic-permission");
      }
    }
  }

  private async ensureStream(): Promise<MediaStream> {
    // pitfall #2 (local-dictate): tearing the capture down and reopening it on
    // every press eventually hands back a stream that opens fine and records
    // pure silence — and whisper hallucinates whole fluent sentences out of
    // silence. Open once and keep it across presses.
    if (this.stream?.getAudioTracks().some((track) => track.readyState === "live")) return this.stream;
    this.dropStream();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const context = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE });
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    const sourceNode = context.createMediaStreamSource(stream);
    sourceNode.connect(analyser);
    this.stream = stream;
    this.context = context;
    this.sourceNode = sourceNode;
    this.analyser = analyser;
    this.samples = new Float32Array(analyser.fftSize);
    return stream;
  }

  private sampleLevel(): void {
    const analyser = this.analyser;
    const buffer = this.samples;
    if (!analyser || !buffer) return;
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) sum += buffer[i]! * buffer[i]!;
    this.peakRms = Math.max(this.peakRms, Math.sqrt(sum / buffer.length));
  }

  private clearLevelTimer(): void {
    if (this.levelTimer) { clearInterval(this.levelTimer); this.levelTimer = null; }
    if (this.maxDurationTimer) { clearTimeout(this.maxDurationTimer); this.maxDurationTimer = null; }
  }

  private async finish(generation: number, mimeType: string): Promise<void> {
    if (generation !== this.generation) return;
    const blob = new Blob(this.chunks, { type: mimeType || "audio/webm" });
    this.chunks = [];
    // The transcript goes into a terminal, where a hallucinated sentence is a
    // hallucinated command. Silence is where whisper hallucinates most, so a
    // near-silent clip is dropped here and never uploaded.
    if (blob.size === 0 || this.peakRms < SILENCE_RMS) {
      reportVoiceDiag("finish-silence", `bytes=${blob.size} peakRms=${this.peakRms.toFixed(5)}`);
      if (this.streamingPreviewEnabled) this.previewCoordinator.completeFinal(false);
      this.errorCb?.("no-speech");
      return;
    }
    try {
      // ponytail: ceiling — sends webm/opus, so the server has to decode it
      // (speaches/faster-whisper and OpenAI do; a bare whisper.cpp build wants
      // wav). Encode wav here only if a wav-only server has to be supported.
      const { text } = await window.aiTerminal.transcribeVoice({
        audio: await blob.arrayBuffer(),
        mimeType: blob.type,
        lang: this.lang,
      });
      if (generation !== this.generation) return;
      if (text) {
        if (this.streamingPreviewEnabled) this.previewCoordinator.completeFinal(true);
        this.resultCb?.(text, true, generation);
      } else {
        if (this.streamingPreviewEnabled) this.previewCoordinator.completeFinal(false);
        this.errorCb?.("no-speech");
      }
    } catch (error) {
      if (generation !== this.generation) return;
      if (this.streamingPreviewEnabled) this.previewCoordinator.completeFinal(false);
      const message = error instanceof Error ? error.message : String(error);
      reportVoiceDiag("finish-error", message.slice(0, 150));
      this.errorCb?.(
        message.includes(NO_SERVER_CODE)
          ? "no-stt-server"
          : /\b(401|403)\b/.test(message)
            ? "stt-auth"
            : "network",
      );
    }
  }

  private scheduleStreamRelease(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    // ponytail: keep the mic across consecutive presses (pitfall #2) but hand it
    // back when idle — a terminal has no business holding the OS mic indicator
    // open all day. 10 minutes now (was 60s): dictation pauses between
    // utterances routinely exceed a minute, and a reopened stream costs a
    // getUserMedia spin-up that cuts the first syllables — and can come back
    // recording pure silence, which the RMS gate then drops as a lost
    // utterance. Staying warm a few extra minutes costs one idle MediaStream +
    // AudioContext (tens of MB at most) and keeps the OS mic indicator lit for
    // up to 10 min after the last dictation — still bounded, never all day.
    this.releaseTimer = setTimeout(() => this.dropStream(), STREAM_RELEASE_IDLE_MS);
  }

  cancel(): void {
    this.generation += 1;
    this.clearLevelTimer();
    this.previewCapture.stop();
    this.previewCoordinator.cancel();
    const recorder = this.recorder;
    this.recorder = null;
    this.chunks = [];
    if (recorder && recorder.state !== "inactive") recorder.stop();
    this.scheduleStreamRelease();
  }

  private dropStream(): void {
    this.previewCapture.stop();
    this.previewCoordinator.cancel();
    this.sourceNode?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.context?.close();
    this.stream = null;
    this.context = null;
    this.sourceNode = null;
    this.analyser = null;
    this.samples = null;
  }

  private pausePreviewWithoutBreakingFinal(): void {
    if (!this.streamingPreviewEnabled) return;
    this.previewCoordinator.cancel();
    this.stateCb?.("preview-paused");
  }
}

/** Event-driven engine available only when the isolated E2E preload flag is set. */
class VoiceTestHarnessEngine implements VoiceSttEngine {
  readonly finalizesAfterStop = true;
  private generation = 0;
  private active = false;
  private resultCb: ((text: string, isFinal: boolean, generation?: number) => void) | null = null;
  private errorCb: ((err: VoiceError) => void) | null = null;
  private stateCb: ((state: StreamingState) => void) | null = null;

  constructor() {
    window.addEventListener("coterm:test-voice-partial", (event) => {
      if (!this.active) return;
      const text = (event as CustomEvent<{ text?: unknown }>).detail?.text;
      if (typeof text === "string") {
        this.stateCb?.("partial");
        this.resultCb?.(text, false, this.generation);
      }
    });
    window.addEventListener("coterm:test-voice-final", (event) => {
      if (!this.active) return;
      const text = (event as CustomEvent<{ text?: unknown }>).detail?.text;
      if (typeof text !== "string") return;
      this.active = false;
      this.stateCb?.("idle");
      this.resultCb?.(text, true, this.generation);
    });
    window.addEventListener("coterm:test-voice-preview-paused", () => {
      if (this.active) this.stateCb?.("preview-paused");
    });
    window.addEventListener("coterm:test-voice-error", (event) => {
      if (!this.active) return;
      const value = (event as CustomEvent<{ error?: VoiceError }>).detail?.error ?? "network";
      this.active = false;
      this.stateCb?.("error");
      this.errorCb?.(value);
    });
  }

  isSupported(): boolean { return true; }
  start(): number {
    this.active = true;
    this.generation += 1;
    this.stateCb?.("listening");
    return this.generation;
  }
  stop(): void { if (this.active) this.stateCb?.("finalizing"); }
  cancel(): void {
    this.active = false;
    this.generation += 1;
    this.stateCb?.("idle");
  }
  onResult(cb: (text: string, isFinal: boolean, generation?: number) => void): void { this.resultCb = cb; }
  onError(cb: (err: VoiceError) => void): void { this.errorCb = cb; }
  onState(cb: (state: StreamingState) => void): void { this.stateCb = cb; }
}

/** Peak RMS below this over the whole clip counts as "nothing was said".
 *  0.02 (was 0.01): a quiet room's ambient noise (fans, AC, keyboard resonance)
 *  sits around 0.01–0.05 RMS — the old 0.01 gate let that through, and whisper
 *  hallucinates fluent sentences ("中文字幕由 Amara.org 社群提供", "本集完")
 *  out of near-silence. 0.02 blocks ambient noise while normal speech (0.05+)
 *  still passes. Raise further if your room is loud; do not lower below 0.012
 *  or ambient noise leaks through again. */
const SILENCE_RMS = 0.02;
// Desktop clip ceiling. 60s cut long dictation mid-sentence (2026-10-06);
// 3 minutes of opus is ~1-3MB, far under the 25MB upload cap.
const MAX_RECORDING_MS = 180_000;
// How long the mic stream stays open after the last dictation before being
// handed back to the OS. See scheduleStreamRelease for the privacy tradeoff.
export const STREAM_RELEASE_IDLE_MS = 10 * 60_000;

// Test override hook. ponytail: production uses WebSpeechEngine; tests inject a mock.
let engineFactory: (() => VoiceSttEngine) | null = null;
export function setVoiceEngineFactoryForTest(factory: (() => VoiceSttEngine) | null | undefined): void {
  engineFactory = factory ?? null;
}

export interface UseVoiceInputOpts {
  lang: string;
  onFinal: (text: string, sessionId?: number) => void;
  onError?: (err: VoiceError) => void;
  onChange?: () => void;
  streamingPreview?: boolean;
}

export interface UseVoiceInputResult {
  isSupported: boolean;
  isRecording: boolean;
  interim: string;
  streamingState: StreamingState;
  start(): void;
  stop(): void;
  cancel(): void;
}

// ponytail: pure state machine, no React — testable in node env without a renderer.
// The hook below wraps it and mirrors state into useState for re-rendering.
export class VoiceController {
  isSupported: boolean;
  isRecording = false;
  interim = "";
  streamingState: StreamingState = "idle";
  // Public so the hook can refresh latest closures without rebuilding the controller.
  onFinal: (text: string, sessionId?: number) => void;
  onError: ((err: VoiceError) => void) | undefined;
  // Fired after any internal state change so the hook can mirror into React state.
  onChange: (() => void) | undefined;
  lang: string;
  private engine: VoiceSttEngine;
  private sessionId = 0;
  private finalCommitted = false;
  private active = false;
  private stopRequested = false;
  private engineGeneration: number | undefined;

  constructor(opts: UseVoiceInputOpts, engine: VoiceSttEngine) {
    this.lang = opts.lang;
    this.onFinal = opts.onFinal;
    this.onError = opts.onError;
    this.onChange = opts.onChange;
    this.engine = engine;
    this.engine.setStreamingPreviewEnabled?.(opts.streamingPreview === true);
    this.isSupported = engine.isSupported();
    engine.onResult((text, isFinal, generation) => {
      if (generation !== undefined && generation !== this.engineGeneration) return;
      if (isFinal) {
        if (!this.active || this.finalCommitted) return;
        const normalized = normalizeVoiceFinal(text);
        this.finalCommitted = true;
        this.active = false;
        if (normalized) this.onFinal(normalized, this.sessionId);
        this.interim = "";
        this.isRecording = false;
        this.streamingState = "idle";
      } else {
        if (!this.active) return;
        this.interim = text;
      }
      this.onChange?.();
    });
    engine.onError((err) => {
      this.invalidateSession();
      this.isRecording = false;
      this.interim = "";
      this.streamingState = "error";
      this.onError?.(err);
      this.onChange?.();
    });
    engine.onEnd?.(() => {
      this.invalidateSession();
      this.isRecording = false;
      this.interim = "";
      this.streamingState = "idle";
      this.onChange?.();
    });
    engine.onState?.((state) => {
      this.streamingState = state;
      this.onChange?.();
    });
  }

  start(): void {
    if (!this.engine.isSupported() || this.active) return;
    this.sessionId += 1;
    this.finalCommitted = false;
    this.active = true;
    this.stopRequested = false;
    this.interim = "";
    this.isRecording = true;
    this.engineGeneration = this.engine.start(this.lang) || undefined;
    this.onChange?.();
  }

  stop(): void {
    if (this.active && this.engine.finalizesAfterStop) {
      // Repeated button/key release while transcribing must not stop the
      // engine again: Whisper's second stop otherwise invalidates the result.
      if (this.stopRequested) return;
      this.stopRequested = true;
      // Server-side STT has nothing to commit until the clip is uploaded, so the
      // session stays open past stop(); the engine's result/error/end closes it.
      // isRecording stays true so the button keeps signalling "still working".
      // ponytail: a wedged request would block the next press — the engine's own
      // request timeout (main/voice/transcribe.ts) is what unwedges it, and that
      // budget is now 90s per attempt with up to 2 timeout retries, so a dead
      // server can hold the button for minutes before the error lands.
      this.engine.stop();
      this.onChange?.();
      return;
    }
    this.invalidateSession();
    this.engine.stop();
    this.isRecording = false;
    this.onChange?.();
  }

  cancel(): void {
    if (!this.active) return;
    this.invalidateSession();
    if (this.engine.cancel) this.engine.cancel();
    else this.engine.stop();
    this.isRecording = false;
    this.interim = "";
    this.onChange?.();
  }

  setStreamingPreviewEnabled(enabled: boolean): void {
    this.engine.setStreamingPreviewEnabled?.(enabled);
  }

  private invalidateSession(): void {
    this.active = false;
    this.finalCommitted = true;
    this.sessionId += 1;
    this.engineGeneration = undefined;
  }
}

export function createVoiceController(opts: UseVoiceInputOpts): VoiceController {
  // Browser/mobile: Web Speech works and needs no server. Desktop: Electron has
  // no Web Speech key, so record-and-upload is the only path.
  const engine = engineFactory
    ? engineFactory()
    : window.aiTerminal.voiceTestHarness
      ? new VoiceTestHarnessEngine()
      : window.aiTerminal.isBrowser
      ? new WebSpeechEngine()
      : new WhisperEngine({ streamingPreview: opts.streamingPreview === true });
  return new VoiceController(opts, engine);
}

export function useVoiceInput(opts: UseVoiceInputOpts): UseVoiceInputResult {
  const { lang, onFinal, onError, streamingPreview = false } = opts;
  const [snapshot, setSnapshot] = useState<{
    isSupported: boolean;
    isRecording: boolean;
    interim: string;
    streamingState: StreamingState;
  }>(() => ({
    isSupported: false,
    isRecording: false,
    interim: "",
    streamingState: "idle",
  }));
  // ponytail: controller lives in a ref (mutable, not state) so we can refresh
  // its closures/lang each render without tripping react-hooks/immutability.
  // Re-render signal comes from setSnapshot, driven by onChange.
  const ctrlRef = useRef<VoiceController | null>(null);
  // Build the controller once, in an effect, so render never reads the ref.
  useEffect(() => {
    if (ctrlRef.current !== null) return;
    ctrlRef.current = createVoiceController({
      ...opts,
      onChange: () => {
        const c = ctrlRef.current;
        if (c) setSnapshot({
          isSupported: c.isSupported,
          isRecording: c.isRecording,
          interim: c.interim,
          streamingState: c.streamingState,
        });
      },
    });
    const c = ctrlRef.current;
    setSnapshot({
      isSupported: c.isSupported,
      isRecording: c.isRecording,
      interim: c.interim,
      streamingState: c.streamingState,
    });
    // opts is captured once at mount; closures/lang are refreshed by the effect below.
  }, [opts]);
  // Refresh latest closures/lang without recreating the controller.
  useEffect(() => {
    const c = ctrlRef.current;
    if (!c) return;
    c.onFinal = onFinal;
    c.onError = onError;
    c.lang = lang;
    c.setStreamingPreviewEnabled(streamingPreview);
  });
  // Stop recognition if the component unmounts mid-recording.
  useEffect(() => () => { ctrlRef.current?.stop(); }, []);

  const start = useCallback(() => {
    const c = ctrlRef.current;
    if (!c || !c.isSupported) return;
    c.start();
  }, []);

  const stop = useCallback(() => {
    ctrlRef.current?.stop();
  }, []);

  const cancel = useCallback(() => {
    ctrlRef.current?.cancel();
  }, []);

  return {
    isSupported: snapshot.isSupported,
    isRecording: snapshot.isRecording,
    interim: snapshot.interim,
    streamingState: snapshot.streamingState,
    start,
    stop,
    cancel,
  };
}
