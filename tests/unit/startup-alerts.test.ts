import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { readStartupAlerts } from "../../src/main/core/app-operations";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("readStartupAlerts", () => {
  it("returns trimmed local alert text without clearing the file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coterm-alerts-"));
    tempPaths.push(directory);
    const file = join(directory, "ALERTS.md");
    await writeFile(file, "\n- cache docs changed\n", "utf8");
    expect(readStartupAlerts(file)).toBe("- cache docs changed");
    expect(readStartupAlerts(file)).toBe("- cache docs changed");
  });

  it("is empty when ALERTS.md does not exist", () => {
    expect(readStartupAlerts(join(tmpdir(), "coterm-alerts-missing.md"))).toBe("");
  });
});
