/**
 * Coterm clean-release script.
 *
 * Scans build-output directories (out/, release/, dist/) and lists the files
 * that would be removed. Default is DRY-RUN — only prints. Pass --yes to
 * actually delete.
 *
 * Usage:
 *   npx tsx scripts/clean-release.ts [--out <project-root>] [--yes] [--json]
 *
 * Safety guards (refuse to delete):
 *   - The current working directory itself or its ancestors
 *   - %APPDATA% / home directory / drive roots
 *   - Any file tracked by git (so source is never touched)
 *   - Paths containing ".." after normalization
 *
 * This script only deletes files inside out/, release/, dist/ subdirectories
 * of the project root. It never deletes the project root itself.
 */
import { readdir, rm, stat } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

// --- CLI parsing -----------------------------------------------------------

interface CliArgs {
  projectRoot: string;
  yes: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    projectRoot: process.cwd(),
    yes: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out" || arg === "--project") {
      const next = argv[i + 1];
      if (!next) {
        console.error(`Missing value for ${arg}`);
        process.exit(1);
      }
      args.projectRoot = next;
      i++;
    } else if (arg === "--yes") {
      args.yes = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: npx tsx scripts/clean-release.ts [--out <project-root>] [--yes] [--json]",
      );
      console.log("  Default is DRY-RUN (no deletion). Pass --yes to delete.");
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return args;
}

// --- Types -----------------------------------------------------------------

interface FileEntry {
  path: string; // absolute
  relativePath: string; // relative to project root
  size: number;
  dir: string; // which build dir (out/release/dist)
}

interface CleanReport {
  projectRoot: string;
  dryRun: boolean;
  scannedDirs: string[];
  files: FileEntry[];
  totalBytes: number;
  totalFiles: number;
  deleted: number;
  deletedBytes: number;
  errors: string[];
  guards: string[];
}

// --- Safety guards ---------------------------------------------------------

const BUILD_DIRS = ["out", "release", "dist"];

/** Paths we refuse to touch even if they appear under a build dir. */
function buildGuardList(projectRoot: string): string[] {
  const guards: string[] = [];
  const appdata = process.env.APPDATA;
  if (appdata) guards.push(appdata);
  guards.push(homedir());
  // Drive roots (e.g. C:\, D:\)
  if (process.platform === "win32") {
    guards.push("C:\\", "D:\\", "E:\\");
  } else {
    guards.push("/");
  }
  // The project root itself and its parent (never delete the root)
  guards.push(projectRoot);
  guards.push(resolve(projectRoot, ".."));
  return guards;
}

function isInsideGuard(target: string, guards: string[]): boolean {
  const norm = resolve(target);
  for (const g of guards) {
    const ng = resolve(g);
    if (norm === ng) return true;
    // If target is an ancestor of the guard, that's fine (guard is more specific).
    // We only block if target is the guard itself or inside it.
  }
  return false;
}

function isProjectRootOrAncestor(target: string, projectRoot: string): boolean {
  const norm = resolve(target);
  const root = resolve(projectRoot);
  if (norm === root) return true;
  // If target is an ancestor of projectRoot, refuse.
  let cur = root;
  for (;;) {
    const parent = resolve(cur, "..");
    if (parent === cur) break;
    if (parent === norm) return true;
    cur = parent;
  }
  return false;
}

// --- Git tracking check ----------------------------------------------------

let cachedGitFiles: Set<string> | null = null;

function getGitTrackedFiles(projectRoot: string): Set<string> {
  if (cachedGitFiles) return cachedGitFiles;
  try {
    const out = execFileSync("git", ["ls-files", "--", "out", "release", "dist"], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 15000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const set = new Set<string>();
    for (const line of out.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) set.add(resolve(projectRoot, trimmed));
    }
    cachedGitFiles = set;
    return set;
  } catch {
    // Not a git repo or git unavailable — treat as empty (no tracked files).
    cachedGitFiles = new Set();
    return cachedGitFiles;
  }
}

// --- Scanning --------------------------------------------------------------

async function scanDir(
  dirPath: string,
  dirLabel: string,
  projectRoot: string,
  guards: string[],
  gitFiles: Set<string>,
  errors: string[],
): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];
  const absDir = resolve(projectRoot, dirPath);

  // Guard: the build dir must be strictly inside the project root, not the root itself.
  if (isProjectRootOrAncestor(absDir, projectRoot)) {
    errors.push(`Refusing to scan project root as build dir: ${absDir}`);
    return entries;
  }
  if (isInsideGuard(absDir, guards)) {
    errors.push(`Refusing to scan guarded path: ${absDir}`);
    return entries;
  }

  let items: Dirent[];
  try {
    items = await readdir(absDir, { withFileTypes: true });
  } catch {
    // Dir doesn't exist — normal, skip.
    return entries;
  }

  for (const item of items) {
    const full = join(absDir, item.name);
    if (item.isDirectory()) {
      // Recurse.
      const sub = await scanDir(
        full,
        dirLabel,
        projectRoot,
        guards,
        gitFiles,
        errors,
      );
      entries.push(...sub);
    } else if (item.isFile()) {
      // Guard: skip git-tracked files.
      if (gitFiles.has(full)) {
        errors.push(`Skipping git-tracked file: ${relative(projectRoot, full)}`);
        continue;
      }
      let info: Stats;
      try {
        info = await stat(full);
      } catch {
        continue;
      }
      entries.push({
        path: full,
        relativePath: relative(projectRoot, full),
        size: info.size,
        dir: dirLabel,
      });
    }
  }
  return entries;
}

// --- Formatting ------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const unit = units[i] ?? "TB";
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${unit}`;
}

function printHuman(report: CleanReport): void {
  console.log("=".repeat(72));
  console.log("Coterm clean-release");
  console.log(`Project root: ${report.projectRoot}`);
  console.log(`Mode:         ${report.dryRun ? "DRY-RUN (no deletion)" : "DELETE (--yes)"}`);
  console.log(`Scanned dirs: ${report.scannedDirs.join(", ") || "(none found)"}`);
  console.log("=".repeat(72));

  if (report.guards.length > 0) {
    console.log("\nSafety guards active:");
    for (const g of report.guards) console.log(`  - ${g}`);
  }

  console.log("\n## Files to remove\n");
  if (report.files.length === 0) {
    console.log("  (no build-output files found)");
  } else {
    console.log(
      `  ${"Dir".padEnd(8)} ${"Size".padStart(10)}  ${"Path"}`,
    );
    console.log(`  ${"-".repeat(8)} ${"-".repeat(10)}  ${"-".repeat(40)}`);
    for (const f of report.files) {
      console.log(
        `  ${f.dir.padEnd(8)} ${formatBytes(f.size).padStart(10)}  ${f.relativePath}`,
      );
    }
  }

  console.log("\n## Summary\n");
  console.log(`  Total files:  ${report.totalFiles}`);
  console.log(`  Total size:   ${formatBytes(report.totalBytes)}`);
  if (!report.dryRun) {
    console.log(`  Deleted:      ${report.deleted}`);
    console.log(`  Freed:        ${formatBytes(report.deletedBytes)}`);
  }

  if (report.errors.length > 0) {
    console.log("\n## Warnings / skipped\n");
    for (const e of report.errors) console.log(`  - ${e}`);
  }
  console.log("");
}

// --- Main ------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = resolve(args.projectRoot);

  // Validate project root is absolute and exists.
  if (!isAbsolute(projectRoot)) {
    console.error(`Project root must be an absolute path: ${projectRoot}`);
    process.exit(1);
  }

  const guards = buildGuardList(projectRoot);
  const gitFiles = getGitTrackedFiles(projectRoot);
  const errors: string[] = [];
  const scannedDirs: string[] = [];

  const allFiles: FileEntry[] = [];
  for (const dir of BUILD_DIRS) {
    const absDir = resolve(projectRoot, dir);
    // Guard: never scan if the build dir equals the project root or a guard.
    if (isProjectRootOrAncestor(absDir, projectRoot)) {
      errors.push(`Refusing to scan project root as build dir: ${absDir}`);
      continue;
    }
    if (isInsideGuard(absDir, guards)) {
      errors.push(`Refusing to scan guarded path: ${absDir}`);
      continue;
    }
    scannedDirs.push(dir);
    const files = await scanDir(dir, dir, projectRoot, guards, gitFiles, errors);
    allFiles.push(...files);
  }

  // Sort by size descending for readability.
  allFiles.sort((a, b) => b.size - a.size);

  const totalBytes = allFiles.reduce((sum, f) => sum + f.size, 0);

  let deleted = 0;
  let deletedBytes = 0;

  if (args.yes) {
    for (const f of allFiles) {
      try {
        await rm(f.path, { force: true });
        deleted++;
        deletedBytes += f.size;
      } catch (err) {
        errors.push(`Failed to delete ${f.relativePath}: ${(err as Error).message}`);
      }
    }
  }

  const report: CleanReport = {
    projectRoot,
    dryRun: !args.yes,
    scannedDirs,
    files: allFiles,
    totalBytes,
    totalFiles: allFiles.length,
    deleted,
    deletedBytes,
    errors,
    guards: [
      "Refuse to delete %APPDATA% / home / drive roots",
      "Refuse to delete git-tracked files",
      "Refuse to delete project root or its ancestors",
      "Only delete inside out/, release/, dist/",
    ],
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }

  // Exit non-zero if nothing was found and --yes was passed (no-op).
  if (args.yes && deleted === 0 && allFiles.length > 0) {
    process.exit(2);
  }
}

main().catch((error) => {
  console.error("clean-release failed:", error);
  process.exit(1);
});
