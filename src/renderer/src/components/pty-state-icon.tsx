import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Loader,
  Lock,
  OctagonX,
  type LucideIcon,
} from "lucide-react";
import type { PtyState } from "@shared/types";
import type { MessageKey } from "../i18n";

/**
 * Lucide icon + accessible label key for each canonical PtyState. Used by the
 * XtermPane header status icon (Issue #3). The icon is purely informational —
 * the exact state is also exposed in the title/aria-label. Reduced-motion is
 * handled in CSS (the working/attention icons get a CSS animation that the
 * prefers-reduced-motion media query disables); the icon choice itself never
 * animates, so it is reduced-motion safe by construction.
 *
 * Round 2: null/undefined → Icon: null (no icon rendered). Non-agent tiles or
 * tiles with no state must NOT show any status icon. Each canonical state has a
 * distinct, semantically meaningful Lucide icon (Blocked=Lock, Error=OctagonX,
 * approval/waiting=AlertTriangle) so the meaning is conveyed by shape, not
 * color alone.
 */
export interface PtyStateIcon {
  /** null when no icon should be rendered (non-agent / no state). */
  Icon: LucideIcon | null;
  labelKey: MessageKey;
  /** CSS class for tone + reduced-motion-aware animation. */
  className: string;
}

export function ptyStateIcon(state: PtyState | null | undefined): PtyStateIcon {
  switch (state) {
    case "starting":
      return { Icon: CircleDashed, labelKey: "pty.state.starting", className: "pty-state-icon pty-state-icon-starting" };
    case "running":
      return { Icon: Loader, labelKey: "pty.state.running", className: "pty-state-icon pty-state-icon-running" };
    case "waiting_input":
      return { Icon: AlertTriangle, labelKey: "pty.state.waiting_input", className: "pty-state-icon pty-state-icon-attention" };
    case "approval_required":
      return { Icon: AlertTriangle, labelKey: "pty.state.approval_required", className: "pty-state-icon pty-state-icon-attention" };
    case "blocked":
      return { Icon: Lock, labelKey: "pty.state.blocked", className: "pty-state-icon pty-state-icon-attention" };
    case "done":
      return { Icon: CheckCircle2, labelKey: "pty.state.done", className: "pty-state-icon pty-state-icon-done" };
    case "error":
      return { Icon: OctagonX, labelKey: "pty.state.error", className: "pty-state-icon pty-state-icon-attention pty-state-icon-error" };
    default:
      // null/undefined: no icon. Non-agent tiles and tiles with no state yet
      // render nothing — the header must not show a status icon in that case.
      return { Icon: null, labelKey: "pty.state.starting", className: "pty-state-icon pty-state-icon-none" };
  }
}
