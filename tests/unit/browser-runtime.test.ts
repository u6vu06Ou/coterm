import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserArtifactStore } from "../../src/main/browser/browser-artifact-store";
import { browserErrorCode, BrowserServiceError } from "../../src/main/browser/browser-errors";
import { browserRisk, parseAllowedHosts, validateBrowserUrl, validateProfileId } from "../../src/main/browser/browser-policy";
import { BrowserRuntimeManager, detectBotWall, SNAPSHOT_MAX_CHARS_DEFAULT, EVALUATE_SCRIPT_MAX_CHARS } from "../../src/main/browser/browser-runtime-manager";
import { BrowserApprovalService } from "../../src/main/browser/browser-approval-service";
import { ApprovalBroker } from "../../src/main/core/approval-broker";
import { BrowserSecretVault } from "../../src/main/browser/browser-secret-vault";
import { browserActionRegistry, browserDiscoverySchema, dispatchBrowserAction } from "../../src/main/browser/browser-action-registry";
import { createBrowserMcpHandler, MCP_BROWSER_CORE_ACTION_IDS } from "../../src/main/mcp/mcp-server";
import { searchWorkspaceEntries } from "../../src/main/core/workspace-search";
import { browserActionErrorCodes, type BrowserDocument } from "../../src/shared/browser-types";
import { browserLocatorSchema, browserWaitForInputSchema } from "../../src/shared/browser-schema";
import { AGENT_RATE_LIMIT_DEFAULTS } from "../../src/shared/schema";
import { redactUrlQuery } from "../../src/main/security/redaction";

const launches = { count: 0 };
const lastEvaluate = { includeLinks: false };
// Mutable so a test can navigate the page mid-approval (evaluate origin TOCTOU).
const pageState = { url: "about:blank" };

// Fake Chromium: enough surface for createSession/newPage, and a launch counter so a test can
// prove that N concurrent sessions share ONE browser process.
vi.mock("playwright", () => {
  const page = {
    on: () => undefined,
    url: () => pageState.url,
    title: () => Promise.resolve(""),
    close: () => Promise.resolve(),
    screenshot: () => Promise.resolve(Buffer.from("fake-png-bytes")),
    viewportSize: () => ({ width: 1280, height: 720 }),
    goto: () => Promise.resolve(),
    evaluate: (_fn: unknown, options?: { includeLinks?: boolean }) => {
      lastEvaluate.includeLinks = options?.includeLinks === true;
      return Promise.resolve({
        version: 1,
        source: { url: "https://a.example/", finalUrl: "https://a.example/", title: "A", fetchedAt: "2026-07-25T00:00:00.000Z", contentType: "text/html" },
        metadata: {}, headings: [], paragraphs: [], lists: [], tables: [], images: [],
        links: [{ text: "B", url: "https://b.example/" }],
        text: "hello",
      });
    },
  };
  const context = { route: () => Promise.resolve(), on: () => undefined, newPage: () => Promise.resolve(page), close: () => Promise.resolve() };
  const browser = { newContext: () => Promise.resolve(context), close: () => Promise.resolve() };
  return { chromium: { launch: () => { launches.count += 1; return Promise.resolve(browser); }, launchPersistentContext: () => Promise.resolve(context) } };
});

let root: string;

beforeEach(async () => {
  pageState.url = "about:blank";
  root = await mkdtemp(join(process.env.TEMP ?? process.cwd(), "coterm-browser-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("browser policy", () => {
  it("allows public HTTP(S) URLs and blocks private or executable schemes", () => {
    expect(validateBrowserUrl("https://example.com/path").hostname).toBe("example.com");
    expect(() => validateBrowserUrl("http://127.0.0.1:3000")).toThrow(BrowserServiceError);
    expect(() => validateBrowserUrl("file:///C:/secret.txt")).toThrow(BrowserServiceError);
    expect(() => validateBrowserUrl("https://user:pass@example.com")).toThrow(BrowserServiceError);
    expect(() => validateBrowserUrl("http://169.254.169.254/latest/meta-data")).toThrow(BrowserServiceError);
    expect(validateBrowserUrl("http://127.0.0.1:3000", { allowPrivateNetwork: true }).port).toBe("3000");
  });

  it("blocks the whole CGNAT range and opens only the hosts on the allowlist", () => {
    // 100.64.0.0/10 runs to 100.127.x. The old pattern stopped at 100.99, so most of a
    // Tailscale tailnet was never blocked at all.
    expect(() => validateBrowserUrl("http://100.64.0.1:8188")).toThrow(BrowserServiceError);
    expect(() => validateBrowserUrl("http://100.127.255.254/")).toThrow(BrowserServiceError);
    expect(validateBrowserUrl("http://100.128.0.1/").hostname).toBe("100.128.0.1");

    const allowHosts = parseAllowedHosts("100.64.0.1, EXAMPLE.local");
    expect(validateBrowserUrl("http://100.64.0.1:8188", { allowHosts }).port).toBe("8188");
    expect(validateBrowserUrl("http://example.local/", { allowHosts }).hostname).toBe("example.local");
    // The allowlist is exactly that — a neighbour on the same subnet stays blocked.
    expect(() => validateBrowserUrl("http://100.64.0.2/", { allowHosts })).toThrow(BrowserServiceError);
    expect(() => validateBrowserUrl("http://127.0.0.1:3000", { allowHosts })).toThrow(BrowserServiceError);
  });

  it("opens one loopback port without opening every local service", () => {
    // This is how the agent reaches its own artifact preview. Opening bare 127.0.0.1 would also
    // hand it the LLM proxy on 8787 and anything else listening locally, so only host:port matches.
    const allowHosts = parseAllowedHosts("127.0.0.1:43127");
    expect(validateBrowserUrl("http://127.0.0.1:43127/artifact-preview/t/i.html", { allowHosts }).port).toBe("43127");
    expect(() => validateBrowserUrl("http://127.0.0.1:8787/v1/messages", { allowHosts })).toThrow(BrowserServiceError);
    expect(() => validateBrowserUrl("http://127.0.0.1/", { allowHosts })).toThrow(BrowserServiceError);
  });

  it("flags bot walls only when the page is short or the URL is unmistakable", () => {
    expect(detectBotWall("https://www.google.com/sorry/index?continue=x", "anything")).toBe(true);
    expect(detectBotWall("https://example.com/", "Please enable JavaScript and cookies to continue")).toBe(true);
    // Brave's real 429 body, verbatim — this is what a burst of queries actually gets back.
    expect(detectBotWall("https://search.brave.com/search?q=x", "Verifying you're not a bot\nQuick check before you continue searching.")).toBe(true);
    // ...and the same wall served to a zh-TW client, which is what Coterm actually receives.
    expect(detectBotWall("https://search.brave.com/search?q=x", "正在驗證您不是機器人\n在您繼續搜尋之前進行快速檢查。\n驗證\n切換至傳統 CAPTCHA")).toBe(true);
    // A long article that merely mentions the phrase is content, not a wall.
    expect(detectBotWall("https://example.com/", `unable to verify${"x".repeat(1600)}`)).toBe(false);
    expect(detectBotWall("https://example.com/", "real page content")).toBe(false);
  });

  it("keeps profile IDs path-safe and classifies sensitive actions", () => {
    expect(validateProfileId("default_1")).toBe("default_1");
    expect(() => validateProfileId("../escape")).toThrow(BrowserServiceError);
    expect(browserRisk("snapshot")).toBe(0);
    expect(browserRisk("fill", { role: "textbox", name: "Password" })).toBe(3);
    expect(browserRisk("upload")).toBe(2);
  });

  it("issue #48: blocks 127.0.0.1 by default but allows it under allow-private", () => {
    // Default (no options) = the safe status quo, including DNS-rebinding protection.
    expect(() => validateBrowserUrl("http://127.0.0.1:8787/x")).toThrow(BrowserServiceError);
    // The same URL passes once the user opts into allow-private.
    expect(validateBrowserUrl("http://127.0.0.1:8787/x", { allowPrivateNetwork: true }).hostname).toBe("127.0.0.1");
    // allow-hosts mode opens only the listed host:port, not all of loopback.
    const allowHosts = parseAllowedHosts("127.0.0.1:8787");
    expect(validateBrowserUrl("http://127.0.0.1:8787/x", { allowHosts }).port).toBe("8787");
    expect(() => validateBrowserUrl("http://127.0.0.1:4002/x", { allowHosts })).toThrow(BrowserServiceError);
  });
});

describe("workspace search", () => {
  it("supports extension, name, path, and free-text filters", async () => {
    await writeFile(join(root, "README.md"), "readme");
    await writeFile(join(root, "notes.txt"), "notes");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(root, "src")));
    await writeFile(join(root, "src", "main.ts"), "main");

    await expect(searchWorkspaceEntries({ root, query: "ext:ts" })).resolves.toEqual([
      expect.objectContaining({ name: "main.ts", relativePath: join("src", "main.ts"), type: "file" }),
    ]);
    await expect(searchWorkspaceEntries({ root, query: "name:read" })).resolves.toEqual([
      expect.objectContaining({ name: "README.md" }),
    ]);
    await expect(searchWorkspaceEntries({ root, query: "path:src" })).resolves.toEqual([
      expect.objectContaining({ relativePath: join("src", "main.ts") }),
    ]);
  });
});

const document: BrowserDocument = {
  version: 1,
  source: {
    url: "https://example.com/article",
    finalUrl: "https://example.com/article",
    title: "Example Article",
    fetchedAt: "2026-07-24T00:00:00.000Z",
    contentType: "text/html",
  },
  metadata: { description: "Example" },
  headings: [{ level: 1, text: "Example Article" }],
  paragraphs: [{ text: "A searchable browser document." }],
  lists: [],
  tables: [],
  text: "Example Article\nA searchable browser document.",
  links: [],
  images: [],
  forms: [],
};

describe("browser artifacts and MCP", () => {
  it("writes JSON and Markdown artifacts and indexes them", async () => {
    const store = new BrowserArtifactStore(root);
    const saved = await store.save({ projectId: "project-1", document, format: "markdown" });
    expect(saved.endsWith(".md")).toBe(true);
    await expect(readFile(saved, "utf8")).resolves.toContain("# Example Article");
    await expect(store.read(saved)).resolves.toContain("# Example Article");
    // Chunk-level FTS5 search: score is now an fts5 rank, so assert the hit and its
    // snippet/anchor rather than the old fixed 1/3 score. Close before asserting so a
    // failure cannot leave the SQLite handle open and break temp-dir cleanup.
    const hits = store.search({ projectId: "project-1", query: "searchable" });
    store.close();
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ title: "Example Article", url: document.source.finalUrl });
    expect(hits[0]?.snippet).toContain("searchable");
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  it("exposes tool and resource discovery without leaking page bodies", async () => {
    const browser = new BrowserRuntimeManager({ userDataPath: root, allowPrivateNetwork: true });
    const handler = createBrowserMcpHandler(browser);
    await expect(handler({ jsonrpc: "2.0", id: 1, method: "tools/list" })).resolves.toMatchObject({
      result: { tools: expect.arrayContaining([expect.objectContaining({ name: "coterm_browser_snapshot" })]) },
    });
    const listed = await handler({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const tools = (listed.result as { tools: Array<{ inputSchema: Record<string, unknown> }> }).tools;
    expect(tools.length).toBe(browserActionRegistry.length);
    expect(tools.every((tool) => tool.inputSchema.additionalProperties !== true)).toBe(true);
    expect(browserDiscoverySchema(browser.getLimits())).toMatchObject({
      endpoints: { schema: "/api/v1/agent/browser/schema" },
      capabilities: { evaluate: true, upload: true, download: true },
    });
    await expect(handler({ jsonrpc: "2.0", id: 2, method: "resources/read" })).resolves.toMatchObject({
      result: { contents: [{ text: "[]" }] },
    });
    await browser.dispose();
  });

  it("rejects unknown or malformed MCP actions with a typed error", async () => {
    const browser = new BrowserRuntimeManager({ userDataPath: root, allowPrivateNetwork: true });
    const handler = createBrowserMcpHandler(browser);
    await expect(handler({ id: 1, method: "tools/call", params: { name: "not_a_browser_tool", arguments: {} } })).resolves.toMatchObject({
      error: { data: { code: "invalid_input" } },
    });
    await expect(handler({ id: 2, method: "tools/call", params: { name: "coterm_browser_session_create", arguments: { mode: "invalid" } } })).resolves.toMatchObject({
      error: { data: { code: "invalid_input" } },
    });
    await browser.dispose();
  });

  it("keeps artifact paths inside the workspace", async () => {
    const store = new BrowserArtifactStore(root);
    const attempt = store.save({ projectId: "project-1", document, format: "text", destinationPath: join(root, "..", "outside") });
    await expect(attempt).rejects.toThrow("outside");
    store.close();
  });

  it("persists a screenshot to disk and registers it as an artifact (issue #18)", async () => {
    const saved: Array<{ path: string; pageUrl: string; title: string }> = [];
    const manager = new BrowserRuntimeManager({
      userDataPath: root,
      onScreenshotSaved: (artifact) => { saved.push(artifact); },
    });
    const session = await manager.createSession({ mode: "headless" });
    const pageId = session.pages[0]!.id;
    const dataUrl = await manager.screenshot(pageId, {});
    expect(typeof dataUrl).toBe("string");
    expect((dataUrl as string).startsWith("data:image/png;base64,")).toBe(true);
    // The callback fired exactly once with a real on-disk path.
    expect(saved).toHaveLength(1);
    expect(saved[0]!.path.endsWith(".png")).toBe(true);
    // The file actually landed on disk.
    await expect(readFile(saved[0]!.path)).resolves.toEqual(Buffer.from("fake-png-bytes"));
    await manager.dispose();
  });

  it("screenshot artifactOnly returns the on-disk path, never base64 (AT-135)", async () => {
    const manager = new BrowserRuntimeManager({ userDataPath: root });
    const session = await manager.createSession({ mode: "headless" });
    const pageId = session.pages[0]!.id;
    const result = await manager.screenshot(pageId, { artifactOnly: true });
    expect(result).toMatchObject({ bytes: Buffer.from("fake-png-bytes").byteLength });
    const { artifactPath } = result as { artifactPath: string; bytes: number };
    expect(artifactPath.endsWith(".png")).toBe(true);
    await expect(readFile(artifactPath)).resolves.toEqual(Buffer.from("fake-png-bytes"));
    await manager.dispose();
  });
});

describe("browser approvals and secrets", () => {
  it("auto-approves level 2 without touching the broker", async () => {
    const request = vi.fn();
    const broker = { request } as unknown as ApprovalBroker;
    const service = new BrowserApprovalService({ broker, approvalModeProvider: () => "auto" });
    await expect(service.request({ action: "upload", level: 2, sessionId: "session", pageId: "page", origin: "https://example.com" })).resolves.toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps level 3 human-gated even when auto mode is enabled", async () => {
    const prompt = vi.fn().mockResolvedValue(false);
    const service = new BrowserApprovalService({ approvalModeProvider: () => "auto", prompt });
    await expect(service.request({ action: "evaluate", level: 3, sessionId: "session", pageId: "page", origin: "https://example.com" })).resolves.toBe(false);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("denies high-risk standalone actions by default", async () => {
    const approvals = new BrowserApprovalService();
    await expect(approvals.request({ action: "upload", level: 2, sessionId: "session", pageId: "page", origin: "https://example.com" })).resolves.toBe(false);
    await expect(approvals.request({ action: "snapshot", level: 1, sessionId: "session", pageId: "page", origin: "https://example.com" })).resolves.toBe(true);
  });

  it("brokers browser approvals with an explicit browser context + display payload (AT-133)", async () => {
    const broker = new ApprovalBroker();
    const service = new BrowserApprovalService({ broker, timeoutMs: 60_000 });
    const signals: Array<{ kind: string; state: string; requestId: string; context: unknown; payload: unknown }> = [];
    broker.onSignal((s) => signals.push({ kind: s.kind, state: s.state, requestId: s.requestId, context: s.context, payload: s.payload }));

    const accepted = service.request({ action: "upload", level: 2, sessionId: "s1", pageId: "p1", origin: "https://example.com", locatorStrategy: "css" });
    // The requestId + payload leave the broker here — this is what the renderer
    // approval dialog needs to display and resolve the request.
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      kind: "approval",
      state: "pending",
      context: { kind: "browser", origin: "https://example.com", sessionId: "s1", pageId: "p1" },
      payload: { action: "upload", level: 2, origin: "https://example.com", locatorStrategy: "css" },
    });
    broker.resolve(signals[0]!.requestId, "accept");
    await expect(accepted).resolves.toBe(true);

    const declined = service.request({ action: "evaluate", level: 3, sessionId: "s1", pageId: "p1", origin: "https://example.com", previewScript: "document.title", previewTruncated: false });
    // The evaluate script preview rides the payload so the dialog never approves blind.
    expect(signals.at(-1)).toMatchObject({ state: "pending", payload: { action: "evaluate", level: 3, previewScript: "document.title", previewTruncated: false } });
    broker.resolve(signals.at(-1)!.requestId, "decline");
    await expect(declined).resolves.toBe(false);
  });

  it("uses opaque, one-shot secret handles", () => {
    const vault = new BrowserSecretVault();
    const ref = vault.issue("not-for-logs");
    expect(ref).toMatch(/^secret:\/\//);
    expect(vault.consume(ref)).toBe("not-for-logs");
    expect(() => vault.resolve(ref)).toThrow("unavailable");
  });
});

// Issue #93: the human is asked once per browser SESSION, not once per action.
describe("browser session-wide approval (issue #93)", () => {
  /**
   * A broker-backed approval service plus a pump for pending requests. The
   * pending signal fires asynchronously (the request goes through an await), so
   * a helper that reads a signal list synchronously would resolve nothing and
   * hang — this waits for the pending request to actually arrive.
   */
  function decisionService() {
    const broker = new ApprovalBroker();
    const autoApproved: string[] = [];
    const grants: string[] = [];
    const pending: string[] = [];
    const waiters: (() => void)[] = [];
    broker.onSignal((signal) => {
      if (signal.state !== "pending") return;
      pending.push(signal.requestId);
      waiters.splice(0).forEach((wake) => wake());
    });
    const service = new BrowserApprovalService({
      broker,
      timeoutMs: 60_000,
      onAutoApprove: (request) => autoApproved.push(request.action),
      onGrant: (sessionId) => grants.push(sessionId),
    });
    /** Resolve the next brokered request once it is pending. */
    async function answer(decision: "accept" | "acceptForSession" | "decline"): Promise<void> {
      while (pending.length === 0) await new Promise<void>((resolve) => waiters.push(resolve));
      broker.resolve(pending.shift()!, decision);
    }
    return { service, autoApproved, grants, answer, pendingCount: () => pending.length };
  }

  const REQUEST = { action: "upload", level: 2 as const, sessionId: "s1", pageId: "p1", origin: "https://example.com" };

  it("acceptForSession grants the session, so later level-3 actions skip the dialog", async () => {
    const { service, autoApproved, grants, answer } = decisionService();
    const first = service.request(REQUEST);
    await answer("acceptForSession");
    await expect(first).resolves.toBe(true);
    expect(grants).toEqual(["s1"]);
    expect(service.isSessionGranted("s1")).toBe(true);

    // Level 3 — the most dangerous tier — now runs with NO broker round-trip.
    await expect(service.request({ ...REQUEST, action: "evaluate", level: 3 })).resolves.toBe(true);
    expect(autoApproved).toEqual(["evaluate"]);
  });

  it("a plain accept does NOT grant the session — the next action asks again", async () => {
    const { service, answer } = decisionService();
    const first = service.request(REQUEST);
    await answer("accept");
    await expect(first).resolves.toBe(true);
    expect(service.isSessionGranted("s1")).toBe(false);

    // No grant => the second request goes back to the broker.
    const second = service.request(REQUEST);
    await answer("decline");
    await expect(second).resolves.toBe(false);
  });

  it("the grant is scoped to ONE session — a different session still asks", async () => {
    const { service, answer } = decisionService();
    const first = service.request(REQUEST);
    await answer("acceptForSession");
    await expect(first).resolves.toBe(true);

    const other = service.request({ ...REQUEST, sessionId: "s2" });
    await answer("decline");
    await expect(other).resolves.toBe(false);
    expect(service.isSessionGranted("s2")).toBe(false);
  });

  it("revoking a session (its close) restores the prompt", async () => {
    const { service, answer } = decisionService();
    const first = service.request(REQUEST);
    await answer("acceptForSession");
    await expect(first).resolves.toBe(true);

    service.revokeSession("s1");
    expect(service.isSessionGranted("s1")).toBe(false);
    const after = service.request(REQUEST);
    await answer("decline");
    await expect(after).resolves.toBe(false);
  });

  it("a session grant outranks the dialog even when approval mode is ask", async () => {
    // The grant is checked BEFORE the mode/provider branch, so no setting can
    // re-prompt a session the human already waved through.
    const prompt = vi.fn().mockResolvedValue(false);
    const service = new BrowserApprovalService({ prompt, approvalModeProvider: () => "ask" });
    service.grantSession("s1");
    await expect(service.request({ action: "evaluate", level: 3, sessionId: "s1", pageId: "p1", origin: "https://example.com" }))
      .resolves.toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });
});

describe("browser evaluate gate (AT-133)", () => {
  it("returns approval_denied when no approval wire is connected", async () => {
    const manager = new BrowserRuntimeManager({ userDataPath: root });
    const session = await manager.createSession({ mode: "headless" });
    await expect(manager.evaluate({ pageId: session.pages[0]!.id, script: "1+1" })).rejects.toMatchObject({ code: "approval_denied" });
    await manager.dispose();
  });

  it("returns approval_denied when the approver says no, runs when it says yes", async () => {
    const denier = new BrowserRuntimeManager({ userDataPath: root, requestApproval: () => Promise.resolve(false) });
    const denied = await denier.createSession({ mode: "headless" });
    await expect(denier.evaluate({ pageId: denied.pages[0]!.id, script: "1+1" })).rejects.toMatchObject({ code: "approval_denied" });
    await denier.dispose();

    const seen: Array<{ action: string; level: number; origin: string }> = [];
    const manager = new BrowserRuntimeManager({
      userDataPath: root,
      requestApproval: (request) => {
        seen.push({ action: request.action, level: request.level, origin: request.origin });
        return Promise.resolve(true);
      },
    });
    const session = await manager.createSession({ mode: "headless" });
    // Risk 3, exactly once — and the (mocked) page result survives the JSON round-trip.
    const result = await manager.evaluate({ pageId: session.pages[0]!.id, script: "({ ok: true })" });
    // new URL("about:blank").origin === "null" — opaque origins string-ify to that.
    expect(seen).toEqual([{ action: "evaluate", level: 3, origin: "null" }]);
    expect(result).toMatchObject({ version: 1 });
    await manager.dispose();
  });

  it("carries a bounded script preview to the approver and flags truncation", async () => {
    const seen: Array<{ previewScript?: string; previewTruncated?: boolean }> = [];
    const manager = new BrowserRuntimeManager({
      userDataPath: root,
      requestApproval: (request) => {
        seen.push({ ...(request.previewScript !== undefined ? { previewScript: request.previewScript } : {}), ...(request.previewTruncated !== undefined ? { previewTruncated: request.previewTruncated } : {}) });
        return Promise.resolve(true);
      },
    });
    const session = await manager.createSession({ mode: "headless" });
    const shortScript = "1+1";
    await manager.evaluate({ pageId: session.pages[0]!.id, script: shortScript });
    expect(seen.at(-1)).toEqual({ previewScript: "1+1", previewTruncated: false });
    const longScript = `"${"x".repeat(2_000)}"`;
    await manager.evaluate({ pageId: session.pages[0]!.id, script: longScript });
    const preview = seen.at(-1)!;
    expect(preview.previewTruncated).toBe(true);
    expect(preview.previewScript).toBe(longScript.slice(0, 500));
    await manager.dispose();
  });

  it("origin TOCTOU: a page that navigates during approval never runs the script (policy_denied)", async () => {
    const manager = new BrowserRuntimeManager({
      userDataPath: root,
      // Simulate a redirect landing DURING the human's decision window.
      requestApproval: () => { pageState.url = "https://evil.example/"; return Promise.resolve(true); },
    });
    const session = await manager.createSession({ mode: "headless" });
    await expect(manager.evaluate({ pageId: session.pages[0]!.id, script: "1+1" })).rejects.toMatchObject({
      code: "policy_denied",
      message: expect.stringContaining("origin changed"),
    });
    await manager.dispose();
  });

  it("refuses oversized scripts before approval is even asked", async () => {
    const asked = { count: 0 };
    const manager = new BrowserRuntimeManager({
      userDataPath: root,
      requestApproval: () => { asked.count += 1; return Promise.resolve(true); },
    });
    const session = await manager.createSession({ mode: "headless" });
    await expect(manager.evaluate({ pageId: session.pages[0]!.id, script: "x".repeat(EVALUATE_SCRIPT_MAX_CHARS + 1) })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(manager.evaluate({ pageId: session.pages[0]!.id, script: "" })).rejects.toMatchObject({ code: "invalid_input" });
    expect(asked.count).toBe(0);
    await manager.dispose();
  });

  it("registers evaluate as risk 3 per-request and dispatches it end to end", async () => {
    const entry = browserActionRegistry.find((action) => action.id === "page.evaluate");
    expect(entry).toMatchObject({ httpName: "evaluate", mutability: "mutation", risk: 3, approval: "per-request" });
    // The schema gate is the first line of defence: no pageId format violation or
    // overlong script ever reaches the runtime.
    expect(() => entry!.schema.parse({ pageId: "not-a-uuid", script: "1+1" })).toThrow();
    expect(() => entry!.schema.parse({ pageId: randomUUID(), script: "x".repeat(EVALUATE_SCRIPT_MAX_CHARS + 1) })).toThrow();

    const manager = new BrowserRuntimeManager({ userDataPath: root, requestApproval: () => Promise.resolve(true) });
    const session = await manager.createSession({ mode: "headless" });
    await expect(
      dispatchBrowserAction(manager, "evaluate", { pageId: session.pages[0]!.id, script: "1+1" }, "http"),
    ).resolves.toMatchObject({ version: 1 });
    await manager.dispose();
  });

  it("lists evaluate in the discovery schema with its risk + approval contract", async () => {
    const browser = new BrowserRuntimeManager({ userDataPath: root });
    const schema = browserDiscoverySchema(browser.getLimits());
    const actions = schema.actions as Array<{ id: string; httpName: string; risk: number; approval: string }>;
    expect(actions.find((action) => action.id === "page.evaluate")).toMatchObject({
      httpName: "evaluate",
      risk: 3,
      approval: "per-request",
    });
    await browser.dispose();
  });
});

describe("browser session concurrency", () => {
  it("shares one browser across concurrent sessions and honours the page cap", async () => {
    launches.count = 0;
    const manager = new BrowserRuntimeManager({ userDataPath: root, maxSessions: 12, maxPagesPerSession: 2, maxTotalPages: 12 });
    const created = await Promise.all(Array.from({ length: 6 }, () => manager.createSession({ mode: "headless" })));

    expect(created).toHaveLength(6);
    expect(manager.listSessions()).toHaveLength(6);
    // The whole point of T1: six parallel agents, one Chromium process.
    expect(launches.count).toBe(1);
    // One page each: proves the reservation counter released correctly, otherwise later
    // creates would have blocked on a phantom page budget until the lease timeout.
    expect(manager.listSessions().reduce((n, s) => n + s.pages.length, 0)).toBe(6);

    await manager.dispose();
    expect(manager.listSessions()).toHaveLength(0);
  });

  it("only previews .html inside an approved root", async () => {
    const approved = join(root, "site");
    await mkdir(approved, { recursive: true });
    await writeFile(join(approved, "scene.html"), "<html></html>", "utf8");
    await writeFile(join(root, "secret.txt"), "nope", "utf8");
    const manager = new BrowserRuntimeManager({ userDataPath: root, loopbackPort: () => 43127, previewRoots: () => [approved] });

    const { url } = await manager.previewLocalFile({ path: join(approved, "scene.html") });
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:43127\/artifact-preview\/[0-9a-f-]{36}\/scene\.html$/);

    // Escaping the root, and non-HTML inside it, both have to fail — the route serves a whole
    // directory, so a bad path here would expose that directory over loopback for ten minutes.
    await expect(manager.previewLocalFile({ path: join(approved, "..", "secret.txt") })).rejects.toThrow();
    await expect(manager.previewLocalFile({ path: join(approved, "scene.html.txt") })).rejects.toThrow();
    await manager.dispose();
  });

  it("refuses to preview when no root is approved", async () => {
    const manager = new BrowserRuntimeManager({ userDataPath: root, loopbackPort: () => 43127 });
    await expect(manager.previewLocalFile({ path: join(root, "x.html") })).rejects.toThrow(BrowserServiceError);
    await manager.dispose();
  });

  it("always collects links for the index but keeps them out of the reply", async () => {
    lastEvaluate.includeLinks = false;
    const manager = new BrowserRuntimeManager({ userDataPath: root });
    const session = await manager.createSession({ mode: "headless" });
    const pageId = session.pages[0]!.id;

    const quiet = (await manager.extractPage({ pageId, format: "json" })) as { document: BrowserDocument };
    // Without this the links table stays empty and `related` silently returns nothing.
    expect(lastEvaluate.includeLinks).toBe(true);
    expect(quiet.document.links).toHaveLength(0);

    const loud = (await manager.extractPage({ pageId, format: "json", includeLinks: true })) as { document: BrowserDocument };
    expect(loud.document.links).toHaveLength(1);

    await manager.dispose();
  });

  it("issue #48: policyProvider flips private-network access without a relaunch", async () => {
    // The provider is read on every navigation, so a Settings toggle takes effect live.
    let allowPrivate = false;
    const manager = new BrowserRuntimeManager({
      userDataPath: root,
      policyProvider: () => ({ allowPrivateNetwork: allowPrivate }),
    });
    const session = await manager.createSession({ mode: "headless" });
    const pageId = session.pages[0]!.id;

    // Default (block): localhost navigation is denied before page.goto runs.
    await expect(manager.navigate(pageId, "http://127.0.0.1:8787/x")).rejects.toThrow(BrowserServiceError);

    // Flip the live provider to allow-private: the same URL now navigates.
    allowPrivate = true;
    await expect(manager.navigate(pageId, "http://127.0.0.1:8787/x")).resolves.toMatchObject({ id: pageId });

    await manager.dispose();
  });
});

// No-rot guards (AT-134): the discovery payload must be generated from its
// declarative sources — a hand-copied literal here silently rots the contract
// agents discover at runtime.
describe("browser discovery schema — no-rot guards", () => {
  it("publishes errorCodes from the browserActionErrorCodes const array, verbatim and in order", () => {
    const browser = new BrowserRuntimeManager({ userDataPath: root });
    const schema = browserDiscoverySchema(browser.getLimits());
    expect(schema.errorCodes).toEqual([...browserActionErrorCodes]);
    expect(schema.errorCodes).toContain("busy");
    expect(schema.errorCodes).toContain("captcha_wall");
    return browser.dispose();
  });

  it("derives locatorStrategies from browserLocatorSchema.options", () => {
    const derived = browserLocatorSchema.options.map(
      (option) => (option.shape.strategy as { value: string }).value,
    );
    const browser = new BrowserRuntimeManager({ userDataPath: root });
    const schema = browserDiscoverySchema(browser.getLimits());
    expect(schema.locatorStrategies).toEqual(derived);
    return browser.dispose();
  });

  it("injects live runtime limits (defaults and overrides), never hard-coded values", () => {
    const defaults = new BrowserRuntimeManager({ userDataPath: root });
    expect(defaults.getLimits()).toEqual({
      maxSessions: 12,
      maxPagesPerSession: 4,
      maxTotalPages: 24,
      snapshotMaxChars: SNAPSHOT_MAX_CHARS_DEFAULT,
    });
    const schema = browserDiscoverySchema(defaults.getLimits());
    expect(schema.limits).toEqual(defaults.getLimits());

    const overridden = new BrowserRuntimeManager({ userDataPath: root, maxSessions: 3, maxPagesPerSession: 2 });
    expect(overridden.getLimits()).toMatchObject({ maxSessions: 3, maxPagesPerSession: 2, maxTotalPages: 24 });
    expect(browserDiscoverySchema(overridden.getLimits()).limits).toEqual(overridden.getLimits());
    return Promise.all([defaults.dispose(), overridden.dispose()]).then(() => undefined);
  });

  it("advertises the schema version, the endpoint table, rate-limit reality, and the log-schema cross-link", () => {
    const browser = new BrowserRuntimeManager({ userDataPath: root });
    const schema = browserDiscoverySchema(browser.getLimits());
    expect(schema.schemaVersion).toBe("1.2");
    // Issue #93: the no-arguments call reports the built-in defaults, so the
    // published numbers never disagree with what the limiter actually enforces
    // when no live settings are supplied.
    expect((schema.rateLimits as { browserMutationsPerMinute: number }).browserMutationsPerMinute)
      .toBe(AGENT_RATE_LIMIT_DEFAULTS.browserPerMinute);
    // With live limits, the schema reports THOSE, not the defaults.
    const live = browserDiscoverySchema(browser.getLimits(), "1", undefined, { terminalPerMinute: 120, browserPerMinute: 90 });
    expect(live.rateLimits).toMatchObject({
      terminalMutationsPerMinute: 120,
      browserMutationsPerMinute: 90,
      mutationsPerMinute: 90,
    });
    const routes = (schema.endpoints as { routes: Array<{ method: string; path: string }> }).routes;
    expect(routes).toHaveLength(6);
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /api/v1/agent/browser/schema",
      "GET /api/v1/agent/browser/sessions",
      "POST /api/v1/agent/browser/session",
      "POST /api/v1/agent/browser/page",
      "POST /api/v1/agent/browser/action",
      "POST /api/v1/agent/mcp",
    ]);
    expect(schema.mcp).toMatchObject({ url: "/api/v1/agent/mcp" });
    // The published rate-limit contract must match reality (issue #93):
    // browser session/page create + mutation actions ride their OWN 30/min
    // per-client token bucket, separate from terminal mutations; their 429s
    // carry the remaining quota and a retryAfterMs; only read actions are
    // unthrottled.
    expect(schema.rateLimits).toEqual({
      terminalMutationsPerMinute: 30,
      browserMutationsPerMinute: 30,
      // Legacy single-number field: report the browser ceiling, the bucket the
      // actions in THIS schema draw on.
      mutationsPerMinute: 30,
      buckets: ["terminal", "browser"],
      mutationBucket: "two independent per-client token buckets: 'terminal' (terminal/workflow/worktree mutations) and 'browser' (browser session/page create + browser mutation actions)",
      bucketRefusal: "429/MCP error carries bucket, limit, remaining and retryAfterMs; retryAfterMs is the time to the NEXT token, not a window reset",
      disclosure: "X-RateLimit-Limit / X-RateLimit-Remaining / X-RateLimit-Policy on mutation responses",
      browserReadActions: "unthrottled",
      onLimited: "429 with body { ok: false, code: 'rate_limited', bucket, limit, remaining, retryAfterMs } and a Retry-After header — back off retryAfterMs, do not retry immediately",
    });
    expect(schema.logSchema).toBe("/api/v1/agent/schema");
    return browser.dispose();
  });
});

describe("phase 7 superpower gates, timeout enforcement, and error-code truth", () => {
  it("P0 actions are registry-tiered, and every tiered action rides the curated MCP subset (§15.2#12 parity)", () => {
    const p0 = browserActionRegistry.filter((action) => action.tier === "p0").map((action) => action.id).sort();
    expect(p0).toEqual(["page.batch", "page.hover", "page.networkLog", "page.scroll", "page.scrollIntoView", "page.snapshotDiff", "page.waitFor"].sort());
    for (const id of p0) expect(MCP_BROWSER_CORE_ACTION_IDS as readonly string[]).toContain(id);
    // B4 P1 membership (§12.2): every P1 action also rides the curated subset — no silent drift.
    const p1 = browserActionRegistry.filter((action) => action.tier === "p1").map((action) => action.id).sort();
    expect(p1).toEqual(["page.assert", "page.batchFill", "page.consoleLog", "page.dialog", "page.download", "page.elementScreenshot", "page.fetchToMarkdown"].sort());
    for (const id of p1) expect(MCP_BROWSER_CORE_ACTION_IDS as readonly string[]).toContain(id);
    // No silent drift: only p0/p1 tiers exist, everything else stays core.
    expect(browserActionRegistry.filter((action) => action.tier !== undefined && action.tier !== "p0" && action.tier !== "p1")).toEqual([]);
    const waitFor = browserActionRegistry.find((action) => action.id === "page.waitFor")!;
    expect(waitFor).toMatchObject({ httpName: "waitFor", mutability: "read", risk: 0, approval: "none" });
    // The registry budget must outlive the max caller timeout (60s), so the inner
    // typed timeout fires first and the race stays a backstop.
    expect(waitFor.timeoutMs).toBeGreaterThan(60_000);
  });

  it("flag-off dispatch fails closed for P0 over HTTP and MCP, core actions unaffected", async () => {
    const manager = new BrowserRuntimeManager({ userDataPath: root, superpowersProvider: () => ({ p0: false, p1: false }) });
    await expect(dispatchBrowserAction(manager, "waitFor", { pageId: randomUUID(), condition: "networkidle" }, "http")).rejects.toMatchObject({ code: "policy_denied" });
    await expect(dispatchBrowserAction(manager, "coterm_browser_wait_for", { pageId: randomUUID(), condition: "networkidle" }, "mcp")).rejects.toMatchObject({ code: "policy_denied" });
    // Core action still dispatches (empty session list — no Chromium needed).
    await expect(dispatchBrowserAction(manager, "listSessions", {}, "http")).resolves.toEqual([]);
    expect(manager.getFeatureFlags()).toEqual({ superpowersP0: false, superpowersP1: false });
    await manager.dispose();
  });

  it("flag-on P0 dispatch reaches the runtime (not the gate)", async () => {
    const manager = new BrowserRuntimeManager({ userDataPath: root, superpowersProvider: () => ({ p0: true, p1: true }) });
    await expect(dispatchBrowserAction(manager, "waitFor", { pageId: randomUUID(), condition: "networkidle" }, "http")).rejects.toMatchObject({ code: "not_found" });
    await manager.dispose();
  });

  it("registry timeoutMs is really enforced: a hung dispatch resolves as code timeout with timer cleanup", async () => {
    vi.useFakeTimers();
    try {
      const hung = { listSessions: () => new Promise(() => undefined) } as unknown as BrowserRuntimeManager;
      const pending = dispatchBrowserAction(hung, "listSessions", {}, "http");
      const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(5_001);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("error-code truth: download_blocked mapping, approval_timeout on broker timeout, approval_denied boolean-deny contract", async () => {
    expect(browserErrorCode(new Error("Page.goto: Download is starting"))).toBe("download_blocked");
    const broker = new ApprovalBroker();
    const service = new BrowserApprovalService({ broker, timeoutMs: 25 });
    await expect(service.request({ action: "upload", level: 2, sessionId: "s", pageId: "p", origin: "https://a.example" })).rejects.toMatchObject({ code: "approval_timeout" });
    const promptService = new BrowserApprovalService({ prompt: () => Promise.resolve(false) });
    await expect(promptService.request({ action: "upload", level: 2, sessionId: "s", pageId: "p", origin: "https://a.example" })).resolves.toBe(false);
  });

  it("waitFor schema: appear/disappear need target, text needs text, url needs url, timeout bounded 60s", () => {
    const pageId = randomUUID();
    expect(() => browserWaitForInputSchema.parse({ pageId, condition: "appear" })).toThrow();
    expect(() => browserWaitForInputSchema.parse({ pageId, condition: "text" })).toThrow();
    expect(() => browserWaitForInputSchema.parse({ pageId, condition: "url" })).toThrow();
    expect(browserWaitForInputSchema.parse({ pageId, condition: "networkidle" }).timeoutMs).toBe(15_000);
    expect(() => browserWaitForInputSchema.parse({ pageId, condition: "networkidle", timeoutMs: 120_000 })).toThrow();
  });

  it("discovery publishes live feature flags and network-ring bounds", async () => {
    const browser = new BrowserRuntimeManager({ userDataPath: root, superpowersProvider: () => ({ p0: false, p1: true }) });
    const schema = browserDiscoverySchema(browser.getLimits(), "1", browser.getFeatureFlags());
    expect(schema.featureFlags).toEqual({ superpowersP0: false, superpowersP1: true });
    expect(schema.networkLog).toMatchObject({ maxEntries: 50, maxTotalChars: 5 * 1024 * 1024, perBodyChars: 65_536 });
    const actions = schema.actions as Array<{ id: string; tier: string }>;
    expect(actions.find((action) => action.id === "page.waitFor")).toMatchObject({ tier: "p0" });
    expect(actions.find((action) => action.id === "page.extract")).toMatchObject({ tier: "core" });
    await browser.dispose();
  });

  it("URL query redaction strips values and fragments, never the keys", () => {
    expect(redactUrlQuery("https://a.example/x?api_key=secret123&q=hi#frag")).toBe("https://a.example/x?api_key=%5BREDACTED%5D&q=%5BREDACTED%5D");
    expect(redactUrlQuery("not a url at all")).toBe("not a url at all");
  });
});
