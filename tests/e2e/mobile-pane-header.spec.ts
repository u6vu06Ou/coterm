import { expect, test } from "@playwright/test";
import { launchCoterm } from "./helpers/coterm-launch";
import {
  MOBILE_LAYOUT_QUERY,
  NARROW_LAYOUT_QUERY,
} from "../../src/renderer/src/components/terminal-responsive";

const MATCHMEDIA_MOBILE_MOCK = `
(() => {
  const native = window.matchMedia ? window.matchMedia.bind(window) : null;
  window.matchMedia = (query) => {
    if (query === ${JSON.stringify(MOBILE_LAYOUT_QUERY)} || query === ${JSON.stringify(NARROW_LAYOUT_QUERY)}) {
      return { matches: true, media: query, onchange: null,
        addListener: () => {}, removeListener: () => {}, addEventListener: () => {},
        removeEventListener: () => {}, dispatchEvent: () => false };
    }
    return native ? native(query) : { matches: false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {},
      removeEventListener: () => {}, dispatchEvent: () => false };
  };
})();
`;

test("mobile pane header hides eye + font-step; desktop shows them", async () => {
  const mobile = await launchCoterm({ initScripts: [MATCHMEDIA_MOBILE_MOCK] });
  try {
    const { page } = mobile;
    await page.locator("header.mobile-dock-bar").waitFor({ state: "visible", timeout: 15_000 });
    await page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      await window.aiTerminal.openTile({ projectId: projects[0]!.id });
    });
    await page.locator(".xterm-host").first().waitFor({ state: "visible", timeout: 15_000 });
    const meta = await page.locator('meta[name="viewport"]').getAttribute("content");
    expect(meta).toContain("maximum-scale=1");
    expect(meta).toContain("user-scalable=no");
    await expect(page.locator('[data-action-id="terminal.clean-view.toggle"]')).toHaveCount(0);
    await expect(page.locator('[data-action-id="terminal.header.more"]')).toHaveCount(0);
    await expect(page.locator('[data-action-id="terminal.font.decrease"]')).toHaveCount(0);
    await expect(page.locator('[data-action-id="terminal.font.increase"]')).toHaveCount(0);
    await expect(page.locator('[data-action-id="terminal.close"]').first()).toBeVisible();
    // The reader is still reachable from the mobile TOOLS menu.
    await page.locator('[data-action-id="topbar.mobile.keys.toggle"]').dispatchEvent("click");
    await expect(page.locator('[data-action-id="topbar.mobile.reader.toggle"]')).toBeVisible();
  } finally {
    await mobile.close();
  }

  const desktop = await launchCoterm();
  try {
    const { page } = desktop;
    await page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      await window.aiTerminal.openTile({ projectId: projects[0]!.id });
    });
    await page.locator(".xterm-host").first().waitFor({ state: "visible", timeout: 15_000 });
    await expect(page.locator('[data-action-id="terminal.clean-view.toggle"]').first()).toBeVisible();
    // 2026-10-03: font steps live in the header's ⋯ tools popover on desktop.
    await page.locator('[data-action-id="terminal.header.more"]').first().click();
    await expect(page.locator('[data-action-id="terminal.font.decrease"]').first()).toBeVisible();
    await expect(page.locator('[data-action-id="terminal.font.increase"]').first()).toBeVisible();
  } finally {
    await desktop.close();
  }
});
