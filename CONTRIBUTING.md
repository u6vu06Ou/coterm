# Contributing to Coterm

感謝你考慮貢獻 Coterm！本檔說明如何設定開發環境、提交 PR、回報 bug。

## 開發環境

### 前置需求

- Node.js（建議 LTS 版；專案使用 Electron 42）
- npm
- Windows 10/11（Coterm 是 Windows-first 專案；conpty 與 NSIS 安裝器僅在 Windows 上完整支援）
- PowerShell 7（`pwsh`）作為預設 shell

### 安裝步驟

1. Clone 本倉庫。
2. `npm install`（postinstall 會自動跑 `electron-builder install-app-deps` 處理原生模組）。
3. `npm run dev` 啟動開發模式（`electron-vite dev`）。

### 驗證

開發過程的驗證層與命令詳見 `docs/DEVELOPMENT.md` §2。重點：

| 命令 | 用途 |
|------|------|
| `npm run verify` | lint + typecheck + test（每個 task 完成時跑） |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | `eslint .` |
| `npm run test` | `vitest run` |
| `npm run test:e2e` | build + Playwright |
| `npm run security:scan` | secret 掃描（release 前必跑） |

## Release 標準

完整 release 定義見 `docs/RELEASE.md`。三道門檻全綠才可發布，缺一不可：

1. **`npm run release:check` 全 PASS** — 五項檢查：`git clean` / `verify green` / `secret scan` / `out/ fresh` / `icon exists`，每一行印 `PASS`，exit 0。
2. **`npm run test:e2e` 綠** — `npm run build && playwright test` 全部通過，exit 0。
3. **打包安裝五步冒煙** — 見 `docs/RELEASE.md`，人工走完五步皆符合預期畫面。

版號採 semver，公開首發起點 `0.1.0`。發布 tag 格式 `v0.1.0`，GitHub Release 附 `release/Coterm-<version>-Setup.exe`。

## PR 要求

提交 PR 前請確認：

- **`npm run typecheck` 零錯**（`tsc --noEmit` 不產生任何錯誤）。
- **`npm run test` 全綠**（`vitest run` 全部通過）。
- **不新增 lint 錯誤**：改動過的檔案 `npm run lint` 0 error。專案仍有歷史 lint 債，你的改動不應增加既有錯誤數。
- 動到 main process 路由 / window 生命週期時，補跑 `npm run test:e2e`。
- release 前補跑 `npm run security:scan`。

### Commit 訊息風格

沿用現行風格：`fix(scope): 一句話` / `feat: ...`，中英文皆可。

## Bug 回報

回報 bug 請使用以下範本：

```
### 標題
一句話描述問題

### 重現步驟
1.
2.
3.

### 預期行為
（應該發生什麼）

### 實際行為
（實際發生了什麼）

### 平台
- OS：（例如 Windows 11 23H2）
- Coterm 版本：（例如 0.1.0，見 Settings 或 package.json）
- Shell：（例如 pwsh 7.4 / powershell 5.1 / cmd）
- 取得方式：（安裝版 / dev 模式 / web 端）

### 版本
- Node.js：
- Electron：

### 附件
- 截圖、log 檔路徑（<userData>/logs/coterm.log）、或最小重現專案
```
