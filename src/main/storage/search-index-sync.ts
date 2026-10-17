import { rmSync, statSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { ConversationSummary } from "@shared/schema";
import { LedgerSearchIndex, type LedgerSearchDoc, type LedgerSearchKind } from "./search-index";

interface SearchSyncRow {
  rid: number;
  id: string;
  projectId: string | null;
  conversationId: string | null;
  terminalId?: string | null;
  type?: string;
  summary?: string;
  payloadJson?: string;
  sourceProfile?: string;
  targetProfile?: string;
  packetJson?: string;
  name?: string;
  localPath?: string;
  mimeType?: string;
}

interface SearchIndexSyncResult {
  elapsedMs: number;
}

/** Sidecar budget: past this the file is runaway accumulation, not an index. */
export const MAX_SEARCH_INDEX_BYTES = 2 * 1024 * 1024 * 1024;

// Yield slot for the inter-batch sleep below (Atomics.wait needs a shared
// buffer; the value never changes, only the timeout matters).
const YIELD_SLOT = new Int32Array(new SharedArrayBuffer(4));
/**
 * This sync runs in a worker thread, so it cannot block the main event loop —
 * but its read I/O still competes with foreground writes (typing) for the
 * disk. WAL already gives writers lock-level priority; sleeping a few ms
 * between 1,000-row batches additionally spreads a ~200 MB rescan over a
 * longer window so writer I/O always wins. Blocking-sleep is safe here: this
 * whole module only ever runs inside the search-index worker thread.
 */
const INTER_BATCH_YIELD_MS = 3;

/**
 * The sidecar is effectively append-only across syncs: rows trimmed from the
 * ledger (terminal event retention, scrub migrations) leave ghosts in the FTS
 * file, and upserts never delete stale entities. Once the file blows the
 * budget, drop it entirely — the sync below rebuilds every live source from
 * the read-only ledger on the same run.
 */
export function dropSearchIndexIfOversized(indexPath: string, maxBytes = MAX_SEARCH_INDEX_BYTES): void {
  let size: number;
  try {
    size = statSync(indexPath).size;
  } catch {
    return;
  }
  if (size <= maxBytes) return;
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${indexPath}${suffix}`, { force: true });
  }
}

/** Build the disposable FTS sidecar from a read-only ledger connection. */
export function syncLedgerSearchIndex(databasePath: string, indexPath: string): SearchIndexSyncResult {
  dropSearchIndexIfOversized(indexPath);
  const startedAt = Date.now();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  database.exec("PRAGMA busy_timeout=5000");
  const index = new LedgerSearchIndex(indexPath);
  try {
    syncSearchIndex(database, index);
    return { elapsedMs: Date.now() - startedAt };
  } finally {
    index.close();
    database.close();
  }
}

function all<T>(database: DatabaseSync, sql: string, params?: Record<string, SQLInputValue>): T[] {
  const statement = database.prepare(sql);
  return (params ? statement.all(params) : statement.all()) as T[];
}

function one<T>(database: DatabaseSync, sql: string): T | null {
  return all<T>(database, sql)[0] ?? null;
}

function syncSearchIndex(database: DatabaseSync, index: LedgerSearchIndex): void {
  index.beginBatch();
  try {
    index.resetSource("project");
    for (const row of all<{ rid: number; id: string; name: string; workspace_path: string }>(
      database,
      "SELECT rowid AS rid, id, name, workspace_path FROM projects WHERE archived = 0",
    )) {
      index.upsert("project", row.rid, {
        kind: "project", id: row.id, projectId: row.id, conversationId: null, terminalId: null,
        title: row.name, body: `${row.name} ${row.workspace_path}`,
      });
    }

    index.resetSource("conversation");
    for (const row of all<{ rid: number; id: string; project_id: string; name: string; summary_json: string | null }>(
      database,
      `SELECT c.rowid AS rid, c.id, c.project_id, c.name, c.summary_json
       FROM conversations c JOIN projects p ON p.id = c.project_id
       WHERE c.archived = 0 AND p.archived = 0`,
    )) {
      const summary = parseSummary(row.summary_json);
      index.upsert("conversation", row.rid, {
        kind: "conversation", id: row.id, projectId: row.project_id, conversationId: row.id, terminalId: null,
        title: row.name, body: `${row.name} ${summary?.brief ?? ""} ${summary?.recentSummary ?? ""}`,
      });
    }

    syncRows(database, index, "event", "SELECT MAX(rowid) AS maxRowid, COUNT(*) AS n FROM events",
      `SELECT e.rowid AS rid, e.id, e.conversation_id AS conversationId, c.project_id AS projectId,
              e.type, e.summary, e.payload_json AS payloadJson
       FROM events e JOIN conversations c ON c.id = e.conversation_id
       WHERE e.rowid > $cursor ORDER BY e.rowid LIMIT $limit`,
      (row) => ({ kind: "event", id: row.id, projectId: row.projectId, conversationId: row.conversationId,
        terminalId: null, title: row.type ?? "", body: `${row.summary ?? ""} ${row.payloadJson ?? ""}` }));
    syncRows(database, index, "terminal", "SELECT MAX(rowid) AS maxRowid, COUNT(*) AS n FROM terminal_events",
      `SELECT rowid AS rid, id, project_id AS projectId, terminal_id AS terminalId,
              type, summary, payload_json AS payloadJson
       FROM terminal_events WHERE rowid > $cursor ORDER BY rowid LIMIT $limit`,
      (row) => ({ kind: "terminal", id: row.id, projectId: row.projectId, conversationId: null,
        terminalId: row.terminalId ?? null, title: row.type ?? "", body: `${row.summary ?? ""} ${row.payloadJson ?? ""}` }));
    syncRows(database, index, "handoff", "SELECT MAX(rowid) AS maxRowid, COUNT(*) AS n FROM handoffs",
      `SELECT h.rowid AS rid, h.id, h.conversation_id AS conversationId, c.project_id AS projectId,
              h.source_profile AS sourceProfile, h.target_profile AS targetProfile, h.packet_json AS packetJson
       FROM handoffs h JOIN conversations c ON c.id = h.conversation_id
       WHERE h.rowid > $cursor ORDER BY h.rowid LIMIT $limit`,
      (row) => ({ kind: "handoff", id: row.id, projectId: row.projectId, conversationId: row.conversationId,
        terminalId: null, title: `${row.sourceProfile ?? ""} -> ${row.targetProfile ?? ""}`, body: row.packetJson ?? "" }));
    syncRows(database, index, "artifact", "SELECT MAX(rowid) AS maxRowid, COUNT(*) AS n FROM attachments",
      `SELECT a.rowid AS rid, a.id, a.conversation_id AS conversationId, c.project_id AS projectId,
              a.name, a.local_path AS localPath, a.mime_type AS mimeType
       FROM attachments a JOIN conversations c ON c.id = a.conversation_id
       WHERE a.rowid > $cursor ORDER BY a.rowid LIMIT $limit`,
      (row) => ({ kind: "artifact", id: row.id, projectId: row.projectId, conversationId: row.conversationId,
        terminalId: null, title: row.name ?? "", body: `${row.name ?? ""} ${row.localPath ?? ""} ${row.mimeType ?? ""}` }));
    index.endBatch(true);
  } catch (error) {
    index.endBatch(false);
    throw error;
  }
}

function syncRows(
  database: DatabaseSync,
  index: LedgerSearchIndex,
  source: LedgerSearchKind,
  countSql: string,
  fetchSql: string,
  toDoc: (row: SearchSyncRow) => LedgerSearchDoc,
): void {
  const stats = one<{ maxRowid: number | null; n: number }>(database, countSql);
  const signature = `${stats?.maxRowid ?? 0}:${stats?.n ?? 0}`;
  if (index.signature(source) === signature) return;
  const batchSize = 1_000;
  let cursor = 0;
  while (true) {
    const rows = all<SearchSyncRow>(database, fetchSql, { $cursor: cursor, $limit: batchSize });
    if (rows.length === 0) break;
    for (const row of rows) {
      if (!index.isIndexed(source, row.rid, row.id)) index.upsert(source, row.rid, toDoc(row));
      cursor = row.rid;
    }
    if (rows.length < batchSize) break;
    Atomics.wait(YIELD_SLOT, 0, 0, INTER_BATCH_YIELD_MS);
  }
  index.setSignature(source, signature);
}

function parseSummary(raw: string | null): ConversationSummary | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ConversationSummary>;
    return typeof value === "object" && value !== null ? value as ConversationSummary : null;
  } catch {
    return null;
  }
}
