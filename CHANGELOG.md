# Changelog

## 1.5.11

- Reset the shipped product baseline to v1.5.6. Product changes from
  v1.5.7 through v1.5.10 are intentionally excluded from this release.
- Enabled native my-kimi context compaction in both harnesses: Claude Code
  compacts at 85% of a 200k working window; Codex compacts between turns at
  170k inside a 190k working window.
- Kept compaction continuity grounded in the native session transcript and a
  structured continuation handoff, so the compacted session can resume the
  objective, decisions, evidence, exact paths, and next action.

## 1.5.6

- Fixed desktop dictation MIME handling: MediaRecorder reports parameterised
  types (`audio/webm;codecs=opus`), now matched by essence.
- Replaced the sql.js in-memory storage engine with node:sqlite, with rolling
  caps and a prune-on-start migration (AT-19).

## 1.5.5

- Fixed desktop dictation failing against Groq: Groq 500s on any non-ASCII
  `prompt` field, so zh-TW/zh-CN clips now retry once without the prompt and
  degrade to the `language` hint instead of hard-failing.
- Redesigned Settings toggles as two-sided segmented controls — 開啟/關閉 are
  both always visible with the active side highlighted, so state is obvious at
  a glance.
- Changed all Settings toggle defaults to ON (Agent API, browser superpowers,
  voice input, streaming dictation, AgentApi sidebar and voice agent) so a
  fresh install works out of the box.

## 1.5.0-beta

- Added the AgentApi voice command rail: bounded streaming dictation previews,
  a hidden supervisor gateway, and voice-driven terminal orchestration.
- Shipped browser superpowers: a token-gated agent browser (navigate, snapshot
  and diff, click/type/fill with secret handles, waitFor, downloads, dialogs,
  network/console logs, screenshots) running real Chromium with SSRF-safe
  production policy and per-request approval levels.
- Split Stable and Beta into side-by-side channels (app identity, userData,
  remote-config dir, and Agent API port are channel-scoped), so a Beta install
  never touches the live Stable data; window title now follows the channel
  product name.
- Added `match` / `staleAfterSec` to the agent wait endpoint and shipped
  `scripts/agent-watch.ps1` for terminal wait watching.
- Fixed the fullscreen TUI bottom row being clipped by measuring the host
  content box on desktop fit (public #16), and showed an instant placeholder
  when adding a project (#17).
- Coalesced rapid exclusive/grid layout toggles and logged layout-switch
  bursts (#15); preserved partial settings updates and stabilized the mobile
  viewport and launch regressions.
- Enforced the v1.5 UI release baseline in tests and hardened the ship
  pipeline (de-identification scan, release artifact globbing).

## 1.4.0

- Added `claude-local-big` and `codex-local-big` as my-kimi backend profiles owned by the
  existing Claude Code and Codex harnesses.
- Pinned the Coterm Kimi working context to 240,000 tokens and reasoning effort
  to `high`; Claude launches include the legacy-model-remap guard.
- Wired Kimi through picker, Settings, Agent API, trusted resume, Reader,
  capability detection, session ownership, and the context meter without
  replacing GLM/Qwen profiles or exposing the private upstream endpoint.
- Aligned GitHub Actions with public `master`, manual dispatch, Node.js 24, and
  a version-agnostic release contract.
- Made the Total UI release gate a truthful per-action debt ratchet and replaced
  its racy mobile media-query injection with an isolated real mobile viewport.
