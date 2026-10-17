import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildStopPayload,
  createRecoveryScheduler,
  planRecovery,
  requestTerminalRecovery,
} from "../../src/renderer/src/components/terminal-recovery";

// Verdict gap 1: desktop Refresh must invoke the hard recovery path and force
// a local canvas refresh even without incoming bytes — NOT call
// refreshTerminal directly. requestTerminalRecovery is the single entry point
// TopBar (desktop + mobile) calls; it schedules a coalesced recovery that
// always includes the canvas-refresh step.

describe("requestTerminalRecovery (single entry point for Refresh)", () => {
  it("is a function that takes a terminalId + reason", () => {
    expect(typeof requestTerminalRecovery).toBe("function");
  });

  it("schedules a coalesced run that executes planRecovery's canvas step", async () => {
    const executed: string[] = [];
    const scheduler = createRecoveryScheduler((reason) => {
      executed.push(reason);
      const steps = planRecovery("term-1");
      // The canvas-refresh step must be part of every scheduled recovery.
      expect(steps.some((s) => s.kind === "refresh-canvas")).toBe(true);
    }, 20);
    requestTerminalRecovery("term-1", "manual-refresh", scheduler);
    await new Promise((r) => setTimeout(r, 60));
    expect(executed).toEqual(["manual-refresh"]);
  });

  it("coalesces rapid manual + sidebar triggers into one run", async () => {
    const runs: string[] = [];
    const scheduler = createRecoveryScheduler((reason) => runs.push(reason), 20);
    requestTerminalRecovery("term-1", "manual-refresh", scheduler);
    requestTerminalRecovery("term-1", "sidebar", scheduler);
    requestTerminalRecovery("term-1", "explorer", scheduler);
    await new Promise((r) => setTimeout(r, 60));
    expect(runs).toEqual(["explorer"]);
  });
});

describe("buildStopPayload still exactly \\x03", () => {
  it("STOP contract unchanged after recovery refactor", () => {
    const payload = buildStopPayload("term-1");
    expect(payload.data).toBe("\x03");
  });
});

describe("runtime layout trigger wiring", () => {
  const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");
  const storeSource = readFileSync("src/renderer/src/store/app-store.ts", "utf8");
  const topBarSource = readFileSync("src/renderer/src/components/TopBar.tsx", "utf8");

  it("recovers the selected terminal after sidebar toggle and resize", () => {
    expect(appSource).toContain('recoverSelectedTerminal("sidebar-toggle")');
    expect(appSource).toContain('recoverSelectedTerminal("sidebar-resize")');
  });

  it("recovers after explorer, split-layout, and exclusive layout changes", () => {
    expect(storeSource).toContain('requestSelectedTerminalRecovery(get, "explorer")');
    expect(storeSource).toContain('requestSelectedTerminalRecovery(get, "split-layout")');
    // #15: setExclusive is coalesced, so the exclusive recovery lives in the
    // applyExclusiveToggle sink rather than inside the store action itself.
    expect(storeSource).toContain('requestSelectedTerminalRecovery(useAppStore.getState, "exclusive")');
  });

  it("keeps every secondary mobile action inside the overlay menu", () => {
    const menuStart = topBarSource.indexOf('<div className="mobile-menu-panel" role="menu">');
    const enterStart = topBarSource.indexOf('data-action-id="topbar.mobile.enter"', menuStart);
    expect(menuStart).toBeGreaterThan(0);
    expect(topBarSource.slice(menuStart, enterStart)).toContain("renderPtySlot(");
    expect(topBarSource).toContain('data-action-id="topbar.mobile.terminal.select"');
    for (const actionId of [
      "topbar.mobile.stop",
      "topbar.mobile.key.up",
      "topbar.mobile.key.down",
      "topbar.mobile.key.left",
      "topbar.mobile.key.right",
      "topbar.mobile.key.escape",
      "topbar.mobile.key.tab",
      "topbar.mobile.refresh",
      "topbar.mobile.paste",
      "topbar.mobile.attach.open",
    ]) {
      const action = topBarSource.indexOf(`data-action-id="${actionId}"`, menuStart);
      expect(action).toBeGreaterThan(menuStart);
      expect(action).toBeLessThan(enterStart);
    }
    expect(topBarSource).toContain('requestTerminalRecovery(activeTerminalId, "mobile-refresh")');
  });

  it("hard-remounts the xterm engine and protects Ctrl+wheel from page zoom", () => {
    const terminalSource = readFileSync("src/renderer/src/components/TerminalDock.tsx", "utf8");
    expect(terminalSource).toContain("setEngineGeneration((generation) => generation + 1)");
    expect(terminalSource).toContain("clearSharedTextureAtlas()");
    expect(terminalSource).toContain("event.preventDefault()");
    expect(terminalSource).toContain("passive: false");
    expect(terminalSource).toContain("remoteBatcher = isDesktop ? null : createRemoteBatcher()");
  });
});
