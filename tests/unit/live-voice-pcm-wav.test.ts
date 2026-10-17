import { describe, expect, it } from "vitest";
import { encodePcm16Wav, downmixToMono } from "../../src/main/voice/live/worker/pcm-wav";

describe("encodePcm16Wav", () => {
  it("produces a valid RIFF/WAVE header for a known input", () => {
    const samples = new Int16Array([0, 100, -100, 32767, -32768]);
    const wav = encodePcm16Wav({ samples, sampleRate: 16000, channels: 1 });
    expect(wav.byteLength).toBe(44 + samples.byteLength);
    // RIFF magic
    expect(String.fromCharCode(wav[0]!, wav[1]!, wav[2]!, wav[3]!)).toBe("RIFF");
    // WAVE magic
    expect(String.fromCharCode(wav[8]!, wav[9]!, wav[10]!, wav[11]!)).toBe("WAVE");
    // fmt chunk marker
    expect(String.fromCharCode(wav[12]!, wav[13]!, wav[14]!, wav[15]!)).toBe("fmt ");
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getUint32(4, true)).toBe(36 + samples.byteLength); // file size - 8
    expect(view.getUint16(20, true)).toBe(1); // PCM format tag
    expect(view.getUint16(22, true)).toBe(1); // channels
    expect(view.getUint32(24, true)).toBe(16000); // sample rate
    expect(view.getUint32(28, true)).toBe(16000 * 1 * 2); // byte rate
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    // data chunk marker
    expect(String.fromCharCode(wav[36]!, wav[37]!, wav[38]!, wav[39]!)).toBe("data");
    expect(view.getUint32(40, true)).toBe(samples.byteLength);
    // payload round-trips
    const payload = new Int16Array(wav.buffer, wav.byteOffset + 44);
    expect(Array.from(payload)).toEqual([0, 100, -100, 32767, -32768]);
  });

  it("handles empty input", () => {
    const wav = encodePcm16Wav({ samples: new Int16Array(0), sampleRate: 24000, channels: 1 });
    expect(wav.byteLength).toBe(44);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getUint32(40, true)).toBe(0);
  });

  it("writes stereo channel count", () => {
    const samples = new Int16Array([100, 200, 300, 400]);
    const wav = encodePcm16Wav({ samples, sampleRate: 48000, channels: 2 });
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(48000);
  });
});

describe("downmixToMono", () => {
  it("returns input unchanged for mono", () => {
    const samples = new Int16Array([1, 2, 3]);
    expect(downmixToMono(samples, 1)).toBe(samples);
  });

  it("averages stereo to mono", () => {
    // L=100, R=200 → avg=150; L=-100, R=100 → avg=0
    const stereo = new Int16Array([100, 200, -100, 100]);
    const mono = downmixToMono(stereo, 2);
    expect(mono.length).toBe(2);
    expect(mono[0]).toBe(150);
    expect(mono[1]).toBe(0);
  });

  it("clamps overflow", () => {
    const stereo = new Int16Array([32767, 32767, -32768, -32768]);
    const mono = downmixToMono(stereo, 2);
    expect(mono[0]).toBe(32767);
    expect(mono[1]).toBe(-32768);
  });
});
