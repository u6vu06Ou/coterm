import { VadEndpointController, type VadEndpointOptions } from "@shared/voice-vad";
import { downmixToMono, encodePcm16Wav } from "./pcm-wav";

export interface PcmFrame {
  data: Int16Array;
  sampleRate: number;
  channels: number;
}

export interface UtterancePipelineOptions {
  /**
   * Receives the mono PCM for one completed utterance and returns the
   * transcript; called serially per utterance. Injectable in tests so the
   * pipeline never needs a network.
   */
  transcribe: (input: { wav: Uint8Array; sampleRate: number }) => Promise<string | null>;
  onSpeechStarted: (atMs: number) => void;
  onFinalUtterance: (text: string, atMs: number) => void;
  /** Optional VAD endpoint signal — fires whenever local speech ends, even for
   *  utterances below minUtteranceMs (used by the Gemini provider to bracket
   *  the turn with activityEnd). */
  onSpeechEnded?: (atMs: number) => void;
vad?: VadEndpointOptions;
  /** RMS threshold on int16 PCM; below it is treated as room silence. */
  rmsThreshold?: number;
  /** Utterances shorter than this are dropped without calling STT. */
  minUtteranceMs?: number;
  /** Bounded rolling audio kept before VAD opens, preventing clipped words. */
  preRollMs?: number;
  maxBufferedFrames?: number;
}

const DEFAULT_RMS_THRESHOLD = 800;
const DEFAULT_MIN_UTTERANCE_MS = 250;
const DEFAULT_PRE_ROLL_MS = 400;
const DEFAULT_MAX_BUFFERED_FRAMES = 60 * 100; // ~1 minute at 10ms frames

/**
 * Turns a live PCM stream into endpointed utterances. Pure and synchronous —
 * all I/O goes through the injected `transcribe`, and the RMS gate runs
 * upstream of the shared, audio-free VadEndpointController (timestamps only).
 */
export class UtterancePipeline {
  private readonly vad: VadEndpointController;
  private readonly rmsThreshold: number;
  private readonly minUtteranceMs: number;
  private readonly preRollMs: number;
  private readonly maxBufferedFrames: number;
  private collecting = false;
  private utteranceStartAtMs = 0;
  private buffered: Int16Array[] = [];
  private bufferedFrames = 0;
  private preRoll: Int16Array[] = [];
  private preRollSamples = 0;
  private sampleRate = 16_000;
  private atMs = 0;
  private transcriptionQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: UtterancePipelineOptions) {
    this.vad = new VadEndpointController(options.vad);
    this.rmsThreshold = options.rmsThreshold ?? DEFAULT_RMS_THRESHOLD;
    this.minUtteranceMs = options.minUtteranceMs ?? DEFAULT_MIN_UTTERANCE_MS;
    this.preRollMs = Math.max(300, Math.min(500, options.preRollMs ?? DEFAULT_PRE_ROLL_MS));
    this.maxBufferedFrames = options.maxBufferedFrames ?? DEFAULT_MAX_BUFFERED_FRAMES;
  }

  get nowMs(): number {
    return this.atMs;
  }

  handleFrame(frame: PcmFrame): void {
    const channels = Math.max(1, Math.trunc(frame.channels));
    const samples = downmixToMono(frame.data, channels);
    this.sampleRate = frame.sampleRate;
    const frameDurationMs = samples.length > 0 ? (samples.length / frame.sampleRate) * 1000 : 0;
    this.atMs += Math.max(0, frameDurationMs);

    const speech = rms(samples) >= this.rmsThreshold;

    const events = this.vad.observe({ speech, atMs: this.atMs });
    for (const event of events) {
      if (event.type === "speech-started") {
        // Covers barge-in too: the agent's outgoing audio is not part of this
        // stream (renderer mic has echoCancellation), so user speech here is
        // always a real user turn — even when the agent is mid-reply.
        this.options.onSpeechStarted(event.atMs);
        this.collecting = true;
        this.utteranceStartAtMs = event.atMs;
        // Preserve the bounded 300–500ms rolling lead-in accumulated before
        // VAD opened. This includes the first minSpeechMs speech frames and
        // avoids chopping initial consonants/short words.
        this.buffered = this.preRoll.map((chunk) => chunk.slice());
        this.bufferedFrames = this.buffered.length;
        this.preRoll = [];
        this.preRollSamples = 0;
      } else if (this.collecting) {
        this.collecting = false;
        this.options.onSpeechEnded?.(event.atMs);
        const durationMs = event.atMs - this.utteranceStartAtMs;
        const samplesToTranscribe = this.buffered;
        this.buffered = [];
        this.bufferedFrames = 0;
        if (durationMs >= this.minUtteranceMs && samplesToTranscribe.length > 0) {
          this.enqueue(samplesToTranscribe, event.atMs);
        }
      }
    }

    if (this.collecting) {
      if (this.bufferedFrames >= this.maxBufferedFrames) {
        this.collecting = false;
        this.buffered = [];
        this.bufferedFrames = 0;
        this.vad.reset();
      } else {
        this.buffered.push(samples);
        this.bufferedFrames += 1;
      }
    } else {
      this.pushPreRoll(samples, frame.sampleRate);
    }
  }

  reset(): void {
    this.collecting = false;
    this.buffered = [];
    this.bufferedFrames = 0;
    this.preRoll = [];
    this.preRollSamples = 0;
    this.vad.reset();
  }

  private pushPreRoll(samples: Int16Array, sampleRate: number): void {
    if (samples.length === 0 || sampleRate <= 0) return;
    this.preRoll.push(samples.slice());
    this.preRollSamples += samples.length;
    const maxSamples = Math.max(1, Math.ceil((sampleRate * this.preRollMs) / 1000));
    while (this.preRollSamples > maxSamples && this.preRoll.length > 0) {
      const oldest = this.preRoll.shift()!;
      this.preRollSamples -= oldest.length;
    }
  }

  /** Serialized: STT requests fire one at a time so clips arrive in order. */
  private enqueue(frames: Int16Array[], atMs: number): void {
    this.transcriptionQueue = this.transcriptionQueue.then(async () => {
      const total = frames.reduce((sum, frame) => sum + frame.length, 0);
      const merged = new Int16Array(total);
      let offset = 0;
      for (const frame of frames) {
        merged.set(frame, offset);
        offset += frame.length;
      }
      const wav = encodePcm16Wav({ samples: merged, sampleRate: this.sampleRate, channels: 1 });
      try {
        const text = await this.options.transcribe({ wav, sampleRate: this.sampleRate });
        if (text && text.trim()) this.options.onFinalUtterance(text.trim(), atMs);
      } catch {
        // STT failure on one utterance must not kill the stream — the next
        // utterance retries on its own. Health reporting is the engine's job.
      }
    });
  }
}

function rms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}
