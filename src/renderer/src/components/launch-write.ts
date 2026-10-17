// Agent launch write contract (private #50/#51): a complete launch command is
// submitted as ONE write carrying exactly ONE trailing CR ("auto-Enter").
// A second Enter (or a missing one) is what made codex launches double-
// submit / sit unsubmitted at the prompt. Normalization rules:
//   - trailing CRs on the command are stripped, then exactly one "\r" is added
//   - bracketed multiline content (embedded \n) is left untouched
// Every agent launch site MUST use buildAgentLaunchWriteInput so the invariant
// holds everywhere: the rebuild path + existing-tile path in TerminalDock,
// and resumeWorktreeAction in app-store (worktree resume — #50/#51 retry).

import type { TerminalWriteInput } from "@shared/types";

export interface LaunchCommandLike {
  command: string;
}

export function buildAgentLaunchWriteInput(
  terminalId: string,
  spec: LaunchCommandLike,
): TerminalWriteInput {
  const command = spec.command.replace(/\r+$/u, "");
  return {
    terminalId,
    data: `${command}\r`,
    source: "automation",
    waitForShellReady: true,
  };
}

/** Contract probe used by the fixture tests: exactly one CR, and it is last. */
export function submitExactlyOneEnter(data: string): boolean {
  return data.endsWith("\r") && (data.match(/\r/gu) ?? []).length === 1;
}
