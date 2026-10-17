import { describe, expect, it } from "vitest";
import { isAgentWorkingPtyState } from "../../src/renderer/src/components/terminal-activity";

describe("isAgentWorkingPtyState", () => {
  it("marks only an actively running LLM PTY as working", () => {
    expect(isAgentWorkingPtyState("llm-running")).toBe(true);
    expect(isAgentWorkingPtyState("running")).toBe(true);
    expect(isAgentWorkingPtyState("waiting_input")).toBe(false);
    expect(isAgentWorkingPtyState("approval_required")).toBe(false);
    expect(isAgentWorkingPtyState("blocked")).toBe(false);
    expect(isAgentWorkingPtyState("error")).toBe(false);
    expect(isAgentWorkingPtyState("starting")).toBe(true);
    expect(isAgentWorkingPtyState("done")).toBe(false);
    expect(isAgentWorkingPtyState("shell-ready")).toBe(false);
    expect(isAgentWorkingPtyState("idle")).toBe(false);
    expect(isAgentWorkingPtyState(null)).toBe(false);
  });
});
