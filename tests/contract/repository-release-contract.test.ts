import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string): string => readFileSync(join(repoRoot, path), "utf8");
const workflow = read(".github/workflows/ci.yml");
const shipScriptPath = join(repoRoot, "scripts/sync-and-ship.bat");
const shipScript = existsSync(shipScriptPath) ? readFileSync(shipScriptPath, "utf8") : null;
const packageJson = JSON.parse(read("package.json")) as {
  version: string;
  engines?: { node?: string };
  scripts: Record<string, string>;
};
const packageLock = JSON.parse(read("package-lock.json")) as {
  version: string;
  packages: Record<string, { version?: string; engines?: { node?: string } }>;
};

describe("repository release contract", () => {
  it("keeps cloud CI manual while ship runs every release gate locally", () => {
    // Ordinary pushes and releases must not consume Actions minutes. The same
    // release checks run locally before ship captures or bumps the version.
    expect(workflow).not.toMatch(/^\s*push:/m);
    expect(workflow).not.toMatch(/^\s*release:/m);
    expect(workflow).toMatch(/pull_request:/);
    expect(workflow).toMatch(/workflow_dispatch:/);
    if (shipScript) {
      expect(shipScript).not.toContain("gh workflow run");
      expect(shipScript).not.toContain("gh run list");
      const captureVersion = shipScript.indexOf("REM capture version");
      for (const gate of [
        "call npm run ci:quality",
        "call npm run test:ui:total:strict",
        "call npm run ci:bdd",
        "call npm run test:packaged",
      ]) {
        expect(shipScript.indexOf(gate)).toBeGreaterThanOrEqual(0);
        expect(shipScript.indexOf(gate)).toBeLessThan(captureVersion);
      }
    }
    expect(workflow).toMatch(/^permissions:\s*\r?\n\s+contents:\s+read$/m);
  });

  it("uses the Node 24 source of truth in every required job", () => {
    expect(read(".node-version").trim()).toBe("24");
    expect(packageJson.engines?.node).toBe("24.x");
    expect(packageLock.packages[""]?.engines?.node).toBe("24.x");
    for (const job of ["quality", "bdd-electron", "packaged-smoke"]) {
      expect(workflow).toMatch(new RegExp(`  ${job}:`));
    }
    expect(workflow.match(/node-version-file:\s+\.node-version/g)).toHaveLength(3);
    expect(workflow).not.toMatch(/node-version:\s+(?:22|24)/);
  });

  it("keeps package and lockfile root versions aligned", () => {
    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages[""]?.version).toBe(packageJson.version);
  });

  it("keeps release documentation version-agnostic and executable", () => {
    const release = read("docs/RELEASE.md");
    expect(release).toContain("package.json.version");
    expect(release).toContain("master");
    expect(release).not.toContain("0.1.0");
    expect(release).not.toMatch(/`main`|在 main 分支/);

    const commands = [...release.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)].map(
      (match) => match[1]!,
    );
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(packageJson.scripts, `missing npm script: ${command}`).toHaveProperty(command);
    }
  });

  it("does not weaken CI or coverage to manufacture a green run", () => {
    expect(workflow).not.toMatch(/continue-on-error:\s*true/i);
    const coverage = read("vitest.config.ts");
    expect(coverage).toMatch(/lines:\s*70/);
    expect(coverage).toMatch(/functions:\s*55/);
    expect(coverage).toMatch(/statements:\s*64/);
    expect(coverage).toMatch(/branches:\s*56/);
  });

  it("keeps the strict UI release gate as a truthful unresolved-debt ratchet", () => {
    expect(packageJson.scripts["test:ui:total:strict"]).toContain("--strict");
    expect(packageJson.scripts["test:ui:total:strict"]).toContain("--baseline");
    expect(packageJson.scripts["test:ui:total:complete"]).toBe(
      "tsx scripts/run-ui-total.ts --strict",
    );
    const baseline = JSON.parse(read("tests/fixtures/ui-total-release-baseline.json")) as {
      schemaVersion: number;
      unresolved: { BLOCKED: string[]; NOT_COVERED: string[] };
    };
    expect(baseline.schemaVersion).toBe(1);
    expect(baseline.unresolved.BLOCKED.length).toBeGreaterThan(0);
    expect(baseline.unresolved.NOT_COVERED.length).toBeGreaterThan(0);
    expect(read("scripts/run-ui-total.ts")).toContain("unexpectedUnresolved");
  });
});
