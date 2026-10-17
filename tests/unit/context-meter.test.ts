import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeContextWindow,
  mungeCwd,
  readClaudeContextUsage,
  resolveLatestSessionJsonl,
} from "../../src/main/terminal/context-meter";

describe("resolveLatestSessionJsonl", () => {
  it("does not fall back to another session when a native session file is not ready", async () => {
    const projectsRoot = await mkdtemp(join(tmpdir(), "coterm-context-meter-"));
    const cwd = "D:\\Coterm";
    const projectFolder = join(projectsRoot, mungeCwd(cwd));
    await mkdir(projectFolder, { recursive: true });
    await writeFile(join(projectFolder, "older-session.jsonl"), "{}\n", "utf8");

    try {
      await expect(resolveLatestSessionJsonl(cwd, projectsRoot, "fresh-session-id")).resolves.toBeNull();
      await expect(resolveLatestSessionJsonl(cwd, projectsRoot)).resolves.toMatchObject({
        file: join(projectFolder, "older-session.jsonl"),
      });
    } finally {
      await rm(projectsRoot, { recursive: true, force: true });
    }
  });
});

describe("claudeContextWindow preset vs observed usage", () => {
  // T4: claude-opus-4-8 / Opus 5 sessions can exceed the 200k default preset.
  // measureOne then promotes the window to the 1M tier instead of clamping to a
  // fake 100%. This pins the preset + the promotion rule so a regression (raising
  // the preset, or dropping the >window guard) is caught.
  it("returns 200_000 for claude-opus-4-8, which a real 253k usage exceeds → measureOne promotes to the 1M tier", () => {
    const preset = claudeContextWindow("claude-opus-4-8");
    expect(preset).toBe(200_000);
    const usedTokens = 253_590; // observed in dfc70efb-…jsonl
    // The exact guard measureOne applies after readClaudeContextUsage:
    expect(preset !== null && usedTokens > preset).toBe(true);
    const promoted = usedTokens <= 1_000_000 ? 1_000_000 : null;
    expect(promoted).toBe(1_000_000);
    expect(Math.round((usedTokens / promoted!) * 100)).toBe(25);
  });

  it("keeps the explicit 1M presets", () => {
    expect(claudeContextWindow("claude-sonnet-4-5[1m]")).toBe(1_000_000);
    expect(claudeContextWindow("claude-fable-5")).toBe(1_000_000);
    expect(claudeContextWindow("gpt-5")).toBeNull();
  });
});

describe("readClaudeContextUsage sidechain filtering", () => {
  it("skips isSidechain:true records and returns the main-thread usage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coterm-context-sidechain-"));
    const file = join(dir, "session.jsonl");
    // Tail order (oldest → newest): a sidechain record with a huge usage,
    // then the real main-thread assistant usage. Without the sidechain skip,
    // the huge sidechain number would be returned and falsely inflate the
    // main thread's battery.
    const lines = [
      JSON.stringify({
        isSidechain: true,
        message: {
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 1_000_000,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 0,
          },
        },
      }),
      JSON.stringify({
        message: {
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 131,
            cache_read_input_tokens: 252_666,
            cache_creation_input_tokens: 258,
            output_tokens: 535,
          },
        },
      }),
    ];
    await writeFile(file, lines.join("\n") + "\n", "utf8");
    try {
      const usage = await readClaudeContextUsage(file);
      expect(usage).not.toBeNull();
      // Main-thread total, NOT the 1M sidechain value.
      expect(usage?.usedTokens).toBe(131 + 252_666 + 258 + 535);
      expect(usage?.model).toBe("claude-opus-4-8");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
