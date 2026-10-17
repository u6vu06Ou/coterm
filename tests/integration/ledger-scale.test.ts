import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../../src/main/storage/database";
import {
  Repository,
  TERMINAL_EVENTS_MAX_ROWS,
} from "../../src/main/storage/repository";

// Scale regression for the 2026-08-06 ledger-bloat incident: every existing
// storage test runs against a few-KB empty DB, so "terminal_events grows to
// a million rows and every write serializes+writes a 1.37 GB export" was
// invisible to CI. This test seeds 250k rows (past the rolling row cap) and
// asserts the startup-prune path brings the ledger back under the cap, that
// VACUUM actually shrinks the file, and that a settings write stays fast.
describe("ledger at scale", () => {
  let directory: string;
  let databasePath: string;
  let database: AppDatabase;
  let repository: Repository;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ai-terminal-scale-"));
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

  it("startup prune caps terminal_events, shrinks the file, and keeps writes fast", async () => {
    const project = await repository.createProject("scale", directory);

    // Seed 250k terminal_events (25% over the 200k rolling cap) in ONE
    // statement — a recursive CTE is orders of magnitude faster than
    // per-row inserts. All timestamps within the last hour so the day-based
    // retention prune must NOT delete them; only the rolling cap may act.
    const SEED = TERMINAL_EVENTS_MAX_ROWS + 50_000;
    const payload80 = "x".repeat(80);
    database.run(
      `INSERT INTO terminal_events(id, project_id, terminal_id, type, created_at, sequence, summary, payload_json)
       WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM seq WHERE x < $total)
       SELECT printf('bulk-%07d', x), $pid, 'term-bulk', 'terminal.output',
              strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || (x % 3600) || ' seconds'),
              x, 'bulk event', '{"text":"${payload80}"}'
       FROM seq`,
      { $total: SEED, $pid: project.id },
    );
    // Force a persist so the pre-prune file size on disk is measurable.
    const settings = repository.getSettings();
    await repository.setSettings({ ...settings, theme: "light" });
    const sizeBefore = (await stat(databasePath)).size;
    expect(sizeBefore).toBeGreaterThan(5 * 1024 * 1024);

    // Mirror AppOperations.maybePruneOnStart: day-based prune (deletes nothing
    // here), then the always-on rolling-cap prune, then VACUUM because the
    // deletion was big.
    const dayPrune = await repository.pruneOldData({ days: 30 });
    expect(dayPrune.deletedTerminalEvents).toBe(0);
    const overflow = await repository.pruneTerminalEventsOverflow("startup");
    expect(overflow.deleted).toBe(50_000);
    expect(overflow.remainingRows).toBe(TERMINAL_EVENTS_MAX_ROWS);
    await repository.vacuumAfterPrune(overflow.deleted);

    const sizeAfter = (await stat(databasePath)).size;
    // Deleting 50k/250k rows only frees ~20%, but VACUUM must actually hand
    // those pages back (the incident DB stayed 1.37 GB after manual deletes).
    expect(sizeAfter).toBeLessThan(sizeBefore * 0.9);

    // A settings write against the pruned ledger must not stall the queue.
    // sql.js exports the whole DB image per write, so the threshold is sized
    // for a capped (~200k-row / small-MB) ledger — not the 1.37 GB disaster.
    // Once the engine is node:sqlite, this is single-digit ms.
    const startedAt = performance.now();
    await repository.setSettings({ ...repository.getSettings(), theme: "dark" });
    const elapsedMs = performance.now() - startedAt;
    expect(repository.getSettings().theme).toBe("dark");
    expect(elapsedMs).toBeLessThan(2_000);

    // Full startup path at scale: age every row past the retention window,
    // day-based prune must sweep them all, and VACUUM brings the file back
    // to a fresh-install size.
    database.run("UPDATE terminal_events SET created_at = '2026-06-01T00:00:00.000Z'");
    const sweep = await repository.pruneOldData({ days: 30 });
    expect(sweep.deletedTerminalEvents).toBe(TERMINAL_EVENTS_MAX_ROWS);
    await repository.vacuumAfterPrune(sweep.deletedTerminalEvents);
    const sizeSwept = (await stat(databasePath)).size;
    expect(sizeSwept).toBeLessThan(2 * 1024 * 1024);
  }, 120_000);
});
