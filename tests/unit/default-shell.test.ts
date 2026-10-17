import { afterEach, describe, expect, it, vi } from "vitest";
import { appSettingsSchema } from "@shared/schema";
import { defaultShellForPlatform } from "../../src/main/storage/repository";

describe("defaultShellForPlatform", () => {
  const originalShell = process.env.SHELL;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = originalShell;
  });

  it("resolves to pwsh on win32", () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    expect(defaultShellForPlatform()).toBe("pwsh");
  });

  it("resolves to zsh on darwin", () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    expect(defaultShellForPlatform()).toBe("zsh");
  });

  it("resolves to $SHELL on linux when set", () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    process.env.SHELL = "/usr/bin/fish";
    expect(defaultShellForPlatform()).toBe("/usr/bin/fish");
  });

  it("resolves to bash on linux when $SHELL is unset", () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    delete process.env.SHELL;
    expect(defaultShellForPlatform()).toBe("bash");
  });

  it("falls back to pwsh on unknown platforms", () => {
    vi.stubGlobal("process", { ...process, platform: "freebsd" });
    expect(defaultShellForPlatform()).toBe("pwsh");
  });

  it("returns a value accepted by the AppSettings.defaultShell enum for known shells", () => {
    // win32 → "pwsh", darwin → "zsh", linux (no SHELL) → "bash" — all in enum.
    vi.stubGlobal("process", { ...process, platform: "win32" });
    expect(appSettingsSchema.shape.defaultShell.parse(defaultShellForPlatform())).toBe("pwsh");

    vi.stubGlobal("process", { ...process, platform: "darwin" });
    expect(appSettingsSchema.shape.defaultShell.parse(defaultShellForPlatform())).toBe("zsh");

    vi.stubGlobal("process", { ...process, platform: "linux" });
    delete process.env.SHELL;
    expect(appSettingsSchema.shape.defaultShell.parse(defaultShellForPlatform())).toBe("bash");
  });
});
