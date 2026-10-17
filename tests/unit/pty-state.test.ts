import { describe, expect, it } from "vitest";
import {
  ATTENTION_STATES,
  isAttentionState,
  isInterruptible,
  isAgentWorking,
  canTransitionTo,
  ptyStateSourceAuthority,
  toLegacyPtyState,
} from "../../src/shared/pty-state";
import type { PtyState } from "../../src/shared/types";

describe("pty-state — canonical helpers", () => {
  it("ATTENTION_STATES covers the four need-a-human states", () => {
    expect([...ATTENTION_STATES].sort()).toEqual(
      ["approval_required", "blocked", "error", "waiting_input"],
    );
  });

  it("isAttentionState is true only for attention states", () => {
    expect(isAttentionState("waiting_input")).toBe(true);
    expect(isAttentionState("approval_required")).toBe(true);
    expect(isAttentionState("blocked")).toBe(true);
    expect(isAttentionState("error")).toBe(true);
    expect(isAttentionState("running")).toBe(false);
    expect(isAttentionState("done")).toBe(false);
    expect(isAttentionState("starting")).toBe(false);
    expect(isAttentionState(null)).toBe(false);
  });

  it("isInterruptible: only running may be Ctrl+C'd", () => {
    expect(isInterruptible("running")).toBe(true);
    // Attention states must NEVER be interruptible.
    expect(isInterruptible("waiting_input")).toBe(false);
    expect(isInterruptible("approval_required")).toBe(false);
    expect(isInterruptible("blocked")).toBe(false);
    expect(isInterruptible("error")).toBe(false);
    expect(isInterruptible("done")).toBe(false);
    expect(isInterruptible(null)).toBe(false);
  });

  it("isAgentWorking: only starting/running are active computation", () => {
    expect(isAgentWorking("starting")).toBe(true);
    expect(isAgentWorking("running")).toBe(true);
    expect(isAgentWorking("waiting_input")).toBe(false);
    expect(isAgentWorking("approval_required")).toBe(false);
    expect(isAgentWorking("blocked")).toBe(false);
    expect(isAgentWorking("error")).toBe(false);
    expect(isAgentWorking("done")).toBe(false);
    expect(isAgentWorking(null)).toBe(false);
  });
});

describe("pty-state — heuristic priority guard (canTransitionTo)", () => {
  it("heuristic may enter running from starting", () => {
    expect(canTransitionTo("starting", "running", "heuristic")).toBe(true);
  });

  it("heuristic may NOT overwrite an attention state", () => {
    // The core guard: ANSI title parser must not clobber approval_required.
    expect(canTransitionTo("approval_required", "running", "heuristic")).toBe(false);
    expect(canTransitionTo("blocked", "done", "heuristic")).toBe(false);
    expect(canTransitionTo("waiting_input", "running", "heuristic")).toBe(false);
    expect(canTransitionTo("error", "done", "heuristic")).toBe(false);
  });

  it("conservative heuristic may enter attention but cannot overwrite it", () => {
    expect(canTransitionTo("running", "approval_required", "heuristic")).toBe(true);
    expect(canTransitionTo("done", "blocked", "heuristic")).toBe(true);
    expect(canTransitionTo("blocked", "approval_required", "heuristic")).toBe(false);
  });

  it("screen/heuristic-filed errors may be retracted by screen/heuristic (issue #25)", () => {
    expect(canTransitionTo("error", "running", "heuristic", "screen")).toBe(true);
    expect(canTransitionTo("error", "done", "screen", "heuristic")).toBe(true);
    expect(canTransitionTo("error", "running", "screen", "screen")).toBe(true);
  });

  it("hard-sourced errors stay locked against screen/heuristic", () => {
    expect(canTransitionTo("error", "running", "heuristic", "osc")).toBe(false);
    expect(canTransitionTo("error", "done", "screen", "provider")).toBe(false);
    expect(canTransitionTo("error", "running", "heuristic", "process")).toBe(false);
    // Unknown provenance (no recorded source) is treated as hard: no retraction.
    expect(canTransitionTo("error", "running", "heuristic")).toBe(false);
    // Hard sources themselves may still clear any error.
    expect(canTransitionTo("error", "running", "provider", "process")).toBe(true);
  });

  it("screen rules may enter attention but cannot clear or rewrite it", () => {
    expect(canTransitionTo("running", "waiting_input", "screen", "heuristic")).toBe(true);
    expect(canTransitionTo("waiting_input", "running", "screen", "screen")).toBe(false);
    expect(canTransitionTo("waiting_input", "blocked", "screen", "screen")).toBe(false);
  });

  it("lower authority cannot replace a hard attention state", () => {
    expect(canTransitionTo("blocked", "running", "osc", "provider")).toBe(false);
    expect(canTransitionTo("blocked", "running", "provider", "osc")).toBe(true);
    expect(ptyStateSourceAuthority("heuristic")).toBeLessThan(ptyStateSourceAuthority("screen"));
    expect(ptyStateSourceAuthority("screen")).toBeLessThan(ptyStateSourceAuthority("osc"));
    expect(ptyStateSourceAuthority("osc")).toBeLessThan(ptyStateSourceAuthority("broker"));
  });

  it("osc/broker/provider may enter and clear attention states", () => {
    expect(canTransitionTo("running", "approval_required", "osc")).toBe(true);
    expect(canTransitionTo("approval_required", "running", "broker")).toBe(true);
    expect(canTransitionTo("blocked", "done", "provider")).toBe(true);
  });

  it("same state is a no-op (returns false so caller skips emit)", () => {
    expect(canTransitionTo("running", "running", "osc")).toBe(false);
    expect(canTransitionTo("approval_required", "approval_required", "broker")).toBe(false);
  });

  it("null current allows any transition", () => {
    expect(canTransitionTo(null, "running", "heuristic")).toBe(true);
    expect(canTransitionTo(null, "approval_required", "osc")).toBe(true);
  });
});

describe("pty-state — legacy mapping (toLegacyPtyState)", () => {
  const cases: Array<[PtyState, "idle" | "shell-ready" | "llm-running"]> = [
    ["starting", "llm-running"],
    ["running", "llm-running"],
    ["waiting_input", "llm-running"],
    ["approval_required", "llm-running"],
    ["blocked", "llm-running"],
    ["error", "llm-running"],
    ["done", "idle"],
  ];
  for (const [state, legacy] of cases) {
    it(`${state} → ${legacy}`, () => {
      expect(toLegacyPtyState(state)).toBe(legacy);
    });
  }
  it("null → idle", () => {
    expect(toLegacyPtyState(null)).toBe("idle");
  });
});
