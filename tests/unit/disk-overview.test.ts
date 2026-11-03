import { describe, it, expect, vi } from "vitest";
import { DiskOverview } from "../../src/main/terminal/disk-overview";

const report = () => ({ schema: "voltdir.overview/1", totals: { files: 2, dirs: 1, logical: 123, physical: 4096 },
  top_files: { items: [{ path: "report.md", logical: 123, physical: 4096 }] },
  top_dirs: { items: [] }, coverage: { incomplete_dirs: 0 } });

describe("on-demand disk overview", () => {
  it("shares in-flight work, caches for one minute, then refreshes", async () => {
    let now = 0;
    const run = vi.fn(async () => report());
    const service = new DiskOverview(run, () => now);
    const [first, second] = await Promise.all([service.get("D:\\Project"), service.get("d:\\project")]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    now = 59_999;
    expect(await service.get("D:\\Project")).toEqual(first);
    now = 60_001;
    expect((await service.get("D:\\Project")).scannedAt).toBe(now);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not spawn a second scan for another root while one is running", async () => {
    let complete!: (value: unknown) => void;
    const run = vi.fn(() => new Promise<unknown>((resolve) => { complete = resolve; }));
    const service = new DiskOverview(run);
    const first = service.get("D:\\a");
    await expect(service.get("D:\\b")).rejects.toThrow("正在盤點");
    expect(run).toHaveBeenCalledTimes(1);
    complete(report());
    await first;
  });

  it("recovers from malformed output without caching a false success", async () => {
    const run = vi.fn().mockResolvedValueOnce({}).mockResolvedValue(report());
    const service = new DiskOverview(run);
    await expect(service.get("D:\\a")).rejects.toThrow();
    expect((await service.get("D:\\a")).totals.files).toBe(2);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("marks unreadable folders as partial", async () => {
    const service = new DiskOverview(async () => ({ ...report(), coverage: { incomplete_dirs: 3 } }));
    expect((await service.get("D:\\a")).partial).toBe(true);
  });

  it("marks time-limited and errored scans as partial even without incomplete directories", async () => {
    for (const coverage of [{ incomplete_dirs: 0, truncated: true }, { incomplete_dirs: 0, errors: { denied: 1 } }]) {
      const service = new DiskOverview(async () => ({ ...report(), coverage }));
      expect((await service.get("D:\\a")).partial).toBe(true);
    }
  });
});
