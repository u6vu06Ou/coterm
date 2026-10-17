import { beforeEach, describe, expect, it } from "vitest";
import { voiceDraftStore } from "../../src/renderer/src/components/voice/voice-draft-state";

describe("voiceDraftStore", () => {
  beforeEach(() => voiceDraftStore.resetForTest());

  it("keeps partial text attached to the terminal locked at recording start", () => {
    const targetA = voiceDraftStore.lock("terminal-a");
    voiceDraftStore.update(targetA, "partial", "partial A");
    expect(voiceDraftStore.getSnapshot().byTerminal["terminal-a"]?.text).toBe("partial A");
    expect(voiceDraftStore.getSnapshot().byTerminal["terminal-b"]).toBeUndefined();
  });

  it("rejects late updates from an older input epoch", () => {
    const oldTarget = voiceDraftStore.lock("terminal-a");
    const currentTarget = voiceDraftStore.lock("terminal-a");
    voiceDraftStore.update(oldTarget, "partial", "stale");
    voiceDraftStore.update(currentTarget, "partial", "current");
    expect(voiceDraftStore.getSnapshot().byTerminal["terminal-a"]?.text).toBe("current");
  });

  it("preserves final text as a recoverable draft after the target closes", () => {
    const target = voiceDraftStore.lock("terminal-a");
    voiceDraftStore.update(target, "partial", "preview");
    voiceDraftStore.recover(target, "final text");
    expect(voiceDraftStore.getSnapshot().byTerminal["terminal-a"]).toBeUndefined();
    expect(voiceDraftStore.getSnapshot().recoverable).toMatchObject({
      sourceTerminalId: "terminal-a",
      text: "final text",
    });
  });

  it("only clears the recoverable draft with the matching epoch", () => {
    const target = voiceDraftStore.lock("terminal-a");
    voiceDraftStore.recover(target, "final text");
    voiceDraftStore.clearRecoverable(target.epoch + 1);
    expect(voiceDraftStore.getSnapshot().recoverable?.text).toBe("final text");
    voiceDraftStore.clearRecoverable(target.epoch);
    expect(voiceDraftStore.getSnapshot().recoverable).toBeNull();
  });
});
