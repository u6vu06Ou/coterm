// public #10 + legacy passthrough: "powershell" (5.1) still errors BEFORE spawn
// with profile + candidates when absent; "pwsh" intentionally has NO pre-spawn
// gate (v1.4 passthrough restored — Store app-exec-aliases spawn fine through
// conpty but are invisible to existsSync).
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppEventBus } from "../../src/main/core/event-bus";
import { PtyManager } from "../../src/main/terminal/pty-manager";

describe.skipIf(process.platform !== "win32")("pty-manager missing-shell failure", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("pwsh 7 absent -> no pre-spawn gate; spawn attempt reaches conpty with the bare name", () => {
    vi.stubEnv("ProgramFiles", "");
    vi.stubEnv("PATH", "");
    vi.stubEnv("SystemRoot", "");
    const manager = new PtyManager(new AppEventBus());
    try {
      expect(() =>
        manager.create({
          projectId: "69bf5cf4-f48a-46d8-8c65-a77f049e07e8",
          profile: "pwsh",
          cwd: process.cwd(),
          isAgent: false,
          agentProfile: null,
        }),
      ).toThrow(/Failed to spawn pwsh7 \(pwsh\.exe\) for profile "pwsh"/);
      expect(manager.dashboardSnapshot()).toHaveLength(0);
    } finally {
      manager.dispose();
    }
  });

  it("powershell (5.1) still resolves when pwsh 7 is absent", () => {
    vi.stubEnv("ProgramFiles", "");
    const manager = new PtyManager(new AppEventBus());
    try {
      const terminal = manager.create({
        projectId: "69bf5cf4-f48a-46d8-8c65-a77f049e07e8",
        profile: "powershell",
        cwd: process.cwd(),
        isAgent: false,
        agentProfile: null,
      });
      expect(terminal.profile).toBe("powershell");
      manager.kill(terminal.id);
    } finally {
      manager.dispose();
    }
  });
});
