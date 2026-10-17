import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeHistory } from "../../src/main/core/claude-history";
import type { Project } from "../../src/shared/types";

describe("Claude history projection", () => {
  let root: string;
  let workspace: string;
  let project: Project;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "coterm-claude-history-"));
    workspace = join(root, "workspace");
    await mkdir(workspace);
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

  afterEach(() => rm(root, { recursive: true, force: true }));

  it("lists matching sessions newest-first with resume metadata", async () => {
    await session("older.jsonl", workspace, "Older task", "2026-06-20T00:00:00.000Z");
    await session("native-secret-session.jsonl", workspace, "Newer task", "2026-06-21T00:00:00.000Z");
    await session("other.jsonl", join(root, "other"), "Other task", "2026-06-22T00:00:00.000Z");

    const listed = await new ClaudeHistory(root).list(project, [project]);

    expect(listed.map((item) => item.title)).toEqual(["Newer task", "Older task"]);
    expect(listed[0]).toMatchObject({
      nativeSessionId: "native-secret-session",
      sizeBytes: expect.any(Number) as number,
    });
    expect(listed[0]?.key).toMatch(/^[a-f0-9]{64}$/);
  });

  it("caches head metadata: unchanged stamp skips re-read, moved mtime re-reads", async () => {
    const file = join(root, "project-key", "cached.jsonl");
    await mkdir(join(root, "project-key"), { recursive: true });
    const write = (title: string) =>
      writeFile(file, JSON.stringify({ ...record("user", workspace, title), timestamp: "2026-06-21T00:00:00.000Z" }), "utf8");
    await write("First title phrase");
    // Integer-ms mtime so utimes can restore the stamp exactly between lists.
    const stamp = 1_750_000_000_000;
    utimesSync(file, new Date(stamp), new Date(stamp));

    const history = new ClaudeHistory(root);
    const [firstListed] = await history.list(project, [project]);
    expect(firstListed?.title).toBe("First title phrase");

    // Same size + same mtime → cache hit; the on-disk head change stays unseen.
    await write("Second title phras");
    utimesSync(file, new Date(stamp), new Date(stamp));
    const [cachedListed] = await history.list(project, [project]);
    expect(cachedListed?.title).toBe("First title phrase");

    // Same size but a moved mtime → re-read picks up the new head.
    await write("Third title phrase");
    const [freshListed] = await history.list(project, [project]);
    expect(freshListed?.title).toBe("Third title phrase");
  });

  it("warm() populates the cache so list() does no re-reads", async () => {
    const file = join(root, "project-key", "warm.jsonl");
    await mkdir(join(root, "project-key"), { recursive: true });
    const write = (title: string) =>
      writeFile(file, JSON.stringify({ ...record("user", workspace, title), timestamp: "2026-06-21T00:00:00.000Z" }), "utf8");
    // "Original warm title" and "Rewritten warm head" are both 19 ASCII chars.
    await write("Original warm title");
    const stamp = 1_750_000_000_000;
    utimesSync(file, new Date(stamp), new Date(stamp));

    const history = new ClaudeHistory(root);
    await history.warm();

    // Same size + same mtime as warm saw → the head came from warm's cache.
    await write("Rewritten warm head");
    utimesSync(file, new Date(stamp), new Date(stamp));
    const [listed] = await history.list(project, [project]);
    expect(listed?.title).toBe("Original warm title");
  });

  it("reads only user and assistant text, redacts secrets, and resolves adoption privately", async () => {
    await session("native-secret-session.jsonl", workspace, "Build it", "2026-06-21T00:00:00.000Z", [
      record("assistant", workspace, [{ type: "text", text: "Done safely" }, { type: "tool_use", input: { password: "MUST_NOT_LEAK" } }]),
      record("user", workspace, "api_key=sk-ant-abcdefghijklmnopqrstuvwxyz"),
    ]);
    const history = new ClaudeHistory(root);
    const [listed] = await history.list(project, [project]);
    const transcript = await history.read(project, [project], listed!.key);
    const adopted = await history.resolve(project, [project], listed!.key);

    expect(transcript.messages.slice(0, 2).map((message) => message.text)).toEqual([
      "Build it",
      "Done safely",
    ]);
    expect(transcript.messages[2]?.text).toContain("[REDACTED]");
    expect(transcript.messages[2]?.text).not.toContain("sk-ant-");
    expect(JSON.stringify(transcript)).not.toContain("MUST_NOT_LEAK");
    expect(adopted.nativeSessionId).toBe("native-secret-session");
    await expect(history.read(project, [project], "../native-secret-session.jsonl"))
      .rejects.toThrow("Invalid Claude history key");
  });

  async function session(
    name: string,
    cwd: string,
    title: string,
    timestamp: string,
    extra: unknown[] = [],
  ): Promise<void> {
    const directory = join(root, "project-key");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, name), [
      JSON.stringify({ ...record("user", cwd, title), timestamp }),
      ...extra.map((item) => JSON.stringify(item)),
    ].join("\n"), "utf8");
  }
});

function record(role: "user" | "assistant", cwd: string, content: unknown): Record<string, unknown> {
  return { type: role, cwd, message: { role, content } };
}
