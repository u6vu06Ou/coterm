import type { AppSettings, AppSettingsPatch } from "@shared/types";

// #60 P2: every settings write goes through the narrowest possible patch so a
// non-STT operation (theme toggle, font size, provider, onboarding) never
// carries voice/sttApiKey, and a stale client snapshot cannot clobber fields
// it did not intend to change.
export function themeTogglePatch(current: AppSettings["theme"]): AppSettingsPatch {
  return { theme: current === "light" ? "dark" : "light" };
}

export function terminalFontSizePatch(terminalFontSize: number): AppSettingsPatch {
  return { terminalFontSize };
}

export function onboardingCompletePatch(defaultWorkspacePath: string | null): AppSettingsPatch {
  return { onboardingCompleted: true, defaultShell: "pwsh", defaultWorkspacePath };
}
