import { expect, test } from "@playwright/test";
import { launchCoterm } from "./helpers/coterm-launch";

// Codex Team (#100) is a built-in profile — it appears in the Agent picker out
// of the box, no settings write needed.
test("Codex Team official profile appears in Agent picker out of the box", async () => {
  const coterm = await launchCoterm({ onboardingCompleted: true, seedProject: true });
  try {
    const { page } = coterm;
    await page.locator('[data-action-id="sidebar.project.open-agent"]').first().dispatchEvent("click");
    await expect(page.locator('[data-agent-id="codex-team"]')).toContainText("Codex Team");
  } finally { await coterm.close(); }
});
