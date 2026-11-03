import { execFile } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";

const item = z.object({ path: z.string(), logical: z.number().nonnegative(), physical: z.number().nonnegative() });
const reportSchema = z.object({
  schema: z.literal("voltdir.overview/1"),
  totals: z.object({ files: z.number(), dirs: z.number(), logical: z.number(), physical: z.number() }),
  top_files: z.object({ items: z.array(item).max(100) }),
  top_dirs: z.object({ items: z.array(item).max(100) }),
  coverage: z.object({ incomplete_dirs: z.number().nonnegative(),
    errors: z.record(z.string(), z.number().nonnegative()).optional(), truncated: z.boolean().optional() }),
});
export type DiskOverviewReport = z.infer<typeof reportSchema> & { root: string; scannedAt: number; partial: boolean };

/** On-demand metadata scan, never a background full-tree poll. One process globally. */
export class DiskOverview {
  private readonly cache = new Map<string, DiskOverviewReport>();
  private running: { key: string; promise: Promise<DiskOverviewReport> } | null = null;

  constructor(private readonly run: (root: string) => Promise<unknown> = runVoltDir,
    private readonly now: () => number = Date.now) {}

  async get(root: string): Promise<DiskOverviewReport> {
    const key = root.toLowerCase();
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.scannedAt < 60_000) return cached;
    if (this.running) {
      if (this.running.key === key) return this.running.promise;
      throw new Error("另一個資料夾正在盤點，請稍後再試。");
    }
    const promise = this.run(root).then((raw) => {
      const report = reportSchema.parse(raw);
      const partial = report.coverage.incomplete_dirs > 0 || report.coverage.truncated === true
        || Object.values(report.coverage.errors ?? {}).some((count) => count > 0);
      const result = { ...report, root, scannedAt: this.now(), partial };
      if (this.cache.size >= 16) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, result);
      return result;
    }).finally(() => { this.running = null; });
    this.running = { key, promise };
    return promise;
  }
}

function runVoltDir(root: string): Promise<unknown> {
  const bundled = join(process.resourcesPath ?? "", "voltdir", "voltdir.exe");
  const development = join(process.cwd(), "resources", "voltdir", "voltdir.exe");
  const executable = existsSync(bundled) ? bundled : existsSync(development) ? development : "voltdir";
  return new Promise((resolve, reject) => {
    execFile(executable, ["overview", root, "--engine", "walk", "--threads", "1", "--top", "20",
      "--timeout-sec", "25", "--quiet", "--exclude", "*/node_modules/*", "--exclude", "*/.git/*"],
    { windowsHide: true, timeout: 30_000, maxBuffer: 256 * 1024, encoding: "utf8" }, (error, stdout) => {
      // Exit 2 contains a valid partial report (unreadable directories).
      if (error && error.code !== 2) {
        reject(new Error("資料夾盤點未完成；請稍後重試或縮小專案範圍。"));
        return;
      }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error("盤點結果格式無法讀取。")); }
    });
  });
}
