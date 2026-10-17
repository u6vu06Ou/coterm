// F: pure helpers for the Ctrl+F in-terminal search overlay. Extracted from
// TerminalDock so the key-detection + direction logic is unit-testable without
// a DOM or a live xterm Terminal (vitest runs in the node environment).

export interface SearchKeyEvent {
  // DOM KeyboardEvent.type is `string`; we only discriminate keydown vs other.
  type: string;
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export type SearchDirection = "next" | "previous";

// Returns true when the event is Ctrl+F (no shift/alt/meta) — the trigger that
// opens the search overlay. xterm's attachCustomKeyEventHandler returns false
// for this so \x06 is not forwarded to the PTY.
export function isSearchOpenShortcut(event: SearchKeyEvent): boolean {
  return (
    event.type === "keydown" &&
    event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    event.key.toLowerCase() === "f"
  );
}

// Resolve an overlay input keydown into a search action. Enter = next,
// Shift+Enter = previous, Escape = close. Returns null for keys the input
// should handle itself (typing, arrow navigation, etc.).
export function resolveSearchInputAction(event: SearchKeyEvent):
  | { kind: "close" }
  | { kind: "search"; direction: SearchDirection }
  | null {
  if (event.type !== "keydown") return null;
  if (event.key === "Escape") return { kind: "close" };
  if (event.key === "Enter") {
    return { kind: "search", direction: event.shiftKey ? "previous" : "next" };
  }
  return null;
}

// Debounce delay (ms) for search-as-you-type in the overlay input. Each
// keystroke re-arms the timer; the incremental find runs once the user pauses.
// IME compositions bypass the timer entirely (see TerminalDock handlers).
export const SEARCH_TYPEAHEAD_DELAY_MS = 120;

export interface SearchOverlayColors {
  matchBackground: string;
  matchBorder: string;
  matchOverviewRuler: string;
  activeMatchBackground: string;
  activeMatchBorder: string;
  activeMatchColorOverviewRuler: string;
}

// Theme-aware match decorations for the SearchAddon (providing `decorations`
// opts into highlight-all). Yellow swatch for matches, amber for the active
// one; alpha keeps both readable on the light and the dark palettes.
export function searchOverlayColors(isLight: boolean): SearchOverlayColors {
  return isLight
    ? {
        matchBackground: "rgba(255, 213, 79, 0.85)",
        matchBorder: "rgba(217, 168, 0, 0.9)",
        matchOverviewRuler: "#d9a800",
        activeMatchBackground: "rgba(255, 145, 0, 0.9)",
        activeMatchBorder: "rgba(214, 106, 0, 0.95)",
        activeMatchColorOverviewRuler: "#d66a00",
      }
    : {
        matchBackground: "rgba(255, 213, 79, 0.3)",
        matchBorder: "rgba(255, 213, 79, 0.8)",
        matchOverviewRuler: "#cfa00e",
        activeMatchBackground: "rgba(255, 145, 0, 0.45)",
        activeMatchBorder: "rgba(255, 167, 38, 0.9)",
        activeMatchColorOverviewRuler: "#ff9100",
      };
}
