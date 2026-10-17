// Unit tests for the agent-detection core (issue §8).
//
// All fixtures are clean-room: synthesized ConPTY byte sequences authored from
// Coterm's own AGENT_FALLBACK_PATTERNS (pty-manager.ts) and observed Claude
// Code / Codex prompt shapes. No third-party fixture is copied.
//
// Vitest fake timers drive both the 50ms coalesce window and xterm headless's
// internal setTimeout(0) write pump deterministically.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentDetectionEngine,
  profileFamily,
  VtSnapshot,
  evaluate,
  evaluateGates,
  sortRules,
  extractRegion,
  extractBottomNonEmpty,
  extractAfterLastHorizontalRule,
  extractPromptBoxBody,
  capRegion,
  MAX_REGION_CHARS,
  MAX_SNAPSHOT_LINES,
  validateRulePatterns,
  manifestSchema,
  type BufferSnapshot,
  type Manifest,
  type Rule,
} from "../../src/main/terminal/agent-detection";
import { ManifestLoader } from "../../src/main/terminal/agent-detection/manifest-loader";
import { bundledClaudeCodeManifest } from "../../src/main/terminal/agent-detection/manifests/claude-code";
import { bundledCodexManifest } from "../../src/main/terminal/agent-detection/manifests/codex";
import * as fs from "node:fs";

const ESC = "\x1b";
const BEL = "\x07";

// OSC 0 title sequence: \x1b]0;TITLE\x07
function oscTitle(title: string): string {
  return `${ESC}]0;${title}${BEL}`;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for filesystem reload");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Drive a VtSnapshot by writing chunks then reading the snapshot. xterm
// headless pumps writes through setTimeout(0), so under fake timers we must
// advance timers to flush the write queue before reading buffer.active.
async function writeAndSnapshot(vt: VtSnapshot, chunks: string[]): Promise<BufferSnapshot> {
  for (const chunk of chunks) {
    vt.write(chunk);
  }
  // Flush xterm's internal write pump (it schedules via setTimeout).
  await vi.advanceTimersByTimeAsync(0);
  return vt.snapshot();
}

describe("VtSnapshot — VT emulation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("\\r overwrites the same line (spinner)", async () => {
    const vt = new VtSnapshot(40, 5);
    const snap = await writeAndSnapshot(vt, ["line1\rspin-A", "\rspin-B"]);
    expect(snap.lines[0]).toBe("spin-B");
    vt.dispose();
  });

  it("CSI K erase-line clears the line", async () => {
    const vt = new VtSnapshot(40, 5);
    const snap = await writeAndSnapshot(vt, ["abc\r\x1b[Kdef"]);
    expect(snap.lines[0]).toBe("def");
    vt.dispose();
  });

  it("CSI cursor move + redraw does not duplicate lines", async () => {
    const vt = new VtSnapshot(40, 5);
    // Move cursor up one line and redraw — append-only ring would duplicate.
    const snap = await writeAndSnapshot(vt, ["row1\nrow2\x1b[1A\rROW1"]);
    expect(snap.lines).toContain("ROW1");
    expect(snap.lines.filter((l) => l === "row1")).toHaveLength(0);
    vt.dispose();
  });

  it("alternate screen enter/exit restores normal buffer", async () => {
    const vt = new VtSnapshot(40, 5);
    const snap = await writeAndSnapshot(vt, [
      "normal-content",
      "\x1b[?1049h",
      "ALTSCREEN",
      "\x1b[?1049l",
    ]);
    // After exiting alt screen, the normal buffer content is restored.
    expect(snap.lines.some((l) => l.includes("normal-content"))).toBe(true);
    expect(snap.lines.some((l) => l.includes("ALTSCREEN"))).toBe(false);
    vt.dispose();
  });

  it("OSC 0 title is captured", async () => {
    const vt = new VtSnapshot(40, 5);
    const snap = await writeAndSnapshot(vt, [oscTitle("⠋ claude"), "output"]);
    expect(snap.title).toBe("⠋ claude");
    vt.dispose();
  });

  it("scrollback is bounded (<= 200)", async () => {
    const vt = new VtSnapshot(40, 5);
    // Write 500 short lines; only the last ~200 + viewport should remain.
    const chunks: string[] = [];
    for (let i = 0; i < 500; i++) chunks.push(`l${i}\n`);
    const snap = await writeAndSnapshot(vt, chunks);
    // The snapshot itself is capped at MAX_SNAPSHOT_LINES.
    expect(snap.lines.length).toBeLessThanOrEqual(MAX_SNAPSHOT_LINES);
    // The most recent line should be present (short enough not to wrap at 40 cols).
    expect(snap.lines.some((l) => l.includes("l499"))).toBe(true);
    vt.dispose();
  });

  it("snapshot is bounded to <= 80 lines and <= 16K chars", async () => {
    const vt = new VtSnapshot(100, 5);
    const chunks: string[] = [];
    // Write 300 wide lines.
    for (let i = 0; i < 300; i++) chunks.push("x".repeat(100) + "\n");
    const snap = await writeAndSnapshot(vt, chunks);
    expect(snap.lines.length).toBeLessThanOrEqual(MAX_SNAPSHOT_LINES);
    const total = snap.lines.join("\n").length;
    expect(total).toBeLessThanOrEqual(16384);
    vt.dispose();
  });

  it("resize updates cols/rows", async () => {
    const vt = new VtSnapshot(40, 5);
    vt.resize(80, 24);
    // No throw + snapshot still works.
    const snap = await writeAndSnapshot(vt, ["hi"]);
    expect(snap.lines[0]).toBe("hi");
    vt.dispose();
  });

  it("dispose releases the VT (no late reads)", () => {
    const vt = new VtSnapshot(40, 5);
    vt.dispose();
    // Calling dispose again is a no-op.
    expect(() => vt.dispose()).not.toThrow();
  });
});

describe("regions — pure extractors", () => {
  const snap = (lines: string[], title = ""): BufferSnapshot => ({ lines, title });

  it("bottom_non_empty skips trailing empty lines", () => {
    expect(extractBottomNonEmpty(snap(["a", "", "b", "", ""]), 3)).toBe("a\nb");
  });

  it("after_last_horizontal_rule returns text below the last rule", () => {
    const lines = ["top", "────────", "permission body", "esc to cancel"];
    expect(extractAfterLastHorizontalRule(snap(lines))).toContain("esc to cancel");
    expect(extractAfterLastHorizontalRule(snap(lines))).not.toContain("top");
  });

  it("after_last_horizontal_rule falls back to whole when no rule", () => {
    const lines = ["just", "text"];
    expect(extractAfterLastHorizontalRule(snap(lines))).toContain("just");
  });

  it("osc_title returns the title", () => {
    expect(extractRegion(snap([], "⠋ working"), "osc_title")).toBe("⠋ working");
  });

  it("prompt_box_body extracts between box corners", () => {
    const lines = ["┌────┐", "Allow?", "Yes/No", "└────┘"];
    const body = extractPromptBoxBody(snap(lines));
    expect(body).toContain("Allow?");
    expect(body).toContain("Yes/No");
  });

  it("prompt_box_body falls back to bottom_non_empty when no box", () => {
    const lines = ["no", "box", "here"];
    expect(extractPromptBoxBody(snap(lines))).toContain("here");
  });

  it("whole_recent returns all lines", () => {
    expect(extractRegion(snap(["a", "b", "c"]), "whole_recent")).toBe("a\nb\nc");
  });

  it("capRegion truncates to MAX_REGION_CHARS keeping the tail", () => {
    const big = "x".repeat(MAX_REGION_CHARS + 100);
    const capped = capRegion(big);
    expect(capped.length).toBe(MAX_REGION_CHARS);
    expect(capped.endsWith("x")).toBe(true);
  });
});

describe("rule-engine — gates, priority, tie, determinism", () => {
  const rule = (id: string, priority: number, opts: Partial<Rule> = {}): Rule => ({
    id,
    state: "done",
    priority,
    region: "bottom_non_empty",
    profile: "claude-code",
    ...opts,
  });

  it("all gate: every contains must match", () => {
    const r = rule("r1", 100, { all: [{ contains: ["foo"] }, { contains: ["bar"] }] });
    expect(evaluateGates(r, "foo bar").allPassed).toBe(true);
    expect(evaluateGates(r, "foo only").allPassed).toBe(false);
  });

  it("any gate: at least one must match", () => {
    const r = rule("r1", 100, { any: [{ contains: ["a"] }, { contains: ["b"] }] });
    expect(evaluateGates(r, "has b").anyPassed).toBe(true);
    expect(evaluateGates(r, "neither").anyPassed).toBe(false);
  });

  it("none gate: no pattern may match", () => {
    const r = rule("r1", 100, { none: [{ contains: ["forbidden"] }] });
    expect(evaluateGates(r, "clean text").nonePassed).toBe(true);
    expect(evaluateGates(r, "has forbidden word").nonePassed).toBe(false);
  });

  it("absent gates are vacuously true", () => {
    const r = rule("r1", 100);
    const g = evaluateGates(r, "anything");
    expect(g.allPassed && g.anyPassed && g.nonePassed).toBe(true);
  });

  it("regex pattern matches", () => {
    const r = rule("r1", 100, { all: [{ regex: "^Error:", flags: "im" }] });
    expect(evaluateGates(r, "Error: boom").allPassed).toBe(true);
    expect(evaluateGates(r, "no error here").allPassed).toBe(false);
  });

  it("any-group alternative matches", () => {
    const r = rule("r1", 100, {
      all: [{ any: [{ contains: ["Yes"] }, { contains: ["No"] }] }],
    });
    expect(evaluateGates(r, "Yes").allPassed).toBe(true);
    expect(evaluateGates(r, "No").allPassed).toBe(true);
    expect(evaluateGates(r, "Maybe").allPassed).toBe(false);
  });

  it("sortRules: priority DESC then id ASC", () => {
    const rules = [
      rule("b", 100),
      rule("a", 100),
      rule("c", 200),
    ];
    const sorted = sortRules(rules);
    expect(sorted.map((r) => r.id)).toEqual(["c", "a", "b"]);
  });

  it("evaluate returns the highest-priority passing rule", () => {
    const manifest: Manifest = {
      profile: "claude-code",
      version: "1.0.0",
      rules: [
        rule("low", 100, { all: [{ contains: ["x"] }] }),
        rule("high", 900, { all: [{ contains: ["x"] }] }),
      ],
    };
    const result = evaluate({ lines: ["x"], title: "" }, manifest);
    expect(result?.ruleId).toBe("high");
  });

  it("evaluate tie-breaks by id lexicographic", () => {
    const manifest: Manifest = {
      profile: "claude-code",
      version: "1.0.0",
      rules: [
        rule("zzz", 100, { all: [{ contains: ["x"] }] }),
        rule("aaa", 100, { all: [{ contains: ["x"] }] }),
      ],
    };
    const result = evaluate({ lines: ["x"], title: "" }, manifest);
    expect(result?.ruleId).toBe("aaa");
  });

  it("evaluate is deterministic (same input → same output)", () => {
    const manifest: Manifest = {
      profile: "claude-code",
      version: "1.0.0",
      rules: [
        rule("a", 100, { all: [{ contains: ["x"] }] }),
        rule("b", 200, { all: [{ contains: ["y"] }] }),
      ],
    };
    const snap: BufferSnapshot = { lines: ["x", "y"], title: "" };
    const r1 = evaluate(snap, manifest);
    const r2 = evaluate(snap, manifest);
    expect(r1).toEqual(r2);
  });

  it("evaluate returns null when no rule passes", () => {
    const manifest: Manifest = {
      profile: "claude-code",
      version: "1.0.0",
      rules: [rule("a", 100, { all: [{ contains: ["zzz"] }] })],
    };
    expect(evaluate({ lines: ["no match"], title: "" }, manifest)).toBeNull();
  });
});

describe("bundled manifests — coverage per family", () => {
  it("claude-code: approval panel matches", () => {
    const lines = [
      "────────",
      "Do you want to run the command?",
      "Yes  No",
      "esc to cancel",
    ];
    const result = evaluate({ lines, title: "" }, bundledClaudeCodeManifest);
    expect(result?.state).toBe("approval_required");
    expect(result?.ruleId).toBe("claude_approval_panel");
  });

  it("claude-code: working spinner in title", () => {
    const result = evaluate({ lines: [""], title: "⠋ claude" }, bundledClaudeCodeManifest);
    expect(result?.state).toBe("running");
    expect(result?.ruleId).toBe("claude_working_title_spinner");
  });

  it("claude-code: done prompt marker", () => {
    const result = evaluate({ lines: ["> "], title: "" }, bundledClaudeCodeManifest);
    expect(result?.state).toBe("done");
    expect(result?.ruleId).toBe("claude_done_prompt");
  });

  it("claude-code: waiting input (Enter to select)", () => {
    const result = evaluate({ lines: ["Enter to select"], title: "" }, bundledClaudeCodeManifest);
    expect(result?.state).toBe("waiting_input");
  });

  it("claude-code: explicit blocked", () => {
    const result = evaluate({ lines: ["Blocked: waiting for lock"], title: "" }, bundledClaudeCodeManifest);
    expect(result?.state).toBe("blocked");
  });

  it("claude-code: an Error: stderr line is NOT classified as an error state", () => {
    // Issue #25: stderr banners from cargo/node/tests legitimately start with
    // "Error:"; screen rules must not file error states. A truly fatal error
    // exits the process and is filed by the process source instead.
    const result = evaluate({ lines: ["Error: something failed"], title: "" }, bundledClaudeCodeManifest);
    expect(result?.state ?? null).not.toBe("error");
  });

  it("claude-code: Esc/Ctrl+C recovery → done", () => {
    const result = evaluate({ lines: ["Interrupted by user"], title: "" }, bundledClaudeCodeManifest);
    expect(result?.state).toBe("done");
    expect(result?.ruleId).toBe("claude_interrupted_recovery");
  });

  it("codex: approval prompt matches", () => {
    const result = evaluate({ lines: ["Do you want to proceed? (y/n)"], title: "" }, bundledCodexManifest);
    expect(result?.state).toBe("approval_required");
  });

  it("codex: done prompt marker (codex>)", () => {
    const result = evaluate({ lines: ["codex> "], title: "" }, bundledCodexManifest);
    expect(result?.state).toBe("done");
  });

  it("codex: working title (Thinking)", () => {
    const result = evaluate({ lines: [""], title: "Thinking…" }, bundledCodexManifest);
    expect(result?.state).toBe("running");
  });
});

describe("false positives — code/prose must not trigger", () => {
  it("source code with 'Error:' inside a code block stays prompt-ready", () => {
    // No screen rule files error at all (issue #25); the done prompt matches
    // the trailing >.
    const lines = ["```typescript", "throw new Error:('boom')", "```", "> "];
    const result = evaluate({ lines, title: "" }, bundledClaudeCodeManifest);
    expect(result?.state).toBe("done");
    expect(result?.ruleId).toBe("claude_done_prompt");
  });

  it("prose containing 'allow' mid-sentence does not match approval", () => {
    // "allow" lowercase mid-sentence without Yes/No/esc-to-cancel → no approval.
    const lines = ["We allow users to configure this.", "> "];
    const result = evaluate({ lines, title: "" }, bundledClaudeCodeManifest);
    expect(result?.state).toBe("done");
  });

  it("source code with 'Blocked' in a comment does not match blocked", () => {
    const lines = ["```", "// Blocked: TODO fix", "```", "codex> "];
    const result = evaluate({ lines, title: "" }, bundledCodexManifest);
    expect(result?.state).toBe("done");
  });

  it("ordinary prose containing capitalized attention words stays prompt-ready", () => {
    const claude = evaluate({
      lines: ["The status field is Blocked when validation fails.", "> "],
      title: "",
    }, bundledClaudeCodeManifest);
    const codex = evaluate({
      lines: ["This example says Enter to select but is explanatory prose.", "codex> "],
      title: "Working directory — docs",
    }, bundledCodexManifest);
    expect(claude?.ruleId).toBe("claude_done_prompt");
    expect(codex?.ruleId).toBe("codex_done_prompt");
  });
});

describe("manifest-loader — guards and fail-closed", () => {
  it("rejects backreference regex", () => {
    const rule: Rule = {
      id: "bad",
      state: "done",
      priority: 100,
      region: "bottom_non_empty",
      all: [{ regex: "(a)\\1", flags: "" }],
      profile: "claude-code",
    };
    expect(validateRulePatterns(rule).ok).toBe(false);
  });

  it("rejects nested quantifier (a+)+", () => {
    const rule: Rule = {
      id: "bad",
      state: "done",
      priority: 100,
      region: "bottom_non_empty",
      all: [{ regex: "(a+)+", flags: "" }],
      profile: "claude-code",
    };
    expect(validateRulePatterns(rule).ok).toBe(false);
  });

  it("rejects disallowed regex flags", () => {
    const rule: Rule = {
      id: "bad",
      state: "done",
      priority: 100,
      region: "bottom_non_empty",
      all: [{ regex: "a", flags: "g" }],
      profile: "claude-code",
    };
    expect(validateRulePatterns(rule).ok).toBe(false);
  });

  it("rejects duplicate flags and syntactically invalid regex", () => {
    const duplicate: Rule = {
      id: "bad-duplicate",
      state: "done",
      priority: 100,
      region: "bottom_non_empty",
      all: [{ regex: "ok", flags: "ii" }],
      profile: "claude-code",
    };
    const invalid: Rule = {
      ...duplicate,
      id: "bad-syntax",
      all: [{ regex: "(", flags: "i" }],
    };
    expect(validateRulePatterns(duplicate).ok).toBe(false);
    expect(validateRulePatterns(invalid).ok).toBe(false);
  });

  it("rejects ambiguous or nested quantified groups", () => {
    const makeRule = (regex: string): Rule => ({
      id: "bad-redos",
      state: "done",
      priority: 100,
      region: "bottom_non_empty",
      all: [{ regex, flags: "" }],
      profile: "claude-code",
    });
    expect(validateRulePatterns(makeRule("(a|aa)+$")).ok).toBe(false);
    expect(validateRulePatterns(makeRule("(a{1,3})+")).ok).toBe(false);
    expect(validateRulePatterns(makeRule("a{1,3}{2}")).ok).toBe(false);
  });

  it("rejects oversized pattern (>256 chars)", () => {
    const rule: Rule = {
      id: "bad",
      state: "done",
      priority: 100,
      region: "bottom_non_empty",
      all: [{ contains: ["x".repeat(257)] }],
      profile: "claude-code",
    };
    expect(validateRulePatterns(rule).ok).toBe(false);
  });

  it("accepts a valid rule", () => {
    const rule: Rule = {
      id: "good",
      state: "done",
      priority: 100,
      region: "bottom_non_empty",
      all: [{ contains: ["ok"] }, { regex: "^x", flags: "im" }],
      none: [{ contains: ["bad"] }],
      profile: "claude-code",
    };
    expect(validateRulePatterns(rule).ok).toBe(true);
  });

  it("rejects explanation-visible ids or versions that are not safe metadata", () => {
    const unsafe = {
      profile: "claude-code",
      version: "secret prompt text",
      rules: [{
        id: "raw prompt: approve secret",
        state: "done",
        priority: 1,
        region: "bottom_non_empty",
        all: [{ contains: ["x"] }],
        profile: "claude-code",
      }],
    };
    expect(manifestSchema.safeParse(unsafe).success).toBe(false);
  });

  it("loads bundled manifests without userDataPath", () => {
    const loader = new ManifestLoader();
    const result = loader.load();
    expect(result.warning).toBeNull();
    expect(result.manifests.get("claude-code")).toBeDefined();
    expect(result.manifests.get("codex")).toBeDefined();
    loader.dispose();
  });
});

describe("AgentDetectionEngine — public contract", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ingest across chunks still matches (VT accumulates)", async () => {
    const candidates: Array<{ id: string; state: string }> = [];
    const engine = new AgentDetectionEngine({
      evaluationDelayMs: 50,
      onCandidate: (id, c) => candidates.push({ id, state: c.state }),
    });
    await engine.start();
    engine.trackTerminal({ terminalId: "t1", agentProfile: "claude-local-main", cols: 80, rows: 24 });
    // Split the approval panel across two chunks.
    engine.ingest("t1", "────────\nDo you want to run?");
    engine.ingest("t1", "\nYes  No\nesc to cancel");
    // Advance past xterm write pump (0ms) + coalesce (50ms).
    await vi.advanceTimersByTimeAsync(60);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.state).toBe("approval_required");
    engine.dispose();
  });

  it("\\r spinner overwrite: final state wins", async () => {
    const candidates: Array<{ state: string }> = [];
    const engine = new AgentDetectionEngine({
      evaluationDelayMs: 50,
      onCandidate: (_id, c) => candidates.push({ state: c.state }),
    });
    await engine.start();
    engine.trackTerminal({ terminalId: "t1", agentProfile: "claude-local-main", cols: 80, rows: 24 });
    // Spinner frames overwrite the same line via \r in the OSC title.
    engine.ingest("t1", oscTitle("⠋ claude"));
    engine.ingest("t1", oscTitle("⠙ claude"));
    await vi.advanceTimersByTimeAsync(60);
    expect(candidates[0]?.state).toBe("running");
    engine.dispose();
  });

  it("CSI erase/redraw: permission panel redraws correctly", async () => {
    const candidates: Array<{ state: string }> = [];
    const engine = new AgentDetectionEngine({
      evaluationDelayMs: 50,
      onCandidate: (_id, c) => candidates.push({ state: c.state }),
    });
    await engine.start();
    engine.trackTerminal({ terminalId: "t1", agentProfile: "claude-local-main", cols: 80, rows: 24 });
    // Draw a panel, then erase and redraw with esc-to-cancel.
    engine.ingest("t1", "────────\nDo you want to run?\nYes  No");
    engine.ingest("t1", "\r\x1b[Kesc to cancel");
    await vi.advanceTimersByTimeAsync(60);
    expect(candidates[0]?.state).toBe("approval_required");
    engine.dispose();
  });

  it("alternate screen: TUI does not leak into normal buffer", async () => {
    const candidates: Array<{ state: string }> = [];
    const engine = new AgentDetectionEngine({
      evaluationDelayMs: 50,
      onCandidate: (_id, c) => candidates.push({ state: c.state }),
    });
    await engine.start();
    engine.trackTerminal({ terminalId: "t1", agentProfile: "claude-local-main", cols: 80, rows: 24 });
    // Enter alt screen, draw, exit, then show a done prompt.
    engine.ingest("t1", "\x1b[?1049h");
    engine.ingest("t1", "ALTSCREEN TUI");
    engine.ingest("t1", "\x1b[?1049l");
    engine.ingest("t1", "> ");
    await vi.advanceTimersByTimeAsync(60);
    expect(candidates[0]?.state).toBe("done");
    engine.dispose();
  });

  it("issue #13: getScreenText caches the current ?1049h frame; a full repaint replaces it", async () => {
    const engine = new AgentDetectionEngine({ evaluationDelayMs: 50 });
    await engine.start();
    engine.trackTerminal({ terminalId: "t1", agentProfile: "claude-local-main", cols: 80, rows: 24 });
    // Full-screen TUI: enter alt screen and paint one coherent frame.
    engine.ingest("t1", "\x1b[?1049h");
    engine.ingest("t1", "\x1b[2J\x1b[HFIRST FRAME\nstatus: working");
    await vi.advanceTimersByTimeAsync(60);
    expect(engine.getScreenText("t1")).toContain("FIRST FRAME");

    // Full-repaint redraw (the CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT pattern):
    // the cached text moves to the current frame, no byte history accrues.
    engine.ingest("t1", "\x1b[2J\x1b[HSECOND FRAME\nstatus: done");
    await vi.advanceTimersByTimeAsync(60);
    const cached = engine.getScreenText("t1");
    expect(cached).toContain("SECOND FRAME");
    expect(cached).not.toContain("FIRST FRAME");
    // Cache stays bounded no matter how much repaint traffic passed.
    expect((cached ?? "").length).toBeLessThanOrEqual(16_384);
    engine.dispose();
  });

  it("issue #13: getScreenText is null for untracked terminals", async () => {
    const engine = new AgentDetectionEngine();
    await engine.start();
    expect(engine.getScreenText("never-tracked")).toBeNull();
    engine.trackTerminal({ terminalId: "t1", agentProfile: "claude-local-main", cols: 80, rows: 24 });
    engine.ingest("t1", "hello");
    await vi.advanceTimersByTimeAsync(60);
    engine.untrack("t1");
    expect(engine.getScreenText("t1")).toBeNull();
    engine.dispose();
  });

  it("onCandidate only fires after a rule match (no false emit)", async () => {
    const candidates: string[] = [];
    const engine = new AgentDetectionEngine({
      evaluationDelayMs: 50,
      onCandidate: (id) => candidates.push(id),
    });
    await engine.start();
    engine.trackTerminal({ terminalId: "t1", agentProfile: "claude-local-main", cols: 80, rows: 24 });
    // Ordinary output that matches no rule.
    engine.ingest("t1", "just some ordinary agent output\n");
    await vi.advanceTimersByTimeAsync(60);
    expect(candidates).toHaveLength(0);
    engine.dispose();
  });

  it("untrack prevents late callback", async () => {
    const candidates: string[] = [];
    const engine = new AgentDetectionEngine({
      evaluationDelayMs: 50,
      onCandidate: (id) => candidates.push(id),
    });
    await engine.start();
    engine.trackTerminal({ terminalId: "t1", agentProfile: "claude-local-main", cols: 80, rows: 24 });
    engine.ingest("t1", "────────\nDo you want to run?\nYes  No\nesc to cancel");
    // Untrack before the coalesce timer fires.
    engine.untrack("t1");
    await vi.advanceTimersByTimeAsync(60);
    expect(candidates).toHaveLength(0);
    engine.dispose();
  });

  it("updateProfile changes the family", async () => {
    const engine = new AgentDetectionEngine();
    await engine.start();
    engine.trackTerminal({ terminalId: "t1", agentProfile: "claude-local-main", cols: 80, rows: 24 });
    engine.updateProfile("t1", "codex-local-main");
    // No throw + still tracked.
    expect(engine.getTrackedCountForTests()).toBe(1);
    engine.dispose();
  });

  it("recordFallback surfaces in explanation", async () => {
    const engine = new AgentDetectionEngine();
    await engine.start();
    engine.trackTerminal({ terminalId: "t1", agentProfile: "claude-local-main", cols: 80, rows: 24 });
    engine.recordFallback("t1", "quiet_timer_done");
    const expl = engine.getExplanation("t1", "done", "heuristic");
    expect(expl.fallbackReason).toBe("quiet_timer_done");
    expect(expl.agentProfile).toBe("claude-local-main");
    expect(expl.matchedRuleId).toBeNull();
    engine.dispose();
  });

  it("match and fallback metadata are mutually exclusive", async () => {
    const engine = new AgentDetectionEngine({ evaluationDelayMs: 50 });
    await engine.start();
    engine.trackTerminal({ terminalId: "t1", agentProfile: "claude-local-main", cols: 80, rows: 24 });
    engine.recordFallback("t1", "heuristic:running");
    engine.ingest("t1", "────────\nDo you want to run?\nYes  No\nesc to cancel");
    await vi.advanceTimersByTimeAsync(60);
    expect(engine.getExplanation("t1", "approval_required", "screen")).toMatchObject({
      matchedRuleId: "claude_approval_panel",
      fallbackReason: null,
    });
    engine.recordFallback("t1", "provider:blocked");
    expect(engine.getExplanation("t1", "blocked", "provider")).toMatchObject({
      matchedRuleId: null,
      fallbackReason: "provider:blocked",
      evaluatedRegion: null,
      gateSummary: null,
      manifestVersion: null,
    });
    engine.dispose();
  });

  it("the same prompt retriggers after an intervening no-match", async () => {
    const candidates: string[] = [];
    const engine = new AgentDetectionEngine({
      evaluationDelayMs: 50,
      onCandidate: (_id, candidate) => candidates.push(candidate.matchedRuleId),
    });
    await engine.start();
    engine.trackTerminal({ terminalId: "t1", agentProfile: "claude-local-main", cols: 80, rows: 24 });
    const panel = "────────\nDo you want to run?\nYes  No\nesc to cancel";
    engine.ingest("t1", panel);
    await vi.advanceTimersByTimeAsync(60);
    engine.ingest("t1", "\x1b[2J\x1b[Hordinary output");
    await vi.advanceTimersByTimeAsync(60);
    expect(engine.getExplanation("t1", "running", "process").matchedRuleId).toBeNull();
    engine.ingest("t1", `\x1b[2J\x1b[H${panel}`);
    await vi.advanceTimersByTimeAsync(60);
    expect(candidates).toEqual(["claude_approval_panel", "claude_approval_panel"]);
    engine.dispose();
  });

  it("acknowledgement does not re-emit while the old prompt is still visible", async () => {
    const candidates: string[] = [];
    const engine = new AgentDetectionEngine({
      evaluationDelayMs: 50,
      onCandidate: (_id, candidate) => candidates.push(candidate.matchedRuleId),
    });
    await engine.start();
    engine.trackTerminal({ terminalId: "t1", agentProfile: "claude-local-main", cols: 80, rows: 24 });
    const panel = "────────\nDo you want to run?\nYes  No\nesc to cancel";
    engine.ingest("t1", panel);
    await vi.advanceTimersByTimeAsync(60);
    engine.recordFallback("t1", "process:running");
    engine.ingest("t1", "\r");
    await vi.advanceTimersByTimeAsync(60);
    expect(candidates).toEqual(["claude_approval_panel"]);
    expect(engine.getExplanation("t1", "running", "process")).toMatchObject({
      matchedRuleId: null,
      fallbackReason: "process:running",
    });
    engine.dispose();
  });

  it("getExplanation for unknown terminal returns nulls", async () => {
    const engine = new AgentDetectionEngine();
    await engine.start();
    const expl = engine.getExplanation("nope", "done", null);
    expect(expl.agentProfile).toBeNull();
    expect(expl.matchedRuleId).toBeNull();
    engine.dispose();
  });

  it("buffers bounded: tracking cap at 12 (= agent API MAX_TERMINALS)", async () => {
    const engine = new AgentDetectionEngine();
    await engine.start();
    for (let i = 0; i < 14; i++) {
      engine.trackTerminal({ terminalId: `t${i}`, agentProfile: "claude-local-main", cols: 80, rows: 24 });
    }
    expect(engine.getTrackedCountForTests()).toBe(12);
    engine.dispose();
  });

  it("explanation key whitelist: no raw PTY / region / evidence", async () => {
    const engine = new AgentDetectionEngine({
      evaluationDelayMs: 50,
    });
    await engine.start();
    engine.trackTerminal({ terminalId: "t1", agentProfile: "claude-local-main", cols: 80, rows: 24 });
    engine.ingest("t1", "────────\nDo you want to run?\nYes  No\nesc to cancel");
    await vi.advanceTimersByTimeAsync(60);
    const expl = engine.getExplanation("t1", "approval_required", "screen");
    const keys = Object.keys(expl).sort();
    // Whitelist: exactly these keys, nothing else.
    expect(keys).toEqual([
      "agentProfile",
      "canonicalState",
      "authoritativeSource",
      "evaluatedAt",
      "evaluatedRegion",
      "fallbackReason",
      "gateSummary",
      "manifestVersion",
      "matchedRuleId",
    ].sort());
    // No raw region text or evidence anywhere in the values.
    const serialized = JSON.stringify(expl);
    expect(serialized).not.toContain("esc to cancel");
    expect(serialized).not.toContain("Do you want to run");
    expect(serialized).not.toContain("Yes  No");
    engine.dispose();
  });
});

describe("profileFamily mapper", () => {
  it("maps claude-* profiles", () => {
    expect(profileFamily("claude-local-main")).toBe("claude-code");
    expect(profileFamily("claude-local-big")).toBe("claude-code");
    expect(profileFamily("claude-local-long")).toBe("claude-code");
    expect(profileFamily("claude-local-freeform")).toBe("claude-code");
    expect(profileFamily("claude-official")).toBe("claude-code");
  });

  it("maps codex-* profiles", () => {
    expect(profileFamily("codex-local-main")).toBe("codex");
    expect(profileFamily("codex-local-big")).toBe("codex");
    expect(profileFamily("codex-local-long")).toBe("codex");
  });

  it("returns null for unknown profiles", () => {
    expect(profileFamily("unknown-agent")).toBeNull();
  });
});

describe("override hot reload + fail-closed (temp dir)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = `${import.meta.dirname}/.tmp-ad-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(`${tmpDir}/agent-detection`, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("valid override replaces bundled manifest", () => {
    const override = {
      profile: "claude-code",
      version: "9.9.9",
      rules: [
        {
          id: "custom_rule",
          state: "done",
          priority: 1000,
          region: "bottom_non_empty",
          all: [{ contains: ["custom-marker"] }],
          profile: "claude-code",
        },
      ],
    };
    fs.writeFileSync(`${tmpDir}/agent-detection/custom.json`, JSON.stringify(override));
    const loader = new ManifestLoader(tmpDir);
    const result = loader.load();
    expect(result.warning).toBeNull();
    expect(result.manifests.get("claude-code")?.version).toBe("9.9.9");
    loader.dispose();
  });

  it("invalid override fails closed (keeps bundled)", () => {
    // Invalid JSON.
    fs.writeFileSync(`${tmpDir}/agent-detection/bad.json`, "{ not valid json");
    const loader = new ManifestLoader(tmpDir);
    const result = loader.load();
    expect(result.warning).not.toBeNull();
    // Bundled manifest is retained.
    expect(result.manifests.get("claude-code")?.version).toBe(bundledClaudeCodeManifest.version);
    loader.dispose();
  });

  it("oversized override fails closed", () => {
    const big: { profile: string; version: string; rules: unknown[] } = { profile: "claude-code", version: "x", rules: [] };
    // Pad to > 128KB.
    big.rules = Array.from({ length: 65 }, () => ({
      id: "x".repeat(60),
      state: "done",
      priority: 1,
      region: "bottom_non_empty",
      all: [{ contains: ["x".repeat(256)] }],
      profile: "claude-code",
    }));
    fs.writeFileSync(`${tmpDir}/agent-detection/big.json`, JSON.stringify(big));
    const loader = new ManifestLoader(tmpDir);
    const result = loader.load();
    expect(result.warning).not.toBeNull();
    expect(result.manifests.get("claude-code")?.version).toBe(bundledClaudeCodeManifest.version);
    loader.dispose();
  });

  it("too-many-rules override fails closed", () => {
    const override = {
      profile: "claude-code",
      version: "x",
      rules: Array.from({ length: 65 }, (_, i) => ({
        id: `r${i}`,
        state: "done",
        priority: 1,
        region: "bottom_non_empty",
        all: [{ contains: ["x"] }],
        profile: "claude-code",
      })),
    };
    fs.writeFileSync(`${tmpDir}/agent-detection/many.json`, JSON.stringify(override));
    const loader = new ManifestLoader(tmpDir);
    const result = loader.load();
    expect(result.warning).not.toBeNull();
    loader.dispose();
  });

  it("rejects a rule whose profile disagrees with its manifest", () => {
    const override = {
      profile: "claude-code",
      version: "mismatch",
      rules: [{
        id: "wrong-family",
        state: "done",
        priority: 1,
        region: "bottom_non_empty",
        all: [{ contains: ["x"] }],
        profile: "codex",
      }],
    };
    fs.writeFileSync(`${tmpDir}/agent-detection/mismatch.json`, JSON.stringify(override));
    const loader = new ManifestLoader(tmpDir);
    const result = loader.load();
    expect(result.warning).toBe("override_rule_profile_mismatch");
    expect(result.manifests.get("claude-code")?.version).toBe(bundledClaudeCodeManifest.version);
    loader.dispose();
  });

  it("hot reload retains the last valid override after an invalid rewrite", async () => {
    const path = `${tmpDir}/agent-detection/custom.json`;
    const valid = {
      profile: "claude-code",
      version: "hot-valid",
      rules: [{
        id: "hot_rule",
        state: "done",
        priority: 1000,
        region: "bottom_non_empty",
        all: [{ contains: ["hot-marker"] }],
        profile: "claude-code",
      }],
    };
    const loader = new ManifestLoader(tmpDir);
    loader.load();
    const reloads: Array<{ version: string | undefined; warning: string | null }> = [];
    loader.startWatch((result) => reloads.push({
      version: result.manifests.get("claude-code")?.version,
      warning: result.warning,
    }));

    fs.writeFileSync(path, JSON.stringify(valid));
    await waitUntil(() => reloads.some((entry) => entry.version === "hot-valid" && entry.warning === null));
    fs.writeFileSync(path, "{ invalid json");
    await waitUntil(() => reloads.some((entry) => entry.warning === "override_invalid_json"));

    expect(loader.getManifests().get("claude-code")?.version).toBe("hot-valid");
    expect(reloads.at(-1)).toEqual({ version: "hot-valid", warning: "override_invalid_json" });
    loader.dispose();
  });

  it("creates and watches a missing override directory", async () => {
    fs.rmSync(`${tmpDir}/agent-detection`, { recursive: true, force: true });
    const loader = new ManifestLoader(tmpDir);
    loader.load();
    const versions: string[] = [];
    loader.startWatch((result) => {
      const version = result.manifests.get("codex")?.version;
      if (version) versions.push(version);
    });
    const valid = {
      profile: "codex",
      version: "created-later",
      rules: [],
    };
    fs.writeFileSync(`${tmpDir}/agent-detection/codex.json`, JSON.stringify(valid));
    await waitUntil(() => versions.includes("created-later"));
    expect(loader.getManifests().get("codex")?.version).toBe("created-later");
    loader.dispose();
  });
});
