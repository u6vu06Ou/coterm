import { expect, test } from "@playwright/test";
import { launchCoterm, readUiActions } from "./helpers/coterm-launch";
import { UI_ACTION_AUDIT_SCENARIO_TITLE } from "../../scripts/lib/ui-action-scenarios";
import { openSettingsTab } from "./helpers/settings-tabs";

test(UI_ACTION_AUDIT_SCENARIO_TITLE, async () => {
  const coterm = await launchCoterm({ onboardingCompleted: true, seedProject: false });
  try {
    const { page, logPath } = coterm;
    await page.locator('[data-action-id="topbar.settings.open"]').click();
    await openSettingsTab(page, "agent");
    await expect(page.locator('[data-action-id="settings.close"]')).toBeVisible();
    await page.locator('[data-action-id="settings.proxy.change"]').fill("http://127.0.0.1:8787/typing-does-not-flood-audit");
    await page.locator('[data-action-id="settings.close"]').click();

    await expect.poll(async () => readUiActions(logPath), { timeout: 10_000 }).toEqual([
      expect.objectContaining({
        actionId: "topbar.settings.open",
        surface: "desktop",
        controlType: "button",
        interaction: "click",
        identified: true,
      }),
      expect.objectContaining({
        actionId: "settings.tab.agent",
        surface: "desktop",
        controlType: "button",
        interaction: "click",
        identified: true,
      }),
      expect.objectContaining({
        actionId: "settings.proxy.change",
        surface: "desktop",
        controlType: "input",
        interaction: "change",
        identified: true,
      }),
      expect.objectContaining({
        actionId: "settings.close",
        surface: "desktop",
        controlType: "button",
        interaction: "click",
        identified: true,
      }),
    ]);
    const serialized = JSON.stringify(await readUiActions(logPath));
    expect(serialized).not.toContain("value");
    expect(serialized).not.toContain("clipboard");
    expect(serialized).not.toContain("terminal output");
    expect(serialized).not.toContain("typing-does-not-flood-audit");
  } finally {
    await coterm.close();
  }
});
