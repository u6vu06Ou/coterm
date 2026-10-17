import { describe, expect, it } from "vitest";
import {
  isSearchOpenShortcut,
  resolveSearchInputAction,
  SEARCH_TYPEAHEAD_DELAY_MS,
  searchOverlayColors,
  type SearchKeyEvent,
} from "../../src/renderer/src/components/terminal-search-key";

function key(partial: Partial<SearchKeyEvent>): SearchKeyEvent {
  return {
    type: "keydown",
    key: "f",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...partial,
  };
}

describe("isSearchOpenShortcut (Ctrl+F trigger)", () => {
  it("matches Ctrl+F with no modifiers", () => {
    expect(isSearchOpenShortcut(key({ key: "f", ctrlKey: true }))).toBe(true);
    expect(isSearchOpenShortcut(key({ key: "F", ctrlKey: true }))).toBe(true);
  });

  it("rejects Ctrl+Shift+F (reserved by browser/other)", () => {
    expect(isSearchOpenShortcut(key({ key: "f", ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it("rejects Ctrl+Alt+F and Cmd+F", () => {
    expect(isSearchOpenShortcut(key({ key: "f", ctrlKey: true, altKey: true }))).toBe(false);
    expect(isSearchOpenShortcut(key({ key: "f", metaKey: true }))).toBe(false);
  });

  it("rejects plain F with no ctrl", () => {
    expect(isSearchOpenShortcut(key({ key: "f" }))).toBe(false);
  });

  it("rejects keyup events", () => {
    expect(isSearchOpenShortcut(key({ type: "keyup", key: "f", ctrlKey: true }))).toBe(false);
  });

  it("does not fire on Ctrl+A / Ctrl+C", () => {
    expect(isSearchOpenShortcut(key({ key: "a", ctrlKey: true }))).toBe(false);
    expect(isSearchOpenShortcut(key({ key: "c", ctrlKey: true }))).toBe(false);
  });
});

describe("resolveSearchInputAction (overlay keys)", () => {
  it("Enter = search next", () => {
    expect(resolveSearchInputAction(key({ key: "Enter" }))).toEqual({
      kind: "search",
      direction: "next",
    });
  });

  it("Shift+Enter = search previous", () => {
    expect(resolveSearchInputAction(key({ key: "Enter", shiftKey: true }))).toEqual({
      kind: "search",
      direction: "previous",
    });
  });

  it("Escape = close", () => {
    expect(resolveSearchInputAction(key({ key: "Escape" }))).toEqual({ kind: "close" });
  });

  it("typing keys are null (input handles them)", () => {
    expect(resolveSearchInputAction(key({ key: "a" }))).toBeNull();
    expect(resolveSearchInputAction(key({ key: "Backspace" }))).toBeNull();
    expect(resolveSearchInputAction(key({ key: "ArrowLeft" }))).toBeNull();
  });

  it("keyup is null", () => {
    expect(
      resolveSearchInputAction(key({ type: "keyup", key: "Enter" })),
    ).toBeNull();
  });
});

describe("search typeahead helpers", () => {
  it("debounce delay is ~120ms", () => {
    expect(SEARCH_TYPEAHEAD_DELAY_MS).toBe(120);
  });

  it("light and dark palettes differ and expose all six decoration fields", () => {
    const light = searchOverlayColors(true);
    const dark = searchOverlayColors(false);

    for (const palette of [light, dark]) {
      for (const value of Object.values(palette)) {
        expect(typeof value).toBe("string");
        expect(value.length).toBeGreaterThan(0);
      }
    }

    // Distinct overview-ruler swatches so the band is readable on both themes.
    expect(light.matchOverviewRuler).toBe("#d9a800");
    expect(dark.matchOverviewRuler).toBe("#cfa00e");
    expect(light.activeMatchColorOverviewRuler).toBe("#d66a00");
    expect(dark.activeMatchColorOverviewRuler).toBe("#ff9100");
  });
});
