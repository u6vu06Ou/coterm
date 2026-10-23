// Shared PTY geometry ownership: who may resize the shared ConPTY, and when a
// client must re-send a size the main side has since changed.
//
// Bug context (2026-10-23 user report): an agent pane running Claude Code in
// the alternate screen sometimes painted its UI into only the top rows, with
// the bottom ~40% of the pane blank. The PTY believed in a smaller grid than
// the desktop xterm view, because a remote (phone) client's rows-only geometry
// intent resized the shared PTY and the desktop tile never re-asserted its own
// fitted grid until the manual "refresh terminal" action (which happens to
// re-fit + re-send the size). The arbitration + dedupe rules below are the
// pure, testable core of the fix:
//
//  1. Desktop owns the geometry while the desktop window is visible AND
//     focused — a remote rows claim must not shrink (or grow) the PTY out
//     from under a visible desktop view during that time.
//  2. When the desktop is not active, remote claims apply freely; the desktop
//     re-asserts its fitted grid when focus returns.
//  3. A client must never skip a resize just because it already sent that
//     size once, when main's reported size has since diverged from what was
//     sent (the stale "last sent" cache trap).

export interface PtyGridGeometry {
  cols: number;
  rows: number;
}

/** A desktop resizeTerminal call stamped with when main received it. */
export interface PtyGeometryAssertion extends PtyGridGeometry {
  at: number;
}

export function geometryEquals(a: PtyGridGeometry, b: PtyGridGeometry): boolean {
  return a.cols === b.cols && a.rows === b.rows;
}

export type RemoteGeometryClaimDecision =
  | { kind: "apply"; geometry: PtyGridGeometry }
  | { kind: "ignore"; reason: "no-change" | "desktop-active" };

/**
 * Decide a remote (web/mobile) client geometry intent
 * (AppOperations.requestTerminalGeometry → this).
 *
 * - `no-change`: the claim already matches the PTY's current grid.
 * - `desktop-active`: the desktop window is visible+focused AND the desktop
 *   previously asserted this terminal's grid via resizeTerminal, and the
 *   claim disagrees with that assertion. The desktop tile re-asserts on its
 *   own layout changes anyway; letting the remote claim through here is what
 *   produced the half-blank pane.
 * - otherwise the claim applies (desktop inactive, or no desktop assertion
 *   yet, or the claim matches the desktop's assertion).
 */
export function decideRemoteGeometryClaim(args: {
  claim: PtyGridGeometry;
  /** The PTY's current grid (main's per-terminal truth). */
  current: PtyGridGeometry;
  /** Last desktop-resizeTerminal assertion for this terminal, if any. */
  desktopAssertion: PtyGeometryAssertion | null;
  /** Desktop window visible && focused at decision time. */
  desktopActive: boolean;
}): RemoteGeometryClaimDecision {
  if (geometryEquals(args.claim, args.current)) {
    return { kind: "ignore", reason: "no-change" };
  }
  if (
    args.desktopActive
    && args.desktopAssertion !== null
    && !geometryEquals(args.claim, args.desktopAssertion)
  ) {
    return { kind: "ignore", reason: "desktop-active" };
  }
  return { kind: "apply", geometry: { cols: args.claim.cols, rows: args.claim.rows } };
}

/**
 * Renderer-side send decision. `lastSent` is the grid this client most
 * recently handed to resizeTerminal; `external` is the last grid main
 * reported for this terminal (the terminalGeometryChanged push), or null when
 * none has been observed yet.
 *
 * Send when ANY of:
 *  - nothing was ever sent (mount);
 *  - the locally fitted grid differs from what we last sent (layout changed);
 *  - main currently reports a grid different from what we last sent, i.e.
 *    another client resized the shared PTY meanwhile. Skipping the re-send
 *    here just because local === lastSent is the stale-cache bug this module
 *    exists to kill.
 */
export function shouldSendTerminalResize(args: {
  lastSent: PtyGridGeometry | null;
  local: PtyGridGeometry;
  external: PtyGridGeometry | null;
}): boolean {
  const { lastSent, local, external } = args;
  if (lastSent === null) return true;
  if (!geometryEquals(lastSent, local)) return true;
  if (external !== null && !geometryEquals(external, lastSent)) return true;
  return false;
}
