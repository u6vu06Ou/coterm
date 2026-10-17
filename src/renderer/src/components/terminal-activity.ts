import type { PtyState } from "@shared/types";
import { isAgentWorking, isAttentionState, isInterruptible } from "@shared/pty-state";

/** Accept canonical state plus the legacy dashboard values during migration. */
export function isAgentWorkingPtyState(state: PtyState | "idle" | "shell-ready" | "llm-running" | null | undefined): boolean {
  if (state === "llm-running") return true;
  if (state === "idle" || state === "shell-ready" || !state) return false;
  return isAgentWorking(state);
}

export function isAttentionRequiredPtyState(state: PtyState | null | undefined): boolean {
  return isAttentionState(state);
}

export function isInterruptiblePtyState(state: PtyState | null | undefined): boolean {
  return isInterruptible(state);
}
