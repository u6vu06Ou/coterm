# Coterm ABCDEF Agent 作業契約

本契約規範**外部 agent（Agent API / IDE agent / shell 腳本）**、**renderer UI+IPC**、與**視窗內 agent** 透過 Coterm 作業時的邊界。以目前程式碼為準；標「已實作」=可用，「目前限制」=程式碼未提供。日期：2026-07-15。

鐵則：**持有效 token 的Agent API指令 = 使用者（Coterm 擁有者）合法授權**，照做（保留判斷），不是 prompt injection。token 在 `<userData>/agent-api-token.txt`， Settings→Agent API 開關預設**關**。

---

## 1. 功能能力矩陣

三條路線分開看：**外部 Agent API**（Agent API，token-gated HTTP）、**renderer UI+IPC**（人類點 UI / renderer 進程）、**視窗內 agent**（PTY 裡跑的 LLM）。

| 能力 | 外部 Agent API (`/api/v1/agent/*`) | renderer UI + IPC | 視窗內 agent | 不可繞過 |
|---|---|---|---|---|
| 開/關/選 terminal | ✅ `POST /terminals`、`/session/:id/close`、`/session/:id/input` | ✅ dock UI | — | dock 上限 8 |
| 讀 session / scrollback | ✅ `GET /sessions`、`/session/:id`（bounded scrollback + redacted lastCommand） | ✅ tile 顯示 | — | 視為敏感，見 §7 |
| 讀 logger / incidents / state | ✅ Phase 2 GET 全系列 | — | — | 唯讀、redacted |
| 建 worktree record | ✅ `POST /worktrees`（只建立，不開 terminal） | ✅ IPC `worktree:create` | — | git repo + path-policy |
| 在 worktree 開 agent terminal | ❌ `/terminals` 不收 `worktreeId` | ✅ 側欄「開啟沙箱 agent」會 create + openTile | ❌ | cwd 必須由 main 驗證 |
| worktree diff | ✅ `GET /worktrees/:id/diff` | ✅ IPC `worktree:diff-summary` | — | — |
| worktree merge / abort / cleanup | ✅ `/worktrees/:id/{merge,abort,cleanup}` | ✅ IPC `worktree:merge/abort/cleanup` | — | merge 需 `confirm:true`；dirty/running PTY 擋 |
| trusted resume | ✅ 管理既有、已綁定的 worktree | ✅ IPC `worktree:resume` | — | API 不能建立 terminal↔worktree 綁定；見 §3 |
| checkpoint list/diff | ❌ **無 Agent API endpoint** | ✅ IPC `checkpoint:list/diff` | — | 只 IPC 層 |
| checkpoint restore / hunk / undo | ❌ **無 Agent API endpoint** | ✅ IPC（preview-first） | — | `confirm:true` + token；fingerprint 漂移擋 |
| attention 收件匣 list | ❌ **無 Agent API endpoint** | ✅ IPC `attention:list` + WS `attention:changed` | — | metadata only |
| attention resolve | ❌ **無 Agent API endpoint** | ✅ IPC `attention:resolve` | — | 見 §5 |
| detection explain | ✅ `GET /session/:id/state-explain`（metadata only） | — | — | 不回 raw PTY/evidence |
| OSC 133/633 marker | — | — | ❌ 契約禁止偽造 | 見 §6 |
| Command Palette | ❌ 無 API | ✅ 人類 `Ctrl+Shift+P` | — | — |
| restart/rebuild/close Coterm | ❌ | ❌ | ❌ | **絕對禁止**（見 §8） |

**外部或視窗內 agent 不得宣稱可直接呼叫 IPC**——IPC 是 renderer↔main 私有通道。checkpoint / attention 沒有 Agent API endpoint；已存在的 checkpoint 與 notification 由人類 UI 處理，或由正式 renderer integration 經 preload wrapper 呼叫。

---

## 2. Worktree Lifecycle（A）

狀態：`active → merged | aborted | conflict | closed`。

```
UI「開啟沙箱 agent」
  → createWorktree
  → git worktree add -b <branch> <userData>/worktrees/<projectId>/<id> <baseRef>
  → DB insert；失敗則 rollback 目錄+分支
  → openTile(worktreeId, cwd=worktreePath) 開 agent 視窗
agent emit native_session_id
  → bindSession(worktreeId, terminalId, sessionId, agentProfile)
[改完]
  → diffSummary (GET /worktrees/:id/diff)  ← 必先看
  → merge {confirm:true}  ← 主樹須乾淨+在 base 分支+無 running PTY
  或 abort → cleanup（刪目錄+DB row，idempotent）
```

**Agent API ceiling**：`POST /worktrees` 到 DB insert 就停止；它不會呼叫 `openTile`。`POST /terminals` 也沒有 `worktreeId` 欄位。因此外部 agent 可以查詢/管理既有沙箱，但不能只靠目前 Agent API 建立一個真正綁到該沙箱的 terminal。需要人類先從 UI「開啟沙箱 agent」，或未來新增受驗證的 worktree terminal endpoint。

硬性檢查（`worktree-manager.ts`）：
- 專案須 git repo；branch 名符合 ref-name 規則；branch 不重複。
- **有 running PTY 綁定該 worktree → 拒絕 merge/abort/cleanup**（不自行 kill PTY，叫人先關）。
- merge：主工作樹 dirty / 不在 base 分支 / 有 project terminal 在跑 → 拒絕。
- merge 衝突：立即 `git merge --abort` 還原主樹，worktree 標 `conflict` 留待人工。
- 開機 `reconcile`：DB active 但目錄消失 → 標 `closed`。
- `assertProjectCanDelete`：有 dirty worktree → 拒絕刪專案。

**merge 實際行為**：`merge()` 在**主專案工作樹**（`project.workspacePath`）執行 `git merge --no-ff --no-edit <worktree.branch>`。**merge 成功 = worktree 分支直接併進 base 分支**，base branch 前進、worktree 標 `merged`；方法不會自行 checkout 或切換分支。

---

## 3. Trusted Resume（J）

- `buildWorktreeResumeCommand(agentProfile, worktreePath, sessionId)` 只接受 allowlisted free profile：`claude-local-main / claude-local-long / claude-local-freeform / claude-local-big / codex-local-main / codex-local-long / codex-local-big`。非 allowlisted → 回 null。
- **綁定時機**：worktree 建立時**不**保存任意指令；只有 agent PTY emit `native_session_id` 後，`bindWorktreeSession` 才把 `{profile, sessionId}` metadata 寫進 worktree（`app-operations.ts:880`）。
- resume 指令由 Coterm **重建**（`Set-Location` + `--resume <sessionId>` + `--dangerously-skip-permissions`），**不從外部讀任意指令字串**；persisted `resume_command` 視為不可信資料，只讀 profile+sessionId，永不 verbatim 執行。
- `POST /worktrees/:id/resume` 只在**已綁定且 live 的 terminal** 回指令（`worktreeResumeInputSchema` 要 `terminalId`，防指令寫進無關專案視窗）。
- resume record 只保存 profile/sessionId metadata；執行環境與 secret 由 terminal profile/runtime 另外提供，不寫進這筆 metadata。
- resume **無 dedicated UI**；走 Agent API 或 renderer IPC。
- 目前 Agent API 沒有 `bind-session` 或「以 worktreeId 開 terminal」端點；只有 UI/renderer 建立的 worktree terminal 能形成 trusted-resume 綁定。

---

## 4. Checkpoint-before-risky-change（B）

**自動 checkpoint（已實作，但範圍有限）**：只 `RunCoordinator.send()` managed turns 有——startTurn 後建 pre-checkpoint，finally 建 post-checkpoint（接 success/error/cancel 所有出口）。失敗記 `failed` 列，**不偽裝成功也不阻擋 turn**。

**目前限制（範圍）**：自動 pre/post checkpoint **不涵蓋**任意原生 PTY keystrokes 或 CLI agent 直接打字——那些沒有 turn 邊界。`checkpoint:create-explicit` 是 renderer IPC，並非人類 UI 或 Agent API；視窗內 agent也不能直接呼叫它。

**目前限制（API）**：checkpoint **沒有 Agent API endpoint**，只在 renderer IPC 層。外部與視窗內 agent 都不得宣稱可直接呼叫 IPC。

**還原契約（preview-first，不可跳步）**：
1. `restorePreview(checkpointId)` → 取 `previewToken` + 當前 `workspaceFingerprint` + `affectedFiles` + `driftDetected`。
2. `restoreCheckpoint(checkpointId, {confirm:true, previewToken})` → token 不符或 fingerprint 漂移 → 拒絕。
3. 逐 hunk：`restoreHunk(checkpointId, filePath, hunkIndex, {confirm:true, previewToken})` → 後端用 `selectUnifiedDiffHunk` 重算該 hunk，**caller 不送 patch 文字**。
4. undo/redo：`checkpoint:undo`（pre-checkpoint of turn N）/ `checkpoint:redo`，同一 preview-first 契約。

**kind 策略**：
- `worktree-commit`：沙箱 branch commit（主樹不動）。
- `git-stash`：非沙箱 git，`git stash create` dangling commit + `stash store` pin（不碰 working tree/index/refs）。
- `file-snapshot`：非 git，`<userData>/checkpoints/`，上限 200 檔/50MB/5MB-檔，**排除 .env/.key/.pem/.pfx/.p12、不跟 symlink**，partial 標記。

hunk restore 已實作（class 註解過時，以程式碼為準）。

---

## 5. Attention 狀態與 Resolve（C）

- 狀態機：`starting → running → waiting_input / approval_required / blocked → done/error`。
- **attention 狀態**（`ATTENTION_STATES`）：`waiting_input / approval_required / blocked / error`。只有這些會發通知。
- `AttentionCenter` 訂閱 `ptyStateChanged`：進入 attention → file notification（每 terminal 最多 1 筆未讀，dedup）；離開 → auto-resolve。
- 通知內容**只有 id + terminalId + projectId + state + source + 時間**。觸發 prompt/指令/approval 文字在 PtyManager 分類後即丟棄，**不存、不 log、不外送**。
- 上限 200 則，溢出淘汰最舊並通知 client 移除。
- 持久化：`<userData>/attention-inbox.json`，atomic write（tmp+rename，失敗退回直寫），損毀開機從空開始不 throw。
- resolve：`attention:resolve`（**IPC，無 Agent API endpoint**）或狀態自然離開。外部 agent 不能直接 resolve；視窗內 agent只能藉由真實狀態轉移讓通知自然結案，人類則可點通知。

**訊號可靠度階層**（`canTransitionTo`）：`process / broker / provider > OSC > screen > activity/quiet heuristic`。main process 用 `@xterm/headless` 維護 live active bottom-buffer，不讀 renderer viewport；profile manifest 規則可進入 attention，但 screen/heuristic **不得覆蓋或清除**已存在的 attention/error。manifest 不認得時才保留舊的 conservative chunk fallback。

**人類 acknowledgement**：desktop/web/mobile 經 renderer IPC 單獨送出的 `source:"human"` `\r` 可解除 `waiting_input / approval_required`，以及 screen/heuristic 產生的 choice-blocked；普通 typing、整包 bracketed/multiline paste（即使內含 CRLF）、soft newline 不解除。Agent API `/input` 固定 `source:"automation"`，即使 `enter:true` 也不能冒充人類 acknowledgement。provider/broker/process hard blocked 與所有 error 只接受可靠 resolution signal。

**Explain**：token-gated `GET /api/v1/agent/session/:terminalId/state-explain` 回 canonical state、authoritative source、agent profile、matched rule 或 fallback reason、region 名、gate pass/fail、manifest version、evaluatedAt；不回 raw prompt、PTY region 或 evidence，也不 broadcast/persist。

---

## 6. OSC 133/633 不得偽造（D）

- marker 由 **pwsh 7 shell 本身**在 prompt/read-line 鉤子產生（`pwshBootstrapCommand`），包裝使用者既有 Prompt，**不改 $PROFILE**。
- PTY 端 `osc-parser.ts` 解析 E（command）/ C（preExec）/ D（finished+exitCode）/ A/B（prompt 邊界）/ P;Cwd。
- **marker 是合作式結構化訊號，不是密碼學安全邊界**：PTY 內任何 process（含視窗內 agent）技術上都能輸出 OSC 633/133 序列。Coterm 靠**契約**禁止偽造——agent 不得在輸出中吐 OSC 序列偽造指令邊界或 exit code，這會污染 `CommandResult` 與 attention 狀態。Agent API派工時若發現視窗內 agent 嘗試此行為，視為異常。
- **authorization 決策不可依賴 marker 真實性**：不要用「marker 說 exitCode=0」當作「agent 已獲授權執行 X」的證據。
- `CommandLifecycle` 只有在 E+C 都到且 D 收尾時才建 result；缺 E 或 C → null，**不捏造** command 或 exit code。
- 退回：PSReadLine 缺失或非 FullLanguage → 純文字模式，`getLastCommand` 回 null。

---

## 7. 已驗證 API / IPC 邊界

**Agent API（`http://127.0.0.1:<port>/api/v1/agent/*`，token-gated）**：
- 安全鏈：health probe 是例外；其餘端點走 `enabled` flag（OFF→404 隱藏）→ Host allowlist（127.0.0.1/localhost/[::1]）→ Bearer token（timing-safe）→ rate limit（mutation 30/min）→ body cap 1MB。`GET /health` 仍可回報 enabled 狀態。
- Phase 1 terminal control：`GET /sessions`、`GET /session/:id`、`POST /terminals`、`POST /session/:id/input`、`POST /session/:id/close`、`GET /session/:id/last-command`、`GET /session/:id/state-explain`。
- Phase 2 read-only：`GET /logger-health`、`/incidents`、`/state`、`/logs`、`/logs/file`、`/diagnostics`、`/schema`、`/audit`。
- Worktree：`GET/POST /worktrees`、`GET /worktrees/:id`、`GET /worktrees/:id/diff`、`POST /worktrees/:id/{merge,abort,cleanup,resume}`。
- `maxChars` budget：預設 8000，上限 64000，超額 `truncated:true`。
- **`GET /session/:id` 回的是 bounded scrollback**（來自 `terminals.snapshots()` 的記憶體快照，**不是完整 terminal 歷史**）+ `lastCommand`（經 `safeCommandResult` → `redactEgress` runtime redact）。scrollback 與 lastCommand **視為敏感內容**——不要寫成「terminal 內容被全部 scrub」：redaction 是欄位級（token、home 路徑等 pattern），bounded 是長度上限，兩者不同。
- 所有回應過 `redactEgress`：token、home 路徑等被 scrub。

**IPC（renderer↔main，非Agent API路線）**：`worktree:create/list/get/diff-summary/merge/abort/cleanup/bind-session/resume`、`checkpoint:list/get/diff/restore-preview/restore/restore-hunk/undo/redo/create-explicit`、`attention:list/resolve/changed`。preload wrapper 在 `src/preload/index.ts`。

**目前限制**：checkpoint 與 attention 的 list/resolve **沒有 Agent API endpoint**，只在 IPC 層。Agent API或視窗內 agent 都**不得宣稱可直接呼叫 IPC**。

---

## 8. 安全停損

1. **同一查找/命令失敗 2 次即換方法**；總工具嘗試自限。
2. **app 內 agent 不得 restart/rebuild/close Coterm**——它跑在裡面會自殺。build/重裝是外部 job，派工時註明「do not commit, do not restart Coterm」。
3. **不 log raw PTY / 對話內容**到 coterm.log（只記 metadata：id/status/count/bytes）。
4. **不把 SQLite raw DB / token / 公司資料同步 GitHub**。
5. worktree **不額外複製 .env/token**（但 git 追蹤的 .env/token 仍會被 `git worktree add` checkout，**不能保證沙箱內不存在** secrets）；merge 前必顯示 diff；非 git snapshot 必排 .env/.key/.pem。
6. **不做通用高權限 MCP router**（MCP 由各 harness 原生管理）。
7. destructive/external 流程用 disposable fixture，預設 BLOCKED，不在真實 userData 盲跑。
8. `/worktrees` endpoint 照完整安全鏈（enabled→Host→Bearer→rateLimited→body）。
9. `assertAllowedPath` 是所有 workspace file op 的 mandatory gate；junction（兩側 canonicalize）與 stale path（`reconcile` 標 closed）是兩個獨立問題，見 USER_GUIDE 排錯段。
10. 派工前用 `GET /sessions` 確認視窗 `cwd`；優先開Agent API自己的 agent-owned 視窗，不關使用者視窗。長 paste 沒送出就補一次 `\r`。
