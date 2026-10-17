/**
 * Coterm footprint measurement script.
 *
 * Usage:
 *   npx tsx scripts/measure-footprint.ts [--userData <path>] [--json]
 *
 * Defaults userData to %APPDATA%/Coterm.
 *
 * Read-only: copies the SQLite file to os.tmpdir() before opening with
 * node:sqlite so the real database is never touched. Logs directory is read
 * with stat only.
 */
import { copyFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

// --- CLI parsing -----------------------------------------------------------

interface CliArgs {
  userData: string;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const defaultUserData =
    process.env.APPDATA ?? join(process.env.HOME ?? "~", ".config");
  const args: CliArgs = {
    userData: join(defaultUserData, "Coterm"),
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--userData" || arg === "--user-data") {
      const next = argv[i + 1];
      if (!next) {
        console.error(`Missing value for ${arg}`);
        process.exit(1);
      }
      args.userData = next;
      i++;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: npx tsx scripts/measure-footprint.ts [--userData <path>] [--json]",
      );
      process.exit(0);
    }
  }
  return args;
}

// --- Types -----------------------------------------------------------------

interface TableInfo {
  name: string;
  rowCount: number;
  estimatedBytes: number;
}

interface LogInfo {
  totalBytes: number;
  fileCount: number;
  oldestMtime: string | null;
  newestMtime: string | null;
}

interface ScrollbackInfo {
  totalBytes: number;
  paneCount: number;
  maxPaneBytes: number;
}

interface EventTypeCount {
  type: string;
  count: number;
}

interface FootprintReport {
  measuredAt: string;
  userDataPath: string;
  sqlite: {
    dbPath: string;
    dbFileBytes: number;
    tables: TableInfo[];
  };
  logs: LogInfo;
  terminalEventsScrollback: ScrollbackInfo;
  eventsByType: EventTypeCount[];
  summary: {
    totalDbBytes: number;
    totalLogBytes: number;
    topConsumers: Array<{ label: string; bytes: number }>;
    prunableEstimateBytes: number;
  };
}

// --- SQLite measurement ----------------------------------------------------

async function measureSqlite(
  dbPath: string,
): Promise<{ report: FootprintReport["sqlite"]; tempPath: string }> {
  const fileStat = await stat(dbPath).catch(() => null);
  if (!fileStat) {
    return {
      report: {
        dbPath,
        dbFileBytes: 0,
        tables: [],
      },
      tempPath: "",
    };
  }

  // Copy to temp so we never touch the original.
  const tempPath = join(
    tmpdir(),
    `coterm-measure-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  await copyFile(dbPath, tempPath);

  const db = new DatabaseSync(tempPath);

  const names = (
    db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{ name: string }>
  ).map((row) => row.name);

  const tables: TableInfo[] = [];
  for (const name of names) {
    const rowCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number } | undefined
    )?.n ?? 0;

    // Estimate bytes: sum of length of all text/blob columns is expensive on
    // large tables. Use a cheaper heuristic — for payload-heavy tables we
    // sample the payload column length; otherwise estimate from page count.
    let estimatedBytes = 0;
    if (rowCount > 0) {
      const colNames = (
        db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>
      ).map((row) => row.name);
      if (colNames.length > 0) {
        // Build a SUM of lengths for text columns, COUNT for others.
        const parts = colNames.map(
          (col) => `COALESCE(LENGTH(CAST("${col}" AS TEXT)), 0)`,
        );
        try {
          estimatedBytes = (
            db.prepare(`SELECT SUM(${parts.join(" + ")}) AS total FROM "${name}"`).get() as
              { total: number | null } | undefined
          )?.total ?? 0;
        } catch {
          // Fallback: rough estimate from row count * avg row size
          estimatedBytes = rowCount * 200;
        }
      }
    }

    tables.push({ name, rowCount, estimatedBytes });
  }

  db.close();

  return {
    report: {
      dbPath,
      dbFileBytes: fileStat.size,
      tables,
    },
    tempPath,
  };
}

// --- Logs measurement ------------------------------------------------------

async function measureLogs(logsDir: string): Promise<LogInfo> {
  const entries = await readdir(logsDir, { withFileTypes: true }).catch(() => []);
  let totalBytes = 0;
  let fileCount = 0;
  let oldestMtime: number | null = null;
  let newestMtime: number | null = null;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = join(logsDir, entry.name);
    const info = await stat(fullPath).catch(() => null);
    if (!info) continue;
    totalBytes += info.size;
    fileCount++;
    if (oldestMtime === null || info.mtimeMs < oldestMtime) {
      oldestMtime = info.mtimeMs;
    }
    if (newestMtime === null || info.mtimeMs > newestMtime) {
      newestMtime = info.mtimeMs;
    }
  }

  return {
    totalBytes,
    fileCount,
    oldestMtime: oldestMtime ? new Date(oldestMtime).toISOString() : null,
    newestMtime: newestMtime ? new Date(newestMtime).toISOString() : null,
  };
}

// --- Terminal events scrollback -------------------------------------------

async function measureTerminalEventsScrollback(
  dbPath: string,
  tempDir: string,
): Promise<ScrollbackInfo> {
  const tempPath = join(tempDir, "te-measure.sqlite");
  await copyFile(dbPath, tempPath).catch(() => null);
  const fileStat = await stat(tempPath).catch(() => null);
  if (!fileStat) {
    return { totalBytes: 0, paneCount: 0, maxPaneBytes: 0 };
  }

  const db = new DatabaseSync(tempPath);

  // terminal_events.payload_json is the biggest column (scrollback content).
  // Also check terminal_panes.scrollback.
  let totalBytes = 0;
  let paneCount = 0;
  let maxPaneBytes = 0;

  // terminal_events payload_json total
  try {
    totalBytes += (
      db.prepare(
        "SELECT COALESCE(SUM(LENGTH(payload_json)), 0) AS total FROM terminal_events",
      ).get() as { total: number } | undefined
    )?.total ?? 0;
  } catch {
    // table might not exist
  }

  // terminal_panes.scrollback total + per-pane max
  try {
    const row = db.prepare(
      "SELECT COALESCE(SUM(LENGTH(scrollback)), 0) AS total, COUNT(*) AS panes, COALESCE(MAX(LENGTH(scrollback)), 0) AS maxPane FROM terminal_panes",
    ).get() as { total: number; panes: number; maxPane: number } | undefined;
    if (row) {
      totalBytes += row.total;
      paneCount = row.panes;
      maxPaneBytes = row.maxPane;
    }
  } catch {
    // table might not exist
  }

  db.close();
  await rm(tempPath, { force: true });

  return { totalBytes, paneCount, maxPaneBytes };
}

// --- Events by type --------------------------------------------------------

async function measureEventsByType(
  dbPath: string,
  tempDir: string,
): Promise<EventTypeCount[]> {
  const tempPath = join(tempDir, "evt-measure.sqlite");
  await copyFile(dbPath, tempPath).catch(() => null);
  const fileStat = await stat(tempPath).catch(() => null);
  if (!fileStat) return [];

  const db = new DatabaseSync(tempPath);

  const result: EventTypeCount[] = [];
  try {
    const rows = db.prepare(
      "SELECT type, COUNT(*) AS count FROM events GROUP BY type ORDER BY count DESC",
    ).all() as Array<{ type: string; count: number }>;
    for (const row of rows) {
      result.push({ type: row.type, count: row.count });
    }
  } catch {
    // table might not exist
  }

  db.close();
  await rm(tempPath, { force: true });

  return result;
}

// --- Formatting ------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const unit = units[i] ?? "TB";
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${unit}`;
}

function printHuman(report: FootprintReport): void {
  console.log("=".repeat(72));
  console.log("Coterm Footprint Report");
  console.log(`Measured: ${report.measuredAt}`);
  console.log(`UserData: ${report.userDataPath}`);
  console.log("=".repeat(72));

  console.log("\n## SQLite Database\n");
  console.log(`  File: ${report.sqlite.dbPath}`);
  console.log(`  File size: ${formatBytes(report.sqlite.dbFileBytes)}`);
  console.log("");
  console.log(
    `  ${"Table".padEnd(28)} ${"Rows".padStart(10)} ${"Est. Bytes".padStart(14)}`,
  );
  console.log(`  ${"-".repeat(28)} ${"-".repeat(10)} ${"-".repeat(14)}`);
  for (const t of report.sqlite.tables) {
    console.log(
      `  ${t.name.padEnd(28)} ${String(t.rowCount).padStart(10)} ${formatBytes(t.estimatedBytes).padStart(14)}`,
    );
  }

  console.log("\n## Logs\n");
  console.log(`  Total size: ${formatBytes(report.logs.totalBytes)}`);
  console.log(`  File count: ${report.logs.fileCount}`);
  console.log(`  Oldest:     ${report.logs.oldestMtime ?? "n/a"}`);
  console.log(`  Newest:     ${report.logs.newestMtime ?? "n/a"}`);

  console.log("\n## Terminal Events Scrollback\n");
  console.log(
    `  Payload + scrollback total: ${formatBytes(report.terminalEventsScrollback.totalBytes)}`,
  );
  console.log(`  Terminal panes:            ${report.terminalEventsScrollback.paneCount}`);
  console.log(
    `  Largest pane scrollback:    ${formatBytes(report.terminalEventsScrollback.maxPaneBytes)}`,
  );

  console.log("\n## Events by Type\n");
  if (report.eventsByType.length === 0) {
    console.log("  (no events)");
  } else {
    console.log(`  ${"Type".padEnd(28)} ${"Count".padStart(10)}`);
    console.log(`  ${"-".repeat(28)} ${"-".repeat(10)}`);
    for (const e of report.eventsByType) {
      console.log(`  ${e.type.padEnd(28)} ${String(e.count).padStart(10)}`);
    }
  }

  console.log("\n## Summary\n");
  console.log(`  Total DB file:     ${formatBytes(report.summary.totalDbBytes)}`);
  console.log(`  Total logs:        ${formatBytes(report.summary.totalLogBytes)}`);
  console.log(`  Prunable estimate: ${formatBytes(report.summary.prunableEstimateBytes)}`);
  console.log("");
  console.log("  Top consumers:");
  for (const c of report.summary.topConsumers) {
    console.log(`    ${c.label.padEnd(40)} ${formatBytes(c.bytes)}`);
  }
  console.log("");
}

// --- Main ------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const dbPath = join(args.userData, "ai-terminal.sqlite");
  const logsDir = join(args.userData, "logs");

  const { report: sqliteReport, tempPath } = await measureSqlite(dbPath);
  if (tempPath) {
    await rm(tempPath, { force: true });
  }

  const logs = await measureLogs(logsDir);

  // Use a shared temp dir for the secondary measurements.
  const tempDir = join(
    tmpdir(),
    `coterm-measure-extra-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await import("node:fs/promises").then((m) => m.mkdir(tempDir, { recursive: true }));

  const scrollback = await measureTerminalEventsScrollback(dbPath, tempDir);
  const eventsByType = await measureEventsByType(dbPath, tempDir);

  await rm(tempDir, { recursive: true, force: true });

  // Build top consumers list.
  const consumers: Array<{ label: string; bytes: number }> = [];
  for (const t of sqliteReport.tables) {
    consumers.push({ label: `table: ${t.name}`, bytes: t.estimatedBytes });
  }
  consumers.push({ label: "logs (total)", bytes: logs.totalBytes });
  consumers.push({
    label: "terminal_events payload + scrollback",
    bytes: scrollback.totalBytes,
  });
  consumers.sort((a, b) => b.bytes - a.bytes);

  // Prunable estimate: terminal_events + events tables bytes (these are the
  // whitelist tables for pruneOldData in Task 2).
  const teTable = sqliteReport.tables.find((t) => t.name === "terminal_events");
  const evtTable = sqliteReport.tables.find((t) => t.name === "events");
  const prunableEstimateBytes =
    (teTable?.estimatedBytes ?? 0) + (evtTable?.estimatedBytes ?? 0);

  const report: FootprintReport = {
    measuredAt: new Date().toISOString(),
    userDataPath: args.userData,
    sqlite: sqliteReport,
    logs,
    terminalEventsScrollback: scrollback,
    eventsByType,
    summary: {
      totalDbBytes: sqliteReport.dbFileBytes,
      totalLogBytes: logs.totalBytes,
      topConsumers: consumers.slice(0, 3),
      prunableEstimateBytes,
    },
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }
}

main().catch((error) => {
  console.error("Footprint measurement failed:", error);
  process.exit(1);
});
