import { describe, expect, it } from "vitest";
import {
  buildSearchCorpus,
  clampActiveHit,
  collectMatchOffsets,
  collectNodeMatchRanges,
  messageIndexForOffset,
  nextActiveHit,
  READER_SEARCH_MAX_HITS,
} from "../../src/renderer/src/components/terminal-reader/terminal-reader-search";

describe("collectMatchOffsets", () => {
  it("empty query returns no hits", () => {
    expect(collectMatchOffsets("anything", "")).toEqual([]);
  });

  it("empty haystack returns no hits", () => {
    expect(collectMatchOffsets("", "abc")).toEqual([]);
  });

  it("case-insensitive matching", () => {
    expect(collectMatchOffsets("Error ERROR error", "error")).toEqual([0, 6, 12]);
  });

  it("non-overlapping advance", () => {
    expect(collectMatchOffsets("abab", "abab")).toEqual([0]);
    expect(collectMatchOffsets("aaaa", "aa")).toEqual([0, 2]);
  });

  it("caps at READER_SEARCH_MAX_HITS", () => {
    const result = collectMatchOffsets("x".repeat(5000), "x");
    expect(result.length).toBe(READER_SEARCH_MAX_HITS);
  });

  it("query longer than haystack returns no hits", () => {
    expect(collectMatchOffsets("ab", "abc")).toEqual([]);
  });
});

describe("buildSearchCorpus", () => {
  it("joins message text with newlines and records each message's start", () => {
    const corpus = buildSearchCorpus([{ text: "hello" }, { text: "wor ld" }, { text: "x" }]);
    expect(corpus.text).toBe("hello\nwor ld\nx");
    expect(corpus.starts).toEqual([0, 6, 13]);
  });

  it("records starts even for empty messages", () => {
    const corpus = buildSearchCorpus([{ text: "a" }, { text: "" }, { text: "b" }]);
    expect(corpus.text).toBe("a\n\nb");
    expect(corpus.starts).toEqual([0, 2, 3]);
  });

  it("empty input yields an empty corpus", () => {
    const corpus = buildSearchCorpus([]);
    expect(corpus.text).toBe("");
    expect(corpus.starts).toEqual([]);
  });
});

describe("messageIndexForOffset", () => {
  const starts = [0, 6, 13];

  it("maps a hit inside the first message", () => {
    expect(messageIndexForOffset(starts, 0)).toBe(0);
    expect(messageIndexForOffset(starts, 5)).toBe(0);
  });

  it("maps a hit inside each later message", () => {
    expect(messageIndexForOffset(starts, 6)).toBe(1);
    expect(messageIndexForOffset(starts, 9)).toBe(1);
    expect(messageIndexForOffset(starts, 13)).toBe(2);
    expect(messageIndexForOffset(starts, 20)).toBe(2);
  });

  it("clamps to the last message past the end", () => {
    expect(messageIndexForOffset(starts, 999)).toBe(2);
  });

  it("empty corpus clamps to 0", () => {
    expect(messageIndexForOffset([], 0)).toBe(0);
    expect(messageIndexForOffset([], 5)).toBe(0);
  });
});

describe("nextActiveHit", () => {
  it("wraps forward past the last hit", () => {
    expect(nextActiveHit(2, 3, "next")).toBe(0);
    expect(nextActiveHit(0, 3, "next")).toBe(1);
  });

  it("wraps backward past the first hit", () => {
    expect(nextActiveHit(0, 3, "previous")).toBe(2);
    expect(nextActiveHit(1, 3, "previous")).toBe(0);
  });

  it("returns 0 when there are no hits", () => {
    expect(nextActiveHit(5, 0, "next")).toBe(0);
    expect(nextActiveHit(5, 0, "previous")).toBe(0);
  });
});

describe("collectNodeMatchRanges (DOM-text highlight offsets)", () => {
  it("returns no ranges for an empty query", () => {
    expect(collectNodeMatchRanges(["hello"], "")).toEqual([]);
  });

  it("matches per node, case-insensitive, with node-relative offsets", () => {
    const ranges = collectNodeMatchRanges(["Error here", "no hit", "another error"], "error");
    expect(ranges).toEqual([
      { node: 0, start: 0, end: 5 },
      { node: 2, start: 8, end: 13 },
    ]);
  });

  it("finds several matches inside one node, non-overlapping", () => {
    expect(collectNodeMatchRanges(["aaaa"], "aa")).toEqual([
      { node: 0, start: 0, end: 2 },
      { node: 0, start: 2, end: 4 },
    ]);
  });

  it("matches CJK text by code units", () => {
    expect(collectNodeMatchRanges(["你好世界，你好嗎"], "你好")).toEqual([
      { node: 0, start: 0, end: 2 },
      { node: 0, start: 5, end: 7 },
    ]);
  });

  it("never invents cross-node matches (em-boundary splits stay unhighlighted)", () => {
    expect(collectNodeMatchRanges(["hel", "lo"], "hello")).toEqual([]);
  });

  it("honours the max cap", () => {
    expect(collectNodeMatchRanges(["xxxx"], "x", 2).length).toBe(2);
  });
});

describe("clampActiveHit", () => {
  it("clamps into range when the capture or query shrinks", () => {
    expect(clampActiveHit(5, 3)).toBe(2);
    expect(clampActiveHit(1, 3)).toBe(1);
  });

  it("returns 0 when there are no hits", () => {
    expect(clampActiveHit(9, 0)).toBe(0);
  });
});
