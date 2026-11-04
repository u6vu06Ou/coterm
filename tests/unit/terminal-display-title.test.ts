import { describe, expect, it } from "vitest";
import { cleanSessionTitle, cwdBasename, isJunkSessionTitle, isPlaceholderSessionTitle, marqueeDurationSeconds, resolveDisplayTitle, resolvePaneDisplayTitle, resolveSemanticSessionSummary, shouldMarqueeSessionSummary, shortCwd, tabDisplayMode } from "../../src/renderer/src/components/terminal-display-title";

const agentInfo = { isAgent: true, profile: "pwsh", cwd: "D:\\workspace\\sync_party", title: "sync_party" } as const;

describe("isPlaceholderSessionTitle", () => {
  it("refuses provider markers but keeps real summaries", () => {
    expect(isPlaceholderSessionTitle("◐ Claude Code")).toBe(true);
    expect(isPlaceholderSessionTitle("✳ Claude Code")).toBe(true);
    expect(isPlaceholderSessionTitle("⠧ Claude Code")).toBe(true);
    expect(isPlaceholderSessionTitle("claude")).toBe(true);
    expect(isPlaceholderSessionTitle("CLAUDE")).toBe(true);
    // Star prefix on the bare form (not just on "Claude Code").
    expect(isPlaceholderSessionTitle("✳ claude")).toBe(true);
    // Launcher shim spellings and a spinner-only frame carry no information.
    expect(isPlaceholderSessionTitle("claude.cmd")).toBe(true);
    expect(isPlaceholderSessionTitle("Claude.exe")).toBe(true);
    expect(isPlaceholderSessionTitle("⠧")).toBe(true);
    expect(isPlaceholderSessionTitle("Fixing auth bug")).toBe(false);
    expect(isPlaceholderSessionTitle("claude-team")).toBe(false);
    expect(isPlaceholderSessionTitle(null)).toBe(false);
    expect(isPlaceholderSessionTitle("   ")).toBe(true);
  });

  // Documented trade-off: a project or task literally named "Claude" can never
  // be the summary — the same rule the cwd-basename filter already applies.
  it("is case-insensitive on purpose", () => {
    expect(isPlaceholderSessionTitle("cLaUdE")).toBe(true);
  });
});

describe("isJunkSessionTitle", () => {
  it("rejects status-line / hook chrome", () => {
    expect(isJunkSessionTitle("⚠parallel-guard: agents 2/20 (all sessions)…")).toBe(true);
    expect(isJunkSessionTitle("⚠ team-guard: spawn denied")).toBe(true);
    expect(isJunkSessionTitle("parallel-guard: agents 0/20")).toBe(true);
    expect(isJunkSessionTitle("team-guard: busy")).toBe(true);
  });

  it("rejects separator rules and pure decoration", () => {
    expect(isJunkSessionTitle("─".repeat(24))).toBe(true);
    expect(isJunkSessionTitle("—".repeat(40) + "…")).toBe(true);
    expect(isJunkSessionTitle("═══════")).toBe(true);
    expect(isJunkSessionTitle("* * *")).toBe(true);
    expect(isJunkSessionTitle("────────── done ──────────")).toBe(true); // separator-majority
    expect(isJunkSessionTitle("── note ──")).toBe(true); // spaces join the runs: rule with a label is still a rule
    expect(isJunkSessionTitle("──── 80% ────")).toBe(true);
  });

  it("does not shoot down short real titles over a couple of separator chars", () => {
    // Below the minimum length, or with dots/underscores (not separators):
    // "__init__", "a==b", "Fix..." must all keep passing.
    expect(isJunkSessionTitle("a==b")).toBe(false);
    expect(isJunkSessionTitle("__init__")).toBe(false);
    expect(isJunkSessionTitle("Fix...")).toBe(false);
    expect(isJunkSessionTitle("Fix team-guard: allow concurrent runs")).toBe(false);
  });

  it("rejects placeholders and empties, keeps real summaries", () => {
    expect(isJunkSessionTitle("◐ Claude Code")).toBe(true);
    expect(isJunkSessionTitle("claude")).toBe(true);
    expect(isJunkSessionTitle("")).toBe(true);
    expect(isJunkSessionTitle(null)).toBe(true);
    expect(isJunkSessionTitle("本地的翻譯 app (meet-translator) 現在可以用了")).toBe(false);
    expect(isJunkSessionTitle("Fixing auth bug in login.ts")).toBe(false);
    // A guard NAME mentioned in prose is fine — only the "name:" status form is junk.
    expect(isJunkSessionTitle("修 team-guard 擋下 spawn 的誤判")).toBe(false);
  });

  // 2026-11-04 claude-team regression: with no native ai-title the header fell
  // through to the screen projection, which surfaced Claude Code's status line
  // as the "session summary". These lines are CLI chrome, never a summary.
  it("rejects Claude Code status-line / footer chrome", () => {
    // The exact live-clobbered string from the bug report.
    expect(isJunkSessionTitle(
      "Opus 5.5 | .../workspace/3jsfloder | 69k/1000k (7%) | proxy ▸▸ bypass permissions on (shift+tab to cycle)",
    )).toBe(true);
    // Each ingredient alone is chrome too.
    expect(isJunkSessionTitle("proxy ▸▸ bypass permissions on (shift+tab to cycle)")).toBe(true);
    expect(isJunkSessionTitle("⏵⏵ accept edits on")).toBe(true);
    expect(isJunkSessionTitle("69k/1000k (7%)")).toBe(true);
    expect(isJunkSessionTitle("esc to interrupt")).toBe(true);
    expect(isJunkSessionTitle("? for shortcuts")).toBe(true);
    expect(isJunkSessionTitle("Opus 5.5 | .../workspace/3jsfloder | 69k/1000k (7%)")).toBe(true);
  });

  it("rejects the claude-team roster rows", () => {
    expect(isJunkSessionTitle("● main")).toBe(true);
    expect(isJunkSessionTitle("○ beta-mate")).toBe(true);
    expect(isJunkSessionTitle("○ gamma-mate")).toBe(true);
    // …and the marker strip must not resurrect a roster row as the bare word.
    expect(cleanSessionTitle("● main")).toBe(null);
    expect(cleanSessionTitle("○ beta-mate")).toBe(null);
    // Bullets whose text is NOT a roster name stay prose.
    expect(isJunkSessionTitle("● 完成度 80%，剩下收尾")).toBe(false);
  });

  it("keeps prose that merely mentions adjacent words", () => {
    // Real session summaries that use similar vocabulary must survive.
    expect(isJunkSessionTitle("權限模式調整與審核流程")).toBe(false);
    expect(isJunkSessionTitle("Write the keyboard shortcuts doc")).toBe(false);
    expect(isJunkSessionTitle("Token usage report for October")).toBe(false);
  });
});

describe("cleanSessionTitle", () => {
  it("strips spinner/marker frames and refuses junk", () => {
    expect(cleanSessionTitle("✳ 本地的翻譯 app")).toBe("本地的翻譯 app");
    expect(cleanSessionTitle("✳ ✳ Fixing")).toBe("Fixing"); // repeated marker frames strip in one pass
    expect(cleanSessionTitle("⠂ Fixing the pane header")).toBe("Fixing the pane header");
    expect(cleanSessionTitle("◐ Claude Code")).toBe(null);
    expect(cleanSessionTitle("⚠parallel-guard: agents 2/20")).toBe(null);
    expect(cleanSessionTitle("─".repeat(12))).toBe(null);
    expect(cleanSessionTitle(null)).toBe(null);
  });
});

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

  // 2026-11-04 regression: Claude Code's status line and TUI separator rules
  // used to be accepted as the session summary.
  it("rejects status-line text and separator rules from every candidate", () => {
    const junk = "⚠parallel-guard: agents 2/20 (all sessions)…";
    expect(resolveDisplayTitle({ ...agentInfo, title: junk }, null)).toBe(null);
    expect(resolveDisplayTitle({ ...agentInfo, title: "─".repeat(30) }, null)).toBe(null);
    // Junk from the live stream must not shadow a good persisted title.
    expect(resolveDisplayTitle({ ...agentInfo, title: "Real summary" }, junk)).toBe("Real summary");
    // …and junk NEVER passes through even when nothing else exists.
    expect(resolveDisplayTitle({ ...agentInfo, title: "sync_party" }, "─".repeat(10))).toBe(null);
  });

  it("accepts a real Claude Code OSC summary for claude and claude-team panes", () => {
    const summary = "✳ 本地的翻譯 app (meet-translator) 現在可以用了";
    const claude = { ...agentInfo, agentProfile: "claude-official" as const, title: "PowerShell" };
    const team = { ...agentInfo, agentProfile: "claude-team" as const, title: "PowerShell" };
    // Marker glyph is stripped before display.
    expect(resolveDisplayTitle(claude, summary)).toBe("本地的翻譯 app (meet-translator) 現在可以用了");
    expect(resolveDisplayTitle(team, summary)).toBe("本地的翻譯 app (meet-translator) 現在可以用了");
    expect(resolvePaneDisplayTitle(team, summary, "semantic fallback"))
      .toBe("本地的翻譯 app (meet-translator) 現在可以用了");
  });
});

describe("resolvePaneDisplayTitle", () => {
  it("lets the native OSC title win over the semantic projection", () => {
    expect(resolvePaneDisplayTitle(
      { ...agentInfo, title: "Fixing auth bug" },
      null,
      "我在檢查 config 的細節——這裡八成是舊設定殘留。",
    )).toBe("Fixing auth bug");
  });

  it("uses the semantic projection as fallback for every agent tile", () => {
    // Not gated on the selected tile: claude-team panes have no native title at
    // all, so an active-only fallback left the tab strip and the unselected
    // tiles showing the placeholder while only the selected pane was readable.
    expect(resolvePaneDisplayTitle(agentInfo, null, "Doing things")).toBe("Doing things");
    expect(resolvePaneDisplayTitle({ ...agentInfo, isAgent: false }, null, "Doing things")).toBe(null);
  });

  // v1.5.19 shipped a claude-/codex- early return that accepted ONLY
  // agentSummaryTitle, which blanked the amber header for every Claude pane
  // (Claude Code publishes its summary through OSC 0, not that field).
  it("keeps the Claude OSC title as the header summary", () => {
    const claude = { ...agentInfo, agentProfile: "claude-official" as const, title: "Fixing the IME scroll lock" };
    expect(resolvePaneDisplayTitle(claude, null, "semantic fallback")).toBe("Fixing the IME scroll lock");
    expect(resolvePaneDisplayTitle(claude, "Live summary", "semantic fallback")).toBe("Live summary");
    expect(resolvePaneDisplayTitle({ ...claude, agentSummaryTitle: "Provider summary" }, "Live summary", "semantic fallback"))
      .toBe("Provider summary");
  });

  it("still refuses a Codex OSC title that is only the cwd basename", () => {
    const codex = { ...agentInfo, agentProfile: "codex-official" as const, title: "sync_party" };
    expect(resolvePaneDisplayTitle(codex, null, null)).toBeNull();
    expect(resolvePaneDisplayTitle({ ...codex, agentSummaryTitle: "Generated task title" }, null, null))
      .toBe("Generated task title");
  });

  // Regression: claude-team panes emit only "◐ Claude Code" spinner frames plus
  // one transient bare "claude" stamped by the npm launcher shim, and never a
  // work summary. Both are placeholders, so the header and the top-bar tab used
  // to read the literal word "claude" instead of falling through to a real
  // summary source.
  it("treats Claude's placeholder and shim titles as no summary for claude-team", () => {
    const team = { ...agentInfo, agentProfile: "claude-team" as const, title: "claude" };
    expect(resolveDisplayTitle(team, null)).toBeNull();
    expect(resolveDisplayTitle(team, "claude")).toBeNull();
    expect(resolveDisplayTitle(team, "◐ Claude Code")).toBeNull();
    expect(resolveDisplayTitle(team, "⠧ Claude Code")).toBeNull();
    // …and the semantic projection supplies the readable line instead.
    expect(resolvePaneDisplayTitle(team, null, "修正 claude-team 表頭摘要"))
      .toBe("修正 claude-team 表頭摘要");
    // A real Claude OSC work summary still wins when one does arrive.
    expect(resolveDisplayTitle(team, "Fixing the pane header summary")).toBe("Fixing the pane header summary");
  });
});

describe("resolveSemanticSessionSummary junk guard", () => {
  const stateWith = (task: string | null, lastTurn: string | null) => ({
    terminalId: "t1",
    identity: { harness: "claude-code" as const, backend: "anthropic" as const, model: null, profile: "claude-team" },
    task: { summary: task, phase: "running", source: "screen-fallback" as const, confidence: 0.45 },
    lastTurn: { status: "completed" as const, summary: lastTurn, finalText: null, completedAt: null, source: "screen-fallback" as const, confidence: 0.5 },
    pendingInteraction: null,
    updatedAt: "2026-11-04T00:00:00.000Z",
  });

  it("rejects the screen-fallback status line and separator rules", () => {
    expect(resolveSemanticSessionSummary(stateWith("⚠parallel-guard: agents 2/20 (all sessions)…", null))).toBe(null);
    expect(resolveSemanticSessionSummary(stateWith("─".repeat(30), null))).toBe(null);
    // A junk task summary falls through to a real last-turn summary.
    expect(resolveSemanticSessionSummary(stateWith(null, "⚠ team-guard: busy"))).toBe(null);
  });

  it("keeps a real screen-derived summary", () => {
    expect(resolveSemanticSessionSummary(stateWith("修正 claude-team 表頭摘要", null)))
      .toBe("修正 claude-team 表頭摘要");
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
    expect(marqueeDurationSeconds(0)).toBe(4.8);
    expect(marqueeDurationSeconds(10)).toBe(4.8);
    expect(marqueeDurationSeconds(1_000_000)).toBe(60);
  });

  it("runs about 25 percent faster while keeping a font-relative reading pace", () => {
    // 13px font -> ~89 px/s; 700px of overflow takes about 10s including holds.
    expect(marqueeDurationSeconds(700, 13)).toBe(10);
    expect(marqueeDurationSeconds(2200, 20)).toBe(20);
    // a larger font scrolls proportionally faster in px/s
    expect(marqueeDurationSeconds(700, 16)).toBeLessThan(marqueeDurationSeconds(700, 13));
  });
});
