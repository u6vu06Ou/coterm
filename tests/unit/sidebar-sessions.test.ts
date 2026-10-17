import { describe, expect, it } from "vitest";
import type { ProjectHistorySession } from "../../src/shared/types";
import {
  parseSessionDragPayload,
  parseSessionGroupDragPayload,
  planGroupOpen,
  resumableSessions,
} from "../../src/renderer/src/components/sidebar-sessions";

function history(overrides: Partial<ProjectHistorySession>): ProjectHistorySession {
  return {
    source: "coterm",
    providerSessionId: "ps1",
    conversationId: "c1",
    projectId: "p1",
    conversationName: "conv",
    profileId: "claude-local-main",
    nativeSessionId: "sid-1",
    historyKey: null,
    sizeBytes: null,
    status: "idle",
    summary: null,
    tokenTotals: null,
    conversationUpdatedAt: "2026-09-22T00:00:00.000Z",
    sessionUpdatedAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

describe("resumableSessions", () => {
  it("keeps only sessions with a native id on a resume-capable profile", () => {
    const sessions = [
      history({ nativeSessionId: "a" }),
      history({ nativeSessionId: null }),
      history({ profileId: "gemini", nativeSessionId: "g" }),
      history({ profileId: "claude-local-big", nativeSessionId: "old" }),
      history({ profileId: "codex-local-main", nativeSessionId: "b" }),
    ];
    expect(resumableSessions(sessions)).toEqual([
      { profileId: "claude-local-main", nativeSessionId: "a" },
      { profileId: "codex-local-main", nativeSessionId: "b" },
    ]);
  });
});

describe("drag payload parsing", () => {
  it("round-trips a single session payload", () => {
    const payload = { projectId: "p", profileId: "claude-local-main", nativeSessionId: "s" };
    expect(parseSessionDragPayload(JSON.stringify(payload))).toEqual(payload);
  });

  it("rejects malformed single payloads", () => {
    expect(parseSessionDragPayload("not json")).toBeNull();
    expect(parseSessionDragPayload("{}")).toBeNull();
    expect(parseSessionDragPayload(JSON.stringify({ projectId: "p", profileId: "x" }))).toBeNull();
  });

  it("round-trips a group payload and skips poisoned entries", () => {
    const data = {
      projectId: "p",
      sessions: [
        { profileId: "claude-local-main", nativeSessionId: "a" },
        { profileId: "claude-local-main" }, // missing id — dropped, group survives
        { profileId: "codex-local-main", nativeSessionId: "b" },
      ],
    };
    expect(parseSessionGroupDragPayload(JSON.stringify(data))).toEqual({
      projectId: "p",
      sessions: [
        { profileId: "claude-local-main", nativeSessionId: "a" },
        { profileId: "codex-local-main", nativeSessionId: "b" },
      ],
    });
  });

  it("rejects groups with no usable session", () => {
    expect(parseSessionGroupDragPayload(JSON.stringify({ projectId: "p", sessions: [{}] }))).toBeNull();
    expect(parseSessionGroupDragPayload("")).toBeNull();
  });
});

describe("planGroupOpen", () => {
  const items = ["a", "b", "c", "d"].map((nativeSessionId) => ({ profileId: "claude-local-main", nativeSessionId }));

  it("opens everything when nothing is open and slots are free", () => {
    const plan = planGroupOpen(items, new Set(), 8);
    expect(plan.toOpen.map((s) => s.nativeSessionId)).toEqual(["a", "b", "c", "d"]);
    expect(plan.focusNativeId).toBeNull();
  });

  it("never re-opens a live session and focuses it when nothing opened (rule #3)", () => {
    const plan = planGroupOpen(items, new Set(["a", "c"]), 8);
    expect(plan.toOpen.map((s) => s.nativeSessionId)).toEqual(["b", "d"]);
    expect(plan.focusNativeId).toBe("a");

    const allLive = planGroupOpen(items, new Set(["a", "b", "c", "d"]), 8);
    expect(allLive.toOpen).toEqual([]);
    expect(allLive.focusNativeId).toBe("a");
  });

  it("respects the dock's free-slot cap, overflowing tail is skipped", () => {
    const plan = planGroupOpen(items, new Set(), 2);
    expect(plan.toOpen.map((s) => s.nativeSessionId)).toEqual(["a", "b"]);
    expect(plan.focusNativeId).toBeNull();
  });

  it("still focuses a live session when the dock is full", () => {
    const plan = planGroupOpen(items, new Set(["c"]), 0);
    expect(plan.toOpen).toEqual([]);
    expect(plan.focusNativeId).toBe("c");
  });
});
