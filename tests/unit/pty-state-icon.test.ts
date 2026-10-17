import { describe, expect, it } from "vitest";
import { ptyStateIcon } from "../../src/renderer/src/components/pty-state-icon";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Loader,
  Lock,
  OctagonX,
} from "lucide-react";
import type { PtyState } from "../../src/shared/types";

describe("ptyStateIcon — all seven canonical states", () => {
  const cases: Array<{ state: PtyState; labelKey: string; expectedIcon: typeof Loader; classNameIncludes: string }> = [
    { state: "starting", labelKey: "pty.state.starting", expectedIcon: CircleDashed, classNameIncludes: "pty-state-icon-starting" },
    { state: "running", labelKey: "pty.state.running", expectedIcon: Loader, classNameIncludes: "pty-state-icon-running" },
    { state: "waiting_input", labelKey: "pty.state.waiting_input", expectedIcon: AlertTriangle, classNameIncludes: "pty-state-icon-attention" },
    { state: "approval_required", labelKey: "pty.state.approval_required", expectedIcon: AlertTriangle, classNameIncludes: "pty-state-icon-attention" },
    { state: "blocked", labelKey: "pty.state.blocked", expectedIcon: Lock, classNameIncludes: "pty-state-icon-attention" },
    { state: "done", labelKey: "pty.state.done", expectedIcon: CheckCircle2, classNameIncludes: "pty-state-icon-done" },
    { state: "error", labelKey: "pty.state.error", expectedIcon: OctagonX, classNameIncludes: "pty-state-icon-error" },
  ];

  for (const { state, labelKey, expectedIcon, classNameIncludes } of cases) {
    it(`${state} → distinct Lucide icon + accessible label key ${labelKey}`, () => {
      const icon = ptyStateIcon(state);
      expect(icon.labelKey).toBe(labelKey);
      expect(icon.Icon).toBe(expectedIcon);
      expect(icon.className).toContain(classNameIncludes);
    });
  }

  it("null/undefined → Icon: null (no icon rendered for non-agent/no-state)", () => {
    expect(ptyStateIcon(null).Icon).toBeNull();
    expect(ptyStateIcon(undefined).Icon).toBeNull();
    expect(ptyStateIcon(null).className).toContain("pty-state-icon-none");
  });

  it("Blocked uses Lock (distinct from Error's OctagonX)", () => {
    expect(ptyStateIcon("blocked").Icon).toBe(Lock);
    expect(ptyStateIcon("error").Icon).toBe(OctagonX);
    expect(ptyStateIcon("blocked").Icon).not.toBe(ptyStateIcon("error").Icon);
  });

  it("approval/waiting use AlertTriangle (alert type, not just color)", () => {
    expect(ptyStateIcon("waiting_input").Icon).toBe(AlertTriangle);
    expect(ptyStateIcon("approval_required").Icon).toBe(AlertTriangle);
  });

  it("every non-null icon has a non-empty className with the base pty-state-icon class", () => {
    const allStates: PtyState[] = [
      "starting",
      "running",
      "waiting_input",
      "approval_required",
      "blocked",
      "done",
      "error",
    ];
    for (const state of allStates) {
      const icon = ptyStateIcon(state);
      expect(icon.className).toMatch(/^pty-state-icon\b/);
    }
  });

  it("error icon carries both attention and error classes", () => {
    const icon = ptyStateIcon("error");
    expect(icon.className).toContain("pty-state-icon-attention");
    expect(icon.className).toContain("pty-state-icon-error");
  });
});
