import { expect, test } from "@playwright/test";
import { launchCoterm, readUiActions } from "./helpers/coterm-launch";

test("topbar desktop actions render and audit", async () => {
  const coterm = await launchCoterm();
  try {
    const { page, logPath } = coterm;

    // topbar.theme.toggle: click flips theme; title attribute changes.
    const themeBtn = page.locator('[data-action-id="topbar.theme.toggle"]');
    await themeBtn.waitFor({ state: "visible" });
    const titleBefore = await themeBtn.getAttribute("title");
    await themeBtn.click();
    await expect.poll(async () => themeBtn.getAttribute("title"), { timeout: 10_000 }).not.toBe(titleBefore);

    // Placement contract: the usage HUD lives in the sidebar foot (moved out of
    // the top bar), and the duplicate explorer shortcut stays removed.
    await expect(page.locator(".topbar-left")).toHaveCount(1);
    await expect(page.locator(".topbar-desktop")).toHaveCSS("display", "grid");
    await expect(page.locator(".sidebar-usage .usage-hud")).toBeVisible();
    await expect(page.locator(".topbar-center")).toHaveCount(0);
    await expect(page.locator(".topbar-right")).toBeVisible();
    await expect(page.locator('[data-action-id="topbar.explorer.toggle"]')).toHaveCount(0);

    // topbar.settings.open: click opens SettingsPanel (backdrop visible).
    await page.locator('[data-action-id="topbar.settings.open"]').click();
    await expect(page.locator('[data-action-id="settings.backdrop.dismiss"]')).toBeVisible();
    await page.locator('[data-action-id="settings.backdrop.dismiss"]').dispatchEvent("mousedown");
    await expect(page.locator('[data-action-id="settings.backdrop.dismiss"]')).toBeHidden();

    // topbar.terminal.refresh: no active terminal → disabled (state oracle).
    const refreshBtn = page.locator('[data-action-id="topbar.terminal.refresh"]');
    await expect(refreshBtn).toBeVisible();
    await expect(refreshBtn).toBeDisabled();

    // topbar.terminal.exclusive-toggle + topbar.terminal.show-all: only render
    // when tiles exist. No terminal → switcher absent (correct state).
    await expect(page.locator('[data-action-id="topbar.terminal.exclusive-toggle"]')).toHaveCount(0);
    await expect(page.locator('[data-action-id="topbar.terminal.show-all"]')).toHaveCount(0);

    // Log oracle: driven actions are audited.
    await expect.poll(async () => (await readUiActions(logPath)).map((a) => a.actionId), { timeout: 10_000 }).toContain("topbar.theme.toggle");
    await expect.poll(async () => (await readUiActions(logPath)).map((a) => a.actionId), { timeout: 10_000 }).toContain("topbar.settings.open");
  } finally {
    await coterm.close();
  }
});
