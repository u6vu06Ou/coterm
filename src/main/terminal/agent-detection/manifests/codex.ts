// Bundled Codex detection manifest — original, clean-room.
//
// Fixture source: Coterm's own ConPTY observations + the existing
// AGENT_FALLBACK_PATTERNS in src/main/terminal/pty-manager.ts. Codex CLI
// (codex-local-main / codex-local-long) shares the same approval/input/blocked/error
// phrase families as Claude Code but uses a different prompt marker ("codex>"
// / "$") and a different spinner style. No third-party content is copied.
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
  TOKEN_STATS_PATTERN,
} from "../background-work";

export const bundledCodexManifest: Manifest = {
  profile: "codex",
  version: "1.1.0",
  rules: [
    // --- Approval (Codex permission prompt) -------------------------------
    // Codex prints "Do you want to ..." / "Allow ..." with a Yes/No choice.
    {
      id: "codex_approval_prompt",
      state: "approval_required",
      priority: 900,
      region: "bottom_non_empty",
      all: [{
        regex: "^[ \\t]*(Do you want to|Would you like to|Allow|Approve)\\b.*(?:\\?|:)",
        flags: "im",
      }],
      any: [
        { contains: ["Yes"] },
        { contains: ["No"] },
        { contains: ["(y/n)"] },
        { contains: ["[y/n]"] },
      ],
      none: [{ contains: ["```"] }],
      profile: "codex",
    },
    // --- Waiting for selection / input ------------------------------------
    {
      id: "codex_waiting_input",
      state: "waiting_input",
      priority: 850,
      region: "bottom_non_empty",
      all: [{
        regex: "^[ \\t]*(Enter to select|Press enter to continue|Type your response|Choose an option)\\b",
        flags: "im",
      }],
      none: [{ contains: ["```"] }],
      profile: "codex",
    },
    // --- Explicit blocked -------------------------------------------------
    {
      id: "codex_blocked_explicit",
      state: "blocked",
      priority: 820,
      region: "bottom_non_empty",
      all: [{
        regex: "^[ \\t]*(Blocked|Deadlock|Waiting for lock|Cannot proceed)\\b",
        flags: "im",
      }],
      none: [{ contains: ["```"] }],
      profile: "codex",
    },
    // --- Esc / Ctrl+C recovery -------------------------------------------
    {
      id: "codex_interrupted_recovery",
      state: "done",
      priority: 700,
      region: "bottom_non_empty",
      all: [{ regex: "^[ \\t]*(Interrupted|Cancelled by user|Aborted)\\b", flags: "im" }],
      none: [{ contains: ["```"] }],
      profile: "codex",
    },
    // --- Background agents still running (the pane is NOT idle) -----------
    // Codex background-agent/team runs share Claude Code's parked-prompt
    // shape: the main turn stops streaming while subagents work. The patterns
    // come from ../background-work so the pty-manager quiet-debounce override
    // reuses the exact same definitions.
    {
      id: "codex_bg_agents_waiting",
      state: "running",
      priority: 680,
      region: "prompt_box_body",
      all: [{ regex: BACKGROUND_WAITING_PATTERN, flags: "m" }],
      profile: "codex",
    },
    // Elapsed + token-counter status rows (bulleted teammate rows or the
    // parenthesized compact form).
    {
      id: "codex_bg_token_counters",
      state: "running",
      priority: 670,
      region: "bottom_non_empty",
      all: [{ any: [
        { regex: TEAM_STATUS_ROW_PATTERN, flags: "m" },
        { regex: TOKEN_STATS_PATTERN, flags: "m" },
      ] }],
      profile: "codex",
    },
    // --- Working (spinner / "Thinking" in title) -------------------------
    // Codex sets the OSC title to a spinner or "Thinking…" while computing.
    {
      id: "codex_working_title",
      state: "running",
      priority: 600,
      region: "osc_title",
      all: [{ any: [
        { regex: "^[\\u2800-\\u28FF]", flags: "" },
        { regex: "^(Thinking|Working)(?:…|\\.\\.\\.|$)", flags: "i" },
      ] }],
      profile: "codex",
    },
    // --- Done / prompt-ready ---------------------------------------------
    // Codex prompt marker: "codex>" or "$ " at line start. The prompt is
    // drawn on every frame, so live background-work signals veto it.
    {
      id: "codex_done_prompt",
      state: "done",
      priority: 100,
      region: "bottom_non_empty",
      all: [{ regex: "^(codex>|\\$)\\s", flags: "m" }],
      none: [
        { regex: "^[ \\t]*esc to cancel\\b", flags: "im" },
        { regex: "^[ \\t]*Enter to select\\b", flags: "im" },
        { regex: BACKGROUND_WAITING_PATTERN, flags: "m" },
        { regex: TEAM_STATUS_ROW_PATTERN, flags: "m" },
        { regex: SPINNER_ACTIVITY_PATTERN, flags: "m" },
      ],
      profile: "codex",
    },
  ],
};
