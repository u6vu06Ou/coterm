---
name: coterm-setup
description: >-
  Guide a first-time user through installing, building, and configuring Coterm
  (the terminal-first desktop workspace for coding agents), connecting their own
  AI CLI (Claude Code, Codex, Gemini CLI, or any terminal agent with their own
  API key or subscription), enabling the Agent API and phone/web remote control,
  and driving multi-pane agent orchestration. Trigger when the user wants to set
  up Coterm, run it from source, point it at their own model backend, call its
  localhost agent API, or have an agent open and drive other Coterm panes.
---

# Coterm Setup — Agent Guide

You are helping a user set up **Coterm** on their machine. Coterm is an Electron
desktop app: a terminal-first workspace where each pane is a real PTY (PowerShell,
cmd, WSL, bash, zsh) that can run interactive AI CLIs (Claude Code, Codex, Gemini
CLI, …) with their native TUI, slash commands, and OAuth flows intact. It mirrors
the panes to a browser/phone over a built-in WebSocket server and exposes a
localhost-only, token-gated **Agent API** for observation and keystroke injection.

Read the repo docs as you go — they are the contract of record:

- `README.md` — feature overview and install commands.
- `docs/ABCDEF_USER_GUIDE.md` — every UI feature, keyed to actual code behavior.
- `docs/AGENT-API.md` — the full agent REST/MCP API with curl and PowerShell examples.
- `docs/CUSTOMIZING.md` — profiles.json, Settings fields, worked examples.
- `docs/PLATFORM-SUPPORT.md` — per-OS support tiers and known gaps.

Rules for you (the helping agent):

- **Do not invent features.** If something is not in the docs or the UI source,
  it does not exist. Say so instead of guessing.
- **The user brings their own AI accounts.** Do not assume any proxy, free
  backend, or shared infrastructure. Claude Code users sign in with their own
  Anthropic subscription/API key; Codex users with their own OpenAI account, etc.
- **Never restart, rebuild, or close a running Coterm from inside an agent pane**
  — the agent runs inside it and would kill itself.
- Verify every step before moving on (each step below says how).

Naming gotcha: the app's userData folder is still named after its old product
name. On Windows, `<userData>` = `%APPDATA%\Coterm` (stable channel) or
`%APPDATA%\Coterm Beta` (beta channel). The newer `%APPDATA%\Coterm` name
appears in some docs; check both. `<userData>` can also be overridden with the
`COTERM_USER_DATA_DIR` env var.

---

## Step 1 — Prerequisites (Windows-first)

| Need | Why | Verify |
|---|---|---|
| Node.js **24.x** | build/runtime contract (`.node-version`, `package.json.engines`) | `node -v` prints `v24.*` |
| npm | deps + postinstall (`electron-builder install-app-deps`) | `npm -v` |
| Git | worktree sandbox features need the project to be a git repo | `git --version` |
| PowerShell 7 (`pwsh`) | default shell; falls back to Windows PowerShell 5.1 if missing | `pwsh -v` |
| The AI CLIs the user wants | e.g. `claude`, `codex`, `gemini` on PATH | `claude --version`, etc. |

**macOS / Linux:** Tier 2, untested, no installer. Run from source only. The
default shell resolver returns `pwsh.exe`, so on non-Windows the user must pick
the `bash` or `zsh` profile when creating a terminal. `claude`/`codex` are
invoked by bare name (must be on PATH). No DMG/AppImage build target exists.

## Step 2 — Install / build

From source (any platform):

```bash
git clone <repo-url> coterm
cd coterm
npm install        # postinstall rebuilds native modules (node-pty, sqlite)
npm run dev        # launch the dev app
```

Windows installer:

```bash
npm run dist       # build + electron-builder → release/Coterm-<version>-Setup.exe
```

**Verify:** the Coterm window opens; a sidebar lists projects (empty on first
run); no crash log entries in `<userData>/logs/crash.log`.

Common errors:

- `npm install` fails on `node-pty`/native modules → wrong Node version; switch
  to Node 24.x and re-run.
- Dev window never appears → check `<userData>/logs/coterm.log` and the console
  you launched from; single-instance lock means a second copy exits silently —
  close the running one first.

## Step 3 — Connect the user's own AI CLI

Coterm does not ship model access. A **profile** is a named launch configuration
that Coterm pastes into a new pane to start an agent. Three supported routes,
in order of what most users want:

### 3a. Official CLIs with the user's own account (most common)

- **Claude Code:** profile `claude-official`. Coterm launches the user's installed
  `claude` CLI as-is — their own login, subscription, or `ANTHROPIC_API_KEY` is
  used. Nothing to configure in Coterm.
- **Codex:** the Codex harness profiles launch the user's installed `codex` CLI;
  sign-in happens in the codex CLI itself.
- **Any other terminal agent** (Gemini CLI, Aider, …): open a plain terminal pane
  and run it — Coterm is just a real PTY; full TUI and OAuth flows keep working.

**Verify:** sidebar `+` on a project → picker opens → choose the profile → the
pane shows the agent's own UI and is signed in (for `claude`, `/status` shows the
user's account).

### 3b. A different provider via Settings → Custom models (no code)

Settings → **Custom models → Add**: give an id (ids starting with `codex-` run on
the Codex harness, everything else runs on the Claude harness), the model name,
the provider base URL (OpenRouter, Groq, any OpenAI/Anthropic-compatible
endpoint), and the auth token. Saved entries appear in the `+` menu immediately,
no restart. Tokens are stored in the local DB, never shown or logged.

**Verify:** the new model appears in the `+` picker; launching it connects to the
provider (agent answers a trivial prompt).

### 3c. A self-hosted/local proxy bridge

Only if the user runs their own loopback proxy. Edit `<userData>/profiles.json`
(created on first launch; restart required) — set `proxyUrl` / `authToken`, and
mark profiles `local: true`. Full worked example in `docs/CUSTOMIZING.md` §1.

**Verify:** launch a `local:true` profile, then in that pane run
`echo $env:ANTHROPIC_BASE_URL` (pwsh) — it must print the proxy URL.

## Step 4 — UI tour (what every control does)

Everything below exists in the current code; teach the user by having them click.

**Sidebar**

- **Project list + `+`** — add project folders; `+` opens a new agent pane with
  the LLM picker (the choice is pasted in and auto-entered).
- **Project `⋯` → 開啟沙箱 agent (sandbox agent)** — creates a git worktree sandbox
  under `<userData>/worktrees/…` and opens the agent pane with cwd inside it, so
  the agent never touches the main checkout. Project must be a git repo.
  Diff/merge/abort/cleanup of the sandbox currently have **no dedicated UI**
  (they exist in the Agent API / IPC layer).
- **Red attention badge** — a pane needs a human (approval/question/error). The
  inbox (metadata only: id, state, source, time — never prompt text) lists them;
  leaving the state auto-resolves.
- **`Ctrl+K`** — focus the sidebar cross-project search box.

**TopBar**

- **Quota bars** — remaining paid Claude 5h / 7d and Codex 7d quota (green
  > 30 %, yellow 5–30 %, red ≤ 5 %; `--` when the account cache is missing).
  Hover shows reset countdown. Nothing to configure for official accounts.
- **Context battery** — 10-segment context-window meter for official
  Claude/Codex profiles (from the CLI's own session file, refreshes every 10 s).
- **Checkpoint button** — opens the right rail with pre/post snapshots of
  run-coordinated turns: changed files, per-file diffs, whole-checkpoint or
  per-hunk restore, undo/redo (always preview-first + confirm). Plain typing in a
  PTY is **not** auto-checkpointed — only managed turns are.
- **PTY lamps on pane buttons (1–max)** — yellow = agent outputting, green =
  idle/finished, red = needs a human decision. Red never clears itself.

**Terminal panes**

- Real ConPTY (pwsh by default, falls back to powershell 5.1); tabs/splits;
  2D drag-resizable dock; up to the configured tile cap (currently 12; older
  docs say 8 — the running app wins).
- **`Ctrl+F`** in-terminal search; WebGL renderer with automatic canvas fallback.
- Select text with the mouse to copy: `Ctrl+C` copies when a selection exists,
  interrupts when not.

**Command palette** — `Ctrl+Shift+P`, lists mounted actions; destructive ones
ask for a second click.

**Settings (gear)** — what needs configuring:

| Section | Needs action? |
|---|---|
| Theme / code theme / terminal theme / terminal font & size | Optional (dark by default). |
| Sidebar Provider (default profile for `+`) | Optional. |
| Bridge Proxy | Only for route 3c. Leave default otherwise. |
| Custom models | Route 3b. |
| **Agent API** (toggle + token show/hide) | Step 5 — ON by default since 1.5.4. |
| Agent rate limits (terminal / browser buckets) | Optional; defaults 30/min each. |
| Voice (dictation, live voice, STT/Gemini keys & URLs) | Optional; off until the user supplies keys/URLs. |
| Browser network policy (allow private/local, allowlist) | Only for browser automation into LAN hosts. |
| Browser superpowers P0/P1 (batch, download, dialogs…) | Optional; off = those actions fail closed. |
| Backup / restore | Optional manual export/restore. |
| Retention (log/conversation pruning) | Optional. |

## Step 5 — Agent API (localhost automation for the user's own tools)

**What it is:** a REST API under `http://127.0.0.1:43127/api/v1/agent/*` that
lets scripts/agents the *user* authorizes read terminal state and inject
keystrokes. Enabled by default (1.5.4+); toggle in Settings → Agent API.

**Token:** a random bearer token written to `<userData>/agent-api-token.txt` and
also readable (show/hide) in Settings → Agent API. Treat it as a credential —
anyone holding it can drive the panes.

**Security chain (in order):** enabled flag (off → 404) → Host-header allowlist
(only `127.0.0.1` / `localhost` / `[::1]` with the right port) → timing-safe
Bearer check → rate limit (30/min per client, separate terminal/browser buckets,
watch the `X-RateLimit-*` headers) → 1 MB body cap. All responses pass egress
redaction (tokens, home paths scrubbed).

**Probe first (no token needed):**

```bash
curl -s http://127.0.0.1:43127/api/v1/agent/health
# → {"ok":true,"enabled":true}
```

**MCP clients** (Claude Code, Codex, Cursor): a streamable-HTTP MCP endpoint
lives at `POST /api/v1/agent/mcp` (stateless JSON-RPC, same token). The repo
ships `.mcp.json` pointing at it with `${COTERM_AGENT_TOKEN}` — tell the user to
set that env var to the token contents, or register the URL globally.

**Verify:** probe returns `enabled:true`; then with the token,
`GET /sessions` returns `"ok": true`.

Common errors:

| Symptom | Cause / fix |
|---|---|
| `404` on every route | API disabled in Settings (or wrong port). |
| `401 Invalid agent token` | Wrong/stale token; re-read the token file after toggling the API (it regenerates). |
| `403 Host rejected` | Called via another hostname/IP; use `127.0.0.1` with the correct port. |
| `429 rate_limited` | Respect `retryAfterMs` / `Retry-After`; raise the bucket in Settings only if truly needed. |

## Step 6 — Phone / web remote control

**The server binds loopback only** (`127.0.0.1`, default port 43127; beta uses
43128; override with `COTERM_WEB_PORT`, must be 20000–49151). It intentionally
never listens on LAN. To drive Coterm from a phone or another machine, the user
puts an identity-aware tunnel in front of that loopback address and configures
Coterm to trust the tunnel's identity:

`%LOCALAPPDATA%\Coterm\remote-config.json`:

```json
{ "authMode": "tailscale", "allowedLogin": "user@example.com" }
```

or Cloudflare Access:

```json
{ "authMode": "cloudflare", "teamDomain": "<team>.cloudflareaccess.com", "audience": "<AUD tag>" }
```

Optional fields: `allowedOrigin`, `allowedHosts` (extra Host headers), and env
var equivalents `COTERM_AUTH_MODE`, `COTERM_ACCESS_TEAM_DOMAIN`, `COTERM_ACCESS_AUD`,
`COTERM_ALLOWED_LOGIN`, `COTERM_ALLOWED_ORIGIN`, `COTERM_ALLOWED_HOSTS` (env wins).
Restart Coterm after editing. Without this config the web server still serves
the loopback UI; remote requests are never accepted unauthenticated.

**Verify:** from the phone (on the tailnet / through the Access hostname), open
the tunnel URL → the dock mirrors; selecting a pane on the phone selects it on
the desktop. If the user gets auth errors, the tunnel is not injecting the
identity headers Coterm verifies — check the tunnel config, not Coterm.

## Step 7 — Multi-pane orchestration (an agent driving other panes)

Everything here is supported by Coterm's own API today. Patterns that work:

0. **Check capacity first:** `GET /api/v1/agent/resources` (read-only, not
   rate-limited) returns CPU/RAM plus `recommendedMaxNewAgents` — use it before
   fanning out. `GET /sessions` tells you free dock slots (`availableSlots`).
1. **Open a worker pane:** `POST /terminals` with `projectId`, `agentProfile`,
   `task`. Only profiles from `supportedAgentProfiles()` can be auto-launched —
   every profile marked "local proxy" (`local:true`: the built-ins `claude-local-main`,
   `claude-local-long`, `claude-local-freeform`, `claude-local-big`, plus custom-model
   entries registered in Local-proxy mode) and the Codex free list
   (`codex-local-main`, `codex-local-long`, `codex-local-big`). Official/paid profiles
   (`claude-official`, `codex-official`, `gemini`, direct-provider custom
   models) are deliberately **not** API-launchable: open a plain tile and drive
   it via `input` instead.
2. **Read state without interrupting:** `GET /session/:id` — note the
   `scrollbackMode` contract: for fullscreen TUIs (`alternate-screen`) the
   byte-ring `scrollback` is always `""`; read `screenText` (bounded live screen)
   instead and never poll in a loop. `GET /session/:id/state-explain` returns
   metadata only (canonical state, matched rule) without content.
3. **Wait instead of polling:** `GET /session/:id/wait?state=done&timeout=120`
   blocks event-driven until a state, a regex `match`, or `staleAfterSec` fires —
   outcomes `matched|match|stale|interrupted|timeout|closed|shutdown`. Max
   4 concurrent waits per terminal, 32 global (`429 WAIT_LIMIT_EXCEEDED`).
4. **Inject input:** `POST /session/:id/input` `{data, enter:true}`. Prefer a
   stable `clientMutationId` for exactly-once retries (same id+payload →
   `deduped:true`; same id different payload → `409 mutation_conflict`). Note:
   API input is `source:"automation"` — it never counts as human acknowledgement
   of an approval prompt.
5. **Hand off work between panes:** `POST /session/:id/handoff-packet` builds a
   redacted, size-bounded packet + `formattedPrompt` for a target profile.
6. **Pane-to-pane chat:** agents inside panes have the `cot` CLI on PATH
   (mailbox `POST /api/v1/mail/send` under the hood, per-pane token, works even
   when the Agent API toggle is off). `cot who` to discover handles.
7. **Clean up:** `POST /session/:id/close` — agent-owned panes close freely;
   user-opened panes need `allowUserTerminal:true` (ask the human first).
8. **Fixed two-role workflow:** `POST /api/v1/agent/workflow` runs a persisted
   implementer → read-only-reviewer loop (≤ 3 cycles) in a fresh worktree;
   `GET /workflow/:id`, `/pause`, `/resume`, `/cancel` manage it. It will not
   merge, commit, push, or approve anything.

**Verify (end-to-end):** probe → `/resources` → open one pane with a trivial
task (`"reply with OK"`) → `wait?state=done` → read the pane → close it.

Do **not** describe checkpoint/attention control over the API — those have no
Agent API endpoints (IPC only); use the UI rail / inbox.

## Step 8 — Final checklist for the user

- [ ] App launches; project added; one agent pane runs their own AI CLI signed
      in with their own account.
- [ ] Quota bars / context battery show data (official profiles) or `--` cache
      missing (harmless).
- [ ] Agent API probe returns `enabled:true`; token file exists.
- [ ] (Optional) remote tunnel + `remote-config.json` in place; phone mirrors the dock.
- [ ] Sandbox button works on a git project (creates a worktree pane).

Useful logs when stuck: `<userData>/logs/coterm.log` (JSON lines, metadata only
— never raw terminal content), `<userData>/logs/crash.log`, and the Agent API
`GET /diagnostics` / `GET /incidents?window=5m` endpoints.
