import { expect, test, type Page } from "@playwright/test";
import { launchCoterm, readUiActions } from "./helpers/coterm-launch";

// 閱讀模式 (1.5.44): enter → drag open-session rows from the LEFT SIDEBAR
// project area to fill the left and right slots → both panes render while the
// grid stays hidden → exit restores the ORIGINAL layout (main-owned dock never
// mutated) → re-enter starts with empty slots. Also covers the 殭屍格回收
// path: a PTY that exits on its own ("exit\r") must reclaim its dock tile
// automatically.

// HTML5 drag a sidebar open-session row onto a reading slot. Chromium supports
// `new DataTransfer()`; React delegates drag events at the root, so
// dispatchEvent reaches the handlers. Sidebar rows carry no data-terminal-id,
// so a tile is picked by its position in the (order-preserving)
// `.project-open-tiles` list.
async function dragSidebarRowToSlot(page: Page, rowIndex: number, slot: "left" | "right"): Promise<void> {
  await page.evaluate((args) => {
    const targetRow = args[0] as number;
    const targetSlot = args[1] as string;
    const source = document.querySelectorAll("ul.project-open-tiles > li > button")[targetRow];
    const target = document.querySelector(`[data-reading-slot="${targetSlot}"]`);
    if (!source || !target) throw new Error("drag endpoints missing");
    const dt = new DataTransfer();
    source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, [rowIndex, slot]);
}

test("reading mode enter/drag/exit restores the original layout", async () => {
  const coterm = await launchCoterm();
  try {
    const { page, logPath } = coterm;

    // Boot trap: .boot-screen waitFor(detached) resolves instantly when the
    // element is simply absent — anchor on the refresh button instead.
    await page.locator('[data-action-id="topbar.terminal.refresh"]').waitFor({ state: "visible", timeout: 30_000 });

    const layout = await page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      for (let i = 0; i < 3; i++) {
        await window.aiTerminal.openTile({ projectId: projects[0]!.id });
      }
      return window.aiTerminal.getDockLayout();
    });
    expect(layout.tiles).toHaveLength(3);
    const tileIds = layout.tiles.map((tile) => tile.terminalId);
    // Real panes mounted.
    await expect(page.locator('[data-action-id="terminal.activate"]')).toHaveCount(3, { timeout: 30_000 });

    // Enter reading mode: two empty slots, grid gone.
    await page.locator('[data-action-id="topbar.reading-mode.toggle"]').click();
    const slots = page.locator(".reading-slot");
    await expect(slots).toHaveCount(2);
    await expect(page.locator(".reading-slot[data-reading-filled]")).toHaveCount(0);
    // The grid must be hidden wholesale (no ghosted grid behind the slots).
    await expect(page.locator(".dock-row-group")).toHaveCount(0);
    await expect(page.locator(".reading-grid .xterm")).toHaveCount(0);

    // Sidebar open-session rows must still be listed under the project folder
    // (main-owned layout untouched) and map to the dock tile order.
    await expect(page.locator("ul.project-open-tiles > li > button")).toHaveCount(tileIds.length);

    // Drag the first row onto the LEFT slot...
    await dragSidebarRowToSlot(page, 0, "left");
    await expect(page.locator('[data-reading-slot="left"][data-reading-filled="true"]')).toHaveCount(1);

    // ...and the second row onto the RIGHT slot.
    await dragSidebarRowToSlot(page, 1, "right");
    await expect(page.locator('[data-reading-slot="right"][data-reading-filled="true"]')).toHaveCount(1);

    // Both dragged-in terminals fill the screen.
    await expect(page.locator(".reading-grid .xterm")).toHaveCount(2, { timeout: 20_000 });

    // Exit: the ORIGINAL layout comes back untouched (no ghosting, all 3 back).
    await page.locator('[data-action-id="topbar.reading-mode.toggle"]').click();
    await expect(page.locator(".reading-mode")).toHaveCount(0);
    await expect(page.locator('[data-action-id="terminal.activate"]')).toHaveCount(3, { timeout: 20_000 });
    const after = await page.evaluate(async () => window.aiTerminal.getDockLayout());
    expect(after.tiles.map((tile) => tile.terminalId)).toEqual(tileIds);

    // Re-enter starts from two EMPTY slots (nothing persisted, nothing stale).
    await page.locator('[data-action-id="topbar.reading-mode.toggle"]').click();
    await expect(page.locator(".reading-slot[data-reading-filled]")).toHaveCount(0);
    await page.locator('[data-action-id="topbar.reading-mode.toggle"]').click();

    // Audit oracle: the toggle lands in the action log. (Drag events have no
    // audit listener by design.)
    const ids = (await readUiActions(logPath)).map((a) => a.actionId);
    expect(ids).toContain("topbar.reading-mode.toggle");
  } finally {
    await coterm.close();
  }
});

// f1b bug 1 repro (maintainer 2026-09-22): if the dock was in EXCLUSIVE (solo) view
// — one click on a topbar switcher number — entering reading mode used to
// leave exclusiveTerminalId untouched, so exiting re-rendered the solo branch
// = "退出只剩第一扇". Fix: entering reading mode suspends solo; exit always
// returns to the full grid.
test("exclusive (solo) view must not survive a reading-mode round trip", async () => {
  const coterm = await launchCoterm();
  try {
    const { page } = coterm;
    await page.locator('[data-action-id="topbar.terminal.refresh"]').waitFor({ state: "visible", timeout: 30_000 });

    const layout = await page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      for (let i = 0; i < 3; i++) {
        await window.aiTerminal.openTile({ projectId: projects[0]!.id });
      }
      return window.aiTerminal.getDockLayout();
    });
    expect(layout.tiles).toHaveLength(3);
    const tileIds = layout.tiles.map((tile) => tile.terminalId);
    await expect(page.locator('[data-action-id="terminal.activate"]')).toHaveCount(3, { timeout: 30_000 });

    // Solo tile 1 the way a user does: click its topbar switcher button.
    await page.locator('[data-action-id="topbar.terminal.exclusive-toggle"]').first().click();
    await expect(page.locator('[data-action-id="terminal.activate"]')).toHaveCount(1, { timeout: 10_000 });
    let state = await page.evaluate(async () => window.aiTerminal.getDockLayout());
    expect(state.exclusiveTerminalId).toBe(tileIds[0]);

    // Enter reading mode: solo is suspended (cleared in main-owned layout).
    await page.locator('[data-action-id="topbar.reading-mode.toggle"]').click();
    await expect(page.locator(".reading-slot")).toHaveCount(2);
    await expect.poll(async () => {
      const current = await page.evaluate(async () => window.aiTerminal.getDockLayout());
      return current.exclusiveTerminalId;
    }, { timeout: 10_000 }).toBeNull();

    // Exit: ALL panes come back — the grid, never the previous solo view.
    await page.locator('[data-action-id="topbar.reading-mode.toggle"]').click();
    await expect(page.locator(".reading-mode")).toHaveCount(0);
    await expect(page.locator('[data-action-id="terminal.activate"]')).toHaveCount(3, { timeout: 20_000 });
    state = await page.evaluate(async () => window.aiTerminal.getDockLayout());
    expect(state.exclusiveTerminalId).toBeNull();
    expect(state.tiles.map((tile) => tile.terminalId)).toEqual(tileIds);
  } finally {
    await coterm.close();
  }
});

// f1b bug 2 (maintainer 2026-09-22): double-clicking the toggle must be EXACTLY ONE
// toggle — enter, and nothing else. Before the fix a dblclick fired two
// toggles ~<500ms apart, reading as an in+out flicker under real pane remount
// cost. Single-click semantics + 400ms debounce make dblclick a no-op echo.
test("double-clicking the reading toggle equals exactly one toggle", async () => {
  const coterm = await launchCoterm();
  try {
    const { page } = coterm;
    await page.locator('[data-action-id="topbar.terminal.refresh"]').waitFor({ state: "visible", timeout: 30_000 });

    await page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      await window.aiTerminal.openTile({ projectId: projects[0]!.id });
      await window.aiTerminal.openTile({ projectId: projects[0]!.id });
    });
    await expect(page.locator('[data-action-id="terminal.activate"]')).toHaveCount(2, { timeout: 30_000 });

    const toggle = page.locator('[data-action-id="topbar.reading-mode.toggle"]');

    // dblclick #1: enter once. NOT in+out, NOT exclusive, grid panes untouched.
    await toggle.dblclick();
    await expect(page.locator(".reading-slot")).toHaveCount(2, { timeout: 10_000 });
    let layout = await page.evaluate(async () => window.aiTerminal.getDockLayout());
    expect(layout.exclusiveTerminalId).toBeNull();

    // dblclick #2 (deliberate, after the debounce window): exit once.
    await page.waitForTimeout(500);
    await toggle.dblclick();
    await expect(page.locator(".reading-mode")).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('[data-action-id="terminal.activate"]')).toHaveCount(2, { timeout: 20_000 });
    layout = await page.evaluate(async () => window.aiTerminal.getDockLayout());
    expect(layout.exclusiveTerminalId).toBeNull();
  } finally {
    await coterm.close();
  }
});

// f1b bug 1 hardening (maintainer 2026-09-22): rapid enter/exit cycles with mixed
// slot picks (last row first, both slots filled) must never drop a tile —
// mirrors the exact "quickly prodding the button" sequence from the report.
test("rapid enter/exit cycles with slot mixing never lose tiles", async () => {
  const coterm = await launchCoterm();
  try {
    const { page } = coterm;
    await page.locator('[data-action-id="topbar.terminal.refresh"]').waitFor({ state: "visible", timeout: 30_000 });

    const layout = await page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      for (let i = 0; i < 3; i++) {
        await window.aiTerminal.openTile({ projectId: projects[0]!.id });
      }
      return window.aiTerminal.getDockLayout();
    });
    const tileIds = layout.tiles.map((tile) => tile.terminalId);
    await expect(page.locator('[data-action-id="terminal.activate"]')).toHaveCount(3, { timeout: 30_000 });

    const toggle = page.locator('[data-action-id="topbar.reading-mode.toggle"]');
    const assertGrid = async (): Promise<void> => {
      await expect(page.locator('[data-action-id="terminal.activate"]')).toHaveCount(3, { timeout: 20_000 });
      const current = await page.evaluate(async () => window.aiTerminal.getDockLayout());
      expect(current.tiles.map((tile) => tile.terminalId)).toEqual(tileIds);
      expect(current.exclusiveTerminalId).toBeNull();
    };

    // Cycle 1: instant in/out, nothing picked. Clicks ≥500ms apart so each is
    // a deliberate toggle (the dblclick debounce only eats sub-400ms echoes).
    await toggle.click();
    await page.waitForTimeout(500);
    await toggle.click();
    await expect(page.locator(".reading-mode")).toHaveCount(0);
    await assertGrid();

    // Cycle 2: drag the LAST sidebar row onto the left slot (slot mixing),
    // exit immediately after.
    await page.waitForTimeout(500);
    await toggle.click();
    await dragSidebarRowToSlot(page, 2, "left");
    await expect(page.locator('[data-reading-slot="left"][data-reading-filled="true"]')).toHaveCount(1);
    await page.waitForTimeout(500);
    await toggle.click();
    await assertGrid();

    // Cycle 3: fill BOTH slots from the sidebar rows, let both panes mount,
    // then exit.
    await page.waitForTimeout(500);
    await toggle.click();
    await dragSidebarRowToSlot(page, 0, "left");
    await dragSidebarRowToSlot(page, 1, "right");
    await expect(page.locator(".reading-grid .xterm")).toHaveCount(2, { timeout: 20_000 });
    await page.waitForTimeout(1000);
    await toggle.click();
    await assertGrid();
    await expect(page.locator(".terminal-dock-grid .xterm")).toHaveCount(3, { timeout: 20_000 });
  } finally {
    await coterm.close();
  }
});

test("zombie tile is reclaimed when its PTY exits on its own", async () => {
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
    const victim = layout.tiles[0]!.terminalId;
    await expect(page.locator('[data-action-id="terminal.activate"]')).toHaveCount(2, { timeout: 30_000 });

    // The shell exits on its own (spawn-death equivalent): before 1.5.44 the
    // tile stayed as an unclosable placeholder still counting toward the max.
    await page.evaluate(async (terminalId) => {
      await window.aiTerminal.writeTerminal({ terminalId, data: "exit\r" });
    }, victim);

    await expect.poll(async () => {
      const current = await page.evaluate(async () => window.aiTerminal.getDockLayout());
      return current.tiles.map((tile) => tile.terminalId);
    }, { timeout: 20_000 }).toEqual([layout.tiles[1]!.terminalId]);

    // And the renderer no longer shows a ghost placeholder pane for it.
    await expect(page.locator('[data-action-id="terminal.activate"]')).toHaveCount(1, { timeout: 20_000 });
  } finally {
    await coterm.close();
  }
});
