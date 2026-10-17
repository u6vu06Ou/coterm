// Horizontal scroll lock for the whole IME composition window.
//
// Root cause of the long-standing "每打一個字畫面就往左推一格" bug:
// while composing, the xterm helper-textarea is unhidden and parked on the
// cursor cell with a ONE CELL wide box (see primeTextareaAtLiveCursor / the
// .ime-composing CSS rules). The OS IME streams the composed text into that
// textarea, so its caret walks right one character per keystroke and leaves
// the 1-cell box. Chromium answers with its "reveal the caret" scroll, which
// walks UP the ancestor chain and shifts the nearest scrollable box — the
// terminal content slides left one cell per keystroke, cumulatively, until it
// hits the scroll maximum. At that point the textarea's rect is far outside
// the visible box and Windows TSF force-ends the composition, which lands in
// our compositionend handler and writes the half-composed string into the PTY
// without the user ever pressing Enter.
//
// The old defense (`lockImeHorizontalLayout`) only zeroed a fixed list of
// elements, and only at compositionstart / compositionupdate — the per-key
// reveal-scroll in between was unopposed, and any scrollable ancestor above
// the host was never covered at all.
//
// This module makes the lock (a) positional — it restores the exact offsets
// captured when composition began, never a blind 0 — and (b) exhaustive — the
// caller feeds it the xterm-internal boxes AND every ancestor up to the
// document element, so whichever box Chromium picks is put back.
//
// Why "restore captured", not "force 0": remote/mobile hosts
// (.xterm-host-remote) mirror the PTY geometry 1:1 and use host.scrollLeft as
// their only way to pan to a cursor beyond the initial viewport. Forcing 0
// there pins the view to column 0 and the composition preview renders off
// screen. Freezing the pan where it stood at compositionstart keeps the view
// still without destroying it.

export interface ScrollLockEntry {
  el: Element;
  left: number;
}

export interface CaptureOptions {
  /**
   * Force the captured lock value to 0 instead of the element's current
   * scrollLeft. Used for the desktop xterm boxes, which never legitimately
   * scroll horizontally — a non-zero value there is already the bug, so
   * freezing it would freeze a broken state.
   */
  zero?: boolean;
}

/** Snapshot the horizontal scroll offset that must hold for the whole composition. */
export function captureHorizontalScrollLock(
  elements: Iterable<Element | null | undefined>,
  options: CaptureOptions = {},
): ScrollLockEntry[] {
  const entries: ScrollLockEntry[] = [];
  const seen = new Set<Element>();
  for (const el of elements) {
    if (!el || seen.has(el)) continue;
    seen.add(el);
    entries.push({ el, left: options.zero ? 0 : el.scrollLeft || 0 });
  }
  return entries;
}

/**
 * Put every locked box back where it was. Returns how many boxes had actually
 * drifted — the tests assert on this, and it is the signal that Chromium's
 * reveal-caret scroll fired.
 */
export function restoreHorizontalScrollLock(entries: readonly ScrollLockEntry[]): number {
  let corrected = 0;
  for (const entry of entries) {
    if ((entry.el.scrollLeft || 0) === entry.left) continue;
    entry.el.scrollLeft = entry.left;
    corrected += 1;
  }
  return corrected;
}

/**
 * The xterm-internal boxes that can absorb a reveal-caret scroll. Kept
 * separate from the ancestor chain because on desktop these are locked to 0
 * (`zero: true`) while ancestors are frozen at their live offset.
 */
export function imeInnerScrollTargets(host: Element): Element[] {
  const targets: Element[] = [host];
  for (const selector of [".xterm", ".xterm-screen", ".xterm-viewport", ".xterm-rows"]) {
    const found = host.querySelector(selector);
    if (found) targets.push(found);
  }
  return targets;
}

/**
 * Every scrollable-capable ancestor above the host, up to and including the
 * document element. Cheap (a handful of nodes) and only walked once per
 * composition, so no need to filter by computed style — restoring an offset a
 * box never had is a no-op.
 */
export function imeAncestorScrollTargets(host: Element): Element[] {
  const targets: Element[] = [];
  let node = host.parentElement;
  while (node) {
    targets.push(node);
    node = node.parentElement;
  }
  return targets;
}
