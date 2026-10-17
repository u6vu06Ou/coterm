import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserRuntimeManager } from "../../src/main/browser/browser-runtime-manager";
import { computeAgentBrowserWindowPlacement } from "../../src/main/browser/window-placement";

// Capture slot for the playwright launch surface — the shared mock in
// browser-runtime.test.ts ignores launch options, so this file keeps its own.
const captured = vi.hoisted(() => ({
  launch: undefined as { headless?: boolean; args?: string[] } | undefined,
  newContextOptions: undefined as Record<string, unknown> | undefined,
}));

// Fake Chromium: records the launch options and every newContext options object.
vi.mock("playwright", () => {
  const page = {
    on: () => undefined,
    url: () => "about:blank",
    title: () => Promise.resolve(""),
    close: () => Promise.resolve(),
    screenshot: () => Promise.resolve(Buffer.from("fake-png-bytes")),
    viewportSize: () => ({ width: 1920, height: 1042 }),
    goto: () => Promise.resolve(),
    evaluate: () => Promise.resolve(null),
  };
  const context = { route: () => Promise.resolve(), on: () => undefined, newPage: () => Promise.resolve(page), close: () => Promise.resolve() };
  const browser = { newContext: (options?: Record<string, unknown>) => { captured.newContextOptions = options; return Promise.resolve(context); }, close: () => Promise.resolve() };
  return {
    chromium: {
      launch: (options?: { headless?: boolean; args?: string[] }) => { captured.launch = options; return Promise.resolve(browser); },
      launchPersistentContext: () => Promise.resolve(context),
    },
  };
});

let root: string;

beforeEach(async () => {
  captured.launch = undefined;
  captured.newContextOptions = undefined;
  root = await mkdtemp(join(process.env.TEMP ?? process.cwd(), "coterm-popout-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("agent browser popout (user request 2026-10-09)", () => {
  it("upgrades a no-explicit-mode session to headed with the placement args", async () => {
    const manager = new BrowserRuntimeManager({
      userDataPath: root,
      popoutWindowProvider: () => true,
      windowPlacementProvider: () => computeAgentBrowserWindowPlacement(
        [
          { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1042 } },
          { id: 2, workArea: { x: 1920, y: 0, width: 1920, height: 1042 } },
        ],
        { x: 0, y: 0, width: 1600, height: 940 },
      ),
    });
    const session = await manager.createSession({}); // the agent did not name a mode

    // The upgrade is visible in the reported session info.
    expect(session.mode).toBe("headed");
    // The browser process really launched headed.
    expect(captured.launch?.headless).toBe(false);
    // AutomationControlled stays first; the placement rect rides as launch args.
    expect(captured.launch?.args?.[0]).toBe("--disable-blink-features=AutomationControlled");
    expect(captured.launch?.args).toContain("--window-position=1920,0");
    expect(captured.launch?.args).toContain("--window-size=1920,1042");
    // Popout pages follow the OS window instead of Playwright's default viewport.
    expect(captured.newContextOptions?.viewport).toBe(null);
    await manager.dispose();
  });

  it("popout also upgrades sessions that name mode headless (the MCP path always sends one)", async () => {
    const manager = new BrowserRuntimeManager({
      userDataPath: root,
      popoutWindowProvider: () => true,
      windowPlacementProvider: () => ({ x: 1920, y: 0, width: 1920, height: 1042 }),
    });
    const session = await manager.createSession({ mode: "headless" });

    expect(session.mode).toBe("headed");
    expect(captured.launch?.headless).toBe(false);
    expect(captured.launch?.args).toContain("--window-position=1920,0");
    await manager.dispose();
  });

  it("with the popout setting off (or the provider absent), the no-explicit-mode default stays headless", async () => {
    const off = new BrowserRuntimeManager({ userDataPath: root, popoutWindowProvider: () => false });
    const offSession = await off.createSession({});
    expect(offSession.mode).toBe("headless");
    expect(captured.launch?.headless).toBe(true);
    await off.dispose();

    // Absent provider = the status quo: headless, no placement args.
    const without = new BrowserRuntimeManager({ userDataPath: root });
    const withoutSession = await without.createSession({});
    expect(withoutSession.mode).toBe("headless");
    expect(captured.launch?.args?.[0]).toBe("--disable-blink-features=AutomationControlled");
    expect(captured.launch?.args).not.toContain(expect.stringMatching(/^--window-position=/));
    await without.dispose();
  });

  it("full access marks the brand-new session granted via the #93 grantSession (not a parallel bypass)", async () => {
    const grants: string[] = [];
    const manager = new BrowserRuntimeManager({
      userDataPath: root,
      newSessionAutoGrantProvider: () => true,
      grantSession: (sessionId) => { grants.push(sessionId); },
      // Simulates the real BrowserApprovalService pairing so the reported info
      // reflects the grant the service would actually see.
      isSessionApprovalGranted: (sessionId) => grants.includes(sessionId),
    });
    const session = await manager.createSession({ mode: "headless" });

    // Exactly one grant, for exactly this session, after the session exists.
    expect(grants).toEqual([session.id]);
    // The reported info shows the human will not be asked for this session.
    expect(session.approvalGranted).toBe(true);
    await manager.dispose();
  });

  it("without full access no grant happens, and approvalGranted reports the real pairing", async () => {
    const grantsOff: string[] = [];
    const off = new BrowserRuntimeManager({
      userDataPath: root,
      newSessionAutoGrantProvider: () => false,
      grantSession: (sessionId) => { grantsOff.push(sessionId); },
      isSessionApprovalGranted: (sessionId) => grantsOff.includes(sessionId),
    });
    const offSession = await off.createSession({ mode: "headless" });
    expect(grantsOff).toEqual([]);
    expect(offSession.approvalGranted).toBe(false);
    await off.dispose();

    // Absent provider and no approval wire: no grant, state false.
    const without = new BrowserRuntimeManager({ userDataPath: root });
    const withoutSession = await without.createSession({ mode: "headless" });
    expect(withoutSession.approvalGranted).toBe(false);
    await without.dispose();
  });
});
