import type { WorkspaceEntry } from "@shared/types";

// 2026-10-10 explorer crash (Maximum call stack in renderNode): projects nest
// (D:\workspace, D:\workspace\app, ...), and a project switch let one
// project's tree state leak into the next. Paths are compared in one canonical
// form, saved/async state outside the live root is dropped, and the renderer
// refuses any child that points back at itself or an ancestor.
export const MAX_TREE_DEPTH = 64;

export function pathKey(value: string): string {
  return value.replaceAll("/", "\\").replace(/\\+$/u, "").toLowerCase();
}

export function isInsideRoot(path: string, root: string): boolean {
  const candidate = pathKey(path);
  const base = pathKey(root);
  return candidate === base || candidate.startsWith(`${base}\\`);
}

/** Children safe to recurse into: drops any entry that is the folder itself or one of its ancestors. */
export function renderableChildren(children: WorkspaceEntry[] | null | undefined, lineage: ReadonlySet<string>): WorkspaceEntry[] {
  return (children ?? []).filter((child) => !lineage.has(pathKey(child.path)));
}
