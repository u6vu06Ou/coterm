import { describe, expect, it } from "vitest";
import { MobileInputController } from "../../src/renderer/src/components/mobile/mobile-input-controller";

describe("MobileInputController", () => {
  it("stages multiline text without executing Enter, even with a legacy opt-in", async () => {
    const controller = new MobileInputController();
    controller.open({ terminalId: "t1", reason: "reader" });
    controller.setSendWithEnter("t1", true);
    controller.setDraft("t1", "first\nsecond");
    const writes: string[] = [];
    await controller.submit(({ data }) => { writes.push(data); });
    expect(writes).toEqual(["\x1b[200~first\nsecond\x1b[201~"]);
    expect(controller.getSnapshot().pastedByTerminal.t1).toEqual({ text: "first\nsecond", entered: false });
    controller.markEntered("t1");
    expect(controller.getSnapshot().pastedByTerminal.t1?.entered).toBe(true);
  });

  it("retains consecutive pasted fragments and blocks escape sequences from ending paste", async () => {
    const controller = new MobileInputController();
    controller.open({ terminalId: "t1", reason: "reader" });
    controller.setDraft("t1", "one");
    await controller.submit(() => undefined);
    controller.open({ terminalId: "t1", reason: "reader" });
    controller.setDraft("t1", "two\x1b[201~");
    const writes: string[] = [];
    await controller.submit(({ data }) => { writes.push(data); });
    expect(writes).toEqual(["\x1b[200~two[201~\x1b[201~"]);
    expect(controller.getSnapshot().pastedByTerminal.t1?.text).toBe("onetwo[201~");
  });
  it("only owns input while a terminal is open", () => {
    const controller = new MobileInputController();
    expect(controller.getSnapshot().state.status).toBe("closed");
    controller.open({ terminalId: "t1", reason: "toolbar" });
    expect(controller.isOpenFor("t1")).toBe(true);
    controller.close("cancel");
    expect(controller.isOpenFor("t1")).toBe(false);
  });

  it("keeps drafts per terminal and submits exactly once", async () => {
    const controller = new MobileInputController();
    const writes: string[] = [];
    controller.open({ terminalId: "t1", reason: "toolbar" });
    controller.setDraft("t1", "hello");
    const writer = async ({ data }: { data: string }): Promise<void> => {
      writes.push(data);
      await Promise.resolve();
    };
    const first = controller.submit(writer);
    const second = controller.submit(writer);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(writes).toEqual(["\x1b[200~hello\x1b[201~"]);
    expect(controller.getSnapshot().draftsByTerminal.t1).toBe("");
  });

  it("blocks submit during composition and retains a failed draft", async () => {
    const controller = new MobileInputController();
    controller.open({ terminalId: "t1", reason: "toolbar" });
    controller.setDraft("t1", "中文");
    controller.setComposition(true);
    expect(controller.isComposing()).toBe(true);
    expect(await controller.submit(() => undefined)).toBe(false);
    controller.setComposition(false);
    expect(controller.isComposing()).toBe(false);
    expect(await controller.submit(() => { throw new Error("offline"); })).toBe(false);
    expect(controller.getSnapshot().draftsByTerminal.t1).toBe("中文");
    expect(controller.getSnapshot().error).toBe("offline");
  });

  it("blocks submit during composition without invoking the writer, then succeeds once composition ends", async () => {
    const controller = new MobileInputController();
    const writes: string[] = [];
    controller.open({ terminalId: "t1", reason: "toolbar" });
    controller.setDraft("t1", "中文");
    controller.setComposition(true);
    const writer = async ({ data }: { data: string }): Promise<void> => {
      writes.push(data);
      await Promise.resolve();
    };
    expect(await controller.submit(writer)).toBe(false);
    expect(writes).toEqual([]);
    controller.setComposition(false);
    expect(await controller.submit(writer)).toBe(true);
    expect(writes).toEqual(["\x1b[200~中文\x1b[201~"]);
  });

  it("closes on terminal switch without deleting the old draft", () => {
    const controller = new MobileInputController();
    controller.open({ terminalId: "old", reason: "toolbar" });
    controller.setDraft("old", "keep me");
    controller.close("terminal-switch");
    controller.open({ terminalId: "new", reason: "bottom-tap" });
    expect(controller.getSnapshot().draftsByTerminal.old).toBe("keep me");
    expect(controller.getSnapshot().draftsByTerminal.new ?? "").toBe("");
  });

  it("clears cancelled drafts and restores the default enter mode", () => {
    const controller = new MobileInputController();
    controller.open({ terminalId: "t1", reason: "toolbar" });
    controller.setDraft("t1", "discard me");
    controller.setSendWithEnter("t1", false);
    controller.close("cancel");

    controller.open({ terminalId: "t1", reason: "toolbar" });
    expect(controller.getSnapshot().draftsByTerminal.t1 ?? "").toBe("");
    expect(controller.getSnapshot().sendWithEnterByTerminal.t1).toBeUndefined();
  });
});
