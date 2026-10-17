import { describe, expect, it } from "vitest";
import {
  SCROLLBACK_MAX_CHARS,
  trimScrollbackChunks,
  truncateScrollback,
} from "../../src/main/terminal/pty-manager";

describe("truncateScrollback", () => {
  it("returns the input unchanged when under the limit", () => {
    const input = "x".repeat(1000);
    expect(truncateScrollback(input)).toBe(input);
  });

  it("returns the input unchanged when exactly at the default limit", () => {
    const input = "x".repeat(2_000_000);
    expect(truncateScrollback(input)).toBe(input);
    expect(truncateScrollback(input).length).toBe(2_000_000);
  });

  it("truncates above the default limit", () => {
    const input = "z".repeat(2_000_100);
    expect(truncateScrollback(input).length).toBe(2_000_000);
  });

  it("truncates to <= max when a newline exists after the cut point", () => {
    // 300K chars with a newline near the end; cut = 300K - 250K = 50K.
    // indexOf("\n", 50K) finds the newline, slice starts after it.
    const input = "a".repeat(50_000) + "\n" + "b".repeat(249_999);
    const result = truncateScrollback(input, 250_000);
    expect(result.length).toBeLessThanOrEqual(250_000);
    expect(result.length).toBeGreaterThan(0);
    // After the newline, content is all "b".
    expect(result).toBe("b".repeat(249_999));
  });

  it("hard-truncates (slice to cut) when no newline is found after cut point", () => {
    // 300K chars, no newline anywhere. M5 fix: must still truncate, not skip.
    const input = "z".repeat(300_000);
    const result = truncateScrollback(input, 250_000);
    expect(result.length).toBe(250_000);
    expect(result).toBe("z".repeat(250_000));
  });

  it("hard-truncates when the only newline is before the cut point", () => {
    // Newline at position 10, well before cut=50K. indexOf("\n", 50K) = -1.
    const input = "\n".repeat(10) + "y".repeat(299_990);
    const result = truncateScrollback(input, 250_000);
    expect(result.length).toBe(250_000);
    expect(result).toBe("y".repeat(250_000));
  });

  it("respects a custom max", () => {
    const input = "x".repeat(1000);
    expect(truncateScrollback(input, 500)).toBe("x".repeat(500));
  });

  it("hard-truncates with custom max when no newline", () => {
    const input = "q".repeat(1000);
    expect(truncateScrollback(input, 300)).toBe("q".repeat(300));
  });
});

/**
 * Chunked ingest path (#7): PtyManager appends PTY data as chunks and trims in
 * place instead of re-copying the joined buffer per tick. These tests replay
 * the exact append/trim sequence from the onData handler and assert the joined
 * result matches the string-based truncateScrollback at every step.
 */
describe("chunked scrollback append + trim", () => {
  function append(chunks: string[], state: { length: number }, data: string, max: number): void {
    chunks.push(data);
    state.length += data.length;
    if (state.length > max) state.length = trimScrollbackChunks(chunks, state.length, max);
  }

  it("many small appends under the cap concatenate exactly", () => {
    const chunks: string[] = [];
    const state = { length: 0 };
    const pieces = Array.from({ length: 500 }, (_, i) => `line-${i}\r\n`);
    for (const data of pieces) append(chunks, state, data, 10_000);
    expect(chunks.join("")).toBe(pieces.join(""));
    expect(state.length).toBe(pieces.join("").length);
    expect(chunks).toHaveLength(500);
  });

  it("matches joined truncateScrollback on every step of a long mixed stream", () => {
    const max = 5_000;
    let reference = "";
    const chunks: string[] = [];
    const state = { length: 0 };
    // Deterministic PRNG so a failure is reproducible.
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 2_000; i++) {
      const size = 1 + Math.floor(rand() * 40);
      let data = "";
      for (let j = 0; j < size; j++) {
        data += rand() < 0.05 ? "\n" : String.fromCharCode(97 + Math.floor(rand() * 26));
      }
      reference = truncateScrollback(reference + data, max);
      append(chunks, state, data, max);
      expect(chunks.join("")).toBe(reference);
      expect(chunks.reduce((sum, chunk) => sum + chunk.length, 0)).toBe(state.length);
    }
    expect(reference.length).toBeLessThanOrEqual(max);
  });

  it("matches the hard cut when the stream has no newlines", () => {
    const max = 2_000;
    let reference = "";
    const chunks: string[] = [];
    const state = { length: 0 };
    for (let i = 0; i < 200; i++) {
      const data = "z".repeat(50);
      reference = truncateScrollback(reference + data, max);
      append(chunks, state, data, max);
      expect(chunks.join("")).toBe(reference);
    }
    expect(state.length).toBe(max);
  });

  it("default cap constant stays at 2M chars", () => {
    expect(SCROLLBACK_MAX_CHARS).toBe(2_000_000);
  });
});
