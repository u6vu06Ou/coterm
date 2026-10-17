# Coterm Architecture

本檔以原始碼目錄為模組單位，描述每個模組的職責、對外介面與依賴方向。正確性以 `src/` 原始碼為準；本檔不重構，只記錄現況。對應開源工單 Task 6（`docs/superpowers/plans/2026-07-02-ticket-4-opensource-readiness.md`）。

進入點：`src/main/index.ts`。`bootstrap()` 建立所有模組實例並接線，順序為 logger → database → repository → approvals → adapters（Claude profiles / Codex profiles）→ handoffs → runs → council → terminals（含 agent detection overrides）→ summarizer → operations → ipc → agentApi token → webServer。

## 模組邊界

### main/core

- **職責**：應用層協調中樞。`AppOperations` 是對 renderer/web 的總閘門（bootstrap、settings、projects、conversations、terminals、dock、approvals、council、artifacts、search）；`RunCoordinator` 管理多 provider 的對話 turn 生命週期；`AppEventBus` 是跨模組事件匯流排；`ApprovalBroker` 處理工具核准與使用者輸入請求；`HandoffManager` 跨 provider 交接；`ConversationSummarizer` / `ClaudeHistory` 做摘要與歷史匯入；`DockLayoutManager` 維護終端機 dock 配置；`logger` 是 JSON-lines 環形緩衝日誌。
- **對外介面**：`AppOperations` 的公開方法（bootstrap/getSettings/setSettings/createTerminal/writeTerminal/getDockLayout/openTile/...，見 `src/main/core/app-operations.ts`）、`RunCoordinator`、`AppEventBus` 事件名稱（`event`/`terminalData`/`terminalExit`/`terminalListChanged`）、`logger` 與 `getLoggerHealth`/`getRecentLogEntries`/`getLogFilePath`、`createId`/`nowIso`、`shouldOpenDesktop`。
- **誰依賴它**：`src/main/index.ts`（組裝）、`src/main/ipc/register-ipc.ts`（IPC handler 全部委派 operations）、`src/main/web/routes.ts`（`bindWebOperations(operations)` 把方法綁成 RPC）、`src/main/web/agent-api.ts`（透過 `ctx.operations` 讀寫終端機）、`src/main/web/live-socket.ts`（replay 與訂閱 events）。

### main/providers

- **職責**：LLM provider 介接。`ClaudeAdapter` 透過 `claude` CLI + Claude Agent SDK 跑 official、Qwen、GLM 與 `claude-local-big`；`CodexAppServer` 跑 official、GLM、Qwen 與 `codex-local-big`。Kimi 仍由 Claude/Codex harness 擁有 session，只把模型流量送到 bridge proxy；Coterm 不保存內部 upstream URL。`CouncilScheduler` 多模型投票；`profiles-config.ts` 讀 `<userData>/profiles.json`；`capability-detector.ts` 探測 CLI 與 route；`executables.ts` 解析 CLI 路徑。
- **對外介面**：`ProviderAdapter` 介面（`run(context)`/`dispose()`/`profiles`）、`ProviderRunContext`/`ProviderRunResult`/`ProviderEvent` 型別、`loadProfilesConfig(userDataPath)`/`DEFAULT_PROFILES`/`DEFAULT_PROXY_URL`/`DEFAULT_AUTH_TOKEN`、`buildClaudeArguments`/`buildCodexAppServerArguments`、`detectProviders(proxyUrl)`、`resolveCliExecutable(name)`。
- **誰依賴它**：`src/main/index.ts`（建構 ClaudeAdapter / CodexAppServer / CouncilScheduler 並餵進 RunCoordinator）、`src/main/ipc/register-ipc.ts`（`detectProviders` 用於 diagnostics）、`src/main/core/conversation-summarizer.ts`（用 ClaudeAdapter 產生摘要）。

### main/terminal

- **職責**：PTY 終端機管理。`PtyManager` 用 `@lydell/node-pty` spawn shell（pwsh 7 優先，回退 powershell.exe；另支援 cmd/wsl/zsh/bash），Windows 走 conpty；維護每個終端機的 2M-char recovery scrollback。Agent pane 另在 main process 用同版 `@xterm/headless` 維護 bounded live VT bottom-buffer（normal/alternate screen、cursor/erase/TUI redraw），再交給 profile-specific TS/Zod 規則引擎判定 canonical `PtyState`。規則支援 region、priority、all/any/none 與 bounded regex；bundled manifest 可由 `<userData>/agent-detection/*.json` 驗證後熱覆寫。
- **對外介面**：`PtyManager`（create/write/resize/rename/markAgent/markAgentOwned/kill/list/get/getPtyState/getAgentStateExplanation/snapshots/dispose）、`AgentDetectionEngine`、`PtyState` 型別、`truncateScrollback`。事件透過 `AppEventBus` emit `terminalData`/`terminalExit`/`ptyStateChanged`。`setPtyState()` 仍是唯一 state writer，權威順序為 process/broker/provider > OSC > screen > activity/quiet heuristic。
- **誰依賴它**：`src/main/index.ts`（建構）、`src/main/ipc/register-ipc.ts`（IPC terminalCreate/Write/Resize/Kill 等委派）、`src/main/core/app-operations.ts`（包裝成 operations.createTerminal 等）、`src/main/web/agent-api.ts`（透過 operations.writeTerminal 注入按鍵）。

### main/storage

- **職責**：持久化層。`AppDatabase` 封裝 better-sqlite3 連線與 schema 遷移；`Repository` 是所有讀寫的閘門（projects/conversations/events/terminal_events/provider_sessions/attachments/settings/summaries），含中斷 run 回收、終端機事件批次寫入、保留期剪裁；`migrations.ts` 是 schema 版本清單。
- **對外介面**：`Repository`（listProjects/createProject/getSettings/setSettings/appendTerminalEvent/listEvents/recoverInterruptedRuns/...）、`AppDatabase`（open/close/backup/restore/queryAll/path/schemaVersion）、`defaultShellForPlatform`、`CONVERSATION_SUMMARY_*` 常數、`migrations` 陣列。
- **誰依賴它**：`src/main/index.ts`（開 DB、建 Repository、`recoverInterruptedRuns`）、`src/main/core/app-operations.ts`（幾乎所有方法都走 repository）、`src/main/core/run-coordinator.ts`（session/事件持久化）、`src/main/ipc/register-ipc.ts`（terminal output 緩衝 flush、diagnostics）。

### main/web

- **職責**：HTTP + WebSocket 伺服器，把手機/瀏覽器/web 端接上主程序。`web-server.ts` 起監聽 `127.0.0.1` 的 http server，處理 `/health`、`/api/rpc`（RPC mutation/讀限流）、靜態 renderer 檔案；`agent-api.ts` 是 localhost-only token-gated agent REST API（`/api/v1/agent/*`，在 Cloudflare verifyAccess 閘門之前分支）；`live-socket.ts` 是 WebSocket `/live`，replay 持久化事件 + 訂閱即時事件 + 推送 dock layout；`routes.ts` 定義 RPC method 白名單與 `bindWebOperations`；`web-config.ts` / `access-auth.ts` 讀遠端設定與 Cloudflare Access JWT 驗證。
- **對外介面**：`startWebServer(options)` → `RunningWebServer`、`attachLiveSocket(server, options)`、`agentApi.handle(req, res, ctx)`、`bindWebOperations(operations)`/`rpcMethods`/`isRpcMethod`、`readWebConfig(env)`、`createCloudflareAccessVerifier`、`originAllowed`/`readBody`/`json`/`MAX_BODY_BYTES`。
- **誰依賴它**：`src/main/index.ts`（`startWebServer` + `bindWebOperations` + `attachLiveSocket` 經由 options.events/dockLayout）。renderer 與外部 agent 透過此模組消費 operations。

### main/security

- **職責**：安全衛生。`redaction.ts` 提供 `redactSecrets`/`redactPii`/`redactEgress`/`safeErrorMessage`（日誌與 API 回應去識別化）；`environment.ts` 的 `sanitizedChildEnvironment` 從子程序環境剝除 secret 形狀的 key（TOKEN/SECRET/KEY）；`path-policy.ts` 的 `assertAllowedPath` 防路徑穿越。
- **對外介面**：`redactSecrets`/`redactPii`/`redactEgress`/`safeErrorMessage`、`sanitizedChildEnvironment`、`assertAllowedPath`/`PathPolicyOptions`。
- **誰依賴它**：`src/main/index.ts`（unhandledRejection/uncaughtException 用 safeErrorMessage）、`src/main/terminal/pty-manager.ts`（spawn 時用 sanitizedChildEnvironment）、`src/main/providers/claude-adapter.ts`（同上）、`src/main/storage/repository.ts`（`redactEgress`）、`src/main/web/agent-api.ts`（回應前 redactEgress）、`src/main/core/logger.ts`、`src/main/ipc/register-ipc.ts`（`assertAllowedPath`）。

### renderer

- **職責**：Electron renderer（React + Vite）。`App.tsx` 是根元件；`store/app-store.ts` 是 zustand store（WorkspacePane、dock layout、事件路由 `routeEvent`）；`components/TerminalDock.tsx` 嵌入 xterm.js 顯示 PTY；`Sidebar.tsx`/`TopBar.tsx`/`SettingsPanel.tsx`/`LLMPickerDialog.tsx`/`FirstRunWizard.tsx`/`ExplorerPanel.tsx`/`ArtifactRail.tsx`/`voice-input.ts` 是 UI 元件；`api/browser-api.ts` 是 preload 暴露的 `AiTerminalApi` 實作；`dev/mock-api.ts` 開發期 mock。
- **對外介面**：`createBrowserApi`（實作 `AiTerminalApi`，經 preload `src/preload/index.ts` 暴露給 renderer 進程呼叫 IPC）、`useAppStore`、`routeEvent`、各元件。renderer 不直接碰 main 模組，只透過 `window.aiTerminal.*`（IPC）與 WebSocket `/live`。
- **誰依賴它**：`src/main/index.ts` 載入 `../renderer/index.html`；`src/main/web/web-server.ts` 在 web 端模式下 serve renderer 靜態檔給手機/瀏覽器。

## 資料流

### 圖一：鍵入 → PTY → scrollback → WS → web 端

```
使用者鍵入（renderer xterm.js）
  → window.aiTerminal.terminalWrite({terminalId, data})        [IPC, src/preload/index.ts]
  → ipcMain.handle(IPC.terminalWrite)                           [src/main/ipc/register-ipc.ts]
  → operations.writeTerminal(input)                             [src/main/core/app-operations.ts]
  → terminals.write(terminalId, data)                           [src/main/terminal/pty-manager.ts]
  → ptyProcess.write(data)                                      [@lydell/node-pty → conpty]

PTY 產出
  → ptyProcess.onData(data)                                     [src/main/terminal/pty-manager.ts]
  → managed.scrollback = truncateScrollback(scrollback + data)  [recovery 記憶體，上限 2M 字元]
  → AgentDetectionEngine.ingest(data)                           [main-owned headless VT，callback 後讀 live active buffer]
  → rule candidate → setPtyState(..., source="screen")          [只送 metadata；raw PTY 不 log/DB/notification]
  → events.emit("terminalData", {terminalId, projectId, data}) [src/main/core/event-bus.ts]

事件匯流排分兩路：
  A) IPC 路徑（桌面 renderer）
     → register-ipc terminalDataListener                        [src/main/ipc/register-ipc.ts]
     → 緩衝（32K 字元 / 250ms idle）後 repository.appendTerminalEvent  [src/main/storage/repository.ts]
     → window.webContents.send(IPC.terminalData, payload)       [桌面 renderer]
  B) WS 路徑（手機 / 瀏覽器）
     → live-socket bindClient 訂閱 events.on("terminalData")    [src/main/web/live-socket.ts]
     → send(client, {type:"terminalData", payload})             [WebSocket /live]
     → web 端 renderer 收到後寫入對應 tile 的 xterm.js
```

### 圖二：agent 啟動 → adapter → proxy

```
使用者按 +agent（renderer）
  → window.aiTerminal.terminalCreate({projectId, profile, cwd, isAgent:true, agentProfile})  [IPC]
  → operations.createTerminal → terminals.create               [src/main/terminal/pty-manager.ts]
    spawn shell，env 注入 ANTHROPIC_AUTH_TOKEN（agent 終端機）
  → +agent 按鈕貼上啟動指令並 auto-Enter（interactive-agent.ts）

兩種 agent 路徑：

  路徑 A：互動式 agent（PTY 內跑 claude CLI）
    → 使用者在 PTY 裡打 claude --model ... --dangerously-skip-permissions
    → ClaudeAdapter 不經手；PTY 直接 spawn claude.exe
    → claude CLI 連 ANTHROPIC_BASE_URL（= profiles.json 的 proxyUrl，預設 http://127.0.0.1:8787）

  路徑 B：訊息式 agent（RunCoordinator 跑 turn）
    → operations.sendMessage(input)                             [src/main/core/app-operations.ts]
    → runs.start({profileId, ...})                              [src/main/core/run-coordinator.ts]
    → ClaudeAdapter.run(context)                                [src/main/providers/claude-adapter.ts]
    → profile = profileTable[profileId]                         [來自 loadProfilesConfig → <userData>/profiles.json]
    → env = sanitizedChildEnvironment() + profile.env
    → if profile.local: env.ANTHROPIC_BASE_URL = getProxyUrl()  [repository.getSettings().proxyUrl]
    → spawn(resolveCliExecutable("claude"), args, {env})        [src/main/providers/executables.ts]
    → claude CLI → ANTHROPIC_BASE_URL（LLM proxy）→ 實際後端（GLM/Qwen/正版 Claude）
    → CLI stdout JSON-lines → ClaudeAdapter 解析 → emit ProviderEvent → AppEventBus
    → 落庫（repository.appendEvent）+ 推 IPC/WS 給 renderer
```

## 程序邊界（補充）

- Renderer：React UI、Markdown、圖片預覽、IME 與 xterm.js。不能取得 Node.js、任意檔案或任意 process spawn 能力。
- Preload：只暴露 `AiTerminalApi` 中的 allowlisted typed IPC。
- Main：Provider adapters、Council、handoff、SQLite、檔案政策與 ConPTY。
- External：Claude Code CLI、Codex app-server、bridge proxy（`http://127.0.0.1:8787`）。

## Canonical ledger

SQLite 是 app conversation 的唯一事件帳本。Provider 原生 session 不會互相冒充：Claude profile 保存各自 session ID；Codex 保存 thread ID；Council 保存 turn group、members、reviews 與 synthesis；切換 Provider 時產生 handoff packet 再送到目標 lane。

## 相關文件

- `docs/CUSTOMIZING.md` — 使用者不改核心碼的三個自訂口。
- `docs/AGENT-API.md` — agent REST API 完整端點與語法。
- `docs/PLATFORM-SUPPORT.md` — 平台支援矩陣。
- `docs/superpowers/specs/2026-06-28-terminal-first-overhaul-design.md` — terminal-first 設計規格。
