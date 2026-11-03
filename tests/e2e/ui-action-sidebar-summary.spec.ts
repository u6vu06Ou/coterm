import { expect, test } from "@playwright/test";
import { launchCoterm } from "./helpers/coterm-launch";

test("sidebar uses the pane summary instead of a transient Working title", async () => {
  const coterm = await launchCoterm();
  try {
    const { page } = coterm;
    await page.locator(".boot-screen").waitFor({ state: "detached" });
    const terminalId = await page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      const layout = await window.aiTerminal.openTile({ projectId: projects[0]!.id });
      return layout.tiles[0]!.terminalId;
    });
    const row = page.locator(".project-open-tile-row strong").first();
    // Wait for PowerShell's startup title and its resulting pane effects;
    // injecting before startup completes races the real initial null summary.
    await expect(row).toHaveText("pwsh");
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    // Exercise the same event contract the pane emits, without a paid CLI call.
    await page.evaluate((id) => {
      window.dispatchEvent(new CustomEvent("coterm:session-summary", {
        detail: { terminalId: id, summary: "檢查 npm 申請與 Gmail" },
      }));
    }, terminalId);
    await expect(row).toHaveText("檢查 npm 申請與 Gmail");
    await expect(page.locator(".project-open-tile-row .pty-signal").first()).toBeVisible();
    await page.evaluate((id) => {
      window.dispatchEvent(new CustomEvent("coterm:session-summary", {
        detail: { terminalId: id, summary: null },
      }));
    }, terminalId);
    await expect(row).not.toHaveText("檢查 npm 申請與 Gmail");
  } finally {
    await coterm.close();
  }
});
