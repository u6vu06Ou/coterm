import { describe, expect, it } from "vitest";
import { shouldOpenDesktop } from "../../src/main/core/launch-mode";

describe("Coterm launch mode", () => {
  it("keeps login startup headless but opens normal launches", () => {
    expect(shouldOpenDesktop(["Coterm.exe", "--host"])).toBe(false);
    expect(shouldOpenDesktop(["Coterm.exe", "--summarize-all"])).toBe(false);
    expect(shouldOpenDesktop(["Coterm.exe"])).toBe(true);
  });
});
