import { expect, test } from "@playwright/test";
import { launchCoterm, readUiActions } from "./helpers/coterm-launch";

const SCENARIO_TITLE = "terminal dock selection and modes render and audit";

test(SCENARIO_TITLE, async () => {
  // This scenario rebuilds xterm, opens four native PTYs, exercises search,
  // and audits the resulting actions. Under the 4-6 worker release matrix it
  // can exceed Playwright's generic 60s budget even though each bounded oracle
  // remains independently timed. Give this heavy native lifecycle scenario a
  // dedicated ceiling rather than weakening any assertion.
  test.setTimeout(120_000);
  const coterm = await launchCoterm();
  try {
    const { page, logPath } = coterm;

    // Wait for the app store to finish initialize() before driving openTile.
    // The boot-screen detaches when loading flips false, which means the store
    // has bootstrapped projects AND subscribed to onDockLayout — without this
    // wait, openTile's broadcast can fire before the subscriber is mounted and
    // the tile never renders (a pre-existing flake in this spec).
    await page.locator(".boot-screen").waitFor({ state: "detached", timeout: 20_000 });

    // Open a plain PTY tile directly via the preload API (the sidebar "+"
    // button's onClick chains openTile + setPickerState, but the click is
    // flaky under force — drive openTile directly to get a tile in the dock).
    await page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      await window.aiTerminal.openTile({ projectId: projects[0]!.id });
    });

    // terminal.activate: the tile section renders and is clickable. After the
    // sidebar open, the new tile becomes the selected/active one, so the
    // section carries the "active" class.
    const tile = page.locator('[data-action-id="terminal.activate"]').first();
    await tile.waitFor({ state: "visible", timeout: 15_000 });
    await tile.dispatchEvent("pointerdown");
    await expect(tile).toHaveClass(/active/);

    // terminal.clean-view.toggle: click the eye toggle -> cleanView=true ->
    // clean overlay renders (only when cleanView && isActive).
    await page.locator('[data-action-id="terminal.clean-view.toggle"]').click();
    const cleanOverlay = page.locator('[data-action-id="terminal.clean-view.consume"]');
    await expect(cleanOverlay).toBeVisible();

    // terminal.clean-view.consume: the overlay is visible (it stops propagation
    // on pointerdown). Asserting visibility is the behavioral oracle for a
    // consume-only surface.
    await expect(cleanOverlay).toBeVisible();
    // Turn clean view back off so it doesn't sit over the search overlay below.
    await page.locator('[data-action-id="terminal.clean-view.toggle"]').click();

    // --- F: Ctrl+F in-terminal search overlay ---
    // The overlay opens only via xterm's attachCustomKeyEventHandler on Ctrl+F,
    // which requires the xterm helper textarea to be the active element. The
    // isActive effect (TerminalDock.tsx:1933) focuses terminal.focus() on tile
    // selection; we re-focus the textarea here as real-DOM focus evidence so the
    // subsequent Ctrl+F reliably reaches the handler (not a force/sleep hack).
    const xtermTextarea = page.locator(".xterm-host textarea.xterm-helper-textarea").first();
    await xtermTextarea.waitFor({ state: "attached", timeout: 15_000 });
    await xtermTextarea.focus();
    await expect.poll(async () => page.evaluate(() => document.activeElement?.className), {
      timeout: 5_000,
    }).toContain("xterm-helper-textarea");

    // Ctrl+F -> isSearchOpenShortcut -> setSearchOpen(true). The overlay renders
    // only when searchOpen && isActive (both true for the selected tile).
    await page.keyboard.press("Control+f");
    const searchOverlay = page.locator('[data-action-id="terminal.search.consume"]');
    await expect(searchOverlay).toBeVisible();

    // terminal.search.consume: the overlay is a consume-only surface
    // (data-action-trigger="pointerdown"). Dispatch a pointerdown on it to drive
    // the surface and produce its audit entry — the overlay's onPointerDown
    // stopPropagation is the behavioral oracle (it must not close the overlay or
    // forward the event to xterm). dispatchEvent avoids the input/button children
    // so the event lands on the consume container itself.
    await searchOverlay.dispatchEvent("pointerdown");
    await expect(searchOverlay).toBeVisible();

    // terminal.search.input: type a guaranteed-absent string. The PTY is a fresh
    // shell; "zzqwxj" never appears in its (near-empty) scrollback, so the
    // SearchAddon's findNext returns false.
    const searchInput = page.locator('[data-action-id="terminal.search.input"]');
    await expect(searchInput).toBeVisible();
    await searchInput.focus();
    await searchInput.fill("zzqwxj");

    // terminal.search.next: clicking Next runs findNext -> no match -> the
    // overlay shows the no-result hint. Clicking the button also blurs the
    // input, committing its native `change` event (the audit hook captures
    // input via change, not per keystroke — see App.tsx:85).
    await page.locator('[data-action-id="terminal.search.next"]').click();
    await expect(page.locator(".xterm-search-noresult")).toBeVisible();

    // terminal.search.previous: findPrevious also returns false; no-result
    // hint stays visible.
    await page.locator('[data-action-id="terminal.search.previous"]').click();
    await expect(page.locator(".xterm-search-noresult")).toBeVisible();

    // terminal.search.close: closes the overlay -> searchOpen=false -> overlay
    // detaches.
    await page.locator('[data-action-id="terminal.search.close"]').click();
    await expect(searchOverlay).toHaveCount(0);

    // Ctrl+wheel must be consumed by the terminal font zoom handler. If this
    // returns true Chromium would also page-zoom, recreating the stale-canvas
    // overlap that prompted the regression fix.
    const wheelWasNotCancelled = await page.locator(".xterm-host").first().evaluate((host) => {
      const event = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -120,
      });
      return host.dispatchEvent(event);
    });
    expect(wheelWasNotCancelled).toBe(false);

    // Refresh is a true engine rebuild: mark the live xterm root, click the
    // toolbar action, and require a fresh root from the authoritative replay.
    const activeFrame = page.locator(".xterm-pane-frame.active");
    await activeFrame.locator(".xterm").evaluate((root) => { root.setAttribute("data-before-refresh", "true"); });
    await page.locator('[data-action-id="topbar.terminal.refresh"]').click();
    await expect.poll(async () => (
      await activeFrame.locator(".xterm").getAttribute("data-before-refresh")
    ), { timeout: 15_000 }).toBeNull();

    // A stale 3-tile resize callback arriving after tile four opens must be
    // rejected by main, and the renderer must keep four non-zero panes.
    const layoutOracle = await page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      for (let index = 0; index < 3; index += 1) {
        await window.aiTerminal.openTile({ projectId: projects[0]!.id });
      }
      const layout = await window.aiTerminal.setDockLayout({
        rows: [0.5, 0.5],
        cols: [[0.5, 0.5], [1]],
      });
      return {
        tiles: layout.tiles.length,
        projected: layout.cols.reduce((total, row) => total + row.length, 0),
      };
    });
    expect(layoutOracle).toEqual({ tiles: 4, projected: 4 });
    const frames = page.locator(".xterm-pane-frame");
    await expect(frames).toHaveCount(4);
    await expect.poll(async () => frames.evaluateAll((items) => items.map((item) => {
      const box = item.getBoundingClientRect();
      return box.width > 40 && box.height > 40;
    })), { timeout: 15_000 }).toEqual([true, true, true, true]);

    // Audit oracle: every driven actionId should appear in coterm.log. The 5
    // search IDs are captured via pointerdown (consume), change (input), and
    // click (previous/next/close) — all document-level capture listeners that
    // fire before React's stopPropagation.
    await expect.poll(
      async () => (await readUiActions(logPath)).map((a) => a.actionId),
      { timeout: 10_000 },
    ).toEqual(
      expect.arrayContaining([
        "terminal.activate",
        "terminal.clean-view.toggle",
        "terminal.search.consume",
        "terminal.search.input",
        "terminal.search.previous",
        "terminal.search.next",
        "terminal.search.close",
      ]),
    );
  } finally {
    await coterm.close();
  }
});
