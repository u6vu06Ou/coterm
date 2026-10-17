import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readClaudeContextUsage,
  readClaudeRecap,
  readCodexContextUsage,
  readCodexThreadTitle,
  normalizeCodexThreadTitle,
  ContextBatteryMonitor,
  mungeCwd,
} from "../../src/main/terminal/context-meter";
import { DatabaseSync } from "node:sqlite";
import type { PtyManager } from "../../src/main/terminal/pty-manager";

describe("readClaudeContextUsage", () => {
  it("sums input + cache_read + cache_creation + output (mutually exclusive buckets)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coterm-cb-claude-"));
    const file = join(dir, "session.jsonl");
    // The work-order's reference record: input=3, cacheCreate=18326,
    // cacheRead=19379, output=48 → used=37756.
    await writeFile(
      file,
      JSON.stringify({
        message: {
          model: "claude-sonnet-4-6",
          usage: {
            input_tokens: 3,
            cache_creation_input_tokens: 18326,
            cache_read_input_tokens: 19379,
            output_tokens: 48,
          },
        },
      }) + "\n",
      "utf8",
    );
    try {
      const usage = await readClaudeContextUsage(file);
      expect(usage).not.toBeNull();
      expect(usage!.usedTokens).toBe(3 + 18326 + 19379 + 48);
      expect(usage!.model).toBe("claude-sonnet-4-6");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null when no usage record is in the tail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coterm-cb-claude-"));
    const file = join(dir, "session.jsonl");
    await writeFile(file, JSON.stringify({ message: { role: "user", content: "hi" } }) + "\n", "utf8");
    try {
      await expect(readClaudeContextUsage(file)).resolves.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("readClaudeRecap", () => {
  it("accepts only the provider-authored away_summary record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coterm-claude-recap-"));
    const file = join(dir, "session.jsonl");
    await writeFile(file, [
      JSON.stringify({ type: "user", message: { role: "user", content: "不要顯示這個 prompt" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "不要顯示這段 assistant prose" }] } }),
      JSON.stringify({ type: "system", subtype: "away_summary", content: "  修正手機 PTY\n表頭契約  " }),
    ].join("\n") + "\n", "utf8");
    try {
      await expect(readClaudeRecap(file)).resolves.toBe("修正手機 PTY 表頭契約");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("readCodexContextUsage", () => {
  it("used = last_token_usage.input + output (input already includes cached subset)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coterm-cb-codex-"));
    const file = join(dir, "rollout.jsonl");
    // input=1200 (already contains the cached subset), cached_input=800
    // (must NOT be added again), output=300 → used=1500. window=200000.
    await writeFile(
      file,
      JSON.stringify({
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 1200,
              cached_input_tokens: 800,
              output_tokens: 300,
            },
            model: "gpt-5.4",
            model_context_window: 200000,
          },
        },
      }) + "\n",
      "utf8",
    );
    try {
      const usage = await readCodexContextUsage(file);
      expect(usage).not.toBeNull();
      expect(usage!.usedTokens).toBe(1200 + 300);
      expect(usage!.windowTokens).toBe(200000);
      expect(usage!.model).toBe("gpt-5.4");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null when no token_count record exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coterm-cb-codex-"));
    const file = join(dir, "rollout.jsonl");
    await writeFile(file, JSON.stringify({ payload: { type: "response_item" } }) + "\n", "utf8");
    try {
      await expect(readCodexContextUsage(file)).resolves.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("readCodexThreadTitle", () => {
  it("reads the generated title for the exact rollout and bounds the header fallback", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coterm-codex-title-"));
    const dbPath = join(dir, "state_5.sqlite");
    const id = "019ff1bb-d798-7331-9de1-60149041e69b";
    const rollout = join(dir, `rollout-2026-08-12T00-00-00-${id}.jsonl`);
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, title TEXT NOT NULL, name TEXT, first_user_message TEXT NOT NULL)");
    db.prepare("INSERT INTO threads (id, rollout_path, title, name, first_user_message) VALUES (?, ?, ?, ?, ?)")
      .run(id, rollout, "修復 Codex PTY 自動摘要", null, "很長的第一個 prompt");
    db.close();
    try {
      expect(readCodexThreadTitle(dbPath, rollout)).toBe("修復 Codex PTY 自動摘要");
      expect(readCodexThreadTitle(dbPath, join(dir, "moved", `rollout-${id}.jsonl`)))
        .toBe("修復 Codex PTY 自動摘要");
      expect(normalizeCodexThreadTitle(`  ${"a".repeat(120)}\nnext  `)).toHaveLength(96);
      expect(normalizeCodexThreadTitle("\n\t")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never falls back to first_user_message or cwd placeholders", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coterm-codex-placeholder-"));
    const dbPath = join(dir, "state_5.sqlite");
    const id = "019ff1bb-d798-7331-9de1-60149041e69b";
    const rollout = join(dir, `rollout-${id}.jsonl`);
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, title TEXT, name TEXT, first_user_message TEXT)");
    db.prepare("INSERT INTO threads (id, rollout_path, title, name, first_user_message) VALUES (?, ?, ?, ?, ?)")
      .run(id, rollout, "請幫我修 bug", null, "請幫我修 bug");
    db.close();
    try {
      expect(readCodexThreadTitle(dbPath, rollout, "D:\\repo")).toBeNull();
      const db2 = new DatabaseSync(dbPath);
      db2.prepare("UPDATE threads SET title = ? WHERE id = ?").run("repo", id);
      db2.close();
      expect(readCodexThreadTitle(dbPath, rollout, "D:\\repo")).toBeNull();
      const db3 = new DatabaseSync(dbPath);
      db3.prepare("UPDATE threads SET name = ? WHERE id = ?").run("使用者命名的工作", id);
      db3.close();
      expect(readCodexThreadTitle(dbPath, rollout, "D:\\repo")).toBe("使用者命名的工作");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // #92: the state DB stores the raw first prompt in `title` until its
  // generated summary arrives, and Codex truncates it — so the placeholder is
  // a PREFIX of first_user_message, which exact-equality filtering misses.
  // A truncated prompt must show nothing, not masquerade as the summary.
  it("rejects a truncated prompt that is a prefix of first_user_message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coterm-codex-echo-"));
    const dbPath = join(dir, "state_5.sqlite");
    const id = "019ff1bb-d798-7331-9de1-60149041e69b";
    const rollout = join(dir, `rollout-${id}.jsonl`);
    const prompt = "請幫我把 Codex 表頭的摘要修好，現在都會顯示第一個 prompt 而不是產生的標題";
    const truncated = "請幫我把 Codex 表頭的摘要修好，現在都會顯示第一個 p"; // 36 chars
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cwd TEXT, title TEXT, name TEXT, first_user_message TEXT, preview TEXT)");
    db.prepare("INSERT INTO threads (id, rollout_path, cwd, title, name, first_user_message, preview) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, rollout, "D:\\repo", truncated, null, prompt, null);
    db.close();
    try {
      expect(readCodexThreadTitle(dbPath, rollout, "D:\\repo")).toBeNull();
      // A real generated title is a rephrase, not a prefix — keep it.
      const db2 = new DatabaseSync(dbPath);
      db2.prepare("UPDATE threads SET title = ? WHERE id = ?").run("修復 Codex 表頭摘要", id);
      db2.close();
      expect(readCodexThreadTitle(dbPath, rollout, "D:\\repo")).toBe("修復 Codex 表頭摘要");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects Codex preview placeholders but accepts a distinct generated title", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coterm-codex-preview-"));
    const dbPath = join(dir, "state_5.sqlite");
    const id = "019ff1bb-d798-7331-9de1-60149041e69b";
    const rollout = join(dir, `rollout-${id}.jsonl`);
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cwd TEXT, title TEXT, name TEXT, first_user_message TEXT, preview TEXT)");
    db.prepare("INSERT INTO threads (id, rollout_path, cwd, title, name, first_user_message, preview) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, rollout, "D:\\repo", "修手機 PTY 的 prompt 預覽", null, "一段更長的原始 prompt", "修手機 PTY 的 prompt 預覽");
    db.close();
    try {
      expect(readCodexThreadTitle(dbPath, rollout, "D:\\repo")).toBeNull();
      const db2 = new DatabaseSync(dbPath);
      db2.prepare("UPDATE threads SET title = ? WHERE id = ?").run("Fix mobile PTY header summary", id);
      db2.close();
      expect(readCodexThreadTitle(dbPath, rollout, "D:\\repo")).toBe("Fix mobile PTY header summary");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ContextBatteryMonitor free-profile gate", () => {
  it("skips free proxy profiles (claude-local-main / codex-local-main) — no battery", async () => {
    const terminals = fakeTerminals([
      { id: "free-1", agentProfile: "claude-local-main", cwd: "D:\\repo", nativeSessionId: "abc", startedAt: new Date().toISOString() },
      { id: "free-2", agentProfile: "codex-local-main", cwd: "D:\\repo", nativeSessionId: null, startedAt: new Date().toISOString() },
    ]);
    const monitor = new ContextBatteryMonitor({
      terminals,
      projectsRoot: join(tmpdir(), "no-claude"),
      codexSessionsRoot: join(tmpdir(), "no-codex"),
      intervalMs: 60_000,
    });
    await (monitor as unknown as { tick: () => Promise<void> }).tick();
    expect(terminals.calls).toHaveLength(0);
  });

  it("skips claude-official without a nativeSessionId (no exact resolution)", async () => {
    const terminals = fakeTerminals([
      { id: "official-1", agentProfile: "claude-official", cwd: "D:\\repo", nativeSessionId: null, startedAt: new Date().toISOString() },
    ]);
    const monitor = new ContextBatteryMonitor({
      terminals,
      projectsRoot: join(tmpdir(), "no-claude"),
      codexSessionsRoot: join(tmpdir(), "no-codex"),
      intervalMs: 60_000,
    });
    await (monitor as unknown as { tick: () => Promise<void> }).tick();
    expect(terminals.calls).toHaveLength(0);
  });
});

describe("ContextBatteryMonitor Claude recap producer", () => {
  const claudeProfiles = [
    "claude-official",
    "claude-local-main",
    "claude-local-long",
    "claude-local-freeform",
    "claude-local-big",
    "claude-local-long2",
  ];

  it("publishes provider-authored recaps for every claude-* profile", async () => {
    const projectsRoot = await mkdtemp(join(tmpdir(), "coterm-claude-profiles-"));
    const cwd = "D:\\repo";
    const projectDir = join(projectsRoot, mungeCwd(cwd));
    await mkdir(projectDir, { recursive: true });
    const snapshots = claudeProfiles.map((agentProfile, index) => ({
      id: `claude-${index}`,
      agentProfile,
      cwd,
      nativeSessionId: `session-${index}`,
      startedAt: new Date().toISOString(),
    }));
    for (const [index, profile] of claudeProfiles.entries()) {
      await writeFile(
        join(projectDir, `session-${index}.jsonl`),
        JSON.stringify({ type: "system", subtype: "away_summary", content: `recap ${profile}` }) + "\n",
        "utf8",
      );
    }
    const terminals = fakeTerminals(snapshots);
    try {
      const monitor = new ContextBatteryMonitor({
        terminals,
        projectsRoot,
        codexSessionsRoot: join(tmpdir(), "no-codex"),
        intervalMs: 60_000,
      });
      await (monitor as unknown as { tick: () => Promise<void> }).tick();
      expect(terminals.recapCalls).toEqual(
        claudeProfiles.map((profile, index) => [`claude-${index}`, `recap ${profile}`]),
      );
      // The recap must never reach the pane header's session summary — that is
      // the v1.5.19 regression where the header went blank / showed proxy noise.
      expect(terminals.titleCalls).toHaveLength(0);
    } finally {
      await rm(projectsRoot, { recursive: true, force: true });
    }
  });

  it("publishes null instead of manufacturing a recap from ordinary prose", async () => {
    const projectsRoot = await mkdtemp(join(tmpdir(), "coterm-claude-no-recap-"));
    const cwd = "D:\\repo";
    const projectDir = join(projectsRoot, mungeCwd(cwd));
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "session-no-recap.jsonl"),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "not a provider recap" }] } }) + "\n",
      "utf8",
    );
    const terminals = fakeTerminals([{
      id: "claude-no-recap",
      agentProfile: "claude-local-long2",
      cwd,
      nativeSessionId: "session-no-recap",
      startedAt: new Date().toISOString(),
    }]);
    try {
      const monitor = new ContextBatteryMonitor({ terminals, projectsRoot, intervalMs: 60_000 });
      await (monitor as unknown as { tick: () => Promise<void> }).tick();
      expect(terminals.recapCalls).toEqual([["claude-no-recap", null]]);
      expect(terminals.titleCalls).toHaveLength(0);
    } finally {
      await rm(projectsRoot, { recursive: true, force: true });
    }
  });
});

describe("ContextBatteryMonitor claude meter gate (measureOne)", () => {
  const claudeSessionWithUsage = async (
    projectsRoot: string,
    cwd: string,
    sessionId: string,
    model: string,
  ): Promise<void> => {
    const projectDir = join(projectsRoot, mungeCwd(cwd));
    await mkdir(projectDir, { recursive: true });
    // The jsonl carries BOTH a usage record (for the battery) and an
    // away_summary (for the recap), so a single session file exercises the
    // gate: the recap path runs before the gate, the battery push after it.
    await writeFile(
      join(projectDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          message: {
            model,
            usage: { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 },
          },
        }),
        JSON.stringify({ type: "system", subtype: "away_summary", content: `recap ${model}` }),
      ].join("\n") + "\n",
      "utf8",
    );
  };

  it("free claude-local-main: reads the recap but publishes NO context battery", async () => {
    const projectsRoot = await mkdtemp(join(tmpdir(), "coterm-cb-gate-"));
    const cwd = "D:\\repo";
    await claudeSessionWithUsage(projectsRoot, cwd, "session-glm", "claude-sonnet-4-6");
    const terminals = fakeTerminals([{
      id: "glm-1", agentProfile: "claude-local-main", cwd,
      nativeSessionId: "session-glm", startedAt: new Date().toISOString(),
    }]);
    try {
      const monitor = new ContextBatteryMonitor({
        terminals, projectsRoot, intervalMs: 60_000,
        codexSessionsRoot: join(tmpdir(), "no-codex"),
      });
      await (monitor as unknown as { tick: () => Promise<void> }).tick();
      // Unmetered free profile → no battery push even though the jsonl has usage.
      expect(terminals.usageCalls).toHaveLength(0);
      expect(terminals.calls).toHaveLength(0);
      // The recap producer sits BEFORE the gate and still runs (and the claudeReads
      // mtime is registered, so the next poll does not re-read for nothing).
      expect(terminals.recapCalls).toEqual([["glm-1", "recap claude-sonnet-4-6"]]);
    } finally {
      await rm(projectsRoot, { recursive: true, force: true });
    }
  });

  it("metered claude-local-long2: publishes the context battery from the same session shape", async () => {
    const projectsRoot = await mkdtemp(join(tmpdir(), "coterm-cb-gate-"));
    const cwd = "D:\\repo";
    await claudeSessionWithUsage(projectsRoot, cwd, "session-qwen", "claude-sonnet-4-6");
    const terminals = fakeTerminals([{
      id: "qwen-1", agentProfile: "claude-local-long2", cwd,
      nativeSessionId: "session-qwen", startedAt: new Date().toISOString(),
    }]);
    try {
      const monitor = new ContextBatteryMonitor({
        terminals, projectsRoot, intervalMs: 60_000,
        codexSessionsRoot: join(tmpdir(), "no-codex"),
      });
      await (monitor as unknown as { tick: () => Promise<void> }).tick();
      // Metered profile past the gate → battery pushed. No tier cache → default
      // 200k window; used = input + cache_read + cache_creation + output = 1005.
      expect(terminals.usageCalls).toHaveLength(1);
      expect(terminals.usageCalls[0]![0]).toBe("qwen-1");
      expect(terminals.usageCalls[0]![1]).toBe(1005);
      expect(terminals.usageCalls[0]![2]).toBe(200_000);
      expect(terminals.recapCalls).toEqual([["qwen-1", "recap claude-sonnet-4-6"]]);
    } finally {
      await rm(projectsRoot, { recursive: true, force: true });
    }
  });
});

describe("ContextBatteryMonitor codex session binding", () => {
  it("binds a fresh codex rollout by cwd + session start timestamp", async () => {
    const sessionsRoot = await mkdtemp(join(tmpdir(), "coterm-cb-bind-"));
    // Terminal started 5s ago — the rollout is written ~now, so its mtime is
    // at/after the terminal start (the fresh-launch case the binder handles).
    const startedAt = new Date(Date.now() - 5_000);
    const startedMs = startedAt.getTime();
    const dayDir = join(
      sessionsRoot,
      String(startedAt.getFullYear()),
      String(startedAt.getMonth() + 1).padStart(2, "0"),
      String(startedAt.getDate()).padStart(2, "0"),
    );
    await mkdir(dayDir, { recursive: true });
    // A rollout whose session_meta cwd matches the terminal and whose start
    // timestamp is at/after the terminal start.
    const rollout = join(dayDir, "rollout-bind.jsonl");
    await writeFile(
      rollout,
      JSON.stringify({
        timestamp: new Date(startedMs + 2_000).toISOString(),
        type: "session_meta",
        payload: { cwd: "D:\\repo", timestamp: new Date(startedMs + 2_000).toISOString() },
      }) + "\n" +
      JSON.stringify({
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 500, output_tokens: 100 },
            model: "gpt-5.4",
            model_context_window: 200000,
          },
        },
      }) + "\n",
      "utf8",
    );
    // A decoy rollout in a different cwd — must not bind.
    const decoy = join(dayDir, "rollout-decoy.jsonl");
    await writeFile(
      decoy,
      JSON.stringify({
        timestamp: new Date(startedMs + 1_000).toISOString(),
        type: "session_meta",
        payload: { cwd: "D:\\other", timestamp: new Date(startedMs + 1_000).toISOString() },
      }) + "\n" +
      JSON.stringify({
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 999, output_tokens: 999 },
            model: "gpt-5.4",
            model_context_window: 200000,
          },
        },
      }) + "\n",
      "utf8",
    );

    // Same cwd but older than the PTY start. The old signed-diff comparison
    // incorrectly preferred this (-30s) over the real rollout (+2s).
    const olderSameCwd = join(dayDir, "rollout-older-same-cwd.jsonl");
    await writeFile(
      olderSameCwd,
      JSON.stringify({
        timestamp: new Date(startedMs - 30_000).toISOString(),
        type: "session_meta",
        payload: { cwd: "D:\\repo", timestamp: new Date(startedMs - 30_000).toISOString() },
      }) + "\n" +
      JSON.stringify({
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 777, output_tokens: 0 },
            model: "gpt-5.4",
            model_context_window: 200000,
          },
        },
      }) + "\n",
      "utf8",
    );

    const terminals = fakeTerminals([{
      id: "codex-1",
      agentProfile: "codex-official",
      cwd: "D:\\repo",
      nativeSessionId: null,
      startedAt: startedAt.toISOString(),
    }]);

    try {
      const monitor = new ContextBatteryMonitor({
        terminals,
        codexSessionsRoot: sessionsRoot,
        projectsRoot: join(tmpdir(), "no-claude"),
        intervalMs: 60_000,
      });
      await (monitor as unknown as { tick: () => Promise<void> }).tick();
      expect(terminals.calls).toHaveLength(1);
      expect(terminals.calls[0]![0]).toBe("codex-1");
      expect(terminals.calls[0]![1]).toBe(600); // 500 + 100, not 999+999
    } finally {
      await rm(sessionsRoot, { recursive: true, force: true });
    }
  });

  it("fails soft instead of cross-wiring two near-simultaneous same-cwd rollouts", async () => {
    const sessionsRoot = await mkdtemp(join(tmpdir(), "coterm-cb-ambiguous-"));
    const startedAt = new Date(Date.now() - 5_000);
    const startedMs = startedAt.getTime();
    const dayDir = join(
      sessionsRoot,
      String(startedAt.getFullYear()),
      String(startedAt.getMonth() + 1).padStart(2, "0"),
      String(startedAt.getDate()).padStart(2, "0"),
    );
    await mkdir(dayDir, { recursive: true });
    for (const [name, offset, used] of [["a", 1_000, 111], ["b", 2_000, 222]] as const) {
      await writeFile(
        join(dayDir, `rollout-${name}.jsonl`),
        JSON.stringify({
          timestamp: new Date(startedMs + offset).toISOString(),
          type: "session_meta",
          payload: { cwd: "D:\\repo", timestamp: new Date(startedMs + offset).toISOString() },
        }) + "\n" + JSON.stringify({
          payload: {
            type: "token_count",
            info: { last_token_usage: { input_tokens: used, output_tokens: 0 }, model_context_window: 200000 },
          },
        }) + "\n",
        "utf8",
      );
    }
    const terminals = fakeTerminals([{
      id: "codex-ambiguous",
      agentProfile: "codex-official",
      cwd: "D:\\repo",
      nativeSessionId: null,
      startedAt: startedAt.toISOString(),
    }]);
    try {
      const monitor = new ContextBatteryMonitor({
        terminals,
        codexSessionsRoot: sessionsRoot,
        projectsRoot: join(tmpdir(), "no-claude"),
        intervalMs: 60_000,
      });
      await (monitor as unknown as { tick: () => Promise<void> }).tick();
      expect(terminals.calls).toHaveLength(0);
      expect(terminals.titleCalls).toHaveLength(0);
    } finally {
      await rm(sessionsRoot, { recursive: true, force: true });
    }
  });
});

describe("ContextBatteryMonitor codex title", () => {
  it("keeps the free Codex battery hidden but still publishes its generated title", async () => {
    const home = await mkdtemp(join(tmpdir(), "coterm-codex-home-"));
    const id = "019ff1bb-d798-7331-9de1-60149041e69b";
    const startedAt = new Date(Date.now() - 5_000);
    const dayDir = join(
      home,
      "sessions",
      String(startedAt.getFullYear()),
      String(startedAt.getMonth() + 1).padStart(2, "0"),
      String(startedAt.getDate()).padStart(2, "0"),
    );
    await mkdir(dayDir, { recursive: true });
    const rollout = join(dayDir, `rollout-2026-08-12T00-00-00-${id}.jsonl`);
    await writeFile(
      rollout,
      JSON.stringify({
        timestamp: new Date(startedAt.getTime() + 2_000).toISOString(),
        type: "session_meta",
        payload: { cwd: "D:\\repo", timestamp: new Date(startedAt.getTime() + 2_000).toISOString() },
      }) + "\n",
      "utf8",
    );
    const dbPath = join(home, "state_5.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, title TEXT NOT NULL, name TEXT, first_user_message TEXT NOT NULL)");
    db.prepare("INSERT INTO threads (id, rollout_path, title, name, first_user_message) VALUES (?, ?, ?, ?, ?)")
      .run(id, rollout, "Audit proxy retries", null, "first prompt");
    db.close();

    const terminals = fakeTerminals([{
      id: "free-codex",
      agentProfile: "codex-local-main",
      cwd: "D:\\repo",
      nativeSessionId: id,
      startedAt: startedAt.toISOString(),
    }]);

    try {
      const monitor = new ContextBatteryMonitor({
        terminals,
        projectsRoot: join(tmpdir(), "no-claude"),
        codexSessionsRoot: join(tmpdir(), "no-codex"),
        codexProfileHomes: { "codex-local-main": home },
        intervalMs: 60_000,
      });
      await (monitor as unknown as { tick: () => Promise<void> }).tick();
      expect(terminals.calls).toHaveLength(0);
      expect(terminals.titleCalls).toEqual([["free-codex", "Audit proxy retries"]]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("ContextBatteryMonitor claude tier learning (#79)", () => {
  const claudeSessionWithUsage = async (projectsRoot: string, cwd: string, sessionId: string, usedTokens: number) => {
    const projectDir = join(projectsRoot, mungeCwd(cwd));
    await mkdir(projectDir, { recursive: true });
    // Model id carries no 1M tier marker — this is the case the old 200k
    // preset misjudged 5x high.
    await writeFile(
      join(projectDir, `${sessionId}.jsonl`),
      JSON.stringify({
        message: {
          model: "claude-opus-5",
          usage: { input_tokens: usedTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 },
        },
      }) + "\n",
      "utf8",
    );
  };

  it("applies the learned 1M account tier to a sub-200k session instead of overreporting 5x", async () => {
    const projectsRoot = await mkdtemp(join(tmpdir(), "coterm-cb-tier-"));
    const dir = await mkdtemp(join(tmpdir(), "coterm-cb-tiercache-"));
    const tierPath = join(dir, "claude-context-tiers.json");
    const cwd = "D:\\repo";
    await claudeSessionWithUsage(projectsRoot, cwd, "s1", 185_632);
    await writeFile(tierPath, JSON.stringify({ "claude-official": 1_000_000 }), "utf8");
    const terminals = fakeTerminals([{
      id: "t1", agentProfile: "claude-official", cwd,
      nativeSessionId: "s1", startedAt: new Date().toISOString(),
    }]);
    try {
      const monitor = new ContextBatteryMonitor({
        terminals, projectsRoot, intervalMs: 60_000, claudeTierCachePath: tierPath,
        codexSessionsRoot: join(tmpdir(), "no-codex"),
      });
      await (monitor as unknown as { tick: () => Promise<void> }).tick();
      expect(terminals.usageCalls).toEqual([["t1", 185_633, 1_000_000, expect.any(Number), "claude-opus-5"]]);
      expect(terminals.usageCalls[0]![3]!).toBeCloseTo(18.5633, 3);
    } finally {
      await rm(projectsRoot, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("defaults to the 200k window when no tier has been learned yet", async () => {
    const projectsRoot = await mkdtemp(join(tmpdir(), "coterm-cb-tier-"));
    const cwd = "D:\\repo";
    await claudeSessionWithUsage(projectsRoot, cwd, "s1", 185_632);
    const terminals = fakeTerminals([{
      id: "t1", agentProfile: "claude-official", cwd,
      nativeSessionId: "s1", startedAt: new Date().toISOString(),
    }]);
    try {
      const monitor = new ContextBatteryMonitor({
        terminals, projectsRoot, intervalMs: 60_000,
        codexSessionsRoot: join(tmpdir(), "no-codex"),
      });
      await (monitor as unknown as { tick: () => Promise<void> }).tick();
      expect(terminals.usageCalls[0]![2]).toBe(200_000);
    } finally {
      await rm(projectsRoot, { recursive: true, force: true });
    }
  });

  it("learns the 1M tier from a session crossing 200k and persists it", async () => {
    const projectsRoot = await mkdtemp(join(tmpdir(), "coterm-cb-tier-"));
    const dir = await mkdtemp(join(tmpdir(), "coterm-cb-tiercache-"));
    const tierPath = join(dir, "claude-context-tiers.json");
    const cwd = "D:\\repo";
    await claudeSessionWithUsage(projectsRoot, cwd, "s1", 215_557);
    const terminals = fakeTerminals([{
      id: "t1", agentProfile: "claude-official", cwd,
      nativeSessionId: "s1", startedAt: new Date().toISOString(),
    }]);
    try {
      const monitor = new ContextBatteryMonitor({
        terminals, projectsRoot, intervalMs: 60_000, claudeTierCachePath: tierPath,
        codexSessionsRoot: join(tmpdir(), "no-codex"),
      });
      await (monitor as unknown as { tick: () => Promise<void> }).tick();
      expect(terminals.usageCalls[0]![2]).toBe(1_000_000);
      // Persisted for the next app start (learning survives restart). The
      // write is fire-and-forget in the monitor, so poll briefly.
      let onDisk: Record<string, number> | null = null;
      for (let attempt = 0; attempt < 50; attempt++) {
        onDisk = await readFile(tierPath, "utf8")
          .then((text) => JSON.parse(text) as Record<string, number>)
          .catch(() => null);
        if (onDisk?.["claude-official"] === 1_000_000) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(onDisk?.["claude-official"]).toBe(1_000_000);
    } finally {
      await rm(projectsRoot, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// Shared fake PtyManager surface: records setContextUsage calls so tests can
// assert which terminals received a battery and with what used-token count.
function fakeTerminals(snapshot: Array<{
  id: string;
  agentProfile: string;
  cwd: string;
  nativeSessionId: string | null;
  startedAt: string;
}>): Pick<PtyManager, "dashboardSnapshot" | "setContextUsage" | "setAgentSummaryTitle" | "setAgentRecap"> & {
  calls: Array<[string, number]>;
  usageCalls: Array<[string, number, number | null, number | null, string | null]>;
  titleCalls: Array<[string, string | null]>;
  recapCalls: Array<[string, string | null]>;
} {
  const calls: Array<[string, number]> = [];
  const usageCalls: Array<[string, number, number | null, number | null, string | null]> = [];
  const titleCalls: Array<[string, string | null]> = [];
  const recapCalls: Array<[string, string | null]> = [];
  return {
    dashboardSnapshot: () =>
      snapshot.map((s) => ({
        info: {
          id: s.id, projectId: "p", profile: "pwsh", title: "t", cwd: s.cwd,
          cols: 100, rows: 28, status: "running",
          startedAt: s.startedAt, closedAt: null, lastExitCode: null,
          isAgent: true, agentProfile: s.agentProfile, ownedByAgentApi: false,
          pid: 0, nativeSessionId: s.nativeSessionId, worktreeId: null,
          contextUsage: null, agentSummaryTitle: null,
        },
        ptyState: "running" as const,
        lastCommand: null,
      })),
    setContextUsage: (id: string, used: number, window: number | null, percent: number | null, model: string | null) => {
      calls.push([id, used]);
      usageCalls.push([id, used, window, percent, model]);
    },
    setAgentSummaryTitle: (id: string, title: string | null) => titleCalls.push([id, title]),
    setAgentRecap: (id: string, recap: string | null) => recapCalls.push([id, recap]),
    calls,
    usageCalls,
    titleCalls,
    recapCalls,
  };
}

describe("ContextBatteryMonitor mtime short-check", () => {
  it("skips the claude tail-reads while the session file is unchanged", async () => {
    const projectsRoot = await mkdtemp(join(tmpdir(), "coterm-cb-mtime-"));
    const cwd = "D:\\repo";
    const projectDir = join(projectsRoot, mungeCwd(cwd));
    await mkdir(projectDir, { recursive: true });
    const sessionFile = join(projectDir, "session-mtime.jsonl");
    const usageRecord = (used: number) => JSON.stringify({
      message: {
        model: "claude-sonnet-4-6",
        usage: { input_tokens: used, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
      },
    });
    await writeFile(sessionFile, usageRecord(100) + "\n", "utf8");
    const terminals = fakeTerminals([{
      id: "claude-mtime",
      agentProfile: "claude-official",
      cwd,
      nativeSessionId: "session-mtime",
      startedAt: new Date().toISOString(),
    }]);
    try {
      const monitor = new ContextBatteryMonitor({
        terminals,
        projectsRoot,
        codexSessionsRoot: join(tmpdir(), "no-codex"),
        intervalMs: 60_000,
      });
      const tick = () => (monitor as unknown as { tick: () => Promise<void> }).tick();
      await tick();
      expect(terminals.usageCalls).toHaveLength(1);
      expect(terminals.recapCalls).toHaveLength(1);
      // Unchanged file → second poll is a pure stat, no reads, no pushes.
      await tick();
      expect(terminals.usageCalls).toHaveLength(1);
      expect(terminals.recapCalls).toHaveLength(1);
      // A write moves the mtime → the next poll reads again.
      await writeFile(sessionFile, usageRecord(250) + "\n", "utf8");
      const later = Date.now() + 1_000;
      await utimes(sessionFile, later / 1000, later / 1000);
      await tick();
      expect(terminals.usageCalls).toHaveLength(2);
      expect(terminals.usageCalls[1]![1]).toBe(250);
    } finally {
      await rm(projectsRoot, { recursive: true, force: true });
    }
  });

  it("gates codex usage on the rollout mtime and the title on the state-DB mtime", async () => {
    const sessionsRoot = await mkdtemp(join(tmpdir(), "coterm-cb-mtime-codex-"));
    const stateDb = join(sessionsRoot, "state_5.sqlite");
    const threadId = "11111111-2222-4333-8444-555555555555";
    const startedAt = new Date(Date.now() - 5_000);
    const dayDir = join(
      sessionsRoot,
      String(startedAt.getFullYear()),
      String(startedAt.getMonth() + 1).padStart(2, "0"),
      String(startedAt.getDate()).padStart(2, "0"),
    );
    await mkdir(dayDir, { recursive: true });
    const rollout = join(dayDir, `rollout-2026-09-23T00-00-00-${threadId}.jsonl`);
    const rolloutRecord = (input: number) =>
      JSON.stringify({
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: input, output_tokens: 50 },
            model: "gpt-5.6",
            model_context_window: 200000,
          },
        },
      }) + "\n";
    await writeFile(rollout, rolloutRecord(500), "utf8");
    const db = new DatabaseSync(stateDb);
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, rollout_path TEXT)");
    db.prepare("INSERT INTO threads (id, name, rollout_path) VALUES (?, ?, ?)")
      .run(threadId, "first title", rollout);
    const terminals = fakeTerminals([{
      id: "codex-mtime",
      agentProfile: "codex-official",
      cwd: "D:\\repo",
      nativeSessionId: threadId,
      startedAt: startedAt.toISOString(),
    }]);
    try {
      const monitor = new ContextBatteryMonitor({
        terminals,
        codexSessionsRoot: sessionsRoot,
        codexStateDbPath: stateDb,
        projectsRoot: join(tmpdir(), "no-claude"),
        intervalMs: 60_000,
      });
      const tick = () => (monitor as unknown as { tick: () => Promise<void> }).tick();
      await tick();
      expect(terminals.titleCalls).toEqual([["codex-mtime", "first title"]]);
      expect(terminals.usageCalls).toHaveLength(1);
      // Nothing changed → second poll is stats only.
      await tick();
      expect(terminals.titleCalls).toHaveLength(1);
      expect(terminals.usageCalls).toHaveLength(1);
      // Rollout write → usage re-read; title untouched (DB mtime unchanged).
      await writeFile(rollout, rolloutRecord(900), "utf8");
      const later = Date.now() + 1_000;
      await utimes(rollout, later / 1000, later / 1000);
      await tick();
      expect(terminals.usageCalls).toHaveLength(2);
      expect(terminals.usageCalls[1]![1]).toBe(950); // 900 + 50
      expect(terminals.titleCalls).toHaveLength(1);
      // A generated title landing in the DB while the rollout idles → title
      // re-read from the DB mtime gate alone, usage untouched.
      db.prepare("UPDATE threads SET name = ? WHERE id = ?").run("renamed title", threadId);
      await tick();
      expect(terminals.titleCalls).toEqual([["codex-mtime", "first title"], ["codex-mtime", "renamed title"]]);
      expect(terminals.usageCalls).toHaveLength(2);
    } finally {
      db.close();
      await rm(sessionsRoot, { recursive: true, force: true });
    }
  });
});
