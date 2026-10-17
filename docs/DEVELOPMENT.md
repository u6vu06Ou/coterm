# Coterm 開發方法論

> 衝突時以程式碼現況為準。

## 1. 變更的生命週期

規格 → 計畫 → 實作 → 驗證。

- **規格（spec）**：新功能先寫設計稿，鎖定的決策與未定選項分開寫清楚。
- **計畫**：可執行的計畫拆成 task，每個 task 附驗證方式。
- **實作**：bug 走 `docs/BUGFIX-PLAYBOOK.md` 六步；功能走計畫 task-by-task。
  動 symbol 前先查影響面（callers/callees）。
- **驗證**：見 §3。

## 2. 驗證論（分四層，寫明每層什麼時候跑）

| 層 | 命令 | 何時必跑 |
|----|------|---------|
| L1 靜態 | `npm run verify`（= `lint` + `typecheck` + `test`，即 eslint + tsc --noEmit + vitest run） | 每個 task 完成時 |
| L2 手動功能 | dev 模式重現該變更的使用路徑 | 每個 UI/行為變更 |
| L3 跨端 | desktop + web（+mobile 若相關）各驗一次 | 動到 dock/WS/sync 的變更 |
| L4 打包 | 先 `npm run release:check` 再 `npm run dist` → 安裝 → 冒煙 | release 前（在 app 外跑） |

驗證鐵律：宣稱完成前必須貼實際命令輸出（不是「應該會過」）。

開發與 CI 使用 Node.js 24.x；`.node-version` 與 `package.json.engines.node` 是可機器讀取的
runtime 契約。`npm run verify` 必須全綠，不接受歷史債、skip 或 `continue-on-error` 作為豁免。

e2e：`npm run test:e2e`（= `npm run build` + Playwright），改動 main process 路由/window 生命週期時跑。
UI 全量盤點與可執行情境：`npm run test:ui:total`；狀態語意、報告路徑與擴充方法見
`docs/TESTING.md`。
secret 掃描：`npm run security:scan`（= `tsx scripts/scan-secrets.ts`），release 前必跑。

## 3. Agent 分工守則

- app 內 agent 永不重啟/重裝 Coterm；build 是外部工作。
- dev 與 Agent API 互斥（單實例鎖 + port 43127）；派 Agent API 工先確認 dev 沒在跑。

## 4. Commit / 分支紀律

- 不 commit/push 除非維護者明說。功能開 feat/ 分支。
- commit message 沿用現行風格：`fix(scope): 一句話`／`feat: ...`；中文可。
- 大改動前打還原 tag：`git tag restore/pre-<主題>-<日期>`。
- 協作時**禁止對他人的工作樹跑 `git clean` / `reset --hard` / `checkout --`**——未追蹤的交付物會被刪光。

## 5. 相關文件索引

- Bug 修復：`docs/BUGFIX-PLAYBOOK.md`
- UI total-test：`docs/TESTING.md`
- agent API：`docs/AGENT-API.md`
