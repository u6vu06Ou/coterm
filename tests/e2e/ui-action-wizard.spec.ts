import { expect, test } from "@playwright/test";
import { launchCoterm, readUiActions } from "./helpers/coterm-launch";

const WIZARD_SCENARIO_TITLE = "first-run wizard steps render and audit";

test(WIZARD_SCENARIO_TITLE, async () => {
  const coterm = await launchCoterm({ onboardingCompleted: false });
  try {
    const { page, logPath } = coterm;

    await expect(page.locator(".wizard-backdrop")).toBeVisible();

    // wizard.step.select: six steps; clicking step 2 (the language page) activates it.
    const stepButtons = page.locator('[data-action-id="wizard.step.select"]');
    await expect(stepButtons).toHaveCount(6);
    await stepButtons.nth(1).click();
    await expect(stepButtons.nth(1)).toHaveClass(/active/);

    // wizard.back: now at step 1, back returns to step 0 and becomes disabled
    await page.locator('[data-action-id="wizard.back"]').click();
    await expect(page.locator('[data-action-id="wizard.back"]')).toBeDisabled();

    // wizard.next: click next -> step 1 button becomes active again
    await page.locator('[data-action-id="wizard.next"]').click();
    await expect(stepButtons.nth(1)).toHaveClass(/active/);

    // wizard.language.*.select: first run pre-selects the OS language, and one
    // click switches the wizard copy live (no reload), which is the whole point
    // of putting the language page before every choice the user has to read.
    const kicker = page.locator(".wizard-kicker");
    const languageOptions = page.locator(".wizard-language-options button");
    await expect(languageOptions).toHaveCount(2);
    await expect(page.locator(".wizard-language-options button.selected")).toHaveCount(1);
    await expect(kicker).toHaveAttribute("data-wizard-step", "2");
    await page.locator('[data-action-id="wizard.language.en-us.select"]').click();
    await expect(page.locator('[data-action-id="wizard.language.en-us.select"]')).toHaveClass(/selected/);
    await expect(kicker).toContainText("FIRST RUN");
    await expect(page.locator('[data-action-id="wizard.next"]')).toContainText("Next");

    // navigate to step 2 (workspace) for wizard.workspace.choose
    await page.locator('[data-action-id="wizard.next"]').click();
    const chooseBtn = page.locator('[data-action-id="wizard.workspace.choose"]');
    await expect(chooseBtn).toBeVisible();
    await chooseBtn.click();
    await expect(chooseBtn).toBeVisible();

    // step 3 is providers, step 4 is shell; the kicker is 1-based
    await page.locator('[data-action-id="wizard.next"]').click();
    await page.locator('[data-action-id="wizard.next"]').click();
    await expect(kicker).toHaveAttribute("data-wizard-step", "5");
    await expect(kicker).toHaveAttribute("data-wizard-total", "6");

    // wizard.shell.select: click shell button -> has className "selected"
    const shellBtn = page.locator('[data-action-id="wizard.shell.select"]');
    await shellBtn.click();
    await expect(shellBtn).toHaveClass(/selected/);

    // navigate to step 5 (ime) for wizard.ime.change
    await page.locator('[data-action-id="wizard.next"]').click();
    await expect(kicker).toHaveAttribute("data-wizard-step", "6");

    // wizard.ime.change: fill textarea -> value reflects input
    const imeTextarea = page.locator('[data-action-id="wizard.ime.change"]');
    await imeTextarea.fill("hello");
    await expect(imeTextarea).toHaveValue("hello");

    // wizard.complete: click complete -> onboardingCompleted=true -> wizard unmounts
    await page.locator('[data-action-id="wizard.complete"]').click();
    await expect(page.locator(".wizard-backdrop")).not.toBeVisible();

    await expect.poll(async () => (await readUiActions(logPath)).map((a) => a.actionId), { timeout: 10_000 })
      .toEqual(expect.arrayContaining(["wizard.language.en-us.select", "wizard.complete"]));
  } finally {
    await coterm.close();
  }
});