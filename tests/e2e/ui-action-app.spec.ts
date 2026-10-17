import { expect, test } from "@playwright/test";
import { launchCoterm, readUiActions } from "./helpers/coterm-launch";
import { openSettingsTab } from "./helpers/settings-tabs";

test("app error banner dismiss renders and audits", async () => {
  const coterm = await launchCoterm();
  try {
    const { page, logPath } = coterm;

    // Trigger an app-level error by submitting an invalid proxy URL via settings.
    // appSettingsSchema.proxyUrl is z.string().url(), so the IPC rejects and
    // updateSettings catches it, setting store.error which renders the banner.
    await page.locator('[data-action-id="topbar.settings.open"]').click();
    await openSettingsTab(page, "agent");
    await expect(page.locator('[data-action-id="settings.close"]')).toBeVisible();
    await page.locator('[data-action-id="settings.proxy.change"]').fill("not-a-valid-url");

    // Error banner appears with dismiss button (z-index 80, above the settings drawer).
    await expect(page.locator('[data-action-id="app.error.dismiss"]')).toBeVisible({ timeout: 10_000 });

    // Click dismiss and assert the banner is removed from the DOM.
    await page.locator('[data-action-id="app.error.dismiss"]').click();
    await expect(page.locator('[data-action-id="app.error.dismiss"]')).toHaveCount(0);

    // Assert the dismiss action was audited in coterm.log.
    await expect.poll(async () => (await readUiActions(logPath)).map((a) => a.actionId), { timeout: 10_000 }).toContain("app.error.dismiss");
  } finally {
    await coterm.close();
  }
});
