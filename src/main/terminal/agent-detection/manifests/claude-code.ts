// Bundled Claude Code detection manifest — original, clean-room.
//
// Fixture source: Coterm's own ConPTY observations + the existing
// AGENT_FALLBACK_PATTERNS in src/main/terminal/pty-manager.ts (the approval /
// input / blocked phrases). No third-party
// manifest content is copied. Phrases are anchored to the bottom region so
// source code the agent prints (which may contain "Error:" or "Allow") does
// not trigger a false positive.
//
// Coverage (issue §5): working, done/prompt-ready, approval, waiting/selection,
// explicit blocked, Esc/Ctrl+C recovery. No screen-sourced error rule: real
// fatal errors exit the process (pty-manager process-source error); noisy
// stderr banners must not file an unrecoverable error state.

import type { Manifest } from "../types";
import {
  BACKGROUND_WAITING_PATTERN,
  SPINNER_ACTIVITY_PATTERN,
  TEAM_STATUS_ROW_PATTERN,
} from "../background-work";

export const bundledClaudeCodeManifest: Manifest = {
  profile: "claude-code",
  version: "1.1.0",
  rules: [
    // --- Approval (permission panel) — highest priority -------------------
    // Claude Code draws a permission panel below a horizontal rule with
    // "Yes" / "No" options and an "esc to cancel" hint.
    {
      id: "claude_approval_panel",
      state: "approval_required",
      priority: 900,
      region: "after_last_horizontal_rule",
      all: [{ contains: ["esc to cancel"] }],
      any: [
        { contains: ["Yes"] },
        { contains: ["No"] },
        { contains: ["Do you want to"] },
        { contains: ["Allow"] },
      ],
      none: [{ contains: ["```"] }],
      profile: "claude-code",
    },
    // --- Waiting for selection / input ------------------------------------
    {
      id: "claude_waiting_input",
      state: "waiting_input",
      priority: 850,
      region: "bottom_non_empty",
      all: [{
        regex: "^[ \\t]*(Enter to select|Press enter to continue|Type your response|Choose an option|Select an option)\\b",
        flags: "im",
      }],
      none: [{ contains: ["```"] }],
      profile: "claude-code",
    },
    // --- Explicit blocked -------------------------------------------------
    {
      id: "claude_blocked_explicit",
      state: "blocked",
      priority: 820,
      region: "bottom_non_empty",
      all: [{
        regex: "^[ \\t]*(Blocked|Deadlock|Waiting for lock|Cannot proceed)\\b",
        flags: "im",
      }],
      none: [{ contains: ["```"] }],
      profile: "claude-code",
    },
    // --- Esc / Ctrl+C recovery -------------------------------------------
    // After an interrupt, Claude Code prints an "Interrupted" / "Cancelled"
    // banner and returns to a prompt-ready state.
    {
      id: "claude_interrupted_recovery",
      state: "done",
      priority: 700,
      region: "bottom_non_empty",
      all: [{ regex: "^[ \\t]*(Interrupted|Cancelled by user|Aborted)\\b", flags: "im" }],
      none: [{ contains: ["```"] }],
      profile: "claude-code",
    },
    // --- Background agents still running (the pane is NOT idle) -----------
    // When the main agent parks on background subagents the prompt box looks
    // idle and output stops streaming, but the status block still shows live
    // signals. Any of them means "running", never done. All three patterns
    // come from ../background-work so the quiet-debounce override in
    // pty-manager reuses the exact same definitions.
    // Waiting spinner line: "✻ Waiting for 8 background agents to finish".
    {
      id: "claude_bg_agents_waiting",
      state: "running",
      priority: 680,
      region: "prompt_box_body",
      all: [{ regex: BACKGROUND_WAITING_PATTERN, flags: "m" }],
      profile: "claude-code",
    },
    // Teammate rows with ticking elapsed/token counters:
    // "○ alpha-mate  <task>  14m 15s · ↓ 172.5k tokens".
    {
      id: "claude_bg_team_rows",
      state: "running",
      priority: 670,
      region: "bottom_non_empty",
      all: [{ regex: TEAM_STATUS_ROW_PATTERN, flags: "m" }],
      profile: "claude-code",
    },
    // --- Working (spinner in OSC title) ----------------------------------
    // Claude Code sets the OSC 0 title to a braille spinner glyph while
    // computing. A braille glyph at the title's start = working.
    {
      id: "claude_working_title_spinner",
      state: "running",
      priority: 600,
      region: "osc_title",
      all: [{ regex: "^[\\u2800-\\u28FF]", flags: "" }],
      profile: "claude-code",
    },
    // --- Done / prompt-ready ---------------------------------------------
    // The bottom line is a Claude prompt marker ("> " at start) with no
    // approval/selection hint above it. The prompt is drawn on EVERY frame —
    // even while background agents are running — so any live background-work
    // or spinner signal in the region vetoes the done verdict.
    {
      id: "claude_done_prompt",
      state: "done",
      priority: 100,
      region: "bottom_non_empty",
      all: [{ regex: "^>\\s", flags: "m" }],
      none: [
        { regex: "^[ \\t]*esc to cancel\\b", flags: "im" },
        { regex: "^[ \\t]*Enter to select\\b", flags: "im" },
        { regex: BACKGROUND_WAITING_PATTERN, flags: "m" },
        { regex: TEAM_STATUS_ROW_PATTERN, flags: "m" },
        { regex: SPINNER_ACTIVITY_PATTERN, flags: "m" },
      ],
      profile: "claude-code",
    },
  ],
};
