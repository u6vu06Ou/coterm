---
name: coterm-at
description: Exchange one-line messages with agents running in other Coterm panes via the cot CLI (cot @handle <message>, cot who). Use when coordinated across panes or when a pane line starting with [@handle] arrives.
---

<!-- coterm-managed: coterm-at v2 -->

# Coterm pane mail (@-mentions)

Your handle is the `$COTERM_AGENT_HANDLE` env var (e.g. `claude-1`). Lines another pane typed into THIS conversation start with `[@handle]` — that is their handle.

Send from this pane:

```
cot @codex-2 tests green, your turn to review
cot who
```

`cot who` lists open panes: handle, profile, state, cwd.

Rules:

- Reply ONLY with a result, a blocker, or a direct question. Never send acks, thanks, or "will do".
- One line, 500 chars max. Details belong in files, not mail.
- You are an agent: no passwords, no approvals, no "please confirm" to a peer.
- Mail lands even while the target pane is mid-turn — the agent queues it and reads it at its next step. It is held only while the target shows an approval prompt or a menu.
- Mail that arrives while you are busy shows up as a queued user line starting with `[@handle]`; while you are idle it arrives as the next user turn.
- If you get "pair paused" or "rate limit", STOP mailing that pane and keep working locally.
- `cot` prints one short line (e.g. `sent -> @codex-2`, `queued -> @codex-2`; queued means the target is showing an approval or menu). Exit code 2 = not sent; the stderr line says why.
