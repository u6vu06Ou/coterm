import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { launchCoterm, readUiActions } from "./helpers/coterm-launch";

// Inject the boundary's error state without shipping a production fault hook.
// The following checks exercise its real fallback buttons and recovery paths.
async function failBoundary(page: Page, source: string): Promise<void> {
  await page.evaluate((source) => {
    interface Fiber {
      child?: Fiber | null;
      sibling?: Fiber | null;
      memoizedProps?: { source?: string };
      stateNode?: { current?: Fiber; setState?: (state: { error: Error }) => void };
    }
    const root = document.getElementById("root") as HTMLElement & Record<string, unknown>;
    const key = Object.keys(root).find((key) => key.startsWith("__reactContainer$"));
    if (!key) throw new Error("React root missing");
    const container = root[key] as Fiber;
    const stack: Fiber[] = [container.stateNode?.current ?? container];
    while (stack.length) {
      const fiber = stack.pop()!;
      if (fiber.memoizedProps?.source === source && fiber.stateNode?.setState) {
        fiber.stateNode.setState({ error: new Error("Isolated recovery fixture") });
        return;
      }
      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);
    }
    throw new Error(`Boundary missing: ${source}`);
  }, source);
}

test("app fallback reload restores the selected terminal", async () => {
  const coterm = await launchCoterm();
  try {
    const { page } = coterm;
    await page.locator(".boot-screen").waitFor({ state: "detached" });
    const terminalId = await page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      const layout = await window.aiTerminal.openTile({ projectId: projects[0]!.id });
      return layout.selectedTerminalId;
    });
    await expect(page.locator(".xterm-pane-frame.active")).toBeVisible();
    await failBoundary(page, "app");
    const reload = page.locator('[data-action-id="app.error.reload"]');
    await expect(reload).toBeVisible();
    await reload.click();
    await expect(reload).toHaveCount(0);
    await expect(page.locator(".xterm-pane-frame.active")).toBeVisible();
    expect(await page.evaluate(async () => (await window.aiTerminal.getDockLayout()).selectedTerminalId)).toBe(terminalId);
    const blocked = await coterm.app.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      const appUrl = contents.getURL();
      const result = new Promise<boolean>((resolve) => {
        contents.once("will-navigate", (event) => {
          resolve(event.defaultPrevented && contents.getURL() === appUrl);
        });
      });
      void contents.executeJavaScript('location.href = "https://example.invalid/blocked-navigation"');
      return result;
    });
    expect(blocked).toBe(true);
  } finally { await coterm.close(); }
});

test("artifact fallback close clears failed preview and preserves terminal", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "coterm-recovery-"));
  await writeFile(join(workspace, "fixture.md"), "# Preview fixture");
  const coterm = await launchCoterm({ defaultWorkspacePath: workspace });
  try {
    const { page, logPath } = coterm;
    await page.locator(".boot-screen").waitFor({ state: "detached" });
    await page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      await window.aiTerminal.openTile({ projectId: projects[0]!.id });
    });
    await page.locator('[data-action-id="explorer.open"]').click();
    await page.locator('[data-action-id="explorer.file.open"]', { hasText: "fixture.md" }).click();
    await expect(page.locator(".artifact-markdown")).toBeVisible();
    await failBoundary(page, "artifact-preview");
    const close = page.locator('[data-action-id="artifact.preview.close"]');
    await expect(close).toBeVisible();
    await close.click();
    await expect(close).toHaveCount(0);
    await expect(page.locator("aside.artifact-rail")).not.toHaveClass(/previewing/);
    await expect(page.locator(".xterm-pane-frame.active")).toBeVisible();
    await expect.poll(async () => (await readUiActions(logPath)).map((entry) => entry.actionId)).toContain("artifact.preview.close");
  } finally {
    await coterm.close();
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("sunmoon worktree row copies its exact path and audits", async () => {
  const coterm = await launchCoterm();
  try {
    const { app, page, logPath } = coterm;
    const path = join(coterm.userData, "fixture-worktree");
    await page.locator(".boot-screen").waitFor({ state: "detached" });
    await app.evaluate(({ ipcMain }, path) => {
      ipcMain.removeHandler("worktree-registry:get");
      ipcMain.handle("worktree-registry:get", () => ({
        entries: [{ path, branch: "fixture", firstSeenAt: Date.now(), lastSeenAt: Date.now(), removed: false, dirty: false }],
        baselineCount: 0, lastCheckedAt: Date.now(),
      }));
    }, path);
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: async (value: string) => { document.documentElement.dataset.copiedWorktree = value; },
      });
    });
    await page.locator('[data-action-id="sidebar.pulse.files.toggle"]').click();
    const row = page.locator('[data-action-id="sidebar.pulse.worktree.row:0"]');
    await expect(row).toContainText("fixture-worktree");
    await row.click();
    await expect(row).toHaveClass(/copied/);
    expect(await page.evaluate(() => document.documentElement.dataset.copiedWorktree)).toBe(path);
    await expect.poll(async () => (await readUiActions(logPath)).map((entry) => entry.actionId)).toContain("sidebar.pulse.worktree.row:0");
  } finally { await coterm.close(); }
});
