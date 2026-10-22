import { describe, expect, it } from "vitest";
import { mergeTranscriptMessages, transcriptMessageEqual } from "../../src/renderer/src/components/terminal-reader/terminal-reader-merge";
import type { TerminalTranscriptMessage } from "@shared/types";

function msg(id: string, text: string, role: TerminalTranscriptMessage["role"] = "assistant"): TerminalTranscriptMessage {
  return { id, role, text, timestamp: null };
}

describe("mergeTranscriptMessages", () => {
  it("returns the previous array reference when nothing changed (no-op refresh)", () => {
    const previous = [msg("a", "hello"), msg("b", "world", "user")];
    // A refetch rebuilds fresh objects with identical content.
    const next = [msg("a", "hello"), msg("b", "world", "user")];
    const merged = mergeTranscriptMessages(previous, next);
    expect(merged).toBe(previous);
  });

  it("appends new messages while keeping old object references (no remount)", () => {
    const previous = [msg("a", "hello"), msg("b", "world", "user")];
    const next = [msg("a", "hello"), msg("b", "world", "user"), msg("c", "new tail")];
    const merged = mergeTranscriptMessages(previous, next);
    expect(merged).not.toBe(previous);
    expect(merged).toHaveLength(3);
    expect(merged[0]).toBe(previous[0]);
    expect(merged[1]).toBe(previous[1]);
    expect(merged[2]).toBe(next[2]);
  });

  it("swaps in new objects only for messages whose content actually changed", () => {
    const previous = [msg("a", "old"), msg("b", "same", "user")];
    const next = [msg("a", "edited"), msg("b", "same", "user")];
    const merged = mergeTranscriptMessages(previous, next);
    expect(merged[0]).toBe(next[0]);
    expect(merged[0]?.text).toBe("edited");
    expect(merged[1]).toBe(previous[1]);
  });

  it("keeps stable references across a full replacement with same ids (session hop refetch)", () => {
    const previous = [msg("a", "one"), msg("b", "two", "user")];
    const next = [msg("a", "one"), msg("b", "two", "user"), msg("c", "three")];
    // previous[1] shifts out of position in the merged view? Order is kept, so
    // identity comes from the id match.
    const merged = mergeTranscriptMessages(previous, next);
    expect(merged[0]).toBe(previous[0]);
    expect(merged[1]).toBe(previous[1]);
  });

  it("matches positionally when messages carry no ids (legacy fixtures)", () => {
    const previous: TerminalTranscriptMessage[] = [{ role: "user", text: "hi", timestamp: null }];
    const next: TerminalTranscriptMessage[] = [
      { role: "user", text: "hi", timestamp: null },
      { role: "assistant", text: "yo", timestamp: null },
    ];
    const merged = mergeTranscriptMessages(previous, next);
    expect(merged[0]).toBe(previous[0]);
    expect(merged[1]).toBe(next[1]);
  });

  it("does not return previous when order changed", () => {
    const previous = [msg("a", "1"), msg("b", "2")];
    const next = [msg("b", "2"), msg("a", "1")];
    const merged = mergeTranscriptMessages(previous, next);
    expect(merged).not.toBe(previous);
    // Objects still reused by id — only the order is new.
    expect(merged[0]).toBe(previous[1]);
    expect(merged[1]).toBe(previous[0]);
  });
});

describe("transcriptMessageEqual", () => {
  it("treats kind/endsTurn differences as changes", () => {
    const a = msg("a", "same");
    const b: TerminalTranscriptMessage = { ...a, kind: "turn_summary" };
    expect(transcriptMessageEqual(a, b)).toBe(false);
    const c: TerminalTranscriptMessage = { ...a, endsTurn: true };
    expect(transcriptMessageEqual(a, c)).toBe(false);
  });
});
