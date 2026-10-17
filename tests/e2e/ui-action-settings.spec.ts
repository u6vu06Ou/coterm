import { expect, test } from "@playwright/test";
import { launchCoterm } from "./helpers/coterm-launch";
import { openSettingsTab } from "./helpers/settings-tabs";

test("settings panel controls render and audit", async () => {
  const coterm = await launchCoterm();
  try {
    const { page } = coterm;

    await page.locator('[data-action-id="topbar.settings.open"]').click();
    const drawer = page.locator('[data-action-id="settings.drawer.consume"]');
    await expect(drawer).toBeVisible();

    // settings.language.change
    const langSelect = page.locator('[data-action-id="settings.language.change"]');
    await langSelect.selectOption("en-US");
    await expect(langSelect).toHaveValue("en-US");
    await openSettingsTab(page, "general");

    // settings.theme.change lives in the same General tab as the locale switch.
    const themeSelect = page.locator('[data-action-id="settings.theme.change"]');
    await expect(themeSelect).toHaveValue("dark");
    await themeSelect.selectOption("light");
    await expect(themeSelect).toHaveValue("light");
    await themeSelect.selectOption("dark");
    await expect(themeSelect).toHaveValue("dark");

    // Only the Sun & Moon skin remains (2026-10-15): it is always on.
    await expect(page.locator("html")).toHaveAttribute("data-skin", "sunmoon");



    await openSettingsTab(page, "agent");
    // settings.provider.change
    const providerSelect = page.locator('[data-action-id="settings.provider.change"]');
    const providerOptions = await providerSelect.locator("option").all();
    const secondOption = providerOptions[1];
    if (secondOption) {
      const idx1Val = await secondOption.getAttribute("value");
      if (idx1Val) {
        await providerSelect.selectOption(idx1Val);
        await expect(providerSelect).toHaveValue(idx1Val);
      }
    }

    // settings.claude-keepalive.change
    const keepaliveSelect = page.locator('[data-action-id="settings.claude-keepalive.change"]');
    await keepaliveSelect.selectOption("4");
    await expect(keepaliveSelect).toHaveValue("4");

    await openSettingsTab(page, "general");
    // settings.permission.change
    const permSelect = page.locator('[data-action-id="settings.permission.change"]');
    await permSelect.selectOption("trusted");
    await expect(permSelect).toHaveValue("trusted");

    await openSettingsTab(page, "appearance");
    // settings.terminal-font-size.change — persisted preference updates live.
    const fontSize = page.locator('[data-action-id="settings.terminal-font-size.change"]');
    await expect(fontSize).toHaveValue("16");
    await fontSize.fill("18");
    await expect(fontSize).toHaveValue("18");
    // Scope to this control's own wrapper: the panel has three range controls
    // (font size plus TTS rate/volume), so a bare selector is ambiguous.
    await expect(
      page
        .locator(".settings-range-control", {
          has: page.locator('[data-action-id="settings.terminal-font-size.change"]'),
        })
        .locator("output"),
    ).toHaveText("18px");

    // DOM code blocks and PTY/xterm palettes are independently selectable.
    const codeTheme = page.locator('[data-action-id="settings.code-theme.change"]');
    await codeTheme.selectOption("solarized-light");
    await expect(codeTheme).toHaveValue("solarized-light");
    await expect(page.locator("html")).toHaveAttribute("data-code-theme", "solarized-light");
    const codePreview = page.locator(".settings-code-theme-preview");
    await expect(codePreview.locator(".hljs-keyword")).toBeVisible();
    await expect(codePreview.locator(".hljs-string")).toBeVisible();
    const terminalTheme = page.locator('[data-action-id="settings.terminal-theme.change"]');
    await terminalTheme.selectOption("github-light");
    await expect(terminalTheme).toHaveValue("github-light");

    await openSettingsTab(page, "agent");
    // settings.proxy.change
    const proxyInput = page.locator('[data-action-id="settings.proxy.change"]');
    await proxyInput.fill("http://127.0.0.1:8787");
    await expect(proxyInput).toHaveValue("http://127.0.0.1:8787");

    await openSettingsTab(page, "security");
    // settings.agent-api.toggle (new-install default is ON)
    const agentApiToggle = page.locator('[data-action-id="settings.agent-api.toggle"]');
    await expect(agentApiToggle).toHaveAttribute("aria-pressed", "true");
    await agentApiToggle.click();
    await expect(agentApiToggle).toHaveAttribute("aria-pressed", "false");
    await agentApiToggle.click();
    await expect(agentApiToggle).toHaveAttribute("aria-pressed", "true");

    // settings.agent-token.toggle (only renders after agent-api enabled)
    const tokenToggle = page.locator('[data-action-id="settings.agent-token.toggle"]');
    await expect(tokenToggle).toBeVisible();
    const tokenCode = page.locator('[data-action-id="settings.drawer.consume"] .token-row code');
    const beforeText = await tokenCode.textContent();
    await tokenToggle.click();
    await expect.poll(async () => await tokenCode.textContent(), { timeout: 5000 }).not.toBe(beforeText);

    await openSettingsTab(page, "browser");
    // Browser policy + superpower flags are persisted through the real
    // settings patch path. The allow-hosts branch must reveal its textarea.
    const browserMode = page.locator('[data-action-id="settings.browser-network.mode.change"]');
    await browserMode.selectOption("allow-hosts");
    await expect(browserMode).toHaveValue("allow-hosts");
    const browserHosts = page.locator('[data-action-id="settings.browser-network.hosts.change"]');
    await browserHosts.fill("example.com\nlocalhost");
    await expect(browserHosts).toHaveValue("example.com\nlocalhost");

    const browserP0 = page.locator('[data-action-id="settings.browser.superpowers-p0.toggle"]');
    const browserP1 = page.locator('[data-action-id="settings.browser.superpowers-p1.toggle"]');
    await expect(browserP0).toHaveAttribute("aria-pressed", "true");
    await browserP0.click();
    await expect(browserP0).toHaveAttribute("aria-pressed", "false");
    // P1 default is ON too: exercise the toggle off then back on.
    await expect(browserP1).toHaveAttribute("aria-pressed", "true");
    await browserP1.click();
    await expect(browserP1).toHaveAttribute("aria-pressed", "false");
    await browserP1.click();
    await expect(browserP1).toHaveAttribute("aria-pressed", "true");

    // Secret values cross IPC once, are cleared locally, and only an opaque
    // one-time handle is rendered back to the user.
    const browserSecret = page.locator('[data-action-id="settings.browser-secret.issue.value.change"]');
    await browserSecret.fill("ui-total-ephemeral-secret");
    await page.locator('[data-action-id="settings.browser-secret.issue.submit"]').click();
    await expect(browserSecret).toHaveValue("");
    await expect(page.locator('[data-action-id="settings.browser-secret.issue.handle"]')).toBeVisible();

    await openSettingsTab(page, "voice");
    // settings.voice.toggle (new-install default is ON; the language/STT block
    // below only renders while it stays enabled).
    const voiceToggle = page.locator('[data-action-id="settings.voice.toggle"]');
    await expect(voiceToggle).toHaveAttribute("aria-pressed", "true");
    await voiceToggle.click();
    await expect(voiceToggle).toHaveAttribute("aria-pressed", "false");
    await voiceToggle.click();
    await expect(voiceToggle).toHaveAttribute("aria-pressed", "true");

    // settings.voice-language.change (only renders after voice enabled)
    const voiceLangSelect = page.locator('[data-action-id="settings.voice-language.change"]');
    await expect(voiceLangSelect).toBeVisible();
    await voiceLangSelect.selectOption("en-US");
    await expect(voiceLangSelect).toHaveValue("en-US");
    const sttUrl = page.locator('[data-action-id="settings.voice-stt-url.change"]');
    await sttUrl.fill("http://127.0.0.1:8765/v1");
    await expect(sttUrl).toHaveValue("http://127.0.0.1:8765/v1");
    const sttModel = page.locator('[data-action-id="settings.voice-stt-model.change"]');
    await expect(sttModel).toBeVisible();
    await sttModel.fill("large-v3");
    await expect(sttModel).toHaveValue("large-v3");

    // API-key clear never exposes the value after the action, and streaming
    // dictation is independently feature-gated.
    const sttApiKey = page.locator('[data-action-id="settings.voice-stt-api-key.change"]');
    await sttApiKey.fill("ui-total-ephemeral-key");
    await page.locator('[data-action-id="settings.voice-stt-api-key.clear"]').click();
    await expect(sttApiKey).toHaveValue("");
    const streamingToggle = page.locator('[data-action-id="settings.voice-streaming.toggle"]');
    // Default is ON: flip off and back on to exercise the toggle.
    await expect(streamingToggle).toHaveAttribute("aria-pressed", "true");
    await streamingToggle.click();
    await expect(streamingToggle).toHaveAttribute("aria-pressed", "false");
    await streamingToggle.click();
    await expect(streamingToggle).toHaveAttribute("aria-pressed", "true");

    // settings.drawer.consume: interacting inside drawer did NOT close it
    await expect(drawer).toBeVisible();

    await openSettingsTab(page, "data");
    // settings.dashboard.select: dashboard section renders (li needs running terminals;
    // without terminals the empty placeholder shows — assert the section is present)
    await expect(page.locator(".terminal-dashboard")).toBeVisible();

    // settings.close
    await page.locator('[data-action-id="settings.close"]').click();
    await expect(drawer).toBeHidden();

    // settings.backdrop.dismiss: reopen, then dispatch mousedown on backdrop
    await page.locator('[data-action-id="topbar.settings.open"]').click();
    await expect(drawer).toBeVisible();
    await page.locator('[data-action-id="settings.backdrop.dismiss"]').dispatchEvent("mousedown");
    await expect(drawer).toBeHidden();
  } finally {
    await coterm.close();
  }
});

// Registry form (hot model registry stage 3). The save path goes through the
// real settings patch (renderer → IPC → main → SQLite), so the list round-trip
// below asserts persistence, not just local draft state. The stored authToken
// is never rendered back: editing a saved entry shows the masked preset row
// and the replace button instead of the password box.
// settings.custom-model.remove is destructive and deliberately not clicked.
test("settings custom model registry form renders and audits", async () => {
  const coterm = await launchCoterm();
  try {
    const { page } = coterm;

    await page.locator('[data-action-id="topbar.settings.open"]').click();
    const drawer = page.locator('[data-action-id="settings.drawer.consume"]');
    await expect(drawer).toBeVisible();

    await openSettingsTab(page, "agent");
    const block = page.locator(".settings-custom-models");
    await expect(block).toBeVisible();
    await expect(block.locator(".settings-custom-model-list .dashboard-empty")).toBeVisible();

    // settings.custom-model.add: empty registry mounts the create form.
    await page.locator('[data-action-id="settings.custom-model.add"]').click();
    const form = page.locator(".settings-custom-model-form");
    await expect(form).toBeVisible();

    // settings.custom-model.id.change
    const idInput = page.locator('[data-action-id="settings.custom-model.id.change"]');
    await idInput.fill("ui-total-model");
    await expect(idInput).toHaveValue("ui-total-model");

    // settings.custom-model.harness.change: codex toggling rewrites the visible
    // id's prefix live; switching back strips it again.
    const harnessSelect = page.locator('[data-action-id="settings.custom-model.harness.change"]');
    await harnessSelect.selectOption("codex");
    await expect(harnessSelect).toHaveValue("codex");
    await expect(idInput).toHaveValue("codex-ui-total-model");
    await harnessSelect.selectOption("claude");
    await expect(idInput).toHaveValue("ui-total-model");

    const labelInput = page.locator('[data-action-id="settings.custom-model.label.change"]');
    await labelInput.fill("UI Total Model");
    await expect(labelInput).toHaveValue("UI Total Model");
    const modelInput = page.locator('[data-action-id="settings.custom-model.model.change"]');
    await modelInput.fill("my-legacy-model");
    await expect(modelInput).toHaveValue("my-legacy-model");
    const baseUrlInput = page.locator('[data-action-id="settings.custom-model.base-url.change"]');
    await baseUrlInput.fill("http://127.0.0.1:8787");
    await expect(baseUrlInput).toHaveValue("http://127.0.0.1:8787");

    // settings.custom-model.auth-token.change (create path: plain password box)
    const tokenInput = page.locator('[data-action-id="settings.custom-model.auth-token.change"]');
    await tokenInput.fill("ui-total-token");
    await expect(tokenInput).toHaveValue("ui-total-token");

    // settings.custom-model.local.change: proxy → direct → proxy round-trip.
    const localSelect = page.locator('[data-action-id="settings.custom-model.local.change"]');
    await expect(localSelect).toHaveValue("proxy");
    await localSelect.selectOption("direct");
    await expect(localSelect).toHaveValue("direct");
    await localSelect.selectOption("proxy");
    await expect(localSelect).toHaveValue("proxy");

    const contextWindowInput = page.locator('[data-action-id="settings.custom-model.context-window.change"]');
    await contextWindowInput.fill("200000");
    await expect(contextWindowInput).toHaveValue("200000");
    const effortSelect = page.locator('[data-action-id="settings.custom-model.reasoning-effort.change"]');
    await effortSelect.selectOption("high");
    await expect(effortSelect).toHaveValue("high");

    // settings.custom-model.env.toggle: the advanced block starts folded.
    const envSection = page.locator(".settings-custom-model-env");
    await expect(envSection).toHaveCount(0);
    await page.locator('[data-action-id="settings.custom-model.env.toggle"]').click();
    await expect(envSection).toBeVisible();
    const envKeys = envSection.locator('[data-action-id="settings.custom-model.env-key.change"]');
    const envValues = envSection.locator('[data-action-id="settings.custom-model.env-value.change"]');

    // settings.custom-model.env.add appends a blank key/value pair.
    await page.locator('[data-action-id="settings.custom-model.env.add"]').click();
    await expect(envKeys).toHaveCount(1);
    await expect(envValues).toHaveCount(1);
    await envKeys.first().fill("UITOTAL_ENV_KEY");
    await expect(envKeys.first()).toHaveValue("UITOTAL_ENV_KEY");
    await envValues.first().fill("uitotal-env-value");
    await expect(envValues.first()).toHaveValue("uitotal-env-value");

    // A second pair keeps both rows addressable...
    await page.locator('[data-action-id="settings.custom-model.env.add"]').click();
    await expect(envKeys).toHaveCount(2);
    await envKeys.nth(1).fill("UITOTAL_SECOND_KEY");

    // ...and settings.custom-model.env.remove drops exactly the targeted row.
    await envSection.locator('[data-action-id="settings.custom-model.env.remove"]').first().click();
    await expect(envKeys).toHaveCount(1);
    await expect(envKeys.first()).toHaveValue("UITOTAL_SECOND_KEY");

    // settings.custom-model.save persists through the real settings patch and
    // closes the form: the message and the registry row both show the saved id.
    await page.locator('[data-action-id="settings.custom-model.save"]').click();
    const savedMessage = block.locator(".settings-message");
    await expect(savedMessage).toContainText("ui-total-model");
    const rows = block.locator(".settings-custom-model-row");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("ui-total-model");
    await expect(rows.first()).toContainText("UI Total Model");
    await expect(page.locator('[data-action-id="settings.custom-model.add"]')).toBeVisible();

    // settings.custom-model.edit reloads the stored entry into the form.
    await rows.first().locator('[data-action-id="settings.custom-model.edit"]').click();
    await expect(form).toBeVisible();
    await expect(idInput).toHaveValue("ui-total-model");
    await expect(labelInput).toHaveValue("UI Total Model");
    await expect(modelInput).toHaveValue("my-legacy-model");
    await expect(baseUrlInput).toHaveValue("http://127.0.0.1:8787");
    await expect(localSelect).toHaveValue("proxy");
    await expect(contextWindowInput).toHaveValue("200000");
    await expect(effortSelect).toHaveValue("high");
    // The env block refolds on edit; unhandled pairs survive the round-trip.
    await expect(envSection).toHaveCount(0);
    await page.locator('[data-action-id="settings.custom-model.env.toggle"]').click();
    await expect(envKeys).toHaveCount(1);
    await expect(envKeys.first()).toHaveValue("UITOTAL_SECOND_KEY");

    // settings.custom-model.auth-token.replace: a stored token renders masked
    // (never its value) and the replace button swaps in the password box.
    await expect(tokenInput).toHaveCount(0);
    const replaceButton = page.locator('[data-action-id="settings.custom-model.auth-token.replace"]');
    await expect(replaceButton).toBeVisible();
    await expect(form.locator(".token-row code")).toHaveText("••••••••");
    await replaceButton.click();
    await expect(tokenInput).toBeVisible();
    await tokenInput.fill("ui-total-token-2");
    await expect(tokenInput).toHaveValue("ui-total-token-2");

    // settings.custom-model.cancel discards the draft without touching the row.
    await page.locator('[data-action-id="settings.custom-model.cancel"]').click();
    await expect(page.locator('[data-action-id="settings.custom-model.add"]')).toBeVisible();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("ui-total-model");
  } finally {
    await coterm.close();
  }
});
