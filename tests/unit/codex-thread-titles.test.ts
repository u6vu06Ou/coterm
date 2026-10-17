import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCodexThreadTitle } from "../../src/main/terminal/context-meter";
import { readCodexThreadTitles } from "../../src/main/core/app-operations";

describe("Codex thread title batch reader", () => {
  let root: string;
  let dbPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "coterm-codex-titles-"));
    dbPath = join(root, "state_5.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`CREATE TABLE threads (
        id TEXT,
        name TEXT,
        title TEXT,
        first_user_message TEXT,
        preview TEXT,
        cwd TEXT,
        rollout_path TEXT
      )`);
    } finally {
      db.close();
    }
  });

  afterEach(async () => {
    // Windows can report the freshly-closed SQLite file as still locked.
    for (let attempt = 0; ; attempt++) {
      try {
        await rm(root, { recursive: true, force: true });
        return;
      } catch (error) {
        if (attempt >= 10) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });

  function insert(row: {
    id: string;
    name: string | null;
    title: string | null;
    first_user_message: string | null;
    preview: string | null;
    cwd: string | null;
    rollout_path: string | null;
  }): void {
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(
        "INSERT INTO threads (id, name, title, first_user_message, preview, cwd, rollout_path) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(row.id, row.name, row.title, row.first_user_message, row.preview, row.cwd, row.rollout_path);
    } finally {
      db.close();
    }
  }

  function insertWithoutRolloutColumn(id: string, name: string): void {
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(
        "INSERT INTO threads (id, name, title, first_user_message, preview, cwd) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(id, name, null, null, null, null);
    } finally {
      db.close();
    }
  }

  const rolloutOf = (id: string) => `rollout-${id}.jsonl`;

  it("agrees with the single-row reader on every guard outcome", async () => {
    insert({
      id: "11111111-2222-4333-8444-555555555555",
      name: null,
      title: "Build the release pip",
      first_user_message: "Build the release pipeline from scratch",
      preview: null,
      cwd: null,
      rollout_path: "C:\\x\\rollout-11111111-2222-4333-8444-555555555555.jsonl",
    });
    insert({
      id: "aaaaaaaa-bbbb-4ccc-ddee-ffffffffffff",
      name: "Generated session name",
      title: "Ignored fallback",
      first_user_message: null,
      preview: null,
      cwd: null,
      rollout_path: "C:\\x\\rollout-aaaaaaaa-bbbb-4ccc-ddee-ffffffffffff.jsonl",
    });
    insert({
      id: "66666666-7777-4888-8999-000000000000",
      name: null,
      title: "powershell",
      first_user_message: "Run the build",
      preview: null,
      cwd: null,
      rollout_path: "C:\\x\\rollout-66666666-7777-4888-8999-000000000000.jsonl",
    });
    const ids = [
      "11111111-2222-4333-8444-555555555555",
      "aaaaaaaa-bbbb-4ccc-ddee-ffffffffffff",
      "66666666-7777-4888-8999-000000000000",
      "12345678-9abc-4def-8123-456789abcdef", // not in the DB at all
    ];

    for (const id of ids) {
      const rollout = rolloutOf(id);
      const single = readCodexThreadTitle(dbPath, rollout);
      const batched = readCodexThreadTitles(dbPath, [rollout]).get(rollout);
      expect(batched).toBe(single);
    }

    // Prompt echo → null (truncated first prompt masquerading as a title).
    expect(readCodexThreadTitle(dbPath, rolloutOf("11111111-2222-4333-8444-555555555555"))).toBeNull();
    // name channel wins over the title fallback.
    expect(readCodexThreadTitle(dbPath, rolloutOf("aaaaaaaa-bbbb-4ccc-ddee-ffffffffffff"))).toBe("Generated session name");
    // Placeholder title ("powershell") → null.
    expect(readCodexThreadTitle(dbPath, rolloutOf("66666666-7777-4888-8999-000000000000"))).toBeNull();
  });

  it("prefers the exact rollout_path row over an id match and batches many rollouts", async () => {
    // Production stores rollout_path as a full path; the exact-match branch
    // fires when the caller resolves the rollout to its stored path.
    insert({
      id: "12345678-9abc-4def-8123-456789abcdef",
      name: "ById",
      title: null,
      first_user_message: null,
      preview: null,
      cwd: null,
      rollout_path: "C:\\old\\rollout-12345678-9abc-4def-8123-456789abcdef.jsonl",
    });
    insert({
      id: "12345678-9abc-4def-8123-456789abcdef",
      name: "ByRollout",
      title: null,
      first_user_message: null,
      preview: null,
      cwd: null,
      rollout_path: "C:\\x\\rollout-12345678-9abc-4def-8123-456789abcdef.jsonl",
    });
    const resolved = "C:\\x\\rollout-12345678-9abc-4def-8123-456789abcdef.jsonl";

    const single = readCodexThreadTitle(dbPath, resolved);
    expect(single).toBe("ByRollout");
    const batch = readCodexThreadTitles(dbPath, [resolved, "rollout-missing.jsonl"]);
    expect(batch.get(resolved)).toBe(single);
    expect(batch.get("rollout-missing.jsonl")).toBeNull();

    // Bare rollout names (what listProjectSessions passes) match via the
    // id fallback; both readers must agree on that row too.
    const bare = rolloutOf("12345678-9abc-4def-8123-456789abcdef");
    expect(readCodexThreadTitles(dbPath, [bare]).get(bare)).toBe(readCodexThreadTitle(dbPath, bare));
  });

  it("keeps working when the rollout_path column or the DB file is missing", async () => {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("DROP TABLE threads");
      db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, first_user_message TEXT, preview TEXT, cwd TEXT)");
    } finally {
      db.close();
    }
    insertWithoutRolloutColumn("11111111-2222-4333-8444-555555555555", "NoRolloutColumn");
    const rollout = rolloutOf("11111111-2222-4333-8444-555555555555");
    const single = readCodexThreadTitle(dbPath, rollout);
    expect(readCodexThreadTitles(dbPath, [rollout, rolloutOf("99999999-9999-4999-8999-999999999999")]).get(rollout)).toBe(single);

    // Older Codex builds: no DB file at all → every rollout null, both readers.
    const missing = join(root, "absent-state.sqlite");
    expect(readCodexThreadTitle(missing, rollout)).toBeNull();
    expect(readCodexThreadTitles(missing, [rollout]).get(rollout)).toBeNull();

    expect(readCodexThreadTitles(missing, []).size).toBe(0);
  });
});
