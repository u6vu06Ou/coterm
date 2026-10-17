import { describe, expect, it } from "vitest";
import { cwdBasename, marqueeDurationSeconds, resolveDisplayTitle, resolvePaneDisplayTitle, resolveSemanticSessionSummary, shouldMarqueeSessionSummary, shortCwd, tabDisplayMode } from "../../src/renderer/src/components/terminal-display-title";

const agentInfo = { isAgent: true, profile: "pwsh", cwd: "D:\\workspace\\sync_party", title: "sync_party" } as const;

describe("cwdBasename", () => {
  it("normalizes Windows separators and trailing slashes", () => {
    expect(cwdBasename("D:\\workspace\\sync_party")).toBe("sync_party");
    expect(cwdBasename("D:/workspace/sync_party/")).toBe("sync_party");
    expect(cwdBasename("")).toBe(null);
  });
});

describe("shortCwd", () => {
  it("keeps shallow paths whole and abbreviates deeper trees to parent/leaf", () => {
    expect(shortCwd("D:\\workspace")).toBe("D:/workspace");
    expect(shortCwd("D:\\workspace\\app")).toBe("…/workspace/app");
    expect(shortCwd("D:\\projects\\workspace\\app")).toBe("…/workspace/app");
    expect(shortCwd("/")).toBe(null);
    expect(shortCwd(null)).toBe(null);
  });
});

describe("tabDisplayMode", () => {
  // Mirrors the container-query breakpoints in styles.css: >= 120 full,
  // 80-119 compact (cwd hidden), < 80 minimal (lamp + number only).
  it("walks the three width steps with the exact breakpoints", () => {
    expect(tabDisplayMode(119.9)).toBe("compact");
    expect(tabDisplayMode(120)).toBe("full");
    expect(tabDisplayMode(79.9)).toBe("minimal");
    expect(tabDisplayMode(80)).toBe("compact");
  });

  it("is monotonic across the whole range", () => {
    expect(tabDisplayMode(0)).toBe("minimal");
    expect(tabDisplayMode(30)).toBe("minimal");
    expect(tabDisplayMode(100)).toBe("compact");
    expect(tabDisplayMode(240)).toBe("full");
  });
});

describe("resolveDisplayTitle", () => {
  it("treats a title equal to the cwd basename as no summary", () => {
    expect(resolveDisplayTitle(agentInfo, null)).toBe(null);
    expect(resolveDisplayTitle({ ...agentInfo, cwd: "D:\\workspace\\sync_party\\" }, null)).toBe(null);
    expect(resolveDisplayTitle({ ...agentInfo, cwd: "D:/workspace/sync_party" }, "sync_party")).toBe(null);
  });

  it("shows a real summary", () => {
    expect(resolveDisplayTitle({ ...agentInfo, title: "Fixing auth bug" }, null)).toBe("Fixing auth bug");
  });

  it("prefers the live session title over the persisted one", () => {
    expect(resolveDisplayTitle(agentInfo, "Live summary")).toBe("Live summary");
  });

  it("prefers Codex's generated task title over its cwd-only OSC title", () => {
    expect(resolveDisplayTitle({ ...agentInfo, agentSummaryTitle: "Explain the llm-tools codebase" }, "sync_party"))
      .toBe("Explain the llm-tools codebase");
    expect(resolvePaneDisplayTitle(
      { ...agentInfo, agentSummaryTitle: "Explain the llm-tools codebase" },
      "sync_party",
      "我在檢查 config 的細節。",
      true,
    )).toBe("Explain the llm-tools codebase");
  });

  it("rejects an agentSummaryTitle equal to the cwd basename or shell default", () => {
    expect(resolveDisplayTitle({ ...agentInfo, agentSummaryTitle: "sync_party" }, "Live summary")).toBe("Live summary");
    expect(resolveDisplayTitle({ ...agentInfo, agentSummaryTitle: "PowerShell" }, "Live summary")).toBe("Live summary");
    expect(resolveDisplayTitle({ ...agentInfo, agentSummaryTitle: "sync_party" }, null)).toBe(null);
  });

  it("shows nothing for non-agent tiles and shell defaults", () => {
    expect(resolveDisplayTitle({ ...agentInfo, isAgent: false, title: "Real" }, null)).toBe(null);
    expect(resolveDisplayTitle({ ...agentInfo, profile: "pwsh", title: "PowerShell" }, null)).toBe(null);
  });
});

describe("resolvePaneDisplayTitle", () => {
  it("lets the native OSC title win over the semantic projection", () => {
    expect(resolvePaneDisplayTitle(
      { ...agentInfo, title: "Fixing auth bug" },
      null,
      "我在檢查 config 的細節——這裡八成是舊設定殘留。",
      true,
    )).toBe("Fixing auth bug");
  });

  it("uses the semantic projection only as fallback on the active agent tile", () => {
    expect(resolvePaneDisplayTitle(agentInfo, null, "Doing things", true)).toBe("Doing things");
    expect(resolvePaneDisplayTitle(agentInfo, null, "Doing things", false)).toBe(null);
    expect(resolvePaneDisplayTitle({ ...agentInfo, isAgent: false }, null, "Doing things", true)).toBe(null);
  });

  // v1.5.19 shipped a claude-/codex- early return that accepted ONLY
  // agentSummaryTitle, which blanked the amber header for every Claude pane
  // (Claude Code publishes its summary through OSC 0, not that field).
  it("keeps the Claude OSC title as the header summary", () => {
    const claude = { ...agentInfo, agentProfile: "claude-official" as const, title: "Fixing the IME scroll lock" };
    expect(resolvePaneDisplayTitle(claude, null, "semantic fallback", true)).toBe("Fixing the IME scroll lock");
    expect(resolvePaneDisplayTitle(claude, "Live summary", "semantic fallback", true)).toBe("Live summary");
    expect(resolvePaneDisplayTitle({ ...claude, agentSummaryTitle: "Provider summary" }, "Live summary", "semantic fallback", true))
      .toBe("Provider summary");
  });

  it("still refuses a Codex OSC title that is only the cwd basename", () => {
    const codex = { ...agentInfo, agentProfile: "codex-official" as const, title: "sync_party" };
    expect(resolvePaneDisplayTitle(codex, null, null, true)).toBeNull();
    expect(resolvePaneDisplayTitle({ ...codex, agentSummaryTitle: "Generated task title" }, null, null, true))
      .toBe("Generated task title");
  });
});

describe("resolveSemanticSessionSummary", () => {
  it("prefers the active task summary and compacts whitespace", () => {
    expect(resolveSemanticSessionSummary({
      terminalId: "t1",
      identity: { harness: "codex-cli", backend: "openai", model: null, profile: "codex-official" },
      task: { summary: "Fix   mobile\nPTY pan", phase: "running", source: "screen-fallback", confidence: 0.45 },
      lastTurn: { status: "completed", summary: "older", finalText: null, completedAt: null, source: "native-transcript", confidence: 0.8 },
      pendingInteraction: null,
      updatedAt: "2026-08-15T00:00:00.000Z",
    })).toBe("Fix mobile PTY pan");
  });
});

describe("shouldMarqueeSessionSummary", () => {
  const base = { mobile: true, active: true, overflowPx: 120, inViewport: true, documentVisible: true, reducedMotion: false };

  it("runs only for an overflowing active mobile summary", () => {
    expect(shouldMarqueeSessionSummary(base)).toBe(true);
    expect(shouldMarqueeSessionSummary({ ...base, mobile: false })).toBe(false);
    expect(shouldMarqueeSessionSummary({ ...base, active: false })).toBe(false);
    expect(shouldMarqueeSessionSummary({ ...base, overflowPx: 0 })).toBe(false);
  });

  it("pauses offscreen, hidden, and reduced-motion summaries", () => {
    expect(shouldMarqueeSessionSummary({ ...base, inViewport: false })).toBe(false);
    expect(shouldMarqueeSessionSummary({ ...base, documentVisible: false })).toBe(false);
    expect(shouldMarqueeSessionSummary({ ...base, reducedMotion: true })).toBe(false);
  });
});

describe("marqueeDurationSeconds", () => {
  it("scales with distance at a fixed readable speed", () => {
    // Longer recap -> longer pass, never faster. The old header marquee was a
    // flat 8s regardless of length, which made long recaps unreadable.
    expect(marqueeDurationSeconds(2200)).toBeGreaterThan(marqueeDurationSeconds(600));
    expect(marqueeDurationSeconds(600)).toBeGreaterThan(marqueeDurationSeconds(200));
  });

  it("clamps both ends so it creeps rather than flicks or stalls", () => {
    expect(marqueeDurationSeconds(0)).toBe(6);
    expect(marqueeDurationSeconds(10)).toBe(6);
    expect(marqueeDurationSeconds(1_000_000)).toBe(60);
  });

  it("keeps a reading pace of about 5.5 characters per second", () => {
    // 13px font -> ~71 px/s; 700px of overflow is ~10s of motion plus holds.
    expect(marqueeDurationSeconds(700, 13)).toBeGreaterThanOrEqual(11);
    expect(marqueeDurationSeconds(700, 13)).toBeLessThanOrEqual(13);
    // a larger font scrolls proportionally faster in px/s
    expect(marqueeDurationSeconds(700, 16)).toBeLessThan(marqueeDurationSeconds(700, 13));
  });
});
