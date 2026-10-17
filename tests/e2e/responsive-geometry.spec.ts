import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { join } from "node:path";
import { appSettingsSchema } from "../../src/shared/schema";
import { startWebServer, type RunningWebServer } from "../../src/main/web/web-server";
import { AppEventBus } from "../../src/main/core/event-bus";
import { MOBILE_LAYOUT_QUERY } from "../../src/renderer/src/components/terminal-responsive";
import type { TerminalTranscriptMessage } from "../../src/shared/types";

const projectId = "11111111-1111-4111-8111-111111111111";
const terminalIds = [
  "21111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "23333333-3333-4333-8333-333333333333",
  "24444444-4444-4444-8444-444444444444",
];

let server: RunningWebServer;
let baseUrl: string;
let transcriptMessages: TerminalTranscriptMessage[] = [];

test.beforeAll(async () => {
  const now = new Date().toISOString();
  const events = new AppEventBus();
  const terminals = terminalIds.map((id, index) => ({
    id,
    projectId,
    profile: "pwsh" as const,
    title: `PTY${index + 1}`,
    cwd: `D:/fixture/PTY${index + 1}`,
    cols: 120,
    rows: 28,
    status: "running" as const,
    startedAt: now,
    closedAt: null,
    lastExitCode: null,
    isAgent: index === 1,
    agentProfile: index === 1 ? "codex-official" as const : null,
    ownedByAgentApi: false,
    pid: 1000 + index,
    nativeSessionId: null,
    worktreeId: null,
    contextUsage: null,
    agentSummaryTitle: index === 1 ? "Investigate mobile PTY horizontal pan" : null,
  }));
  const dockLayout = {
    tiles: terminalIds.map((terminalId, index) => ({ terminalId, projectId, weight: 1, agentProfile: index === 1 ? "codex-official" as const : null })),
    selectedTerminalId: terminalIds[1]!,
    exclusiveTerminalId: null,
    rows: [0.5, 0.5],
    cols: [[0.5, 0.5], [0.5, 0.5]],
    ptyCols: 120,
    ptyRows: 28,
  };
  server = await startWebServer({
    port: 0,
    allowedOrigin: "self",
    rendererPath: join(process.cwd(), "out", "renderer"),
    verifyAccess: () => Promise.resolve({ email: "owner@example.com" }),
    events,
    operations: {
      bootstrap: () => ({
        projects: [{
          id: projectId,
          name: "Responsive fixture",
          workspacePath: process.cwd(),
          pinned: true,
          archived: false,
          createdAt: now,
          updatedAt: now,
        }],
        conversations: [],
        runningConversationIds: [],
        archivedProjects: [],
        archivedConversations: [],
        providers: [],
        appVersion: "1.0.0",
        userDataPath: "[redacted]",
        startupAlerts: "",
      }),
      // Parse through the shared schema so future settings sections (voice,
      // agentapi, browser flags, …) arrive with their defaults instead of
      // crashing the renderer the first time it reads them (#52 regression).
      getSettings: () => appSettingsSchema.parse({
        theme: "dark",
        codeTheme: "github-dark",
        terminalTheme: "github-dark",
        locale: "zh-TW",
        terminalFontSize: 14,
        defaultProvider: "codex-official",
        defaultShell: "pwsh",
        proxyUrl: "http://127.0.0.1:8787",
        permissionPreset: "ask",
        onboardingCompleted: true,
        defaultWorkspacePath: process.cwd(),
      }),
      getDockLayout: () => dockLayout,
      getTerminalWorkspace: () => ({
        terminals,
        split: "grid",
        activeId: terminalIds[1]!,
        secondaryId: terminalIds[0]!,
        scrollback: Object.fromEntries(terminals.map((terminal, index) => [
          terminal.id,
          `PTY${index + 1} ` + "0123456789".repeat(12) + "\r\nPS> ",
        ])),
        restored: true,
      }),
      getTerminalDashboard: () => terminals.map((terminal) => ({ ...terminal, ptyState: terminal.isAgent ? "running" : "idle" })),
      getTerminalTranscript: (terminalId: string) => ({
        terminalId,
        provider: "codex",
        status: transcriptMessages.length ? "ready" : "ambiguous",
        messages: transcriptMessages,
      }),
      getAgentApiSemanticState: (terminalId: string) => terminalId === terminalIds[1] ? {
        terminalId,
        identity: { harness: "codex-cli", backend: "openai", model: null, profile: "codex-official" },
        task: { summary: "Investigate mobile PTY horizontal pan", phase: "running", source: "screen-fallback", confidence: 0.45 },
        lastTurn: { status: null, summary: null, finalText: null, completedAt: null, source: null, confidence: 0 },
        pendingInteraction: null,
        updatedAt: now,
      } : null,
      getUsageSnapshot: () => ({
        claude5h: null,
        claude7d: null,
        codex7d: null,
        fetchedAt: Date.now(),
      }),
      listAttention: () => [],
      listEvents: () => [],
      listWorkspace: () => [],
      listAttachments: () => [],
      refreshProviders: () => [],
      selectTile: () => dockLayout,
      setDockLayout: () => dockLayout,
      refreshTerminal: () => undefined,
    } as never,
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

test.afterAll(async () => server.close());

test("reader announces new messages without moving the history being read", async ({ browser }) => {
  transcriptMessages = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    text: `History message ${i}: ` + "Readable history. ".repeat(35),
    timestamp: null,
    endsTurn: true,
  }));
  const { context, page } = await openTouchPage(browser);
  try {
    await page.goto(baseUrl);
    await page.locator(".boot-screen").waitFor({ state: "detached" });
    await page.locator('[data-action-id="topbar.mobile.keys.toggle"]').click();
    await page.locator('[data-action-id="topbar.mobile.reader.toggle"]').click();
    const scroller = page.locator(".terminal-reader-scroll");
    await expect(page.locator(".terminal-reader-message")).toHaveCount(40);
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
    await scroller.evaluate((element) => { element.scrollTop = 100; });
    const jump = page.locator('[data-action-id="terminal.reader.jump-bottom"]');
    await expect(jump).toHaveText("回到最新 ↓");
    transcriptMessages = [...transcriptMessages, { role: "assistant", text: "A new reply has arrived.", timestamp: null, endsTurn: true }];
    await expect(jump).toHaveText("新訊息 ↓");
    expect(await scroller.evaluate((element) => element.scrollTop)).toBe(100);
    await jump.click();
    await expect(jump).toBeHidden();
    await expect.poll(() => scroller.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2);
  } finally {
    transcriptMessages = [];
    await context.close();
  }
});

function collectRpcMethods(page: Page): string[] {
  const methods: string[] = [];
  page.on("request", (request) => {
    if (!request.url().endsWith("/api/rpc")) return;
    try {
      const payload = JSON.parse(request.postData() ?? "{}") as { method?: string };
      if (payload.method) methods.push(payload.method);
    } catch {
      // A malformed request is handled by the server; this oracle only records
      // valid RPC envelopes emitted by the renderer.
    }
  });
  return methods;
}

async function openTouchPage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    screen: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  return { context, page: await context.newPage() };
}

test("phone portrait-landscape-portrait keeps one selected remote terminal", async ({ browser }) => {
  const { context, page } = await openTouchPage(browser);
  const rpcMethods = collectRpcMethods(page);
  try {
    await page.goto(baseUrl);
    await page.locator(".boot-screen").waitFor({ state: "detached" });

    const assertMobileSelection = async (): Promise<void> => {
      expect(await page.evaluate((query) => matchMedia(query).matches, MOBILE_LAYOUT_QUERY)).toBe(true);
      await expect(page.locator("header.mobile-dock-bar")).toBeVisible();
      await expect(page.locator(".xterm-pane-frame")).toHaveCount(1);
      await expect(page.locator(".dock-row-group")).toHaveCount(0);
      await expect(page.locator(".xterm-id-label")).toContainText(`#${terminalIds[1]!.slice(-6)}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    };

    await assertMobileSelection();
    await page.setViewportSize({ width: 844, height: 390 });
    await page.evaluate(() => window.dispatchEvent(new Event("orientationchange")));
    await assertMobileSelection();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.dispatchEvent(new Event("orientationchange")));
    await assertMobileSelection();

    expect(rpcMethods).not.toContain("resizeTerminal");
  } finally {
    await context.close();
  }
});

test("phone horizontal swipe pans a wide remote PTY", async ({ browser }) => {
  const { context, page } = await openTouchPage(browser);
  try {
    await page.goto(baseUrl);
    await page.locator(".boot-screen").waitFor({ state: "detached" });
    const host = page.locator(".xterm-host-remote");
    await expect(host).toHaveCount(1);
    await page.locator(".xterm-screen").waitFor({ state: "visible" });
    await page.waitForTimeout(250);
    await expect.poll(() => host.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);

    const manualPan = await host.evaluate((element) => {
      const target = element as HTMLElement;
      target.scrollLeft = 80;
      const value = target.scrollLeft;
      target.scrollLeft = 0;
      return value;
    });
    expect(manualPan).toBeGreaterThan(0);

    const before = await host.evaluate((element) => element.scrollLeft);
    const observed = await host.evaluate((element) => {
      const target = element as HTMLElement;
      let observedMove = "none";
      target.addEventListener("touchmove", (event) => {
        observedMove = `${event.touches.length}:${event.touches[0]?.clientX ?? "missing"}`;
      }, { once: true });
      const touch = (x: number, y: number) => new Touch({
        identifier: 1,
        target,
        clientX: x,
        clientY: y,
        pageX: x,
        pageY: y,
        screenX: x,
        screenY: y,
        radiusX: 1,
        radiusY: 1,
        rotationAngle: 0,
        force: 1,
      });
      const start = touch(320, 300);
      target.dispatchEvent(new TouchEvent("touchstart", {
        bubbles: true,
        cancelable: true,
        touches: [start],
        targetTouches: [start],
        changedTouches: [start],
      }));
      const moved = touch(180, 302);
      target.dispatchEvent(new TouchEvent("touchmove", {
        bubbles: true,
        cancelable: true,
        touches: [moved],
        targetTouches: [moved],
        changedTouches: [moved],
      }));
      target.dispatchEvent(new TouchEvent("touchend", {
        bubbles: true,
        cancelable: true,
        touches: [],
        targetTouches: [],
        changedTouches: [moved],
      }));
      return observedMove;
    });
    expect(observed).toBe("1:180");
    await expect.poll(() => host.evaluate((element) => element.scrollLeft)).toBeGreaterThan(before);
  } finally {
    await context.close();
  }
});

test("phone shows the provider-authored Codex summary in PTY bar and pane header", async ({ browser }) => {
  const { context, page } = await openTouchPage(browser);
  try {
    await page.goto(baseUrl);
    await page.locator(".boot-screen").waitFor({ state: "detached" });
    await expect(page.locator(".mobile-session-summary")).toContainText("Investigate mobile PTY horizontal pan");
    await expect(page.locator(".xterm-agent-label")).toContainText("Investigate mobile PTY horizontal pan");
  } finally {
    await context.close();
  }
});

test("Codex reader pauses with a status message when transcript binding is ambiguous (no raw snapshot)", async ({ browser }) => {
  const { context, page } = await openTouchPage(browser);
  try {
    await page.goto(baseUrl);
    await page.locator(".boot-screen").waitFor({ state: "detached" });
    await page.evaluate((terminalId) => {
      window.dispatchEvent(new CustomEvent("coterm:reader-toggle", { detail: { terminalId } }));
    }, terminalIds[1]!);
    await expect(page.locator(".terminal-reader-overlay")).toBeVisible();
    await expect(page.locator(".terminal-reader-status")).toContainText("多個對話");
    // v1.5.65: the raw PTY snapshot fallback is gone — the reader never
    // renders the PTY-hard-wrapped raw text, it shows only the status block.
    await expect(page.locator(".terminal-reader-raw-pre")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("web multi-pane fits each remote PTY into its pane without horizontal pan", async ({ page }) => {
  const rpcMethods = collectRpcMethods(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseUrl);
  await page.locator(".boot-screen").waitFor({ state: "detached" });
  const hosts = page.locator(".xterm-host-remote");
  await expect(hosts).toHaveCount(4);
  await expect(page.locator(".dock-row-group")).toBeVisible();

  // 1.5.59: a desktop-layout remote shrinks its LOCAL font so the host grid
  // fits the pane (no clipped right edge) — nothing left to pan sideways.
  const overflows = (): Promise<boolean[]> => hosts.evaluateAll((elements) => elements.map((element) => {
    const host = element as HTMLElement;
    return host.scrollWidth > host.clientWidth + 1;
  }));
  await expect.poll(overflows).toEqual([false, false, false, false]);

  await page.setViewportSize({ width: 1600, height: 800 });
  await expect.poll(
    () => hosts.evaluateAll((elements) => elements.map((element) => (element as HTMLElement).scrollLeft)),
  ).toEqual([0, 0, 0, 0]);

  // A short fine-pointer desktop browser is not a landscape phone.
  await page.setViewportSize({ width: 1280, height: 480 });
  await expect(page.locator("header.mobile-dock-bar")).toBeHidden();
  await expect(hosts).toHaveCount(4);
  expect(await page.evaluate((query) => matchMedia(query).matches, MOBILE_LAYOUT_QUERY)).toBe(false);
  expect(rpcMethods).not.toContain("resizeTerminal");
});

test("web 2x2 panes keep every remote PTY bottom row visible and reachable", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(baseUrl);
  await page.locator(".boot-screen").waitFor({ state: "detached" });
  const hosts = page.locator(".xterm-host-remote");
  await expect(hosts).toHaveCount(4);
  await page.locator(".xterm-screen").first().waitFor({ state: "visible" });
  await page.waitForTimeout(500);

  const geometry = await hosts.evaluateAll((elements) => elements.map((element) => {
    const host = element as HTMLElement;
    host.scrollTop = host.scrollHeight;
    const xterm = host.querySelector<HTMLElement>(".xterm");
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    const hostRect = host.getBoundingClientRect();
    const xtermRect = xterm?.getBoundingClientRect() ?? hostRect;
    const screenRect = screen?.getBoundingClientRect() ?? hostRect;
    const workspaceRect = document.querySelector<HTMLElement>(".workspace-shell")?.getBoundingClientRect();
    return {
      hostBottom: hostRect.bottom,
      workspaceBottom: workspaceRect?.bottom ?? innerHeight,
      hostClientHeight: host.clientHeight,
      hostScrollHeight: host.scrollHeight,
      hostScrollTop: host.scrollTop,
      xtermHeight: xtermRect.height,
      screenHeight: screenRect.height,
      screenBottom: screenRect.bottom,
      hostBottomAfterScroll: hostRect.bottom,
      rootOverflow: xterm ? getComputedStyle(xterm).overflow : "missing",
    };
  }));

  for (const pane of geometry) {
    expect(pane.hostBottom).toBeLessThanOrEqual(pane.workspaceBottom + 1);
    expect(pane.hostScrollTop + pane.hostClientHeight).toBeGreaterThanOrEqual(pane.hostScrollHeight - 1);
    expect(pane.xtermHeight).toBeGreaterThanOrEqual(pane.screenHeight - 1);
    expect(pane.screenBottom).toBeLessThanOrEqual(pane.hostBottomAfterScroll + 1);
  }
});
