import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { AppEventBus } from "../../src/main/core/event-bus";
import { startWebServer, type RunningWebServer } from "../../src/main/web/web-server";
import { appSettingsSchema } from "../../src/shared/schema";

/**
 * Mobile terminal-first launch regression.
 *
 * The old suite targeted the removed conversation/pane UI and a duplicate
 * top-bar +agent button. The production contract is now:
 * sidebar project + -> openTile -> LLM picker -> coterm:interactive-agent.
 * Exactly-one trailing Enter is covered by kimi-launch-enter.test.ts.
 */

const projectId = "11111111-1111-4111-8111-111111111111";
const rpcCalls: Array<{ method: string; input?: unknown }> = [];
let nextTerminal = 1;
let server: RunningWebServer;
let baseUrl: string;

interface FixtureLayout {
  tiles: Array<{ terminalId: string; projectId: string; weight: number; agentProfile: null }>;
  selectedTerminalId: string | null;
  exclusiveTerminalId: null;
  rows: number[];
  cols: number[][];
  ptyCols: number;
  ptyRows: number;
}

let dockLayout: FixtureLayout;

function emptyLayout(): FixtureLayout {
  return {
    tiles: [],
    selectedTerminalId: null,
    exclusiveTerminalId: null,
    rows: [],
    cols: [],
    ptyCols: 100,
    ptyRows: 28,
  };
}

test.beforeAll(async () => {
  const now = new Date().toISOString();
  dockLayout = emptyLayout();
  server = await startWebServer({
    port: 0,
    allowedOrigin: "self",
    rendererPath: join(process.cwd(), "out", "renderer"),
    verifyAccess: () => Promise.resolve({ email: "owner@example.com" }),
    events: new AppEventBus(),
    operations: {
      bootstrap: () => ({
        projects: [{
          id: projectId,
          name: "Coterm fixture",
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
        appVersion: "1.5.0-beta.1",
        userDataPath: "[redacted]",
        startupAlerts: "",
      }),
      getSettings: () => appSettingsSchema.parse({
        theme: "dark",
        locale: "zh-TW",
        defaultProvider: "codex-local-main",
        defaultShell: "powershell",
        proxyUrl: "http://127.0.0.1:8787",
        permissionPreset: "ask",
        onboardingCompleted: true,
        defaultWorkspacePath: process.cwd(),
      }),
      getDockLayout: () => dockLayout,
      getTerminalWorkspace: () => ({
        terminals: [],
        split: "single",
        activeId: null,
        secondaryId: null,
        scrollback: {},
        restored: true,
      }),
      getTerminalDashboard: () => [],
      getUsageSnapshot: () => ({ claude5h: null, claude7d: null, codex7d: null, fetchedAt: Date.now() }),
      listAttention: () => [],
      listEvents: () => [],
      listWorkspace: () => [],
      listAttachments: () => [],
      refreshProviders: () => [],
      openTile: (input: unknown) => {
        rpcCalls.push({ method: "openTile", input });
        const terminalId = `31111111-1111-4111-8111-${String(nextTerminal++).padStart(12, "0")}`;
        dockLayout = {
          ...dockLayout,
          tiles: [...dockLayout.tiles, { terminalId, projectId, weight: 1, agentProfile: null }],
          selectedTerminalId: terminalId,
          rows: [1],
          cols: [Array.from({ length: dockLayout.tiles.length + 1 }, () => 1 / (dockLayout.tiles.length + 1))],
        };
        return dockLayout;
      },
      selectTile: (input: unknown) => {
        rpcCalls.push({ method: "selectTile", input });
        return dockLayout;
      },
      setDockLayout: () => dockLayout,
      getPtyState: () => "shell-ready",
      writeTerminal: (input: unknown) => {
        rpcCalls.push({ method: "writeTerminal", input });
        return undefined;
      },
    } as never,
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

test.afterAll(async () => server.close());

test.beforeEach(() => {
  rpcCalls.length = 0;
  dockLayout = emptyLayout();
});

async function enterMobile(page: Page): Promise<void> {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(baseUrl);
  await page.locator(".boot-screen").waitFor({ state: "detached" });
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator("[data-action-id='sidebar.expand']")).toBeVisible();
}

async function openProjectPicker(page: Page): Promise<void> {
  await page.locator("[data-action-id='sidebar.expand']").click();
  const openAgent = page.locator("[data-action-id='sidebar.project.open-agent']");
  await expect(openAgent).toBeVisible();
  await openAgent.click();
  await expect(page.locator("[data-action-id='picker.dialog.consume']")).toBeVisible();
}

test("mobile uses the project + launcher and has no duplicate top-bar agent button", async ({ page }) => {
  await enterMobile(page);
  await expect(page.locator(".terminal-dock")).toBeVisible();
  await expect(page.locator(".topbar-agent-launch")).toHaveCount(0);

  await openProjectPicker(page);
  expect(rpcCalls.filter((call) => call.method === "openTile")).toHaveLength(1);
  await expect(page.locator("[data-action-id='picker.plain.select']")).toBeVisible();
});

test("selecting an agent dispatches once to the terminal returned by openTile", async ({ page }) => {
  await enterMobile(page);
  await page.evaluate(() => {
    const launches: unknown[] = [];
    Object.assign(window, { __cotermLaunches: launches });
    window.addEventListener("coterm:interactive-agent", (event) => {
      launches.push((event as CustomEvent).detail);
    });
  });
  await openProjectPicker(page);
  const terminalId = dockLayout.selectedTerminalId;
  expect(terminalId).not.toBeNull();

  const codex = page.locator("[data-agent-id='codex-local-main']");
  await expect(codex).toHaveCount(1);
  await codex.click();
  await expect(page.locator("[data-action-id='picker.dialog.consume']")).toHaveCount(0);

  const launches = await page.evaluate(() => (window as unknown as {
    __cotermLaunches: Array<{ terminalId: string; provider: string }>;
  }).__cotermLaunches);
  expect(launches).toEqual([{ terminalId, provider: "codex-local-main" }]);
});

test("plain terminal closes the picker without opening a duplicate tile", async ({ page }) => {
  await enterMobile(page);
  await openProjectPicker(page);
  await page.locator("[data-action-id='picker.plain.select']").click();
  await expect(page.locator("[data-action-id='picker.dialog.consume']")).toHaveCount(0);
  expect(rpcCalls.filter((call) => call.method === "openTile")).toHaveLength(1);
  await expect(page.locator("[data-action-id='topbar.mobile.enter']")).toBeEnabled();
});

test("rapid open and Escape cycles leave the shell responsive", async ({ page }) => {
  await enterMobile(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  for (let index = 0; index < 5; index += 1) {
    await openProjectPicker(page);
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-action-id='picker.dialog.consume']")).toHaveCount(0);
  }

  expect(rpcCalls.filter((call) => call.method === "openTile")).toHaveLength(5);
  expect(pageErrors).toEqual([]);
  await expect(page.locator(".app-shell")).toBeVisible();
});
