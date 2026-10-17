import { expect, test } from "@playwright/test";
import { launchCoterm, readUiActions } from "./helpers/coterm-launch";

// The mobile dock branch renders only when useIsMobile() returns true, which
// is gated on the shared mobile media query. The desktop
// Electron BrowserWindow has minWidth:1024, so this scenario launches an
// isolated 390px E2E viewport through the main-process test flag.
const SCENARIO_TITLE = "topbar mobile dock actions render and audit";

test(SCENARIO_TITLE, async () => {
  const coterm = await launchCoterm({ mobileViewport: true });
  try {
    const { page, logPath } = coterm;

    // Mobile dock bar mounts (proves useIsMobile() === true via the mock).
    await page.locator("header.mobile-dock-bar").waitFor({ state: "visible", timeout: 15_000 });

    // Open a plain PTY tile directly via the preload API so activeTerminalId is
    // set and the mobile keys become enabled (same pattern as terminal spec).
    await page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      await window.aiTerminal.openTile({ projectId: projects[0]!.id });
    });

    // The fixed Sidebar button is the only visible Workspace control at left.
    await expect(page.locator('[data-action-id="sidebar.expand"]')).toBeVisible();

    // The left-most control opens the same settings sheet the desktop brand gear does.
    await page.locator('[data-action-id="topbar.mobile.settings.open"]').click();
    await expect(page.locator('[data-action-id="settings.drawer.consume"]')).toBeVisible();
    await page.locator('[data-action-id="settings.close"]').click();
    await expect(page.locator('[data-action-id="settings.drawer.consume"]')).toBeHidden();

    // The main row contains Workspace, one middle dropdown, and Enter. PTY
    // choices/tools stay hidden until the dropdown opens.
    const keysToggle = page.locator('[data-action-id="topbar.mobile.keys.toggle"]');
    await expect(keysToggle).toBeVisible();
    await expect(keysToggle).toBeEnabled();
    await expect(page.locator(".mobile-menu-panel")).toBeHidden();

    const enterBtn = page.locator('[data-action-id="topbar.mobile.enter"]');
    await expect(enterBtn).toBeVisible();
    await expect(enterBtn).toBeEnabled();
    await enterBtn.dispatchEvent("click");

    // The dropdown is an overlay, not a second layout row.
    await keysToggle.dispatchEvent("click");
    await expect(page.locator(".mobile-menu-panel")).toBeVisible();
    await expect(page.locator(".mobile-keys-tray")).toBeVisible();

    // PTY selection now lives inside the dropdown and closes it after use.
    const slot = page.locator('[data-action-id="topbar.mobile.terminal.select"]').first();
    await slot.waitFor({ state: "visible", timeout: 15_000 });
    await expect(slot).toHaveClass(/active/);
    await slot.dispatchEvent("click");
    await expect(page.locator(".mobile-menu-panel")).toBeHidden();
    await keysToggle.dispatchEvent("click");

    // Arrow / Esc / Tab keys: visible + enabled (state oracle). Driving them
    // would write escape sequences to the PTY; visibility+enabled is the
    // behavioral oracle for these key-injection surfaces.
    for (const id of [
      "topbar.mobile.key.up",
      "topbar.mobile.key.down",
      "topbar.mobile.key.left",
      "topbar.mobile.key.right",
      "topbar.mobile.key.escape",
      "topbar.mobile.key.tab",
    ]) {
      const btn = page.locator(`[data-action-id="${id}"]`);
      await expect(btn).toBeVisible();
      await expect(btn).toBeEnabled();
    }

    // topbar.mobile.refresh: visible + enabled.
    const refreshBtn = page.locator('[data-action-id="topbar.mobile.refresh"]');
    await expect(refreshBtn).toBeVisible();
    await expect(refreshBtn).toBeEnabled();

    // topbar.mobile.input.open: visible + enabled. Opens the input overlay panel
    // (reuses mobile-paste-fallback). Driving it opens the panel with a
    // controlled textarea + send-with-Enter toggle.
    const inputBtn = page.locator('[data-action-id="topbar.mobile.input.open"]');
    await expect(inputBtn).toBeVisible();
    await expect(inputBtn).toBeEnabled();
    // A fresh profile starts in composer mode, so the first toggle selects the
    // native keyboard and closes the menu. Reopen and toggle once more to drive
    // the composer branch without relying on a racy pre-render init script.
    await inputBtn.dispatchEvent("click");
    await expect(page.locator(".mobile-menu-panel")).toBeHidden();
    await keysToggle.dispatchEvent("click");
    await inputBtn.dispatchEvent("click");
    const inputPanel = page.locator('[data-action-id="topbar.mobile.paste-fallback.consume"]');
    await expect(inputPanel).toBeVisible();
    // Reopen helper: the button toggles the mode, so after one open the stored
    // mode is "composer" and the next click would switch to the native keyboard.
    // Reset to "direct" before reopening the menu (TopBar re-reads the mode on
    // every render, and opening the menu is a render).
    const reopenComposer = async (): Promise<void> => {
      await page.evaluate(() => localStorage.setItem("coterm.mobile.inputMode", "direct"));
      await keysToggle.dispatchEvent("click");
      await inputBtn.dispatchEvent("click");
    };
    await inputPanel.dispatchEvent("pointerdown");
    await expect(inputPanel).toContainText("按右上角 ENTER");
    const textarea = page.locator('[data-action-id="topbar.mobile.paste-fallback.textarea"]');
    await textarea.click();
    await textarea.fill("中文輸入\n第二行");
    await expect(inputPanel.locator(".mobile-paste-fallback-warn")).toContainText("2");

    // A composing IME owns Ctrl+Enter: it must not submit until compositionend.
    await textarea.dispatchEvent("compositionstart");
    await textarea.press("Control+Enter");
    await expect(inputPanel).toBeVisible();
    await textarea.dispatchEvent("compositionend");
    await textarea.press("Control+Enter");
    await expect(inputPanel).toBeHidden();

    // Reopening clears input and restores the send-with-Enter default.
    await reopenComposer();
    await expect(inputPanel).toBeVisible();
    await expect(textarea).toHaveValue("");

    // Toggle-off confirmation uses the raw-text path and closes the panel.
    await textarea.fill("raw-no-enter");
    await page.locator('[data-action-id="topbar.mobile.paste-fallback.confirm"]').dispatchEvent("click");
    await expect(inputPanel).toBeHidden();

    // Cancel sends nothing and the next open starts empty/default-on again.
    await reopenComposer();
    await textarea.fill("cancel-me");
    await page.locator('[data-action-id="topbar.mobile.paste-fallback.cancel"]').dispatchEvent("click");
    await expect(inputPanel).toBeHidden();
    await reopenComposer();
    await expect(textarea).toHaveValue("");
    await page.locator('[data-action-id="topbar.mobile.paste-fallback.cancel"]').dispatchEvent("click");

    // Audit oracle: driven actionIds appear in coterm.log.
    await expect.poll(
      async () => (await readUiActions(logPath)).map((a) => a.actionId),
      { timeout: 10_000 },
    ).toEqual(
      expect.arrayContaining([
        "topbar.mobile.terminal.select",
        "topbar.mobile.enter",
        "topbar.mobile.keys.toggle",
        "topbar.mobile.input.open",
        "topbar.mobile.paste-fallback.consume",
        "topbar.mobile.paste-fallback.textarea",
        "topbar.mobile.paste-fallback.confirm",
        "topbar.mobile.paste-fallback.cancel",
      ]),
    );
  } finally {
    await coterm.close();
  }
});
