# Codex Team（issue #100 移植版）

追蹤：[Issue #100](https://github.com/u6vu06Ou/coterm-private/issues/100)。Node ESM bridge；使用隨安裝版附帶的 smol-toml 解析設定。

## 兩支 MCP 工具

- `bridge.mjs` — PM 這端的 stdio MCP server。提供 `team_start` / `team_send` / `team_status` / `team_cancel` / `team_wait` / `team_respond` 六個工具，並起一個本機 dashboard（隨機 127.0.0.1 埠）：`/state` 看板狀態、`/action` 傳話（有 Host/Origin 檢查）。它負責 spawn Codex `app-server`（每個隊員一條持續的 native thread）。
- `team_bus.mjs` — 隊員這端的 worker-only MCP server。提供 `team_message`（用隊員名字直接傳話）與 `report_to_lead`（保留名 `'lead'`，佇列事件並喚醒 lead 的 `team_wait`），打到上面 dashboard 的 `/action`。

## 啟動方式

以 Node 模式執行 Electron：`<Coterm 的 electron.exe> bridge.mjs` 並帶 `ELECTRON_RUN_AS_NODE=1`，安裝版使用附帶的 `smol-toml.cjs`，不需要使用者額外安裝 npm 套件。bridge 會用 `process.execPath` spawn `team_bus.mjs`，並把 runtime 設定寫進每次 session 的 `%CODEX_TEAM_HOME%`（`[mcp_servers.team_bus]` 帶 `command`、`args`、`env.ELECTRON_RUN_AS_NODE`）。Codex `app-server` spawn 時拿掉 ELECTRON_RUN_AS_NODE／OPENAI_API_KEY／ANTHROPIC_API_KEY／ANTHROPIC_AUTH_TOKEN／CHATGPT_ACCESS_TOKEN，並 `windowsHide: true`（無頭，不開視窗）。

## 環境變數（都有預設值）

| 變數 | 作用 | 預設 |
|---|---|---|
| `CODEX_TEAM_PROXY_URL` | 免費後端 proxy 位址，bridge 自動補 `/v1` | `http://127.0.0.1:8787` |
| `CODEX_TEAM_CLI` | Codex CLI exe 完整路徑 | npm vendor 路徑 → cmd-shim → PATH 掃描，都找不到就報明確錯誤 |
| `CODEX_TEAM_CLI_PREFIX_ARGS` | 放在 `app-server` 前面的參數（JSON 陣列） | 空 |
| `CODEX_TEAM_HOME` | runtime／log 目錄 | `~/.codex-team-free` |
| `CODEX_TEAM_CAPABILITIES_HOME` | 本機 MCP、技能、指示與信任設定來源 | 父程序 `CODEX_HOME`，沒有時為 `~/.codex` |

給 Codex 的設定範本：`codex-team.config.toml.example`（`__NODE__`／`__BRIDGE__`／`__PROXY__` 三個佔位符）。

## 正常 agent 能力

- 新隊員預設 `access=full-access`：可讀檔、改檔、執行指令與測試。仍遵守任務範圍與服務授權。指定 `read-only` / `workspace-write` 可保留限制，不會失敗後偷偷提權。舊 `workspace_write=true/false` 明確傳入時仍維持原先語意，不可與 `access` 同時使用。
- 完整權限隊員另有 JSON `apply_patch` 工具，直接呼叫 Codex 原生修補引擎；不經 Windows shell 轉送多行內容。受限隊員不提供此工具，避免繞過其沙箱。
- 只繼承使用者設定的 MCP servers、技能開關、已信任專案與全域指示；連接既有 skills/rules 目錄。停用的工具或技能保持停用，橋接器不遞迴載入自己。專案 AGENTS.md 由 Codex 原生從 cwd 載入。
- 不複製 auth.json、付費 provider 或帳號狀態；原生 subagent 仍停用，避免現行 CLI 的 provider 路由落到付費模型。帳號專屬連接器、外部服務登入與後端不支援的工具不能藉完整本機權限取得。
- 原生提問與工具審批透過 `worker_request` 喚醒 lead；`team_status.requests` 也可查詢。主控以 `team_respond` 回傳原生 response，不能忽略或擅自替使用者批准越界操作。

## 行為重點

- 每個隊員一條持續 thread：`team_send` 在同 thread 追問，執行中走 steer、完成後續聊；history 每隊員 50 則上限。
- app-server 工作程序結束 → 回收 pending RPC、所有隊員標 `error`（thread 不可重用，請 `team_start` 一個新名字重新 spawn）。
- `team_status` 可帶 `max_chars`（預設 2000、上限 8000）控制輸出量；看板另有 `updatedAt`、`elapsedSec`。
- `team_wait` 是 lead 的長輪詢（預設擋 1500 秒、最長 1700、最少 1）：隊員完成一輪（completed/interrupted/failed）或有隊員向 lead 傳話（保留名 `'lead'`）就返回該事件＋該隊員狀態與輸出尾巴（`max_chars` 控制量）；符合的事件已在佇列時立即返回；逾時回 `timedOut: true` 加精簡狀態（無輸出尾巴）。讀 `team_status` 視同 lead 已看過，會清空事件佇列。
- dashboard 的 bus 傳訊有環形節流：`X-Team-Bus: 1` 來源 10 分鐘最多 20 則、同 (name, text) 60 秒內重複會回 429。
- bridge 結束（stdin 關閉或收到訊號）→ 關掉 HTTP server + `taskkill /T /F` 砍掉 app-server 進程樹，然後退出。
- 隊員名稱規則：`/^[a-z0-9][a-z0-9_-]{0,31}$/i`。

## 測試

```
node --test tools/codex-team/test/bridge.test.mjs tools/codex-team/test/capabilities.test.mjs
```

16 個測試，另含完整權限／明確限制、互動回覆與能力繼承；原有情境：initialize、team_start/完成輪詢、同 thread 追問、取消、dashboard Origin 檢查、bus 節流、未知隊員名稱、app-server crash → 死亡標記 + 新名字重生、team_wait 完成返回／已佇列立即返回／lead 傳話喚醒／逾時路徑、stdin 關閉乾淨退出。fake app-server 在 `test/fake-app-server.mjs`（文字 `CRASH` 觸發 exit 1）。

真實模型驗收（選用，會呼叫免費 proxy）：`node tools/codex-team/test/live-agent.mjs`。GLM/Kimi 各自於獨立測試目錄讀檔、apply_patch、執行 node 測試、讀技能、呼叫 MCP、回報與同 thread 接續；產物與摘要寫在輸出的臨時目錄。設定 `CODEX_TEAM_TEST_BRIDGE` / `CODEX_TEAM_TEST_EXECUTABLE` 可驗證安裝版 bridge / Electron。驗收不重啟共享服務。
