import { randomUUID } from "node:crypto";

/**
 * Short-lived grants that let the artifact panel load a local HTML file over http:// so its
 * scripts and relative assets actually work. A grant is minted in-process only AFTER the path
 * has cleared assertAllowedPath, is scoped to one directory, and dies in ten minutes — it is a
 * preview window, not a general-purpose file server.
 */
const TTL_MS = 10 * 60 * 1000;
const MAX_GRANTS = 32;

const grants = new Map<string, { directory: string; expiresAt: number }>();

function sweep(now: number): void {
  for (const [token, grant] of grants) if (grant.expiresAt <= now) grants.delete(token);
}

/** Mint a preview token for an already-validated directory. */
export function mintArtifactPreviewToken(directory: string): string {
  const now = Date.now();
  sweep(now);
  // ponytail: oldest-first eviction, no LRU. A user cannot have 32 live previews open.
  while (grants.size >= MAX_GRANTS) {
    const oldest = grants.keys().next();
    if (oldest.done) break;
    grants.delete(oldest.value);
  }
  const token = randomUUID();
  grants.set(token, { directory, expiresAt: now + TTL_MS });
  return token;
}

/** Resolve a token to its directory, or null if unknown/expired. */
export function resolveArtifactPreviewToken(token: string): string | null {
  const grant = grants.get(token);
  if (!grant) return null;
  if (grant.expiresAt <= Date.now()) {
    grants.delete(token);
    return null;
  }
  return grant.directory;
}

/** Test seam: drop every grant. */
export function clearArtifactPreviewTokens(): void {
  grants.clear();
}
