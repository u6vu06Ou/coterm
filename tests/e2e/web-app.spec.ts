import { test, expect } from "@playwright/test";
import { join } from "node:path";
import { startWebServer, type RunningWebServer } from "../../src/main/web/web-server";
import { AppEventBus } from "../../src/main/core/event-bus";

let server: RunningWebServer;
let baseUrl: string;
let eventsBus: AppEventBus;
const conversationId = "22222222-2222-4222-8222-222222222222";
let summaryCalls = 0;
let failNextSummary = false;
let selectedModel = "default";
let lastMessage: Record<string, unknown> | null = null;
let sendMessageCalls = 0;
let sendDelayMs = 0;
let runningConversationIds: string[] = [];
let lastUserInput: Record<string, unknown> | null = null;

test.beforeAll(async () => {
  const now = new Date().toISOString();
  const projectId = "11111111-1111-4111-8111-111111111111";
  eventsBus = new AppEventBus();
  const options = {
    port: 0,
    allowedOrigin: "self",
    rendererPath: join(process.cwd(), "out", "renderer"),
    verifyAccess: () => Promise.resolve({ email: "owner@example.com" }),
    events: eventsBus,
    operations: {
      bootstrap: () => ({
        projects: [{ id: projectId, name: "Coterm", workspacePath: process.cwd(), pinned: true, archived: false, createdAt: now, updatedAt: now }],
        conversations: [{ id: conversationId, projectId, name: "Remote", activeProvider: "claude-official", claudeModel: selectedModel, archived: false, summary: null, createdAt: now, updatedAt: now }],
        runningConversationIds,
        archivedProjects: [], archivedConversations: [], providers: [], appVersion: "1.0.0", userDataPath: "[redacted]",
      }),
      getSettings: () => ({
        theme: "aurora-glass", visualEffects: "off", codeTheme: "vitesse-dark", fontSize: 14,
        defaultProvider: "codex-official", defaultShell: "powershell",
        proxyUrl: "", permissionPreset: "ask",
        onboardingCompleted: true, defaultWorkspacePath: process.cwd(), telemetry: false,
        agentapi: { voiceAgent: true },
      }),
      listEvents: () => [], refreshProviders: () => [],
      sendMessage: async (value: unknown) => {
        sendMessageCalls += 1;
        lastMessage = value as Record<string, unknown>;
        if (sendDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, sendDelayMs));
        return { turnId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
      },
      cancelMessage: () => undefined,
      resolveUserInput: (value: unknown) => { lastUserInput = value as Record<string, unknown>; },
      listWorkspace: () => [],
      getTerminalWorkspace: () => ({ terminals: [], split: "single", activeId: null, secondaryId: null, scrollback: {}, restored: false }),
      listAttachments: () => [],
      summarizeConversation: async () => {
        summaryCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 120));
        if (failNextSummary) {
          failNextSummary = false;
          throw new Error("摘要服務暫時無法使用");
        }
        return {
          id: conversationId, projectId, name: `摘要名稱 ${summaryCalls}`,
          activeProvider: "claude-official" as const, claudeModel: selectedModel as "default" | "opus" | "sonnet" | "haiku", archived: false,
          summary: {
            brief: "這是簡略摘要", longTermGoal: "完成手機版 Coterm",
            recentSummary: "已完成摘要抽屜", updatedAt: "2026-06-21T04:05:06.000Z", partial: true,
          },
          createdAt: now, updatedAt: "2026-06-21T04:05:06.000Z",
        };
      },
      setConversationClaudeModel: (value: unknown) => {
        const input = value as { model: string };
        selectedModel = input.model;
        return {
          id: conversationId, projectId, name: "Remote", activeProvider: "claude-official" as const,
          claudeModel: selectedModel as "default" | "opus" | "sonnet" | "haiku",
          archived: false, summary: null, createdAt: now, updatedAt: new Date().toISOString(),
        };
      },
      listClaudeHistory: () => [{
        key: "a".repeat(64), projectId, title: "Projected Claude work", updatedAt: now,
      }],
      readClaudeHistory: () => ({
        session: { key: "a".repeat(64), projectId, title: "Projected Claude work", updatedAt: now },
        messages: [{ role: "user" as const, text: "Historical request" }, { role: "assistant" as const, text: "Historical answer" }],
        truncated: false,
      }),
      adoptClaudeHistory: () => ({
        id: "77777777-7777-4777-8777-777777777777", projectId, name: "Projected Claude work",
        activeProvider: "claude-official" as const, claudeModel: "default" as const,
        archived: false, summary: null, createdAt: now, updatedAt: now,
      }),
    },
  };
  server = await startWebServer(options);
  baseUrl = `http://127.0.0.1:${server.port}`;
});

test.afterAll(async () => server.close());

test.beforeEach(() => {
  sendMessageCalls = 0;
  sendDelayMs = 0;
  lastMessage = null;
});

test("fits the full workspace into a 360px mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(baseUrl);
  await expect(page.locator(".app-shell")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator(".sidebar")).toHaveClass(/collapsed/);
  const mobileBar = page.locator("header.mobile-dock-bar");
  await expect(mobileBar).toBeVisible();
  await expect(page.locator('[data-action-id="topbar.mobile.keys.toggle"]')).toBeVisible();
  await expect(page.locator('[data-action-id="topbar.mobile.enter"]')).toBeVisible();
  expect(await mobileBar.evaluate((element) => getComputedStyle(element).flexWrap)).toBe("nowrap");
  expect((await mobileBar.boundingBox())?.height ?? 999).toBeLessThanOrEqual(52);
  await page.locator(".sidebar-toggle").click();
  await expect(page.locator(".sidebar")).not.toHaveClass(/collapsed/);
  // Terminal-first no longer renders the legacy conversation composer.
  await expect(page.locator(".terminal-dock")).toBeVisible();
});

test("uses the terminal-first desktop web shell without legacy conversation UI or desktop Quit", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseUrl);
  await expect(page.locator(".app-shell.terminal-first")).toBeVisible();
  await expect(page.locator(".topbar-desktop")).toBeVisible();
  await expect(page.locator(".terminal-dock")).toBeVisible();
  await expect(page.locator(".conversation-column")).toHaveCount(0);
  await expect(page.locator(".composer textarea")).toHaveCount(0);
  await expect(page.locator(".workspace-pane")).toHaveCount(0);
  await expect(page.locator('[data-action-id="topbar.app.quit"]')).toHaveCount(0);
});

test.skip("legacy conversation-first: keeps the mobile conversation and composer usable when the viewport shrinks", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseUrl);
  await expect.poll(() => eventsBus.listenerCount("event")).toBeGreaterThan(0);
  eventsBus.emit("event", {
    id: "55555555-5555-4555-8555-555555555555",
    conversationId,
    turnId: "66666666-6666-4666-8666-666666666666",
    providerSessionId: null,
    turnGroupId: null,
    type: "assistant.final",
    createdAt: new Date().toISOString(),
    sequence: 1,
    summary: "Existing mobile conversation",
    payload: { text: "Existing mobile conversation", provider: "codex-official" },
  });
  await expect(page.getByText("Existing mobile conversation", { exact: true })).toBeVisible();

  const textarea = page.locator(".composer textarea");
  await textarea.focus();
  await page.setViewportSize({ width: 390, height: 500 });

  const layout = await page.evaluate(() => {
    const timeline = document.querySelector(".chat-timeline")?.getBoundingClientRect();
    const composer = document.querySelector(".composer-wrap")?.getBoundingClientRect();
    return {
      timelineHeight: timeline?.height ?? 0,
      composerBottom: composer?.bottom ?? Number.POSITIVE_INFINITY,
      viewportHeight: window.innerHeight,
    };
  });

  expect(layout.timelineHeight).toBeGreaterThan(40);
  expect(layout.composerBottom).toBeLessThanOrEqual(layout.viewportHeight);
  await textarea.fill("mobile input");
  await expect(textarea).toHaveValue("mobile input");
});

test.skip("legacy conversation-first: keeps mobile navigation readable and opens Explorer and Artifacts", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(baseUrl);

  await page.locator(".sidebar-toggle").click();
  const type = await page.evaluate(() => ({
    project: Number.parseFloat(getComputedStyle(document.querySelector(".project-copy strong")!).fontSize),
    path: Number.parseFloat(getComputedStyle(document.querySelector(".project-copy small")!).fontSize),
    conversation: Number.parseFloat(getComputedStyle(document.querySelector(".conversation-item > button")!).fontSize),
    actions: getComputedStyle(document.querySelector(".project-actions")!).opacity,
  }));
  expect(type.project).toBeGreaterThanOrEqual(14);
  expect(type.path).toBeGreaterThanOrEqual(12);
  expect(type.conversation).toBeGreaterThanOrEqual(14);
  expect(type.actions).toBe("1");
  expect(await page.locator(".composer textarea").evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
  await page.locator(".sidebar-brand .sidebar-toggle").click();

  const explorer = page.getByRole("button", { name: "Explorer" });
  const artifacts = page.getByRole("button", { name: "Artifacts" });
  const controls = await page.evaluate(() => Array.from(document.querySelectorAll(".topbar-actions .toolbar-button:not([style*='display: none'])"))
    .filter((element) => getComputedStyle(element).display !== "none")
    .map((element) => element.getBoundingClientRect())
    .map(({ left, right }) => ({ left, right })));
  expect(controls[0]!.right).toBeLessThanOrEqual(controls[1]!.left);
  expect(await page.locator(".topbar").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  await explorer.click();
  await expect(page.locator(".explorer-panel:not(.collapsed)")).toBeVisible();
  await page.locator(".explorer-panel > header button").click();
  await artifacts.click();
  await expect(page.locator(".artifact-rail")).toBeVisible();
});

test.skip("legacy conversation-first: generates, reopens, and regenerates a conversation summary on mobile", async ({ page }) => {
  summaryCalls = 0;
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(baseUrl);
  await page.locator(".sidebar-toggle").click();

  const summaryButton = page.getByRole("button", { name: "產生 Remote 的對話摘要" });
  const size = await summaryButton.evaluate((element) => element.getBoundingClientRect());
  expect(size.width).toBeGreaterThanOrEqual(44);
  expect(size.height).toBeGreaterThanOrEqual(44);
  await summaryButton.click();
  await expect(page.getByRole("dialog", { name: "對話摘要" })).toBeVisible();
  const closeSize = await page.getByRole("button", { name: "關閉對話摘要" })
    .evaluate((element) => element.getBoundingClientRect());
  expect(closeSize.width).toBeGreaterThanOrEqual(44);
  expect(closeSize.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByText("正在產生摘要…")).toBeVisible();
  await expect(page.getByText("這是簡略摘要")).toBeVisible();
  await expect(page.getByText("部分內容未納入摘要")).toBeVisible();
  await expect(page.getByText("上次摘要時間")).toBeVisible();
  await expect(page.getByText(/2026/)).toBeVisible();
  expect(await page.locator(".summary-drawer").evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);

  await page.getByRole("button", { name: "關閉對話摘要" }).click();
  await expect(page.getByRole("dialog", { name: "對話摘要" })).toBeHidden();
  await page.getByRole("button", { name: "開啟 摘要名稱 1 的對話摘要" }).click();
  await expect(page.getByText("這是簡略摘要")).toBeVisible();

  const regenerate = page.getByRole("button", { name: "重新摘要" });
  await regenerate.click();
  await expect(page.getByRole("button", { name: "摘要產生中…" })).toBeDisabled();
  await expect(page.getByRole("dialog", { name: "對話摘要" }).locator("header strong"))
    .toHaveText("摘要名稱 2");
  expect(summaryCalls).toBe(2);
});

test.skip("legacy conversation-first: keeps the active conversation and keyboard focus while using summaries on desktop", async ({ page }) => {
  summaryCalls = 0;
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseUrl);

  const activeConversation = page.locator(".conversation-item > button.selected");
  const summaryButton = page.locator(".conversation-item:has(> button.selected) .conversation-summary-button");
  await expect(summaryButton).toHaveAccessibleName("產生 Remote 的對話摘要");
  await expect(activeConversation).toHaveText(/Remote/);
  await activeConversation.focus();
  await page.keyboard.press("Tab");
  await expect(summaryButton).toBeFocused();
  await expect(summaryButton).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(activeConversation).toHaveText(/摘要名稱 1/);
  await expect(page.getByRole("button", { name: "關閉對話摘要" })).toBeFocused();

  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "重新摘要" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "對話摘要" })).toBeHidden();
  await expect(summaryButton).toBeFocused();
});

test.skip("legacy conversation-first: shows summary failures inside the open drawer", async ({ page }) => {
  failNextSummary = true;
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseUrl);
  await page.locator(".conversation-item > button.selected").hover();
  await page.getByRole("button", { name: "產生 Remote 的對話摘要" }).click();

  await expect(page.getByRole("dialog", { name: "對話摘要" }).getByRole("alert"))
    .toHaveText("Coterm request failed.");
});

test.skip("legacy conversation-first: uses a static rainbow frame that rotates only while running", async ({ page }) => {
  await page.goto(baseUrl);
  const pane = page.locator(".workspace-pane.active");
  expect(await pane.evaluate((element) => getComputedStyle(element, "::after").backgroundImage)).toContain("conic-gradient");
  await pane.evaluate((element) => element.classList.add("running"));
  expect(await pane.evaluate((element) => getComputedStyle(element, "::after").animationName)).toContain("pane-border-spin");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await pane.evaluate((element) => getComputedStyle(element, "::after").animationName)).toBe("none");
});

test.skip("legacy conversation-first: blocks duplicate composer submits while IPC is pending", async ({ page }) => {
  sendDelayMs = 150;
  await page.goto(baseUrl);
  const composer = page.locator(".composer textarea");
  await composer.fill("double submit guard");
  const send = page.locator(".send-button").filter({ has: page.locator("svg") });
  await Promise.all([
    send.click(),
    send.click({ force: true }),
  ]);
  await expect(composer).toHaveValue("");
  expect(sendMessageCalls).toBe(1);
  expect(lastMessage?.text).toBe("double submit guard");
});

test.skip("legacy conversation-first: writes speech recognition text into the composer", async ({ page }) => {
  await page.addInitScript(() => {
    class MockSpeechRecognition {
      lang = "";
      interimResults = false;
      maxAlternatives = 1;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onresult: ((event: { results: Array<Array<{ transcript: string }>> }) => void) | null = null;
      start(): void {
        this.onstart?.();
        this.onresult?.({ results: [[{ transcript: "voice command" }]] });
        this.onend?.();
      }
    }
    Object.defineProperty(window, "SpeechRecognition", { value: MockSpeechRecognition, configurable: true });
    Object.defineProperty(window, "webkitSpeechRecognition", { value: MockSpeechRecognition, configurable: true });
  });
  await page.goto(baseUrl);
  const composer = page.locator(".composer textarea");
  await composer.fill("run");
  await page.locator(".composer-tools button[title='語音輸入到對話']").click();
  await expect(composer).toHaveValue("run voice command");
});

test.skip("legacy conversation-first: restores the rotating pane frame from bootstrap running state", async ({ page }) => {
  runningConversationIds = [conversationId];
  try {
    await page.goto(baseUrl);
    await expect(page.locator(".workspace-pane.running")).toBeVisible();
    expect(await page.locator(".workspace-pane.running").evaluate(
      (element) => getComputedStyle(element, "::after").animationName,
    )).toContain("pane-border-spin");
  } finally {
    runningConversationIds = [];
  }
});

test.skip("legacy conversation-first: selects an official Claude model without overflowing mobile controls", async ({ page }) => {
  selectedModel = "default";
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(baseUrl);
  await page.getByRole("combobox", { name: "Claude 模型" }).selectOption("opus");
  await expect(page.getByRole("combobox", { name: "Claude 模型" })).toHaveValue("opus");
  expect(selectedModel).toBe("opus");
  expect(await page.locator(".topbar").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test.skip("legacy conversation-first: opens projected Claude history and adopts it without exposing a session ID", async ({ page }) => {
  await page.goto(baseUrl);
  await page.getByRole("button", { name: "Claude 歷史" }).click();
  await page.getByRole("button", { name: /Projected Claude work/ }).click();
  await expect(page.getByText("Historical request")).toBeVisible();
  await expect(page.getByText("Historical answer")).toBeVisible();
  await page.getByRole("button", { name: "接續到 Coterm" }).click();
  await expect(page.locator(".conversation-item > button.selected")).toContainText("Projected Claude work");
  await expect(page.getByText(/77777777/)).toHaveCount(0);
});

test.skip("legacy conversation-first: marks the running session and its project across live devices", async ({ page }) => {
  await page.goto(baseUrl);
  await expect.poll(() => eventsBus.listenerCount("event")).toBeGreaterThan(0);
  const turnId = "88888888-8888-4888-8888-888888888888";
  eventsBus.emit("event", {
    id: "99999999-9999-4999-8999-999999999999", conversationId, turnId,
    providerSessionId: null, turnGroupId: null, type: "user.message",
    createdAt: new Date().toISOString(), sequence: 5, summary: "running", payload: { text: "run" },
  });
  await expect(page.locator(".project-group.running")).toBeVisible();
  await expect(page.getByRole("button", { name: "停止 Agent" })).toContainText("停止");
  await expect(page.getByText("Session 執行中")).toBeVisible();
  eventsBus.emit("event", {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", conversationId, turnId,
    providerSessionId: null, turnGroupId: null, type: "assistant.final",
    createdAt: new Date().toISOString(), sequence: 6, summary: "done", payload: { text: "done", provider: "claude-official" },
  });
  await expect(page.locator(".project-group.running")).toHaveCount(0);
});

test.skip("legacy conversation-first: requires confirmation and sends native Workflow approval for one Claude turn", async ({ page }) => {
  lastMessage = null;
  await page.goto(baseUrl);
  const composer = page.locator(".composer textarea");
  await composer.fill("/goal 研究這個專案");

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("原生 Claude Workflow");
    await dialog.dismiss();
  });
  await composer.press("Enter");
  await expect(composer).toHaveValue("/goal 研究這個專案");
  expect(lastMessage).toBeNull();

  page.once("dialog", async (dialog) => {
    await dialog.accept();
  });
  await composer.press("Enter");
  await expect.poll(() => lastMessage).not.toBeNull();
  expect(lastMessage).toMatchObject({
    text: "/goal 研究這個專案",
    nativeWorkflow: true,
  });
});

test.skip("legacy conversation-first: retains the desktop browser workspace", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseUrl);
  await expect(page.locator(".topbar")).toBeVisible();
  await expect(page.locator(".conversation-column")).toBeVisible();
});

test.skip("legacy conversation-first: shows a provider question menu and returns the selected answer", async ({ page }) => {
  lastUserInput = null;
  await page.goto(baseUrl);
  await expect.poll(() => eventsBus.listenerCount("event")).toBeGreaterThan(0);
  const turnId = "12121212-1212-4212-8212-121212121212";
  eventsBus.emit("event", {
    id: "13131313-1313-4313-8313-131313131313", conversationId, turnId,
    providerSessionId: null, turnGroupId: null, type: "user.message",
    createdAt: new Date().toISOString(), sequence: 1, summary: "choose", payload: { text: "Choose" },
  });
  eventsBus.emit("event", {
    id: "14141414-1414-4414-8414-141414141414", conversationId, turnId,
    providerSessionId: null, turnGroupId: null, type: "user_input.requested",
    createdAt: new Date().toISOString(), sequence: 2, summary: "Question", payload: {
      requestId: "request-1",
      questions: [{ id: "approach", header: "Approach", question: "Which approach?", isOther: true,
        options: [{ label: "Agent SDK", description: "Use the supported callback." }] }],
    },
  });

  await page.getByRole("button", { name: /Agent SDK/ }).click();
  await page.getByRole("button", { name: "Submit" }).click();
  await expect.poll(() => lastUserInput).toEqual({
    requestId: "request-1", answers: { approach: ["Agent SDK"] },
  });
});

test.skip("legacy conversation-first: streams a new event into the same browser conversation", async ({ page }) => {
  await page.goto(baseUrl);
  await expect.poll(() => eventsBus.listenerCount("event")).toBeGreaterThan(0);
  eventsBus.emit("event", {
    id: "33333333-3333-4333-8333-333333333333",
    conversationId,
    turnId: "44444444-4444-4444-8444-444444444444",
    providerSessionId: null,
    turnGroupId: null,
    type: "assistant.final",
    createdAt: new Date().toISOString(),
    sequence: 1,
    summary: "Remote result",
    payload: { text: "Live remote result", provider: "codex-official" },
  });
  await expect(page.getByText("Live remote result", { exact: true })).toBeVisible();
});
