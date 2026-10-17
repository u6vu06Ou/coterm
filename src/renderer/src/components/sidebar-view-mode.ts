export type SidebarViewMode = "all" | "open";

// 「僅顯示已開啟 session」is opt-in; the default stays the full folder view.
const STORAGE_KEY = "coterm.sidebar.viewMode";

export function readSidebarViewMode(): SidebarViewMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "open" ? "open" : "all";
    // A missing/corrupt key falls back to the original full-folder mode.
  } catch {
    return "all";
  }
}

export function writeSidebarViewMode(mode: SidebarViewMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Safari private mode throws on storage writes; the preference just
    // doesn't persist — the in-memory default still drives this session.
  }
}
