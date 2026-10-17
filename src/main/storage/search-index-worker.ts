import { parentPort } from "node:worker_threads";
import { syncLedgerSearchIndex } from "./search-index-sync";

interface SyncRequest {
  id: number;
  databasePath: string;
  indexPath: string;
}

if (!parentPort) throw new Error("search-index-worker must run inside a worker thread");

parentPort.on("message", (request: SyncRequest) => {
  try {
    const result = syncLedgerSearchIndex(request.databasePath, request.indexPath);
    parentPort?.postMessage({ id: request.id, ok: true, ...result });
  } catch (error) {
    parentPort?.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
