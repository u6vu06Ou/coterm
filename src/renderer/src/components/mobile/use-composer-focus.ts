// Focus-ownership machinery shared by every mobile composer surface: the
// floating MobileCommandComposer and the phone reader's inline input.
//
// Background (see mobile-composer-focus.ts): an Android/iOS IME language
// switch tears down the input connection — keyboard hide/reshow fires
// visualViewport resizes, focus drops to body/html/null or is stolen into
// xterm's helper textarea, and keyboard reconnect routinely outlasts an rAF
// budget. This hook owns all listeners/timers; mobile-composer-focus.ts owns
// the pure may-we-take-focus-back decision. The reader MUST reuse this: its
// content keeps updating live while the agent runs, and without reclaim a
// mid-typing re-render that drops focus would collapse the keyboard.

import { useEffect, useMemo, useRef } from "react";
import {
  FOCUS_RECLAIM_RETRY_DELAYS_MS,
  OUTSIDE_TAP_SUSPEND_MS,
  shouldRebindAfterKeyboardDrop,
  shouldReclaimComposerFocus,
  type ComposerFocusProbe,
} from "./mobile-composer-focus";
import { mobileInputController } from "./mobile-input-controller";

export interface ComposerFocusOwnershipOptions {
  /** True while this surface owns the composer for terminalId. */
  readonly open: boolean;
  readonly terminalId: string | null;
  /** Container div — controls inside it may legitimately hold focus. */
  readonly panelRef: { readonly current: HTMLElement | null };
  /** The textarea we are trying to keep focused. */
  readonly textareaRef: { readonly current: HTMLTextAreaElement | null };
  /**
   * Bumps when the floating composer re-opens; re-runs the initial autofocus
   * (iOS only accepts programmatic focus inside the user-gesture task, so the
   * first focus attempt fires on the opening generation, not on mount).
   */
  readonly openingGeneration?: number | null;
  /**
   * Default true: focus the textarea on open (floating composer pops the
   * keyboard by design). The reader passes false — opening reading mode must
   * not pop the keyboard over content; focus starts with the user's tap.
   */
  readonly focusOnOpen?: boolean;
}

export interface ComposerFocusOwnership {
  /** Call from the textarea's onBlur. */
  readonly notifyComposerBlur: () => void;
}

export function useComposerFocusOwnership(options: ComposerFocusOwnershipOptions): ComposerFocusOwnership {
  const { open, terminalId, panelRef, textareaRef, openingGeneration = null, focusOnOpen = true } = options;
  const reclaimFocusRef = useRef<() => void>(() => undefined);

  // Initial focus on open. Short rAF ladder — the reclaim effect below owns
  // anything later. Skipped entirely when focusOnOpen is false (reader).
  useEffect(() => {
    if (!open || !terminalId || !focusOnOpen) return;
    let cancelled = false;
    let attempts = 0;
    const focus = (): void => {
      if (cancelled || attempts >= 5) return;
      attempts += 1;
      if (document.activeElement !== textareaRef.current) textareaRef.current?.focus({ preventScroll: true });
      if (document.activeElement === textareaRef.current) mobileInputController.markFocused();
      else requestAnimationFrame(focus);
    };
    const frame = requestAnimationFrame(focus);
    return () => { cancelled = true; cancelAnimationFrame(frame); };
  }, [focusOnOpen, open, terminalId, openingGeneration, textareaRef]);

  // Focus ownership while open: retry on a ~600ms timer ladder after any
  // blur, re-assert on viewport resize / window refocus — except right after
  // a deliberate tap outside the composer panel.
  useEffect(() => {
    if (!open || !terminalId) return;
    let disposed = false;
    let settled = false;
    let timers: number[] = [];
    const cancelRetries = (): void => {
      for (const timer of timers) window.clearTimeout(timer);
      timers = [];
    };
    const lastOutsidePointerDownRef = { current: 0 };
    const attempt = (): boolean => {
      if (disposed || !mobileInputController.isOpenFor(terminalId)) return false;
      const focusProbe: ComposerFocusProbe = {
        activeElement: document.activeElement,
        panel: panelRef.current,
        textarea: textareaRef.current,
        recentOutsidePointerDown: Date.now() - lastOutsidePointerDownRef.current < OUTSIDE_TAP_SUSPEND_MS,
      };
      if (!shouldReclaimComposerFocus(focusProbe)) return false;
      textareaRef.current?.focus({ preventScroll: true });
      const ok = document.activeElement === textareaRef.current;
      if (ok) mobileInputController.markFocused();
      return ok;
    };
    const scheduleReclaim = (): void => {
      if (disposed) return;
      cancelRetries();
      settled = false;
      for (const delay of FOCUS_RECLAIM_RETRY_DELAYS_MS) {
        timers.push(window.setTimeout(() => {
          if (disposed || settled) return;
          if (attempt()) settled = true;
        }, delay));
      }
    };
    reclaimFocusRef.current = scheduleReclaim;
    // Resize re-assert rides the same ladder via scheduleReclaim; while the
    // textarea still holds focus every attempt is a no-op. That no-op is the
    // v1.5.59 field bug: after a 中/EN switch the OS hides the keyboard but
    // the textarea keeps DOM focus (ring stays lit), so nothing reconnects.
    // When the viewport grows by a keyboard's worth while we still hold
    // focus, blur+focus forces a fresh input connection.
    let lastViewportHeight = window.visualViewport?.height ?? window.innerHeight;
    let lastRebindAt = Number.NEGATIVE_INFINITY;
    const onViewportResize = (): void => {
      const height = window.visualViewport?.height ?? window.innerHeight;
      const textarea = textareaRef.current;
      const rebind = !disposed && textarea !== null && mobileInputController.isOpenFor(terminalId) && shouldRebindAfterKeyboardDrop({
        textareaFocused: document.activeElement === textarea,
        previousViewportHeight: lastViewportHeight,
        viewportHeight: height,
        recentOutsidePointerDown: Date.now() - lastOutsidePointerDownRef.current < OUTSIDE_TAP_SUSPEND_MS,
        msSinceLastRebind: Date.now() - lastRebindAt,
      });
      lastViewportHeight = height;
      if (rebind && textarea) {
        lastRebindAt = Date.now();
        const { selectionStart, selectionEnd } = textarea;
        textarea.blur();
        textarea.focus({ preventScroll: true });
        try { textarea.setSelectionRange(selectionStart, selectionEnd); } catch { /* detached */ }
        if (document.activeElement === textarea) mobileInputController.markFocused();
      }
      scheduleReclaim();
    };
    const onWindowFocus = (): void => scheduleReclaim();
    const onVisibilityChange = (): void => {
      if (!document.hidden) scheduleReclaim();
    };
    const onPointerDownCapture = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target && panelRef.current?.contains(target)) return;
      lastOutsidePointerDownRef.current = Date.now();
    };
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", onViewportResize);
    window.addEventListener("focus", onWindowFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pointerdown", onPointerDownCapture, true);
    return () => {
      disposed = true;
      cancelRetries();
      reclaimFocusRef.current = () => undefined;
      viewport?.removeEventListener("resize", onViewportResize);
      window.removeEventListener("focus", onWindowFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pointerdown", onPointerDownCapture, true);
    };
  }, [open, terminalId, panelRef, textareaRef]);

  return useMemo(() => ({ notifyComposerBlur: () => reclaimFocusRef.current() }), []);
}
