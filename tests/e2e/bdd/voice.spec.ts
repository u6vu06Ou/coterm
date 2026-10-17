import { expect, test } from "@playwright/test";
import { launchCoterm } from "../helpers/coterm-launch";
import { openSettingsTab } from "../helpers/settings-tabs";

test("BDD-VOICE-002 configured endpoint and model survive a settings round trip", async () => {
  const coterm = await launchCoterm({
    voiceEnabled: true,
    voiceSttUrl: "http://127.0.0.1:8765/v1",
    voiceSttModel: "large-v3",
  });
  try {
    const { page } = coterm;
    await page.locator('[data-action-id="topbar.settings.open"]').click();
    await openSettingsTab(page, "voice");
    await expect(page.locator('[data-action-id="settings.voice-stt-url.change"]'))
      .toHaveValue("http://127.0.0.1:8765/v1");
    await expect(page.locator('[data-action-id="settings.voice-stt-model.change"]'))
      .toHaveValue("large-v3");
    await page.locator('[data-action-id="settings.close"]').click();
    await page.locator('[data-action-id="topbar.settings.open"]').click();
    await openSettingsTab(page, "voice");
    await expect(page.locator('[data-action-id="settings.voice-stt-url.change"]'))
      .toHaveValue("http://127.0.0.1:8765/v1");
  } finally {
    await coterm.close();
  }
});

test("BDD-VOICE-008 disabling voice removes the hold-to-talk affordance", async () => {
  const coterm = await launchCoterm({ voiceEnabled: false });
  try {
    await expect(coterm.page.locator('[data-action-id="topbar.voice.toggle"]')).toHaveCount(0);
  } finally {
    await coterm.close();
  }
});

async function openPlainTerminal(page: import("@playwright/test").Page): Promise<void> {
  const countBefore = await page.locator('[data-action-id="terminal.activate"]').count();
  await page.locator('[data-action-id="sidebar.project.open-agent"]').first().dispatchEvent("click");
  await expect(page.locator('[data-action-id="picker.dialog.consume"]')).toBeVisible();
  await page.locator('[data-action-id="picker.plain.select"]').click();
  await expect(page.locator('[data-action-id="terminal.activate"]')).toHaveCount(countBefore + 1);
}

test("BDD-VOICE-P4 locked pane gets partial only; final writes once without Enter", async () => {
  const coterm = await launchCoterm({
    voiceEnabled: true,
    voiceStreamingDictation: true,
    voiceTestHarness: true,
  });
  try {
    const { page } = coterm;
    await openPlainTerminal(page);
    await openPlainTerminal(page);
    const terminalIds = await page.evaluate(async () => (await window.aiTerminal.getDockLayout()).tiles.map((tile) => tile.terminalId));
    const [terminalA, terminalB] = terminalIds;
    expect(terminalA).toBeTruthy();
    expect(terminalB).toBeTruthy();
    await page.evaluate(async (terminalId) => window.aiTerminal.selectTile({ terminalId }), terminalA!);

    const mic = page.locator('[data-action-id="topbar.voice.toggle"]');
    await expect(mic).toBeVisible();
    // Toggle mode: a tap (pointerdown + pointerup within the long-press window) starts recording.
    await mic.dispatchEvent("pointerdown");
    await mic.dispatchEvent("pointerup");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("coterm:test-voice-partial", {
      detail: { text: "partial preview" },
    })));

    const overlayA = page.locator(`[data-voice-terminal-id="${terminalA}"]`);
    await expect(overlayA).toContainText("partial preview");
    await expect(page.locator(`[data-voice-terminal-id="${terminalB}"]`)).toHaveCount(0);
    expect(await page.evaluate(() => (window.aiTerminal.getVoiceTestWrites?.() ?? []).filter((entry) => entry.data.length > 0))).toEqual([]);

    await page.evaluate(() => window.dispatchEvent(new Event("coterm:test-voice-preview-paused")));
    await expect(overlayA).toHaveAttribute("data-voice-phase", "preview-paused");

    await page.evaluate(async (terminalId) => window.aiTerminal.selectTile({ terminalId }), terminalB!);
    // Second tap submits.
    await mic.dispatchEvent("pointerdown");
    await mic.dispatchEvent("pointerup");
    // An impatient third tap while recognition finishes must preserve the final.
    await mic.dispatchEvent("pointerdown");
    await mic.dispatchEvent("pointerup");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("coterm:test-voice-final", {
      detail: { text: "final mixed 中文 text" },
    })));

    await expect.poll(() => page.evaluate(() => (window.aiTerminal.getVoiceTestWrites?.() ?? []).filter((entry) => entry.data.length > 0)))
      .toEqual([{ terminalId: terminalA, data: "final mixed 中文 text" }]);
    const writes = await page.evaluate(() => (window.aiTerminal.getVoiceTestWrites?.() ?? []).filter((entry) => entry.data.length > 0));
    expect(writes[0]?.data).not.toMatch(/[\r\n]/u);
  } finally {
    await coterm.close();
  }
});

test("BDD-VOICE-P4 closed target preserves final as recoverable draft", async () => {
  const coterm = await launchCoterm({
    voiceEnabled: true,
    voiceStreamingDictation: true,
    voiceTestHarness: true,
  });
  try {
    const { page } = coterm;
    await openPlainTerminal(page);
    await openPlainTerminal(page);
    const terminalIds = await page.evaluate(async () => (await window.aiTerminal.getDockLayout()).tiles.map((tile) => tile.terminalId));
    const [terminalA, terminalB] = terminalIds;
    await page.evaluate(async (terminalId) => window.aiTerminal.selectTile({ terminalId }), terminalA!);
    const mic = page.locator('[data-action-id="topbar.voice.toggle"]');
    await mic.dispatchEvent("pointerdown");
    await mic.dispatchEvent("pointerup");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("coterm:test-voice-partial", {
      detail: { text: "preview before close" },
    })));
    await page.evaluate(async (terminalId) => window.aiTerminal.closeTile({ terminalId }), terminalA!);
    await expect(page.locator(`[data-voice-terminal-id="${terminalA}"]`)).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("coterm:test-voice-final", {
      detail: { text: "recoverable final" },
    })));

    const recovery = page.locator('[data-action-id="topbar.voice.recover-insert"]');
    await expect(recovery).toBeVisible();
    expect(await page.evaluate(() => (window.aiTerminal.getVoiceTestWrites?.() ?? []).filter((entry) => entry.data.length > 0))).toEqual([]);
    await recovery.click();
    await expect.poll(() => page.evaluate(() => (window.aiTerminal.getVoiceTestWrites?.() ?? []).filter((entry) => entry.data.length > 0)))
      .toEqual([{ terminalId: terminalB, data: "recoverable final" }]);
    await expect(recovery).toHaveCount(0);
  } finally {
    await coterm.close();
  }
});
test("BDD-VOICE-P6 agentapi rail stays hidden while the feature flag is off", async () => {
  // Failure/circuit-break isolation (§14): with agentapi.sidebar off, no
  // panel, no toggle, no IPC surface appears in the UI at all. 2026-10-02:
  // defaults are OFF for new installs, so this scenario seeds it off loudly.
  const coterm = await launchCoterm({ voiceEnabled: false });
  try {
    const { page } = coterm;
    await page.locator('[data-action-id="explorer.open"]').waitFor({ state: "visible", timeout: 15_000 });
    await expect(page.locator('[data-action-id="topbar.agentapi.toggle"]')).toHaveCount(0);
    await expect(page.locator("aside.agentapi-rail")).toHaveCount(0);
  } finally {
    await coterm.close();
  }
});
