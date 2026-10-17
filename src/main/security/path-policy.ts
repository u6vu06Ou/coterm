import { realpath, lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * Expand a leading home alias (`~/x`, `~\x`, bare `~`) to the real home
 * directory. node:path deliberately does NOT expand `~` — a terminal-link
 * click on `~/notes/a.md` would otherwise resolve against the process cwd and
 * fail containment (roots include the home dir). Applied at BOTH policy entry
 * points so artifact reads and open-external/reveal behave identically.
 * `~user/...` is NOT expanded (not our alias).
 */
export function expandHomeAlias(inputPath: string): string {
  if (inputPath === "~") return homedir();
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return join(homedir(), inputPath.slice(2));
  }
  return inputPath;
}

export interface PathPolicyOptions {
  roots: string[];
  /**
   * When false, a non-existent candidate path is allowed (e.g. a worktree path
   * that will be created by `git worktree add`). Default true preserves the
   * historical behaviour: the path must already exist on disk.
   *
   * Even with mustExist:false, containment is enforced lexically AND the nearest
   * existing ancestor is realpath-resolved to block symlink-escape attacks: a
   * candidate whose existing ancestor resolves outside every root is rejected.
   */
  mustExist?: boolean;
}

/**
 * Canonicalize an existing path with NO containment check.
 *
 * Only for handlers that hand a file to the OS on a click the user just made (reveal-in-folder,
 * open-with-default-app). Those are desktop IPC only — never reachable over the web RPC — so the
 * caller is the person sitting at the machine, who could open the same file from Explorer. A root
 * list there bought nothing and broke every artifact outside a project workspace (`C:\CloudDrive\...`).
 * The code-execution surface is guarded by the executable-extension blocklist at the call site.
 *
 * Do NOT use this for reading file contents into the app: that path IS web-reachable, and an
 * unbounded read would be a network-exposed arbitrary-file-read primitive.
 */
export async function assertExistingPath(inputPath: string): Promise<string> {
  const absolute = resolve(expandHomeAlias(inputPath));
  if (!isAbsolute(absolute)) throw new Error("Path must be absolute.");
  return realpath(absolute).catch(() => {
    throw new Error("Path does not exist.");
  });
}

function isInside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function lexicalContainment(candidate: string, roots: string[]): boolean {
  // Lexical check first (cheap, catches `..` and prefix-collision before any
  // disk access). A candidate is contained if its normalized path is equal to
  // or a descendant of a root, with no `..` escape.
  for (const root of roots) {
    if (isInside(candidate, root)) return true;
  }
  return false;
}

export async function assertAllowedPath(
  inputPath: string,
  options: PathPolicyOptions,
): Promise<string> {
  const mustExist = options.mustExist ?? true;
  const absolute = resolve(expandHomeAlias(inputPath));

  const lexicalRoots = options.roots.map((root) => resolve(root));
  const resolvedRoots = await Promise.all(
    lexicalRoots.map(async (root) => realpath(root).catch(() => root)),
  );

  if (mustExist) {
    // Existing paths are compared only after both sides are canonicalized.
    // Comparing a lexical candidate to realpath-resolved roots rejects a valid
    // Windows junction such as C:\CloudDrive -> G:\... before the candidate has a
    // chance to resolve to the same target.
    const candidate = await realpath(absolute).catch(() => {
      throw new Error("Path does not exist.");
    });
    if (!resolvedRoots.some((root) => isInside(candidate, root))) {
      throw new Error("Path is outside the allowed workspace.");
    }
    return candidate;
  }

  // A non-existent candidate cannot be fully canonicalized, so first enforce
  // containment using the paths exactly as requested (after path.resolve).
  // Keep this separate from resolvedRoots: an allowed root may itself be a
  // symlink/junction whose canonical path uses a different drive or prefix.
  if (!lexicalContainment(absolute, lexicalRoots)) {
    throw new Error("Path is outside the allowed workspace.");
  }

  // mustExist:false — the candidate may not exist yet. Walk up to the nearest
  // existing ancestor and realpath THAT, then confirm the ancestor is contained
  // and the candidate is still lexically inside the ancestor (no `..` between
  // them). This blocks a non-existent path whose first existing component is a
  // symlink pointing outside the roots.
  let ancestor = absolute;
  let ancestorStat = await lstat(ancestor).catch(() => null);
  while (!ancestorStat) {
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      // Reached the filesystem root without finding an existing component.
      throw new Error("Path does not exist.");
    }
    ancestor = parent;
    ancestorStat = await lstat(ancestor).catch(() => null);
  }
  const ancestorReal = await realpath(ancestor).catch(() => {
    throw new Error("Path does not exist.");
  });
  // Realpath containment is mandatory. If an existing child is a symlink or
  // junction outside the allowed root, its lexical location must not rescue it.
  // Roots that are themselves symlinks are already represented by resolvedRoots.
  const contained = resolvedRoots.some((root) => isInside(ancestorReal, root));
  if (!contained) {
    throw new Error("Path is outside the allowed workspace.");
  }
  return absolute;
}
