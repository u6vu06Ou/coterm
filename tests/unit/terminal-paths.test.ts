import { describe, expect, it } from "vitest";
import { quoteTerminalPath } from "../../src/shared/terminal";

describe("terminal path quoting", () => {
  it("quotes PowerShell, cmd, and WSL attachment paths safely", () => {
    expect(quoteTerminalPath("C:\\Users\\Me\\screen shot.png", "powershell")).toBe(
      "'C:\\Users\\Me\\screen shot.png'",
    );
    expect(quoteTerminalPath("C:\\Users\\Me\\screen shot.png", "cmd")).toBe(
      '"C:\\Users\\Me\\screen shot.png"',
    );
    expect(quoteTerminalPath("C:\\Users\\Me\\screen shot.png", "wsl")).toBe(
      "'/mnt/c/Users/Me/screen shot.png'",
    );
  });
});
