/**
 * Scrollback hot-path benchmark for issue #7.
 *
 * Measures the real exported functions with the exact append/trim sequence of
 * PtyManager's onData handler:
 *   BEFORE (old implementation, re-created): `${scrollback}${data}` concat +
 *     truncateScrollback on every PTY tick (O(total) copy per write).
 *   AFTER (shipped): chunk push + trimScrollbackChunks, string only joins on
 *     snapshot reads.
 *
 * Run: npx tsx scripts/bench-scrollback-chunks.mts
 */
import {
  SCROLLBACK_MAX_CHARS,
  trimScrollbackChunks,
  truncateScrollback,
} from "../src/main/terminal/pty-manager";

const CHUNK = `${"x".repeat(50)}\x1b[32mcolor\x1b[0m\r\n`; // ~60B agent-ish line

interface Result {
  writes: number;
  totalMs: number;
  usPerWrite: number;
  heapPeakMB: number;
}

function bench(label: string, writes: number, run: (data: string) => void): Result {
  for (let i = 0; i < 3; i++) run(CHUNK); // warm-up
  globalThis.gc?.();
  const heapStart = process.memoryUsage().heapUsed;
  const start = process.hrtime.bigint();
  for (let i = 0; i < writes; i++) run(CHUNK);
  const totalMs = Number(process.hrtime.bigint() - start) / 1e6;
  const heapPeakMB = (process.memoryUsage().heapUsed - heapStart) / 1024 / 1024;
  console.log(`${label}: ${writes} writes, ${totalMs.toFixed(1)} ms, ${(totalMs * 1000 / writes).toFixed(2)} us/write, heap +${heapPeakMB.toFixed(1)} MB`);
  return { writes, totalMs, usPerWrite: (totalMs * 1000) / writes, heapPeakMB };
}

// BEFORE: string concat + truncate per write (issue #7 as reported).
let scrollback = "";
// Pre-fill past the cap so every write copies the full 2M-char buffer.
scrollback = truncateScrollback(CHUNK.repeat(Math.ceil(SCROLLBACK_MAX_CHARS / CHUNK.length)));
console.log(`prefill length: ${scrollback.length} chars`);
const before = bench("BEFORE (string concat)", 5_000, (data) => {
  scrollback = truncateScrollback(`${scrollback}${data}`);
});
console.log(`post length: ${scrollback.length} chars`);

// AFTER: chunked push + in-place trim (current pty-manager onData).
const chunks: string[] = [CHUNK.repeat(Math.ceil(SCROLLBACK_MAX_CHARS / CHUNK.length))];
let length = chunks[0]!.length;
length = trimScrollbackChunks(chunks, length, SCROLLBACK_MAX_CHARS);
const after = bench("AFTER  (chunk array)  ", 5_000, (data) => {
  chunks.push(data);
  length += data.length;
  if (length > SCROLLBACK_MAX_CHARS) length = trimScrollbackChunks(chunks, length, SCROLLBACK_MAX_CHARS);
});
console.log(`post chunks: ${chunks.length}, joined length: ${chunks.join("").length}`);
console.log(`speedup: ${(before.usPerWrite / after.usPerWrite).toFixed(1)}x`);
