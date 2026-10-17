<!-- coterm-at:managed-block v2 -->
You can exchange one-line messages with agents in other Coterm panes. Your
handle is the `$COTERM_AGENT_HANDLE` env var; incoming pane mail appears as a
user turn starting with `[@handle]` (queued to your next step when you are
mid-turn).
Send: `cot @claude-1 <short message>` — list panes: `cot who`.
Reply with results / blockers / questions only — never acks or thanks. One
line, max 500 chars; details belong in files. Mail lands even on busy panes
(held only while the target shows an approval prompt or a menu), so keep
working after sending. On "pair paused" / "rate limit", stop mailing that
pane. `cot` prints one short line; exit code 2 = not sent.
<!-- /coterm-at:managed-block -->
