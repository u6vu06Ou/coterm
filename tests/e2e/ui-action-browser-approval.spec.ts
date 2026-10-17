import { expect, test } from "@playwright/test";
import { launchCoterm, readUiActions } from "./helpers/coterm-launch";

/**
 * v1.5.41 gap scenarios (issue #97):
 * - browserApproval.acceptForSession — the "allow for this session" button on
 *   the browser approval dialog (added 4694d05, was never driven end-to-end).
 * - terminal.renderer.degraded — the WebGL context-loss badge whose click
 *   rebuilds the pane engine.
 *
 * Real flow produces approval prompts from the built-in browser agent, which
 * needs a live L2/L3 action — too heavy for the action matrix. The event
 * stream main→renderer is the dialog's only input, so the scenario injects a
 * canonical approval.requested/approval.resolved pair over the same
 * "stream:event" IPC channel main itself uses (register-ipc.ts), then drives
 * the real button and audits it.
 */

const APPROVAL_CHANNEL = "stream:event";

function approvalEvent(type: "approval.requested" | "approval.resolved", requestId: string) {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    conversationId: "66666666-7777-4888-8999-000000000000",
    turnId: "12345678-90ab-4cde-8f01-234567890abc",
    providerSessionId: null,
    turnGroupId: null,
    type,
    createdAt: new Date().toISOString(),
    sequence: 1,
    summary: "",
    payload: {
      browser: true,
      requestId,
      action: "fill",
      origin: "https://example.com",
      level: 2,
      locatorStrategy: "role",
    },
  };
}

test("browser approval session grant renders and audits", async () => {
  const coterm = await launchCoterm();
  try {
    const { app, page, logPath } = coterm;
    // Boot-screen can unmount before this wait is even attached
    // (waitFor(detached) resolves instantly on an absent element), so it is
    // NOT proof that initialize() finished and the onEvent subscriber is live.
    // The topbar only renders from the post-initialize React tree — use it.
    await page.locator('[data-action-id="topbar.terminal.refresh"]').waitFor({ state: "visible", timeout: 20_000 });

    const requestId = "e2e-accept-for-session-1";
    // app.evaluate stringifies the callback into the main process — closures
    // over this spec's consts do NOT cross, so the channel rides along as an
    // arg instead of being captured. Send to every window: the app may hold
    // helper windows and getAllWindows()[0] is not guaranteed to be the UI.
    await app.evaluate(({ BrowserWindow }, injected) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send(injected.channel, injected.event);
    }, { channel: APPROVAL_CHANNEL, event: approvalEvent("approval.requested", requestId) });

    // The dialog renders the session-wide note and all three decisions.
    const sessionButton = page.locator('[data-action-id="browserApproval.acceptForSession"]');
    await sessionButton.waitFor({ state: "visible", timeout: 10_000 });
    await expect(page.locator('[data-action-id="browserApproval.accept"]')).toBeVisible();
    await expect(page.locator('[data-action-id="browserApproval.decline"]')).toBeVisible();

    // Clicking grant-for-session resolves through the real IPC path
    // (approval:resolve). The broker has no pending entry for the synthetic id,
    // so the dismissal the flow would normally broadcast is injected here —
    // same channel main uses for approval.resolved.
    await sessionButton.click();
    await app.evaluate(({ BrowserWindow }, injected) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send(injected.channel, injected.event);
    }, { channel: APPROVAL_CHANNEL, event: approvalEvent("approval.resolved", requestId) });
    await expect(page.locator('[data-action-id="browserApproval.backdrop"]')).toHaveCount(0);

    await expect.poll(
      async () => (await readUiActions(logPath)).map((a) => a.actionId),
      { timeout: 10_000 },
    ).toEqual(expect.arrayContaining(["browserApproval.acceptForSession"]));
  } finally {
    await coterm.close();
  }
});

test("terminal renderer degraded badge rebuilds the engine and audits", async () => {
  const coterm = await launchCoterm();
  try {
    const { page, logPath } = coterm;
    await page.locator(".boot-screen").waitFor({ state: "detached", timeout: 20_000 });

    await page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      await window.aiTerminal.openTile({ projectId: projects[0]!.id });
    });
    const frame = page.locator(".xterm-pane-frame.active");
    await frame.waitFor({ state: "visible", timeout: 15_000 });

    // Mark the engine root so the badge click can be oracled as a true rebuild
    // (fresh .xterm root), mirroring the topbar refresh scenario.
    await frame.locator(".xterm").evaluate((root) => {
      root.setAttribute("data-before-degraded", "true");
    });

    // Force a real WebGL context loss on the pane's addon canvas. Runners
    // without any GPU path (no webgl context at all) cannot exercise this
    // branch — skip there rather than fake the badge.
    const loss = await frame.evaluate((host) => {
      for (const canvas of Array.from(host.querySelectorAll("canvas"))) {
        const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as
          | (WebGLRenderingContext & { getExtension(name: string): { loseContext(): void } | null })
          | null;
        const extension = gl?.getExtension("WEBGL_lose_context");
        if (extension) {
          extension.loseContext();
          return "lost";
        }
      }
      return "no-webgl";
    });
    test.skip(loss !== "lost", "no WebGL context on this runner");

    // #96: context loss drops the engine back to the DOM renderer and surfaces
    // the degraded badge in the pane header.
    const badge = page.locator('[data-action-id="terminal.renderer.degraded"]');
    await badge.waitFor({ state: "visible", timeout: 10_000 });

    // Clicking the badge bumps the engine generation: a rebuild, so both the
    // badge and the marked root are gone.
    await badge.click();
    await expect(badge).toHaveCount(0);
    await expect.poll(async () => (
      await frame.locator(".xterm").getAttribute("data-before-degraded")
    ), { timeout: 15_000 }).toBeNull();

    await expect.poll(
      async () => (await readUiActions(logPath)).map((a) => a.actionId),
      { timeout: 10_000 },
    ).toEqual(expect.arrayContaining(["terminal.renderer.degraded"]));
  } finally {
    await coterm.close();
  }
});
