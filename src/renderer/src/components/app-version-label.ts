/**
 * The sidebar brand line used to read a hardcoded "v1.0 workspace", so the only
 * way to tell which build was running was to ask an agent to go read
 * package.json / the exe's file version. It now shows the running build's real
 * version, which also makes the stable-vs-beta split visible at a glance
 * (a beta carries its prerelease tag and lives in a separate userData world).
 */
export function formatAppVersionLabel(version: string | null | undefined): string {
  const value = version?.trim() ?? "";
  if (!value) return "workspace";
  const normalized = value.replace(/^v/i, "");
  // Refuse anything that is not a version: better to fall back to the neutral
  // label than to print whatever string reached us into the brand line.
  if (!/^\d+(\.\d+)*([-+][0-9A-Za-z.-]+)?$/.test(normalized)) return "workspace";
  return `v${normalized}`;
}
