import { describe, expect, it } from "vitest";
import {
  clampReaderFontSize,
  keepFinalTurnOutputs,
  pinchReaderFontSize,
  stepReaderFontSize,
  terminalReaderController,
} from "../../src/renderer/src/components/terminal-reader/terminal-reader-state";
import type { TerminalTranscriptMessage } from "@shared/types";

describe("terminal reader state", () => {
  it("clamps reader font without changing PTY settings", () => {
    expect(clampReaderFontSize(2)).toBe(12);
    expect(clampReaderFontSize(99)).toBe(32);
  });
  it("A-/A+ step in visible jumps and pinch follows finger spread", () => {
    expect(stepReaderFontSize(16, 1)).toBe(18);
    expect(stepReaderFontSize(17, -1)).toBe(16);
    expect(stepReaderFontSize(32, 1)).toBe(32);
    expect(stepReaderFontSize(12, -1)).toBe(12);
    expect(pinchReaderFontSize(16, 100, 150)).toBe(24);
    expect(pinchReaderFontSize(16, 100, 10)).toBe(12);
    expect(pinchReaderFontSize(16, 0, 50)).toBe(16);
  });
  it("keeps open and font state per terminal", () => {
    terminalReaderController.resetForTest();
    terminalReaderController.toggle("a");
    terminalReaderController.adjustFont("a", 4);
    expect(terminalReaderController.get("a")).toMatchObject({ open: true, fontSize: 20 });
    expect(terminalReaderController.get("b").open).toBe(false);
  });
  it("closes and resets the font per terminal", () => {
    terminalReaderController.resetForTest();
    terminalReaderController.toggle("a");
    terminalReaderController.stepFont("a", 1);
    expect(terminalReaderController.get("a").fontSize).toBe(18);
    terminalReaderController.resetFont("a");
    expect(terminalReaderController.get("a").fontSize).toBe(16);
    terminalReaderController.close("a");
    expect(terminalReaderController.get("a").open).toBe(false);
  });

  it("openWithSearch opens the reader with a one-shot search request", () => {
    terminalReaderController.resetForTest();
    expect(terminalReaderController.get("a").searchRequest).toBeNull();
    terminalReaderController.openWithSearch("a", "needle");
    const state = terminalReaderController.get("a");
    expect(state.open).toBe(true);
    expect(state.searchRequest).toMatchObject({ query: "needle" });
  });

  it("search requests are consumed once and close clears a pending one", () => {
    terminalReaderController.resetForTest();
    terminalReaderController.openWithSearch("a", "one");
    const first = terminalReaderController.get("a").searchRequest;
    terminalReaderController.openWithSearch("a", "two");
    const second = terminalReaderController.get("a").searchRequest;
    // A newer request supersedes the old (ascending nonce), so a stale
    // request reference can never reopen an old query.
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.nonce).toBeGreaterThan(first!.nonce);
    expect(second!.query).toBe("two");
    terminalReaderController.clearSearchRequest("a");
    expect(terminalReaderController.get("a").searchRequest).toBeNull();
    expect(terminalReaderController.get("a").open).toBe(true);
    terminalReaderController.openWithSearch("a", "three");
    terminalReaderController.close("a");
    expect(terminalReaderController.get("a").open).toBe(false);
    expect(terminalReaderController.get("a").searchRequest).toBeNull();
  });
});

describe("keepFinalTurnOutputs", () => {
  const msg = (role: "user" | "assistant" | "system", text: string, id: string): TerminalTranscriptMessage => ({
    id,
    role,
    kind: "message",
    text,
    timestamp: null,
    provider: "claude",
    model: null,
  });

  it("keeps all user messages and only the last assistant of each run", () => {
    // user → a1,a2,a3 → user → a4  ⇒  user, a3, user, a4
    const input = [
      msg("user", "q1", "u1"),
      msg("assistant", "a1", "a1"),
      msg("assistant", "a2", "a2"),
      msg("assistant", "a3", "a3"),
      msg("user", "q2", "u2"),
      msg("assistant", "a4", "a4"),
    ];
    const out = keepFinalTurnOutputs(input);
    expect(out.map((m) => m.id)).toEqual(["u1", "a3", "u2", "a4"]);
  });

  it("keeps every turn-ending reply when injected user turns were dropped", () => {
    // q1 → a1(tool) a2(end) a3(end, reply to a dropped notification) a4(in progress)
    const end = (id: string): TerminalTranscriptMessage => ({ ...msg("assistant", id, id), endsTurn: true });
    const input = [msg("user", "q1", "u1"), msg("assistant", "a1", "a1"), end("a2"), end("a3"), msg("assistant", "a4", "a4")];
    expect(keepFinalTurnOutputs(input).map((m) => m.id)).toEqual(["u1", "a2", "a3", "a4"]);
  });

  it("preserves system and notice messages", () => {
    const sys: TerminalTranscriptMessage = { id: "s1", role: "system", kind: "notice", text: "sys", timestamp: null };
    const input = [sys, msg("assistant", "a1", "a1"), msg("assistant", "a2", "a2")];
    const out = keepFinalTurnOutputs(input);
    expect(out.map((m) => m.id)).toEqual(["s1", "a2"]);
  });

  it("returns an empty array unchanged", () => {
    expect(keepFinalTurnOutputs([])).toEqual([]);
  });

  it("keeps a lone assistant message", () => {
    const input = [msg("assistant", "solo", "x")];
    expect(keepFinalTurnOutputs(input).map((m) => m.id)).toEqual(["x"]);
  });

  it("prefers a turn_summary over same-run commentary (Codex final answers)", () => {
    const summary: TerminalTranscriptMessage = { id: "sum", role: "assistant", kind: "turn_summary", text: "done", timestamp: null, provider: "codex" };
    const input = [
      msg("user", "q1", "u1"),
      msg("assistant", "commentary 1", "c1"),
      msg("assistant", "commentary 2", "c2"),
      summary,
      msg("user", "q2", "u2"),
      // A run without any summary falls back to the last-message heuristic.
      msg("assistant", "only chunks", "c3"),
    ];
    const out = keepFinalTurnOutputs(input);
    expect(out.map((m) => m.id)).toEqual(["u1", "sum", "u2", "c3"]);
  });
});
