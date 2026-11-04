import { describe, expect, it } from "vitest";
import type { ProjectHistorySession } from "../../src/shared/types";
import {
  isTransientWorkingTitle,
  openTileDisplayTitle,
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

describe("open tile display title", () => {
  it("prefers the pane header's real summary over raw OSC title", () => {
    expect(
      openTileDisplayTitle(
        { title: "Working", cwd: "D:/project" },
        "檢查npm申請與Gmail",
        "terminal-1",
      ),
    ).toBe("檢查npm申請與Gmail");
  });

  it("does not persist the transient working state as a title", () => {
    expect(isTransientWorkingTitle("Working")).toBe(true);
    expect(isTransientWorkingTitle("Thinking…")).toBe(true);
    expect(isTransientWorkingTitle("檢查npm申請與Gmail")).toBe(false);
    expect(
      openTileDisplayTitle({ title: "Working", cwd: "D:/project" }, "Working", "terminal-1"),
    ).toBe("project");
    expect(
      openTileDisplayTitle({ title: "Working", cwd: null as unknown as string }, null, "terminal-1234"),
    ).toBe("pty 1234");
  });
});

describe("open tile display title — junk guard (header/sidebar parity)", () => {
  const statusLine = "⚠parallel-guard: agents 2/20 (all sessions)…";
  const separator = "─".repeat(40) + "…";

  it("never shows status-line text or a separator rule as the row name", () => {
    // Junk in the pane-header summary event AND in the raw OSC title must both
    // fall through to the cwd basename — never to the junk.
    expect(openTileDisplayTitle({ title: statusLine, cwd: "D:/project" }, statusLine, "t-1")).toBe("project");
    expect(openTileDisplayTitle({ title: separator, cwd: "D:/project" }, null, "t-1")).toBe("project");
    expect(openTileDisplayTitle({ title: separator, cwd: "D:/project" }, separator, "t-1")).toBe("project");
  });

  it("resolves the same summary the pane header resolved (claude and claude-team)", () => {
    // The header strips the ✳ marker before dispatching coterm:session-summary;
    // the sidebar must show exactly that text, not re-derive something else.
    const headerSummary = "本地的翻譯 app (meet-translator) 現在可以用了";
    expect(openTileDisplayTitle({ title: "claude", cwd: "D:/project" }, headerSummary, "t-1")).toBe(headerSummary);
    expect(openTileDisplayTitle({ title: "PowerShell", cwd: "D:/project" }, headerSummary, "t-1")).toBe(headerSummary);
    // If the event is missing but the OSC title is real, the sidebar still
    // matches what the header's info.title fallback would show.
    expect(openTileDisplayTitle({ title: "Fixing auth bug", cwd: "D:/project" }, null, "t-1")).toBe("Fixing auth bug");
    // A marker-prefixed OSC title is shown stripped, same as the header.
    expect(openTileDisplayTitle({ title: "✳ Fixing auth bug", cwd: "D:/project" }, null, "t-1")).toBe("Fixing auth bug");
  });

  it("provider placeholders fall through to cwd instead of persisting as the name", () => {
    expect(openTileDisplayTitle({ title: "◐ Claude Code", cwd: "D:/project" }, null, "t-1")).toBe("project");
    expect(openTileDisplayTitle({ title: "claude", cwd: "D:/project" }, null, "t-1")).toBe("project");
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
