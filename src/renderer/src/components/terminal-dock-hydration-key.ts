// Stable content key for the tile list. The web/mobile dockLayout arrives via
// WebSocket JSON.parse, so every broadcast is a fresh array even when content
// is unchanged. Keying the hydrate effect on this string (instead of the
// array identity) means a mere re-broadcast doesn't cancel in-flight RPCs.
export function tileHydrationKey(
  tiles: { terminalId: string; projectId: string }[],
): string {
  return tiles.map((t) => `${t.terminalId}:${t.projectId}`).join(",");
}
