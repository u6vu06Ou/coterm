import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityMonitor, isIgnoredActivityPath } from "../../src/main/terminal/activity-monitor";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("sidebar activity monitor", () => {
  let dir: string | null = null;
  let monitor: ActivityMonitor | null = null;

  afterEach(async () => {
    monitor?.stop();
    monitor = null;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("skips git internals and installed packages", () => {
    expect(isIgnoredActivityPath(".git/objects/ab/cdef")).toBe(true);
    expect(isIgnoredActivityPath("web\\node_modules\\x\\index.js")).toBe(true);
    expect(isIgnoredActivityPath("src/app.ts")).toBe(false);
    expect(isIgnoredActivityPath(".github/workflows/ci.yml")).toBe(false);
  });

  it("counts files the agents write after launch, not before", async () => {
    dir = await mkdtemp(join(tmpdir(), "coterm-activity-"));
    await writeFile(join(dir, "old.txt"), "already here");
    const root = dir;
    monitor = new ActivityMonitor({ listRoots: () => [root, root, ""] });
    monitor.start();
    const first = monitor.getSnapshot();
    expect(first.watchedRoots).toBe(1);
    expect(first.agentFiles).toBe(0);
    expect(first.memTotalBytes).toBeGreaterThan(0);

    await sleep(150);
    await writeFile(join(dir, "made-by-agent.md"), "x".repeat(1000));
    await mkdir(join(dir, "node_modules"));
    await writeFile(join(dir, "node_modules", "pkg.js"), "y".repeat(5000));

    let snapshot = monitor.getSnapshot();
    for (let i = 0; i < 40 && snapshot.agentFiles === 0; i += 1) {
      await sleep(200);
      snapshot = monitor.getSnapshot();
    }
    expect(snapshot.agentFiles).toBe(1);
    expect(snapshot.agentBytes).toBe(1000);
  }, 15_000);

  it("never watches a drive root", () => {
    monitor = new ActivityMonitor({ listRoots: () => ["C:\\", "/"] });
    expect(monitor.getSnapshot().watchedRoots).toBe(0);
  });

  it("listFiles returns size-first entries with baselineSize and caps at the limit", async () => {
    dir = await mkdtemp(join(tmpdir(), "coterm-activity-list-"));
    const root = dir;
    monitor = new ActivityMonitor({ listRoots: () => [root] });
    monitor.start();
    // getSnapshot() is what creates the watchers (syncRoots) — call it before
    // writing or the creation event happens with no watcher attached.
    const initial = monitor.getSnapshot();
    expect(initial.watchedRoots).toBe(1);
    expect(initial.agentFiles).toBe(0);

    await sleep(150);
    const first = join(dir, "one.md");
    await writeFile(first, "a".repeat(300));
    let snapshot = monitor.getSnapshot();
    for (let i = 0; i < 40 && snapshot.agentFiles === 0; i += 1) {
      await sleep(200);
      snapshot = monitor.getSnapshot();
    }
    expect(snapshot.agentFiles).toBe(1);

    await sleep(150);
    const second = join(dir, "two.md");
    await writeFile(second, "b".repeat(5));

    snapshot = monitor.getSnapshot();
    for (let i = 0; i < 40 && snapshot.agentFiles < 2; i += 1) {
      await sleep(200);
      snapshot = monitor.getSnapshot();
    }
    expect(snapshot.agentFiles).toBe(2);

    // Sorted largest first (2026-10-12 maintainer — find where the fat data is):
    // the newer 5-byte file is NOT first, size wins over mtime.
    const listing = monitor.listFiles();
    expect(listing.total).toBe(2);
    expect(listing.files).toHaveLength(2);
    const [largest, smallest] = listing.files;
    if (!largest || !smallest) throw new Error("expected two file entries");
    expect(largest.path.toLowerCase()).toBe(first.toLowerCase());
    expect(smallest.path.toLowerCase()).toBe(second.toLowerCase());
    expect(largest.size).toBe(300);
    expect(smallest.size).toBe(5);
    expect(smallest.mtimeMs).toBeGreaterThanOrEqual(largest.mtimeMs);
    // Created files: baseline 0, so the whole size is this session's growth.
    expect(largest.baselineSize).toBe(0);
    expect(smallest.baselineSize).toBe(0);
    // Birthtime on/after launch (stat'd fresh inside the tempdir) ⇒ created.
    expect(largest.kind).toBe("created");
    expect(smallest.kind).toBe("created");

    // The cap keeps the LARGEST file, not the newest.
    const capped = monitor.listFiles(1);
    expect(capped.total).toBe(2);
    expect(capped.files).toHaveLength(1);
    const cappedLargest = capped.files[0];
    if (!cappedLargest) throw new Error("expected capped listing");
    expect(cappedLargest.path.toLowerCase()).toBe(first.toLowerCase());

    // Missing files drop out on the next flush after deletion.
    await rm(first, { force: true });
    let pruned = monitor.listFiles();
    for (let i = 0; i < 40 && pruned.total !== 1; i += 1) {
      await sleep(200);
      pruned = monitor.listFiles();
    }
    expect(pruned.total).toBe(1);
  }, 15_000);

  it("keeps the first-sight size as the baseline for a modified file's growth delta", async () => {
    dir = await mkdtemp(join(tmpdir(), "coterm-activity-delta-"));
    // Pre-launch file (birthtime before start) ⇒ tracked only via post-launch
    // changes, kind "modified".
    const target = join(dir, "grow.log");
    await writeFile(target, "already here");
    // Windows sets the file's creation timestamp with sub-ms precision, so a
    // constructor immediately after the write can straddle it (birthtime
    // landing AFTER startedAt reads as "created"). A real gap makes the
    // pre-launch birthtime unambiguously before startedAt.
    await sleep(100);
    const root = dir;
    monitor = new ActivityMonitor({ listRoots: () => [root] });
    monitor.start();
    expect(monitor.getSnapshot().watchedRoots).toBe(1);

    await sleep(150);
    await writeFile(target, "already here" + "x".repeat(24));
    let listing = monitor.listFiles();
    for (let i = 0; i < 40 && listing.total === 0; i += 1) {
      await sleep(200);
      listing = monitor.listFiles();
    }
    expect(listing.total).toBe(1);
    const seen = listing.files[0];
    if (!seen) throw new Error("expected the modified file entry");
    expect(seen.kind).toBe("modified");
    expect(seen.baselineSize).toBe(36); // first sight: after the first append

    await sleep(150);
    await writeFile(target, "already here" + "x".repeat(56));
    let grown = monitor.listFiles();
    for (let i = 0; i < 40 && (grown.files[0]?.size ?? 0) <= (seen.size ?? 0); i += 1) {
      await sleep(200);
      grown = monitor.listFiles();
    }
    const entry = grown.files[0];
    if (!entry) throw new Error("expected the grown entry");
    expect(entry.size).toBe(68);
    // The baseline is frozen at first sight; the delta is only what grew after it.
    expect(entry.baselineSize).toBe(36);
    expect(entry.size - entry.baselineSize).toBe(32);
    // The total counts only that growth, never the old file's full size.
    expect(monitor.getSnapshot().agentBytes).toBe(32);
  }, 20_000);

  it("caps tracked files at maxTrackedFiles without evicting tracked entries", async () => {
    dir = await mkdtemp(join(tmpdir(), "coterm-activity-cap-"));
    const root = dir;
    monitor = new ActivityMonitor({ listRoots: () => [root], maxTrackedFiles: 2 });
    monitor.start();
    const initial = monitor.getSnapshot();
    expect(initial.watchedRoots).toBe(1);
    expect(initial.agentFiles).toBe(0);

    await sleep(150);
    const updated = join(dir, "a.txt");
    await writeFile(join(dir, "a.txt"), "x");
    await writeFile(join(dir, "b.txt"), "y".repeat(50));
    let snapshot = monitor.getSnapshot();
    for (let i = 0; i < 40 && snapshot.agentFiles < 2; i += 1) {
      await sleep(200);
      snapshot = monitor.getSnapshot();
    }
    expect(snapshot.agentFiles).toBe(2);

    // Beyond the cap: a tracked file keeps updating, a new file is skipped.
    await writeFile(join(dir, "c.txt"), "z".repeat(9));
    await writeFile(updated, "x".repeat(40));
    let listing = monitor.listFiles();
    let seen = listing.files.find((entry) => entry.path.toLowerCase().endsWith("a.txt"));
    for (let i = 0; i < 40 && (seen?.size ?? 0) !== 40; i += 1) {
      await sleep(200);
      listing = monitor.listFiles();
      seen = listing.files.find((entry) => entry.path.toLowerCase().endsWith("a.txt"));
    }
    expect(seen?.size).toBe(40); // the flush DID run after the cap hit
    expect(listing.total).toBe(2); // c.txt was skipped, nothing evicted
    expect(listing.files.some((entry) => entry.path.toLowerCase().endsWith("c.txt"))).toBe(false);
  }, 20_000);

  it("listFiles falls back safely on odd limits and empty monitor", () => {
    monitor = new ActivityMonitor({ listRoots: () => [] });
    expect(monitor.listFiles()).toEqual({ files: [], total: 0 });
    expect(monitor.listFiles(-5)).toEqual({ files: [], total: 0 });
    expect(monitor.listFiles(Number.NaN)).toEqual({ files: [], total: 0 });
  });
});
