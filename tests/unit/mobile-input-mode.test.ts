// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readMobileInputMode,
  resolveMobileTapAction,
  writeMobileInputMode,
} from "../../src/renderer/src/components/mobile/mobile-input-mode";

// In-memory localStorage stub. The module reads/writes `localStorage` directly,
// so we inject a minimal store on globalThis — no jsdom needed.
function makeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    removeItem: (k: string) => { store.delete(k); },
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
  } as Storage;
}

let storage: Storage;
beforeEach(() => {
  storage = makeStorage();
  vi.stubGlobal("localStorage", storage);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveMobileTapAction", () => {
  it("returns none for non-open-composer gestures regardless of mode", () => {
    expect(resolveMobileTapAction("scroll", "composer")).toBe("none");
    expect(resolveMobileTapAction("scroll", "direct")).toBe("none");
    expect(resolveMobileTapAction("pan", "direct")).toBe("none");
    expect(resolveMobileTapAction("noop", "composer")).toBe("none");
  });

  it("opens composer for open-composer gesture in composer mode", () => {
    expect(resolveMobileTapAction("open-composer", "composer")).toBe("open-composer");
  });

  it("focuses pty for open-composer gesture in direct mode", () => {
    expect(resolveMobileTapAction("open-composer", "direct")).toBe("focus-pty");
  });

  it("treats unknown gesture strings as none", () => {
    expect(resolveMobileTapAction("whatever", "direct")).toBe("none");
    expect(resolveMobileTapAction("", "composer")).toBe("none");
  });
});

describe("readMobileInputMode", () => {
  it("defaults to composer when storage is empty", () => {
    expect(readMobileInputMode()).toBe("composer");
  });

  it("returns direct when stored", () => {
    storage.setItem("coterm.mobile.inputMode", "direct");
    expect(readMobileInputMode()).toBe("direct");
  });

  it("falls back to composer on a corrupt value", () => {
    storage.setItem("coterm.mobile.inputMode", "garbage");
    expect(readMobileInputMode()).toBe("composer");
  });

  it("round-trips through writeMobileInputMode", () => {
    writeMobileInputMode("direct");
    expect(readMobileInputMode()).toBe("direct");
    writeMobileInputMode("composer");
    expect(readMobileInputMode()).toBe("composer");
  });
});

describe("writeMobileInputMode", () => {
  it("persists the mode", () => {
    writeMobileInputMode("direct");
    expect(storage.getItem("coterm.mobile.inputMode")).toBe("direct");
  });

  it("does not throw when storage is unavailable", () => {
    // Simulate Safari private mode: accessing localStorage throws.
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => { throw new Error("SecurityError"); },
    });
    expect(() => writeMobileInputMode("direct")).not.toThrow();
    expect(readMobileInputMode()).toBe("composer");
  });
});
