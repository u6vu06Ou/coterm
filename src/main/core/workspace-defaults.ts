// #10 default workspace resolution: never point the picker/onboarding at a
// path that does not exist (the old draft could carry a stale or hard-coded
// D:\workspace from another machine). Order: the user's configured
// defaultWorkspacePath, then existing project workspaces, then OS-level
// fallbacks (Documents, home). The last fallback is returned even if missing
// — a dialog defaultPath pointing nowhere is ignored by the OS, never fatal.

import { existsSync, statSync } from "node:fs";

export interface WorkspaceDefaultDeps {
  dirExists?: (path: string) => boolean;
}

function defaultDirExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export interface DefaultWorkspaceOptions {
  configured?: string | null;
  candidates?: readonly string[];
  /** Ordered OS-level fallbacks; must contain at least one entry. */
  fallbacks: readonly string[];
}

export function resolveDefaultWorkspacePath(
  options: DefaultWorkspaceOptions,
  deps: WorkspaceDefaultDeps = {},
): string {
  const dirExists = deps.dirExists ?? defaultDirExists;
  const ordered = [
    ...(options.configured ? [options.configured] : []),
    ...(options.candidates ?? []),
    ...options.fallbacks,
  ].filter((path) => typeof path === "string" && path.trim() !== "");
  for (const path of ordered) {
    if (dirExists(path)) return path;
  }
  const last = options.fallbacks[options.fallbacks.length - 1];
  return last ?? "";
}
