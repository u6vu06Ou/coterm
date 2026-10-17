import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _electron as electron, expect, test } from "@playwright/test";
import { AppDatabase } from "../../src/main/storage/database";
import { Repository } from "../../src/main/storage/repository";
import { openSettingsTab } from "./helpers/settings-tabs";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

// Retained as a historical regression record only. The conversation timeline,
// composer, workspace-pane controls, and conversation rename/archive UI this
// scenario exercises were intentionally removed by the terminal-first redesign.
// Current IME coverage lives in terminal/mobile input tests; current native
// ConPTY coverage is pinned by the terminal-first smoke below and packaged E2E.
test.skip("legacy conversation-first local-state / IME / workspace scenario", async () => {
  const userData = await mkdtemp(join(tmpdir(), "ai-terminal-e2e-"));
  const markdownPath = join(process.cwd(), ".coterm-e2e.md");
  await writeFile(markdownPath, "# Original\n", "utf8");
  const database = new AppDatabase(join(userData, "ai-terminal.sqlite"));
  await database.open();
  const repository = new Repository(database);
  const project = await repository.createProject("E2E 中文專案", process.cwd());
  const conversation = await repository.createConversation(
    project.id,
    "桌面驗收",
    "codex-official",
  );
  const imagePath = join(userData, "e2e-attachment.png");
  await writeFile(
    imagePath,
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  );
  const attachment = await repository.addAttachment(
    conversation.id,
    "驗收圖片.png",
    "image/png",
    imagePath,
    68,
  );
  const session = await repository.getOrCreateProviderSession(
    conversation.id,
    "codex-official",
  );
  const turnId = await repository.startTurn(conversation.id, session.id);
  await repository.appendEvent({
    conversationId: conversation.id,
    turnId,
    providerSessionId: session.id,
    turnGroupId: null,
    type: "user.message",
    summary: "User message.",
    payload: {
      text: "這是 Electron E2E 對話。",
      profileId: "codex-official",
      attachmentIds: [attachment.id],
    },
  });
  await repository.appendEvent({
    conversationId: conversation.id,
    turnId,
    providerSessionId: session.id,
    turnGroupId: null,
    type: "assistant.progress",
    summary: "Codex is responding.",
    payload: { delta: "本機資料" },
  });
  await repository.appendEvent({
    conversationId: conversation.id,
    turnId,
    providerSessionId: session.id,
    turnGroupId: null,
    type: "assistant.progress",
    summary: "Codex is responding.",
    payload: { delta: "載入成功。" },
  });
  await repository.appendEvent({
    conversationId: conversation.id,
    turnId,
    providerSessionId: session.id,
    turnGroupId: null,
    type: "agent.started",
    summary: "搜尋終端專案",
    payload: { taskId: "task-1", description: "搜尋終端專案", status: "running" },
  });
  await repository.appendEvent({
    conversationId: conversation.id,
    turnId,
    providerSessionId: session.id,
    turnGroupId: null,
    type: "agent.completed",
    summary: "搜尋完成",
    payload: { taskId: "task-1", status: "completed", totalTokens: 3210, toolUses: 7, durationMs: 42_000 },
  });
  await repository.appendEvent({
    conversationId: conversation.id,
    turnId,
    providerSessionId: session.id,
    turnGroupId: null,
    type: "assistant.final",
    summary: "Codex completed.",
    payload: { text: "本機資料載入成功。", provider: "codex-official" },
  });
  await repository.completeTurn(turnId, "completed");
  await repository.setSettings({
    ...repository.getSettings(),
    onboardingCompleted: true,
    defaultWorkspacePath: process.cwd(),
  });
  database.close();

  const application = await electron.launch({
    executablePath: electronPath,
    args: ["."],
    cwd: process.cwd(),
    env: {
      ...process.env,
      COTERM_USER_DATA_DIR: userData,
      NODE_ENV: "production",
    },
  });

  try {
    const page = await application.firstWindow();
    await expect(page.getByText("本機資料載入成功。", { exact: true })).toBeVisible();
    await page.locator(".trace-panel > summary").click();
    await page.getByText("Workflow Agents", { exact: true }).click();
    await expect(page.getByText("3,210 tokens · 7 tools · 42s", { exact: true })).toBeVisible();
    await expect(page.locator(".explorer-panel")).toHaveClass(/collapsed/);
    await page.getByRole("button", { name: "開啟 Explorer" }).click();
    await expect(page.locator(".explorer-panel")).not.toHaveClass(/collapsed/);
    await expect(page.getByRole("button", { name: "package.json" })).toBeVisible();
    await page.getByRole("button", { name: ".coterm-e2e.md" }).click();
    await page.getByRole("button", { name: "編輯 Markdown" }).click();
    const markdownEditor = page.getByRole("textbox", { name: "Markdown 編輯器" });
    await markdownEditor.fill("# Saved\n");
    await page.getByRole("button", { name: "存檔" }).click();
    await expect(page.getByRole("heading", { name: "Saved" })).toBeVisible();
    await expect.poll(() => readFile(markdownPath, "utf8")).toBe("# Saved\n");
    await page.getByRole("button", { name: "放大圖片" }).click();
    await expect(page.getByRole("dialog", { name: "圖片放大檢視" })).toBeVisible();
    await page.getByRole("button", { name: "關閉圖片" }).click();
    const sidebarResizer = page.getByRole("separator", { name: "調整左側欄寬度" });
    const initialSidebarWidth = Number(await sidebarResizer.getAttribute("aria-valuenow"));
    await sidebarResizer.press("ArrowRight");
    await expect(sidebarResizer).toHaveAttribute("aria-valuenow", String(initialSidebarWidth + 12));
    await expect(page.getByRole("separator", { name: "調整右側預覽寬度" })).toBeVisible();
    const paneWidthWithArtifacts = await page.locator(".workspace-panes").evaluate((element) =>
      element.getBoundingClientRect().width,
    );
    await page.getByRole("button", { name: "關閉預覽" }).click();
    await expect(page.locator(".artifact-rail")).toHaveCount(0);
    await expect.poll(() => page.locator(".workspace-panes").evaluate((element) =>
      element.getBoundingClientRect().width,
    )).toBeGreaterThan(paneWidthWithArtifacts + 200);
    await page.getByRole("button", { name: "Artifacts" }).click();
    await expect(page.locator(".artifact-rail")).toBeVisible();
    await expect(page.getByRole("combobox", { name: "目前代理" })).toHaveValue(
      "codex-official",
    );
    await expect(page.locator(".paid-crown")).toHaveCount(2);
    await expect(page.locator(".pane-project-title")).toHaveCSS("font-weight", "750");
    const projectRow = page.locator(".project-row").filter({ hasText: "E2E 中文專案" });
    await projectRow.hover();
    await projectRow.getByRole("button", { name: "重新命名專案" }).click();
    const projectName = page.getByRole("textbox", { name: "專案名稱" });
    await projectName.fill("重新命名成功");
    await projectName.press("Enter");
    await expect(page.locator(".project-row .project-copy strong", { hasText: "重新命名成功" })).toBeVisible();
    await page.getByRole("button", { name: "收合專案欄" }).click();
    await expect(page.getByRole("button", { name: "展開專案欄" })).toBeVisible();
    await page.getByRole("button", { name: "展開專案欄" }).click();

    const composer = page.locator(".composer textarea");
    await expect(composer).toHaveAttribute("placeholder", "");
    await page.keyboard.press("Control+K");
    await expect(page.getByRole("textbox", { name: "搜尋專案" })).toBeFocused();
    await composer.fill("保留既有草稿");
    await page.getByText("Codex 常用技能", { exact: true }).click();
    await page.getByRole("button", { name: /Plan/ }).click();
    await expect(composer).toHaveValue(/請先檢查專案[\s\S]*保留既有草稿/);
    await composer.fill("第一行\n第二行\n第三行");
    await expect
      .poll(() => composer.evaluate((element) => element.getBoundingClientRect().height))
      .toBeGreaterThan(40);
    await composer.fill("/he");
    await expect(page.getByRole("listbox", { name: "Slash 指令" })).toBeVisible();
    await composer.press("Escape");
    await expect(composer).toHaveValue("/he");
    await expect(page.getByRole("listbox", { name: "Slash 指令" })).toHaveCount(0);
    await composer.fill("");
    await page.getByRole("combobox", { name: "目前代理" }).selectOption("claude-official");
    await composer.fill("ultracode 調查問題");
    await expect(page.locator(".composer")).toHaveClass(/ultracode-active/);
    await expect(page.getByText("ULTRACODE", { exact: true })).toBeVisible();
    await composer.fill("/ultracode");
    await expect(page.getByRole("option", { name: /自動派發多個 Agent/ })).toBeVisible();
    await composer.press("Enter");
    await expect(composer).toHaveValue("ultracode ");
    await expect(page.getByRole("button", { name: "原生互動" })).toBeVisible();
    await composer.fill("");
    await composer.fill("/status");
    await composer.press("Enter");
    await expect(page.getByRole("heading", { name: "Coterm status" })).toBeVisible();
    await expect(composer).toHaveValue("");
    await composer.evaluate((element) => {
      element.dispatchEvent(new CompositionEvent("compositionstart", { data: "測", bubbles: true }));
    });
    await expect(page.locator(".ime-active")).toBeVisible();
    await composer.evaluate((element) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        element,
        "測試組字不可送出",
      );
      element.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: "測試組字不可送出",
        inputType: "insertCompositionText",
        isComposing: true,
      }));
    });
    await expect(composer).toHaveValue("測試組字不可送出");
    await expect(page.locator(".ime-active")).toBeVisible();
    const unsentComposition = page.locator(".user-message").filter({ hasText: "測試組字不可送出" });
    await expect(unsentComposition).toHaveCount(0);
    const imeEnterPrevented = await composer.evaluate((element) => {
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      });
      Object.defineProperty(event, "isComposing", { value: true });
      Object.defineProperty(event, "keyCode", { value: 229 });
      return !element.dispatchEvent(event);
    });
    expect(imeEnterPrevented).toBe(true);
    await expect(unsentComposition).toHaveCount(0);
    await composer.evaluate((element) => {
      element.dispatchEvent(new CompositionEvent("compositionend", { data: "測試", bubbles: true }));
    });

    await page.evaluate(() => localStorage.setItem("coterm-terminal-height", "900"));
    await page.reload();
    await page.locator('[data-action-id="sidebar.project.open-agent"]').first().dispatchEvent("click");
    await expect(page.locator(".xterm-screen")).toBeVisible();
    await expect(page.locator(".xterm-pane-frame header").first()).toContainText("shell");
    const terminalResizer = page.getByRole("separator", { name: "調整對話區與終端高度" });
    await expect(terminalResizer).toHaveAttribute("aria-valuenow", "224");
    const initialTerminalHeight = Number(await terminalResizer.getAttribute("aria-valuenow"));
    await terminalResizer.press("ArrowUp");
    await expect(terminalResizer).toHaveAttribute("aria-valuenow", String(initialTerminalHeight + 16));
    await page.evaluate(() => localStorage.setItem("coterm-terminal-height", "720"));
    await page.reload();
    await expect(terminalResizer).toHaveAttribute("aria-valuenow", "720");
    await terminalResizer.dblclick();
    await expect(terminalResizer).toHaveAttribute("aria-valuenow", "224");
    const paneCount = page.getByRole("combobox", { name: "工作窗格數量" });
    const expectTerminalDockToFit = async (): Promise<void> => {
      await expect.poll(async () => page.locator(".workspace-pane").evaluateAll((panes) =>
        panes.every((pane) => {
          const dock = pane.querySelector<HTMLElement>(".terminal-dock:not(.collapsed)");
          if (!dock) return true;
          const paneHeight = pane.getBoundingClientRect().height;
          const dockHeight = dock.getBoundingClientRect().height;
          return dockHeight >= 95 && dockHeight <= paneHeight - 210;
        }),
      )).toBe(true);
    };
    await paneCount.selectOption("2");
    await expect(page.locator(".workspace-panes")).toHaveClass(/panes-2/);
    await expectTerminalDockToFit();
    await expect.poll(async () => {
      const boxes = await page.locator(".workspace-pane").evaluateAll((items) =>
        items.map((item) => item.getBoundingClientRect().width),
      );
      return Math.abs((boxes[0] ?? 0) - (boxes[1] ?? 0));
    }).toBeLessThan(2);
    await paneCount.selectOption("3");
    await expect(page.locator(".workspace-panes")).toHaveClass(/panes-3/);
    await expectTerminalDockToFit();
    await expect.poll(async () => {
      const boxes = await page.locator(".workspace-pane").evaluateAll((items) =>
        items.map((item) => item.getBoundingClientRect().height),
      );
      return (boxes[0] ?? 0) > (boxes[1] ?? 0);
    }).toBe(true);
    await paneCount.selectOption("4");
    await expect(page.locator(".workspace-panes")).toHaveClass(/panes-4/);
    await expectTerminalDockToFit();
    await expect(page.locator(".workspace-pane")).toHaveCount(4);
    await expect.poll(async () => {
      const boxes = await page.locator(".workspace-pane").evaluateAll((items) =>
        items.map((item) => {
          const box = item.getBoundingClientRect();
          return { width: box.width, height: box.height };
        }),
      );
      return Math.max(
        Math.abs((boxes[0]?.width ?? 0) - (boxes[3]?.width ?? 0)),
        Math.abs((boxes[0]?.height ?? 0) - (boxes[3]?.height ?? 0)),
      );
    }).toBeLessThan(2);
    await page.locator(".workspace-pane").nth(1).getByRole("button", { name: "關閉此窗格" }).click();
    await expect(page.locator(".workspace-pane")).toHaveCount(3);
    await paneCount.selectOption("1");
    await page.getByRole("button", { name: "設定" }).click();
    const themeSelect = page.getByRole("combobox", { name: "介面主題" });
    for (const theme of ["aurora-glass", "neo-ink", "obsidian-copper", "pearl-frost", "prism-noir", "teams"]) {
      await themeSelect.selectOption(theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      if (theme === "pearl-frost") {
        await expect(page.locator(".terminal-dock")).toHaveCSS("background-color", "rgb(11, 31, 42)");
        expect(await page.locator(".xterm-viewport").evaluate((element) => {
          const channels = getComputedStyle(element).backgroundColor.match(/\d+/g)?.map(Number) ?? [];
          return channels.length >= 3 && Math.max(...channels.slice(0, 3)) < 64;
        })).toBe(true);
      }
    }
    const effectsSelect = page.getByRole("combobox", { name: "視覺效果" });
    for (const effects of ["off", "low", "medium", "high"]) {
      await effectsSelect.selectOption(effects);
      await expect(page.locator("html")).toHaveAttribute("data-effects", effects);
    }
    await themeSelect.selectOption("aurora-glass");
    await effectsSelect.selectOption("medium");
    await page.locator(".settings-drawer").getByRole("button").first().click();
    const conversationRow = page.locator(".conversation-item").filter({ hasText: "桌面驗收" });
    await conversationRow.hover();
    await conversationRow.getByRole("button", { name: "重新命名對話" }).click();
    const conversationName = page.getByRole("textbox", { name: "對話名稱" });
    await conversationName.fill("對話改名成功");
    await conversationName.press("Enter");
    const renamedConversation = page.locator(".conversation-item").filter({ hasText: "對話改名成功" });
    await expect(renamedConversation).toBeVisible();
    await renamedConversation.hover();
    await renamedConversation.getByRole("button", { name: "封存對話" }).click();
    await page.getByRole("button", { name: "封存項目" }).click();
    await expect(page.getByText("對話改名成功", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "還原對話" }).click();
    await expect(page.locator(".conversation-item").filter({ hasText: "對話改名成功" })).toBeVisible();
  } finally {
    await application.close();
    await rm(userData, { recursive: true, force: true });
    await rm(markdownPath, { force: true });
  }
});

test("loads terminal-first local state and starts a ConPTY shell", async () => {
  const userData = await mkdtemp(join(tmpdir(), "coterm-terminal-first-e2e-"));
  const database = new AppDatabase(join(userData, "ai-terminal.sqlite"));
  await database.open();
  const repository = new Repository(database);
  await repository.createProject("Terminal-first E2E", process.cwd());
  await repository.setSettings({
    ...repository.getSettings(),
    onboardingCompleted: true,
    defaultWorkspacePath: process.cwd(),
  });
  database.close();

  const application = await electron.launch({
    executablePath: electronPath,
    args: ["."],
    cwd: process.cwd(),
    env: {
      ...process.env,
      COTERM_USER_DATA_DIR: userData,
      NODE_ENV: "production",
    },
  });

  try {
    const page = await application.firstWindow();
    await expect(page.locator(".project-main").filter({ hasText: "Terminal-first E2E" })).toBeVisible();
    await expect(page.locator(".conversation-column")).toHaveCount(0);
    await expect(page.locator(".composer textarea")).toHaveCount(0);
    await page.locator('[data-action-id="sidebar.project.open-agent"]').first().dispatchEvent("click");
    await expect(page.locator(".xterm-screen")).toBeVisible();
    await expect(page.locator('[data-action-id="picker.dialog.consume"]')).toBeVisible();
    await page.locator('[data-action-id="picker.close"]').click();
    await expect(page.locator(".terminal-dock-grid")).toBeVisible();
  } finally {
    await application.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test("allows first-run completion without forcing an IME sample", async () => {
  const userData = await mkdtemp(join(tmpdir(), "ai-terminal-onboarding-e2e-"));
  const application = await electron.launch({
    executablePath: electronPath,
    args: ["."],
    cwd: process.cwd(),
    env: {
      ...process.env,
      COTERM_USER_DATA_DIR: userData,
      NODE_ENV: "production",
    },
  });

  try {
    const page = await application.firstWindow();
    const next = page.getByRole("button", { name: /下一步/ });
    for (let step = 0; step < 5; step += 1) await next.click();
    const finish = page.getByRole("button", { name: /略過測試並完成/ });
    await expect(finish).toBeEnabled();
    await finish.click();
    await expect(page.locator(".first-run-wizard")).toHaveCount(0);
  } finally {
    await application.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test("keeps one database writer by rejecting a second app instance", async () => {
  const userData = await mkdtemp(join(tmpdir(), "ai-terminal-single-instance-e2e-"));
  const application = await electron.launch({
    executablePath: electronPath,
    args: ["."],
    cwd: process.cwd(),
    env: {
      ...process.env,
      COTERM_USER_DATA_DIR: userData,
      NODE_ENV: "production",
    },
  });

  try {
    const page = await application.firstWindow();
    await expect(page).toHaveTitle("Coterm");
    const second = spawn(electronPath, ["."], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        COTERM_USER_DATA_DIR: userData,
        NODE_ENV: "production",
      },
      stdio: "ignore",
      windowsHide: true,
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        second.kill();
        reject(new Error("Second Coterm instance did not exit."));
      }, 10_000);
      second.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      second.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    expect(exitCode).toBe(0);
    await expect(page).toHaveTitle("Coterm");
  } finally {
    await application.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test("keeps the core alive after the last window closes and reopens it from a second launch", async () => {
  const userData = await mkdtemp(join(tmpdir(), "coterm-background-e2e-"));
  const application = await electron.launch({
    executablePath: electronPath, args: ["."], cwd: process.cwd(),
    env: { ...process.env, COTERM_USER_DATA_DIR: userData, NODE_ENV: "production" },
  });
  try {
    const first = await application.firstWindow();
    const originalPid = application.process().pid;
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await expect.poll(() => application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.isVisible(),
    )).toBe(false);
    const second = spawn(electronPath, ["."], {
      cwd: process.cwd(),
      env: { ...process.env, COTERM_USER_DATA_DIR: userData, NODE_ENV: "production" },
      stdio: "ignore", windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      second.once("exit", () => resolve()); second.once("error", reject);
    });
    await expect.poll(() => application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.isVisible(),
    )).toBe(true);
    await expect(first).toHaveTitle("Coterm");
    expect(application.process().pid).toBe(originalPid);
  } finally {
    await application.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test("offers an explicit desktop-only Quit action", async () => {
  const userData = await mkdtemp(join(tmpdir(), "coterm-quit-e2e-"));
  const database = new AppDatabase(join(userData, "ai-terminal.sqlite"));
  await database.open();
  const repository = new Repository(database);
  await repository.setSettings({ ...repository.getSettings(), onboardingCompleted: true });
  database.close();
  const application = await electron.launch({
    executablePath: electronPath, args: ["."], cwd: process.cwd(),
    env: { ...process.env, COTERM_USER_DATA_DIR: userData, NODE_ENV: "production" },
  });
  try {
    const page = await application.firstWindow();
    const exited = new Promise<void>((resolve) => application.process().once("exit", () => resolve()));
    await page.locator('[data-action-id="topbar.app.quit"]').click();
    await exited;
  } finally {
    await application.close().catch(() => undefined);
    await rm(userData, { recursive: true, force: true });
  }
});

test("packaged app loads ASAR resources and native ConPTY", async () => {
  test.skip(process.env.COTERM_PACKAGED_E2E !== "1");
  const packagedExecutable =
    process.env.COTERM_PACKAGED_EXE ??
    join(process.cwd(), "release", "win-unpacked", "Coterm.exe");
  expect(existsSync(packagedExecutable)).toBe(true);
  const userData = await mkdtemp(join(tmpdir(), "ai-terminal-packaged-e2e-"));
  const database = new AppDatabase(join(userData, "ai-terminal.sqlite"));
  await database.open();
  const repository = new Repository(database);
  const project = await repository.createProject("Packaged E2E", process.cwd());
  await repository.createConversation(project.id, "ASAR 驗收", "codex-official");
  await repository.setSettings({
    ...repository.getSettings(),
    onboardingCompleted: true,
    defaultWorkspacePath: process.cwd(),
  });
  database.close();

  const application = await electron.launch({
    executablePath: packagedExecutable,
    env: {
      ...process.env,
      COTERM_USER_DATA_DIR: userData,
    },
  });

  try {
    const page = await application.firstWindow();
    await expect(page.locator(".project-main").filter({ hasText: "Packaged E2E" })).toBeVisible();
    await page.locator('[data-action-id="sidebar.project.open-agent"]').first().dispatchEvent("click");
    await expect(page.locator(".xterm-screen")).toBeVisible();
    const picker = page.locator('[data-action-id="picker.dialog.consume"]');
    await expect(picker).toBeVisible();
    // Rows show the backend label (「my-qwen」), not the raw profile id — assert
    // by data-agent-id so the display rename can't drift this test.
    await expect(picker.locator('[data-agent-id="claude-local-long2"]').first()).toBeVisible();
    // claude-local-long / codex-local-long duplicate the my-qwen pair — hidden from the picker 2026-09-13.
    await expect(picker.locator('[data-agent-id="claude-local-long"]')).toHaveCount(0);
    await expect(picker.locator('[data-agent-id="codex-local-long"]')).toHaveCount(0);
    // DeepSeek V4 (my-ds-alt) was removed 2026-09-09 — its options must be gone entirely.
    await expect(picker.getByText("DeepSeek V4 — Codex", { exact: true })).toHaveCount(0);
    // my-legacy-model was decommissioned 2026-08-29 — its options must be gone entirely.
    await expect(picker.getByText("my-legacy-model 1.5 — Claude Code", { exact: true })).toHaveCount(0);
    await expect(picker.getByText("my-legacy-model 1.5 — Codex", { exact: true })).toHaveCount(0);
    await page.locator('[data-action-id="picker.close"]').click();

    await page.locator('[data-action-id="topbar.settings.open"]').click();
    await openSettingsTab(page, "agent");
    const providerSelect = page.locator('[data-action-id="settings.provider.change"]');
    await expect(providerSelect.locator('option[value="claude-local-long2"]')).toHaveCount(1);
    await expect(providerSelect.locator('option[value="codex-local-main"]')).toHaveCount(1);
    await expect(providerSelect.locator('option[value="claude-local-legacy"]')).toHaveCount(0);
    await expect(providerSelect.locator('option[value="codex-local-legacy"]')).toHaveCount(0);
  } finally {
    await application.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test("does not resurrect ended PTYs after restart and can open a fresh terminal-first tile", async () => {
  // This lifecycle test launches Electron twice and can overlap six other
  // Playwright workers in the full suite. Keep the assertions unchanged but
  // give process shutdown/startup a bounded budget that survives CI contention.
  test.setTimeout(120_000);
  const userData = await mkdtemp(join(tmpdir(), "ai-terminal-layout-e2e-"));
  const database = new AppDatabase(join(userData, "ai-terminal.sqlite"));
  await database.open();
  const repository = new Repository(database);
  const project = await repository.createProject("Layout E2E", process.cwd());
  await repository.createConversation(project.id, "Layout", "codex-official");
  await repository.setSettings({
    ...repository.getSettings(),
    onboardingCompleted: true,
    defaultWorkspacePath: process.cwd(),
  });
  database.close();

  let application = await electron.launch({
    executablePath: electronPath,
    args: ["."],
    cwd: process.cwd(),
    env: {
      ...process.env,
      COTERM_USER_DATA_DIR: userData,
      NODE_ENV: "production",
    },
  });

  try {
    let page = await application.firstWindow();
    await page.locator('[data-action-id="sidebar.project.open-agent"]').first().dispatchEvent("click");
    await expect(page.locator('[data-action-id="picker.dialog.consume"]')).toBeVisible();
    await page.locator('[data-action-id="picker.close"]').click();
    await page.locator('[data-action-id="sidebar.project.open-agent"]').first().dispatchEvent("click");
    await expect(page.locator('[data-action-id="picker.dialog.consume"]')).toBeVisible();
    await page.locator('[data-action-id="picker.close"]').click();
    await expect(page.locator(".xterm-screen")).toHaveCount(2);
    await expect(page.locator(".dock-resize-vertical")).toHaveCount(1);
    await page.waitForTimeout(500);
    await application.close();

    application = await electron.launch({
      executablePath: electronPath,
      args: ["."],
      cwd: process.cwd(),
      env: {
        ...process.env,
        COTERM_USER_DATA_DIR: userData,
        NODE_ENV: "production",
      },
    });
    page = await application.firstWindow();
    // DockLayoutManager deliberately persists only structural resize fractions:
    // PTY process identities do not survive an application restart.
    await expect(page.locator(".xterm-screen")).toHaveCount(0);
    await page.locator('[data-action-id="sidebar.project.open-agent"]').first().dispatchEvent("click");
    await expect(page.locator(".xterm-screen")).toHaveCount(1);
    await expect(page.locator('[data-action-id="picker.dialog.consume"]')).toBeVisible();
    await page.locator('[data-action-id="picker.close"]').click();
  } finally {
    await application.close().catch(() => undefined);
    await rm(userData, { recursive: true, force: true });
  }
});
