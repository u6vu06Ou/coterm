import { access } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchCoterm } from "./helpers/coterm-launch";

test("connected tabs keep twelve close buttons visible and solo workspace aligned", async () => {
  test.setTimeout(120_000);
  const coterm = await launchCoterm({ theme: "light" });
  try {
    const { page } = coterm;
    await page.locator(".boot-screen").waitFor({ state: "detached" });
    await page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      for (let i = 0; i < 12; i++) await window.aiTerminal.openTile({ projectId: projects[0]!.id });
    });
    const frames = page.locator(".xterm-pane-frame");
    await expect(frames).toHaveCount(12);
    const bounds = async (): Promise<{ top: number; bottom: number }> => frames.evaluateAll((elements) => {
      const rects = elements.map((element) => element.getBoundingClientRect());
      return { top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)) };
    });
    for (const frame of await frames.all()) {
      const close = frame.locator('[data-action-id="terminal.close"]');
      await expect(close).toBeVisible();
      expect(await close.evaluate((button) => {
        const r = button.getBoundingClientRect();
        const pane = button.closest(".xterm-pane-frame")!.getBoundingClientRect();
        return r.left >= pane.left && r.right <= pane.right && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("button") === button;
      })).toBe(true);
    }
    const all = await bounds();
    const tabs = page.locator(".topbar-tab");
    await expect(tabs).toHaveCount(12);
    expect(await tabs.first().evaluate((tab) => getComputedStyle(tab).borderBottomLeftRadius)).not.toBe("0px");
    await page.screenshot({ path: ".review/coterm-b-twelve-verified.png" });
    await tabs.first().click();
    await expect(frames).toHaveCount(1);
    await expect.poll(async () => Math.abs((await bounds()).bottom - all.bottom)).toBeLessThan(0.01);
    // Pane top is mode-independent: the connected solo pane keeps the grid's top offset.
    await expect.poll(async () => Math.abs((await bounds()).top - all.top)).toBeLessThanOrEqual(0.5);
    const active = page.locator(".topbar-tab.active");
    await expect.poll(async () => {
      const tab = await active.boundingBox();
      return Math.abs((await bounds()).top - (tab!.y + tab!.height));
    }).toBeLessThanOrEqual(0.5);
    // The joined tab is lamp + number only; its summary moves into the pane header.
    await expect(frames.locator(".xterm-agent-label")).toBeVisible();
    await expect(active.locator(".topbar-tab-row2")).toBeHidden();
    await expect(frames.locator(".xterm-cwd-label")).toBeVisible();
    await page.screenshot({ path: ".review/coterm-b-solo-verified.png" });
    await page.locator('[data-action-id="topbar.terminal.show-all"]').click();
    await expect(frames).toHaveCount(12);
    await expect.poll(bounds).toEqual(all);
  } finally { await coterm.close(); }
});

test("mobile reader stages visible text and only toolbar ENTER executes it", async () => {
  const coterm = await launchCoterm({ mobileViewport: true });
  try {
    const { page, userData } = coterm;
    const marker = join(userData, "explicit-enter.txt");
    const command = `[IO.File]::WriteAllText('${marker.replace(/\\/g, "/")}', 'sent')`;
    await page.locator(".boot-screen").waitFor({ state: "detached" });
    const projectId = await page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      await window.aiTerminal.openTile({ projectId: projects[0]!.id });
      return projects[0]!.id;
    });
    await expect(page.locator(".xterm-host")).toBeVisible();
    await expect.poll(() => page.evaluate(async (id) => {
      const workspace = await window.aiTerminal.getTerminalWorkspace(id);
      return Object.values(workspace.scrollback).join("\n");
    }, projectId)).toContain("PS");
    await page.locator('[data-action-id="topbar.mobile.keys.toggle"]').click();
    await page.locator('[data-action-id="topbar.mobile.reader.toggle"]').click();
    const input = page.locator('[data-action-id="terminal.reader.mobile.input"]');
    await input.fill(command);
    await input.press("Enter");
    await expect(input).toHaveValue(command + "\n");
    expect(await access(marker).then(() => true, () => false)).toBe(false);
    await page.locator('[data-action-id="terminal.reader.mobile.send"]').click();
    const preview = page.locator(".terminal-reader-local-input");
    await expect(preview).toContainText(command);
    await expect(preview).toContainText("已貼入，尚未送出");
    expect(await access(marker).then(() => true, () => false)).toBe(false);
    await page.locator('[data-action-id="topbar.mobile.enter"]').click();
    await expect.poll(() => access(marker).then(() => true, () => false)).toBe(true);
    await expect(preview).toContainText("已按 ENTER");
    await page.screenshot({ path: ".review/coterm-b-mobile-verified.png" });
  } finally { await coterm.close(); }
});
