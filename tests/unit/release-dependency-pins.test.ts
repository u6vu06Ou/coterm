import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CRITICAL_PINS,
  collectExactPins,
  exactPinnedVersion,
  verifyDependencyPins,
  type InstalledVersions,
  type PackageJsonLike,
  type PackageLockLike,
} from "../../scripts/lib/verify-dependency-pins";

// v1.5.11 事故：lockfile 重排把 @xterm/xterm 從 6.1.0-beta.302 pin 退回
// ^6.0.0 → 6.0.0，issue #80 中文 IME 修復靜默蒸發。這份測試鎖住防線行為。

// noUncheckedIndexedAccess 下不要直接標記索引取值；pin 值在此攤平，並由下方
// 測試斷言 CRITICAL_PINS 表本身沒被改。
const PIN = "6.1.0-beta.302";

function makePkg(xtermSpec: string): PackageJsonLike {
  return {
    dependencies: { "@xterm/xterm": xtermSpec, react: "^19.2.7" },
    devDependencies: { playwright: "1.61.0", vitest: "~4.1.9", local: "file:../local" },
  };
}

function makeLock(declaredXterm: string, resolvedXterm: string): PackageLockLike {
  return {
    packages: {
      "": {
        dependencies: { "@xterm/xterm": declaredXterm, react: "^19.2.7" },
        devDependencies: { playwright: "1.61.0", vitest: "~4.1.9", local: "file:../local" },
      },
      "node_modules/@xterm/xterm": { version: resolvedXterm },
      "node_modules/playwright": { version: "1.61.0" },
      // 本 repo lockfile 的 Windows npm 曾寫出反斜線 key，偵測不可假性 miss
      "node_modules\\react": { version: "19.2.7" },
    },
  };
}

const INSTALLED_OK: InstalledVersions = {
  "@xterm/xterm": PIN,
  playwright: "1.61.0",
};

const okResult = () => verifyDependencyPins(makePkg(PIN), makeLock(PIN, PIN), INSTALLED_OK);

describe("verify-dependency-pins", () => {
  it("CRITICAL_PINS 表本身至少含 @xterm/xterm = 6.1.0-beta.302（issue #80）", () => {
    // 表被改 = 防線被拆；這裡直接鎖值
    const entries = Object.entries(CRITICAL_PINS).find(([name]) => name === "@xterm/xterm");
    expect(entries).toEqual(["@xterm/xterm", PIN]);
  });

  it("全部一致 → ok，零 problems", () => {
    const r = okResult();
    expect(r.problems, JSON.stringify(r.problems.map((p) => p.message))).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("package.json pin 與 lock 宣告不符 → 抓到 manifest-spec-mismatch", () => {
    // v1.5.11 事故第一步：lock 宣告被改成 ^6.0.0
    const r = verifyDependencyPins(makePkg(PIN), makeLock("^6.0.0", PIN), INSTALLED_OK);
    expect(r.ok).toBe(false);
    const p = r.problems.find((x) => x.kind === "manifest-spec-mismatch" && x.name === "@xterm/xterm");
    expect(p, JSON.stringify(r.problems.map((x) => x.message))).toBeDefined();
    expect(p!.expected).toBe(PIN);
    expect(p!.actual).toBe("^6.0.0");
    expect(p!.message).toContain(PIN);
  });

  it("lock 實際 resolved 版本被降版 → 抓到 lock-version-downgrade", () => {
    // 宣告仍是 pin 字串，但 node 節點被重排成 6.0.0
    const r = verifyDependencyPins(makePkg(PIN), makeLock(PIN, "6.0.0"), INSTALLED_OK);
    expect(r.ok).toBe(false);
    const p = r.problems.find((x) => x.kind === "lock-version-downgrade" && x.name === "@xterm/xterm");
    expect(p, JSON.stringify(r.problems.map((x) => x.message))).toBeDefined();
    expect(p!.actual).toBe("6.0.0");
  });

  it("CRITICAL_PINS 被改掉（pin 變範圍）→ 抓到 critical-pin-modified", () => {
    // 最陰險的型態：pin 整個被改成 ^6.0.0，一般層會把它當「非 pin」整包跳過
    const pkg = makePkg("^6.0.0");
    const lock = makeLock("^6.0.0", "6.0.0");
    const r = verifyDependencyPins(pkg, lock, { "@xterm/xterm": "6.0.0", playwright: "1.61.0" });
    expect(r.ok).toBe(false);
    const p = r.problems.find((x) => x.kind === "critical-pin-modified" && x.name === "@xterm/xterm");
    expect(p, JSON.stringify(r.problems.map((x) => x.message))).toBeDefined();
    expect(p!.expected).toBe(PIN);
    expect(p!.actual).toBe('"^6.0.0"');
  });

  it("CRITICAL_PINS 實裝版本被換 → 抓到（installed 層）", () => {
    const r = verifyDependencyPins(makePkg(PIN), makeLock(PIN, PIN), {
      "@xterm/xterm": "6.0.0",
      playwright: "1.61.0",
    });
    expect(
      r.problems.filter((x) => x.kind === "critical-pin-modified" && x.name === "@xterm/xterm"),
    ).not.toEqual([]);
  });

  it("^ / ~ / file: 範圍與協議形式不視為 pin，不誤報", () => {
    // react ^19.2.7、vitest ~4.1.9、local file:../local 全都不該進 pin 清單，
    // 即使 lock 裡故意沒有它們的 node 節點對應也不該叫
    const pins = collectExactPins(makePkg(PIN)).map((p) => p.name).sort();
    expect(pins).toEqual(["@xterm/xterm", "playwright"]);
    expect(exactPinnedVersion("^6.0.0")).toBeNull();
    expect(exactPinnedVersion("~4.1.9")).toBeNull();
    expect(exactPinnedVersion(">=1.0.0")).toBeNull();
    expect(exactPinnedVersion("*")).toBeNull();
    expect(exactPinnedVersion("file:../x")).toBeNull();
    expect(exactPinnedVersion("link:../x")).toBeNull();
    expect(exactPinnedVersion("git+ssh://x.git")).toBeNull();
    expect(exactPinnedVersion("npm:other@1.0.0")).toBeNull();
    expect(exactPinnedVersion("workspace:*")).toBeNull();
    expect(exactPinnedVersion("6.1.0-beta.302")).toBe("6.1.0-beta.302");
    expect(exactPinnedVersion("=1.2.3")).toBe("1.2.3");
  });

  it("lock key 是反斜線（Windows npm 寫出的）也能查到節點", () => {
    // makeLock 裡 react 的 key 是 node_modules\react；若正規化壞掉會誤報 missing。
    // react 非 pin，改用正斜線 pin 套件做反斜線變體直接驗 normalized 查表：
    const lock = makeLock(PIN, PIN);
    lock.packages!["node_modules\\playwright"] = { version: "1.61.0" };
    delete lock.packages!["node_modules/playwright"];
    expect(verifyDependencyPins(makePkg(PIN), lock, INSTALLED_OK).ok).toBe(true);
  });

  it("node_modules 套件缺失 / 實裝版本不符（一般 pin 層）", () => {
    const missing = verifyDependencyPins(makePkg(PIN), makeLock(PIN, PIN), {
      "@xterm/xterm": PIN,
      playwright: null,
    });
    expect(missing.problems.some((p) => p.kind === "installed-missing" && p.name === "playwright")).toBe(true);
    const drift = verifyDependencyPins(makePkg(PIN), makeLock(PIN, PIN), {
      "@xterm/xterm": PIN,
      playwright: "1.60.0",
    });
    expect(drift.problems.some((p) => p.kind === "installed-version-mismatch" && p.name === "playwright")).toBe(true);
  });

  it("實機迴歸守門：目前 repo 的 package.json ↔ lock 的 @xterm/xterm pin 一致", () => {
    const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as PackageJsonLike;
    const lock = JSON.parse(readFileSync(resolve("package-lock.json"), "utf8")) as PackageLockLike;
    const installed: InstalledVersions = {};
    try {
      installed["@xterm/xterm"] = (
        JSON.parse(readFileSync(resolve("node_modules/@xterm/xterm/package.json"), "utf8")) as { version?: string }
      ).version ?? null;
    } catch {
      // CI 若無 node_modules 就只驗 manifest↔lock 兩層
    }
    const r = verifyDependencyPins(pkg, lock, installed);
    expect(r.ok, JSON.stringify(r.problems.map((p) => p.message))).toBe(true);
  });
});
