import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { launchCoterm, readUiActions } from "./helpers/coterm-launch";

const execFileAsync = promisify(execFile);
const SCENARIO_TITLE = "worktree manager dialog renders actions and audits them";

// Disposable fixture git repo: create a sandbox worktree, open the manager
// dialog, and assert the button-state rules mirror the backend's hard checks:
// - active + running PTY → merge/abort/cleanup DISABLED, resume ENABLED
// - diff toggle loads the pre-merge summary
// All destructive ops run against the disposable repo only; never real userData.
test(SCENARIO_TITLE, async () => {
  const repo = await mkdtemp(join(tmpdir(), "coterm-e2e-wt-mgr-"));
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

    // Open a sandbox agent (creates a worktree + running terminal bound to it).
    await page.locator('[data-action-id="sidebar.project.actions.open"]').first().dispatchEvent("click");
    await page.locator('[data-action-id="sidebar.project.open-sandbox"]').dispatchEvent("click");
    await page.locator('[data-action-id="picker.dialog.consume"]').waitFor({ state: "visible", timeout: 20_000 });
    await page.locator('[data-action-id="picker.close"]').click();

    // Wait for the worktree + bound running terminal to materialize.
    await expect.poll(async () => page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      const projectId = projects[0]!.id;
      const [worktree] = await window.aiTerminal.listWorktrees({ projectId });
      const terminal = worktree
        ? (await window.aiTerminal.listTerminals(projectId)).find((t) => t.worktreeId === worktree.id) ?? null
        : null;
      return {
        status: worktree?.status,
        hasRunningTerminal: worktree?.hasRunningTerminal,
        terminalStatus: terminal?.status,
      };
    }), { timeout: 20_000 }).toMatchObject({
      status: "active",
      hasRunningTerminal: true,
      terminalStatus: "running",
    });

    // Fetch the concrete ids for guarded cleanup (expect.poll's matcher is void).
    const fixture = await page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      const projectId = projects[0]!.id;
      const [worktree] = await window.aiTerminal.listWorktrees({ projectId });
      const terminal = (await window.aiTerminal.listTerminals(projectId))
        .find((t) => t.worktreeId === worktree!.id)!;
      return { worktreeId: worktree!.id, terminalId: terminal.id, agentProfile: terminal.agentProfile ?? "claude-local-main" };
    });

    // Open the worktree manager dialog.
    await page.locator('[data-action-id="sidebar.project.actions.open"]').first().dispatchEvent("click");
    await page.locator('[data-action-id="sidebar.project.manage-sandboxes"]').dispatchEvent("click");
    await page.locator('[data-action-id="worktree.dialog.consume"]').waitFor({ state: "visible", timeout: 10_000 });

    // The active worktree item is present.
    const item = page.locator(".worktree-item").first();
    await expect(item).toBeVisible();

    // active + running PTY, but no bound session yet → merge/abort/cleanup
    // DISABLED (running PTY), resume DISABLED (no nativeSessionId). Resume is
    // only usable when trusted session metadata is bound (acceptance #3).
    await expect(item.locator('[data-action-id="worktree.dialog.merge"]')).toBeDisabled();
    await expect(item.locator('[data-action-id="worktree.dialog.abort"]')).toBeDisabled();
    await expect(item.locator('[data-action-id="worktree.dialog.cleanup"]')).toBeDisabled();
    await expect(item.locator('[data-action-id="worktree.dialog.resume"]')).toBeDisabled();

    // Bind a trusted session metadata for the worktree+terminal. Now resume
    // becomes ENABLED (nativeSessionId present + live terminal bound).
    await page.evaluate(async ({ worktreeId, terminalId, agentProfile }) => {
      await window.aiTerminal.bindWorktreeSession({
        worktreeId,
        terminalId,
        nativeSessionId: "fake-session-id-0123",
        agentProfile,
      });
    }, { worktreeId: fixture.worktreeId, terminalId: fixture.terminalId, agentProfile: fixture.agentProfile });
    // Reopen the dialog so the store reloads worktrees with bound session.
    await page.locator('[data-action-id="worktree.dialog.close"]').click();
    await page.locator('[data-action-id="sidebar.project.actions.open"]').first().dispatchEvent("click");
    await page.locator('[data-action-id="sidebar.project.manage-sandboxes"]').dispatchEvent("click");
    await page.locator('[data-action-id="worktree.dialog.consume"]').waitFor({ state: "visible", timeout: 10_000 });
    const itemAfter = page.locator(".worktree-item").first();
    await expect(itemAfter.locator('[data-action-id="worktree.dialog.resume"]')).toBeEnabled({ timeout: 10_000 });
    // merge/abort/cleanup stay disabled (terminal still running).
    await expect(itemAfter.locator('[data-action-id="worktree.dialog.merge"]')).toBeDisabled();
    await expect(itemAfter.locator('[data-action-id="worktree.dialog.cleanup"]')).toBeDisabled();

    // Diff toggle loads the pre-merge summary (stat + commits). The worktree
    // has no commits ahead of base, so the stat may be empty — assert the
    // diff region renders, not its content.
    await itemAfter.locator('[data-action-id="worktree.dialog.diff.toggle"]').click();
    await expect(itemAfter.locator(".worktree-diff")).toBeVisible({ timeout: 10_000 });

    // Close the bound terminal so destructive ops become enabled, then cleanup.
    await page.evaluate(async ({ terminalId, worktreeId }) => {
      await window.aiTerminal.closeTile({ terminalId });
      await window.aiTerminal.cleanupWorktree({ worktreeId });
    }, { terminalId: fixture.terminalId, worktreeId: fixture.worktreeId });

    await page.locator('[data-action-id="worktree.dialog.close"]').click();
    await expect(page.locator('[data-action-id="worktree.dialog.consume"]')).toHaveCount(0);

    await expect.poll(
      async () => (await readUiActions(logPath)).map((entry) => entry.actionId),
      { timeout: 10_000 },
    ).toContain("sidebar.project.manage-sandboxes");
  } finally {
    await coterm.close();
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
