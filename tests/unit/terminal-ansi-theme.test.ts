import { describe, expect, it } from "vitest";
import { createLightTerminalAnsiNormalizer } from "../../src/renderer/src/components/terminal-ansi-theme";

describe("light terminal ANSI normalization", () => {
  it("removes reverse-video and fixed ANSI backgrounds", () => {
    const normalizer = createLightTerminalAnsiNormalizer();
    expect(normalizer.write("\x1b[7mcommand\x1b[27m \x1b[41merror\x1b[49m")).toBe("command error");
  });

  it("removes 256-color and true-color backgrounds but keeps foreground/emphasis", () => {
    const normalizer = createLightTerminalAnsiNormalizer();
    expect(normalizer.write("\x1b[1;37;48;5;22mA\x1b[38;2;10;20;30;48;2;1;2;3mB"))
      .toBe("\x1b[1;37mA\x1b[38;2;10;20;30mB");
  });

  it("preserves non-SGR terminal controls", () => {
    const normalizer = createLightTerminalAnsiNormalizer();
    expect(normalizer.write("\x1b[2J\x1b[3;4Htext")).toBe("\x1b[2J\x1b[3;4Htext");
  });

  it("handles an SGR sequence split across PTY chunks", () => {
    const normalizer = createLightTerminalAnsiNormalizer();
    expect(normalizer.write("\x1b[48;2;0")).toBe("");
    expect(normalizer.write(";0;0mcode")).toBe("code");
  });

  it("translates standalone dim (SGR 2) to a readable mid-gray truecolor fg", () => {
    const normalizer = createLightTerminalAnsiNormalizer();
    expect(normalizer.write("\x1b[2mfaint")).toBe("\x1b[38;2;103;96;86mfaint");
  });

  it("dims the ghost hint and restores default fg on SGR 22", () => {
    const normalizer = createLightTerminalAnsiNormalizer();
    expect(normalizer.write("\x1b[2mhint\x1b[22m")).toBe(
      "\x1b[38;2;103;96;86mhint\x1b[22;39m",
    );
  });

  it("keeps bold but translates the dim part of bold+dim", () => {
    const normalizer = createLightTerminalAnsiNormalizer();
    expect(normalizer.write("\x1b[1;2mbold-dim")).toBe(
      "\x1b[1;38;2;103;96;86mbold-dim",
    );
  });

  it("translates dim on colored faint text", () => {
    const normalizer = createLightTerminalAnsiNormalizer();
    expect(normalizer.write("\x1b[31;2mred dim")).toBe(
      "\x1b[31;38;2;103;96;86mred dim",
    );
  });

  it("keeps a plain truecolor foreground untouched", () => {
    const normalizer = createLightTerminalAnsiNormalizer();
    expect(normalizer.write("\x1b[38;2;1;2;3mX")).toBe("\x1b[38;2;1;2;3mX");
  });

  it("does not mistake 38/48/58 truecolor mode tokens for standalone dim", () => {
    const normalizer = createLightTerminalAnsiNormalizer();
    expect(normalizer.write("\x1b[38;2;10;20;30;2mX")).toBe(
      "\x1b[38;2;10;20;30;38;2;103;96;86mX",
    );
    expect(normalizer.write("\x1b[2;38;2;10;20;30mX")).toBe(
      "\x1b[38;2;103;96;86;38;2;10;20;30mX",
    );
    expect(normalizer.write("\x1b[58;2;255;0;0mX")).toBe("\x1b[58;2;255;0;0mX");
    expect(normalizer.write("\x1b[48;2;1;2;3m")).toBe("");
  });

  it("strips colon-form backgrounds and keeps colon-form foreground/underline", () => {
    const normalizer = createLightTerminalAnsiNormalizer();
    expect(normalizer.write("\x1b[38:2::255:0:0mF\x1b[48:2::10:20:30mG")).toBe("\x1b[38:2::255:0:0mFG");
  });

  it("translates a dim sequence split across PTY chunks", () => {
    const normalizer = createLightTerminalAnsiNormalizer();
    expect(normalizer.write("\x1b[2")).toBe("");
    expect(normalizer.write("mtext")).toBe("\x1b[38;2;103;96;86mtext");
  });

  it("always translates standalone SGR 22 to 22;39 even without prior dim", () => {
    const normalizer = createLightTerminalAnsiNormalizer();
    expect(normalizer.write("\x1b[22mx")).toBe("\x1b[22;39mx");
  });

  it("handles SGR 0 and empty resets naturally", () => {
    const normalizer = createLightTerminalAnsiNormalizer();
    expect(normalizer.write("\x1b[0mreset")).toBe("\x1b[0mreset");
    expect(normalizer.write("empty\x1b[m")).toBe("empty\x1b[0m");
  });
});
