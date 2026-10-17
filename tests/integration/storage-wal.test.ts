import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../../src/main/storage/database";
import { Repository } from "../../src/main/storage/repository";

/**
 * Issue #94 residual root: the ledger ran in rollback-journal mode, so the
 * search-index rescan's shared read lock stalled every write for the whole
 * ~200 MB scan — typing froze the window. These tests prove the fix at the
 * locking layer (rollback blocks the writer, WAL does not), plus the
 * backup/restore and counter invariants the WAL switch had to preserve.
 */
describe("storage WAL + rolling-cap counters", () => {
  let directory: string;
  let databasePath: string;
  let database: AppDatabase;
  let repository: Repository;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ai-terminal-wal-"));
    databasePath = join(directory, "state.sqlite");
    database = new AppDatabase(databasePath);
    await database.open();
    repository = new Repository(database);
  });

  afterEach(async () => {
    await repository.closeSearchIndex();
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  const counter = (key: string): number =>
    database.queryOne<{ value: number }>("SELECT value FROM storage_counters WHERE key = ?", [key])
      ?.value ?? Number.NaN;

  it("opens the ledger in WAL mode", () => {
    const mode = database.queryOne<{ journal_mode: string }>("PRAGMA journal_mode");
    expect(mode?.journal_mode).toBe("wal");
  });

  it("is the freeze repro: rollback mode blocks a writer behind a held read, WAL does not", () => {
    // Control — the OLD behavior: rollback journal + a read transaction held
    // the way the search rescan holds it. The writer stalls until
    // busy_timeout and then fails.
    const controlPath = join(directory, "control.sqlite");
    const controlWriter = new DatabaseSync(controlPath);
    controlWriter.exec("PRAGMA busy_timeout = 250");
    controlWriter.exec("CREATE TABLE probe(x TEXT)");
    controlWriter.exec("INSERT INTO probe VALUES ('seed')");
    expect(
      (controlWriter.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
    ).not.toBe("wal");
    const controlReader = new DatabaseSync(controlPath, { readOnly: true });
    controlReader.exec("BEGIN");
    controlReader.prepare("SELECT COUNT(*) AS n FROM probe").get();
    const blockedStart = Date.now();
    expect(() =>
      controlWriter.prepare("INSERT INTO probe VALUES ('blocked')").run(),
    ).toThrow();
    expect(Date.now() - blockedStart).toBeGreaterThanOrEqual(200); // the freeze, at lock level
    controlReader.exec("ROLLBACK");
    controlReader.close();
    controlWriter.close();

    // Fixed behavior — AppDatabase is WAL; the same held read must not block
    // a writer at all.
    const reader = new DatabaseSync(databasePath, { readOnly: true });
    reader.exec("PRAGMA busy_timeout = 5000");
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) AS n FROM projects").get();
    const writeStart = Date.now();
    database.run(
      "UPDATE storage_counters SET value = value WHERE key = 'terminal_events.rows'",
    );
    expect(Date.now() - writeStart).toBeLessThan(2000);
    reader.exec("ROLLBACK");
    reader.close();
  });

  it("keeps storage_counters exact across appends, direct SQL writes, cascade deletes, and pruning", async () => {
    const project = await repository.createProject("counters", directory);
    for (let i = 0; i < 5; i++) {
      await repository.appendTerminalEvent({
        projectId: project.id,
        terminalId: "t1",
        type: "terminal.output",
        summary: `s${i}`,
        payload: { text: "x".repeat(100) },
      });
    }

    const actual = () =>
      database.queryOne<{ n: number; bytes: number }>(
        "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(payload_json)), 0) AS bytes FROM terminal_events",
      )!;

    // Direct SQL (maintenance scripts, tests) bypasses the repository; the
    // triggers must still move the counters.
    database.run(
      `INSERT INTO terminal_events(id, project_id, terminal_id, type, created_at, sequence, summary, payload_json)
       VALUES ('d1d1d1d1-0000-4000-8000-000000000001', ?, 't1', 'terminal.output', ?, 99, 'direct', ?)`,
      [project.id, new Date().toISOString(), JSON.stringify({ text: "y".repeat(50) })],
    );
    let truth = actual();
    expect(counter("terminal_events.rows")).toBe(truth.n);
    expect(counter("terminal_events.payload_bytes")).toBe(truth.bytes);

    // Cascade delete via project removal.
    const doomed = await repository.createProject("doomed", directory);
    await repository.appendTerminalEvent({
      projectId: doomed.id,
      terminalId: "t2",
      type: "terminal.output",
      summary: "doomed",
      payload: { text: "z" },
    });
    await repository.deleteProject(doomed.id);
    truth = actual();
    expect(counter("terminal_events.rows")).toBe(truth.n);
    expect(counter("terminal_events.payload_bytes")).toBe(truth.bytes);

    // Overflow pruning: counters drive the decision and the triggers keep
    // them exact afterwards.
    const pruned = await repository.pruneTerminalEventsOverflow("test", { maxRows: 2 });
    expect(pruned.deleted).toBe(4);
    expect(pruned.remainingRows).toBe(2);
    truth = actual();
    expect(counter("terminal_events.rows")).toBe(truth.n);
    expect(counter("terminal_events.payload_bytes")).toBe(truth.bytes);

    // Under-cap check is a no-op (and never scans).
    const untouched = await repository.pruneTerminalEventsOverflow("test", { maxRows: 100 });
    expect(untouched).toEqual({ deleted: 0, remainingRows: 2, remainingPayloadBytes: truth.bytes });
  });

  it("backup snapshots under WAL alongside a live reader, and restore swaps in cleanly", async () => {
    await repository.createProject("keep", directory);

    // A reader with an open transaction stands in for the search-index worker
    // mid-rescan: backup must succeed anyway and stay a single standalone
    // file.
    const reader = new DatabaseSync(databasePath, { readOnly: true });
    reader.exec("PRAGMA busy_timeout = 5000");
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) AS n FROM projects").get();
    const backupPath = join(directory, "backup.sqlite");
    await database.backup(backupPath);
    reader.exec("ROLLBACK");
    reader.close();

    await repository.createProject("after backup", directory);
    expect(repository.listProjects()).toHaveLength(2);

    await database.restore(backupPath);

    // Stale -wal frames from the pre-restore DB replayed onto the swapped
    // file would corrupt/mismatch it — a correct list proves the swap wiped
    // sidecars properly.
    expect(repository.listProjects().map((project) => project.name)).toEqual(["keep"]);
    expect(database.queryOne<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode).toBe(
      "wal",
    );
  });
});
