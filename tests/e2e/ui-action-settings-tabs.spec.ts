import { expect, test } from "@playwright/test";
import { launchCoterm, readUiActions } from "./helpers/coterm-launch";
import { openSettingsTab, type SettingsTab } from "./helpers/settings-tabs";

const SCENARIO_TITLE = "settings tab rail switches panes, locale and focus";

interface TabCase {
  id: SettingsTab;
  /** A control that exists only inside this tab so panes are provably swapped. */
  sentinel: string;
}

const TAB_CASES: TabCase[] = [
  { id: "general", sentinel: "settings.language.change" },
  { id: "appearance", sentinel: "settings.terminal-font-size.change" },
  { id: "agent", sentinel: "settings.provider.change" },
  { id: "voice", sentinel: "settings.voice.toggle" },
  { id: "browser", sentinel: "settings.browser-network.mode.change" },
  { id: "security", sentinel: "settings.agent-api.toggle" },
  { id: "data", sentinel: "settings.backup.create" },
];

const railButton = (id: SettingsTab): string => `[data-action-id="settings.tab.${id}"]`;

test(SCENARIO_TITLE, async () => {
  const coterm = await launchCoterm();
  try {
    const { page, logPath } = coterm;

    // The entry point lives in the sidebar brand cluster, beside the product name.
    const gear = page.locator('[data-action-id="topbar.settings.open"]');
    await expect(gear).toBeVisible();
    await gear.click();
    const shell = page.locator('[data-action-id="settings.drawer.consume"]');
    await expect(shell).toBeVisible();

    // The sheet is centered and deliberately not full-bleed: both side margins
    // stay visible so the terminal behind the dialog keeps context.
    const box = await shell.boundingBox();
    // Playwright reports no viewport for Electron windows, so read it in the page.
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    if (!box || !viewport) throw new Error("settings sheet or viewport size unavailable");
    expect(box.x).toBeGreaterThan(40);
    expect(box.width).toBeLessThanOrEqual(viewport.width - 150);
    expect(box.width + box.x).toBeLessThan(viewport.width - 40);
    expect(box.y).toBeGreaterThan(20);
    expect(box.height).toBeLessThanOrEqual(viewport.height - 60);

    await expect(page.locator(".settings-rail")).toBeVisible();
    await expect(page.locator(railButton("general"))).toHaveAttribute("aria-current", "page");

    // Every rail entry switches to its own pane and hides all other panes.
    const labelsBefore: string[] = [];
    for (const tabCase of TAB_CASES) {
      const button = page.locator(railButton(tabCase.id));
      labelsBefore.push(((await button.textContent()) ?? "").trim());
      await button.click();
      await expect(button).toHaveAttribute("aria-current", "page");
      await expect(shell).toHaveAttribute("data-tab", tabCase.id);
      await expect(page.locator(`[data-action-id="${tabCase.sentinel}"]`)).toBeVisible();
      for (const other of TAB_CASES.filter((candidate) => candidate.id !== tabCase.id)) {
        await expect(page.locator(`[data-action-id="${other.sentinel}"]`)).toBeHidden();
      }
      // No internal jargon or legacy product nickname reaches the rail.
      expect(labelsBefore.at(-1)).not.toMatch(/agentapi|phase\s*\d|feature flag/i);
    }

    // Rail keyboard nav moves the selection and follows focus.
    await expect(page.locator(railButton("data"))).toBeFocused();
    await page.keyboard.press("Home");
    await expect(page.locator(railButton("general"))).toHaveAttribute("aria-current", "page");
    await expect(page.locator(railButton("general"))).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(railButton("appearance"))).toHaveAttribute("aria-current", "page");
    await expect(page.locator(railButton("appearance"))).toBeFocused();

    // One-click locale switch repaints the whole rail without a reload.
    await openSettingsTab(page, "general");
    const localeSelect = page.locator('[data-action-id="settings.language.change"]');
    await localeSelect.selectOption("en-US");
    await expect(localeSelect).toHaveValue("en-US");
    await expect(page.locator(railButton("general"))).toHaveText("General");
    await expect(page.locator(railButton("voice"))).toHaveText("Voice");
    const labelsAfter = await page.locator(".settings-rail .settings-rail-item").allTextContents();
    expect(labelsAfter.map((label) => label.trim())).not.toEqual(labelsBefore);

    // Escape closes the sheet and hands focus back to the gear that opened it.
    await page.keyboard.press("Escape");
    await expect(shell).toBeHidden();
    await expect(gear).toBeFocused();

    // The tab choice persists across close/reopen (localStorage, not state loss).
    await gear.click();
    await expect(shell).toHaveAttribute("data-tab", "general");
    await openSettingsTab(page, "data");
    await page.locator('[data-action-id="settings.close"]').click();
    await expect(shell).toBeHidden();
    await gear.click();
    await expect(shell).toHaveAttribute("data-tab", "data");

    // The gear lives in the topbar right group (2026-10-02); the sidebar no
    // longer carries an entry point — confirm the topbar entry still opens.
    await page.locator('[data-action-id="settings.close"]').click();
    await expect(shell).toBeHidden();
    await page.locator('[data-action-id="sidebar.collapse"]').click();
    await page.locator('[data-action-id="topbar.settings.open"]').click();
    await expect(shell).toBeVisible();
    await page.locator('[data-action-id="settings.close"]').click();
    await expect(shell).toBeHidden();

    // Ctrl+, re-opens the closed sheet without touching any entry button.
    await page.keyboard.press("Control+Comma");
    await expect(shell).toBeVisible();

    await expect
      .poll(async () => (await readUiActions(logPath)).map((entry) => entry.actionId), { timeout: 10_000 })
      .toEqual(
        expect.arrayContaining([
          "topbar.settings.open",
          ...TAB_CASES.map((tabCase) => `settings.tab.${tabCase.id}`),
          "settings.language.change",
          "settings.close",
        ]),
      );
  } finally {
    await coterm.close();
  }
});