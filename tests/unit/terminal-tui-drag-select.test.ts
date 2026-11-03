import { afterEach, describe, expect, it, vi } from "vitest";
import { cellFromPoint, installTuiDragSelect, selectionSpan, shouldInterceptTuiMouseDown } from "../../src/renderer/src/components/terminal-tui-drag-select";
import type { Terminal } from "@xterm/xterm";

describe("TUI drag select geometry", () => {
  it("maps a point to a buffer cell, clamped to the grid", () => {
    const rect = { left: 100, top: 50, width: 800, height: 400 };
    expect(cellFromPoint(100, 50, rect, 80, 20, 0)).toEqual({ col: 0, row: 0 });
    expect(cellFromPoint(115, 75, rect, 80, 20, 10)).toEqual({ col: 1, row: 11 });
    expect(cellFromPoint(5000, 5000, rect, 80, 20, 0)).toEqual({ col: 79, row: 19 });
  });

  it("builds a select() span in either drag direction", () => {
    expect(selectionSpan({ col: 5, row: 1 }, { col: 2, row: 2 }, 80)).toEqual({ col: 5, row: 1, length: 78 });
    expect(selectionSpan({ col: 2, row: 2 }, { col: 5, row: 1 }, 80)).toEqual({ col: 5, row: 1, length: 78 });
    expect(selectionSpan({ col: 3, row: 0 }, { col: 3, row: 0 }, 80)).toEqual({ col: 3, row: 0, length: 1 });
  });
});

describe("shouldInterceptTuiMouseDown", () => {
  const base = { button: 0, hasModifier: false, mouseTracking: true, overLink: false };

  it("intercepts a plain left click inside a mouse-tracking TUI", () => {
    expect(shouldInterceptTuiMouseDown(base)).toBe(true);
  });

  it("passes through when the click is on a link (xterm-cursor-pointer)", () => {
    // v1.5.57 regression: swallowing the down/up pair kept xterm's Linkifier
    // from ever calling activate(), so clicking a file path in Claude Code /
    // Codex did nothing (no artifact panel).
    expect(shouldInterceptTuiMouseDown({ ...base, overLink: true })).toBe(false);
  });

  it("does nothing when the app is not tracking the mouse", () => {
    expect(shouldInterceptTuiMouseDown({ ...base, mouseTracking: false, overLink: false })).toBe(false);
    expect(shouldInterceptTuiMouseDown({ ...base, mouseTracking: false, overLink: true })).toBe(false);
  });

  it("ignores non-left buttons and modified clicks", () => {
    expect(shouldInterceptTuiMouseDown({ ...base, button: 2 })).toBe(false);
    expect(shouldInterceptTuiMouseDown({ ...base, hasModifier: true })).toBe(false);
  });
});

// The installer wires mousedown interception on a plain object graph, so a
// DOM-lite fake (captured listeners + measured rects) suffices — vitest runs
// in the node environment and only globalThis.window needs a stub.
describe("installTuiDragSelect focus routing", () => {
  afterEach(() => vi.unstubAllGlobals());

  function fakeDom() {
    const listeners = new Map<string, (event: unknown) => void>();
    const screen = {
      getBoundingClientRect: () => ({ left: 100, top: 50, width: 800, height: 400 }),
    };
    const host = {
      addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
      removeEventListener: () => undefined,
      querySelector: (selector: string) => (selector === ".xterm-screen" ? screen : null),
      contains: () => true,
    } as unknown as HTMLElement;
    vi.stubGlobal("window", { addEventListener: () => undefined, removeEventListener: () => undefined });
    const focus = vi.fn();
    const select = vi.fn();
    const terminal = {
      modes: { mouseTrackingMode: "any" },
      cols: 80,
      rows: 20,
      buffer: { active: { viewportY: 0 } },
      hasSelection: () => false,
      clearSelection: vi.fn(),
      select,
      focus,
    } as unknown as Terminal;
    return { listeners, host, terminal, focus, select };
  }

  function leftDownEvent() {
    return {
      button: 0,
      shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
      clientX: 200, clientY: 200,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };
  }

  it("refocuses the terminal when it swallows a mousedown that starts a drag-select", () => {
    // Regression: an unfocused pane + swallowed mousedown left keyboard input
    // routed to the previously focused element, so select-then-Backspace was
    // a no-op. Focus is re-asserted WITHOUT sending bytes or moving the caret.
    const { listeners, host, terminal, focus, select } = fakeDom();
    installTuiDragSelect(terminal, host);
    const onDown = listeners.get("mousedown");
    expect(onDown).toBeDefined();
    onDown!(leftDownEvent());
    expect(focus).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled(); // focus only, no selection side effects yet
  });

  it("does not steal focus when the click is not intercepted (right button)", () => {
    const { listeners, host, terminal, focus } = fakeDom();
    installTuiDragSelect(terminal, host);
    const onDown = listeners.get("mousedown");
    onDown!({ ...leftDownEvent(), button: 2 });
    expect(focus).not.toHaveBeenCalled();
  });
});
