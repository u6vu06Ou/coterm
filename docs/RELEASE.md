# Coterm Release 契約

本檔定義公開 release 的機器閘門與人工證據。版本唯一真相是
`package.json.version`；以下以 `<package-version>` 表示該值，不在文件寫死目前版號。

## Branch、tag 與產物

- 發布分支：`master`。
- tag：`v<package-version>`。
- Windows installer：`release/Coterm-<package-version>-Setup.exe`。
- GitHub Release 必須附上與 `package.json.version` 相同版本的 installer。

## 機器閘門

以下命令全部 exit 0 才可發布，不得降低 coverage、skip job 或用
`continue-on-error` 製造綠燈：

```powershell
npm run ci:quality
npm run test:ui:total:strict
npm run ci:bdd
npm run test:packaged
npm run release:check
```

`sync-and-ship.bat` 會在本機依序執行 quality、UI、BDD 與 packaged smoke gate；任何一項
失敗都不得發布。GitHub Actions 僅保留作為 PR／手動 `workflow_dispatch` 的診斷備援，
不由 push、release 或 `/ship` 自動觸發，也不阻擋發布。

## 人工 smoke

每次發布都建立一份帶日期、commit SHA 與 tester 的證據，至少覆蓋：

1. Desktop：安裝／啟動／關閉、建立 PTY、輸入與輸出正常。
2. Web/mobile：layout、選取、scrollback 與 exactly-once input 同步。
3. Windows IME：新注音 composition box 穩定，送字不重複。
4. Reader：active 與 non-active pane 都可開啟；unsupported/not-found/ambiguous 正確 fallback。
5. Voice target lock：錄音期間鎖定原 terminal，只插入文字、不自動 Enter。
6. Provider representative paths：依本次 release notes 列出新增或風險較高的 profile。

For the my-kimi release, smoke both `claude-local-big` and `codex-local-big`: confirm the
400,000 context contract, `high` reasoning, one real tool result, correct
session owner/Reader binding, and restart/resume without cross-harness fallback.

真實硬體、網路、VPN、provider API 或 credential 不可用時，該項只能標
`BLOCKED`，不得用 mock、單元測試或推測宣稱 `PASS`。

## 已知問題模板

發布當下填寫，並同步到 GitHub Release notes：

| ID | 狀態 | 重現方式／證據 | 影響 | 後續 issue |
|---|---|---|---|---|
| （無則填 None） | OPEN / BLOCKED / DEFERRED | 可重現命令或人工步驟 | 使用者可感知影響 | URL |

不得沿用無法由目前程式碼、測試或 live evidence 證實的歷史 blocked／lint debt。

## 發布流程

1. 確認在 `master`，working tree 只含本次授權的 release 變更。
2. 依序跑完五個機器閘門並保存摘要。
3. 執行人工 smoke；未執行的真實環境項目標 `BLOCKED`。
4. `npm run dist`，核對 installer 檔名與 `package.json.version`。
5. 建立 `v<package-version>` tag、推送 `master` 與 tag。
6. 建立或更新 GitHub Release，上傳 installer，附 CI run URL、commit SHA 與已知問題。

## Beta side-by-side 安裝（v1.5 Phase 0C）

目的：不動既存 stable 正式環境；本 prerelease 的 `npm run dist`（等同
`npm run dist:beta`）產出可同機並存的 Beta，只有明確的 `npm run dist:stable`
才使用 legacy stable builder identity。
channel 判定：任何 prerelease 版號（含 `-`，例 `1.5.0-beta.1`）自動 beta，或
`COTERM_CHANNEL=beta`/`stable` 強制指定（`src/main/core/app-identity.ts`）。

| 資源 | stable（不變，逐字保留） | beta |
|---|---|---|
| appId | `io.coterm.app` | `io.coterm.app.beta` |
| productName / exe | Coterm | Coterm Beta |
| userData | `%APPDATA%\Coterm` | `%APPDATA%\Coterm Beta` |
| remote-config dir | `%LOCALAPPDATA%\Coterm` | `%LOCALAPPDATA%\Coterm Beta` |
| Agent API 預設 port | 43127 | 43128 |
| installer 檔名 | `Coterm-<v>-Setup.exe` | `Coterm Beta-<v>-Setup.exe` |

userData 下所有 channel 自有資源（SQLite、settings.json、session-index、
browser profiles、agent-api token、agent launchers、logs）依上表全隔離；
NSIS `deleteAppDataOnUninstall=false`，移除任一方都不動對方資料。
Rollback：直接停用/移除 Beta 即可——stable 的每個值都與 1.4.x 逐字相同
（`tests/unit/app-identity.test.ts` 鎖定），無資料遷移。
