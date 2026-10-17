import { describe, expect, it } from "vitest";
import { MobileInputController } from "../../src/renderer/src/components/mobile/mobile-input-controller";
import {
  forceResolveCompositionForSend,
  shouldSubmitComposerOnEnter,
} from "../../src/renderer/src/components/mobile/mobile-composer-submit";

// iPhone native dictation (語音輸入 on the iOS keyboard) inserts text via
// beforeinput/input events with insertText/insertReplacementText and fires
// composition events around marked text. These tests pin the guards that keep
// dictation working: text lands in the per-terminal draft through input events
// only, NOTHING submits while a composition is open, and only an explicit
// Send tap or a genuine Enter keydown may send.

describe("shouldSubmitComposerOnEnter", () => {
  it("blocks Enter while the keydown itself is inside a composition", () => {
    expect(shouldSubmitComposerOnEnter({ eventComposing: true, keyCode: 13, controllerComposing: false })).toBe(false);
  });

  it("blocks Enter that passed through IME processing (keyCode 229) even when flags already cleared", () => {
    // Some IMEs end composition BEFORE the Enter that confirms the candidate;
    // isComposing is already false on that keydown, so 229 is the only signal.
    expect(shouldSubmitComposerOnEnter({ eventComposing: false, keyCode: 229, controllerComposing: false })).toBe(false);
  });

  it("blocks Enter while the controller still holds a composition flag (marked dictation text)", () => {
    expect(shouldSubmitComposerOnEnter({ eventComposing: false, keyCode: 13, controllerComposing: true })).toBe(false);
  });

  it("allows a genuine Enter keypress", () => {
    expect(shouldSubmitComposerOnEnter({ eventComposing: false, keyCode: 13, controllerComposing: false })).toBe(true);
  });
});

describe("dictation sequences through the controller", () => {
  it("insert then revise (insertReplacementText) keeps the latest revision as the draft", () => {
    const controller = new MobileInputController();
    controller.open({ terminalId: "t1", reason: "reader" });
    // Dictation starts: compositionstart → marked text begins.
    controller.setComposition(true);
    // insertText "你好" → input event → controlled onChange writes the value.
    controller.setDraft("t1", "你好");
    // iOS revises the marked text: insertReplacementText replaces it with
    // "你好嗎" → the controlled input event carries the WHOLE new value.
    controller.setDraft("t1", "你好嗎");
    expect(controller.getSnapshot().draftsByTerminal.t1).toBe("你好嗎");
    // Still marked — nothing has submitted, nothing cleared the draft.
    expect(controller.isComposing()).toBe(true);
    expect(controller.getSnapshot().state.status).not.toBe("closed");
  });

  it("Enter during an open dictation composition submits nothing and keeps the draft", async () => {
    const controller = new MobileInputController();
    const writes: string[] = [];
    controller.open({ terminalId: "t1", reason: "reader" });
    controller.setComposition(true);
    controller.setDraft("t1", "講到一半");
    // The Enter keydown is rejected by the guard...
    expect(shouldSubmitComposerOnEnter({
      eventComposing: true,
      keyCode: 13,
      controllerComposing: controller.isComposing(),
    })).toBe(false);
    // ...and even if a caller slipped past it, submit() itself refuses while
    // composing: the draft must survive until dictation finishes revising.
    expect(await controller.submit(({ data }) => { writes.push(data); })).toBe(false);
    expect(writes).toEqual([]);
    expect(controller.getSnapshot().draftsByTerminal.t1).toBe("講到一半");
  });

  it("Send tap with still-marked dictation text force-resolves and submits the latest revision exactly once", async () => {
    const controller = new MobileInputController();
    const writes: string[] = [];
    controller.open({ terminalId: "t1", reason: "reader" });
    controller.setComposition(true);
    controller.setDraft("t1", "舊版本");
    // 2026-10-06 field bug: long dictated sentences left the composition open
    // forever, so the send tap silently did nothing. The tap takes the
    // textarea's LIVE value (which may be newer than the last echoed draft).
    forceResolveCompositionForSend("t1", "最新修正版", controller);
    expect(controller.isComposing()).toBe(false);
    expect(controller.getSnapshot().draftsByTerminal.t1).toBe("最新修正版");
    expect(await controller.submit(({ data }) => { writes.push(data); })).toBe(true);
    expect(writes).toEqual(["\x1b[200~最新修正版\x1b[201~"]);
    // Sent: draft cleared, and dictation's late revisions must not resurrect it.
    expect(controller.getSnapshot().draftsByTerminal.t1).toBe("");
  });

  it("Send tap with no open composition leaves the draft untouched", () => {
    const controller = new MobileInputController();
    controller.open({ terminalId: "t1", reason: "reader" });
    controller.setDraft("t1", "typed");
    forceResolveCompositionForSend("t1", "typed", controller);
    expect(controller.getSnapshot().draftsByTerminal.t1).toBe("typed");
  });

  it("a reader session hands over to the floating composer with the draft intact", () => {
    const controller = new MobileInputController();
    controller.open({ terminalId: "t1", reason: "reader" });
    controller.setDraft("t1", "keep across surfaces");
    // Reader closes: "unmount" keeps drafts by design.
    controller.close("unmount");
    expect(controller.getSnapshot().draftsByTerminal.t1).toBe("keep across surfaces");
    // Floating composer opens next and sees the same draft.
    controller.open({ terminalId: "t1", reason: "bottom-tap" });
    expect(controller.getSnapshot().draftsByTerminal.t1).toBe("keep across surfaces");
  });
});
