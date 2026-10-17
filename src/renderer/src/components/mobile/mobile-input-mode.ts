export type MobileInputMode = "composer" | "direct";
export type MobileTapAction = "open-composer" | "focus-pty" | "none";

const STORAGE_KEY = "coterm.mobile.inputMode";

export function readMobileInputMode(): MobileInputMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "direct" ? "direct" : "composer";
  } catch {
    return "composer";
  }
}

export function writeMobileInputMode(mode: MobileInputMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Safari private mode throws on storage writes; the preference just
    // doesn't persist — the in-memory default still drives this session.
  }
}

export function resolveMobileTapAction(gesture: string, mode: MobileInputMode): MobileTapAction {
  if (gesture !== "open-composer") return "none";
  if (mode === "direct") return "focus-pty";
  return "open-composer";
}
