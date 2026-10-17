import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import type { GlobalSearchResult } from "@shared/types";

export type LedgerSearchKind = Exclude<GlobalSearchResult["kind"], "session">;

export interface LedgerSearchDoc {
  kind: LedgerSearchKind;
  id: string;
  projectId: string | null;
  conversationId: string | null;
  terminalId: string | null;
  title: string;
  body: string;
}

export interface LedgerSearchHit extends LedgerSearchDoc {
  rowid: number;
}

const SCHEMA_VERSION = 1;

/** Terminal payloads are megabytes of PTY output; keep indexed bodies bounded. */
export const MAX_SEARCH_BODY_CHARS = 8_192;

/**
 * Disposable FTS5 trigram index over the ledger tables (projects,
 * conversations, events, terminal_events, handoffs, attachments). The ledger
 * itself is sql.js, whose WASM build has no FTS5 module ("no such module:
 * fts5"), so the index lives in a node:sqlite sidecar file next to the main
 * DB, mirroring session-index.ts/browser-index.ts. The index is a cache: the
 * ledger stays the source of truth, stale rows are filtered at read time, and
 * corruption or a SCHEMA_VERSION bump drops and rebuilds the whole file.
 */
export class LedgerSearchIndex {
  private db: DatabaseSync | null = null;

  constructor(private readonly dbPath: string) {}

  private open(): DatabaseSync {
    if (this.db) return this.db;
    try {
      this.db = this.connect();
    } catch (error) {
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
      CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
        kind UNINDEXED, entity_id UNINDEXED, project_id UNINDEXED,
        conversation_id UNINDEXED, terminal_id UNINDEXED, title, body,
        tokenize='trigram'
      );
      CREATE TABLE IF NOT EXISTS idx_state (
        source TEXT NOT NULL,
        source_rowid INTEGER NOT NULL,
        entity_id TEXT NOT NULL,
        PRIMARY KEY (source, source_rowid)
      );
      CREATE TABLE IF NOT EXISTS idx_meta (
        source TEXT PRIMARY KEY,
        signature TEXT NOT NULL
      );
    `);
  }

  private deleteDbFiles(): void {
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${this.dbPath}${suffix}`, { force: true });
    }
    this.db = null;
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // already closed
    }
    this.db = null;
  }

  beginBatch(): void {
    this.open().exec("BEGIN");
  }

  endBatch(commit: boolean): void {
    this.open().exec(commit ? "COMMIT" : "ROLLBACK");
  }

  signature(source: string): string | null {
    const row = this.open()
      .prepare("SELECT signature FROM idx_meta WHERE source = ?")
      .get(source) as { signature: string } | undefined;
    return row?.signature ?? null;
  }

  setSignature(source: string, signature: string): void {
    this.open()
      .prepare("INSERT OR REPLACE INTO idx_meta (source, signature) VALUES (?, ?)")
      .run(source, signature);
  }

  /**
   * True when this source rowid is already indexed for the same entity id.
   * Rowids can be reused after deletion of the table's max rowid, so the
   * entity id is part of the check: a reused rowid with a different id forces
   * re-indexing of the new row.
   */
  isIndexed(source: string, sourceRowid: number, entityId: string): boolean {
    const row = this.open()
      .prepare("SELECT entity_id FROM idx_state WHERE source = ? AND source_rowid = ?")
      .get(source, sourceRowid) as { entity_id: string } | undefined;
    return row !== undefined && row.entity_id === entityId;
  }

  upsert(source: string, sourceRowid: number, doc: LedgerSearchDoc): void {
    const db = this.open();
    const existing = db
      .prepare("SELECT entity_id FROM idx_state WHERE source = ? AND source_rowid = ?")
      .get(source, sourceRowid) as { entity_id: string } | undefined;
    if (existing && existing.entity_id !== doc.id) {
      db.prepare("DELETE FROM docs WHERE kind = ? AND entity_id = ?").run(source, existing.entity_id);
    }
    const body = doc.body.length > MAX_SEARCH_BODY_CHARS ? doc.body.slice(0, MAX_SEARCH_BODY_CHARS) : doc.body;
    db.prepare(
      `INSERT INTO docs (kind, entity_id, project_id, conversation_id, terminal_id, title, body)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(doc.kind, doc.id, doc.projectId, doc.conversationId, doc.terminalId, doc.title, body);
    db.prepare(
      "INSERT OR REPLACE INTO idx_state (source, source_rowid, entity_id) VALUES (?, ?, ?)",
    ).run(source, sourceRowid, doc.id);
  }

  /** Drop every indexed row for one source (used for the small, mutable tables). */
  resetSource(source: LedgerSearchKind): void {
    const db = this.open();
    db.prepare("DELETE FROM docs WHERE kind = ?").run(source);
    db.prepare("DELETE FROM idx_state WHERE source = ?").run(source);
  }

  /**
   * Terms >= 3 codepoints go through FTS5 MATCH as an AND of quoted phrases
   * (trigram = substring match, case-insensitive). Any shorter term falls back
   * to LIKE over all terms, since the trigram tokenizer cannot match under 3
   * chars — mirrors session-index.ts:446.
   */
  search(terms: string[], maxRows = 200): LedgerSearchHit[] {
    const db = this.open();
    if (terms.every((term) => Array.from(term).length >= 3)) {
      const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" ");
      return db.prepare(
        `SELECT rowid, kind, entity_id AS id, project_id AS projectId,
                conversation_id AS conversationId, terminal_id AS terminalId, title, body
         FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT ?`,
      ).all(match, maxRows) as unknown as LedgerSearchHit[];
    }
    const where = terms.map(() => "body LIKE ? ESCAPE '\\'").join(" AND ");
    const patterns = terms.map((term) => `%${escapeLike(term)}%`);
    return db.prepare(
      `SELECT rowid, kind, entity_id AS id, project_id AS projectId,
              conversation_id AS conversationId, terminal_id AS terminalId, title, body
       FROM docs WHERE ${where} LIMIT ?`,
    ).all(...patterns, maxRows) as unknown as LedgerSearchHit[];
  }
}

function escapeLike(term: string): string {
  return term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
