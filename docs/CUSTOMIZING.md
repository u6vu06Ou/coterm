# Customizing Coterm

Coterm 設計上讓使用者在**不改核心碼**的前提下自訂三個地方。本文每個口都給一個完整可抄的範例。

> 路徑代稱：`<userData>` 是 Coterm 的 userData 目錄。Windows 預設是 `%APPDATA%\Coterm`（歷史目錄名，見 `CLAUDE.md`「Installer / app-name history」）。可在 Settings → 診斷資料匯出看到實際路徑，或用環境變數 `COTERM_USER_DATA_DIR` 覆寫。

## 口一：`<userData>/profiles.json` — 自訂 proxy / token / model / env

這是開源版的核心自訂點。Coterm 啟動時呼叫 `loadProfilesConfig(userDataPath)`（`src/main/providers/profiles-config.ts`）讀取此檔；檔案不存在會自動寫出內建預設值再讀回。zod 驗證失敗時回退內建預設並 logger.warn，不崩潰。

### 檔案結構（欄位名以 `profiles-config.ts` 的 schema 為準）

```jsonc
{
  "proxyUrl": "http://127.0.0.1:8787",   // claude-* 本地 profile 的 ANTHROPIC_BASE_URL
  "authToken": "ccr-local",              // 本地 profile 預設 token（profiles.env 可覆寫）
  "profiles": {
    "<profileId>": {
      "model": "claude-sonnet-4-6",      // 可選；claude-official 不用設
      "local": true,                     // true=走 proxyUrl；false=正版 Anthropic
      "env": {                           // 注入子程序的環境變數
        "ANTHROPIC_MODEL": "claude-sonnet-4-6",
        "ANTHROPIC_AUTH_TOKEN": "ccr-local",
        "ANTHROPIC_SMALL_FAST_MODEL": "claude-3-5-haiku-latest",
        "DISABLE_TELEMETRY": "1",
        "DISABLE_COST_WARNINGS": "1",
        "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
        "CLAUDE_CODE_WORKFLOWS": "1",
        "DISABLE_GROWTHBOOK": "1"
      }
    }
  }
}
```

欄位來源（`src/main/providers/profiles-config.ts`）：
- `proxyUrl`：`DEFAULT_PROXY_URL = "http://127.0.0.1:8787"`，被 `ClaudeAdapter` 用於 `profile.local === true` 時設 `env.ANTHROPIC_BASE_URL`。
- `authToken`：`DEFAULT_AUTH_TOKEN = "ccr-local"`。
- `profiles`：`Record<string, ClaudeProfile>`，內建 Claude profile 包含 `claude-official` / `claude-local-long` / `claude-local-freeform` / `claude-local-main` / `claude-local-big`。
- `ClaudeProfile`：`{ model?: string; local: boolean; contextWindow?: number; reasoningEffort?: "low" | "high" | "max"; env: Record<string, string | undefined> }`。`env` 值設 `undefined` 會從子程序環境刪除該 key。

### 完整範例：把 proxy 換成自己的 `http://my-proxy:8080`，並把 claude-local-main 的 model 換掉

1. 編輯 `<userData>/profiles.json`（若不存在，先啟動一次 Coterm 讓它生成預設檔，再關閉）。
2. 改成以下內容（只列要改的欄位，其餘保留預設）：

```json
{
  "proxyUrl": "http://my-proxy:8080",
  "authToken": "my-secret-token",
  "profiles": {
    "claude-official": {
      "local": false,
      "env": {
        "ANTHROPIC_BASE_URL": undefined,
        "ANTHROPIC_AUTH_TOKEN": undefined,
        "ANTHROPIC_MODEL": undefined,
        "ANTHROPIC_SMALL_FAST_MODEL": undefined
      }
    },
    "claude-local-long": {
      "local": true,
      "model": "claude-3-5-sonnet-latest",
      "env": {
        "ANTHROPIC_AUTH_TOKEN": "my-secret-token",
        "ANTHROPIC_SMALL_FAST_MODEL": "claude-3-5-haiku-latest",
        "DISABLE_TELEMETRY": "1",
        "DISABLE_COST_WARNINGS": "1",
        "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
        "CLAUDE_CODE_WORKFLOWS": "1",
        "DISABLE_GROWTHBOOK": "1",
        "ANTHROPIC_MODEL": "claude-3-5-sonnet-latest"
      }
    },
    "claude-local-freeform": {
      "local": true,
      "model": "claude-haiku-4-5-20251001",
      "env": {
        "ANTHROPIC_AUTH_TOKEN": "my-secret-token",
        "ANTHROPIC_SMALL_FAST_MODEL": "claude-3-5-haiku-latest",
        "DISABLE_TELEMETRY": "1",
        "DISABLE_COST_WARNINGS": "1",
        "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
        "CLAUDE_CODE_WORKFLOWS": "1",
        "DISABLE_GROWTHBOOK": "1",
        "ANTHROPIC_MODEL": "claude-haiku-4-5-20251001"
      }
    },
    "claude-local-main": {
      "local": true,
      "model": "claude-sonnet-4-6",
      "env": {
        "ANTHROPIC_AUTH_TOKEN": "my-secret-token",
        "ANTHROPIC_SMALL_FAST_MODEL": "claude-3-5-haiku-latest",
        "DISABLE_TELEMETRY": "1",
        "DISABLE_COST_WARNINGS": "1",
        "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
        "CLAUDE_CODE_WORKFLOWS": "1",
        "DISABLE_GROWTHBOOK": "1",
        "ANTHROPIC_MODEL": "claude-sonnet-4-6"
      }
    }
  }
}
```

3. 存檔後重啟 Coterm。`claude-local-main` / `claude-local-long` 等 `local: true` profile 啟動 agent 時，`ANTHROPIC_BASE_URL` 會指向 `http://my-proxy:8080`。

> 注意 JSON 不允許 `undefined` 字面量；上面 `claude-official.env` 中的 `undefined` 是 TypeScript 語意（表示「刪除該 env key」）。實際寫檔時把要刪的 key 直接省略即可，或寫成空字串 `""`（但空字串會被當成設值，不是刪除）。最保險的做法：`claude-official` 只寫 `"local": false` 與 `"env": {}`，讓 `ClaudeAdapter` 的 `local === false` 分支自己處理。

### 驗證生效

啟動一個 `claude-local-main` agent 視窗，在 PTY 裡跑 `echo $env:ANTHROPIC_BASE_URL`，應看到 `http://my-proxy:8080`。

## 口二：Settings — 主題 / shell / 預設 provider / proxy URL

Settings 存在 SQLite `settings` 表，schema 見 `src/shared/schema.ts` 的 `appSettingsSchema`。透過 UI（Settings 面板）或 IPC（`settingsGet`/`settingsSet`）改，不需要編輯檔案。

可調欄位（以 schema 為準）：
- `theme`：`"dark"` | `"light"`（預設 `dark`）。
- `defaultProvider`：側欄按 + 開 LLM picker 時預選的 profile。
- `defaultShell`：`"powershell" | "cmd" | "wsl" | "pwsh" | "zsh" | "bash"`（預設 `pwsh`）。**注意：目前 UI 固定顯示 pwsh 不暴露切換**（見 `SettingsPanel.tsx`），但 schema 與 `PtyManager` 支援其他 shell，可由 IPC 或未來 UI 設定。
- `proxyUrl`：bridge proxy URL（預設 `http://127.0.0.1:8787`）。**此欄位與 profiles.json 的 `proxyUrl` 是同一個值**——`ClaudeAdapter` 的 `getProxyUrl` 回傳 `repository.getSettings().proxyUrl`。Settings 面板的「Bridge Proxy」輸入框改的就是這個。
- `permissionPreset`：`"ask" | "trusted"`。
- `agentApi`：`{ enabled: boolean; token: string }`（預設 OFF）。
- `voice`：`{ enabled: boolean; lang: "zh-TW" | "zh-CN" | "en-US" }`。
- `retention`：`{ days: number; pruneOnStart: boolean }`。

### 完整範例：把主題切 light、proxy 換成 `http://my-proxy:8080`、預設 provider 改 claude-local-main

**做法 A（UI）**：開 Coterm → 右上齒輪 → LOCAL PREFERENCES → 改「Bridge Proxy」為 `http://my-proxy:8080`、Sidebar Provider 為 `claude-local-main`。主題目前 UI 沒有切換鈕（schema 有 `theme` 欄位但 `SettingsPanel.tsx` 未暴露），需用做法 B。

**做法 B（IPC，透過 devtools console）**：在 Coterm 視窗開 DevTools（開發模式下），執行：

```js
const s = await window.aiTerminal.getSettings();
await window.aiTerminal.setSettings({
  ...s,
  theme: "light",
  proxyUrl: "http://my-proxy:8080",
  defaultProvider: "claude-local-main"
});
```

> `window.aiTerminal.getSettings` / `setSettings` 對應 IPC `settingsGet` / `settingsSet`（`src/main/ipc/register-ipc.ts`）。`setSettings` 會 merge 存回 SQLite。重啟後仍生效。

### 字體

Coterm 目前**沒有把字體放進 settings**——字型清單寫在 `src/renderer/src/theme-tokens.css`（`--font-ui`、`--font-mono`）與 `styles.css`。要換字體需改 CSS（屬於改核心碼，不在本檔範圍）。未來若把字體移進 `appSettingsSchema`，本節會更新。

## 口三：Agent API — 唯讀檢視 + 注入按鍵

外部工具（IDE、腳本、外部 agent）可透過 localhost-only token-gated REST API 讀終端機狀態並注入按鍵，不需改 Coterm 程式碼。完整端點、語法與安全模型見 **`docs/AGENT-API.md`**。

啟用方式：Settings → Agent API 打開 ON。Token 寫入 `<userData>/agent-api-token.txt`，也顯示在 Settings 面板。API 預設監聽 `127.0.0.1:<webServerPort>`。

### 完整範例：讀某終端機 scrollback，再注入一行指令

```bash
TOKEN=$(cat "$APPDATA/Coterm/agent-api-token.txt")
PORT=43127   # 實際 port 見 Coterm 啟動 log，或 GET /api/v1/agent/health

# 1. 列出所有終端機，找到目標 terminalId
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:$PORT/api/v1/agent/sessions"

# 2. 讀單一終端機 detail + scrollback
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:$PORT/api/v1/agent/session/<terminalId>"

# 3. 注入指令並按 Enter
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"data":"git status","enter":true}' \
  "http://127.0.0.1:$PORT/api/v1/agent/session/<terminalId>/input"
```

安全限制（見 `src/main/web/agent-api.ts`）：Host-header allowlist（僅 `127.0.0.1`/`localhost`/`[::1]`）、timing-safe token 比對、mutation 端點 30/min 限流、1MB body 上限、關閉時所有端點回 404。Agent API 的 free-profile allowlist 由 `supportedAgentProfiles()` 單一來源提供，包含 Claude/Codex 的 Qwen、GLM 與 Kimi profile；未知值 fail closed。

## 相關文件

- `docs/ARCHITECTURE.md` — 模組邊界與資料流。
- `docs/AGENT-API.md` — agent REST API 完整端點。
- `docs/PLATFORM-SUPPORT.md` — 平台支援矩陣。
