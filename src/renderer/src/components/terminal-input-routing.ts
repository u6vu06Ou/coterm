// #14 (v1.5 Phase 2 retry): TerminalDock's custom key / ctrl+wheel / recovery
// dispatch extracted into injectable handlers so the PRODUCTION code path is
// the tested code path. Terminals, refs and DOM APIs sit behind tiny
// dependency interfaces — tests drive these handlers directly (vitest runs in
// the node environment; no live xterm/DOM needed), while TerminalDock wires
// them to the real xterm instance. Mirrors the terminal-recovery.ts /
// terminal-search-key.ts extraction pattern.

import { terminalCopyText } from "@shared/value";
import { isSearchOpenShortcut } from "./terminal-search-key";
import type { RecoveryStep } from "./terminal-recovery";

// Shift/Ctrl+Enter inserts a soft newline instead of submitting.
export const SOFT_NEWLINE_SEQ = "\n";

export interface RoutedKeyEvent {
  // DOM KeyboardEvent.type is `string`; only keydown is discriminated.
  type: string;
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export interface KeyRoutingActions {
  /** True while an IME composition is in flight. */
  isComposing(): boolean;
  writeInput(data: string): void;
  /** Clears the selected input if any; returns true when it consumed the key. */
  clearSelectedInput(): boolean;
  markClearNextDelete(): void;
  /**
   * Optional: typed printable char over an input-line selection replaces it.
   * Returns true when the char was consumed (selection translated away).
   * Omit/return false → the key passes through to xterm untouched.
   */
  replaceSelection?(char: string): boolean;
  selectAll(): void;
  openSearch(): void;
  getSelection(): string;
  copyText(text: string): void;
}

/**
 * The exact decision tree TerminalDock installs via
 * terminal.attachCustomKeyEventHandler. Return true = let xterm process the
 * key (forward bytes to the PTY); return false = Coterm consumed it.
 */
export function routeCustomKey(event: RoutedKeyEvent, actions: KeyRoutingActions): boolean {
  if (actions.isComposing() && event.key === "Enter") return false;
  if (
    event.type === "keydown" &&
    event.key === "Enter" &&
    (event.shiftKey || event.ctrlKey) &&
    !actions.isComposing()
  ) {
    actions.writeInput(SOFT_NEWLINE_SEQ);
    return false;
  }
  if (
    event.type === "keydown" &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    (event.key === "Backspace" || event.key === "Delete") &&
    actions.clearSelectedInput()
  ) {
    return false;
  }
  // Printable char over an input-line selection = replace the selection
  // (selection-aware translation in terminal-selection-edit.ts). Only fires
  // when a selection actually lies on the live input line; every other plain
  // keypress costs one hasSelection() check and passes through.
  if (
    event.type === "keydown" &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    event.key.length === 1 &&
    !actions.isComposing() &&
    actions.replaceSelection?.(event.key)
  ) {
    return false;
  }
  // Ctrl+A: select the visible buffer for copy; xterm's default would send
  // \x01 (readline home) to the PTY.
  if (
    event.type === "keydown" &&
    event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === "a"
  ) {
    actions.markClearNextDelete();
    actions.selectAll();
    return false;
  }
  // Ctrl+F: open the in-terminal search overlay; \x06 must not reach the PTY.
  if (isSearchOpenShortcut(event)) {
    actions.openSearch();
    return false;
  }
  const copied = terminalCopyText(event, actions.getSelection());
  if (copied === null) return true;
  actions.copyText(copied);
  return false;
}

export interface WheelZoomEvent {
  ctrlKey: boolean;
  deltaY: number;
  preventDefault(): void;
  stopPropagation(): void;
}

export interface WheelZoomActions {
  getFontSize(): number;
  applyFontSize(next: number): void;
}

/**
 * Ctrl+wheel = font zoom; consumed (preventDefault+stopPropagation) so
 * Chromium page-zoom and xterm's own wheel handler never double-run. Any
 * non-ctrl wheel is left to xterm natively (see the TerminalDock "ponytail"
 * note: a second local scrollLines fought xterm's handler into jitter).
 * Returns true when Coterm consumed the event.
 */
export function routeCtrlWheelZoom(event: WheelZoomEvent, actions: WheelZoomActions): boolean {
  if (!event.ctrlKey) return false;
  event.preventDefault();
  event.stopPropagation();
  const delta = -Math.sign(event.deltaY);
  if (delta === 0) return true;
  actions.applyFontSize(actions.getFontSize() + delta);
  return true;
}

export interface RecoveryActions {
  remeasure(): void;
  /** `replace` mirrors the plan step; `reason` decides manual vs automatic replay. */
  requestAuthoritativeReplay(replace: boolean, reason: string): void;
  refreshCanvas(): void;
  restoreFocusScroll(): void;
}

/**
 * Executes planRecovery steps in order against the caller-owned side effects.
 * The plan is structurally kill-free (no kill/restart step exists) — recovery
 * rehydrates via remeasure + authoritative replay + canvas refresh + focus
 * restore, never by respawning the PTY (#14 contract).
 */
export function executeRecoveryPlan(steps: readonly RecoveryStep[], reason: string, actions: RecoveryActions): void {
  for (const step of steps) {
    switch (step.kind) {
      case "remeasure":
        actions.remeasure();
        break;
      case "request-authoritative-replay":
        actions.requestAuthoritativeReplay(step.replace === true, reason);
        break;
      case "refresh-canvas":
        actions.refreshCanvas();
        break;
      case "restore-focus-scroll":
        actions.restoreFocusScroll();
        break;
    }
  }
}
