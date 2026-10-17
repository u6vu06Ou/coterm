import { mkdir, mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionIndex } from "../../src/main/core/session-index";
import type { Project } from "../../src/shared/types";

describe("SessionIndex", () => {
  let root: string;
  let claudeRoot: string;
  let dbPath: string;
  let workspace: string;
  let project: Project;
  let index: SessionIndex | null = null;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "coterm-session-index-"));
    claudeRoot = join(root, "claude-projects");
    workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await mkdir(join(claudeRoot, "proj-key"), { recursive: true });
    dbPath = join(root, "session-index.db");
    project = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Workspace",
      workspacePath: workspace,
      pinned: false,
      order: 0,
      archived: false,
      createdAt: "2026-06-21T00:00:00.000Z",
      updatedAt: "2026-06-21T00:00:00.000Z",
    };
  });

  afterEach(async () => {
    index?.close();
    index = null;
    await rm(root, { recursive: true, force: true });
  });

  // throttleMs=0 so repeated sync() calls in the same test always re-scan.
  const makeIndex = () => {
    index = new SessionIndex(dbPath, claudeRoot, 0);
    return index;
  };

  it("indexes only sessions whose cwd maps to a known project (≥3 char CJK FTS hit)", async () => {
    await writeSession("matched.jsonl", workspace, [
      rec("user", workspace, "幫我查台北天氣預報"),
      rec("assistant", workspace, "台北今天晴朗", "claude-sonnet-4-6"),
    ]);
    await writeSession("unmatched.jsonl", join(root, "other-workspace"), [
      rec("user", join(root, "other-workspace"), "台北天氣在這裡"),
    ]);

    const index = makeIndex();
    await index.sync([project]);

    const hits = index.search("台北天氣", [project], 20);
    expect(hits.map((h) => h.nativeSessionId)).toEqual(["matched"]);
    expect(hits[0]?.projectId).toBe(project.id);
    expect(hits[0]?.snippet).toContain("台北");
  });

  it("falls back to LIKE for 2-char CJK queries", async () => {
    await writeSession("short.jsonl", workspace, [
      rec("user", workspace, "企鵝南極"),
    ]);

    const index = makeIndex();
    await index.sync([project]);

    const hits = index.search("企鵝", [project], 20);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.nativeSessionId).toBe("short");
  });

  it("incrementally indexes appended lines and advances offset", async () => {
    await writeSession("grow.jsonl", workspace, [
      rec("user", workspace, "初始訊息內容"),
    ]);

    const index = makeIndex();
    await index.sync([project]);
    expect(index.search("獨特關鍵字甲", [project], 20)).toEqual([]);

    // Append a new user turn with a unique keyword.
    await appendLine("grow.jsonl", rec("user", workspace, "後續討論獨特關鍵字甲"));
    await index.sync([project]);

    const hits = index.search("獨特關鍵字甲", [project], 20);
    expect(hits.map((h) => h.nativeSessionId)).toEqual(["grow"]);
  });

  it("preserves aiTitle/title/model captured before the incremental offset", async () => {
    await writeSession("meta.jsonl", workspace, [
      { type: "ai-title", aiTitle: "重要的原始標題", cwd: workspace },
      rec("user", workspace, "第一句提示語"),
      rec("assistant", workspace, "回覆內容一", "my-glm-legacy"),
    ]);

    const index = makeIndex();
    await index.sync([project]);

    // Second sync reads only the appended tail — head metadata must survive.
    await appendLine("meta.jsonl", rec("user", workspace, "追加訊息乙"));
    await index.sync([project]);

    const hits = index.search("追加訊息乙", [project], 20);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.title).toBe("重要的原始標題");
    expect(hits[0]?.profileId).toBe("claude-local-main");
  });

  it("skips tool_result and injection-prefixed user turns", async () => {
    await writeSession("skip.jsonl", workspace, [
      rec("user", workspace, "<system-reminder>這是注入內容不該被索引</system-reminder>"),
      {
        type: "user",
        cwd: workspace,
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "工具結果不該被索引" }],
        },
      },
      rec("assistant", workspace, "正常回覆文字", "claude-sonnet-4-6"),
    ]);

    const index = makeIndex();
    await index.sync([project]);

    expect(index.search("注入內容不該", [project], 20)).toEqual([]);
    expect(index.search("工具結果不該", [project], 20)).toEqual([]);
    const hits = index.search("正常回覆文字", [project], 20);
    expect(hits.map((h) => h.nativeSessionId)).toEqual(["skip"]);
  });

  it("attributes subagent transcript hits to the parent session", async () => {
    await writeSession("parent-main.jsonl", workspace, [
      rec("user", workspace, "主 session 的訊息"),
    ]);
    await writeSubagent("parent-main", "agent-x.jsonl", [
      rec("user", workspace, "子代理討論獨特關鍵字丙"),
      rec("assistant", workspace, "子代理回覆丙", "claude-sonnet-4-6"),
    ]);

    const index = makeIndex();
    await index.sync([project]);

    const hits = index.search("獨特關鍵字丙", [project], 20);
    expect(hits.map((h) => h.nativeSessionId)).toEqual(["parent-main"]);
  });

  it("falls back to the parent session cwd when a subagent record has no cwd", async () => {
    await writeSession("parent-fb.jsonl", workspace, [
      rec("user", workspace, "主 session 訊息 fb"),
    ]);
    // Subagent records with NO cwd field — attribution must fall back to parent.
    await writeSubagent("parent-fb", "agent-nocwd.jsonl", [
      { type: "user", message: { role: "user", content: "無 cwd 子代理獨特關鍵字丁" } },
    ]);

    const index = makeIndex();
    await index.sync([project]);

    const hits = index.search("獨特關鍵字丁", [project], 20);
    expect(hits.map((h) => h.nativeSessionId)).toEqual(["parent-fb"]);
  });

  it("skips journal.jsonl under subagents/ (different schema)", async () => {
    await writeSession("parent-j.jsonl", workspace, [
      rec("user", workspace, "主 session 訊息 j"),
    ]);
    // journal.jsonl lives under subagents/ but must NOT be indexed.
    const dir = join(claudeRoot, "proj-key", "parent-j", "subagents");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "journal.jsonl"), `${JSON.stringify({ text: "journal 獨特關鍵字戊" })}\n`, "utf8");

    const index = makeIndex();
    await index.sync([project]);

    expect(index.search("獨特關鍵字戊", [project], 20)).toEqual([]);
  });

  it("accumulates token usage across main + subagent files and incremental syncs", async () => {
    await writeSession("tok-main.jsonl", workspace, [
      usageRec(workspace, "主回覆", { input_tokens: 100, output_tokens: 50 }),
    ]);
    await writeSubagent("tok-main", "agent-tok.jsonl", [
      usageRec(workspace, "子代理回覆", { input_tokens: 30, output_tokens: 20 }),
    ]);

    const index = makeIndex();
    await index.sync([project]);

    let stats = index.stats(["tok-main"]);
    expect(stats.get("tok-main")).toEqual({ tokensIn: 130, tokensOut: 70, cacheRead: 0, cacheCreation: 0 });

    // Append another usage record and re-sync — must accumulate, not overwrite.
    await appendLine("tok-main.jsonl", usageRec(workspace, "第二筆", { input_tokens: 5, output_tokens: 3 }));
    await index.sync([project]);

    stats = index.stats(["tok-main"]);
    expect(stats.get("tok-main")).toEqual({ tokensIn: 135, tokensOut: 73, cacheRead: 0, cacheCreation: 0 });
  });

  it("rebuilds a stale v1 DB on open (user_version upgrade path)", async () => {
    // Hand-craft a v1 DB with an old schema (no token columns) and user_version=1.
    const { DatabaseSync } = await import("node:sqlite");
    const stale = new DatabaseSync(dbPath);
    stale.exec("PRAGMA user_version = 1");
    stale.exec("CREATE TABLE sessions (native_session_id TEXT PRIMARY KEY, file TEXT)");
    stale.exec("CREATE VIRTUAL TABLE messages_fts USING fts5(session_id UNINDEXED, text, tokenize='trigram')");
    stale.close();

    await writeSession("upgrade.jsonl", workspace, [
      rec("user", workspace, "升版後獨特關鍵字己"),
    ]);

    const index = makeIndex();
    await index.sync([project]);

    const hits = index.search("獨特關鍵字己", [project], 20);
    expect(hits.map((h) => h.nativeSessionId)).toEqual(["upgrade"]);
    // token columns exist after rebuild.
    expect(index.stats(["upgrade"]).get("upgrade")).toEqual({ tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheCreation: 0 });
  });

  it("reconcile drops a deleted main-session file (no ghost hits)", async () => {
    await writeSession("ghost-main.jsonl", workspace, [
      rec("user", workspace, "幽靈清理獨特關鍵字庚"),
    ]);

    const index = makeIndex();
    await index.sync([project]);
    expect(index.search("獨特關鍵字庚", [project], 20).map((h) => h.nativeSessionId)).toEqual(["ghost-main"]);

    // Delete the jsonl on disk, then re-sync — the index must purge it.
    rmSync(join(claudeRoot, "proj-key", "ghost-main.jsonl"), { force: true });
    await index.sync([project]);

    expect(index.search("獨特關鍵字庚", [project], 20)).toEqual([]);
    expect(index.stats(["ghost-main"]).get("ghost-main")).toBeUndefined();
  });

  it("reconcile of a deleted subagent file keeps the parent session searchable", async () => {
    await writeSession("ghost-parent.jsonl", workspace, [
      rec("user", workspace, "主 session 訊息辛"),
    ]);
    await writeSubagent("ghost-parent", "agent-del.jsonl", [
      rec("user", workspace, "子代理獨特關鍵字壬"),
    ]);

    const index = makeIndex();
    await index.sync([project]);
    // Subagent hit attributes to the parent.
    expect(index.search("獨特關鍵字壬", [project], 20).map((h) => h.nativeSessionId)).toEqual(["ghost-parent"]);

    // Delete only the subagent file — parent must stay searchable.
    rmSync(join(claudeRoot, "proj-key", "ghost-parent", "subagents", "agent-del.jsonl"), { force: true });
    await index.sync([project]);

    expect(index.search("主 session 訊息辛", [project], 20).map((h) => h.nativeSessionId)).toEqual(["ghost-parent"]);
  });

  it("status() reports syncing flag and lastCompletedAt", async () => {
    const index = makeIndex();
    expect(index.status()).toEqual({ syncing: false, lastCompletedAt: null });
    await index.sync([project]);
    const after = index.status();
    expect(after.syncing).toBe(false);
    expect(after.lastCompletedAt).not.toBeNull();
  });

  async function writeSession(name: string, _cwd: string, records: unknown[]): Promise<void> {
    const dir = join(claudeRoot, "proj-key");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, name),
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8",
    );
  }

  async function appendLine(name: string, record: unknown): Promise<void> {
    await appendFile(join(claudeRoot, "proj-key", name), `${JSON.stringify(record)}\n`, "utf8");
  }

  function rec(role: "user" | "assistant", cwd: string, content: string, model?: string): Record<string, unknown> {
    const message: Record<string, unknown> = { role, content };
    if (model) message.model = model;
    return { type: role, cwd, message };
  }

  function usageRec(cwd: string, content: string, usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }, model = "claude-sonnet-4-6"): Record<string, unknown> {
    return { type: "assistant", cwd, message: { role: "assistant", content, model, usage } };
  }

  async function writeSubagent(parent: string, name: string, records: unknown[]): Promise<void> {
    const dir = join(claudeRoot, "proj-key", parent, "subagents");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  }
});
