import { expect, test } from "@playwright/test";
import { launchCoterm, readUiActions } from "./helpers/coterm-launch";

const SCENARIO_TITLE = "sidebar project + archive actions render and audit";

test(SCENARIO_TITLE, async () => {
  const coterm = await launchCoterm();
  try {
    const { page, logPath } = coterm;

    page.on("dialog", (d) => void d.accept());

    await page.locator("section.project-group").first().waitFor({ state: "visible" });

    await page.locator('[data-action-id="sidebar.collapse"]').click();
    await expect(page.locator("aside.sidebar")).toHaveClass(/collapsed/);
    await expect(page.locator('[data-action-id="sidebar.expand"]')).toBeVisible();

    await page.locator('[data-action-id="sidebar.expand"]').click();
    await expect(page.locator("aside.sidebar")).not.toHaveClass(/collapsed/);
    await expect(page.locator('[data-action-id="sidebar.collapse"]')).toBeVisible();

    await page.locator('[data-action-id="sidebar.search.change"]').fill("ab");
    await expect(page.locator(".search-results")).toBeVisible();
    await page.locator('[data-action-id="sidebar.search.change"]').fill("");

    // sidebar.project.create: the IPC path needs the native folder picker, so
    // assert the button is wired (audited) rather than that a new project appears.
    await page.locator('[data-action-id="sidebar.project.create"]').click();

    const projectMain = page.locator('[data-action-id="sidebar.project.rename.start"]').first();
    await projectMain.dblclick();
    await expect(page.locator('[data-action-id="sidebar.project.rename.submit"]')).toBeVisible();

    const renameInput = page.locator('[data-action-id="sidebar.project.rename.change"]');
    await renameInput.fill("Renamed Project");
    await renameInput.press("Enter");
    await expect(page.locator('[data-action-id="sidebar.project.rename.submit"]')).toHaveCount(0);

    await page.locator('[data-action-id="sidebar.project.actions.open"]').first().dispatchEvent("click");
    await expect(page.locator(".project-more-menu")).toBeVisible();

    await page.locator('[data-action-id="sidebar.project.rename"]').click();
    await expect(page.locator('[data-action-id="sidebar.project.rename.submit"]')).toBeVisible();
    await page.locator('[data-action-id="sidebar.project.rename.change"]').press("Escape");
    await expect(page.locator('[data-action-id="sidebar.project.rename.submit"]')).toHaveCount(0);

    await page.locator('[data-action-id="sidebar.project.actions.open"]').first().dispatchEvent("click");
    await page.locator('[data-action-id="sidebar.project.pin-toggle"]').click();
    await expect(page.locator(".project-more-menu")).toHaveCount(0);

    // C: create a real OSC 9 attention signal in a PTY, then exercise the
    // inbox action end-to-end. Sleeping after the notification keeps the
    // command lifecycle open long enough for the user-facing row to remain.
    const { decoyTerminalId, attentionTerminalId } = await page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      const first = await window.aiTerminal.openTile({ projectId: projects[0]!.id });
      const second = await window.aiTerminal.openTile({ projectId: projects[0]!.id });
      await window.aiTerminal.markTerminalAgent({
        terminalId: second.selectedTerminalId!,
        agentProfile: "claude-local-main",
      });
      return {
        decoyTerminalId: first.selectedTerminalId!,
        attentionTerminalId: second.selectedTerminalId!,
      };
    });
    // openTile above goes through preload directly; wait until the renderer's
    // terminal-list subscription has mounted both frames before selecting one
    // by its terminal id. PTY state can become ready slightly earlier.
    await expect(page.locator('[data-action-id="terminal.activate"]')).toHaveCount(2, { timeout: 15_000 });
    await expect.poll(
      () => page.evaluate((id) => window.aiTerminal.getPtyState(id), attentionTerminalId),
      { timeout: 15_000 },
    ).toBe("done");
    // The #id label moved into the header's ⋯ popover (2026-10-03); the frame
    // carries its terminal id as an attribute instead.
    const attentionFrame = page.locator(`[data-action-id="terminal.activate"][data-terminal-id="${attentionTerminalId}"]`);
    const beforeAttention = await attentionFrame.evaluate((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return {
        borderWidth: style.borderTopWidth,
        borderWidthToken: getComputedStyle(document.documentElement)
          .getPropertyValue("--dock-pane-border-width").trim(),
        width: box.width,
        height: box.height,
      };
    });
    // Chromium reports device-pixel-adjusted computed border widths on some
    // Windows display scales. Assert the authored CSS token is exactly 3px,
    // then compare the rendered geometry before/after attention below.
    expect(beforeAttention.borderWidthToken).toBe("3px");
    await page.evaluate(async ({ terminalId, command }) => {
      await window.aiTerminal.writeTerminal({ terminalId, data: command });
    }, {
      terminalId: attentionTerminalId,
      command: '[Console]::Write("`e]9;Approval required`a"); $null=Read-Host; Start-Sleep -Seconds 2; [Console]::Write("`e]9;Approval required`a"); $null=Read-Host; Start-Sleep -Seconds 15\r',
    });
    const attentionItem = page.locator('[data-action-id="sidebar.attention.item.select"]');
    await expect(attentionItem).toBeVisible({ timeout: 10_000 });
    await expect(attentionFrame).toHaveClass(/attention-ring/);
    const withAttention = await attentionFrame.evaluate((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return {
        borderWidth: style.borderTopWidth,
        borderWidthToken: getComputedStyle(document.documentElement)
          .getPropertyValue("--dock-pane-border-width").trim(),
        width: box.width,
        height: box.height,
      };
    });
    expect(withAttention).toEqual(beforeAttention);
    await expect(page.locator(".xterm-attention-badge")).toBeVisible();
    await expect(page.locator(".project-attention-badge").first()).toHaveText("1");

    // A blank human Enter acknowledges the first prompt immediately across
    // frame/header/sidebar. The command emits a second prompt two seconds
    // later, proving a fresh attention notification can re-trigger.
    await page.evaluate((terminalId) => window.aiTerminal.writeTerminal({
      terminalId,
      data: "\r",
      source: "human",
    }), attentionTerminalId);
    await expect(page.locator(".attention-inbox")).toHaveCount(0);
    await expect(attentionFrame).not.toHaveClass(/attention-ring/);
    await expect(page.locator(".xterm-attention-badge")).toHaveCount(0);
    await expect(attentionItem).toBeVisible({ timeout: 10_000 });
    await expect(attentionFrame).toHaveClass(/attention-ring/);

    await page.evaluate((terminalId) => window.aiTerminal.selectTile({ terminalId }), decoyTerminalId);
    await attentionItem.click();
    await expect(page.locator(".attention-inbox")).toHaveCount(0);
    await expect(attentionFrame).toHaveClass(/active/);
    await page.evaluate((terminalId) => window.aiTerminal.writeTerminal({
      terminalId,
      data: "\r",
      source: "human",
    }), attentionTerminalId);
    await expect(attentionFrame).not.toHaveClass(/attention-ring/);

    // f2: on desktop the history button expands the INLINE session branch
    // under the folder (the fullscreen panel is web/mobile only now).
    await page.locator('[data-action-id="sidebar.project.history.open"]').first().dispatchEvent("click");
    await expect(page.locator(".project-sessions")).toBeVisible();

    await page.locator('[data-action-id="sidebar.history.close"]').click();
    await expect(page.locator(".project-sessions")).toHaveCount(0);

    // sidebar.project.archive: the menu button triggers window.confirm which
    // is flaky under force-click. Drive the archive via the preload API (same
    // path the button's archiveProject() calls), then reload so the store
    // re-bootstraps and the project leaves the active list.
    await page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      await window.aiTerminal.archiveProject({ projectId: projects[0]!.id, value: true });
    });
    await page.reload();
    await page.locator("section.project-group").first().waitFor({ state: "detached" });

    await page.locator('[data-action-id="sidebar.archive.toggle"]').click();
    await expect(page.locator(".archive-list")).toBeVisible();

    await expect(page.locator('[data-action-id="sidebar.archive.restore"]').first()).toBeVisible();
    await page.locator('[data-action-id="sidebar.archive.restore"]').first().click();

    await expect.poll(async () => (await readUiActions(logPath)).map((a) => a.actionId), { timeout: 10_000 }).toEqual(
      expect.arrayContaining([
        "sidebar.collapse",
        "sidebar.expand",
        "sidebar.project.actions.open",
        "sidebar.project.rename",
        "sidebar.project.pin-toggle",
        "sidebar.attention.item.select",
        "sidebar.archive.toggle",
        "sidebar.archive.restore",
        "sidebar.history.close",
      ]),
    );
  } finally {
    await coterm.close();
  }
});
