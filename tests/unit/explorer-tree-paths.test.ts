import { describe, expect, it } from "vitest";
import type { WorkspaceEntry } from "../../src/shared/types";
import { isInsideRoot, pathKey, renderableChildren } from "../../src/renderer/src/components/explorer-tree-paths";

const entry = (path: string, type: WorkspaceEntry["type"] = "directory"): WorkspaceEntry =>
  ({ name: path.split("\\").at(-1) ?? path, path, type, relativePath: path }) as WorkspaceEntry;

describe("explorer tree paths", () => {
  it("canonicalizes case, slashes and trailing separators", () => {
    expect(pathKey("D:/Workspace/app/")).toBe("d:\\workspace\\app");
  });

  it("keeps nested project roots apart", () => {
    expect(isInsideRoot("D:\\workspace\\app\\docs", "D:\\workspace\\app")).toBe(true);
    expect(isInsideRoot("D:\\workspace\\app", "D:\\workspace\\app")).toBe(true);
    expect(isInsideRoot("D:\\workspace", "D:\\workspace\\app")).toBe(false);
    expect(isInsideRoot("D:\\llm-tools", "D:\\workspace\\app")).toBe(false);
    expect(isInsideRoot("D:\\workspace\\caex", "D:\\workspace\\app")).toBe(false);
  });

  it("drops children that point back at the folder or an ancestor (render cycle)", () => {
    const lineage = new Set([pathKey("D:\\workspace"), pathKey("D:\\workspace\\app")]);
    const children = [
      entry("D:\\workspace\\app\\docs"),
      entry("D:\\Workspace\\app"),
      entry("D:\\workspace"),
      entry("D:\\workspace\\app\\a_b.html", "file"),
    ];
    expect(renderableChildren(children, lineage).map((child) => child.path)).toEqual([
      "D:\\workspace\\app\\docs",
      "D:\\workspace\\app\\a_b.html",
    ]);
    expect(renderableChildren(null, lineage)).toEqual([]);
  });
});
