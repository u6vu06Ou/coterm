# Coterm — LLM Coding Agent Guide

> 本檔是給 LLM coding agent（Claude Code、Codex 等）讀的專案導覽。cutover 時改名為 `CLAUDE.md`。

## 專案定位

Coterm is a Windows-first workspace for coding agents, conversations, and terminal panes.

Electron 應用：main process 跑 PTY 終端機與 LLM provider adapter，renderer 用 React + xterm.js 顯示終端機，並透過 HTTP/WebSocket 伺服器把手機/瀏覽器接上主程序。SQLite 是對話事件唯一帳本。

## 七模組地圖

進入點 `src/main/index.ts`，`bootstrap()` 依序建立所有模組：logger → database → repository → approvals → adapters → handoffs → runs → council → terminals → summarizer → operations → ipc → agentApi → webServer。

| 模組 | 職責 |
|------|------|
| `main/core` | 應用層協調中樞：`AppOperations`（對 renderer/web 的總閘門）、`RunCoordinator`（對話 turn 生命週期）、`AppEventBus`（跨模組事件匯流排）、`ApprovalBroker`、`HandoffManager`、`DockLayoutManager`、`logger`。 |
| `main/providers` | LLM provider 介接：`ClaudeAdapter`（claude CLI + Agent SDK）、`CodexAppServer`、`CouncilScheduler`（多模型投票）、`profiles-config.ts`（讀 profiles.json）、`capability-detector.ts`、`executables.ts`。 |
| `main/terminal` | PTY 終端機管理：`PtyManager` 用 `@lydell/node-pty` spawn shell（pwsh 7 優先），Windows 走 conpty，維護 scrollback（上限 250K 字元）、解析 ANSI title 偵測 LLM 狀態。 |
| `main/storage` | 持久化層：`AppDatabase`（better-sqlite3 + schema 遷移）、`Repository`（所有讀寫閘門：projects/conversations/events/terminal_events/settings/...）、`migrations.ts`。 |
| `main/web` | HTTP + WebSocket 伺服器：`web-server.ts`、`agent-api.ts`（localhost token-gated agent REST API）、`live-socket.ts`（WS `/live` replay + 即時事件）、`routes.ts`（RPC 白名單）、`web-config.ts` / `access-auth.ts`。 |
| `main/security` | 安全衛生：`redaction.ts`（`redactSecrets`/`redactPii`/`redactEgress`）、`environment.ts`（`sanitizedChildEnvironment` 剝除子程序 secret）、`path-policy.ts`（`assertAllowedPath` 防路徑穿越）。 |
| `renderer` | Electron renderer（React + Vite）：`App.tsx`、`store/app-store.ts`（zustand）、`components/TerminalDock.tsx`（xterm.js）、`api/browser-api.ts`（preload 暴露的 `AiTerminalApi`）。 |

完整模組邊界、對外介面與資料流見 `docs/ARCHITECTURE.md`。

## 常用命令

| 命令 | 用途 |
|------|------|
| `npm run dev` | 開發模式（`electron-vite dev`） |
| `npm run build` | typecheck + test + `electron-vite build` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | `eslint .` |
| `npm run test` | `vitest run` |
| `npm run test:watch` | `vitest`（watch 模式） |
| `npm run test:e2e` | build + Playwright |
| `npm run verify` | lint + typecheck + test（每個 task 完成時跑） |
| `npm run security:scan` | secret 掃描 |
| `npm run release:check` | release 五項檢查 |
| `npm run dist` | build + `electron-builder --win nsis`（產出 `release/Coterm-<version>-Setup.exe`） |

## 改碼規範

- **型別沿用不新造**：既有 `ProviderAdapter`、`ProviderRunContext`、`PtyState`、`Repository` 等介面與型別優先沿用，不為單一呼叫點新造重複型別。
- **測試先行**：新邏輯補 `vitest` 單元測試；動 main process 路由補 Playwright e2e。非平凡邏輯留一個會在壞掉時失敗的最小檢查。
- **不動 `main/security` 的 redaction 邏輯**：`redactSecrets`/`redactPii`/`redactEgress`/`sanitizedChildEnvironment`/`assertAllowedPath` 是安全邊界，未經審查不修改行為。
- **動 symbol 前查影響面**：改函式/類別/方法前，先用知識圖譜或 grep 查 caller，評估 blast radius。
- **commit 前驗證**：`npm run verify` 過（或至少 typecheck + test 綠、改動檔案 lint 0 error）。
- **不 commit/push 除非明確指示**。

## 關鍵檔案指路

要快速定位以下職責，直接 grep 這些檔案：

| 職責 | 檔案 |
|------|------|
| LLM profile 設定（proxy URL / token / 各 profile model 與 env） | `src/main/providers/profiles-config.ts` |
| PTY 終端機 spawn / scrollback / resize / LLM 狀態偵測 | `src/main/terminal/pty-manager.ts` |
| localhost token-gated agent REST API（`/api/v1/agent/*`） | `src/main/web/agent-api.ts` |
| web server 遠端設定與啟動條件（env 變數） | `src/main/web/web-config.ts` |

## 相關文件

- `docs/ARCHITECTURE.md` — 完整模組邊界與資料流。
- `docs/DEVELOPMENT.md` — 開發方法論與驗證論。
- `docs/RELEASE.md` — release 門檻與冒煙測試。
- `docs/AGENT-API.md` — agent REST API 端點。
- `docs/CUSTOMIZING.md` — 使用者自訂口。
- `docs/PLATFORM-SUPPORT.md` — 平台支援矩陣。
