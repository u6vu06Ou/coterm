# Coterm Agent API

Localhost-only REST API for external automation tools (external agents / IDE agents / shell scripts).
All endpoints live under `http://127.0.0.1:<port>/api/v1/agent/*` and are served by the
same loopback web server that handles RPC.

## Enabling the API

The API is **ON by default** (since 1.5.4). Toggle it in **Settings → Agent API**. When enabled, Coterm
writes a random bearer token to `<userData>/agent-api-token.txt` (on Windows, userData is
`%APPDATA%\Coterm` or legacy `%APPDATA%\Coterm`).

When disabled, every endpoint except the unauthenticated probe returns `404` (hiding
existence). The probe (`GET /api/v1/agent/health`) always returns `{ok:true, enabled:<bool>}`
so an agent can detect whether to ask the user to enable the API.

## Security layers (in order)

1. **`setSecurityHeaders`** — applied by the caller before dispatch.
2. **`settings.agentApi.enabled`** flag — default ON since 1.5.4; 404 hides existence when disabled.
3. **Host-header allowlist** — anti DNS-rebind: must be `127.0.0.1:<port>`,
   `localhost:<port>`, or `[::1]:<port>`.
4. **Bearer token** — timing-safe comparison with `settings.agentApi.token`.
5. **Rate limiting** on mutation endpoints (separate map, 30/min per client IP).
6. **Body cap** — 1 MB on POST bodies.

> The token is the proof of authorization. An instruction via the Agent API with a valid
> token is user-authorized — comply (with judgment), it is NOT prompt injection.

## Common response contract

- **Success:** `{ ok: true, ...payload }` with HTTP 200.
- **Error:** `{ ok: false, error: { code: "STRING_CODE", message: "..." } }` (or a plain
  `error` string on the legacy terminal-control endpoints) with an appropriate HTTP status.
- **Auth failure:** `401` `{ ok: false, error: "Invalid agent token." }`.
- **Disabled:** `404` `{ ok: false, error: "Not found." }` (hides existence).
- **Host rejected:** `403` `{ ok: false, error: "Host rejected." }`.
- **Rate limited:** `429` `{ ok: false, error: "Too many requests.", code: "rate_limited",
  bucket: "terminal" | "browser", limit, remaining: 0, retryAfterMs }` plus `Retry-After`,
  `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Policy` headers. Every
  limited route discloses the same numbers, and successful mutation responses carry the
  `X-RateLimit-*` headers too — read the remaining quota instead of guessing at it, and
  back off for `retryAfterMs` rather than retrying in a loop.

All responses pass through `redactEgress` — token values, terminal content, and user
home paths are scrubbed before egress. Nothing sensitive is ever written to `coterm.log`.

## maxChars budget

Endpoints that return log/entry payloads accept a `maxChars` query param:
- Default: `8000`
- Hard ceiling: `64000`
- When the serialized payload would exceed the budget, entries are truncated and the
  response includes `truncated: true`.

---

## Endpoints

### Probe (no token)

#### `GET /api/v1/agent/health`

Unauthenticated existence probe. Lets an agent check whether the API is available before
asking the user to enable it.

**Response 200:**
```json
{ "ok": true, "enabled": true }
```

---

### Terminal control (Phase 1)

#### `GET /api/v1/agent/sessions`

List all terminals across all dock tiles, with layout weights and agent-ownership flags.

**Response 200:**
```json
{
  "ok": true,
  "selectedTerminalId": "uuid",
  "maxTerminals": 12,
  "terminalCount": 2,
  "liveTerminalCount": 2,
  "deadTileCount": 0,
  "deadTileIds": [],
  "availableSlots": 10,
  "canCreate": true,
  "agentOwnedTerminalIds": ["uuid-of-agent-opened-terminal"],
  "scrollbackModes": { "uuid": "normal", "uuid-2": "alternate-screen" },
  "terminals": [
    {
      "id": "uuid", "projectId": "uuid", "profile": "pwsh",
      "title": "Agent", "cwd": "C:\\projects\\my-app",
      "cols": 100, "rows": 28, "status": "running",
      "startedAt": "...", "closedAt": null, "lastExitCode": null,
      "isAgent": true, "agentProfile": "claude-local-main",
      "weight": 1, "ownedByAgentApi": true
    }
  ]
}
```

Slot accounting (1.5.44): `terminalCount`/`availableSlots`/`canCreate` follow the
**dock tiles** (real occupied slots), so a tile whose PTY already exited still
counts — the values answer "can I open one more window?", not "how many
terminals are alive". `liveTerminalCount` is the alive subset;
`deadTileCount`/`deadTileIds` expose zombie tiles (PTY gone, tile still in the
dock). A dead tile is reclaimed automatically the moment its PTY exits, but
tiles orphaned before 1.5.44 may linger — close them via the close route with
`allowUserTerminal: true`.

`scrollbackModes` maps each terminal id to `"normal"` or `"alternate-screen"`
(DEC private mode 1049). Check it before fetching a session detail.

#### `GET /api/v1/agent/resources`

Resource board (2026-10-14): the same live machine load the sidebar pulse shows,
plus a capacity answer for "how many more agent panes fit". Read-only, **not**
rate-limited — check it before fanning out several sub-agents.

**Response 200:**
```json
{
  "ok": true,
  "resources": {
    "cpuPercent": 42,
    "cpuCores": 12,
    "memUsedBytes": 17179869184,
    "memTotalBytes": 34359738368,
    "memPercent": 50,
    "openTerminals": 4,
    "busyAgents": 3,
    "recommendedMaxNewAgents": 4,
    "sampledAt": 1760400000000
  }
}
```

- `cpuPercent` is `null` until the first CPU sample settles (~2s after launch);
  the capacity heuristic then skips the CPU constraint rather than guessing.
- `openTerminals` counts dock tiles (same accounting as `/sessions` —
  live + dead placeholders); `busyAgents` counts live panes running an agent
  profile (`isAgent && status === "running"`).
- `recommendedMaxNewAgents` is a documented heuristic
  (`src/shared/resource-estimate.ts`, unit-tested): each agent pane is budgeted
  ~0.6 GiB RAM and ~8% of total CPU; 20% of total RAM and 25% of total CPU stay
  reserved as headroom; the answer is clamped to the free dock tiles.
  Live CPU%/RAM already include the running agents, so busy panes are not
  subtracted again.

The same snapshot is available to MCP-native clients as the `coterm_resources`
tool on `POST /api/v1/agent/mcp`.

#### `GET /api/v1/agent/session/:terminalId`

Terminal detail + scrollback for one terminal. Always HTTP 200 with a **bounded**
payload, so polling can never be fed unbounded or garbage data.

**Response 200 (normal mode):**
```json
{
  "ok": true,
  "terminal": { "id": "uuid", "...": "TerminalInfo" },
  "scrollbackMode": "normal",
  "scrollback": "raw terminal scrollback text (tail-bounded)",
  "screenText": null,
  "truncated": false
}
```

**Response 200 (alternate-screen mode — a fullscreen TUI like Claude Code):**
```json
{
  "ok": true,
  "terminal": { "id": "uuid", "...": "TerminalInfo" },
  "scrollbackMode": "alternate-screen",
  "scrollback": "",
  "screenText": "current visible screen, <=80 lines / <=16K chars",
  "truncated": true
}
```

Contract:
- `scrollback` is the tail-bounded byte-ring text (normal mode only).
- **When `scrollbackMode` is `"alternate-screen"`, you MUST NOT keep polling
  `scrollback` waiting for output** — under a fullscreen TUI the byte ring is
  full-repaint escape noise and is fixed to `""`. Read `screenText` (the VT
  screen cache, bounded to the current frame) instead; it is `null` for
  terminals the detection engine does not track (never track them by hand).
- `truncated` is `true` when content was omitted from the bounded payload.

**Errors:** `404` if terminal not in dock or not found; `500` if workspace unavailable.

#### `GET /api/v1/agent/session/:terminalId/state-explain`

Explain the current canonical Agent state without returning terminal content. This is a
read-only, token-gated diagnostic endpoint; it is not an acknowledgement or resolve API.

**Response 200:**
```json
{
  "ok": true,
  "explanation": {
    "canonicalState": "approval_required",
    "authoritativeSource": "screen",
    "agentProfile": "claude-local-main",
    "matchedRuleId": "claude_approval_panel",
    "fallbackReason": null,
    "evaluatedRegion": "after_last_horizontal_rule",
    "gateSummary": {
      "allPassed": true,
      "allCount": 1,
      "anyPassed": true,
      "anyCount": 1,
      "nonePassed": true,
      "noneCount": 1
    },
    "manifestVersion": "1.0.0",
    "evaluatedAt": "2026-07-20T12:00:00.000Z"
  }
}
```

The response has a fixed metadata-only shape. It never contains the matched text, raw
prompt, bottom-buffer lines, or optional evidence. **Errors:** `404` if the terminal is
not live; `500` if explanation is unavailable.

#### `GET /api/v1/agent/session/:terminalId/wait?state=...&timeout=...&stopOn=...&match=...&staleAfterSec=...`

Event-driven, cancellable wait for a terminal to enter a canonical PtyState, for new
scrollback output to hit a regex, or for output to go stale. **No polling** — the request
blocks until a `ptyStateChanged` event, new `terminalData`, a `terminalExit`, a timeout, an
HTTP connection close (caller cancel), or server shutdown resolves it. Read-only: never
writes to the terminal.

**Query params:**

| Param | Default | Notes |
|-------|---------|-------|
| `state` | (see rule) | Target canonical PtyState: `starting`, `running`, `waiting_input`, `approval_required`, `blocked`, `done`, `error` |
| `timeout` | `60` | Integer seconds in the inclusive range `1..300` |
| `stopOn` | `error,blocked,approval_required,waiting_input` | Comma-separated canonical states that resolve `interrupted`. The `state` target is always excluded. |
| `match` | none | Regex (multiline; max 512 chars) tested against **new** scrollback output only. The first hit resolves `match`. |
| `staleAfterSec` | none | Integer seconds `1..300`. Resolves `stale` after N seconds without scrollback growth, counted from wait start; any new output re-arms the clock. |

At least one of `state`, `match`, `staleAfterSec` is required, and they compose freely: the
**first condition that fires resolves the wait** and names the reason in `result.outcome`.

**Outcomes** (exactly one per wait, in `result.outcome`):
| Outcome | Meaning |
|---------|---------|
| `matched` | The terminal entered the target state. |
| `match` | New scrollback output matched `match`; see `result.match` for `{ line, offset }`. |
| `stale` | No scrollback growth for `staleAfterSec` seconds. |
| `interrupted` | The terminal entered a stop state, or the HTTP connection was closed (caller cancel). |
| `timeout` | The deadline elapsed without a match or stop. |
| `closed` | The terminal exited (`terminalExit`) before a match. |
| `shutdown` | The server is shutting down. |

For a `match` outcome, `result.match.line` is the buffered line containing the hit and
`result.match.offset` is the character offset of the hit within the output appended since
the wait began (not an absolute scrollback offset). For match/stale-only waits
`result.targetState` is `null`.

**Response 200:**
```json
{
  "ok": true,
  "result": {
    "sessionId": "uuid",
    "targetState": "approval_required",
    "state": "approval_required",
    "outcome": "matched",
    "observedAt": "2026-07-20T12:00:00.000Z",
    "explanation": {
      "canonicalState": "approval_required",
      "authoritativeSource": "osc"
    }
  }
}
```

`explanation` is produced by the same metadata-only state explanation operation as
`state-explain`; its free-form fields pass through egress redaction. It is `{}` when the
terminal has already closed or explanation generation is unavailable.

**Concurrency limits:** max 4 concurrent waits per terminal, 32 globally. Over the limit →
`429` with `{ error: { code: "WAIT_LIMIT_EXCEEDED", ... }, limits: { perSession, perSessionMax, global, globalMax } }`.

**Errors:** `400` no wait condition (`state`/`match`/`staleAfterSec` all missing), invalid
`state`, `timeout`, `stopOn` entry, empty `stopOn`, invalid/empty `match` regex, or invalid
`staleAfterSec`; `404` terminal not live/in the dock or wait coordinator unavailable; `401`
missing token; `429` limit exceeded; `503` coordinator is shutting down and cannot accept a
new wait; `500` internal failure. All normal outcomes use `200`.

```bash
# Wait (up to 60s) until output contains a line starting with DONE or BLOCKED
curl -s -H "$AUTH" "$BASE/session/<terminalId>/wait?match=%5E(DONE%7CBLOCKED)%5Cb"

# Return "stale" once the terminal has produced no output for 300 seconds
curl -s -H "$AUTH" "$BASE/session/<terminalId>/wait?staleAfterSec=300"

# Compose: match OR reaching done OR a stop state — whichever fires first
curl -s -H "$AUTH" "$BASE/session/<terminalId>/wait?state=done&match=%5EDONE&timeout=120"
```

**Cancellation:** closing the HTTP connection (TCP FIN) aborts the wait and resolves
`interrupted`. A caller can cancel by aborting the fetch/request.

**Lost-wakeup protection:** after subscribing, the coordinator rechecks the current state so
a transition that fired between the fast-path read and the subscribe boundary is never lost.

#### `POST /api/v1/agent/session/:terminalId/handoff-packet`

Build a version-1, privacy-safe handoff packet for another PTY. Claude terminals prefer the
native transcript; other profiles (or a missing native transcript) use only the bounded tail
of sanitized scrollback. Git branch/HEAD/dirty paths, canonical state, and the last structured
command are added as metadata. This endpoint **does not write to any PTY and does not resolve
or acknowledge attention state**.

**Body (strict):**
```json
{
  "targetProfile": "codex-local-main",
  "objective": "review implementation",
  "idempotencyKey": "workflow-step-id"
}
```

**Response 200:**
```json
{
  "ok": true,
  "packet": {
    "version": 1,
    "sourceSessionId": "ref-<one-way-hash-prefix>",
    "sourceProfile": "claude-local-main",
    "targetProfile": "codex-local-main",
    "projectId": "project-<one-way-hash-prefix>",
    "worktree": { "branch": "codex/task", "head": "abc123", "diffStat": "2 files changed", "dirty": true },
    "brief": "... <=200 Unicode code points ...",
    "completed": [], "changedFiles": [], "verification": [], "pending": [],
    "nextAction": "...", "risks": [],
    "state": { "canonical": "done", "authoritativeSource": "process", "matchedRuleId": null },
    "lastCommand": null,
    "source": "native-transcript",
    "partial": false,
    "createdAt": "2026-07-20T12:00:00.000Z"
  },
  "formattedPrompt": "<terminal_handoff ...>",
  "provenance": {
    "source": "native-transcript", "summarizerProfile": "claude-local-main",
    "inputBytes": 1000, "packetBytes": 900, "tokenEstimate": 900,
    "ledgerId": "stable-ledger-id",
    "createdAt": "...", "reused": false
  }
}
```

`formattedPrompt` wraps the packet in an explicit `UNTRUSTED_TERMINAL_HISTORY` boundary.
Content is redacted field-by-field before summarization, then schema-validated and redacted
field-by-field again (including ordinary uppercase environment assignments such as `FOO=x`).
`brief` is hard-capped at 200 Unicode code points. The conservative token upper bound is the
serialized UTF-8 byte count (every token consumes at least one byte); packets are re-converged
after redaction to at most 1,200 by that bound and asserted below the 2,000 hard ceiling.
Bounded-list/source truncation—or a native transcript already at its upstream 200-message
ceiling—sets `partial:true`.

Summarization is allowlisted to `claude-local-main`, then `claude-local-long`; both failing produces a
deterministic extractive packet. Providers run from Coterm's neutral temp directory, never the
source workspace; source-workspace paths are still used locally for redaction. One job-wide
deadline covers collection, git metadata, every map/reduce invocation, validation, and ledger
write. The SQLite ledger stores only one-way source/idempotency/request fingerprints, the
redacted packet, provenance, and size metadata—never raw transcript, scrollback, provider
output, or prompt. Identical/concurrent idempotency keys reuse the stable `ledgerId`, including
after restart. Reusing a key with a different objective or target returns a conflict.

**Errors:** `400` malformed/extra fields; `404` terminal/service unavailable; `409` no usable
source or idempotency fingerprint conflict; `413` body too large; `429` API/service rate or
concurrency limit; `499` caller abort; `504` job deadline; `500` internal failure.

#### `POST /api/v1/agent/terminals`

Open a new dock tile for agent work. Rate-limited (30/min). Can optionally launch a free
agent profile (claude-local-main / claude-local-long / claude-local-freeform / claude-local-big / codex-local-main / codex-local-long / codex-local-big) by pasting
the launch command and auto-pressing Enter.

**Body:**
```json
{
  "projectId": "uuid (required)",
  "agentProfile": "claude-local-main (optional)",
  "launch": true,
  "task": "optional prompt string",
  "resumeSessionId": "optional native session id"
}
```
**Response 200:**
```json
{
  "ok": true,
  "terminal": { "id": "uuid", "...": "TerminalInfo" },
  "selectedTerminalId": "uuid",
  "launched": true,
  "supportedAgentProfiles": ["claude-local-main", "claude-local-long", "claude-local-freeform", "claude-local-big", "codex-local-main", "codex-local-long", "codex-local-big"],
  "maxTerminals": 12,
  "terminalCount": 3,
  "availableSlots": 9,
  "canCreate": true
}
```
**Errors:** `400` invalid JSON / missing projectId / unsupported profile; `409` dock full;
`413` body too large; `429` rate limited; `500` openTile/writeTerminal failure.
A `500` after the tile was already created reclaims that tile itself — retrying
a failed create never piles up blank placeholder tiles (1.5.44).

#### `POST /api/v1/agent/session/:terminalId/input`

Write keystrokes to a terminal. Rate-limited (30/min).

This route always writes with `source:"automation"`. `enter:true` appends `\r`, but does
not acknowledge/resolve a human-attention notification. Human acknowledgement comes only
from explicit desktop/web/mobile renderer input.

**Body:**
```json
{ "data": "keystrokes", "enter": true }
```

**Exact-once retries (optional, recommended for supervisors):** send a stable
`clientMutationId` (UUID) with the request. The main process pins each id to a hash
of `(terminalId, data)` for a bounded TTL (5 minutes):

- Retry with the **same id + same payload** → no second PTY write; response
  `{ "ok": true, "deduped": true }`.
- Reuse with a **different payload** → `409` with `code: "mutation_conflict"`
  (treated as a client bug instead of silently sending the wrong text).
- A write that **failed** (e.g. PTY exited) is not recorded, so retrying it can
  still deliver.

```json
{ "data": "keystrokes", "enter": true, "clientMutationId": "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }
```
**Response 200:** `{ "ok": true, "deduped": false }`
**Errors:** `400` invalid JSON / empty data / malformed `clientMutationId`;
`409` PTY exited or `mutation_conflict`; `413` too large; `429` rate limited;
`500` write failed.

#### `POST /api/v1/agent/session/:terminalId/close`

Close a terminal tile. Agent-owned terminals close freely; user-opened terminals require
explicit approval.

**Body:**
```json
{ "allowUserTerminal": false }
```
**Response 200:**
```json
{
  "ok": true,
  "selectedTerminalId": "uuid",
  "maxTerminals": 12,
  "terminalCount": 1,
  "availableSlots": 11,
  "canCreate": true
}
```
**Errors:** `404` not in dock; `409` refusing to close user terminal without approval
(includes `needsUserApproval: true`); `429` rate limited; `500` close failed.

---

### Investigation endpoints (Phase 2 — shipped, read-only GET endpoints)

All Phase 2 endpoints require the bearer token. Responses pass through `redactEgress`.

#### `GET /api/v1/agent/logger-health`

Logger health snapshot: ring buffer state, file-write state, consecutive failures.

**Response 200:**
```json
{
  "ok": true,
  "health": {
    "degraded": false,
    "consecutiveWriteFailures": 0,
    "ringBufferCount": 42,
    "fileWriteDisabled": false,
    "logPath": "~/AppData/Roaming/Coterm/logs/coterm.log"
  }
}
```
> `logPath` is redacted (home dir → `~`) before egress.

#### `GET /api/v1/agent/incidents?window=5m`

Aggregate `warn`/`error` log entries in the ring buffer within a time window.

**Query params:**
| Param | Default | Notes |
|-------|---------|-------|
| `window` | `5m` | Duration: `Ns`, `Nm`, `Nh` |
| `maxChars` | `8000` | Budget for the `recent` array |

**Response 200:**
```json
{
  "ok": true,
  "incidents": {
    "count": 3,
    "window": "5m",
    "byCategory": { "app": 2, "pty": 1 },
    "byLevel": { "warn": 2, "error": 1 },
    "recent": ["{\"ts\":\"...\",\"level\":\"warn\",...}"],
    "truncated": false
  }
}
```

#### `GET /api/v1/agent/state`

App state summary — terminal count, dock layout, selected settings. **No terminal content
or scrollback** is returned.

**Response 200:**
```json
{
  "ok": true,
  "state": {
    "terminals": 2,
    "dockLayout": { "tileCount": 2, "selectedTerminalId": "uuid" },
    "settings": {
      "agentApiEnabled": true,
      "defaultProvider": "claude-local-main",
      "defaultShell": "pwsh"
    }
  }
}
```

#### `GET /api/v1/agent/logs`

Grep the in-memory ring buffer (last 200 entries, already redacted).

**Query params:**
| Param | Default | Notes |
|-------|---------|-------|
| `level` | (all) | `debug` / `info` / `warn` / `error` |
| `category` | (all) | `app` / `ipc` / `web` / `pty` / `provider` / `storage` / `run` / `council` / `security` / `audit` |
| `since` | (all) | ISO 8601 timestamp |
| `q` | (all) | Substring search on `msg` |
| `limit` | `200` | Max entries to scan (1–200) |
| `maxChars` | `8000` | Budget for the `lines` array |

**Response 200:**
```json
{
  "ok": true,
  "lines": ["{\"ts\":\"...\",\"level\":\"info\",\"category\":\"app\",\"msgCode\":\"app.bootstrap\",\"msg\":\"...\"}"],
  "count": 4,
  "truncated": false
}
```

#### `GET /api/v1/agent/logs/file`

Tail the `coterm.log` file (raw, each line redacted). Returns `text/plain; charset=utf-8`.

**Query params:**
| Param | Default | Notes |
|-------|---------|-------|
| `lines` | `500` | Number of trailing lines (1–2000) |
| `maxChars` | `8000` | Budget for the response body |

**Response 200:** `text/plain; charset=utf-8` — each line is a redacted JSON log line.
The `X-Truncated` response header is `true` when the char budget was exceeded.
**Errors:** `503` if the log file is unavailable (console-logger fallback) or unreadable.

#### `GET /api/v1/agent/diagnostics`

One-shot snapshot combining health + state + incidents (5m window). Saves three round-trips.

**Response 200:**
```json
{
  "ok": true,
  "diagnostics": {
    "health": { "degraded": false, "...": "LoggerHealth" },
    "state": { "terminals": 2, "dockLayout": {...}, "settings": {...} },
    "incidents": { "count": 1, "window": "5m", "byCategory": {...}, "byLevel": {...} }
  }
}
```

#### `GET /api/v1/agent/schema`

Static log schema: valid levels, categories, and known msgCodes. Browser automation
capabilities live in a separate schema at `GET /api/v1/agent/browser/schema`.

**Response 200:**
```json
{
  "ok": true,
  "schema": {
    "levels": ["debug", "info", "warn", "error"],
    "categories": ["app", "ipc", "web", "pty", "provider", "storage", "run", "council", "security", "audit"],
    "msgCodes": ["app.bootstrap", "app.start.failed", "..."],
    "browserSchema": "/api/v1/agent/browser/schema"
  }
}
```

#### `GET /api/v1/agent/audit`

Audit trail shortcut — equivalent to `GET /logs?category=audit`. Returns entries written via
`logger.audit()` (level=info, category=audit).

**Query params:**
| Param | Default | Notes |
|-------|---------|-------|
| `since` | (all) | ISO 8601 timestamp |
| `maxChars` | `8000` | Budget for the `entries` array |

**Response 200:**
```json
{
  "ok": true,
  "entries": ["{\"ts\":\"...\",\"level\":\"info\",\"category\":\"audit\",\"msgCode\":\"terminal.workspace.saved\",\"msg\":\"...\"}"],
  "count": 2,
  "truncated": false
}
```

---

## Pane mailbox (agent mail / @-mentions)

Cross-pane messaging for agent sessions running inside Coterm panes (Claude Code,
Codex, or any mix). Each agent PTY gets a short handle (`claude-1`, `codex-2`, ...)
shown in its pane header; agents send each other one-line updates through the
`cot` CLI that is already on their PATH.

These routes deliberately live under `/api/v1/mail/*` — NOT `/api/v1/agent/*` —
so they keep working when **Settings → Agent API is OFF**. Same loopback +
Host-header gates as the rest of the server, but the bearer token is the
**per-pane `COTERM_MAIL_TOKEN`** injected into each agent PTY at spawn (never the
full agent-API token; a pane token cannot call any `/api/v1/agent/*` route and
vice versa).

Requests are POST-only with JSON bodies. Send `Accept: text/plain` to get short
plain-text answers (what the `cot` CLI prints); otherwise JSON.

#### `POST /api/v1/mail/send`

Body: `{ "to": "@codex-2", "text": "tests green, your turn" }`.

- `text` is capped at 500 Unicode characters; newlines, control characters, and
  ANSI/OSC escape sequences are stripped so one mail can never inject terminal
  control into the receiving pane.
- The wire format inside the target pane is a single user-turn line
  `[@claude-1] <text>` followed by Enter.
- Delivery happens immediately whenever the target agent is idle (`done`) or
  actively working (`running`, `waiting_input`): both Claude Code and Codex
  accept typed input mid-turn and queue it as the next user message, so the
  sender never waits for the turn to finish. Delivery is plain text + Enter —
  Esc/Ctrl+C are never sent, so a busy agent is steered, never interrupted.
- The message queues instead only while typing could hijack a UI: an
  approval/permission prompt (`approval_required`), an open menu/picker
  (the screen detector's waiting-input rules), `starting`, `blocked`, or
  `error`. Queued mail flushes FIFO the moment that state clears; several
  queued messages from the same sender coalesce into one line joined with
  ` | `.
- Messages expire after 30 minutes; expired or dead-target mail is dropped and
  the sender is told on their next `send`/`who` call.

Text-mode success (HTTP 200): `sent -> @codex-2` or `queued -> @codex-2`,
optionally followed by drop-notice lines.

Errors: `400` bad body / empty text / mailing yourself; `404` unknown handle;
`413` body over 1 MB; `429` per-sender rate limit (10 messages/minute). If a
pane pair exchanges more than 20 messages in 10 minutes the pair is paused and
the pane raises the attention state so the user sees the ping-pong; sends
return `400 pair_paused` until the pair has been quiet for 10 minutes.

#### `POST /api/v1/mail/who`

One line per open agent pane: `handle \t profile \t state \t cwd-basename`.
Text mode prepends `you: <your-handle>` and appends any drop notices.

#### Auditing

Every message writes one audit line (`agentMail.delivered | queued | dropped |
rejected | pairPaused | writeFailed`) with from/to handles, text length, and
outcome. The message text itself is never logged.

## Browser automation

The agent API also drives Coterm's built-in Chromium runtime (Playwright-backed,
isolated per session). The surface is intentionally machine-discoverable: fetch the
schema first, then dispatch actions by name — no source reading required.

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/api/v1/agent/browser/schema` | Machine-readable capability discovery (see below) |
| GET | `/api/v1/agent/browser/sessions` | List browser sessions (metadata only — no cookies, no page bodies) |
| POST | `/api/v1/agent/browser/session` | Create a session (input = `session.create`, e.g. `{ "mode": "headless" }`) |
| POST | `/api/v1/agent/browser/page` | Create a page (input = `page.new`, e.g. `{ "sessionId": "<uuid>", "url": "..." }`) |
| POST | `/api/v1/agent/browser/action` | Dispatch any action: `{ "action": "<httpName>", "input": { ... } }` |
| POST | `/api/v1/agent/mcp` | MCP (streamable HTTP, stateless JSON-RPC) — curated core tools for MCP-native clients (see below) |

`GET /api/v1/agent/browser/schema` returns (schemaVersion `1.2`): the full action
list with input JSON Schemas, mutability, risk level (0 read-only → 3 high-risk),
approval mode, and timeout per action; locator strategies; snapshot-ref semantics;
error codes; live runtime limits; capabilities; and a rateLimits block. The payload
is generated from the action registry, locator schema, and the running
`BrowserRuntimeManager` — treat it as the contract of record.

Action names for the `/action` envelope are the `httpName` of each registry entry
(`createSession`, `navigate`, `snapshot`, `click`, `fill`, `screenshot`, `extract`,
`search`, ... — read the schema). Sensitive actions (`fill` with a secret, `upload`)
require `approval: "per-request"` (so do `fill` on a password-like field and
`evaluate`) and fail with `policy_denied` / `approval_timeout` when no human
answers. On the desktop build the request surfaces as an approval dialog showing
action, origin, and risk level; the answer resolves the same broker requestId
used by provider approvals.

**One session, one authorization (issue #93):** the dialog's *Allow — and stop
asking this session* button grants that **browser session** blanket approval.
The first level-2/3 action in a session still prompts; after a grant, every
later action in the same session — **including level 3** — passes without a
dialog. The grant is checked before the dialog, so no setting can re-prompt an
already-granted session. There is deliberately **no permanent "remember"**: the
grant dies with the session (close, idle sweep, or dispose). Granted state is
visible as `approvalGranted: true` on the session in `/browser/sessions` and
`/browser/session/:id`, and every auto-passed action is written to the audit log
(`browser.approval.autoApproved`) together with the grant itself
(`browser.approval.granted`), so an unattended run stays reviewable.

**Rate limits:** there are two independent per-client buckets (issue #93):

| Bucket | Covers | Default |
|---|---|---|
| `terminal` | terminal/workflow/worktree mutations | 30/min |
| `browser` | browser session create, page create, browser mutation actions, mutating MCP `tools/call` | 30/min |

They are separate on purpose: one browser form flow is roughly a dozen
mutations while a terminal dispatch is one, so a shared bucket meant whichever
ran first starved the other. Both are **configurable** in Settings (Agent API →
rate limit) and take effect on the next request — no relaunch. Each is a token
bucket refilled continuously at `limit/60s`, so `retryAfterMs` is the time to
the next token (typically milliseconds), never the pessimistic "time until the
window resets" of a fixed window. Every limited route returns the same
disclosure body and the `X-RateLimit-*` headers. Browser read actions and the
GET routes (`/browser/schema`, `/browser/sessions`) are not rate-limited;
session/page capacity limits apply separately.

Deliberately separate schemas: terminal log/event schema is
`GET /api/v1/agent/schema`; browser capability schema is
`GET /api/v1/agent/browser/schema`. Neither contains the other.

### Phase 7 superpowers (B3/B4)

The registry `tier` field gates advanced actions behind Settings → Browser
superpowers (P0/P1). A disabled tier fails closed with `policy_denied` before
any browser work; discovery (`/browser/schema`) lists each action's tier.

- **`page.batch`** (P0): up to 20 ordered registry steps; nested batches are
  rejected; every step re-passes schema/tier/approval/timeout, and every
  mutation step consumes the `browser` bucket individually (per-step
  `rate_limited` codes appear inside the 200 batch result). `stopOnError`
  defaults to true; per-step results are size-capped with truncation markers.
- **`page.batchFill`** (P1): fills many fields in one round-trip. Each field
  re-runs its own approval — a password-shaped field is still level 3. Values
  must be literal or an opaque one-time `secret://…` handle; the result
  carries field metadata only (never values). stop/continue semantics mirror
  `page.batch`.
- **Secret handles are minted locally only.** The desktop Settings UI
  (`Issue one-time secret handle`) sends the raw value straight into the
  in-memory vault over renderer IPC; the opaque handle is TTL'd (60 s
  default, max 10 min) and self-destructs on first use. There is deliberately
  no HTTP/MCP path for secret material.
- **`page.dialog`** (P1): answer a pending page dialog or wait (`awaitMs`,
  bounded 30 s) for the next. Accept/prompt is a level-2 per-request
  approval; dismiss is level 1. Unanswered dialogs auto-dismiss after 30 s —
  a page can never wedge an agent loop on a modal.
- **`page.download`** (P1): always per-request level-2 approval. Saves land
  under `<userData>/browser-cache/downloads/` only (sanitized basename, random
  suffix, lexical + realpath containment, executable-extension denylist,
  64 MiB cap, sha256 + path metadata in the reply — never file bytes).
- **`page.fetchToMarkdown`** (P1): cookie-free fetch → markdown. Same DNS/SSRF
  policy as navigation, re-validated per redirect hop (max 5); bounded time
  and 1 MiB body cap with a truncated marker; reply URLs are query-redacted;
  bot walls report `captcha_wall` and are never bypassed.
- **`page.consoleLog`** (P1): read-only bound page console + uncaught
  `pageerror` ring (100 entries, 256 KiB aggregate, per-entry redaction at
  capture).
- **`page.elementScreenshot`** (P1): element capture by current snapshot ref
  only; always artifact-on-disk metadata; shares the screenshot pixel/byte
  ceilings.
- **`page.assert`** (P1): typed boolean assertions over text/url/visible/value
  with bounded redacted observations; ref targets fail closed on stale
  snapshots.
- **`page.screenshot` now takes `format` (`png`|`jpeg`), `quality` (jpeg only)
  and `scale` (`css`|`device`)** plus a document-side pixel ceiling; oversized
  asks fail `invalid_input`/`permission_denied`, never OOM. Snapshot results
  may carry `blocked: true, blockedReason: "captcha_wall"` — detection only.
### MCP endpoint (AT-135)

`POST /api/v1/agent/mcp` speaks MCP over streamable HTTP in stateless mode
(JSON-RPC request → JSON response; notifications get `202`; no SSE, no session
headers). Same bearer token, same Host allowlist, same `browser` mutation bucket
as the REST browser routes (a mutating `tools/call` 429s with `rate_limited` +
`retryAfterMs`, same as REST). MCP-native clients (Claude Code, Codex, Cursor) get tools with schemas
injected into their session — no envelope to learn.

- **Curated tool set, deliberately.** MCP tool definitions ride along with every
  prompt in the client session, so this endpoint exposes a core subset of the
  browser registry (`search`, session create/close, `navigate`, `snapshot`,
  `screenshot`, `extract`, `click`, `fill`, `type`, `evaluate`,
  `previewLocalFile`, `searchIndex`) plus the read-only terminal tools —
  `coterm_terminal_sessions` (compact dock list with `scrollbackMode`),
  `coterm_terminal_read` (bounded read honoring the scrollbackMode contract:
  `alternate-screen` → `scrollback` is `""`, read `screenText`, never poll) and
  `coterm_resources` (resource board — same payload as `GET /resources`).
  The full action surface stays on the REST envelope + `/browser/schema`.
- **`screenshot` never returns base64 over MCP** — it lands on disk and the tool
  returns `{ artifactPath, bytes }`; the client Reads the file if it needs pixels.
- Approval semantics are unchanged: level 2–3 actions (e.g. `evaluate`) still go
  through the same human approval dialog; switching protocols does not bypass it.

Project-scoped client wiring lives in `.mcp.json` at the repo root
(`${COTERM_AGENT_TOKEN}` env var; set it to the token from
`<userData>/agent-api-token.txt`). To use it from any directory, register the
same URL globally instead.

---

## AgentApi fixed workflow (issue #6)

The MVP is one persisted, bounded workflow only:

`claude-local-main implementer -> codex-local-main enforced read-only reviewer -> at most 3 review loops -> human review`

It always creates an isolated worktree, pins the Claude implementer to an explicit
session UUID, uses the event-driven wait endpoint internally, and reuses the
Terminal Handoff ledger. The reviewer is bound to the configured loopback GLM
proxy with sandbox `read-only` and approval policy `never`; if those controls or a
stable handoff ID cannot be guaranteed, the workflow stops in `needs_human`.

### `POST /workflow`

```json
{
  "projectId": "<uuid>",
  "task": "implement and verify the requested change",
  "idempotencyKey": "external-job-123",
  "branch": "codex/optional-branch",
  "baseRef": "main",
  "implementer": "claude-local-main",
  "reviewer": "codex-local-main"
}
```

The roles are fixed; other values return `400`. Success is `202` with the durable
workflow snapshot. Reusing the same idempotency key with the same request returns
the same workflow; a different request returns `409`.

### `GET /workflow/:id`

Returns `{ workflow, steps }`. Each persisted step has a stable ID, attempt,
idempotency key, status, session/handoff IDs, timestamps, outcome, and revision.
Raw terminal history, reviewer provider output, and git diff are never stored in
the workflow tables.

### `POST /workflow/:id/resume`

Resumes a recoverable `needs_human`, `blocked`, or `failed` workflow. If the
implementation terminal still reports `waiting_input`, `approval_required`,
`blocked`, or `error`, this returns `409`; it never writes an answer or clears
attention.

### `POST /workflow/:id/pause`

Cancels the current wait/reviewer run and records a resumable human pause. It does
not stop the terminal or delete the worktree.

### `POST /workflow/:id/cancel`

Stops future dispatch and cleans up wait listeners. It deliberately preserves the
terminal, worktree, branch, and user edits. Completed workflows cannot be canceled.

Crash recovery never blindly resends an ambiguous `dispatching_*` prompt. Those
states become `needs_human`; safe waiting and idempotent handoff states can resume.
AgentApi never approves permissions or performs merge, commit, push, PR, deploy,
worktree deletion, or destructive cleanup.

## curl examples

```bash
# Read the token (Windows). On legacy installs the dir is "Coterm".
TOKEN=$(cat "$APPDATA/Coterm/agent-api-token.txt")
PORT=43127
BASE="http://127.0.0.1:$PORT/api/v1/agent"
AUTH="Authorization: Bearer $TOKEN"

# Probe (no token needed)
curl -s "$BASE/health"

# List sessions
curl -s -H "$AUTH" "$BASE/sessions"

# Open a claude-local-main terminal and auto-launch
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"projectId":"<uuid>","agentProfile":"claude-local-main","task":"fix the typo"}' \
  "$BASE/terminals"

# Write keystrokes + Enter
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"data":"ls -la","enter":true}' \
  "$BASE/session/<terminalId>/input"

# Explain the current Agent state (metadata only)
curl -s -H "$AUTH" "$BASE/session/<terminalId>/state-explain"

# Wait up to the default 60 seconds; attention/error states interrupt it
curl -s -H "$AUTH" "$BASE/session/<terminalId>/wait?state=done"

# Wait up to 10 seconds with custom stop states
curl -s -H "$AUTH" \
  "$BASE/session/<terminalId>/wait?state=done&timeout=10&stopOn=error,blocked"

# Logger health
curl -s -H "$AUTH" "$BASE/logger-health"

# Grep warn/error logs from the last 5 minutes
curl -s -H "$AUTH" "$BASE/incidents?window=5m"

# Tail the raw log file (last 200 lines)
curl -s -H "$AUTH" "$BASE/logs/file?lines=200"

# One-shot diagnostics
curl -s -H "$AUTH" "$BASE/diagnostics"

# Audit trail
curl -s -H "$AUTH" "$BASE/audit"

# Start and inspect a fixed AgentApi workflow
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"projectId":"<uuid>","task":"implement the issue","idempotencyKey":"job-123"}' \
  "$BASE/workflow"
curl -s -H "$AUTH" "$BASE/workflow/<workflowId>"
```

## PowerShell examples

```powershell
# Read the token (Windows). On legacy installs the dir is "Coterm".
$Token = Get-Content "$env:APPDATA\Coterm\agent-api-token.txt" -Raw
$Port  = 43127
$Base  = "http://127.0.0.1:$Port/api/v1/agent"
$Auth  = @{ Authorization = "Bearer $Token" }

# Probe (no token needed)
Invoke-RestMethod "$Base/health"

# List sessions
Invoke-RestMethod "$Base/sessions" -Headers $Auth

# Open a claude-local-main terminal and auto-launch
Invoke-RestMethod "$Base/terminals" -Headers $Auth -Method Post `
  -ContentType "application/json" `
  -Body (@{ projectId = "<uuid>"; agentProfile = "claude-local-main"; task = "fix the typo" } | ConvertTo-Json)

# Write keystrokes + Enter
Invoke-RestMethod "$Base/session/<terminalId>/input" -Headers $Auth -Method Post `
  -ContentType "application/json" `
  -Body (@{ data = "ls -la"; enter = $true } | ConvertTo-Json)

# Explain the current Agent state (metadata only)
Invoke-RestMethod "$Base/session/<terminalId>/state-explain" -Headers $Auth

# Wait for the terminal to enter approval_required (blocks up to 60s)
Invoke-RestMethod "$Base/session/<terminalId>/wait?state=approval_required" -Headers $Auth

# Wait with a 10s timeout and custom stop states
Invoke-RestMethod "$Base/session/<terminalId>/wait?state=done&timeout=10&stopOn=error,blocked" -Headers $Auth

# Cancel a wait: close the connection (Invoke-RestMethod supports -TimeoutSec
# and you can wrap in a job + Stop-Job to abort early).
$job = Start-Job {
  param($Base, $Auth)
  Invoke-RestMethod "$Base/session/<terminalId>/wait?state=approval_required&timeout=60" -Headers $Auth
} -ArgumentList $Base, $Auth
# ...later, to cancel:
Stop-Job $Job; Remove-Job $Job

# Start, inspect, and cancel a fixed AgentApi workflow
$Workflow = Invoke-RestMethod "$Base/workflow" -Headers $Auth -Method Post `
  -ContentType "application/json" `
  -Body (@{ projectId = "<uuid>"; task = "implement the issue"; idempotencyKey = "job-123" } | ConvertTo-Json)
Invoke-RestMethod "$Base/workflow/$($Workflow.workflow.id)" -Headers $Auth
Invoke-RestMethod "$Base/workflow/$($Workflow.workflow.id)/cancel" -Headers $Auth -Method Post -Body "{}" -ContentType "application/json"
```
## Constraints

- **Read-only investigation endpoints** (`logger-health`, `incidents`, `state`, `logs`,
  `logs/file`, `diagnostics`, `schema`, `audit`) never mutate state.
- **Terminal-control endpoints** (`terminals`, `input`, `close`) are rate-limited at 30/min.
- The API only drives **free profiles** returned by `supportedAgentProfiles()`:
  `claude-local-main`, `claude-local-long`, `claude-local-freeform`, `claude-local-big`,
  `codex-local-main`, `codex-local-long`, and `codex-local-big`.
- An in-app agent must NOT restart/rebuild/close Coterm — it runs inside Coterm.
- `maxChars` default 8000, hard ceiling 64000; over-budget responses are truncated with
  `truncated: true` (or `X-Truncated: true` header for `logs/file`).
