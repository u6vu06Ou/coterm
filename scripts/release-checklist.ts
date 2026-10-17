// scripts/release-checklist.ts — release 前體檢（僅讀，不改任何東西）
// 出處：工單 2 Task 3（Fable 5 設計）；git clean 事故後重建。
// 注意：C4 lint 債清零前，"verify green" 項預期 FAIL（見 docs/DEVELOPMENT.md §3），不算擋件。
import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CRITICAL_PINS,
  exactPinnedPackageNames,
  verifyDependencyPins,
  type InstalledVersions,
  type PackageJsonLike,
  type PackageLockLike,
} from "./lib/verify-dependency-pins";

const checks: Array<[string, () => boolean | string]> = [
  ["git clean", () => execSync("git status --porcelain").toString().trim() === "" || "working tree dirty"],
  ["verify green", () => { execSync("npm run verify", { stdio: "pipe" }); return true; }],
  ["secret scan", () => { execSync("npm run security:scan", { stdio: "pipe" }); return true; }],
  ["out/ fresh", () => {
    const out = statSync("out/main/index.js").mtimeMs;
    return out > Date.now() - 30 * 60_000 || "out/ 超過 30 分鐘未重建，先 npm run build";
  }],
  ["icon exists", () => existsSync("resources/icon.ico") || "resources/icon.ico missing"],
  // v1.5.11 事故防線：lockfile 被順手重排會把精確 pin（@xterm/xterm 的 IME 修復）
  // 退回範圍版，這裡機械核對 package.json ↔ lock ↔ node_modules，比對邏輯在
  // scripts/lib/verify-dependency-pins.ts（純函式）。
  ["dependency pins", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as PackageJsonLike;
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as PackageLockLike;
    const names = new Set([...exactPinnedPackageNames(pkg), ...Object.keys(CRITICAL_PINS)]);
    const installed: InstalledVersions = {};
    for (const name of names) {
      try {
        const meta = JSON.parse(readFileSync(join("node_modules", name, "package.json"), "utf8")) as { version?: string };
        installed[name] = meta.version ?? null;
      } catch {
        installed[name] = null;
      }
    }
    const result = verifyDependencyPins(pkg, lock, installed);
    return result.ok || result.problems.map((p) => p.message).join("；");
  }],
];

let failed = 0;
for (const [name, fn] of checks) {
  try {
    const r = fn();
    if (r === true) console.log(`PASS ${name}`);
    else { console.log(`FAIL ${name}: ${r}`); failed++; }
  } catch (e) { console.log(`FAIL ${name}: ${(e as Error).message.split("\n")[0]}`); failed++; }
}
process.exit(failed ? 1 : 0);
