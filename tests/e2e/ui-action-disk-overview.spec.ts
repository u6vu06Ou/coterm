import { test, expect } from "@playwright/test";
import { launchCoterm } from "./helpers/coterm-launch";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("project disk overview is on demand and lists copyable files", async () => {
  const root = await mkdtemp(join(tmpdir(), "coterm-disk-test-"));
  await writeFile(join(root, "report.md"), "hello");
  const coterm = await launchCoterm({ defaultWorkspacePath: root });
  try {
    const { page } = coterm;
    await page.locator('[data-action-id="topbar.terminal.refresh"]').waitFor({ state: "visible", timeout: 30_000 });
    const toggle = page.locator('[data-action-id="sidebar.pulse.files.toggle"]');
    await toggle.click();
    await expect(page.getByText("資料夾盤點：", { exact: false })).toHaveCount(0);
    await page.locator('[data-action-id="sidebar.pulse.disk.scan"]').click();
    await expect(page.getByText("資料夾盤點：", { exact: false })).toContainText("1 個檔案");
    await page.locator('[data-action-id="sidebar.pulse.disk.file:0"]').click();
    await expect.poll(() => coterm.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(join(root, "report.md"));
  } finally { await coterm.close(); await rm(root, { recursive: true, force: true }); }
});
