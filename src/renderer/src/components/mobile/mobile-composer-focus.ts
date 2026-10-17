// Focus-ownership policy for MobileCommandComposer (the floating textarea that
// overlays the PTY on phones).
//
// Background: an Android IME language switch (e.g. EN <-> 注音) tears down the
// input connection — the soft keyboard hides and re-shows, visualViewport
// resizes fire, and focus can land on body/html/null, or be stolen into a
// helper element (xterm's hidden textarea, refocused by terminal recovery on
// every viewport resize). The composer's old onBlur reclaim (3 rAF retries,
// and deliberately ignoring any "real" element) was not enough: keyboard
// reconnect can take far longer than 3 frames, and the xterm helper textarea
// theft reads as "a real element holds focus → leave it alone".
//
// This module is the pure decision ("may we take focus back right now?") so
// the policy stays unit-testable; the component owns all listeners/timers.

export interface ComposerFocusProbe {
  /** document.activeElement at probe time (null when nothing holds focus). */
  readonly activeElement: Element | null;
  /** The composer panel root — controls inside it may legitimately hold focus. */
  readonly panel: Element | null;
  /** The composer textarea we are trying to keep focused. */
  readonly textarea: Element | null;
  /**
   * True when a pointerdown outside the composer landed within the suspend
   * window (OUTSIDE_TAP_SUSPEND_MS). A deliberate outside tap is the only
   * legitimate way focus moves away while the composer stays open, so during
   * that window we do not fight it. Every deliberate outside-focus path that
   * matters (send / cancel / use-native-keyboard / terminal switch) also
   * closes the composer, which stops reclaim entirely.
   */
  readonly recentOutsidePointerDown: boolean;
}

export function shouldReclaimComposerFocus(probe: ComposerFocusProbe): boolean {
  const { activeElement, panel, textarea, recentOutsidePointerDown } = probe;
  if (!textarea) return false;
  if (activeElement === textarea) return false; // already focused — nothing to do
  // A control inside our own dialog (send / cancel / send-with-enter toggle)
  // is allowed to hold focus for the duration of its tap.
  if (activeElement && panel?.contains(activeElement)) return false;
  // IME teardown lands focus on body / documentElement / null: nothing real
  // holds it, so take it back unconditionally.
  if (!activeElement) return true;
  const tag = activeElement.tagName;
  if (tag === "BODY" || tag === "HTML") return true;
  // A real element outside the composer holds focus. Legitimate only when the
  // user just tapped outside; otherwise it is a programmatic steal (e.g. the
  // xterm helper textarea during viewport-resize recovery) and we reclaim.
  return !recentOutsidePointerDown;
}

/**
 * Suppress window for deliberate outside taps (pointerdown outside the
 * composer). Long enough to cover the tap's click/focus settling, short enough
 * that an IME language switch (which produces no page pointerdown) is never
 * mistaken for one.
 */
export const OUTSIDE_TAP_SUSPEND_MS = 700;

/**
 * Blur-reclaim retry ladder. Android keyboard teardown/reconnect after a
 * language switch routinely outlasts the old "3 animation frames" budget; the
 * ladder reaches ~0.6s and each rung is a no-op once focus is back.
 */
export const FOCUS_RECLAIM_RETRY_DELAYS_MS: readonly number[] = [16, 90, 200, 380, 600];

// "Yellow ring, dead keyboard" (2026-10-06, v1.5.59 field report): after an
// Android 中/EN switch the textarea KEEPS DOM focus (its :focus ring stays
// lit), but the IME input connection is gone — the keyboard hides and typing
// goes nowhere until the user taps the box. shouldReclaimComposerFocus sees
// "already focused" and does nothing, so DOM focus alone cannot be the
// signal. The keyboard hiding shows up as visualViewport growing back while
// the textarea is still the active element; that is when we must blur+focus
// to force Chrome to open a fresh input connection.

export interface KeyboardDropProbe {
  readonly textareaFocused: boolean;
  /** visualViewport height before this resize event. */
  readonly previousViewportHeight: number;
  readonly viewportHeight: number;
  readonly recentOutsidePointerDown: boolean;
  /** ms since the last rebind we performed (Infinity if never). */
  readonly msSinceLastRebind: number;
}

/** A height jump this large is a keyboard hiding, not an IME candidate bar. */
export const KEYBOARD_DROP_MIN_GROWTH_PX = 120;
/** One rebind per drop; stops any show/hide ping-pong. */
export const KEYBOARD_REBIND_COOLDOWN_MS = 800;

export function shouldRebindAfterKeyboardDrop(probe: KeyboardDropProbe): boolean {
  if (!probe.textareaFocused) return false; // blur path owns this case
  if (probe.recentOutsidePointerDown) return false;
  if (probe.msSinceLastRebind < KEYBOARD_REBIND_COOLDOWN_MS) return false;
  return probe.viewportHeight - probe.previousViewportHeight >= KEYBOARD_DROP_MIN_GROWTH_PX;
}
