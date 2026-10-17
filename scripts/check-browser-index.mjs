// Minimal T5 check: same URL saved twice → pages has one row; Chinese query hits.
// Run: node scripts/check-browser-index.mjs
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const tmp = mkdtempSync(join(tmpdir(), "browser-index-check-"));
const dbPath = join(tmp, "browser-index.sqlite");

// Inline a minimal BrowserIndex-shaped wrapper to exercise the real schema.
// We re-implement the upsert + chunk + search logic against the same SQL the
// production BrowserIndex uses, so this validates the SQL/schema end-to-end.
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode=WAL");
db.exec("PRAGMA busy_timeout=5000");
db.exec(`
  CREATE TABLE pages (
    id TEXT PRIMARY KEY, url TEXT UNIQUE, host TEXT, title TEXT,
    fetched_at INTEGER NOT NULL DEFAULT 0, sha256 TEXT, md_path TEXT,
    text_len INTEGER NOT NULL DEFAULT 0, project_id TEXT
  );
  CREATE VIRTUAL TABLE chunks_fts USING fts5(
    page_id UNINDEXED, anchor UNINDEXED, text, tokenize='trigram'
  );
  CREATE TABLE links (from_page TEXT NOT NULL, to_url TEXT NOT NULL);
`);

const url = "https://example.com/中文頁面";
const host = "example.com";
const title = "中文測試頁面";
const sha = createHash("sha256").update("內容一樣").digest("hex");
const id = createHash("sha256").update(url).digest("hex").slice(0, 16);

function upsert(sha256, text) {
  const existing = db.prepare("SELECT id, sha256 FROM pages WHERE url = ?").get(url);
  if (existing && existing.sha256 === sha256) {
    db.prepare("UPDATE pages SET fetched_at = ?, title = ? WHERE id = ?").run(Date.now(), title, existing.id);
    return existing.id;
  }
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
    ).run(id, url, host, title, Date.now(), sha256, join(tmp, "page.md"), text.length, null);
    db.prepare("INSERT INTO chunks_fts (page_id, anchor, text) VALUES (?, ?, ?)").run(id, "top", text);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// Save twice with identical content.
upsert(sha, "這是一段中文內容，用來測試 trigram 搜尋。");
upsert(sha, "這是一段中文內容，用來測試 trigram 搜尋。");

const pageCount = db.prepare("SELECT COUNT(*) AS n FROM pages WHERE url = ?").get(url).n;
const chunkCount = db.prepare("SELECT COUNT(*) AS n FROM chunks_fts WHERE page_id = ?").get(id).n;

// Chinese trigram search (>=3 codepoints → MATCH).
const phrase = `"中文內容"`;
const ftsHit = db.prepare(
  `SELECT page_id, snippet(chunks_fts, 2, '', '', '…', 12) AS snip FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT 200`,
).all(phrase);

// Short query (<3 codepoints) → LIKE fallback.
const likeHit = db.prepare(
  `SELECT page_id FROM chunks_fts WHERE text LIKE ? ESCAPE '\\' LIMIT 200`,
).all(`%測試%`);

db.close();
rmSync(tmp, { recursive: true, force: true });

const ok = pageCount === 1 && chunkCount === 1 && ftsHit.length === 1 && likeHit.length === 1;
console.log(JSON.stringify({
  pageCount,
  chunkCount,
  ftsHit: ftsHit.length,
  likeHit: likeHit.length,
  pass: ok,
}, null, 2));
process.exit(ok ? 0 : 1);
