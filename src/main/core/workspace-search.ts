import { opendir, realpath } from "node:fs/promises";
import { extname, join, relative } from "node:path";

export interface WorkspaceSearchInput {
  root: string;
  query: string;
  maxResults?: number | undefined;
  includeDirectories?: boolean | undefined;
  includeHidden?: boolean | undefined;
  signal?: AbortSignal | undefined;
}
export interface WorkspaceSearchResult { name: string; path: string; relativePath: string; type: "file" | "directory"; score: number; }

export async function searchWorkspaceEntries(input: WorkspaceSearchInput): Promise<WorkspaceSearchResult[]> {
  const root = await realpath(input.root);
  const query = parseQuery(input.query);
  const maxResults = Math.min(input.maxResults ?? 300, 300);
  const ignored = new Set([".git", "node_modules", ".cache", ".coterm", "coverage", "playwright-report", "test-results"]);
  const results: WorkspaceSearchResult[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (input.signal?.aborted || results.length >= maxResults || depth > 64) return;
    let handle: Awaited<ReturnType<typeof opendir>>;
    try { handle = await opendir(directory); } catch { return; }
    try {
      for await (const entry of handle) {
        if (input.signal?.aborted || results.length >= maxResults) return;
        if (!input.includeHidden && entry.name.startsWith(".")) continue;
        if (entry.isDirectory() && ignored.has(entry.name.toLowerCase())) continue;
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) continue; // avoids junction/symlink loops and path escapes
        const type = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : null;
        if (!type) continue;
        const relativePath = relative(root, path);
        const score = scoreEntry(entry.name, relativePath, type, query);
        if (score > 0 && (type === "file" || input.includeDirectories)) results.push({ name: entry.name, path, relativePath, type, score });
        if (type === "directory") await visit(path, depth + 1);
      }
    } finally { await handle.close().catch(() => undefined); }
  };
  await visit(root, 0);
  return results.sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath)).slice(0, maxResults);
}

type SearchQuery = { text: string; extension?: string; name?: string; path?: string; glob?: string };
function parseQuery(raw: string): SearchQuery {
  const value = raw.trim(); const query: SearchQuery = { text: value.toLowerCase() };
  for (const token of value.split(/\s+/)) {
    const lower = token.toLowerCase();
    if (lower.startsWith("ext:")) query.extension = lower.slice(4).replace(/^\./, "");
    else if (lower.startsWith("name:")) query.name = lower.slice(5);
    else if (lower.startsWith("path:")) query.path = lower.slice(5);
    else if (lower.startsWith("*.") && lower.length > 2) query.extension = lower.slice(2);
    else if (lower.startsWith(".") && lower.length > 1 && !lower.includes(" ")) query.extension = lower.slice(1);
  }
  return query;
}
function scoreEntry(name: string, relativePath: string, type: WorkspaceSearchResult["type"], query: SearchQuery): number {
  const lowerName = name.toLowerCase(); const lowerPath = relativePath.toLowerCase();
  if (query.extension && extname(lowerName).replace(/^\./, "") !== query.extension) return 0;
  if (query.name && !lowerName.includes(query.name)) return 0;
  if (query.path && !lowerPath.includes(query.path)) return 0;
  if (query.glob && !lowerName.includes(query.glob)) return 0;
  const freeText = query.text.replace(/(?:ext|name|path):[^\s]+/g, "").replace(/\*?\.[A-Za-z0-9_-]+/g, "").trim();
  if (freeText && !lowerName.includes(freeText) && !lowerPath.includes(freeText)) return 0;
  let score = type === "file" ? 2 : 1;
  if (freeText && lowerName === freeText) score += 5;
  else if (freeText && lowerName.includes(freeText)) score += 3;
  if (query.extension) score += 2;
  if (query.name && lowerName.startsWith(query.name)) score += 2;
  return score;
}
