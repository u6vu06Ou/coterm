import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Guards the v1.0.11 hotfix: v1.0.10's W0 put perf telemetry and an IME policy
// module on the terminal hot path and caused rendering/IME regressions. If W0 is
// ever re-applied, it must not touch production runtime again.
const BANNED = ["terminal-perf", "terminal-ime-policy"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

describe("v1.0.10 W0 telemetry regression", () => {
  it("production sources do not reference W0 terminal telemetry modules", () => {
    const offenders = sourceFiles("src").filter((file) => {
      const text = readFileSync(file, "utf8");
      return BANNED.some((name) => text.includes(name));
    });
    expect(offenders).toEqual([]);
  });
});
