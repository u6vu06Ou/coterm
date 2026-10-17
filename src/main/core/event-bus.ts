import { EventEmitter } from "node:events";
import type { AgentOption, BrowserArtifactSaved, CommandResult, NormalizedEvent, PtyStateChanged, UsageSnapshot } from "@shared/types";

interface EventMap {
  event: [NormalizedEvent];
  terminalData: [{
    terminalId: string;
    projectId: string;
    data: string;
    replace?: boolean;
    force?: boolean;
    revision: number;
  }];
  terminalExit: [{ terminalId: string; projectId: string; exitCode: number }];
  // Fired when a terminal is created or killed so every client (including
  // mobile, which only projects a single PTY) can refresh its terminal list
  // and stay in sync with the desktop.
  // projectIds: present only when a new terminal re-ordered the project list
  // (最近開過置頂) — the full active-project order after the bump.
  terminalListChanged: [{ projectId: string; projectIds?: string[] }];
  // Fired when a shell command completes a rich OSC 633 lifecycle (E+C+D).
  // Carries a privacy-safe CommandResult (command already redactEgress'd).
  // Never logged with command text in coterm.log — see osc-parser/pty-manager.
  terminalCommand: [{ terminalId: string; projectId: string; result: CommandResult }];
  // Fired on every canonical PtyState transition. Metadata-only: terminalId,
  // projectId, state, previousState, source. Never the prompt/command/message.
  // AttentionCenter subscribes to file need-a-human notifications; the WS
  // broadcasts it so desktop ring/badge + mobile push stay in sync.
  ptyStateChanged: [PtyStateChanged];
  // Fired when the global paid-account usage snapshot changes (every 10s poll
  // of local Claude/Codex usage files). Metadata-only: percentages + reset
  // epochs + source file mtime. Never the file body (§A.2).
  usageChanged: [UsageSnapshot];
  // Fired when the built-in browser saves a screenshot artifact to disk.
  // Metadata-only (path/url/title); the image itself never crosses the bus.
  browserArtifactSaved: [BrowserArtifactSaved];
  // Private #50/#51: fired once per terminal on its first PTY output with the
  // three cold-start stage durations. Metadata-only: terminalId, profile,
  // shellKind, resolveMs/spawnMs/firstOutputMs. NEVER the command line, cwd,
  // or any env value (§A.2). Declared inline (not imported from pty-manager)
  // to keep this module free of main-process cycles.
  coldStartTiming: [{
    terminalId: string;
    profile: string;
    shellKind: string;
    resolveMs: number;
    spawnMs: number;
    firstOutputMs: number;
  }];
  // Hot model registry (stage 1): fired when settings.customProfiles changes.
  // Carries the FULL derived agent option list (id/label/model/local/harness)
  // so every surface — desktop picker, web, mobile — can rebuild its "＋"
  // menu without a restart. Metadata only: no env values, no tokens (§A.2).
  profilesChanged: [AgentOption[]];
}

export class AppEventBus extends EventEmitter<EventMap> {}
