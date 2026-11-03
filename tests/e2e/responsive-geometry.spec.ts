import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { join } from "node:path";
import { appSettingsSchema } from "../../src/shared/schema";
import { startWebServer, type RunningWebServer } from "../../src/main/web/web-server";
import { AppEventBus } from "../../src/main/core/event-bus";
import { MOBILE_LAYOUT_QUERY } from "../../src/renderer/src/components/terminal-responsive";
import type { TerminalTranscriptMessage } from "../../src/shared/types";

const projectId = "11111111-1111-4111-8111-111111111111";
const providerSummary = "評估清理 Mac 容量與安裝，保留重要檔案並整理完整報告";
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
    agentSummaryTitle: index === 1 ? providerSummary : null,
    agentHandle: index === 1 ? "codex-9" : null,
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
      requestTerminalGeometry: () => undefined,
      requestReadAloud: () => ({ ok: false, error: "empty" }),
    } as never,
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

test.afterAll(async () => server.close());

test("phone toolbar buttons align while menu items keep their original size", async ({ browser }) => {
  const { context, page } = await openTouchPage(browser);
  try {
    await page.goto(baseUrl);
    await page.locator(".boot-screen").waitFor({ state: "detached" });
    const toggle = page.locator('[data-action-id="topbar.mobile.keys.toggle"]');
    await expect(toggle).toHaveCSS("height", "56px");
    await expect(page.locator(".mobile-menu-pty-label")).toHaveCSS("font-size", "20px");
    await toggle.click();
    await expect(page.locator(".mobile-menu-panel .mobile-pty-num").first()).toHaveCSS("font-size", "12px");
    await expect(page.locator(".mobile-menu-panel .mobile-pty-slot").first()).toHaveCSS("height", "44px");
    await expect(page.locator(".mobile-menu-panel .mobile-key-label").first()).toHaveCSS("font-size", "12px");
  } finally {
    await context.close();
  }
});

test("phone header gives the summary a full row and keeps narration away from close", async ({ browser }) => {
  const { context, page } = await openTouchPage(browser);
  const methods = collectRpcMethods(page);
  try {
    await page.goto(baseUrl);
    await page.locator(".boot-screen").waitFor({ state: "detached" });
    const header = page.locator(".xterm-pane-frame > header");
    await expect(header.locator(".xterm-agent-label")).toContainText("評估清理 Mac");
    for (const width of [320, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      for (const theme of ["light", "dark"]) {
        await page.evaluate((theme) => {
          document.documentElement.dataset.skin = "sunmoon";
          document.documentElement.dataset.theme = theme;
        }, theme);
        const boxes = await page.evaluate(() => {
          const rect = (selector: string) => {
            const el = document.querySelector<HTMLElement>(selector)!;
            const r = el.getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height,
              font: Number.parseFloat(getComputedStyle(el).fontSize), client: el.clientWidth, scroll: el.scrollWidth };
          };
          return {
            summary: rect(".xterm-header-identity .xterm-agent-label"),
            model: rect(".xterm-model-label"),
            close: rect('[data-action-id="terminal.close"]'),
            sidebar: rect('[data-action-id="sidebar.expand"]'),
            settings: rect('[data-action-id="topbar.mobile.settings.open"]'),
            enter: rect('[data-action-id="topbar.mobile.enter"]'),
            toggle: rect(".mobile-menu-toggle"),
            header: rect(".xterm-pane-frame > header"),
            terminal: rect(".xterm-host"),
          };
        });
        expect(boxes.header.height).toBe(88);
        expect(boxes.summary.font).toBe(20);
        expect(boxes.summary.width).toBeGreaterThan(width - 40);
        expect(boxes.summary.top).toBeGreaterThanOrEqual(boxes.close.bottom);
        expect(boxes.summary.bottom).toBeLessThanOrEqual(boxes.header.bottom);
        expect(boxes.terminal.top).toBeGreaterThanOrEqual(boxes.header.bottom);
        expect(boxes.model.scroll).toBeLessThanOrEqual(boxes.model.client);
        expect(boxes.model.right).toBeLessThan(boxes.close.left);
        expect(boxes.close.width).toBeGreaterThanOrEqual(44);
        for (const box of [boxes.sidebar, boxes.settings, boxes.enter]) {
          expect(box.height).toBe(56);
          expect(box.width).toBe(56);
          expect(Math.abs(box.top - boxes.toggle.top)).toBeLessThanOrEqual(1);
        }
        await expect(header.locator('[data-action-id="terminal.read-aloud.toggle"]')).toHaveCount(0);
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    await page.screenshot({ path: "logs/mobile-header-1.5.78.png" });
    await page.locator('[data-action-id="topbar.mobile.keys.toggle"]').click();
    const narration = page.locator('[data-action-id="topbar.mobile.read-aloud.toggle"]');
    await expect(narration).toBeVisible();
    await expect(narration).toContainText("朗讀");
    await narration.click();
    await expect.poll(() => methods.includes("requestReadAloud")).toBe(true);
    await expect(page.locator(".read-aloud-toast")).toBeVisible();
    await expect(page.locator(".xterm-pane-frame")).toHaveCount(1);
    expect(methods).not.toContain("closeTile");
  } finally {
    await context.close();
  }
});

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

test("phone wake rebuilds a suspended renderer and fills the selected pane without a reload", async ({ browser }) => {
  const { context, page } = await openTouchPage(browser);
  const methods = collectRpcMethods(page);
  try {
    await page.goto(baseUrl);
    await page.locator(".boot-screen").waitFor({ state: "detached" });
    await expect(page.locator(".xterm-screen")).toHaveCount(1);
    await page.waitForTimeout(500);
    methods.length = 0;
    await page.evaluate(() => {
      Object.defineProperties(document, {
        hidden: { configurable: true, value: true },
        visibilityState: { configurable: true, value: "hidden" },
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(150);
    expect(methods).not.toContain("getTerminalWorkspace");
    await page.evaluate(() => {
      Object.defineProperties(document, {
        hidden: { configurable: true, value: false },
        visibilityState: { configurable: true, value: "visible" },
      });
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    await expect.poll(() => methods.filter((method) => method === "getTerminalWorkspace").length).toBeGreaterThan(0);
    await expect(page.locator(".xterm-pane-frame")).toHaveCount(1);
    await expect.poll(() => page.locator(".xterm-host-remote").evaluate((host) => {
      const screen = host.querySelector<HTMLElement>(".xterm-screen");
      // A taller grid is intentionally pannable; only a shorter grid leaves
      // the empty lower strip this regression guards against.
      return screen ? Math.max(0, host.clientHeight - screen.getBoundingClientRect().height) : 9999;
    })).toBeLessThan(60);
    expect(methods).not.toContain("resizeTerminal");
  } finally {
    await context.close();
  }
});

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
      await expect(page.locator(".xterm-pane-frame")).toHaveAttribute("data-terminal-id", terminalIds[1]!);
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
    await expect(page.locator(".mobile-session-summary")).toContainText(providerSummary);
    await expect(page.locator(".xterm-agent-label")).toContainText(providerSummary);
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

async function readerPinchEvent(page: Page, type: "touchstart" | "touchmove" | "touchend", distance: number): Promise<void> {
  await page.evaluate(({ type, distance }) => {
    const target = document.querySelector<HTMLElement>(".terminal-reader-scroll")!;
    const rect = target.getBoundingClientRect();
    const touches = type === "touchend" ? [] : [0, 1].map((id) => new Touch({
      identifier: id, target, clientX: rect.left + rect.width / 2 + (id ? 1 : -1) * distance / 2,
      clientY: rect.top + rect.height / 2,
    }));
    target.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches, targetTouches: touches }));
  }, { type, distance });
}

async function readerFont(page: Page): Promise<number> {
  return page.locator(".terminal-reader-overlay").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
}

test("phone reader pinches a scaled conversation and keeps the visible message", async ({ browser }) => {
  transcriptMessages = Array.from({ length: 120 }, (_, index) => ({
    role: index % 2 ? "assistant" as const : "user" as const,
    text: `Message ${index}: ` + Array.from({ length: index === 61 ? 180 : 12 }, (_, line) =>
      `Paragraph ${line}: Readable Chinese 中文 and mixed text for stable zoom.`).join("\n\n"),
    timestamp: null, endsTurn: true,
  }));
  const { context, page } = await openTouchPage(browser);
  try {
    await page.goto(baseUrl);
    await page.locator(".boot-screen").waitFor({ state: "detached" });
    await page.evaluate((terminalId) => window.dispatchEvent(new CustomEvent("coterm:reader-toggle", { detail: { terminalId } })), terminalIds[1]!);
    await expect(page.locator(".terminal-reader-message")).toHaveCount(120);
    expect(await readerFont(page)).toBe(20);
    const scroller = page.locator(".terminal-reader-scroll");
    // Start halfway through ONE very long answer, with many older/newer turns.
    await scroller.evaluate((el) => {
      const message = el.querySelector<HTMLElement>('[data-message-index="61"]')!;
      el.scrollTop += message.getBoundingClientRect().top - el.getBoundingClientRect().top + message.clientHeight * 0.5;
      el.dispatchEvent(new Event("scroll", { bubbles: false }));
    });
    await expect(page.locator('[data-action-id="terminal.reader.jump-bottom"]')).toBeVisible();
    // Track an actual character, rather than accepting any location inside the answer.
    const anchor = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>(".terminal-reader-scroll")!;
      const box = el.getBoundingClientRect();
      const range = (document as Document & { caretRangeFromPoint(x: number, y: number): Range | null })
        .caretRangeFromPoint(box.left + box.width / 2, box.top + box.height / 2)!;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let index = 0;
      while (walker.nextNode() !== range.startContainer) index++;
      const marker = document.createRange();
      marker.setStart(range.startContainer, range.startOffset);
      marker.setEnd(range.startContainer, range.startOffset + 1);
      return { index, offset: range.startOffset, y: marker.getBoundingClientRect().top - box.top };
    });
    const assertAnchor = async () => {
      const y = await scroller.evaluate((el, anchor) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let node: Node | null = null;
        for (let i = 0; i <= anchor.index; i++) node = walker.nextNode();
        const range = document.createRange();
        range.setStart(node!, anchor.offset);
        range.setEnd(node!, anchor.offset + 1);
        return range.getBoundingClientRect().top - el.getBoundingClientRect().top;
      }, anchor);
      expect(Math.abs(y - anchor.y)).toBeLessThan(3);
    };
    await readerPinchEvent(page, "touchstart", 100);
    // Each move is a separate browser turn and must produce a real layout change.
    for (const distance of [115, 135, 150, 120]) {
      await readerPinchEvent(page, "touchmove", distance);
      await expect.poll(() => readerFont(page)).toBe(Math.round(20 * distance / 100));
      await assertAnchor();
    }
    await readerPinchEvent(page, "touchend", 0);
    await expect.poll(() => page.evaluate(() => localStorage.getItem("coterm-reader-font-size"))).toBe("24");
    await page.reload();
    await page.locator(".boot-screen").waitFor({ state: "detached" });
    await page.evaluate((terminalId) => window.dispatchEvent(new CustomEvent("coterm:reader-toggle", { detail: { terminalId } })), terminalIds[1]!);
    await expect(page.locator(".terminal-reader-message")).toHaveCount(120);
    expect(await readerFont(page)).toBe(24);
    await expect.poll(() => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2);
    await readerPinchEvent(page, "touchstart", 100);
    await readerPinchEvent(page, "touchmove", 125);
    await expect.poll(() => readerFont(page)).toBe(30);
    await expect.poll(() => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2);
    await readerPinchEvent(page, "touchend", 0);
  } finally {
    transcriptMessages = [];
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
