import { expect, test } from "@playwright/test";
import { launchCoterm } from "./helpers/coterm-launch";

// Pane header solo (maximize) toggle: blank double-click on a PTY pane header
// fires the same store setExclusive the topbar tab does, and double-clicking
// the already-solo pane's header again restores the grid. Guards: interactive
// children of the header (buttons, hidden file input) own the gesture; mobile
// layout / reader overlay / reading mode are skipped; one tile is a no-op.


test("pane header double-click maximizes the pane and a second one restores the grid", async () => {
  test.setTimeout(60_000);
  const coterm = await launchCoterm();
  try {
    const { page } = coterm;
    // Boot trap: .boot-screen waitFor(detached) also resolves when absent —
    // anchor on the topbar refresh button (ui-action-reading-mode pattern).
    await page.locator('[data-action-id="topbar.terminal.refresh"]').waitFor({ state: "visible", timeout: 30_000 });

    const layout = await page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      await window.aiTerminal.openTile({ projectId: projects[0]!.id });
      await window.aiTerminal.openTile({ projectId: projects[0]!.id });
      return window.aiTerminal.getDockLayout();
    });
    expect(layout.tiles).toHaveLength(2);
    await expect(page.locator('[data-action-id="terminal.activate"]')).toHaveCount(2, { timeout: 30_000 });

    // Blank double-click on the second pane's header → solo.
    await expect(page.locator(".xterm-pane-frame > header")).toHaveCount(2);
    await page.locator(".xterm-pane-frame > header").nth(1).dblclick();
    await expect(page.locator('[data-action-id="terminal.activate"]')).toHaveCount(1, { timeout: 10_000 });
    let state = await page.evaluate(async () => window.aiTerminal.getDockLayout());
    expect(state.exclusiveTerminalId).toBe(layout.tiles[1]!.terminalId);

    // Second double-click on the solo pane's header → the grid returns and
    // exclusiveTerminalId is back to null (persistent layout untouched).
    await page.locator(".xterm-pane-frame > header").dblclick();
    await expect(page.locator('[data-action-id="terminal.activate"]')).toHaveCount(2, { timeout: 10_000 });
    state = await page.evaluate(async () => window.aiTerminal.getDockLayout());
    expect(state.exclusiveTerminalId).toBeNull();
  } finally {
    await coterm.close();
  }
});

test("double-clicking a header button child never toggles solo", async () => {
  test.setTimeout(60_000);
  const coterm = await launchCoterm();
  try {
    const { page } = coterm;
    await page.locator('[data-action-id="topbar.terminal.refresh"]').waitFor({ state: "visible", timeout: 30_000 });

    const layout = await page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      await window.aiTerminal.openTile({ projectId: projects[0]!.id });
      await window.aiTerminal.openTile({ projectId: projects[0]!.id });
      return window.aiTerminal.getDockLayout();
    });
    expect(layout.tiles).toHaveLength(2);
    await expect(page.locator('[data-action-id="terminal.activate"]')).toHaveCount(2, { timeout: 30_000 });

    // Double-click the ⋯ header menu button: two open/close cycles of the
    // popover, but the closest() guard must keep the store untouched. Settle
    // past the exclusive toggle's 250ms coalescer so a guard regression cannot
    // sneak through while its async toggle is still in flight.
    await page.locator('[data-action-id="terminal.header.more"]').first().dblclick();
    await page.waitForTimeout(600);
    const state = await page.evaluate(async () => window.aiTerminal.getDockLayout());
    expect(state.exclusiveTerminalId).toBeNull();
    await expect(page.locator('[data-action-id="terminal.activate"]')).toHaveCount(2);
  } finally {
    await coterm.close();
  }
});

test("single-tile header double-click is a no-op", async () => {
  test.setTimeout(60_000);
  const coterm = await launchCoterm();
  try {
    const { page } = coterm;
    await page.locator('[data-action-id="topbar.terminal.refresh"]').waitFor({ state: "visible", timeout: 30_000 });

    const layout = await page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      await window.aiTerminal.openTile({ projectId: projects[0]!.id });
      return window.aiTerminal.getDockLayout();
    });
    expect(layout.tiles).toHaveLength(1);
    await expect(page.locator('[data-action-id="terminal.activate"]')).toHaveCount(1, { timeout: 30_000 });

    await page.locator(".xterm-pane-frame > header").dblclick();
    await page.waitForTimeout(600);
    const state = await page.evaluate(async () => window.aiTerminal.getDockLayout());
    expect(state.exclusiveTerminalId).toBeNull();
  } finally {
    await coterm.close();
  }
});
