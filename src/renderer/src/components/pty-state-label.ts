import type { PtyState } from "@shared/types";
import type { MessageKey } from "../i18n";

/**
 * Map a canonical PtyState to the i18n key for its compact TopBar label.
 * starting/running/waiting_input/approval_required/blocked/done/error each
 * get a human label; null (no state yet) → null (button shows just its number).
 */
export function ptyStateLabelKey(state: PtyState | null | undefined): MessageKey | null {
  switch (state) {
    case "starting": return "pty.state.starting";
    case "running": return "pty.state.running";
    case "waiting_input": return "pty.state.waiting_input";
    case "approval_required": return "pty.state.approval_required";
    case "blocked": return "pty.state.blocked";
    case "done": return "pty.state.done";
    case "error": return "pty.state.error";
    default: return null;
  }
}

/**
 * Collapse the seven canonical PTY states into three glanceable signal tones.
 * The exact state is still exposed in the button tooltip/accessibility label.
 */
export type PtySignalTone = "working" | "ready" | "attention" | "unknown";

export function ptySignalTone(state: PtyState | null | undefined): PtySignalTone {
  switch (state) {
    case "starting":
    case "running":
      return "working";
    case "done":
      return "ready";
    case "waiting_input":
    case "approval_required":
    case "blocked":
    case "error":
      return "attention";
    default:
      return "unknown";
  }
}
