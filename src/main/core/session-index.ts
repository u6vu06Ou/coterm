import { DatabaseSync } from "node:sqlite";
import { createReadStream, rmSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Project, ProviderProfileId } from "@shared/types";
import { inferProfileId, owningProject } from "./claude-history";
import { redactSecrets } from "../security/redaction";

export interface SessionSearchHit {
  nativeSessionId: string;
  projectId: string;
  title: string;
  snippet: string;
  updatedAt: string;
  profileId: ProviderProfileId;
}

const SYNC_THROTTLE_MS = 10_000;
const MAX_TEXT = 20_000;
const SCHEMA_VERSION = 2;
/** Vacuum only after this many free pages pile up (~4 MB at 4 KB pages). */
const VACUUM_FREELIST_PAGES_MIN = 1_000;
/** At most one vacuum per day, so sync stays off the hot path. */
const VACUUM_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const INJECTION_PREFIXES = [
  "<system-reminder",
  "<command-name>",
  "<local-command-stdout",
  "<task-notification",
  "<teammate-message",
  "Caveat:",
  "[Request interrupted",
];

interface FileRow {
  path: string;
  size: number;
  mtime: number;
  offset: number;
  cwd: string | null;
  indexed: number;
  session_id: string | null;
}

/**
 * Detect a subagent transcript and return its parent session id. Layout
 * (verified on disk): proj/parentSessionId/subagents/agent-*.jsonl, optionally
 * under a workflows/wf_X subfolder. The parent is the directory name
 * immediately above "subagents". Returns null for main-session files and for
 * journal.jsonl (different schema, skipped).
 */
function subagentParent(file: string): string | null {
  const norm = file.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/subagents/");
  if (idx < 0) return null;
  const before = norm.slice(0, idx);
  const parent = before.slice(before.lastIndexOf("/") + 1);
  if (!parent) return null;
  // journal.jsonl lives under subagents/ too but has a different schema — skip it.
  if (norm.endsWith("/journal.jsonl")) return null;
  return parent;
}

/**
 * Disposable FTS5 trigram index over Claude Code session jsonl files.
 * Background-synced; search is synchronous and never throws (corruption →
 * rebuild, query error → empty array). ponytail: single-process SQLite is
 * plenty for one user's ~2.6k session files; shard only if sync is measured slow.
 */
export class SessionIndex {
  private db: DatabaseSync | null = null;
  private lastSyncFinishedAt = 0;
  private lastVacuumAtMs = 0;
  private inFlight: Promise<void> | null = null;
  private syncing = false;
  private lastCompletedAtIso: string | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly claudeRoot: string,
    private readonly throttleMs: number = SYNC_THROTTLE_MS,
  ) {}

  private open(): DatabaseSync {
    if (this.db) return this.db;
    try {
      this.db = this.connect();
    } catch (error) {
      // Corruption → drop db + sidecars and rebuild from scratch.
      const msg = error instanceof Error ? error.message : String(error);
      if (!/malformed|not a database|database disk image/i.test(msg)) throw error;
      this.deleteDbFiles();
      this.db = this.connect();
    }
    return this.db;
  }

  private connect(): DatabaseSync {
    const db = new DatabaseSync(this.dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("PRAGMA synchronous=NORMAL");
    // Schema versioning: bump SCHEMA_VERSION when the layout changes. Older DBs
    // are dropped wholesale (the index is a disposable cache; full rebuild is
    // ~5.6s) rather than ALTERed in place. ponytail: no migration path — if a
    // future change needs to preserve data, add an ALTER branch then.
    const version = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    if ((version?.user_version ?? 0) < SCHEMA_VERSION) {
      db.close();
      this.deleteDbFiles();
      const fresh = new DatabaseSync(this.dbPath);
      fresh.exec("PRAGMA journal_mode=WAL");
      fresh.exec("PRAGMA busy_timeout=5000");
      fresh.exec("PRAGMA synchronous=NORMAL");
      this.createSchema(fresh);
      fresh.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      this.db = fresh;
      return fresh;
    }
    this.createSchema(db);
    return db;
  }

  private createSchema(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY, size INTEGER NOT NULL DEFAULT 0, mtime INTEGER NOT NULL DEFAULT 0,
        offset INTEGER NOT NULL DEFAULT 0, cwd TEXT, indexed INTEGER NOT NULL DEFAULT 0, session_id TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        native_session_id TEXT PRIMARY KEY, file TEXT NOT NULL, cwd TEXT,
        title TEXT, ai_title TEXT, model TEXT, updated_at TEXT,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        cache_read INTEGER NOT NULL DEFAULT 0,
        cache_creation INTEGER NOT NULL DEFAULT 0
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        session_id UNINDEXED, text, tokenize='trigram'
      );
    `);
  }

  private deleteDbFiles(): void {
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${this.dbPath}${suffix}`, { force: true });
    }
    this.db = null;
  }

  /** Close the SQLite handle. Safe to call multiple times; sync after close reopens. */
  close(): void {
    try {
      this.db?.close();
    } catch {
      // already closed
    }
    this.db = null;
  }

  async sync(projects: Project[]): Promise<void> {
    if (Date.now() - this.lastSyncFinishedAt < this.throttleMs) return;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doSync(projects).finally(() => {
      this.lastSyncFinishedAt = Date.now();
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /**
   * Snapshot of index sync state for UI hints. `syncing` is true while a
   * doSync is in flight; `lastCompletedAt` is the ISO time of the most recent
   * successful doSync finish (null until the first sync completes). Distinct
   * from lastSyncFinishedAt (a ms throttle timestamp) — do not reuse it.
   */
  status(): { syncing: boolean; lastCompletedAt: string | null } {
    return { syncing: this.syncing, lastCompletedAt: this.lastCompletedAtIso };
  }

  private async doSync(projects: Project[]): Promise<void> {
    this.syncing = true;
    try {
      const db = this.open();
      const diskFiles = await this.files();
      for (const file of diskFiles) {
        try {
          await this.syncFile(db, file, projects);
        } catch (error) {
          console.warn(`[session-index] sync failed for ${file}:`, error);
        }
      }
      try {
        this.reconcile(db, diskFiles);
      } catch (error) {
        console.warn("[session-index] reconcile failed:", error);
      }
      this.maybeVacuum(db);
    } finally {
      this.syncing = false;
      this.lastCompletedAtIso = new Date().toISOString();
    }
  }

  /**
   * Drop index rows for jsonl files that no longer exist on disk (deleted
   * sessions). Main-session file gone → wipeSession (fts + sessions row) and
   * delete every files row attributed to that session_id (including its
   * subagent rows). Subagent file gone → delete only that one files row; fts
   * residue is tolerated because the session_id is the parent's and must not
   * be wiped (that would nuke the still-live parent's search hits).
   */
  private reconcile(db: DatabaseSync, diskFiles: string[]): void {
    const disk = new Set(diskFiles);
    const rows = db.prepare("SELECT path, session_id FROM files").all() as Array<{ path: string; session_id: string | null }>;
    const missing = rows.filter((row) => !disk.has(row.path));
    if (missing.length === 0) return;
    db.exec("BEGIN");
    try {
      for (const row of missing) {
        if (subagentParent(row.path) === null) {
          // Main session file: wipe the whole session if we know its id.
          if (row.session_id) {
            this.wipeSession(db, row.session_id);
            db.prepare("DELETE FROM files WHERE session_id = ?").run(row.session_id);
          } else {
            db.prepare("DELETE FROM files WHERE path = ?").run(row.path);
          }
        } else {
          // Subagent file: delete only this row. fts rows carry the parent
          // session_id and are left intact (see method doc).
          db.prepare("DELETE FROM files WHERE path = ?").run(row.path);
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  private async syncFile(db: DatabaseSync, file: string, projects: Project[]): Promise<void> {
    const info = await stat(file);
    const row = db.prepare("SELECT * FROM files WHERE path = ?").get(file) as FileRow | undefined;
    if (row && row.size === info.size && row.mtime === Math.floor(info.mtimeMs)) return;

    const nativeSessionId = basename(file, ".jsonl");
    const parentSessionId = subagentParent(file);
    const isSubagent = parentSessionId !== null;
    // Subagent hits attribute to the parent session (so search lands on the
    // resumable main session). Main-session files use their own id.
    const effectiveSessionId = parentSessionId ?? nativeSessionId;
    // Truncated file (size shrank below last offset) → re-read from 0. For
    // subagent files we must NOT wipeSession — that deletes the parent's fts
    // rows. Just reset this file's offset; stale fts rows are tolerated (the
    // index is disposable, occasional duplicate hits are acceptable).
    if (row && info.size < row.offset) {
      if (!isSubagent) this.wipeSession(db, nativeSessionId);
      db.prepare("UPDATE files SET offset = 0, size = 0, mtime = 0, indexed = 0 WHERE path = ?").run(file);
    }
    const startOffset = row?.offset ?? 0;

    const insertFts = db.prepare("INSERT INTO messages_fts (session_id, text) VALUES (?, ?)");
    // COALESCE keeps metadata captured in earlier chunks: an incremental read
    // starts past the head, so title/aiTitle/model would otherwise be wiped.
    const upsertSession = db.prepare(
      `INSERT INTO sessions (native_session_id, file, cwd, title, ai_title, model, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(native_session_id) DO UPDATE SET
         file=excluded.file, cwd=excluded.cwd,
         title=COALESCE(title, excluded.title),
         ai_title=COALESCE(excluded.ai_title, ai_title),
         model=COALESCE(model, excluded.model),
         updated_at=excluded.updated_at`,
    );
    // Incremental token accumulation — never overwrite, always add. For
    // subagent files this targets the parent row; if the parent hasn't been
    // upserted yet (rare ordering) this affects 0 rows, which is acceptable.
    const addTokens = db.prepare(
      `UPDATE sessions SET
         tokens_in = tokens_in + ?,
         tokens_out = tokens_out + ?,
         cache_read = cache_read + ?,
         cache_creation = cache_creation + ?
       WHERE native_session_id = ?`,
    );

    let offset = startOffset;
    let cwd = row?.cwd ?? "";
    let title = "";
    let aiTitle: string | null = null;
    let model = "";
    let updatedAt = "";
    // Subagent files often carry no cwd of their own — pre-seed from the parent
    // session row (already upserted, since main files sync first) so project
    // attribution and fts inserts work during the scan, not just after.
    if (isSubagent && !cwd) {
      const parent = db.prepare("SELECT cwd FROM sessions WHERE native_session_id = ?").get(effectiveSessionId) as { cwd: string | null } | undefined;
      if (parent?.cwd) cwd = parent.cwd;
    }
    let project = cwd ? owningProject(cwd, projects) : undefined;
    let tokensIn = 0;
    let tokensOut = 0;
    let cacheRead = 0;
    let cacheCreation = 0;

    db.exec("BEGIN");
    try {
      const lines = createInterface({ input: createReadStream(file, { start: startOffset }), crlfDelay: Infinity });
      let firstLine = true;
      let drift = false;
      for await (const line of lines) {
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(line) as Record<string, unknown>;
        } catch {
          // Partial trailing line — stop without advancing offset past it.
          // If the very FIRST line of an incremental read is unparseable, the
          // stored offset no longer sits on a line boundary → full re-read.
          drift = firstLine && startOffset > 0;
          break;
        }
        firstLine = false;
        if (!cwd && typeof record.cwd === "string") {
          cwd = record.cwd;
          project = owningProject(cwd, projects);
        }
        if (typeof record.timestamp === "string" && record.timestamp) updatedAt = record.timestamp;
        if (!aiTitle && typeof record.aiTitle === "string" && record.aiTitle.trim()) {
          aiTitle = record.aiTitle.trim();
        }
        const message = record.message as Record<string, unknown> | undefined;
        if (message) {
          if (!model && typeof message.model === "string" && message.model) {
            model = message.model;
          }
          // Token usage lives on assistant records as message.usage. Missing
          // fields count as 0. Subagent usage rolls up to the parent session.
          const usage = message.usage as Record<string, unknown> | undefined;
          if (usage) {
            tokensIn += numOrZero(usage.input_tokens);
            tokensOut += numOrZero(usage.output_tokens);
            cacheRead += numOrZero(usage.cache_read_input_tokens);
            cacheCreation += numOrZero(usage.cache_creation_input_tokens);
          }
        }
        const text = projectedText(record);
        if (text && project) {
          if (!title) title = text.replace(/\s+/g, " ").slice(0, 100);
          insertFts.run(effectiveSessionId, text);
        }
        offset += Buffer.byteLength(line, "utf8") + 1;
      }
      if (drift) {
        if (!isSubagent) this.wipeSession(db, nativeSessionId);
        db.prepare("UPDATE files SET offset = 0, size = 0, mtime = 0, indexed = 0 WHERE path = ?").run(file);
        db.exec("COMMIT");
        // Recursion is bounded: the retry reads from offset 0, where a parse
        // failure no longer counts as drift.
        return this.syncFile(db, file, projects);
      }
      const indexed = project ? 1 : 0;
      const finalUpdatedAt = updatedAt || info.mtime.toISOString();
      db.prepare(
        `INSERT INTO files (path, size, mtime, offset, cwd, indexed, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           size=excluded.size, mtime=excluded.mtime, offset=excluded.offset,
           cwd=excluded.cwd, indexed=excluded.indexed, session_id=excluded.session_id`,
      ).run(file, info.size, Math.floor(info.mtimeMs), offset, cwd || null, indexed, effectiveSessionId);
      if (isSubagent) {
        // Subagent files never own a sessions row — title/aiTitle/model/
        // updated_at belong to the parent. Only roll token usage up to it.
        if (project && (tokensIn || tokensOut || cacheRead || cacheCreation)) {
          addTokens.run(tokensIn, tokensOut, cacheRead, cacheCreation, effectiveSessionId);
        }
      } else if (project) {
        upsertSession.run(
          effectiveSessionId, file, cwd,
          title || null, aiTitle, model || null, finalUpdatedAt,
        );
        if (tokensIn || tokensOut || cacheRead || cacheCreation) {
          addTokens.run(tokensIn, tokensOut, cacheRead, cacheCreation, effectiveSessionId);
        }
      } else {
        // cwd doesn't map to a known Coterm project — keep file row (indexed=0)
        // so a later sweep can backfill, but drop any session metadata.
        db.prepare("DELETE FROM sessions WHERE native_session_id = ?").run(effectiveSessionId);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  private wipeSession(db: DatabaseSync, nativeSessionId: string): void {
    db.prepare("DELETE FROM messages_fts WHERE session_id = ?").run(nativeSessionId);
    db.prepare("DELETE FROM sessions WHERE native_session_id = ?").run(nativeSessionId);
  }

  private async files(): Promise<string[]> {
    const root = resolve(this.claudeRoot);
    const directories = await readdir(root, { withFileTypes: true }).catch(() => []);
    const main: string[] = [];
    const subagents: string[] = [];
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      const folder = join(root, directory.name);
      for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          main.push(join(folder, entry.name));
        } else if (entry.isDirectory()) {
          // A session directory (named like a session id) may hold a subagents/
          // subtree. Collect those after the main jsonls so the parent sessions
          // row exists before subagent rows roll token usage up to it.
          const subDir = join(folder, entry.name, "subagents");
          await this.collectSubagents(subDir, subagents, 0);
        }
      }
    }
    return [...main, ...subagents];
  }

  /**
   * Occasional vacuum: reclaim pages freed by reconcile/sync pruning, but
   * only when a meaningful amount has piled up and at most once a day, so
   * this stays off the search hot path. Never throws.
   */
  private maybeVacuum(db: DatabaseSync): void {
    try {
      const now = Date.now();
      if (now - this.lastVacuumAtMs < VACUUM_MIN_INTERVAL_MS) return;
      const row = db.prepare("PRAGMA freelist_count").get() as { freelist_count?: number } | undefined;
      const freePages = row?.freelist_count ?? 0;
      if (freePages < VACUUM_FREELIST_PAGES_MIN) return;
      db.exec("VACUUM");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      this.lastVacuumAtMs = now;
      console.log(`[session-index] vacuum reclaimed ${freePages} free pages`);
    } catch (error) {
      console.warn("[session-index] vacuum failed:", error);
    }
  }

  /**
   * Recursively collect subagent transcripts under a subagents dir. Depth
   * capped at 4 to guard against an accidental tree explosion. journal.jsonl
   * is skipped (different schema). ponytail: depth limit is a backstop, not a
   * real constraint — the known layout is subagents/agent-*.jsonl, optionally
   * under workflows/wf_X.
   */
  private async collectSubagents(dir: string, out: string[], depth: number): Promise<void> {
    if (depth > 4) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name !== "journal.jsonl") {
        out.push(path);
      } else if (entry.isDirectory()) {
        await this.collectSubagents(path, out, depth + 1);
      }
    }
  }

  search(query: string, projects: Project[], limit: number): SessionSearchHit[] {
    const q = query.trim();
    const codePoints = Array.from(q).length;
    if (codePoints < 2) return [];
    try {
      const db = this.open();
      const rows = codePoints >= 3 ? this.ftsSearch(db, q) : this.likeSearch(db, q);
      return this.materialize(db, rows, projects, limit);
    } catch (error) {
      console.warn("[session-index] search failed:", error);
      return [];
    }
  }

  /**
   * Look up accumulated token usage for a batch of sessions. Synchronous,
   * never throws (query error → empty map). ids are queried in batches of 500
   * to stay under SQLite's variable limit. ponytail: one round-trip per batch
   * is fine for the history panel's ~dozens of sessions; switch to a temp table
   * if a panel ever shows thousands.
   */
  stats(nativeSessionIds: string[]): Map<string, { tokensIn: number; tokensOut: number; cacheRead: number; cacheCreation: number }> {
    const out = new Map<string, { tokensIn: number; tokensOut: number; cacheRead: number; cacheCreation: number }>();
    if (nativeSessionIds.length === 0) return out;
    try {
      const db = this.open();
      for (let i = 0; i < nativeSessionIds.length; i += 500) {
        const batch = nativeSessionIds.slice(i, i + 500);
        const placeholders = batch.map(() => "?").join(",");
        const rows = db.prepare(
          `SELECT native_session_id, tokens_in, tokens_out, cache_read, cache_creation
           FROM sessions WHERE native_session_id IN (${placeholders})`,
        ).all(...batch) as Array<{ native_session_id: string; tokens_in: number; tokens_out: number; cache_read: number; cache_creation: number }>;
        for (const row of rows) {
          out.set(row.native_session_id, {
            tokensIn: row.tokens_in,
            tokensOut: row.tokens_out,
            cacheRead: row.cache_read,
            cacheCreation: row.cache_creation,
          });
        }
      }
    } catch (error) {
      console.warn("[session-index] stats failed:", error);
    }
    return out;
  }

  private ftsSearch(db: DatabaseSync, q: string): Array<{ session_id: string; snip: string }> {
    const phrase = `"${q.replaceAll('"', '""')}"`;
    return db.prepare(
      `SELECT session_id, snippet(messages_fts, 1, '', '', '…', 12) AS snip
       FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rank LIMIT 200`,
    ).all(phrase) as Array<{ session_id: string; snip: string }>;
  }

  private likeSearch(db: DatabaseSync, q: string): Array<{ session_id: string; snip: string }> {
    const escaped = q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    return db.prepare(
      `SELECT session_id, substr(text, max(1, instr(text, ?) - 30), 80) AS snip
       FROM messages_fts WHERE text LIKE ? ESCAPE '\\' LIMIT 200`,
    ).all(q, `%${escaped}%`) as Array<{ session_id: string; snip: string }>;
  }

  private materialize(
    db: DatabaseSync,
    rows: Array<{ session_id: string; snip: string }>,
    projects: Project[],
    limit: number,
  ): SessionSearchHit[] {
    const seen = new Set<string>();
    const hits: SessionSearchHit[] = [];
    const sessionStmt = db.prepare("SELECT native_session_id, cwd, title, ai_title, model, updated_at FROM sessions WHERE native_session_id = ?");
    for (const row of rows) {
      if (seen.has(row.session_id)) continue;
      seen.add(row.session_id);
      const meta = sessionStmt.get(row.session_id) as
        | { cwd: string | null; title: string | null; ai_title: string | null; model: string | null; updated_at: string }
        | undefined;
      if (!meta || !meta.cwd) continue;
      const project = owningProject(meta.cwd, projects);
      if (!project) continue;
      hits.push({
        nativeSessionId: row.session_id,
        projectId: project.id,
        title: meta.ai_title || meta.title || row.session_id,
        snippet: row.snip,
        updatedAt: meta.updated_at,
        profileId: inferProfileId(meta.model ?? ""),
      });
    }
    return hits
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }
}

function numOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Extract indexable text from a jsonl record: user/assistant text blocks only.
 * Skips thinking / tool_use / tool_result / image. Drops injection-prefixed
 * user turns. Mirrors claude-history.ts projectedMessage but without the
 * firstPrompt/title coupling (we want every message, not just the first).
 */
function projectedText(record: Record<string, unknown>): string | null {
  const message = record.message;
  if (!message || typeof message !== "object") return null;
  const value = message as Record<string, unknown>;
  if (value.role !== "user" && value.role !== "assistant") return null;
  const content = value.content;
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .flatMap((block) => {
        if (!block || typeof block !== "object") return [];
        const item = block as Record<string, unknown>;
        return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
      })
      .join("\n");
  } else {
    return null;
  }
  if (value.role === "user") {
    const trimmed = text.trimStart();
    if (INJECTION_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return null;
  }
  const redacted = redactSecrets(text).trim().slice(0, MAX_TEXT);
  return redacted || null;
}
