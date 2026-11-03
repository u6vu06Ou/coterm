import { expect, test } from "@playwright/test";
import { launchCoterm } from "./helpers/coterm-launch";

test("mobile readability keeps topbar, pane header, and settings close clear", async () => {
  const coterm = await launchCoterm({ mobileViewport: true });
  try {
    const { page } = coterm;
    await page.locator("header.mobile-dock-bar").waitFor({ state: "visible", timeout: 15_000 });
    await page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      await window.aiTerminal.openTile({ projectId: projects[0]!.id });
    });

    const topbar = page.locator("header.mobile-dock-bar");
    const paneHeader = page.locator(".xterm-pane-frame > header").first();
    await expect(topbar).toBeVisible();
    await expect(paneHeader).toBeVisible();

    const geometry = await page.evaluate(() => {
      const topbar = document.querySelector<HTMLElement>(".mobile-menu-toggle")!;
      const paneHeader = document.querySelector<HTMLElement>(".xterm-pane-frame > header")!;
      return {
        topbarHeight: Math.round(topbar.getBoundingClientRect().height),
        paneHeaderHeight: Math.round(paneHeader.getBoundingClientRect().height),
        paneHeaderFontSize: Number.parseFloat(getComputedStyle(paneHeader).fontSize),
        topbarFontSize: Number.parseFloat(getComputedStyle(topbar).fontSize),
        labelFontSize: Number.parseFloat(getComputedStyle(paneHeader.querySelector(".xterm-pane-label") ?? paneHeader).fontSize),
      };
    });
    expect(geometry.topbarHeight).toBe(56);
    expect(geometry.paneHeaderHeight).toBe(88);
    expect(geometry.paneHeaderFontSize).toBe(20);
    expect(geometry.topbarFontSize).toBe(20);
    expect(geometry.labelFontSize).toBe(20);

    await page.locator('[data-action-id="topbar.mobile.settings.open"]').click();
    const drawer = page.locator('[data-action-id="settings.drawer.consume"]');
    const close = page.locator('[data-action-id="settings.close"]');
    await expect(drawer).toBeVisible();
    await expect(close).toBeVisible();

    const occlusion = await close.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const centered = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return centered === element || (centered !== null && element.contains(centered));
    });
    expect(occlusion).toBe(true);

    await close.click();
    await expect(page.locator('[data-action-id="settings.drawer.consume"]')).toBeHidden();
  } finally {
    await coterm.close();
  }
});
