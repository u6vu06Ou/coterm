import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import { createHash } from "node:crypto";
import type { BrowserDocument, BrowserSearchResult } from "@shared/browser-types";

export interface BrowserChunk {
  pageId: string;
  anchor: string;
  text: string;
}

export interface BrowserRelatedPage {
  title: string;
  url: string;
  direction: "out" | "in";
}

export interface BrowserIndexPage {
  id: string;
  url: string;
  host: string;
  title: string;
  fetchedAt: number;
  sha256: string;
  mdPath: string;
  textLen: number;
  projectId: string | null;
}

const SCHEMA_VERSION = 1;
const MAX_CHUNK_CHARS = 1200;
const RETENTION_DAYS = 90;
const RETENTION_MAX_PAGES = 2000;

/**
 * Disposable FTS5 trigram index over saved browser pages. Mirrors session-index.ts:
 * node:sqlite DatabaseSync, fts5(tokenize='trigram'), snippet(), LIKE fallback
 * for short queries. ponytail: single-process SQLite is plenty for a local
 * browser cache; shard only if sync is measured slow.
 */
export class BrowserIndex {
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
      CREATE TABLE IF NOT EXISTS pages (
        id TEXT PRIMARY KEY, url TEXT UNIQUE, host TEXT, title TEXT,
        fetched_at INTEGER NOT NULL DEFAULT 0, sha256 TEXT, md_path TEXT,
        text_len INTEGER NOT NULL DEFAULT 0, project_id TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        page_id UNINDEXED, anchor UNINDEXED, text, tokenize='trigram'
      );
      CREATE TABLE IF NOT EXISTS links (
        from_page TEXT NOT NULL, to_url TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pages_host ON pages(host);
      CREATE INDEX IF NOT EXISTS idx_pages_fetched ON pages(fetched_at);
      CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_page);
      CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_url);
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

  /** Look up an existing page by URL. Returns the row or undefined. */
  findByUrl(url: string): BrowserIndexPage | undefined {
    const db = this.open();
    const row = db.prepare("SELECT id, url, host, title, fetched_at, sha256, md_path, text_len, project_id FROM pages WHERE url = ?").get(url) as BrowserIndexPage | undefined;
    return row;
  }

  /**
   * Upsert a page + its chunks + links. sha256 dedup: if the content hash
   * matches an existing row for this URL, only fetched_at is refreshed and no
   * file rewrite or chunk re-indexing happens. Returns the page id.
   */
  upsertPage(input: {
    url: string;
    host: string;
    title: string;
    sha256: string;
    mdPath: string;
    textLen: number;
    projectId?: string | null;
    document: BrowserDocument;
  }): string {
    const db = this.open();
    const existing = db.prepare("SELECT id, sha256 FROM pages WHERE url = ?").get(input.url) as { id: string; sha256: string } | undefined;
    if (existing && existing.sha256 === input.sha256) {
      db.prepare("UPDATE pages SET fetched_at = ?, title = ? WHERE id = ?").run(Date.now(), input.title, existing.id);
      return existing.id;
    }
    const id = existing?.id ?? createHash("sha256").update(input.url).digest("hex").slice(0, 16);
    db.exec("BEGIN");
    try {
      if (existing) {
        db.prepare("DELETE FROM chunks_fts WHERE page_id = ?").run(id);
        db.prepare("DELETE FROM links WHERE from_page = ?").run(id);
      }
      db.prepare(
        `INSERT INTO pages (id, url, host, title, fetched_at, sha256, md_path, text_len, project_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           url=excluded.url, host=excluded.host, title=excluded.title,
           fetched_at=excluded.fetched_at, sha256=excluded.sha256, md_path=excluded.md_path,
           text_len=excluded.text_len, project_id=excluded.project_id`,
      ).run(id, input.url, input.host, input.title, Date.now(), input.sha256, input.mdPath, input.textLen, input.projectId ?? null);
      const insertChunk = db.prepare("INSERT INTO chunks_fts (page_id, anchor, text) VALUES (?, ?, ?)");
      for (const chunk of chunkDocument(id, input.document)) {
        insertChunk.run(chunk.pageId, chunk.anchor, chunk.text);
      }
      const insertLink = db.prepare("INSERT INTO links (from_page, to_url) VALUES (?, ?)");
      for (const link of input.document.links) {
        try {
          const resolved = new URL(link.url, input.url).toString();
          if (resolved !== input.url) insertLink.run(id, resolved);
        } catch {
          // malformed link — skip
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    this.enforceRetention();
    return id;
  }

  /**
   * Chunk-level FTS5 search. Queries >=3 codepoints use MATCH + snippet(); <3
   * fall back to LIKE (trigram tokenizer needs >=3 chars). Mirrors
   * session-index.ts:488-501. Never throws — query error → empty array.
   */
  search(input: { query: string; host?: string; projectId?: string | null; limit?: number }): BrowserSearchResult[] {
    const q = input.query.trim();
    const codePoints = Array.from(q).length;
    if (codePoints < 2) return [];
    try {
      const db = this.open();
      const rows = codePoints >= 3 ? this.ftsSearch(db, q) : this.likeSearch(db, q);
      return this.materialize(db, rows, input, input.limit ?? 20);
    } catch (error) {
      console.warn("[browser-index] search failed:", error);
      return [];
    }
  }

  private ftsSearch(db: DatabaseSync, q: string): Array<{ page_id: string; anchor: string; snip: string; rank: number }> {
    const phrase = `"${q.replaceAll('"', '""')}"`;
    return db.prepare(
      `SELECT page_id, anchor, snippet(chunks_fts, 2, '', '', '…', 12) AS snip, rank
       FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT 200`,
    ).all(phrase) as Array<{ page_id: string; anchor: string; snip: string; rank: number }>;
  }

  private likeSearch(db: DatabaseSync, q: string): Array<{ page_id: string; anchor: string; snip: string; rank: number }> {
    const escaped = q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    return db.prepare(
      `SELECT page_id, anchor, substr(text, max(1, instr(text, ?) - 30), 80) AS snip, 0 AS rank
       FROM chunks_fts WHERE text LIKE ? ESCAPE '\\' LIMIT 200`,
    ).all(q, `%${escaped}%`) as Array<{ page_id: string; anchor: string; snip: string; rank: number }>;
  }

  private materialize(
    db: DatabaseSync,
    rows: Array<{ page_id: string; anchor: string; snip: string; rank: number }>,
    input: { host?: string; projectId?: string | null },
    limit: number,
  ): BrowserSearchResult[] {
    const seen = new Set<string>();
    const hits: BrowserSearchResult[] = [];
    const pageStmt = db.prepare("SELECT url, title, host, project_id, md_path FROM pages WHERE id = ?");
    for (const row of rows) {
      const key = `${row.page_id}:${row.anchor}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const meta = pageStmt.get(row.page_id) as { url: string; title: string; host: string; project_id: string | null; md_path: string } | undefined;
      if (!meta) continue;
      if (input.host && meta.host !== input.host) continue;
      if (input.projectId && meta.project_id !== input.projectId) continue;
      hits.push({
        title: meta.title || meta.url,
        url: meta.url,
        snippet: row.snip,
        sourceFile: meta.md_path,
        chunkId: row.anchor || row.page_id,
        score: row.rank === 0 ? 1 : 1 / (1 + Math.abs(row.rank)),
      });
    }
    return hits
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
      .slice(0, limit);
  }

  /**
   * Related pages via the links table. Out = pages this page links to that we
   * have already fetched; in = pages that link to this one. ponytail: one
   * edges table + two JOINs, no graph DB.
   */
  related(input: { url?: string; pageId?: string; sameHostOnly?: boolean; limit?: number }): BrowserRelatedPage[] {
    if (!input.url && !input.pageId) return [];
    try {
      const db = this.open();
      let pageId = input.pageId;
      let pageUrl: string | undefined;
      if (!pageId && input.url) {
        const row = db.prepare("SELECT id, url FROM pages WHERE url = ?").get(input.url) as { id: string; url: string } | undefined;
        if (!row) return [];
        pageId = row.id;
        pageUrl = row.url;
      } else if (pageId) {
        const row = db.prepare("SELECT url FROM pages WHERE id = ?").get(pageId) as { url: string } | undefined;
        pageUrl = row?.url;
      }
      if (!pageId) return [];
      const limit = input.limit ?? 20;
      const hostFilter = input.sameHostOnly ? db.prepare("SELECT host FROM pages WHERE id = ?").get(pageId) as { host: string } | undefined : undefined;
      const targetHost = hostFilter?.host;
      const out = db.prepare(
        `SELECT p.title, p.url, p.host FROM links l JOIN pages p ON p.url = l.to_url
         WHERE l.from_page = ? ${targetHost ? "AND p.host = ?" : ""} LIMIT ?`,
      ).all(pageId, ...(targetHost ? [targetHost] : []), limit) as Array<{ title: string; url: string; host: string }>;
      const inLinks = db.prepare(
        `SELECT p.title, p.url, p.host FROM links l JOIN pages p ON p.id = l.from_page
         WHERE l.to_url = ? ${targetHost ? "AND p.host = ?" : ""} ${pageUrl ? "AND p.url <> ?" : ""} LIMIT ?`,
      ).all(pageUrl ?? "", ...(targetHost ? [targetHost] : []), ...(pageUrl ? [pageUrl] : []), limit) as Array<{ title: string; url: string; host: string }>;
      const seen = new Set<string>();
      const results: BrowserRelatedPage[] = [];
      for (const row of out) {
        if (seen.has(row.url)) continue;
        seen.add(row.url);
        results.push({ title: row.title || row.url, url: row.url, direction: "out" });
      }
      for (const row of inLinks) {
        if (seen.has(row.url)) continue;
        seen.add(row.url);
        results.push({ title: row.title || row.url, url: row.url, direction: "in" });
      }
      return results.slice(0, limit);
    } catch (error) {
      console.warn("[browser-index] related failed:", error);
      return [];
    }
  }

  /** Enforce 90-day or 2000-page LRU retention. ponytail: bounded cache, not an archive. */
  private enforceRetention(): void {
    try {
      const db = this.open();
      const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
      const stale = db.prepare("SELECT id, md_path FROM pages WHERE fetched_at < ? ORDER BY fetched_at ASC").all(cutoff) as Array<{ id: string; md_path: string }>;
      if (stale.length > 0) {
        db.exec("BEGIN");
        try {
          for (const row of stale) {
            db.prepare("DELETE FROM chunks_fts WHERE page_id = ?").run(row.id);
            db.prepare("DELETE FROM links WHERE from_page = ?").run(row.id);
            db.prepare("DELETE FROM pages WHERE id = ?").run(row.id);
          }
          db.exec("COMMIT");
          purgeFiles(stale);
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }
      const countRow = db.prepare("SELECT COUNT(*) AS n FROM pages").get() as { n: number };
      if (countRow.n > RETENTION_MAX_PAGES) {
        const excess = countRow.n - RETENTION_MAX_PAGES;
        const lru = db.prepare("SELECT id, md_path FROM pages ORDER BY fetched_at ASC LIMIT ?").all(excess) as Array<{ id: string; md_path: string }>;
        db.exec("BEGIN");
        try {
          for (const row of lru) {
            db.prepare("DELETE FROM chunks_fts WHERE page_id = ?").run(row.id);
            db.prepare("DELETE FROM links WHERE from_page = ?").run(row.id);
            db.prepare("DELETE FROM pages WHERE id = ?").run(row.id);
          }
          db.exec("COMMIT");
          purgeFiles(lru);
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }
    } catch (error) {
      console.warn("[browser-index] retention failed:", error);
    }
  }
}

/**
 * Delete the cached files behind evicted rows. Retention that only drops DB rows leaves the
 * markdown on disk forever, which is the growth the 90-day / 2000-page cap exists to bound.
 */
function purgeFiles(rows: Array<{ md_path: string }>): void {
  for (const row of rows) {
    if (!row.md_path) continue;
    rmSync(row.md_path, { force: true });
    rmSync(row.md_path.replace(/\.md$/, ".json"), { force: true });
  }
}

/**
 * Split a document into chunks at heading boundaries, each ≤1200 chars, with
 * the heading's anchor (or a synthetic one) attached. ponytail: heading-first
 * chunking keeps search hits scoped to a section, not a random 1200-char window.
 */
function chunkDocument(pageId: string, document: BrowserDocument): BrowserChunk[] {
  const chunks: BrowserChunk[] = [];
  const sections: { anchor: string; text: string }[] = [];
  if (document.headings.length === 0) {
    sections.push({ anchor: "top", text: document.text });
  } else {
    const headingPositions: { anchor: string; index: number }[] = [];
    for (const heading of document.headings) {
      const anchor = heading.anchor || slugify(heading.text) || `h${headingPositions.length + 1}`;
      const idx = document.text.indexOf(heading.text);
      headingPositions.push({ anchor, index: idx >= 0 ? idx : 0 });
    }
    headingPositions.sort((a, b) => a.index - b.index);
    for (let i = 0; i < headingPositions.length; i += 1) {
      const start = headingPositions[i]!.index;
      const end = i + 1 < headingPositions.length ? headingPositions[i + 1]!.index : document.text.length;
      sections.push({ anchor: headingPositions[i]!.anchor, text: document.text.slice(start, end) });
    }
  }
  for (const section of sections) {
    const text = section.text.trim();
    if (!text) continue;
    for (let i = 0; i < text.length; i += MAX_CHUNK_CHARS) {
      const slice = text.slice(i, i + MAX_CHUNK_CHARS);
      if (slice.trim()) {
        chunks.push({ pageId, anchor: section.anchor, text: slice });
      }
    }
  }
  return chunks.length > 0 ? chunks : [{ pageId, anchor: "top", text: document.text.slice(0, MAX_CHUNK_CHARS) }];
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}
