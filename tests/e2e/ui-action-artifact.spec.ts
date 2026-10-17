import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "@playwright/test";
import { launchCoterm, readUiActions } from "./helpers/coterm-launch";

const SCENARIO_TITLE = "artifact rail controls render and audit";
const ORIGINAL_MARKDOWN = "# original\n\n```ts\nconst answer = 42;\n```\n";

test(SCENARIO_TITLE, async () => {
  // Workspace is a temp dir so the temp markdown file lives outside the repo
  // root (a crash before cleanup would otherwise leave __artifact-test-*.md
  // in the repo, risking it being committed).
  const workspacePath = await mkdtemp(join(tmpdir(), "coterm-artifact-ws-"));
  const tempMdName = `__artifact-test.md`;
  const tempMdPath = join(workspacePath, tempMdName);
  await writeFile(tempMdPath, ORIGINAL_MARKDOWN, "utf8");

  const coterm = await launchCoterm({
    onboardingCompleted: true,
    defaultWorkspacePath: workspacePath,
    seedProject: true,
  });
  const { page, logPath } = coterm;
  try {
    // Wait for the app shell to render (boot screen gone).
    await page.locator('[data-action-id="explorer.open"]').waitFor({ state: "visible", timeout: 15_000 });

    // Open a dock tile for the seeded project so the explorer has a selected
    // project to list files from.
    await page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      await window.aiTerminal.openTile({ projectId: projects[0]!.id });
    });

    // Open the explorer panel.
    await page.locator('[data-action-id="explorer.open"]').click();
    await expect(page.locator('[data-action-id="explorer.close"]')).toBeVisible();

    // Click the temp markdown file row to open it as an artifact.
    const fileRow = page.locator('[data-action-id="explorer.file.open"]', { hasText: tempMdName });
    await fileRow.first().dispatchEvent("click");

    // The ArtifactRail should now be visible (artifactOpen=true).
    const rail = page.locator("aside.artifact-rail");
    await expect(rail).toBeVisible({ timeout: 10_000 });

    // artifact.resize: the resizer separator is visible (role=separator).
    const resizer = page.locator('[data-action-id="artifact.resize"]');
    await expect(resizer).toBeVisible();
    await expect(resizer).toHaveAttribute("role", "separator");

    // The ArtifactViewer needs to load the file content. Wait for the
    // "previewing" class (selectedArtifact is set by openArtifact).
    await expect(rail).toHaveClass(/previewing/);

    // Wait for the markdown viewer to render (editor actions appear).
    const editBtn = page.locator('[data-action-id="artifact.edit"]');
    await expect(editBtn).toBeVisible({ timeout: 10_000 });
    await expect(rail.locator(".artifact-markdown .hljs-keyword")).toBeVisible();
    await expect(rail.locator(".artifact-markdown .hljs-number")).toBeVisible();

    // artifact.edit: click edit -> textarea appears (editing mode).
    await editBtn.dispatchEvent("click");
    const editor = page.locator('[data-action-id="artifact.editor.change"]');
    await expect(editor).toBeVisible();

    // artifact.editor.change: fill the textarea with new content.
    await editor.fill("# edited content");
    await expect(editor).toHaveValue("# edited content");

    // artifact.revert: click revert -> draft resets to original content (the
    // editor stays open; revert only resets the draft, it does not exit edit mode).
    await page.locator('[data-action-id="artifact.revert"]').dispatchEvent("click");
    await expect(editor).toHaveValue(ORIGINAL_MARKDOWN);

    // artifact.save: fill new content and save -> writeArtifact called, exits edit mode.
    await page.locator('[data-action-id="artifact.editor.change"]').fill("# saved content");
    await page.locator('[data-action-id="artifact.save"]').dispatchEvent("click");
    await expect(page.locator('[data-action-id="artifact.editor.change"]')).toHaveCount(0);
    await expect(page.locator('[data-action-id="artifact.edit"]')).toBeVisible();

    // artifact.back: click back -> selectedArtifact cleared, "previewing"
    // class removed from the rail.
    await page.locator('[data-action-id="artifact.back"]').dispatchEvent("click");
    await expect(rail).not.toHaveClass(/previewing/);

    // artifact.close: click close -> rail unmounts (artifactOpen=false).
    await page.locator('[data-action-id="artifact.close"]').dispatchEvent("click");
    await expect(rail).toHaveCount(0);

    // Log oracle: driven actions are audited.
    await expect.poll(
      async () => (await readUiActions(logPath)).map((a) => a.actionId),
      { timeout: 10_000 },
    ).toEqual(
      expect.arrayContaining([
        "artifact.edit",
        "artifact.editor.change",
        "artifact.revert",
        "artifact.save",
        "artifact.back",
        "artifact.close",
      ]),
    );
  } finally {
    await coterm.close();
  }
});
