import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  pruneAgedFiles,
  pruneBrowserProfiles,
  pruneCodexHomes,
  rotateDatabaseBackups,
  runStorageHousekeeping,
} from "../../src/main/storage/housekeeping";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("storage housekeeping", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "coterm-housekeeping-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const age = async (path: string, daysAgo: number): Promise<void> => {
    const then = new Date(Date.now() - daysAgo * DAY_MS);
    await utimes(path, then, then);
  };

  describe("rotateDatabaseBackups", () => {
    it("keeps the newest 2 backups and deletes older ones + leftover .restore", async () => {
      const userData = join(root, "userData");
      const ledgerDir = join(root, "ledger");
      await mkdir(userData, { recursive: true });
      await mkdir(ledgerDir, { recursive: true });
      const ledger = join(ledgerDir, "ai-terminal.sqlite");
      await writeFile(ledger, "ledger");
      await age(ledger, 1);
      for (const [name, days] of [
        ["bak-a", 10],
        ["bak-b", 5],
        ["bak-c", 1],
      ] as const) {
        const p = join(userData, name);
        await writeFile(p, name);
        await age(p, days);
      }
      const beforeRestore = join(ledgerDir, "ai-terminal.sqlite.before-restore");
      await writeFile(beforeRestore, "recovery");
      await age(beforeRestore, 0.2);
      const staleRestore = join(ledgerDir, "ai-terminal.sqlite.restore");
      await writeFile(staleRestore, "staging");

      const summary = await rotateDatabaseBackups({
        ledgerPath: ledger,
        userDataPath: userData,
        keep: 2,
      });

      expect(summary.deleted).toBe(3); // bak-a + bak-b (pool) + leftover .restore
      expect(summary.kept).toBe(2); // before-restore (0.2d) + bak-c (1d)
      await expect(stat(beforeRestore)).resolves.toBeTruthy();
      await expect(stat(join(userData, "bak-c"))).resolves.toBeTruthy();
      await expect(stat(join(userData, "bak-a"))).rejects.toThrow();
      await expect(stat(join(userData, "bak-b"))).rejects.toThrow();
      await expect(stat(staleRestore)).rejects.toThrow();
      await expect(stat(ledger)).resolves.toBeTruthy();
    });
  });

  describe("pruneAgedFiles", () => {
    it("deletes only old files and removes emptied dirs", async () => {
      const dir = join(root, "leftovers");
      const oldDir = join(dir, "2026-08-01");
      const freshDir = join(dir, "2026-09-20");
      await mkdir(oldDir, { recursive: true });
      await mkdir(freshDir, { recursive: true });
      await writeFile(join(oldDir, "a.wav"), "x");
      await writeFile(join(freshDir, "b.wav"), "y");
      await age(join(oldDir, "a.wav"), 40);
      await age(join(freshDir, "b.wav"), 1);

      const summary = await pruneAgedFiles({ dir, maxAgeMs: 30 * DAY_MS });

      expect(summary.deleted).toBe(1);
      await expect(stat(join(freshDir, "b.wav"))).resolves.toBeTruthy();
      await expect(stat(oldDir)).rejects.toThrow(); // emptied dir removed
    });
  });

  describe("pruneCodexHomes", () => {
    it("deletes the archived dead profile outright and caps only stale files", async () => {
      const userData = await mkdtemp(join(tmpdir(), "coterm-codex-"));
      const homes = join(userData, "codex-homes");
      await mkdir(homes, { recursive: true });
      const dead = join(homes, "codex-local-max");
      await mkdir(join(dead, "sessions"), { recursive: true });
      await writeFile(join(dead, "sessions", "x.json"), "x");
      const live = join(homes, "codex-local-main");
      await mkdir(live, { recursive: true });
      await writeFile(join(live, "config.toml"), "cfg");
      await writeFile(join(live, "auth.json"), "auth");
      await writeFile(join(live, "old.log"), "x".repeat(2000));
      await writeFile(join(live, "new.log"), "y".repeat(50));
      await age(join(live, "old.log"), 5);
      await age(join(live, "new.log"), 0.1);

      const summary = await pruneCodexHomes({
        userDataPath: userData,
        homeCapBytes: 1000,
        totalCapBytes: 10000,
        minAgeMs: DAY_MS,
      });

      expect(summary.deleted).toBe(2); // dead profile dir + old.log (per-home cap pruning)
      await expect(stat(dead)).rejects.toThrow();
      await expect(stat(join(live, "config.toml"))).resolves.toBeTruthy();
      await expect(stat(join(live, "auth.json"))).resolves.toBeTruthy();
      await expect(stat(join(live, "new.log"))).resolves.toBeTruthy();
      await expect(stat(join(live, "old.log"))).rejects.toThrow();
      await rm(userData, { recursive: true, force: true });
    });
  });

  describe("pruneBrowserProfiles", () => {
    it("deletes the oldest stale profile under cap and skips fresh ones", async () => {
      const userData = join(root, "userData");
      const profs = join(userData, "browser-profiles");
      await mkdir(profs, { recursive: true });
      const oldDir = join(profs, "2026-08-01T10-00-00");
      const freshDir = join(profs, "2026-09-20T10-00-00");
      await mkdir(oldDir, { recursive: true });
      await mkdir(freshDir, { recursive: true });
      await writeFile(join(oldDir, "a.txt"), "x".repeat(800));
      await writeFile(join(freshDir, "b.txt"), "y".repeat(800));
      await age(join(oldDir, "a.txt"), 5);
      await age(join(freshDir, "b.txt"), 0.1);
      await age(oldDir, 5); // the dir's own mtime counts as "touched"

      const summary = await pruneBrowserProfiles({
        userDataPath: userData,
        capBytes: 1000,
        minAgeMs: DAY_MS,
      });

      expect(summary.deleted).toBe(1);
      await expect(stat(oldDir)).rejects.toThrow();
      await expect(stat(freshDir)).resolves.toBeTruthy();
    });
  });

  describe("runStorageHousekeeping", () => {
    it("runs all sweeps and reports a combined summary", async () => {
      const userData = join(root, "userData");
      const ledger = join(userData, "ai-terminal.sqlite");
      await mkdir(userData, { recursive: true });
      await writeFile(ledger, "ledger");
      await mkdir(join(userData, "uploads"), { recursive: true });
      const stale = join(userData, "uploads", "old.bin");
      await writeFile(stale, "x");
      await age(stale, 10);

      const summary = await runStorageHousekeeping({ ledgerPath: ledger, userDataPath: userData });

      expect(summary.totalDeleted).toBe(1);
      expect(summary.sweeps).toHaveLength(4);
      expect(summary.durationMs).toBeGreaterThanOrEqual(0);
      await expect(stat(ledger)).resolves.toBeTruthy();
    });
  });
});
