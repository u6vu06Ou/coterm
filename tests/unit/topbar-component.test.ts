// @vitest-environment node
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";

// Mock the app-store before importing TopBar. The store is a zustand singleton;
// we replace it with a mutable stub so each test can set the state TopBar reads.
const storeState: Record<string, unknown> = {
  dockLayout: { tiles: [], selectedTerminalId: null, exclusiveTerminalId: null, rows: [], cols: [], ptyCols: 100, ptyRows: 28 },
  settings: { theme: "dark", locale: "en-US", voice: { enabled: false, lang: "zh-TW" } },
  ptyStates: {},
  selectTile: () => Promise.resolve(),
  lastLocalSelectedTerminalId: null,
  noteLocalTileSelection: () => undefined,
  setExclusive: () => Promise.resolve(),
  setSettingsOpen: () => undefined,
  setCheckpointOpen: () => undefined,
  updateSettings: () => Promise.resolve(),
  requestTerminalRecovery: () => undefined,
  checkpointOpen: false,
};

vi.mock("../../src/renderer/src/store/app-store", () => ({
  useAppStore: Object.assign(
    () => storeState,
    { getState: () => storeState, setState: () => undefined },
  ),
}));

// Mock useI18n to return a translator that echoes the key (so we can assert
// which keys are consumed) and a fixed locale.
vi.mock("../../src/renderer/src/i18n", () => ({
  useI18n: () => ({
    locale: "en-US",
    t: (key: string, vars?: Record<string, string | number>) => {
      if (!vars) return key;
      return key + JSON.stringify(vars);
    },
  }),
}));

// Mock voice-input (not under test) to avoid pulling in browser APIs.
vi.mock("../../src/renderer/src/components/voice-input", () => ({
  useVoiceInput: () => ({ isSupported: false, isRecording: false, start: () => undefined, stop: () => undefined, interim: "" }),
}));

// Mock usage-hud (not under test).
vi.mock("../../src/renderer/src/components/usage-hud", () => ({
  UsageHud: () => null as unknown as React.JSX.Element,
}));

// Mock terminal-recovery buildStopPayload (not under test).
vi.mock("../../src/renderer/src/components/terminal-recovery", () => ({
  buildStopPayload: (id: string) => ({ terminalId: id, data: "\x03" }),
}));

// Mock shouldSendMobileTileSelection (pure, keep real).
vi.mock("../../src/renderer/src/components/topbar-logic", async () => {
  const actual = await vi.importActual<typeof import("../../src/renderer/src/components/topbar-logic")>("../../src/renderer/src/components/topbar-logic");
  return { ...actual };
});

import { TopBar } from "../../src/renderer/src/components/TopBar";

const T1 = "11111111-1111-4111-8111-111111111111";

beforeAll(() => {
  // Minimal window stub: matchMedia returns mobile=false so the desktop branch
  // renders (the desktop fleet is what we assert here). isBrowser=false.
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      matchMedia: () => ({ matches: false, media: "", onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }),
      aiTerminal: { isBrowser: false },
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  // Reset store to baseline.
  storeState.dockLayout = { tiles: [], selectedTerminalId: null, exclusiveTerminalId: null, rows: [], cols: [], ptyCols: 100, ptyRows: 28 };
  storeState.ptyStates = {};
  storeState.settings = { theme: "dark", locale: "en-US", voice: { enabled: false, lang: "zh-TW" } };
  // Reset window to desktop (matchMedia mobile=false).
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      matchMedia: () => ({ matches: false, media: "", onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }),
      aiTerminal: { isBrowser: false },
    },
  });
});

function setMobileMatchMedia(): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      matchMedia: (query: string) => ({
        matches: query.includes("max-width") || query.includes("pointer: coarse"),
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }),
      aiTerminal: { isBrowser: false },
    },
  });
}

describe("TopBar desktop render — operation chrome", () => {
  it("never renders the fleet status dashboard", () => {
    storeState.dockLayout = {
      tiles: [{ terminalId: T1, projectId: "p", weight: 1, agentProfile: "claude-local-main" }],
      selectedTerminalId: T1,
      exclusiveTerminalId: null,
      rows: [], cols: [], ptyCols: 100, ptyRows: 28,
    };
    storeState.ptyStates = { [T1]: "error" };
    const html = renderToStaticMarkup(React.createElement(TopBar));
    expect(html).not.toContain("topbar-fleet");
    expect(html).not.toContain("fleet.label");
    expect(html).not.toContain("topbar.attention");
  });

  it("keeps per-terminal signal lamps without exposing state text", () => {
    storeState.dockLayout = {
      tiles: [{ terminalId: T1, projectId: "p", weight: 1, agentProfile: "claude-local-main" }],
      selectedTerminalId: T1,
      exclusiveTerminalId: null,
      rows: [], cols: [], ptyCols: 100, ptyRows: 28,
    };
    storeState.ptyStates = { [T1]: "error" };
    const html = renderToStaticMarkup(React.createElement(TopBar));
    expect(html).toContain("pty-signal");
    expect(html).not.toContain("pty.state.error");
  });
});

describe("TopBar mobile render — keyboard input overlay", () => {
  // NOTE: The keyboard buttons live inside {keysOpen && ...} so they only
  // render after the user taps the PTY dropdown toggle. Server-side rendering
  // only covers the always-visible mobile chrome.

  it("mobile dock bar renders (mobile branch is taken via matchMedia mock)", () => {
    setMobileMatchMedia();
    storeState.dockLayout = {
      tiles: [{ terminalId: T1, projectId: "p", weight: 1, agentProfile: "claude-local-main" }],
      selectedTerminalId: T1,
      exclusiveTerminalId: null,
      rows: [], cols: [], ptyCols: 100, ptyRows: 28,
    };
    const html = renderToStaticMarkup(React.createElement(TopBar));
    expect(html).toContain("mobile-dock-bar");
    // The PTY dropdown toggle (which opens the panel containing the keyboard
    // button + FLEET row) is present and enabled.
    expect(html).toContain('data-action-id="topbar.mobile.keys.toggle"');
    expect(html).not.toContain('data-action-id="topbar.mobile.keys.toggle"[^>]*disabled');
  });

  it("mobile Enter button is disabled when there is no active terminal", () => {
    setMobileMatchMedia();
    storeState.dockLayout = {
      tiles: [{ terminalId: T1, projectId: "p", weight: 1, agentProfile: "claude-local-main" }],
      selectedTerminalId: null,
      exclusiveTerminalId: null,
      rows: [], cols: [], ptyCols: 100, ptyRows: 28,
    };
    const html = renderToStaticMarkup(React.createElement(TopBar));
    const enterBtn = html.match(/data-action-id="topbar\.mobile\.enter"[^>]*disabled/);
    expect(enterBtn).not.toBeNull();
  });
});
