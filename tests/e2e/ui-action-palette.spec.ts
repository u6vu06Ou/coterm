import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "@playwright/test";
import { launchCoterm, readUiActions } from "./helpers/coterm-launch";

const SCENARIO_TITLE = "command palette controls render and audit";

test(SCENARIO_TITLE, async () => {
  // sidebar.project.create's IPC path opens a native folder dialog
  // (dialog.showOpenDialog), which is unavailable in headless Electron. The
  // helper seeds a project at process.cwd(); we point the picker at a fresh
  // temp dir so the store's duplicate check does not short-circuit and a NEW
  // project is actually created (bootstrap count +1).
  const freshWorkspace = await mkdtemp(join(tmpdir(), "coterm-palette-"));

  const coterm = await launchCoterm();
  try {
    const { app, page, logPath } = coterm;

    // Monkey-patch the native open-directory dialog to return freshWorkspace.
    // pickWorkspace IPC adds the canonical path to an approved set that
    // createProject IPC checks, so both halves of the flow stay consistent.
    await app.evaluate(({ dialog }, path: string) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
    }, freshWorkspace);

    await page.locator("section.project-group").first().waitFor({ state: "visible" });

    const baseline = await page.evaluate(() => window.aiTerminal.bootstrap());
    const baselineCount = baseline.projects.length;

    // --- Open 1: search "project create" and run sidebar.project.create ---
    await page.keyboard.press("Control+Shift+P");
    const dialog = page.locator('[data-action-id="palette.dialog.consume"]');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    const searchInput = page.locator('[data-action-id="palette.search.change"]');
    await expect(searchInput).toBeFocused();

    await searchInput.fill("project create");
    // sidebar.project.create is stateful (non-destructive): one click runs it.
    const createItem = dialog.locator('[data-action-id="palette.item.select"]', {
      hasText: "sidebar.project.create",
    });
    await createItem.first().click();
    // palette closes on successful invoke; a new project appears after bootstrap.
    await expect(dialog).toHaveCount(0);

    await expect.poll(async () => {
      const next = await page.evaluate(() => window.aiTerminal.bootstrap());
      return next.projects.length;
    }, { timeout: 15_000 }).toBe(baselineCount + 1);

    // --- Open 2: external actions require an inline second confirmation ---
    await page.keyboard.press("Control+Shift+P");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await page.locator('[data-action-id="palette.search.change"]').fill("project open agent");
    const externalItem = dialog.locator('[data-action-id="palette.item.select"]').first();
    await expect(externalItem).toContainText("sidebar.project.open-agent");
    await externalItem.click();
    await expect(externalItem).toHaveClass(/confirming/);
    await expect(dialog).toBeVisible();
    await expect(page.locator('[data-action-id="picker.dialog.consume"]')).toHaveCount(0);

    // Escape cancels the pending confirmation without closing the palette.
    await page.keyboard.press("Escape");
    await expect(externalItem).not.toHaveClass(/confirming/);
    await expect(dialog).toBeVisible();

    // Dismiss via backdrop after proving the external action did not run.
    await page.locator('[data-action-id="palette.backdrop.dismiss"]').click({ position: { x: 5, y: 5 } });
    await expect(dialog).toHaveCount(0);

    // --- Open 3: dismiss via close button. Clicking the dialog header icon
    //     first drives palette.dialog.consume (capture-phase audit resolves
    //     closest [data-action-id] to the dialog container, not the input). ---
    await page.keyboard.press("Control+Shift+P");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.locator("header svg").first().click();
    await page.locator('[data-action-id="palette.close"]').click();
    await expect(dialog).toHaveCount(0);

    await expect.poll(async () => (await readUiActions(logPath)).map((a) => a.actionId), { timeout: 10_000 }).toEqual(
      expect.arrayContaining([
        "palette.backdrop.dismiss",
        "palette.dialog.consume",
        "palette.search.change",
        "palette.item.select",
        "palette.close",
      ]),
    );
  } finally {
    await coterm.close();
    await rm(freshWorkspace, { recursive: true, force: true });
  }
});
