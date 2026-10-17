import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { launchCoterm, readUiActions } from "./helpers/coterm-launch";

const execFileAsync = promisify(execFile);
const SCENARIO_TITLE = "worktree sandbox opens an isolated terminal and audits the action";

test(SCENARIO_TITLE, async () => {
  const repo = await mkdtemp(join(tmpdir(), "coterm-e2e-worktree repo-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repo, shell: false, windowsHide: true });
  await execFileAsync("git", ["config", "user.email", "e2e@coterm.dev"], { cwd: repo, shell: false, windowsHide: true });
  await execFileAsync("git", ["config", "user.name", "Coterm E2E"], { cwd: repo, shell: false, windowsHide: true });
  await writeFile(join(repo, "README.md"), "# fixture\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repo, shell: false, windowsHide: true });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: repo, shell: false, windowsHide: true });

  const coterm = await launchCoterm({ defaultWorkspacePath: repo });
  try {
    const { page, logPath } = coterm;
    await page.locator(".boot-screen").waitFor({ state: "detached", timeout: 20_000 });
    await page.locator('[data-action-id="sidebar.project.actions.open"]').first().dispatchEvent("click");
    await page.locator('[data-action-id="sidebar.project.open-sandbox"]').dispatchEvent("click");
    await expect(page.locator('[data-action-id="picker.dialog.consume"]')).toBeVisible({ timeout: 20_000 });

    const state = await expect.poll(async () => page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      const projectId = projects[0]!.id;
      const worktrees = await window.aiTerminal.listWorktrees({ projectId });
      const terminals = await window.aiTerminal.listTerminals(projectId);
      const worktree = worktrees[0] ?? null;
      const terminal = worktree
        ? terminals.find((item) => item.worktreeId === worktree.id) ?? null
        : null;
      return { projectId, worktree, terminal };
    }), { timeout: 20_000 }).toMatchObject({
      worktree: { status: "active", baseRef: "main" },
      terminal: { status: "running" },
    });

    // expect.poll's matcher is the oracle; fetch the concrete ids for guarded cleanup.
    const fixture = await page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      const projectId = projects[0]!.id;
      const [worktree] = await window.aiTerminal.listWorktrees({ projectId });
      const terminal = (await window.aiTerminal.listTerminals(projectId))
        .find((item) => item.worktreeId === worktree!.id)!;
      return { worktree: worktree!, terminal };
    });
    expect(fixture.terminal.cwd.toLowerCase()).toBe(fixture.worktree.worktreePath.toLowerCase());

    await page.locator('[data-action-id="picker.close"]').click();
    await page.evaluate(async ({ terminalId, worktreeId }) => {
      await window.aiTerminal.closeTile({ terminalId });
      await window.aiTerminal.cleanupWorktree({ worktreeId });
    }, { terminalId: fixture.terminal.id, worktreeId: fixture.worktree.id });

    await expect.poll(
      async () => (await readUiActions(logPath)).map((entry) => entry.actionId),
      { timeout: 10_000 },
    ).toContain("sidebar.project.open-sandbox");
    void state;
  } finally {
    await coterm.close();
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
