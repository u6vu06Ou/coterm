// #10: default workspace must EXIST (or fall back), never a stale/hard-coded
// machine-specific path.
import { describe, expect, it } from "vitest";
import { resolveDefaultWorkspacePath } from "../../src/main/core/workspace-defaults";

const HOME = "C:\\Users\\Example";
const DOCS = "C:\\Users\\Example\\Documents";

function deps(existing: readonly string[]) {
  return { dirExists: (path: string) => existing.includes(path) };
}

describe("resolveDefaultWorkspacePath (#10 exists/fallback)", () => {
  it("uses the configured default when it exists", () => {
    expect(
      resolveDefaultWorkspacePath(
        { configured: "D:\\work", candidates: ["D:\\proj"], fallbacks: [DOCS, HOME] },
        deps(["D:\\work", "D:\\proj", DOCS, HOME]),
      ),
    ).toBe("D:\\work");
  });

  it("drops a stale configured path and falls back to an existing project workspace", () => {
    expect(
      resolveDefaultWorkspacePath(
        { configured: "D:\\workspace\\gone", candidates: ["E:\\proj"], fallbacks: [DOCS, HOME] },
        deps(["E:\\proj", DOCS, HOME]),
      ),
    ).toBe("E:\\proj");
  });

  it("falls back to OS dirs when nothing is configured and no projects exist", () => {
    expect(
      resolveDefaultWorkspacePath(
        { configured: null, candidates: [], fallbacks: [DOCS, HOME] },
        deps([DOCS, HOME]),
      ),
    ).toBe(DOCS);
  });

  it("ignores empty/blank configured values", () => {
    expect(
      resolveDefaultWorkspacePath(
        { configured: "   ", candidates: [], fallbacks: [DOCS, HOME] },
        deps([HOME]),
      ),
    ).toBe(HOME);
  });

  it("returns the last fallback even when nothing exists (dialog-safe, never throws)", () => {
    expect(
      resolveDefaultWorkspacePath(
        { configured: "D:\\gone", candidates: ["E:\\gone"], fallbacks: ["F:\\gone", "G:\\gone-too"] },
        deps([]),
      ),
    ).toBe("G:\\gone-too");
  });

  it("never resolves to the forbidden hard-coded D:\\workspace when it is absent", () => {
    const resolved = resolveDefaultWorkspacePath(
      { configured: "D:\\workspace", candidates: [], fallbacks: [DOCS, HOME] },
      deps([DOCS, HOME]),
    );
    expect(resolved).not.toBe("D:\\workspace");
    expect(resolved).toBe(DOCS);
  });
});
