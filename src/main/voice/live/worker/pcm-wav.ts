/**
 * Encodes interleaved 16-bit PCM samples as a RIFF/WAVE buffer. Whisper-style
 * servers key off the container, not a MediaRecorder mimeType, so the worker
 * hands over plain WAV bytes instead of the browser's webm/opus chunks.
 */
export function encodePcm16Wav(input: { samples: Int16Array; sampleRate: number; channels: number }): Uint8Array {
  const { samples, sampleRate } = input;
  const channels = Math.max(1, Math.trunc(input.channels));
  const dataBytes = samples.byteLength;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format tag
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true); // byte rate
  view.setUint16(32, channels * 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  new Int16Array(buffer, 44).set(samples);
  return new Uint8Array(buffer);
}

/** Averages interleaved multi-channel PCM down to a single channel. */
export function downmixToMono(samples: Int16Array, channels: number): Int16Array {
  const count = Math.max(1, Math.trunc(channels));
  if (count <= 1) return samples;
  const frames = Math.floor(samples.length / count);
  const mono = new Int16Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    const base = frame * count;
    for (let ch = 0; ch < count; ch += 1) sum += samples[base + ch] ?? 0;
    mono[frame] = Math.max(-32768, Math.min(32767, Math.round(sum / count)));
  }
  return mono;
}
