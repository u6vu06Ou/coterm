import { describe, expect, it } from "vitest";
import { encodeWav, PcmRingBuffer, computeRms, PREVIEW_SAMPLE_COUNT, PREVIEW_SAMPLE_RATE } from "../../src/renderer/src/components/voice/wav-encoder";

describe("encodeWav", () => {
  it("produces a valid WAV header for 16kHz mono", () => {
    const samples = new Float32Array(1600); // 100ms
    const buf = encodeWav(samples, PREVIEW_SAMPLE_RATE);
    const view = new DataView(buf);
    // RIFF header
    expect(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))).toBe("RIFF");
    expect(String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11))).toBe("WAVE");
    // fmt chunk
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(PREVIEW_SAMPLE_RATE);
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    // data chunk size
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
    // Total size = 44 header + 3200 data
    expect(buf.byteLength).toBe(44 + samples.length * 2);
  });

  it("clamps samples to [-1, 1] range", () => {
    const samples = new Float32Array([2.0, -2.0, 0.5]);
    const buf = encodeWav(samples, PREVIEW_SAMPLE_RATE);
    const view = new DataView(buf);
    // 2.0 → 0x7fff (32767), -2.0 → 0x8000 (-32768)
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
    expect(view.getInt16(48, true)).toBe(Math.floor(0.5 * 32767));
  });
});

describe("PcmRingBuffer", () => {
  it("appends and extracts tail samples", () => {
    const ring = new PcmRingBuffer(100);
    ring.append(new Float32Array([1, 2, 3, 4, 5]));
    expect(ring.length).toBe(5);
    const tail = ring.tail(3);
    expect(Array.from(tail)).toEqual([3, 4, 5]);
  });

  it("wraps around when buffer is full", () => {
    const ring = new PcmRingBuffer(5);
    ring.append(new Float32Array([1, 2, 3, 4, 5]));
    ring.append(new Float32Array([6, 7]));
    expect(ring.length).toBe(5);
    // Last 5 samples: 3,4,5,6,7
    const all = ring.all();
    expect(Array.from(all)).toEqual([3, 4, 5, 6, 7]);
  });

  it("handles chunks larger than capacity", () => {
    const ring = new PcmRingBuffer(3);
    ring.append(new Float32Array([1, 2, 3, 4, 5, 6]));
    expect(ring.length).toBe(3);
    expect(Array.from(ring.all())).toEqual([4, 5, 6]);
  });

  it("returns empty for zero-length tail", () => {
    const ring = new PcmRingBuffer(10);
    expect(ring.tail(5).length).toBe(0);
    expect(ring.all().length).toBe(0);
  });

  it("clears correctly", () => {
    const ring = new PcmRingBuffer(10);
    ring.append(new Float32Array([1, 2, 3]));
    ring.clear();
    expect(ring.length).toBe(0);
    expect(ring.all().length).toBe(0);
  });

  it("default capacity matches preview sample count", () => {
    const ring = new PcmRingBuffer();
    expect(ring.capacity).toBe(PREVIEW_SAMPLE_COUNT);
  });
});

describe("computeRms", () => {
  it("returns 0 for empty buffer", () => {
    expect(computeRms(new Float32Array(0))).toBe(0);
  });

  it("computes RMS correctly", () => {
    const samples = new Float32Array([0.5, -0.5, 0.5, -0.5]);
    const rms = computeRms(samples);
    expect(rms).toBeCloseTo(0.5, 5);
  });

  it("returns 0 for silence", () => {
    const samples = new Float32Array(100);
    expect(computeRms(samples)).toBe(0);
  });
});
