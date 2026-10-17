// Pure helpers for the reader's search box (Ctrl+F over the conversation view).
// Extracted from the overlay so offset collection + hit→message location are
// unit-testable without a DOM (vitest runs in the node environment). The
// terminal's own Ctrl+F overlay (terminal-search-key.ts) covers the xterm
// buffer; this one covers the transcript messages the conversation reader
// renders.

// Bounds how many matches are collected per keystroke. The corpus is the whole
// conversation text, and an unbounded query like a single space could produce
// 100k hits — the cap keeps the count display and memory flat no matter what
// the user types.
export const READER_SEARCH_MAX_HITS = 2000;

// Case-insensitive, non-overlapping match offsets. Searching re-scans the
// corpus per keystroke (~1ms per MB) — cheap enough that no debounce and no
// indexing is needed.
export function collectMatchOffsets(text: string, query: string): number[] {
  if (!query) return [];
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const out: number[] = [];
  let from = 0;
  while (out.length < READER_SEARCH_MAX_HITS && from <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    out.push(idx);
    from = idx + needle.length;
  }
  return out;
}

// Searchable corpus over the conversation the reader currently shows: each
// message's text joined with a newline, plus each message's start offset so a
// hit offset maps back to the message node to scroll to.
export interface ReaderSearchCorpus {
  text: string;
  starts: number[];
}

export function buildSearchCorpus(messages: ReadonlyArray<{ text: string }>): ReaderSearchCorpus {
  const parts: string[] = [];
  const starts: number[] = [];
  let cursor = 0;
  for (const message of messages) {
    const text = message.text ?? "";
    starts.push(cursor);
    parts.push(text);
    cursor += text.length + 1; // +1 for the joining "\n"
  }
  return { text: parts.join("\n"), starts };
}

// Message index for a hit offset: the last message whose start is <= offset.
// Offsets before the first message (impossible; starts[0] === 0) clamp to 0.
export function messageIndexForOffset(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  let found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const start = starts[mid] ?? 0;
    if (start <= offset) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

// Clamp + wrap the active hit after a corpus change or a navigation step.
export function nextActiveHit(active: number, total: number, direction: "next" | "previous"): number {
  if (total <= 0) return 0;
  return direction === "next"
    ? (active + 1) % total
    : (active - 1 + total) % total;
}

// Keep the displayed position in range when the corpus shrinks (refresh) or
// the query tightens while the active index is still held over.
export function clampActiveHit(active: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(active, total - 1);
}
