import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppOperations } from "../../src/main/core/app-operations";
import { BrowserRuntimeManager } from "../../src/main/browser/browser-runtime-manager";
import { computeAgentBrowserWindowPlacement } from "../../src/main/browser/window-placement";

// Capture slot — the shared mock in browser-runtime.test.ts ignores launch
// options and navigation targets, so this file keeps its own.
const captured = vi.hoisted(() => ({
  launch: undefined as { headless?: boolean; args?: string[] } | undefined,
  goto: undefined as string | undefined,
  newContextOptions: undefined as Record<string, unknown> | undefined,
}));

// Fake Chromium: records the launch options and every navigation target.
vi.mock("playwright", () => {
  const page = {
    on: () => undefined,
    url: () => "about:blank",
    title: () => Promise.resolve(""),
    close: () => Promise.resolve(),
    screenshot: () => Promise.resolve(Buffer.from("fake-png-bytes")),
    viewportSize: () => ({ width: 1920, height: 1042 }),
    goto: (url?: string) => { captured.goto = url; return Promise.resolve(); },
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
  captured.goto = undefined;
  captured.newContextOptions = undefined;
  root = await mkdtemp(join(process.env.TEMP ?? process.cwd(), "coterm-open-agent-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// Minimal dependencies: the popout composition only touches
// dependencies.browser; everything else satisfies the constructor's event
// subscription and type surface.
const stubOperations = (browser: BrowserRuntimeManager): AppOperations =>
  new AppOperations({
    repository: {} as never,
    runs: { send: () => undefined, cancel: () => undefined, command: () => undefined } as never,
    approvals: { resolve: () => undefined } as never,
    council: { start: () => undefined, cancel: () => undefined } as never,
    terminals: {} as never,
    attention: { list: () => [], resolve: () => undefined, onAttentionChanged: () => undefined } as never,
    events: { on: () => undefined } as never,
    appVersion: "test",
    userDataPath: root,
    tempPath: root,
    browser,
  } as never);

describe("openInAgentBrowser (lead wiring entry, 2026-10-09)", () => {
  it("opens an http(s) URL through the policy-checked session path (popout default intact)", async () => {
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
    const operations = stubOperations(manager);
    await operations.openInAgentBrowser({ target: "https://example.com/page " }); // trailing space is trimmed

    // The trimmed URL really navigated, inside a headed (popout) session.
    expect(captured.goto).toBe("https://example.com/page");
    expect(captured.launch?.headless).toBe(false);
    await manager.dispose();
  });

  it("opens a local .html file through the previewLocalFile loopback route (file: stays hard-blocked)", async () => {
    await mkdir(join(root, "artifacts"), { recursive: true });
    await writeFile(join(root, "artifacts", "demo.html"), "<html><body>demo</body></html>");
    const manager = new BrowserRuntimeManager({
      userDataPath: root,
      loopbackPort: () => 4444,
      previewRoots: () => [join(root, "artifacts")],
    });
    const operations = stubOperations(manager);
    await operations.openInAgentBrowser({ target: join(root, "artifacts", "demo.html") });

    // The minted loopback URL navigated (token segment is runtime-minted),
    // never a file:// URL.
    expect(captured.goto).toBeDefined();
    expect(captured.goto).toMatch(/^http:\/\/127\.0\.0\.1:4444\/artifact-preview\/[^/]+\/demo\.html$/);
    await manager.dispose();
  });

  it("returns {ok:false,error} instead of throwing when the browser runtime is unavailable", async () => {
    // Same stub shape as stubOperations but with no browser dependency, so
    // browserRuntime() throws inside the try block.
    const operations = new AppOperations({
      repository: {} as never,
      runs: { send: () => undefined, cancel: () => undefined, command: () => undefined } as never,
      approvals: { resolve: () => undefined } as never,
      council: { start: () => undefined, cancel: () => undefined } as never,
      terminals: {} as never,
      attention: { list: () => [], resolve: () => undefined, onAttentionChanged: () => undefined } as never,
      events: { on: () => undefined } as never,
      appVersion: "test",
      userDataPath: root,
      tempPath: root,
    } as never);
    const result = await operations.openInAgentBrowser({ target: "https://example.com/x" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Browser runtime is unavailable.");
  });
});
