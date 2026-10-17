// scripts/lib/verify-dependency-pins.ts — dependency pin 核對（純函式，無 I/O）
// 背景（真實事故）：v1.5.11 重建 release 時 lockfile 被順手重排，@xterm/xterm
// 從 6.1.0-beta.302（issue #80 中文 IME 修復 pin）退回 ^6.0.0 → resolved 6.0.0，
// 修復靜默蒸發、上線後 IME 又壞。
// 本模組只收「已解析好的」package.json / package-lock.json / 實際安裝版本三份
// 物件，讀檔是呼叫端（scripts/release-checklist.ts）的責任，這裡才能單元測試。

export interface PackageJsonLike {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface LockPackageNode {
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface PackageLockLike {
  packages?: Record<string, LockPackageNode>;
}

/** name → node_modules/<name>/package.json 的 version；null = 該套件不在 node_modules；缺 key = 呼叫端沒提供，跳過該層 */
export type InstalledVersions = Record<string, string | null>;

export type PinProblemKind =
  | "manifest-spec-mismatch" // package.json pin 與 lock packages[""] 宣告不一致
  | "lock-entry-missing" // lock packages 裡找不到 node_modules/<name> 節點
  | "lock-version-downgrade" // lock 實際 resolved 版本 ≠ pin（本模組的核心防線）
  | "installed-missing" // node_modules 無此套件
  | "installed-version-mismatch" // 實裝版本 ≠ pin
  | "critical-pin-modified"; // CRITICAL_PINS 表內的 pin 被動過

export interface PinProblem {
  kind: PinProblemKind;
  name: string;
  /** 期待值（人讀） */
  expected: string;
  /** 實際值（人讀） */
  actual: string;
  /** 可直接印給使用者的一句話 */
  message: string;
}

export interface PinVerifyResult {
  ok: boolean;
  problems: PinProblem[];
}

// 出事過／不許被「順手重排」動掉的關鍵 pin。要新增保護就加一行（含原因註解）。
export const CRITICAL_PINS: Record<string, string> = {
  // issue #80：中文 IME composition 修復，只在 6.1.0-beta.x 線上；
  // v1.5.11 就是被重排退回 ^6.0.0 導致修復蒸發。
  "@xterm/xterm": "6.1.0-beta.302",
};

// file:/link:/git:/npm:/workspace:/https: 等協議形式一律不視為「精確版本 pin」
const VERSION_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * 判斷 spec 是否為「精確版本 pin」，是的話回傳版本號字串，否則回 null。
 * 規則（同任務定義）：不以 ^ ~ > < * 開頭，也不是 file:/link:/git 等協議形式。
 * 額外容許 npm 合法但少見的 "=1.2.3" 等號前綴（照樣算精確）。
 * dist-tag（"latest"、"beta"）不符合上述排除條件時會被當成 pin——
 * release 線上出現 tag 依賴本來就該被擋下來，這是故意的。
 */
export function exactPinnedVersion(spec: string): string | null {
  const s = spec.trim();
  if (s === "" || VERSION_SCHEME.test(s) || /^[\^~<>*]/.test(s)) return null;
  return s.replace(/^=+/, "");
}

/** package.json 的 dependencies + devDependencies 裡所有精確 pin（同名列一次）。 */
export function collectExactPins(
  pkg: PackageJsonLike,
): Array<{ name: string; spec: string; version: string }> {
  const seen = new Set<string>();
  const out: Array<{ name: string; spec: string; version: string }> = [];
  for (const group of [pkg.dependencies, pkg.devDependencies]) {
    if (!group) continue;
    for (const [name, rawSpec] of Object.entries(group)) {
      if (typeof rawSpec !== "string" || seen.has(name)) continue;
      const version = exactPinnedVersion(rawSpec);
      if (version !== null) {
        seen.add(name);
        out.push({ name, spec: rawSpec.trim(), version });
      }
    }
  }
  return out;
}

export function exactPinnedPackageNames(pkg: PackageJsonLike): string[] {
  return collectExactPins(pkg).map((p) => p.name);
}

/** 主核對：三層（package.json ↔ lock 宣告 ↔ lock resolved）＋可選 node_modules 層＋CRITICAL_PINS。 */
export function verifyDependencyPins(
  pkg: PackageJsonLike,
  lock: PackageLockLike,
  installed: InstalledVersions = {},
): PinVerifyResult {
  const problems: PinProblem[] = [];
  const push = (kind: PinProblemKind, name: string, expected: string, actual: string, message: string): void => {
    problems.push({ kind, name, expected, actual, message });
  };

  const lockPackages = lock.packages ?? {};
  const root = lockPackages[""] ?? {};
  // 本 repo 的 lockfile 曾被 Windows npm 寫出 "node_modules\abbrev" 反斜線 key，
  // 先把所有 key 正規化成正斜線再查，避免假性 lock-entry-missing。
  const normalizedNodes = new Map<string, LockPackageNode>();
  for (const [key, node] of Object.entries(lockPackages)) {
    if (key !== "") normalizedNodes.set(key.replace(/\\/g, "/"), node);
  }
  const declaredSpec = (name: string): string | undefined =>
    root.dependencies?.[name] ?? root.devDependencies?.[name];
  const checkInstalled = (name: string, version: string): void => {
    if (!Object.prototype.hasOwnProperty.call(installed, name)) return;
    const inst = installed[name];
    if (inst === null) {
      push("installed-missing", name, version, "（node_modules 無此套件）",
        `${name}: node_modules 找不到套件（pin=${version}），是不是 npm install 沒跑？`);
    } else if (typeof inst === "string" && inst !== version) {
      push("installed-version-mismatch", name, version, inst,
        `${name}: node_modules 實裝 "${inst}" 與 pin "${version}" 不符`);
    }
  };

  // ── 一般 pin 三層核對 ──
  for (const { name, spec, version } of collectExactPins(pkg)) {
    const declared = declaredSpec(name);
    if (declared === undefined) {
      push("manifest-spec-mismatch", name, spec, "（lock 未宣告）",
        `${name}: package.json pin 是 "${spec}"，但 package-lock packages[""] 沒有對應宣告`);
    } else if (declared.trim() !== spec) {
      push("manifest-spec-mismatch", name, spec, declared.trim(),
        `${name}: package.json pin "${spec}" 與 package-lock 宣告 "${declared.trim()}" 不一致（v1.5.11 事故型：lock 被重排）`);
    }
    const node = normalizedNodes.get(`node_modules/${name}`);
    if (!node || typeof node.version !== "string") {
      push("lock-entry-missing", name, version, node?.version ?? "（無 node_modules 節點）",
        `${name}: lockfile 找不到 node_modules/${name} 節點（pin=${version}）`);
    } else if (node.version !== version) {
      push("lock-version-downgrade", name, version, node.version,
        `${name}: lockfile 實際 resolved "${node.version}" 不等於 pin "${version}"——降版會讓修復靜默蒸發`);
    }
    checkInstalled(name, version);
  }

  // ── CRITICAL_PINS：即使 pin 被改成範圍（一般層會整包跳過）也要抓到 ──
  for (const [name, critical] of Object.entries(CRITICAL_PINS)) {
    const pkgSpec = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
    if (pkgSpec === undefined || pkgSpec.trim() !== critical) {
      push("critical-pin-modified", name, critical,
        pkgSpec === undefined ? "（package.json 無此依賴）" : `"${pkgSpec.trim()}"`,
        `${name}: CRITICAL pin 應為 package.json 精確寫死 "${critical}"，實際 ${
          pkgSpec === undefined ? "依賴消失" : `是 "${pkgSpec.trim()}"`
        }（這個版本載過修復，動它 = 修復蒸發）`);
      continue; // manifest 層已歪，後面兩層比了也只是噪音
    }
    const declared = declaredSpec(name);
    if (declared === undefined || declared.trim() !== critical) {
      push("critical-pin-modified", name, critical,
        declared === undefined ? "（lock 未宣告）" : `"${declared.trim()}"`,
        `${name}: CRITICAL pin 的 lock 宣告應為 "${critical}"，實際 ${
          declared === undefined ? "未宣告" : `"${declared.trim()}"`
        }`);
    }
    const node = normalizedNodes.get(`node_modules/${name}`);
    if (!node || node.version !== critical) {
      push("critical-pin-modified", name, critical, node?.version ?? "（無節點）",
        `${name}: CRITICAL pin 的 lock resolved 應為 "${critical}"，實際 "${node?.version ?? "無節點"}"`);
    }
    if (Object.prototype.hasOwnProperty.call(installed, name) && installed[name] !== critical) {
      push("critical-pin-modified", name, critical,
        installed[name] === null ? "（未安裝）" : `"${installed[name]}"`,
        `${name}: CRITICAL pin 的 node_modules 實裝應為 "${critical}"，實際 ${
          installed[name] === null ? "未安裝" : `"${installed[name]}"`
        }`);
    }
  }

  return { ok: problems.length === 0, problems };
}
