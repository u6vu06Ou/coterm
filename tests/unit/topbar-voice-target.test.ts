// @vitest-environment node
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { useAppStore } from "../../src/renderer/src/store/app-store";
import { resolveVoiceTargetTerminalId } from "../../src/renderer/src/components/topbar-logic";
import type { DockLayout } from "../../src/shared/types";

// voicefix: voice dictation must target the terminal THIS window's user last
// picked with a local pointer gesture, not the main-owned global selection —
// another client (Agent API opening a tile) steals selectedTerminalId over the WS
// broadcast mid-utterance.

const originalState = useAppStore.getState();

const TERM_A = "11111111-1111-4111-8111-111111111111";
const TERM_B = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";

beforeAll(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
});

afterEach(() => {
  useAppStore.setState(originalState, true);
});

function layout(selectedTerminalId: string | null, tileIds: string[]): DockLayout {
  return {
    tiles: tileIds.map((terminalId) => ({
      terminalId,
      projectId: PROJECT,
      weight: 1,
      agentProfile: null,
    })),
    selectedTerminalId,
    exclusiveTerminalId: null,
    rows: [1],
    cols: [[1]],
    ptyCols: 100,
    ptyRows: 28,
  };
}

function tileIds(l: DockLayout): string[] {
  return l.tiles.map((tile) => tile.terminalId);
}

function currentVoiceTarget(): string | null {
  const state = useAppStore.getState();
  return resolveVoiceTargetTerminalId(
    state.lastLocalSelectedTerminalId,
    tileIds(state.dockLayout),
    state.dockLayout.selectedTerminalId,
  );
}

describe("resolveVoiceTargetTerminalId (pure)", () => {
  const ids = [TERM_A, TERM_B];

  it("prefers the pin over the global selection", () => {
    expect(resolveVoiceTargetTerminalId(TERM_A, ids, TERM_B)).toBe(TERM_A);
  });

  it("falls back to the global selection when there is no pin", () => {
    expect(resolveVoiceTargetTerminalId(null, ids, TERM_B)).toBe(TERM_B);
  });

  it("falls back to the global selection when the pinned terminal is gone", () => {
    expect(resolveVoiceTargetTerminalId(TERM_A, [TERM_B], TERM_B)).toBe(TERM_B);
  });

  it("returns null when neither pin nor selection exists", () => {
    expect(resolveVoiceTargetTerminalId(null, ids, null)).toBeNull();
  });
});

describe("voice target pinning (app-store integration)", () => {
  it("noteLocalTileSelection sets the pin synchronously (no IPC round trip)", () => {
    useAppStore.setState({ dockLayout: layout(TERM_A, [TERM_A, TERM_B]) });

    useAppStore.getState().noteLocalTileSelection(TERM_B);

    expect(useAppStore.getState().lastLocalSelectedTerminalId).toBe(TERM_B);
  });

  it("acceptance: local pick A → external client steals selection to B → target stays A", () => {
    // 1. Local user pointer-picks A (TerminalDock onActivate / mobile select).
    useAppStore.setState({ dockLayout: layout(TERM_A, [TERM_A]) });
    useAppStore.getState().noteLocalTileSelection(TERM_A);
    // 2. External client (Agent API) opens B; main moves selectedTerminalId to B and
    //    broadcasts the layout over WS — the renderer applies it wholesale.
    useAppStore.setState({ dockLayout: layout(TERM_B, [TERM_A, TERM_B]) });

    // 3. Voice tap-start / onVoiceFinal resolve through the pin → A, not B.
    expect(currentVoiceTarget()).toBe(TERM_A);
  });

  it("pin survives broadcast selection changes made by others", () => {
    useAppStore.setState({ dockLayout: layout(TERM_A, [TERM_A, TERM_B]) });
    useAppStore.getState().noteLocalTileSelection(TERM_A);

    // Repeated foreign selection flips never move the pin.
    useAppStore.setState({ dockLayout: layout(TERM_B, [TERM_A, TERM_B]) });
    useAppStore.setState({ dockLayout: layout(null, [TERM_A, TERM_B]) });

    expect(useAppStore.getState().lastLocalSelectedTerminalId).toBe(TERM_A);
    expect(currentVoiceTarget()).toBe(TERM_A);
  });

  it("a later local pick re-pins (bing A→B→talk goes to B)", () => {
    useAppStore.setState({ dockLayout: layout(TERM_A, [TERM_A, TERM_B]) });
    useAppStore.getState().noteLocalTileSelection(TERM_A);
    useAppStore.setState({ dockLayout: layout(TERM_B, [TERM_A, TERM_B]) });
    useAppStore.getState().noteLocalTileSelection(TERM_B);

    expect(currentVoiceTarget()).toBe(TERM_B);
  });

  it("pinned terminal closed → falls back to the global selection", () => {
    useAppStore.setState({ dockLayout: layout(TERM_A, [TERM_A, TERM_B]) });
    useAppStore.getState().noteLocalTileSelection(TERM_A);
    // A closes; main reselects B and broadcasts.
    useAppStore.setState({ dockLayout: layout(TERM_B, [TERM_B]) });

    expect(currentVoiceTarget()).toBe(TERM_B);
  });

  it("no pin at all → global selection (pre-fix behaviour, still sane)", () => {
    useAppStore.setState({ dockLayout: layout(TERM_B, [TERM_A, TERM_B]) });

    expect(currentVoiceTarget()).toBe(TERM_B);
  });
});
