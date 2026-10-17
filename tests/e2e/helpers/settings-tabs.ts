import { expect, type Page } from "@playwright/test";

export type SettingsTab =
  | "general"
  | "appearance"
  | "agent"
  | "voice"
  | "mission"
  | "browser"
  | "security"
  | "data";

/**
 * Desktop settings is a tabbed sheet: only the active tab's panes are in the
 * layout, so a scenario must select the tab that owns a control before it
 * touches that control (otherwise Playwright times out on a display:none node).
 * Mobile keeps the single-column stack with no rail, so mobile specs never
 * need this helper.
 */
export async function openSettingsTab(page: Page, tab: SettingsTab): Promise<void> {
  const button = page.locator(`[data-action-id="settings.tab.${tab}"]`);
  await button.click();
  await expect(button).toHaveAttribute("aria-current", "page");
  await expect(page.locator('[data-action-id="settings.drawer.consume"]')).toHaveAttribute("data-tab", tab);
}