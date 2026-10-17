import { Worker } from "node:worker_threads";

interface WorkerReply {
  id: number;
  ok: boolean;
  elapsedMs?: number;
  error?: string;
}

export class SearchIndexWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (elapsedMs: number) => void; reject: (error: Error) => void }>();

  sync(databasePath: string, indexPath: string): Promise<number> {
    const worker = this.getWorker();
    const id = this.nextId++;
    return new Promise<number>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, databasePath, indexPath });
    });
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    for (const pending of this.pending.values()) pending.reject(new Error("Search index worker closed"));
    this.pending.clear();
    if (worker) await worker.terminate();
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    // Vitest and source-level Playwright helpers import this .ts module
    // directly; the packaged Electron main imports the bundled index.js.
    const runningFromSource = import.meta.url.endsWith(".ts");
    const entry = new URL(
      runningFromSource ? "./search-index-worker.ts" : "./search-index-worker.mjs",
      import.meta.url,
    );
    const worker = new Worker(entry, runningFromSource ? { execArgv: ["--import", "tsx"] } : undefined);
    worker.on("message", (reply: WorkerReply) => {
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      if (reply.ok) pending.resolve(reply.elapsedMs ?? 0);
      else pending.reject(new Error(reply.error ?? "Search index worker failed"));
    });
    const fail = (error: Error): void => {
      if (this.worker === worker) this.worker = null;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
    worker.on("error", fail);
    worker.on("exit", (code) => {
      if (code !== 0 && this.worker === worker) fail(new Error(`Search index worker exited with code ${code}`));
    });
    this.worker = worker;
    return worker;
  }
}
