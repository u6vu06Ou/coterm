import { access, copyFile, cp, lstat, mkdir, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";

export interface WorkspaceShell {
  trashItem(path: string): Promise<void>;
  showItemInFolder(path: string): void;
  openPath(path: string): Promise<string>;
}

export interface WorkspaceEntryRecord {
  name: string;
  path: string;
  type: "file" | "directory";
  relativePath: string;
}

export function assertSafeEntryName(name: string): string {
  const trimmed = name.trim();
  const windowsStem = trimmed.split(".", 1)[0]?.toUpperCase();
  const hasControlCharacter = [...trimmed].some((character) => character.charCodeAt(0) < 32);
  if (
    trimmed !== name ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("\\") ||
    trimmed.includes("/") ||
    hasControlCharacter ||
    /[<>:"|?*]/u.test(trimmed) ||
    /[ .]$/u.test(trimmed) ||
    ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"].includes(windowsStem ?? "")
  ) {
    throw new Error("Invalid workspace entry name.");
  }
  return trimmed;
}

async function ensureMissing(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    return;
  }
  throw new Error("A workspace entry with that name already exists.");
}

export async function listWorkspaceEntries(root: string, directory: string): Promise<WorkspaceEntryRecord[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => ![".git", "node_modules"].includes(entry.name))
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name))
    .slice(0, 500)
    .map((entry) => ({
      name: entry.name,
      path: join(directory, entry.name),
      type: entry.isDirectory() ? "directory" : "file",
      relativePath: relative(root, join(directory, entry.name)),
    }));
}

export async function createWorkspaceFile(parent: string, name: string): Promise<void> {
  const safeName = assertSafeEntryName(name);
  const target = join(parent, safeName);
  await ensureMissing(target);
  await writeFile(target, "", { encoding: "utf8", flag: "wx" });
}

export async function createWorkspaceDirectory(parent: string, name: string): Promise<void> {
  const target = join(parent, assertSafeEntryName(name));
  await ensureMissing(target);
  await mkdir(target);
}

export async function renameWorkspaceEntry(source: string, target: string, root: string): Promise<void> {
  if (source.toLowerCase() === root.toLowerCase()) throw new Error("The workspace root cannot be renamed.");
  await ensureMissing(target);
  await rename(source, target);
}

export async function duplicateWorkspaceEntry(source: string, target: string): Promise<void> {
  await ensureMissing(target);
  const info = await lstat(source);
  if (info.isDirectory()) {
    await cp(source, target, { recursive: true, errorOnExist: true, force: false });
  } else if (info.isFile()) {
    await copyFile(source, target, 0);
  } else {
    throw new Error("Only regular files and directories can be duplicated.");
  }
}

export async function duplicateTarget(source: string, destinationParent = dirname(source)): Promise<string> {
  const parent = destinationParent;
  const fileName = basename(source);
  const extension = extname(fileName);
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? " copy" : ` copy ${index + 1}`;
    const candidate = join(parent, `${stem}${suffix}${extension}`);
    try {
      await access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error("Unable to find an unused duplicate name.");
}

export async function workspaceEntryType(path: string): Promise<"file" | "directory"> {
  const info = await stat(path);
  if (info.isDirectory()) return "directory";
  if (info.isFile()) return "file";
  throw new Error("Unsupported workspace entry type.");
}
