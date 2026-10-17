import { describe, expect, it, vi } from "vitest";
import { resolveTerminalTheme } from "../../src/renderer/src/components/terminal-themes";
import { sunTimes } from "../../src/renderer/src/components/sun-times";
import {
  filterPulseEntries,
  formatBytes,
  formatGrowthDelta,
  nextPulseSortDirection,
  pulseSortArrow,
  readPulseSortPrefs,
  sortPulseEntries,
  writePulseSortPrefs,
} from "../../src/renderer/src/components/pulse-format";
import type { PulseSortEntry } from "../../src/renderer/src/components/pulse-format";

describe("pulse panel formatting", () => {
  it("formats byte sizes human readable", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(340 * 1024)).toBe("340 KB");
    // Sub-ten values keep two decimals (1.2e9 bytes → 1.20 GB).
    expect(formatBytes(1.2 * 1024 ** 3)).toBe("1.20 GB");
    expect(formatBytes(300)).toBe("300 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });

  it("shows the session growth delta: positive, never negative, created files count whole size", () => {
    // Modified files: delta over the first-sight baseline.
    expect(formatGrowthDelta({ baselineSize: 1024, size: 1024 + 340 * 1024 })).toBe("+340 KB");
    expect(formatGrowthDelta({ baselineSize: 500, size: 500 })).toBe("");
    // Shrunk files do not show a negative; they just show nothing.
    expect(formatGrowthDelta({ baselineSize: 500, size: 300 })).toBe("");
    // Created files: baseline 0, so the whole size is growth.
    expect(formatGrowthDelta({ baselineSize: 0, size: 300 })).toBe("+300 B");
  });
});

describe("pulse file-list sort/filter", () => {
  type TestFile = PulseSortEntry & { id: string };
  const file = (
    id: string,
    size: number,
    baselineSize: number,
    mtimeMs: number,
    kind: "created" | "modified" = "modified",
  ): TestFile => ({ id, size, baselineSize, mtimeMs, kind });
  const ids = (rows: TestFile[]): string[] => rows.map((entry) => entry.id);

  it("sorts by every key in both directions", () => {
    const rows = [
      file("a", 4096, 1024, 300),
      file("b", 512, 0, 100, "created"),
      file("c", 2048, 2048, 200),
    ];
    // 大小: desc＝大→小 (default), asc＝小→大.
    expect(ids(sortPulseEntries(rows, "size", "desc"))).toEqual(["a", "c", "b"]);
    expect(ids(sortPulseEntries(rows, "size", "asc"))).toEqual(["b", "c", "a"]);
    // 成長: delta = size − baselineSize (created files count the whole size).
    expect(ids(sortPulseEntries(rows, "growth", "desc"))).toEqual(["a", "b", "c"]);
    expect(ids(sortPulseEntries(rows, "growth", "asc"))).toEqual(["c", "b", "a"]);
    // 時間: desc＝新→舊, asc＝舊→新.
    expect(ids(sortPulseEntries(rows, "time", "desc"))).toEqual(["a", "c", "b"]);
    expect(ids(sortPulseEntries(rows, "time", "asc"))).toEqual(["b", "c", "a"]);
  });

  it("keeps ties stable in both directions (input order wins)", () => {
    const rows = [
      file("first", 1000, 500, 100),
      file("second", 1000, 500, 100),
      file("third", 900, 900, 50),
    ];
    expect(ids(sortPulseEntries(rows, "size", "desc"))).toEqual(["first", "second", "third"]);
    // The bigger row leads ascending; the tied pair keeps input order.
    expect(ids(sortPulseEntries(rows, "size", "asc"))).toEqual(["third", "first", "second"]);
  });

  it("filters 全部/新增/修改 and never mutates the input", () => {
    const rows = [file("created", 100, 0, 100, "created"), file("modified", 100, 90, 100)];
    expect(ids(filterPulseEntries(rows, "all"))).toEqual(["created", "modified"]);
    expect(ids(filterPulseEntries(rows, "created"))).toEqual(["created"]);
    expect(ids(filterPulseEntries(rows, "modified"))).toEqual(["modified"]);
    expect(rows).toHaveLength(2);
  });

  it("flips direction on the same key, resets to descending on a new key", () => {
    expect(nextPulseSortDirection("size", "size", "desc")).toBe("asc");
    expect(nextPulseSortDirection("size", "size", "asc")).toBe("desc");
    expect(nextPulseSortDirection("size", "growth", "asc")).toBe("desc");
    expect(nextPulseSortDirection("time", "growth", "asc")).toBe("desc");
    expect(pulseSortArrow("desc")).toBe("↓");
    expect(pulseSortArrow("asc")).toBe("↑");
  });

  it("persists prefs; missing/corrupt localStorage falls back per field", () => {
    // Back to the plain node test env (no working localStorage): the write
    // must not throw and the read returns the defaults.
    writePulseSortPrefs({ key: "growth", direction: "asc", filter: "modified" });
    expect(readPulseSortPrefs()).toEqual({ key: "size", direction: "desc", filter: "all" });

    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    });
    try {
      writePulseSortPrefs({ key: "time", direction: "asc", filter: "created" });
      expect(readPulseSortPrefs()).toEqual({ key: "time", direction: "asc", filter: "created" });
      // Corrupt JSON falls back entirely.
      store.set("coterm.sidebar.pulse.sort", "{bogus");
      expect(readPulseSortPrefs()).toEqual({ key: "size", direction: "desc", filter: "all" });
      // One garbled field never loses the two valid ones.
      store.set(
        "coterm.sidebar.pulse.sort",
        JSON.stringify({ key: "growth", direction: "weird", filter: "created" }),
      );
      expect(readPulseSortPrefs()).toEqual({ key: "growth", direction: "desc", filter: "created" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("sun & moon skin", () => {
  it("maps auto terminal colours to the sun/moon palettes (sunmoon is the only skin)", () => {
    expect(resolveTerminalTheme("auto", "light").id).toBe("coterm-sun");
    expect(resolveTerminalTheme("auto", "dark").id).toBe("coterm-moon");
    // An explicit user choice always wins.
    expect(resolveTerminalTheme("dracula", "light").id).toBe("dracula");
  });

  it("marks submitted lines in scrollback only on the sun palette", () => {
    const luminance = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const contrast = (a: string, b: string): number => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    const sun = resolveTerminalTheme("auto", "light");
    expect(sun.typedLine).toMatch(/^#[0-9a-f]{6}$/);
    // Pale apricot wash (2026-10-03: the old orange+white bar was too loud).
    // Visible against the paper, but light enough that the normal dark text
    // keeps its own ANSI colour and stays well above 4.5:1.
    const typedVsPaper = contrast(sun.typedLine!, "#f3ebdc");
    expect(typedVsPaper).toBeGreaterThan(1.15);
    expect(typedVsPaper).toBeLessThan(1.6);
    expect(contrast(sun.palette.foreground!, sun.typedLine!)).toBeGreaterThanOrEqual(4.5);
    // The mark is sun-only: moon scrollback keeps its plain background.
    expect(resolveTerminalTheme("auto", "dark").typedLine).toBeUndefined();
  });

  it("gives selection a visible highlight on both sun and moon palettes", () => {
    const luminance = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const contrast = (a: string, b: string): number => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    // xterm turns an OPAQUE selectionBackground into 30% alpha and then blends
    // it over the page colour — model exactly what is drawn, not the raw hex.
    const drawn = (selection: string, page: string): string => {
      const alpha = selection.length === 9 ? parseInt(selection.slice(7, 9), 16) / 255 : 0.3;
      const channel = (hex: string, i: number): number => parseInt(hex.slice(i, i + 2), 16);
      return `#${[1, 3, 5].map((i) => Math.round(channel(selection, i) * alpha + channel(page, i) * (1 - alpha))
        .toString(16).padStart(2, "0")).join("")}`;
    };
    const cases: Array<{ appTheme: "light" | "dark"; gradient: string; foreground: string; selMin: number }> = [
      // Old sun selection (#e6cdb4 on paper) was 1.3:1 — invisible.
      { appTheme: "light", gradient: "#f3ebdc", foreground: "#2b2420", selMin: 1.8 },
      // Old moon selection (#3a4256 on charcoal) was 1.4:1 — barely there.
      { appTheme: "dark", gradient: "#262a32", foreground: "#dcdcea", selMin: 1.6 },
    ];
    for (const { appTheme, gradient, foreground, selMin } of cases) {
      const theme = resolveTerminalTheme("auto", appTheme);
      expect(theme.transparentBackground).toBe(true);
      expect(theme.palette.background).toMatch(/^#[0-9a-f]{6}00$/);
      // Opaque colours get silently cut to 30% — always ship an explicit alpha.
      expect(theme.palette.selectionBackground).toMatch(/^#[0-9a-f]{8}$/);
      const selected = drawn(theme.palette.selectionBackground!, gradient);
      const active = contrast(selected, gradient);
      expect(active).toBeGreaterThanOrEqual(selMin);
      // Selected text stays readable against the selection background.
      expect(contrast(foreground, selected)).toBeGreaterThanOrEqual(4.5);
      // Inactive (unfocused window) is a dimmer tint, still distinct from the page.
      const inactive = contrast(drawn(theme.palette.selectionInactiveBackground!, gradient), gradient);
      expect(inactive).toBeGreaterThan(1.25);
      expect(inactive).toBeLessThan(active);
    }
  });

  it("computes Taipei sunrise/sunset within a few minutes", () => {
    // 2026-10-01 Taipei: sunrise ~05:46, sunset ~17:43 (UTC+8).
    const { rise, set } = sunTimes(new Date("2026-10-01T12:00:00+08:00"), 25.03, 121.56);
    const offsetFix = new Date("2026-10-01T12:00:00+08:00").getTimezoneOffset() + 480;
    expect(Math.abs(rise + offsetFix - (5 * 60 + 46))).toBeLessThanOrEqual(4);
    expect(Math.abs(set + offsetFix - (17 * 60 + 43))).toBeLessThanOrEqual(4);
  });
});

describe("echoed user rows (agent TUIs)", () => {
  it("never treats an agent table or unwrapped answer as input continuation", async () => {
    const { findEchoedUserRows } = await import("../../src/renderer/src/components/terminal-typed-line");
    expect(findEchoedUserRows(["❯ 比較資料", "  ┌────┐", "  │ agent output │", "  └────┘"])).toEqual([0]);
    expect(findEchoedUserRows(["❯ 第一行", "  真正軟換行", "  agent answer"], -1, [false, true, false])).toEqual([0, 1]);
  });
  it("marks sent messages but not the live input box", async () => {
    const { findEchoedUserRows } = await import("../../src/renderer/src/components/terminal-typed-line");
    const rows = [
      "❯ 第一句訊息",
      "  第二行接續",
      "",
      "● 回覆",
      "────────────────────",
      "❯ ",
    ];
    expect(findEchoedUserRows(rows)).toEqual([0, 1]);
    expect(findEchoedUserRows(["────────────", "❯ 打字中"])).toEqual([]);
  });

  it("skips Codex's composer (no rule above it) when the cursor sits in it", async () => {
    const { findEchoedUserRows } = await import("../../src/renderer/src/components/terminal-typed-line");
    const rows = ["› 修好登入", "", "• 已修好", "", "› Ask Codex to do anything", "", "  my-kimi high · Context 0% used"];
    expect(findEchoedUserRows(rows, 4)).toEqual([0]);
    expect(findEchoedUserRows(rows)).toEqual([0, 4]);
  });
});

describe("shell executable titles", () => {
  it("turns pwsh's exe-path window title into the bare program name", async () => {
    const { shellExecutableName, resolveDisplayTitle } = await import("../../src/renderer/src/components/terminal-display-title");
    expect(shellExecutableName("C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\\pwsh.exe")).toBe("pwsh");
    expect(shellExecutableName("C:\\WINDOWS\\system32\\cmd.exe")).toBe("cmd");
    expect(shellExecutableName("修好登入流程")).toBeNull();
    expect(shellExecutableName("D:\\Coterm")).toBeNull();
    expect(resolveDisplayTitle(
      { isAgent: true, profile: "pwsh", cwd: "D:\\Coterm", title: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", agentSummaryTitle: null },
      null,
    )).toBeNull();
  });
});
