import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Locator } from "@playwright/test";
import { launchCoterm, readUiActions } from "./helpers/coterm-launch";

const SCENARIO_TITLE = "checkpoint rail controls render and audit";

test(SCENARIO_TITLE, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "coterm-e2e-checkpoint-"));
  const target = join(workspace, "state.txt");
  await writeFile(target, "v1\n");

  const coterm = await launchCoterm({ defaultWorkspacePath: workspace });
  try {
    const { page, logPath } = coterm;
    page.on("dialog", (dialog) => void dialog.accept());
    await page.locator(".boot-screen").waitFor({ state: "detached", timeout: 20_000 });

    const projectId = await page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      const projectId = projects[0]!.id;
      await window.aiTerminal.openTile({ projectId });
      return projectId;
    });
    await page.evaluate(
      (id) => window.aiTerminal.createExplicitCheckpoint({ projectId: id, phase: "pre" }),
      projectId,
    );
    await writeFile(target, "v2\n");
    await page.evaluate(
      (id) => window.aiTerminal.createExplicitCheckpoint({ projectId: id, phase: "post" }),
      projectId,
    );
    await writeFile(target, "v3\n");

    await page.locator('[data-action-id="topbar.checkpoint.toggle"]').click();
    const rail = page.locator(".checkpoint-rail");
    await expect(rail).toBeVisible();
    const resizer = page.locator('[data-action-id="checkpoint.resize"]');
    const widthBefore = Number(await resizer.getAttribute("aria-valuenow"));
    await resizer.dispatchEvent("pointerdown", { pointerId: 1, clientX: 500 });
    await resizer.dispatchEvent("pointerup", { pointerId: 1, clientX: 500 });
    await resizer.focus();
    await resizer.press("ArrowLeft");
    await expect(resizer).toHaveAttribute("aria-valuenow", String(widthBefore + 16));

    const preCard = page.locator(".checkpoint-card", {
      has: page.locator('[data-action-id="checkpoint.undo"]'),
    });
    const postCard = page.locator(".checkpoint-card", {
      has: page.locator('[data-action-id="checkpoint.redo"]'),
    });
    await expect(preCard).toHaveCount(1);
    await expect(postCard).toHaveCount(1);

    await preCard.locator('[data-action-id="checkpoint.diff"]').click();
    await expect(preCard).toContainText("state.txt");

    await preCard.locator('[data-action-id="checkpoint.hunk.restore"]').click();
    await expect.poll(() => readFile(target, "utf8").catch(() => null)).toBe("v1\n");
    await writeFile(target, "v3\n");
    await preCard.locator('[data-action-id="checkpoint.diff"]').click();

    await preCard.locator('[data-action-id="checkpoint.restore"]').click();
    await expect.poll(() => readFile(target, "utf8").catch(() => null)).toBe("v1\n");

    await writeFile(target, "undo-source\n");
    const undoButton = preCard.locator('[data-action-id="checkpoint.undo"]');
    expect(await actionAtCenter(undoButton)).toBe("checkpoint.undo");
    await undoButton.click();
    await expect.poll(() => readFile(target, "utf8").catch(() => null)).toBe("v1\n");

    await writeFile(target, "redo-source\n");
    const redoButton = postCard.locator('[data-action-id="checkpoint.redo"]');
    expect(await actionAtCenter(redoButton)).toBe("checkpoint.redo");
    await redoButton.click();
    await expect.poll(() => readFile(target, "utf8").catch(() => null)).toBe("v2\n");

    await page.locator('[data-action-id="checkpoint.close"]').click();
    await expect(rail).toHaveCount(0);

    await expect.poll(
      async () => (await readUiActions(logPath)).map((entry) => entry.actionId),
      { timeout: 10_000 },
    ).toEqual(expect.arrayContaining([
      "topbar.checkpoint.toggle",
      "checkpoint.resize",
      "checkpoint.close",
      "checkpoint.diff",
      "checkpoint.restore",
      "checkpoint.hunk.restore",
      "checkpoint.undo",
      "checkpoint.redo",
    ]));
  } finally {
    await coterm.close();
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

async function actionAtCenter(locator: Locator): Promise<string | null> {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return document
      .elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      ?.closest("[data-action-id]")
      ?.getAttribute("data-action-id") ?? null;
  });
}
