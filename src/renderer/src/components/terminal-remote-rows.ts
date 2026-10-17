export function calculateRemoteRows({
  fallbackRows,
}: {
  fallbackRows: number;
}): number {
  // ANSI full-screen TUIs (Codex/Claude) position every cell against the
  // PTY's reported dimensions. A browser may be physically taller than the
  // desktop tile, but changing only xterm's rows makes subsequent absolute
  // cursor moves land in a different geometry after an alternate-screen
  // redraw. Remote clients must therefore mirror both PTY dimensions.
  return Math.max(1, Math.floor(fallbackRows));
}
