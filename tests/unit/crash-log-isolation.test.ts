// Phase 0C retry (review P1): writeCrashLog must never hard-code the stable
// "%APPDATA%\Coterm" dir. The sink is <userData>\logs\crash.log where
// userData is the channel-resolved dir passed by the bootstrap. Stable and
// Beta crashes land in different files with zero cross-writes.
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeCrashLog } from "../../src/main/core/logger";
import { resolveAppIdentity } from "../../src/main/core/app-identity";

describe("writeCrashLog channel isolation (Phase 0C)", () => {
  let base: string;
  let stableData: string;
  let betaData: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "coterm-crash-"));
    stableData = join(base, resolveAppIdentity("1.4.11", {}).userDataDirName);
    betaData = join(base, resolveAppIdentity("1.5.0-beta.1", {}).userDataDirName);
    vi.stubEnv("COTERM_USER_DATA_DIR", "");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(base, { recursive: true, force: true });
  });

  it("channel-resolved userData dirs differ (beta is never the stable dir)", () => {
    expect(betaData).not.toBe(stableData);
  });

  it("a beta crash lands in beta's logs only — the stable sink stays absent", async () => {
    writeCrashLog(new Error("beta boom"), betaData);
    const betaLine = await readFile(join(betaData, "logs", "crash.log"), "utf8");
    expect(betaLine).toContain("beta boom");
    await expect(access(join(stableData, "logs", "crash.log"))).rejects.toThrow();
  });

  it("a stable crash lands in stable's logs only — no beta cross-write", async () => {
    writeCrashLog(new Error("stable boom"), stableData);
    const stableLine = await readFile(join(stableData, "logs", "crash.log"), "utf8");
    expect(stableLine).toContain("stable boom");
    await expect(access(join(betaData, "logs", "crash.log"))).rejects.toThrow();
  });

  it("repeated crashes append to the same channel sink", async () => {
    writeCrashLog(new Error("one"), betaData);
    writeCrashLog(new Error("two"), betaData);
    const log = await readFile(join(betaData, "logs", "crash.log"), "utf8");
    // Each crash appends one "[<iso>]" entry line (stack frames follow on
    // their own lines); count entries, not physical lines.
    expect(log.split("\n").filter((line) => line.startsWith("[2"))).toHaveLength(2);
    expect(log).toContain("one");
    expect(log).toContain("two");
  });

  it("the no-arg fallback honors COTERM_USER_DATA_DIR (test/e2e override) only", async () => {
    vi.stubEnv("COTERM_USER_DATA_DIR", betaData);
    writeCrashLog(new Error("env routed"));
    const log = await readFile(join(betaData, "logs", "crash.log"), "utf8");
    expect(log).toContain("env routed");
    // Never defaults to a hard-coded stable path.
    await expect(access(join(stableData, "logs", "crash.log"))).rejects.toThrow();
  });

  it("survives a null dir without throwing (last-resort path)", () => {
    vi.stubEnv("COTERM_USER_DATA_DIR", "");
    const saved = process.env.COTERM_USER_DATA_DIR;
    delete process.env.COTERM_USER_DATA_DIR;
    try {
      expect(() => writeCrashLog(new Error("nowhere"), null)).not.toThrow();
    } finally {
      process.env.COTERM_USER_DATA_DIR = saved;
    }
  });
});
