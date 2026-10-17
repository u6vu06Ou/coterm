// Background-work signals — shared busy indicators for multi-agent TUIs.
//
// When the main Claude Code (or Codex) agent parks its turn on background
// agents — "Waiting for N background agents to finish" — the pane shows an
// empty, idle-looking prompt while subagents/teammates/shells keep running.
// The main turn emits no output for minutes, so BOTH the output-quiet
// debounce (pty-manager) and the bare prompt marker (screen rules) misread
// it as idle/done and the lamp goes green while real work continues.
//
// These patterns live in ONE place so the bundled manifests (screen rules →
// state "running") and the pty-manager quiet-debounce override cannot drift.
//
// Design input: kbwo/ccmanager src/services/stateDetector/claude.ts (MIT) —
// elapsed/token counters and structured status rows are the busy signals
// that survive Claude Code UI churn; the ❯/> prompt is drawn on every frame
// and must never count as idle evidence on its own. All patterns here are
// re-authored from Coterm's own ConPTY observations; no third-party code is
// copied (and herdr's AGPL fixtures remain off-limits).
//
// Layering: this module only TESTS patterns against bounded screen text. It
// never logs, stores, or forwards the text it inspected.

/**
 * Waiting spinner line, e.g.
 *   "✻ Waiting for 8 background agents to finish"
 *   "✻ Waiting for 9 background agents to finish · 6 messages hidden"
 * Anchored to the "to finish" tail so prose mentioning background agents
 * ("…is waiting for 2 background agents soon") does not collide.
 */
export const BACKGROUND_WAITING_PATTERN =
  String.raw`Waiting for \d+ (background agents?|teammates?|background tasks?|sub-?agents?|other agents?) to finish\b`;

/**
 * Live teammate / background-agent status row: a leading status bullet with
 * an elapsed timer and a ↓ token counter, e.g.
 *   "○ alpha-mate   正在檢查 scan1 進度   14m 15s · ↓ 172.5k tokens"
 *   "● main"
 * Rows live in the status block at the bottom and disappear when the agent
 * completes, so a match means work is still in flight.
 */
export const TEAM_STATUS_ROW_PATTERN =
  String.raw`^[ \t]*[●○◯◉][^\n]*·\s*↓\s*[0-9][0-9.]*[kKmM]?\s*tokens?\b`;

/**
 * Parenthesized token-stats line, e.g. "(2m 18s · ↓ 4.8k tokens)" — the
 * compact form of the same elapsed/counter signal.
 */
export const TOKEN_STATS_PATTERN =
  String.raw`\([^)\n]*\d[^)\n]*·\s*↓\s*[0-9][0-9.]*[kKmM]?\s*tokens?[^)\n]*\)`;

/**
 * Live background shells/monitors in the permission status line, e.g.
 *   "⏵⏵ bypass permissions on · 14 shells, 1 monitor"
 * Without live background shells the line ends at "bypass permissions on",
 * NOT used as a busy signal: long-lived shells (dev servers) and monitors
 * outlive the agent turn, so they would pin the lamp to running forever.
 * Kept exported for diagnostics only.
 */
export const BACKGROUND_SHELLS_PATTERN =
  String.raw`\bbypass permissions on\b[^\n]*\b\d+\s+(?:shells?|monitors?)\b`;

/**
 * Live spinner activity line: a spinner glyph followed by an "-ing" verb and
 * the U+2026 ellipsis, e.g. "✻ Thinking…", "✽ Compacting…". Past-tense
 * summaries ("✻ Sautéed for 42s") intentionally do not match.
 */
export const SPINNER_ACTIVITY_PATTERN =
  String.raw`^[ \t]*[✱✲✳✴✵✶✷✸✹✺✻✼✽✾✿❀❁❂❃❇❈❉❊❋✢✣✤✥✦✧✨⊛⊕⊙◉◎◍⁂⁕※⍟☼★☆·•⏺▸▹∙⋅] \S+ing\b[^\n]*…`;

// Compiled once. The inputs are bounded (engine snapshots are <= 16K chars),
// so a single test pass is cheap.
const SIGNALS: readonly RegExp[] = [
  new RegExp(BACKGROUND_WAITING_PATTERN, "m"),
  new RegExp(TEAM_STATUS_ROW_PATTERN, "m"),
];

/**
 * True when the given screen frame still shows a live background-agents /
 * teammates / background-shells block — i.e. the pane is BUSY even though the
 * main prompt box looks idle. Input is the engine's cached bounded screen
 * text (see AgentDetectionEngine.getScreenText); the returned value is the
 * only thing callers may use — never log or forward the input here.
 */
export function hasBackgroundWorkSignal(screenText: string | null | undefined): boolean {
  if (!screenText) return false;
  for (const signal of SIGNALS) {
    if (signal.test(screenText)) return true;
  }
  return false;
}
