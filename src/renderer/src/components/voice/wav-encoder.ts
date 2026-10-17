/**
 * Pure WAV encoder for 16kHz mono PCM — no DOM, no Electron, fully testable.
 *
 * Phase 4 streaming dictation captures continuous PCM from an AudioWorklet
 * (or test harness), maintains a rolling buffer, and periodically encodes a
 * 4–6 second preview as a WAV ArrayBuffer for upload to the STT server.
 */

export const PREVIEW_SAMPLE_RATE = 16_000;
export const PREVIEW_CHANNELS = 1;
export const PREVIEW_BITS_PER_SAMPLE = 16;

/** 5 seconds of 16kHz mono 16-bit audio = 160 KB. */
export const PREVIEW_DURATION_MS = 5_000;
export const PREVIEW_SAMPLE_COUNT = Math.floor((PREVIEW_SAMPLE_RATE * PREVIEW_DURATION_MS) / 1_000);

/**
 * Encode a Float32 PCM buffer (samples in [-1, 1]) as a 16kHz mono WAV
 * ArrayBuffer.  This is the exact format whisper.cpp / speaches / OpenAI
 * /v1/audio/transcriptions accept without container negotiation.
 */
export function encodeWav(samples: Float32Array, sampleRate = PREVIEW_SAMPLE_RATE): ArrayBuffer {
  const byteLength = 44 + samples.length * 2;
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, PREVIEW_CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * PREVIEW_CHANNELS * 2, true); // byte rate
  view.setUint16(32, PREVIEW_CHANNELS * 2, true); // block align
  view.setUint16(34, PREVIEW_BITS_PER_SAMPLE, true);
  writeString(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

/**
 * Rolling PCM buffer — appends incoming Float32 chunks and can extract the
 * last N samples as a preview.  Threaded by the streaming coordinator.
 */
export class PcmRingBuffer {
  private buffer: Float32Array;
  private writePos = 0;
  private filled = 0;

  constructor(capacity = PREVIEW_SAMPLE_COUNT) {
    this.buffer = new Float32Array(capacity);
  }

  get length(): number {
    return this.filled;
  }

  get capacity(): number {
    return this.buffer.length;
  }

  append(samples: Float32Array): void {
    const n = samples.length;
    if (n >= this.buffer.length) {
      // New data is larger than the whole ring — keep only the tail.
      const start = n - this.buffer.length;
      this.buffer.set(samples.subarray(start), 0);
      this.writePos = 0;
      this.filled = this.buffer.length;
      return;
    }
    const end = this.writePos + n;
    if (end <= this.buffer.length) {
      this.buffer.set(samples, this.writePos);
    } else {
      const split = this.buffer.length - this.writePos;
      this.buffer.set(samples.subarray(0, split), this.writePos);
      this.buffer.set(samples.subarray(split), 0);
    }
    this.writePos = end % this.buffer.length;
    this.filled = Math.min(this.filled + n, this.buffer.length);
  }

  /** Extract the last `count` samples (or all if fewer available). */
  tail(count: number): Float32Array {
    const n = Math.min(count, this.filled);
    if (n === 0) return new Float32Array(0);
    const out = new Float32Array(n);
    const start = (this.writePos - n + this.buffer.length) % this.buffer.length;
    if (start + n <= this.buffer.length) {
      out.set(this.buffer.subarray(start, start + n));
    } else {
      const split = this.buffer.length - start;
      out.set(this.buffer.subarray(start, this.buffer.length), 0);
      out.set(this.buffer.subarray(0, n - split), split);
    }
    return out;
  }

  /** Extract all accumulated samples (for the final full utterance). */
  all(): Float32Array {
    return this.tail(this.filled);
  }

  clear(): void {
    this.writePos = 0;
    this.filled = 0;
  }
}

/** Compute RMS amplitude — used by the silence gate (mirrors WhisperEngine). */
export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / samples.length);
}
