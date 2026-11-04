import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyClaudeSummaryRecord,
  ClaudeSessionSummaryScanner,
  claudeSessionSummaryFromScan,
  createClaudeSummaryScan,
  stripClaudeRecapSuffix,
} from "../../src/main/terminal/claude-session-summary";

const userRecord = (text: string) => ({
  type: "user",
  message: { role: "user", content: [{ type: "text", text }] },
  timestamp: "2026-11-04T01:00:00.000Z",
});

describe("stripClaudeRecapSuffix", () => {
  it("removes the exact opt-out footer the CLI appends", () => {
    expect(stripClaudeRecapSuffix("正在重新打包，跑完會給你下載網址。 (disable recaps in /config)"))
      .toBe("正在重新打包，跑完會給你下載網址。");
    expect(stripClaudeRecapSuffix("No footer here")).toBe("No footer here");
  });
});

describe("applyClaudeSummaryRecord", () => {
  it("collects ai-title, custom-title, recap and real user prompts", () => {
    const scan = createClaudeSummaryScan();
    applyClaudeSummaryRecord(userRecord("修正 claude-team 表頭摘要"), scan);
    applyClaudeSummaryRecord(
      { type: "system", subtype: "away_summary", content: "正在修表頭。 (disable recaps in /config)" },
      scan,
    );
    applyClaudeSummaryRecord({ type: "ai-title", aiTitle: "修表頭摘要" }, scan);
    expect(scan.title).toBe("修表頭摘要");
    expect(scan.recap).toBe("正在修表頭。");
    expect(scan.lastPrompt).toBe("修正 claude-team 表頭摘要");
    // custom-title (user /rename) beats an earlier ai-title.
    applyClaudeSummaryRecord({ type: "custom-title", customTitle: "Sidebar 摘要修正" }, scan);
    expect(scan.title).toBe("Sidebar 摘要修正");
  });

  it("skips tool results, injected CLI text and bare slash commands", () => {
    const scan = createClaudeSummaryScan();
    applyClaudeSummaryRecord(userRecord("真正的第一個 prompt"), scan);
    applyClaudeSummaryRecord({ type: "user", toolUseResult: "x", message: { role: "user", content: "tool out" } }, scan);
    applyClaudeSummaryRecord({ type: "user", isMeta: true, message: { role: "user", content: "[Image: source: C:\\tmp\\1.png]" } }, scan);
    applyClaudeSummaryRecord({ type: "user", isSidechain: true, message: { role: "user", content: "subagent chatter" } }, scan);
    applyClaudeSummaryRecord(userRecord("<system-reminder>tools used</system-reminder>"), scan);
    applyClaudeSummaryRecord(userRecord("<command-name>/review</command-name>"), scan);
    applyClaudeSummaryRecord(userRecord("/compact"), scan);
    expect(scan.lastPrompt).toBe("真正的第一個 prompt");
    // A slash invocation WITH arguments is a real instruction, not noise.
    applyClaudeSummaryRecord(userRecord("/review src/main/terminal"), scan);
    expect(scan.lastPrompt).toBe("/review src/main/terminal");
    // A bare absolute PATH is not a slash command — keep it as a prompt.
    applyClaudeSummaryRecord(userRecord("/usr/local/bin 下面的舊版本"), scan);
    expect(scan.lastPrompt).toBe("/usr/local/bin 下面的舊版本");
  });

  it("treats a blank custom-title as clearing the rename", () => {
    const scan = createClaudeSummaryScan();
    applyClaudeSummaryRecord({ type: "custom-title", customTitle: "舊標題" }, scan);
    expect(scan.title).toBe("舊標題");
    applyClaudeSummaryRecord({ type: "custom-title", customTitle: "" }, scan);
    expect(scan.title).toBe(null);
  });
});

describe("claudeSessionSummaryFromScan", () => {
  it("prefers title over recap over last prompt", () => {
    expect(claudeSessionSummaryFromScan({
      title: "修表頭摘要",
      recap: "正在修表頭。",
      lastPrompt: "修正 claude-team 表頭摘要",
    })).toBe("修表頭摘要");
    expect(claudeSessionSummaryFromScan({ title: null, recap: "正在修表頭。", lastPrompt: "修正 claude-team 表頭摘要" }))
      .toBe("正在修表頭。");
    expect(claudeSessionSummaryFromScan({ title: null, recap: null, lastPrompt: "修正 claude-team 表頭摘要" }))
      .toBe("修正 claude-team 表頭摘要");
    expect(claudeSessionSummaryFromScan({ title: null, recap: null, lastPrompt: null })).toBe(null);
  });

  it("runs the winner through the shared junk guards before publishing", () => {
    // A chrome-looking candidate never reaches the header; fall to next source.
    expect(claudeSessionSummaryFromScan({
      title: null,
      recap: null,
      lastPrompt: "──────────────",
    })).toBe(null);
    expect(claudeSessionSummaryFromScan({
      title: "claude",
      recap: "Recap survives",
      lastPrompt: null,
    })).toBe("Recap survives");
  });

  it("caps long prompts with an emoji-safe ellipsis", () => {
    const long = "很長的 prompt ".repeat(40).trim();
    const summary = claudeSessionSummaryFromScan({ title: null, recap: null, lastPrompt: long })!;
    expect(Array.from(summary).length).toBe(180);
    expect(summary.endsWith("…")).toBe(true);
  });
});

describe("ClaudeSessionSummaryScanner", () => {
  it("reads incrementally: the early ai-title is found once, appends update the rest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coterm-claude-summary-"));
    const file = join(dir, "session.jsonl");
    try {
      await writeFile(file, JSON.stringify(userRecord("第一個 prompt")) + "\n", "utf8");
      const scanner = new ClaudeSessionSummaryScanner();
      await scanner.update(file);
      expect(claudeSessionSummaryFromScan(scanner.result)).toBe("第一個 prompt");

      await appendFile(file, JSON.stringify({ type: "ai-title", aiTitle: "版本摘要修正" }) + "\n", "utf8");
      await appendFile(file, JSON.stringify(userRecord("第二個 prompt")) + "\n", "utf8");
      await scanner.update(file);
      expect(scanner.result.title).toBe("版本摘要修正");
      expect(scanner.result.lastPrompt).toBe("第二個 prompt");
      expect(claudeSessionSummaryFromScan(scanner.result)).toBe("版本摘要修正");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("follows a session rebind: a different file restarts the scan", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coterm-claude-summary-rebind-"));
    const fileA = join(dir, "a.jsonl");
    const fileB = join(dir, "b.jsonl");
    try {
      await writeFile(fileA, JSON.stringify({ type: "ai-title", aiTitle: "舊 session" }) + "\n", "utf8");
      await writeFile(fileB, JSON.stringify(userRecord("新 session 的 prompt")) + "\n", "utf8");
      const scanner = new ClaudeSessionSummaryScanner();
      await scanner.update(fileA);
      expect(scanner.result.title).toBe("舊 session");
      await scanner.update(fileB);
      expect(scanner.result.title).toBe(null);
      expect(claudeSessionSummaryFromScan(scanner.result)).toBe("新 session 的 prompt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("handles a half-written trailing line without corrupting the scan", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coterm-claude-summary-partial-"));
    const file = join(dir, "session.jsonl");
    try {
      const line = JSON.stringify({ type: "ai-title", aiTitle: "Decode 邊界標題" });
      await writeFile(file, line, "utf8"); // no trailing newline yet
      const scanner = new ClaudeSessionSummaryScanner();
      await scanner.update(file);
      expect(scanner.result.title).toBe(null);
      await appendFile(file, "\n", "utf8");
      await scanner.update(file);
      expect(scanner.result.title).toBe("Decode 邊界標題");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
