import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { migrations } from "./migrations";

export type SqlParams = Record<string, unknown> | unknown[];

// node:sqlite (DatabaseSync) — replaces sql.js (2026-08-06, ledger-bloat work
// order). sql.js held the whole DB in memory and persist() re-serialized +
// rewrote the entire file after EVERY committed transaction; at a 1.37 GB
// ledger each write cost a 1.37 GB export, so the serialized transaction queue
// never drained and even a settings toggle appeared dead. With a file-backed
// engine a COMMIT writes only changed pages, so persist() is a no-op.
//
// Behavior differences from sql.js that this wrapper must smooth over:
// 1. Named-parameter binding THROWS on object keys the statement does not
//    mention; sql.js silently ignored them and several call sites pass a
//    conditionally-built superset (e.g. finalizeCheckpoint). We filter to the
//    $name/:name/@name tokens present in the SQL.
// 2. Positional "?" parameters must be passed as varargs, not an array.
// 3. Bound values must be string/number/bigint/null/Uint8Array — booleans and
//    undefined are coerced (1/0, null) the way sql.js tolerated them.
const NAMED_PARAM_PATTERN = /[$:@][A-Za-z_][A-Za-z0-9_]*/g;

function coerceParamValue(value: unknown): SQLInputValue {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === undefined || value === null) return null;
  return value as SQLInputValue;
}

function filterNamedParams(sql: string, params: Record<string, unknown>): Record<string, SQLInputValue> {
  const mentioned = new Set<string>();
  for (const match of sql.matchAll(NAMED_PARAM_PATTERN)) mentioned.add(match[0]);
  const filtered: Record<string, SQLInputValue> = {};
  for (const [key, value] of Object.entries(params)) {
    if (mentioned.has(key)) filtered[key] = coerceParamValue(value);
  }
  return filtered;
}

export class AppDatabase {
  private db: DatabaseSync | null = null;
  private transactionQueue: Promise<void> = Promise.resolve();
  private readonly transactionContext = new AsyncLocalStorage<boolean>();
  private closing = false;

  constructor(readonly path: string) {}

  async open(): Promise<void> {
    this.closing = false;
    await mkdir(dirname(this.path), { recursive: true });
    const db = new DatabaseSync(this.path);
    // WAL (write-ahead log): readers (the search-index worker's read-only
    // connection re-scanning the ledger) never block writers, and writers
    // never wait on readers. Under the rollback journal, that rescan held a
    // shared read lock across a ~200 MB read while every write (e.g. a
    // terminal-event append on each typed keystroke batch) stalled behind it
    // — the "typing freezes the whole window" root cause. journal_mode is
    // persistent in the DB header, so this is a no-op after first open.
    // The -wal/-shm sidecars this creates are handled on the backup/restore
    // paths below (VACUUM INTO produces single-file snapshots; sidecars are
    // wiped around the restore file swap).
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    this.db = db;
    this.migrate();
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  async closeWhenIdle(): Promise<void> {
    this.closing = true;
    await this.transactionQueue;
    this.close();
  }

  get schemaVersion(): number {
    const row = this.queryOne<{ version: number }>(
      "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
    );
    return row?.version ?? 0;
  }

  run(sql: string, params: SqlParams = {}): void {
    const statement = this.requireDb().prepare(sql);
    if (Array.isArray(params)) {
      statement.run(...params.map(coerceParamValue));
    } else {
      statement.run(filterNamedParams(sql, params));
    }
  }

  queryAll<T>(sql: string, params: SqlParams = {}): T[] {
    const statement = this.requireDb().prepare(sql);
    if (Array.isArray(params)) {
      return statement.all(...params.map(coerceParamValue)) as T[];
    }
    return statement.all(filterNamedParams(sql, params)) as T[];
  }

  queryOne<T>(sql: string, params: SqlParams = {}): T | null {
    return this.queryAll<T>(sql, params)[0] ?? null;
  }

  async transaction<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.transactionContext.getStore()) {
      return operation();
    }
    if (this.closing) throw new Error("Database is closing.");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.transactionQueue;
    this.transactionQueue = previous.then(() => gate);
    await previous;

    try {
      return await this.transactionContext.run(true, async () => {
        const db = this.requireDb();
        let committed = false;
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = await operation();
          db.exec("COMMIT");
          committed = true;
          return result;
        } catch (error) {
          if (!committed) db.exec("ROLLBACK");
          throw error;
        }
      });
    } finally {
      release();
    }
  }

  // node:sqlite persists every COMMIT straight to the DB file, so the old
  // sql.js whole-image export is gone. Kept as an async no-op: repository and
  // migration-replay tests still call it to demarcate "make it durable".
  async persist(): Promise<void> {}

  async backup(destination: string): Promise<void> {
    await mkdir(dirname(destination), { recursive: true });
    // VACUUM INTO is SQLite's online backup: it yields a consistent,
    // standalone single-file snapshot of the committed state without taking
    // the write lock (and under WAL it does not block concurrent readers or
    // writers). It refuses to overwrite an existing file and cannot run
    // inside a transaction, hence no transaction() wrapper here.
    await rm(destination, { force: true });
    await this.vacuumInto(destination);
  }

  async restore(source: string): Promise<void> {
    const staging = `${this.path}.restore`;
    const recovery = `${this.path}.before-restore`;
    await this.removeSidecars(staging);
    await copyFile(source, staging);

    const validation = new AppDatabase(staging);
    try {
      await validation.open();
      if (validation.schemaVersion < migrations.at(-1)!.version) {
        throw new Error("Backup schema is incomplete.");
      }
    } finally {
      validation.close();
      await this.removeSidecars(staging);
    }

    // Snapshot the pre-restore state as a standalone single file (same
    // reasoning as backup()).
    await rm(recovery, { force: true });
    await this.vacuumInto(recovery);
    await this.closeWhenIdle();
    try {
      // Swapping the main file: a -wal/-shm surviving from the OLD database
      // would be replayed onto the NEW file on next open and corrupt it, so
      // sidecars must be gone before and after the copy.
      await this.removeSidecars(this.path);
      await copyFile(staging, this.path);
      await this.removeSidecars(this.path);
      await this.open();
    } catch (error) {
      await this.removeSidecars(this.path);
      await copyFile(recovery, this.path);
      await this.removeSidecars(this.path);
      await this.open();
      throw error;
    } finally {
      await this.removeSidecars(staging);
      await rm(staging, { force: true });
    }
  }

  // VACUUM INTO does not consult the busy handler, so a momentarily locked
  // source (e.g. an in-flight write COMMIT) fails with SQLITE_BUSY — retry a
  // few times instead of failing the user's backup.
  private async vacuumInto(destination: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        this.requireDb().prepare("VACUUM INTO ?").run(destination);
        return;
      } catch (error) {
        const busy = error instanceof Error && /busy|locked/i.test(error.message);
        if (!busy || attempt >= 5) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
      }
    }
  }

  // Delete a database's -wal/-shm sidecars (and stale rollback -journal).
  // The last connection to close a WAL database normally removes these
  // itself, but another handle (the search-index worker mid-sync) can hold
  // them briefly, so retry instead of trusting one shot. Failing while a
  // sidecar is open is fine: the caller then refuses to swap the file.
  private async removeSidecars(databasePath: string): Promise<void> {
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      for (let attempt = 1; ; attempt++) {
        try {
          await rm(`${databasePath}${suffix}`, { force: true });
          break;
        } catch (error) {
          if (attempt >= 5) throw error;
          await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
        }
      }
    }
  }

  private migrate(): void {
    const db = this.requireDb();
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    const current = this.schemaVersion;
    for (const migration of migrations.filter((item) => item.version > current)) {
      db.exec("BEGIN");
      try {
        for (const statement of migration.statements) {
          db.exec(statement);
        }
        if (migration.run) migration.run(this);
        db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(
          migration.version,
          new Date().toISOString(),
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  private requireDb(): DatabaseSync {
    if (!this.db) {
      throw new Error("Database is not open.");
    }
    return this.db;
  }
}
