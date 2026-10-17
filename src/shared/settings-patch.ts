import type { AppSettings, AppSettingsPatch } from "./schema";

// #60 deep-merge for settings patches. Contract (from the v1.5 work order):
// - absent / undefined field: keep the current value
// - explicit "" / false / null / []: overwrite (clear)
// - nested objects: deep merge
// - arrays: replace wholesale, never concat
export function mergeAppSettingsPatch(base: AppSettings, patch: AppSettingsPatch): AppSettings {
  const merged: AppSettings = { ...base };
  if (patch.theme !== undefined) merged.theme = patch.theme;
  if (patch.readingPreset !== undefined) merged.readingPreset = patch.readingPreset;
  if (patch.codeTheme !== undefined) merged.codeTheme = patch.codeTheme;
  if (patch.terminalTheme !== undefined) merged.terminalTheme = patch.terminalTheme;
  if (patch.locale !== undefined) merged.locale = patch.locale;
  if (patch.defaultProvider !== undefined) merged.defaultProvider = patch.defaultProvider;
  if (patch.defaultShell !== undefined) merged.defaultShell = patch.defaultShell;
  if (patch.terminalFontSize !== undefined) merged.terminalFontSize = patch.terminalFontSize;
  if (patch.terminalFont !== undefined) merged.terminalFont = patch.terminalFont;
  if (patch.claudeKeepaliveHours !== undefined) merged.claudeKeepaliveHours = patch.claudeKeepaliveHours;
  if (patch.proxyUrl !== undefined) merged.proxyUrl = patch.proxyUrl;
  // Hot model registry (stage 1): customProfiles is a record the Settings UI
  // edits as a whole table — replace wholesale, same contract as arrays.
  if (patch.customProfiles !== undefined) merged.customProfiles = patch.customProfiles;
  if (patch.permissionPreset !== undefined) merged.permissionPreset = patch.permissionPreset;
  if (patch.onboardingCompleted !== undefined) merged.onboardingCompleted = patch.onboardingCompleted;
  if (patch.defaultWorkspacePath !== undefined) merged.defaultWorkspacePath = patch.defaultWorkspacePath;
  if (patch.telemetry !== undefined) merged.telemetry = patch.telemetry;
  if (patch.searchIndexEnabled !== undefined) merged.searchIndexEnabled = patch.searchIndexEnabled;
  if (patch.agentDoneToast !== undefined) merged.agentDoneToast = patch.agentDoneToast;
  if (patch.agentApi !== undefined) {
    merged.agentApi = {
      enabled: patch.agentApi.enabled ?? base.agentApi.enabled,
      token: patch.agentApi.token ?? base.agentApi.token,
      // Issue #93: a patch carrying only one of the two buckets must not reset
      // the other back to the default — keep the base value per field.
      rateLimit: {
        terminalPerMinute: patch.agentApi.rateLimit?.terminalPerMinute ?? base.agentApi.rateLimit.terminalPerMinute,
        browserPerMinute: patch.agentApi.rateLimit?.browserPerMinute ?? base.agentApi.rateLimit.browserPerMinute,
      },
    };
  }
  if (patch.retention !== undefined) {
    merged.retention = {
      days: patch.retention.days ?? base.retention.days,
      pruneOnStart: patch.retention.pruneOnStart ?? base.retention.pruneOnStart,
    };
  }
  if (patch.browserNetwork !== undefined) {
    merged.browserNetwork = {
      mode: patch.browserNetwork.mode ?? base.browserNetwork.mode,
      allowHosts: patch.browserNetwork.allowHosts ?? base.browserNetwork.allowHosts,
    };
  }
  if (patch.browserApproval !== undefined) {
    merged.browserApproval = {
      mode: patch.browserApproval.mode ?? base.browserApproval.mode,
    };
  }
  if (patch.browser !== undefined) {
    merged.browser = {
      superpowersP0: patch.browser.superpowersP0 ?? base.browser.superpowersP0,
      superpowersP1: patch.browser.superpowersP1 ?? base.browser.superpowersP1,
    };
  }
  if (patch.voice !== undefined) {
    merged.voice = {
      enabled: patch.voice.enabled ?? base.voice.enabled,
      lang: patch.voice.lang ?? base.voice.lang,
      sttLanguageMode: patch.voice.sttLanguageMode ?? base.voice.sttLanguageMode,
      responseLanguage: patch.voice.responseLanguage ?? base.voice.responseLanguage,
      sttUrl: patch.voice.sttUrl ?? base.voice.sttUrl,
      sttModel: patch.voice.sttModel ?? base.voice.sttModel,
      sttApiKey: patch.voice.sttApiKey ?? base.voice.sttApiKey,
      streamingDictation: patch.voice.streamingDictation ?? base.voice.streamingDictation,
      live: patch.voice.live === undefined ? base.voice.live : {
        enabled: patch.voice.live.enabled ?? base.voice.live.enabled,
        provider: patch.voice.live.provider ?? base.voice.live.provider,
        serverUrl: patch.voice.live.serverUrl ?? base.voice.live.serverUrl,
        apiKey: patch.voice.live.apiKey ?? base.voice.live.apiKey,
        apiSecret: patch.voice.live.apiSecret ?? base.voice.live.apiSecret,
        ttsVoice: patch.voice.live.ttsVoice ?? base.voice.live.ttsVoice,
        geminiApiKey: patch.voice.live.geminiApiKey ?? base.voice.live.geminiApiKey,
        geminiModel: patch.voice.live.geminiModel ?? base.voice.live.geminiModel,
      },
    };
  }
  if (patch.jev !== undefined) {
    merged.jev = {
      enabled: patch.jev.enabled ?? base.jev.enabled,
      apiKey: patch.jev.apiKey ?? base.jev.apiKey,
    };
  }
  if (patch.checkpoint !== undefined) {
    merged.checkpoint = {
      topbarButton: patch.checkpoint.topbarButton ?? base.checkpoint.topbarButton,
    };
  }
  if (patch.readingMode !== undefined) {
    merged.readingMode = {
      topbarButton: patch.readingMode.topbarButton ?? base.readingMode.topbarButton,
    };
  }
  if (patch.agentapi !== undefined) {
    merged.agentapi = {
      voiceAgent: patch.agentapi.voiceAgent ?? base.agentapi.voiceAgent,
    };
  }
  if (patch.agentBrowserWindow !== undefined) merged.agentBrowserWindow = patch.agentBrowserWindow;
  if (patch.agentBrowserFullAccess !== undefined) merged.agentBrowserFullAccess = patch.agentBrowserFullAccess;
  return merged;
}
