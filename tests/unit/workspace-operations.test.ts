import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertSafeEntryName,
  createWorkspaceDirectory,
  createWorkspaceFile,
  duplicateTarget,
  duplicateWorkspaceEntry,
  listWorkspaceEntries,
  renameWorkspaceEntry,
} from "../../src/main/core/workspace-operations";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(process.env.TEMP ?? process.cwd(), "coterm-explorer-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("workspace operations", () => {
  it("creates files/directories and lists directories lazily", async () => {
    await createWorkspaceDirectory(root, "src");
    await createWorkspaceFile(join(root, "src"), "main.ts");
    const entries = await listWorkspaceEntries(root, root);
    expect(entries).toEqual([
      { name: "src", path: join(root, "src"), type: "directory", relativePath: "src" },
    ]);
    await expect(listWorkspaceEntries(root, join(root, "src"))).resolves.toEqual([
      { name: "main.ts", path: join(root, "src", "main.ts"), type: "file", relativePath: join("src", "main.ts") },
    ]);
  });

  it("renames entries and refuses collisions", async () => {
    await writeFile(join(root, "old.txt"), "old");
    await writeFile(join(root, "other.txt"), "other");
    await renameWorkspaceEntry(join(root, "old.txt"), join(root, "new.txt"), root);
    await expect(renameWorkspaceEntry(join(root, "new.txt"), join(root, "other.txt"), root)).rejects.toThrow("already exists");
  });

  it("duplicates files with deterministic collision-safe names", async () => {
    await writeFile(join(root, "note.md"), "hello");
    expect(await duplicateTarget(join(root, "note.md"))).toBe(join(root, "note copy.md"));
    await duplicateWorkspaceEntry(join(root, "note.md"), join(root, "note copy.md"));
    expect(await duplicateTarget(join(root, "note.md"))).toBe(join(root, "note copy 2.md"));
  });

  it("rejects path separators and traversal-like entry names", () => {
    expect(() => assertSafeEntryName("../escape")).toThrow();
    expect(() => assertSafeEntryName("folder\\file")).toThrow();
    expect(() => assertSafeEntryName("name.")).toThrow();
    expect(assertSafeEntryName("中文檔案.txt")).toBe("中文檔案.txt");
  });
});
