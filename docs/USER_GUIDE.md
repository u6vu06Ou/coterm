# Coterm 使用者操作手冊

本手冊以**目前程式碼實際行為**為準，不照抄設計願景。標「已實作」代表可在現有版本操作；標「目前限制」代表程式碼未提供或需人工步驟。文件日期：2026-07-15。

---

## 3 分鐘 Quick Start

1. 啟動 Coterm（`npm run dev` 或安裝版）。左側欄列出已加入的專案資料夾。
2. 在專案上點 **「+」**（`sidebar.project.open-agent`）→ 開一個純 PTY 視窗，並彈出 LLM 選擇器；選 profile 即把啟動指令貼入並自動 Enter。
3. 想隔離跑：改點專案列的 **「⋯」→「開啟沙箱 agent」**（`sidebar.project.open-sandbox`）→ 自動建 git worktree 沙箱再開 agent。
4. 任何時候按 **`Ctrl+Shift+P`** 開 Command Palette（指令面板），搜尋並執行任意已掛載動作；按 **`Ctrl+K`** 則聚焦側欄搜尋框（跨專案/對話/session 全文搜尋，非 palette）。
5. 視窗需要你批准/輸入時，側欄專案旁出現紅色 attention 數字；點進去處理。
6. 若這次工作是 Coterm `RunCoordinator` 管理的回合，可用 TopBar 的 checkpoint 按鈕（`topbar.checkpoint.toggle`）開右側 rail 看 pre/post 快照；一般原生 PTY agent 不會自動產生 checkpoint。

預設 shell 為 **pwsh 7**（找不到才退回 Windows PowerShell 5.1）。

---

## E. Command Palette（指令面板）

| 項目 | 說明 |
|---|---|
| 何時用 | 不記得按鈕在哪、或想用鍵盤快速叫出任意動作 |
| 怎麼做 | 按 `Ctrl+Shift+P` → 輸入關鍵字 → ↑↓ 選 → Enter 執行 |
| 看到什麼 | 搜尋框 + 動作清單（每項顯示 label 與 `data-action-id`），上限 50 筆 |
| 風險 | 破壞性/外部動作（`risk` 標記）第一次點會進入**二次確認**模式，需再點一次 |
| 限制 | Palette 只列出**當下已掛載在 DOM** 的動作（對話框/選單未開時不出現）；`palette.item.select` 是單一 audit ID，不逐項 audit |

實作：`src/renderer/src/components/CommandPalette.tsx`、`src/renderer/src/action-registry.ts`、`App.tsx:55` 註冊 `Ctrl+Shift+P`。側欄搜尋（`Ctrl+K`）是另一條路線，見 `Sidebar.tsx:89`。

---

## F. xterm Engine Pack（終端引擎強化）

| 項目 | 說明 |
|---|---|
| 何時用 | 降低大量輸出的渲染負擔、終端機內搜尋、改善繁中/emoji 字寬 |
| 怎麼做 | 自動載入；**Ctrl+F** 開終端機內搜尋覆蓋層 |
| 看到什麼 | WebGL 渲染（無 GPU 或黑名單時自動退回 canvas，不報錯）；繁中字寬正確 |
| 限制 | web 端退回 DomRenderer 時可能踩既有 CSP inline style bug（非 F 引入）；序列化 addon 為未來 session 還原鋪路，目前還原仍靠 PTY bytes |

實作：`TerminalDock.tsx` 載入 `addon-search / webgl / serialize / unicode-graphemes / progress`。WebGL 必須在 `terminal.open()` 之後載入，其餘在 open 之前。

---

## D. Structured Shell Integration（OSC 133/633 指令邊界）

| 項目 | 說明 |
|---|---|
| 何時用 | 想讓 Coterm 看懂每個指令的 cwd / exit code / 換行邊界（也是 C 的訊號源） |
| 怎麼做 | pwsh 7 啟動時自動注入 OSC 633 marker（包裝你的 Prompt 與 PSConsoleHostReadLine，**不改你的 $PROFILE**） |
| 看到什麼 | Coterm 內部拿到 `CommandResult { command, cwd, exitCode, startedAt, endedAt }`；Agent API 的 session/last-command 與 checkpoint evidence 可使用這些資料 |
| 限制 | **只 pwsh 7**；PSReadLine 缺失或語言模式非 FullLanguage 時靜默退回純文字（`getLastCommand` 回 null）；bash/zsh/cmd 無 marker |
| 風險 | marker 是**合作式結構化訊號**，不是密碼學安全邊界：PTY 內任何 process（含 agent）技術上都能輸出 OSC 序列。Coterm 靠**契約**禁止偽造，authorization 決策**不可依賴** marker 真實性 |

實作：`pty-manager.ts` 的 `pwshBootstrapCommand()` + `osc-parser.ts`。退回條件已內建。

---

## C. Agent Attention Center（注意力收件匣）

| 項目 | 說明 |
|---|---|
| 何時用 | 同時開多個 agent 視窗，不想輪流點開看哪個在等你 |
| 怎麼做 | 視窗進入 `waiting_input / approval_required / blocked / error` 時，側欄專案旁亮紅色 badge |
| 看到什麼 | attention 收件匣列未讀通知（**只有 id + 狀態 + 來源 + 時間，沒有 prompt/指令內容**）；橘框與藍色 active 框同為 3px，不改 pane 幾何；離開 attention 狀態自動 resolve |
| 怎麼解除 | 明確的人類 Enter（含接受預設選項的空白 Enter）會解除 `waiting_input / approval_required`，也會解除 screen/heuristic 誤歸類的 choice-blocked；純打字、整包多行 paste（即使內含換行）、soft newline、Agent API automation input 都不會提早解除 |
| 限制 | 通知上限 200 則，超過淘汰最舊；**手機端差異見後段**；screen/heuristic 不能清除既有 attention，provider/broker/process hard blocked/error 也不會被普通 Enter 清除 |
| 風險 | 收件匣只存 metadata，觸發文字在 PtyManager 分類後即丟棄，不寫入 coterm.log |

偵測依據是 main process 的 live terminal bottom-buffer，不跟著使用者 scroll viewport。Claude Code/Codex 使用 bundled 規則；進階使用者可在 `<userData>/agent-detection/*.json` 放本機 override，通過 Zod/regex/大小驗證後熱重載。無效檔案不會取代上一個有效版本。

實作：`src/main/terminal/agent-detection/`、`src/main/terminal/pty-manager.ts`、`src/main/core/attention-center.ts`、`src/shared/pty-state.ts`。狀態機：`starting → running → waiting_input / approval_required / blocked → done/error`。

---

## A. Worktree Sandbox（git 隔離沙箱）+ J. Trusted Resume

| 項目 | 說明 |
|---|---|
| 何時用 | 要讓 agent 改 code，但不想弄髒主資料夾 |
| 怎麼做 | 側欄專案「⋯」→ **開啟沙箱 agent**；自動 `git worktree add` 建分支沙箱在 `<userData>/worktrees/<projectId>/<id>/`，再開 agent 視窗（cwd=沙箱路徑） |
| 看到什麼 | agent 只改沙箱；主資料夾乾淨 |
| 限制 | 專案必須是 **git repo**（不會自動建 repo）；沙箱有 running PTY 時**拒絕** merge/abort/cleanup（先關視窗）；merge 只在主工作樹乾淨且停在原 base 分支時允許 |
| 風險 | worktree 共用 .git，Coterm **不額外複製** .env/token；但 git worktree 仍會 checkout 已被 git 追蹤的 .env/token，**不能保證沙箱內不存在** secrets。merge 衝突會立即 `git merge --abort` 還原主樹，沙箱留著待人工修 |

**目前限制（UI/API）**：UI 目前只有「開啟沙箱 agent」一個入口；**diff / merge / abort / cleanup / resume 沒有專屬 UI**。Agent API 可建立 worktree record、查 diff 與管理 lifecycle，但 `POST /worktrees` **不會順便在該 worktree 開 terminal**，而 `POST /terminals` 目前也不收 `worktreeId`。要真正開一個 cwd 位於沙箱的 agent，請從 UI 的「開啟沙箱 agent」進入。

**merge 實際行為**：`WorktreeManager.merge()` 在**主專案工作樹**（`project.workspacePath`）跑 `git merge --no-ff --no-edit <worktree.branch>`；主樹須乾淨、停在 base 分支、無 running PTY。**merge 成功 = worktree 分支直接併進 base 分支**（base branch 前進）。

**J. Trusted Resume（已實作）**：agent emit `native_session_id` 後，Coterm 才把 `{profile, sessionId}` metadata 綁到 worktree（**不是建立 worktree 時保存任意指令**）。重開可由 `POST /api/v1/agent/worktrees/:id/resume` 取回**由 Coterm 重建**的 resume 指令；允許 `claude-local-main / claude-local-long / claude-local-freeform / claude-local-big / codex-local-main / codex-local-long / codex-local-big`。執行環境與 secret 不放進 resume metadata。resume **無 dedicated UI**，且必須是先前已由 UI/IPC 建立並成功綁定 session 的 worktree。

實作：`src/main/core/worktree-manager.ts`、`src/main/core/app-operations.ts` 的 `bindWorktreeSession`/`resumeWorktree`、`src/main/providers/agent-launch.ts` 的 `buildWorktreeResumeCommand`。

---

## B. Checkpoint / Diff / Undo-Redo Review Rail

| 項目 | 說明 |
|---|---|
| 何時用 | agent 跑完一輪，想看改了哪些檔、退回某輪、或逐 hunk 還原 |
| 怎麼做 | TopBar checkpoint 按鈕開右側 rail（與 artifact rail 互斥） |
| 看到什麼 | checkpoint 清單 → changed files / stat / 逐檔 unified diff（上限 256KB） |
| 還原流程 | **preview-first**：先 `restorePreview` 取 token + fingerprint → 再 `restoreCheckpoint` 帶 `confirm:true` + 同一 token。fingerprint 漂移就拒絕 |
| 限制 | 非 Git 專案用檔案 snapshot（上限 200 檔 / 50MB / 5MB-檔，**排除 .env/.key/.pem**，不跟 symlink）；partial 會標記不謊稱完整 |
| 風險 | Git 非沙箱模式用 `git stash create`（dangling commit，**不碰 working tree/index**）；沙箱模式用 branch commit。絕不在你 dirty working tree 偷偷 commit |

**已實作**：整個 checkpoint 還原、**逐 hunk 還原**（`restoreHunk` + `selectUnifiedDiffHunk`，依檔案路徑+index 由後端重算，caller 不送 patch 文字）、undo/redo（走同一 preview-first 契約）。

**目前限制（自動 checkpoint 範圍）**：自動 pre/post checkpoint **只涵蓋 `RunCoordinator` managed turns**（`RunCoordinator.send()` startTurn 後建 pre、finally 建 post，接 success/error/cancel 所有出口）。**不涵蓋**任意原生 PTY keystrokes 或 CLI agent 直接在終端打字——那些沒有 turn 邊界，不會自動 checkpoint。`checkpoint:create-explicit` 目前只是 renderer IPC 能力，尚無人類 UI 按鈕或 Agent API endpoint；所以原生 PTY 工作今天不能靠 UI 手動補建 Coterm checkpoint。失敗只記 `failed` 列，**不阻擋 turn**；沒有「每個危險指令自動 checkpoint」的行為。

**目前限制（API）**：checkpoint **沒有 Agent API endpoint**，只在 renderer IPC 層（`checkpoint:list/get/diff/restore-preview/restore/restore-hunk/undo/redo/create-explicit`）。外部或視窗內 agent 都不得宣稱能直接呼叫 renderer IPC；人類可用 rail 檢視／還原已存在的 checkpoint，新的 renderer 整合則可透過 preload wrapper 呼叫 IPC。

實作：`src/main/core/checkpoint-manager.ts`、`src/main/core/run-coordinator.ts:79,259`、`src/renderer/src/components/CheckpointRail.tsx`。

---

## junction / stale path 排錯

- **junction / symlink 路徑**：`assertAllowedPath` 採「兩側都 canonicalize 再比」策略：`mustExist:true` 時 candidate 與 roots 都先 `realpath`，junction（例如把雲端硬碟目錄用 junction 掛到別槽）會被解成同一目標，**不再誤判路徑逃逸**。若仍看到 `Path is outside the allowed workspace`，先確認正在跑的是含此修正的版本。
  - `mustExist:false`（worktree 建立前目錄不存在）：先 lexical containment，再「最近存在祖先 realpath」檢查，擋掉 symlink 逃逸。
- **worktree stale 目錄**：`<userData>/worktrees/` 下若手動刪目錄，開機時 `WorktreeManager.reconcile` 會把 DB 中 active 但目錄已消失的 worktree 標成 `closed`。stale 目錄與 junction 路徑是**兩個獨立問題**，分開排查。
- **專案路徑真的不存在**：先在 terminal 跑 `Test-Path -LiteralPath '<你的專案路徑>'` 確認。若是 `False`，這不是安全閘誤判；請確認該資料夾存在，或在 Coterm 移除舊專案後重新加入正確位置。

實作：`src/main/security/path-policy.ts`。

---

## 手機 / 網頁差異（已查證）

| 面向 | 桌面 | 手機（`isMobile` / max-width 600px） | 網頁 |
|---|---|---|---|
| Dock 顯示 | 全部 tile，2D 可拖曳 | **只顯示被選的 tile**（exclusive） | 同桌面 |
| 選取 | 點 tile 即選，3px 藍框 | 自動 exclusive，可由 TopBar 切換 | 同桌面 |
| attention | 側欄 badge + 收件匣 | 同（WS 廣播） | 同 |
| 載入 | xterm 全 addon | WebGL 依裝置 GPU，可能退回 canvas | 可能踩 CSP inline style bug |
| 進入點 | 側欄 + TopBar | 側欄收合，TopBar 簡化 | 同桌面 |

**未查證/不寫**：推播到原生手機通知（code 無證據，標限制）。attention 的 WS 廣播會到所有端，但「手機原生推播」目前沒有實作證據。

---

## 通用限制與安全邊界

- app 內 agent **不得 restart/rebuild/close Coterm**（它跑在裡面會自殺）；build/重裝是外部工作。
- coterm.log 只記 metadata，**不寫 raw PTY / 對話內容**。
- worktree 不額外複製 .env/token（但 git 追蹤的仍會 checkout，見 A 段）；merge 前必顯示 diff。
- Agent API（Agent API）只驅動免費 profile：`claude-local-main / claude-local-long / claude-local-freeform / claude-local-big / codex-local-main / codex-local-long / codex-local-big`。
- 最多 8 個 terminal tile；exited 的 tile 自動清理不洩漏。
