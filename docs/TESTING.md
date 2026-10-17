# Coterm UI total-test

Coterm 的 UI total-test 是給人與 agent 共用的可延伸測試底座。它把「所有可互動面都被發現」
和「該操作已被真實驗證」分開，避免清單完整卻誤報為全數通過。

## 一鍵執行

```powershell
npm run test:ui:total
```

這個命令依序執行 production build（含 typecheck、action-ID gate、Vitest）、AST 互動面盤點、
以及隔離 userData 的 Electron Playwright 情境，最後產生：

- `.review/audits/ui-action-inventory.json`：機器可讀的完整互動面與來源位置。
- `.review/audits/ui-action-inventory.md`：給人閱讀的靜態清單。
- `.review/audits/ui-total-report.json`：agent 應優先讀取的逐 action 結果。
- `.review/audits/ui-total-report.md`：給人閱讀的總表。

快速迭代可用 `npm run test:ui:total -- --skip-build`。Release 使用
`npm run test:ui:total:strict`：它保留報告內真實的 BLOCKED／NOT_COVERED 狀態，並以
`tests/fixtures/ui-total-release-baseline.json` 做不可增加的 debt ratchet；任何新 unresolved
action、FAIL 或基礎設施失敗都會回傳非零。`npm run test:ui:total:complete` 則要求 100%
可執行覆蓋，適合持續清償基線。`--live` 只解除分類阻擋；若沒有對應的安全情境，仍會是
NOT_COVERED。

## 狀態契約

| 狀態 | 唯一合法意義 |
|---|---|
| `PASS` | Playwright 真正執行操作，且明確的 state/log oracle 通過。 |
| `FAIL` | 操作已執行，但產品狀態或稽核 oracle 不符。 |
| `BLOCKED` | 需要 live provider、OS/device 或破壞性授權，預設安全模式不執行。 |
| `NOT_COVERED` | 已有穩定 action ID，但尚無可執行情境或 oracle。 |

`data-action-id` 只是定位契約，不是通過證據。任何 agent 都不得把 NOT_COVERED 改寫成 PASS，
也不得以 generic click API 在正式使用者資料上盲點所有按鈕。

## 新增或修改 UI 時

1. 所有可點、可輸入、可拖曳或鍵盤操作的 renderer 元件都要有語意化且唯一的
   `data-action-id`。`npm run build` 會透過 `check:ui-actions` 阻止漏標或重複。
2. `scripts/lib/ui-action-catalog.ts` 負責 SAFE／STATEFUL／DESTRUCTIVE／EXTERNAL 分級與適用表面。
3. 在 `tests/e2e/` 建立使用暫存 `COTERM_USER_DATA_DIR` 的 Playwright 情境；不得讀寫正式
   `%APPDATA%\Coterm`。
4. 每個情境必須有可判定的 oracle，例如 UI state、SQLite state 或 privacy-safe `ui.action`
   log；不能只驗證「click 沒丟 exception」。
5. 在 `scripts/lib/ui-action-scenarios.ts` 將情境與 action IDs 綁定，重跑 total-test，確認結果從
   NOT_COVERED/BLOCKED 變成 PASS 或可信的 FAIL。

## 安全與隱私

- `coterm.log` 的 `ui.action` 只允許 action ID、surface、control type、interaction 與 identified；
  不得寫 label、input value、clipboard、PTY output 或對話內文。
- free-text 採原生 `change`（commit/blur）稽核，不按每個 keystroke 寫 log。
- web/mobile 的 UI audit 有獨立 rate-limit bucket，不會耗盡正常 product mutation quota。
- destructive/external 情境必須使用 disposable fixture 或 mock；live 驗證必須由操作者明確 opt in。

## 2026-07-14 起始基線

- 97 個互動面全部有唯一穩定 ID。
- 3 PASS：`topbar.settings.open`、`settings.proxy.change`、`settings.close`。
- 0 FAIL、16 BLOCKED、78 NOT_COVERED。

基線數字只是起點，最新事實永遠以剛產生的 `ui-total-report.json` 為準。
Release baseline 只豁免已逐 ID 列出的既有 unresolved actions，不會把它們改寫成 PASS；
新增互動面若沒有可信情境，strict gate 仍會失敗。

## TDD / BDD release gates

- Local development and all GitHub Actions jobs use Node.js 24.x from
  `.node-version`, with `package.json.engines.node` carrying the same contract.
- Unit, integration, and contract suites are independently runnable with
  `npm run test:unit`, `npm run test:integration`, and `npm run test:contract`.
- `npm run test:coverage` enforces the committed global coverage floor. Raising
  coverage raises the floor; a release must not lower it merely to turn CI green.
- Electron user journeys live under `tests/e2e/bdd/` and use stable scenario IDs
  in test titles. Local Playwright retries are zero; CI retries once and rejects
  flaky tests.
- Voice release evidence has three layers: mocked HTTP contract, unpacked or
  packaged Electron flow, and an explicitly opted-in live OpenAI-compatible STT
  endpoint. Mock success must never be reported as live microphone success.
