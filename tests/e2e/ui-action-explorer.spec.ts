import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { launchCoterm, readUiActions } from "./helpers/coterm-launch";

const SCENARIO_TITLE = "explorer panel controls render and audit";

test(SCENARIO_TITLE, async () => {
  const coterm = await launchCoterm({ onboardingCompleted: true, seedProject: true });
  const { page, logPath } = coterm;
  try {
    // Wait for the seeded project to appear in the sidebar, then open a tile
    // (creates a dock terminal bound to the project so ExplorerPanel can find it).
    await page.locator("section.project-group").first().waitFor({ state: "visible" });
    // Open a dock tile directly via the preload API so ExplorerPanel has a
    // selected project to list files from (sidebar open-agent click is flaky
    // under force and chains a picker that may not open).
    const workspacePath = await page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      await window.aiTerminal.openTile({ projectId: projects[0]!.id });
      return projects[0]!.workspacePath;
    });

    // --- explorer.open ---
    // Panel starts collapsed; the open button is the only visible child.
    await page.locator('[data-action-id="explorer.open"]').click();
    await expect(page.locator("aside.explorer-panel:not(.collapsed)")).toBeVisible();
    await expect(page.locator('[data-action-id="explorer.close"]')).toBeVisible();

    // Wait for the async tree to load (window.aiTerminal.listWorkspace).
    await page.locator('[data-action-id="explorer.folder.toggle"]').first().waitFor({ state: "visible" });

    // --- explorer.folder.toggle ---
    // Chevron expansion keeps the root in place and lazy-loads that folder's
    // children without replacing the rest of the tree.
    await page.locator('[data-action-id="explorer.folder.toggle"]').first().click({ force: true });

    // --- explorer.file.open ---
    // Clicking a file row at the project root calls openArtifact → artifact
    // rail becomes visible.
    const fileRow = page.locator('.explorer-root > .tree-node > [data-action-id="explorer.file.open"]').first();
    await fileRow.waitFor({ state: "visible" });

    // --- explorer.copy-path ---
    // Drive the actual right-click menu and record the exact value passed to
    // the real clipboard API. The OS clipboard is shared by parallel Electron
    // workers (and the user's live desktop), so reading it after the click is
    // racy even when this page wrote the correct value.
    await coterm.app.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.evaluate(() => {
      const clipboard = navigator.clipboard;
      const originalWriteText = clipboard.writeText.bind(clipboard);
      Object.defineProperty(clipboard, "writeText", {
        configurable: true,
        value: async (value: string) => {
          document.documentElement.dataset.lastExplorerClipboardWrite = value;
          await originalWriteText(value);
        },
      });
      document.addEventListener("contextmenu", (event) => {
        const target = event.target instanceof Element
          ? event.target.closest('[data-action-id="explorer.file.open"]')
          : null;
        document.documentElement.dataset.lastExplorerContextName = target?.textContent?.trim() ?? "";
      }, { capture: true, once: true });
    });
    await fileRow.click({ button: "right" });
    await expect(page.locator(".explorer-context-menu")).toBeVisible();
    const fileName = await page.evaluate(() => document.documentElement.dataset.lastExplorerContextName);
    expect(fileName).toBeTruthy();
    await page.locator('[data-action-id="explorer.copy-path"]').click();
    const copiedPath = await page.evaluate(() => document.documentElement.dataset.lastExplorerClipboardWrite);
    expect(copiedPath).toBe(join(workspacePath, fileName!));

    await fileRow.click({ force: true });
    await expect(page.locator("aside.artifact-rail")).toBeVisible();

    // --- explorer.close ---
    // Collapse the panel → the open button reappears.
    await page.locator('[data-action-id="explorer.close"]').click();
    await expect(page.locator('[data-action-id="explorer.open"]')).toBeVisible();

    // Log oracle: every explorer action was audited.
    await expect.poll(
      async () => (await readUiActions(logPath)).map((a) => a.actionId),
      { timeout: 10_000 },
    ).toEqual(
      expect.arrayContaining([
        "explorer.open",
        "explorer.folder.toggle",
        "explorer.file.open",
        "explorer.copy-path",
        "explorer.close",
      ]),
    );
  } finally {
    await coterm.close();
  }
});
