import { describe, expect, it } from "vitest";
import { ptySignalTone, ptyStateLabelKey } from "../../src/renderer/src/components/pty-state-label";

describe("ptyStateLabelKey", () => {
  it("maps every canonical PtyState to a label key", () => {
    expect(ptyStateLabelKey("starting")).toBe("pty.state.starting");
    expect(ptyStateLabelKey("running")).toBe("pty.state.running");
    expect(ptyStateLabelKey("waiting_input")).toBe("pty.state.waiting_input");
    expect(ptyStateLabelKey("approval_required")).toBe("pty.state.approval_required");
    expect(ptyStateLabelKey("blocked")).toBe("pty.state.blocked");
    expect(ptyStateLabelKey("done")).toBe("pty.state.done");
    expect(ptyStateLabelKey("error")).toBe("pty.state.error");
  });

  it("returns null for null/undefined (no state yet)", () => {
    expect(ptyStateLabelKey(null)).toBeNull();
    expect(ptyStateLabelKey(undefined)).toBeNull();
  });
});

describe("ptySignalTone", () => {
  it("collapses canonical states into working, ready, and attention", () => {
    expect(ptySignalTone("starting")).toBe("working");
    expect(ptySignalTone("running")).toBe("working");
    expect(ptySignalTone("done")).toBe("ready");
    expect(ptySignalTone("waiting_input")).toBe("attention");
    expect(ptySignalTone("approval_required")).toBe("attention");
    expect(ptySignalTone("blocked")).toBe("attention");
    expect(ptySignalTone("error")).toBe("attention");
  });

  it("falls back to unknown before the dashboard hydrates", () => {
    expect(ptySignalTone(null)).toBe("unknown");
    expect(ptySignalTone(undefined)).toBe("unknown");
  });
});
