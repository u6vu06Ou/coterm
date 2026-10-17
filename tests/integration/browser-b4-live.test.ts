import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserRuntimeManager } from "../../src/main/browser/browser-runtime-manager";
import { BrowserSecretVault } from "../../src/main/browser/browser-secret-vault";
import { dispatchBrowserAction } from "../../src/main/browser/browser-action-registry";
import { BROWSER_DOWNLOAD_MAX_BYTES } from "../../src/shared/browser-schema";
import type { BrowserDownloadResult, BrowserSnapshot } from "../../src/shared/browser-types";

/**
 * Phase 7 B4 live fixture (work order §12.2/§12.3): REAL Chromium against a
 * loopback fixture server — no mocks for page behaviour. The manager opts into
 * allowPrivateNetwork here (a test-only override); a SECOND manager without
 * the override proves fetchToMarkdown stays SSRF-fail-closed in production
 * policy. SKIP with the real launch error when Chromium is unavailable.
 *
 * Gate: COTERM_BROWSER_LIVE_REQUIRED=1 turns the SKIP into a hard FAIL — a CI
 * lane that promises live browser coverage must not go green without Chromium.
 */

const BROWSER_LIVE_REQUIRED = process.env.COTERM_BROWSER_LIVE_REQUIRED === "1";

const FILE_BODY = "alpha beta gamma download-bytes 0123456789";

const PAGE_MAIN = `<!doctype html><html><head><title>B4 Main</title></head><body>
<h1>B4 Main</h1>
<button id="ask">Ask</button>
<button id="alert-btn">Alert</button>
<span id="dialog-state">none</span>
<a id="dl" href="/api/file.txt" download>Download file</a>
<a id="dl-evil" href="/api/file-evil.txt" download>Download evil</a>
<a id="dl-exe" href="/api/tool.exe" download>Download exe</a>
<a id="dl-big" href="/api/big.bin" download>Download big</a>
<input id="field" value="preset-value" aria-label="Preset field" />
<input id="pw" type="password" aria-label="Password" />
<button id="save-main">Save</button>
<div id="shadow-host"></div>
<iframe id="inner" src="/frame"></iframe>
<div role="status" aria-label="Shot target" id="shot-target" style="width:120px;height:60px;background:#123456;color:#fff">shot me</div>
<script>
document.getElementById("ask").addEventListener("click", () => {
  document.getElementById("dialog-state").textContent = window.confirm("Proceed with the demo?") ? "accepted" : "dismissed";
});
document.getElementById("alert-btn").addEventListener("click", () => { window.alert("heads up"); });
document.getElementById("save-main").addEventListener("click", () => {
  document.getElementById("save-main").textContent = "main-clicked";
});
const host = document.getElementById("shadow-host");
const root = host.attachShadow({ mode: "open" });
const shadowButton = document.createElement("button");
shadowButton.textContent = "Save";
shadowButton.addEventListener("click", () => { shadowButton.textContent = "shadow-clicked"; });
root.appendChild(shadowButton);
console.log("booted token gsk_superSECRET123abcd");
console.error("page warning apocalyptic");
setTimeout(() => { throw new Error("kaboom api_key=zztop999"); }, 100);
</script>
</body></html>`;

const PAGE_FRAME = `<!doctype html><html><head><title>B4 Frame</title></head><body>
<button id="save-frame">Save</button>
<script>
document.getElementById("save-frame").addEventListener("click", () => {
  document.getElementById("save-frame").textContent = "frame-clicked";
});
</script>
</body></html>`;

const PAGE_MARKDOWN = `<!doctype html><html><head><title>Markdown Fixture</title></head><body>
<h1>Heading One</h1>
<p>First paragraph with <strong>courage</strong>.</p>
<ul><li>alpha</li><li>beta</li></ul>
<p><a href="/page2">second page</a> and a <a href="https://external.example/x">link out</a>.</p>
<script>console.log("not visible in markdown");</script>
</body></html>`;

const PAGE_CAPTCHA = `<!doctype html><html><head><title>Hold on</title></head><body><p>verify you are human: captcha challenge below</p></body></html>`;

const BIG_HTML = `<!doctype html><html><head><title>Big HTML</title></head><body><div style="height:20000px">${"large content ".repeat(200)}</div></body></html>`;

describe("browser B4 superpowers live fixture (real Chromium + loopback)", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let root = "";
  let manager: BrowserRuntimeManager | undefined;
  let gatedManager: BrowserRuntimeManager | undefined;
  let vault: BrowserSecretVault | undefined;
  let chromiumError: unknown = null;
  const approvals: { action: string; level: number }[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (path === "/") { response.writeHead(200, { "content-type": "text/html" }); response.end(PAGE_MAIN); return; }
      if (path === "/frame") { response.writeHead(200, { "content-type": "text/html" }); response.end(PAGE_FRAME); return; }
      if (path === "/markdown") { response.writeHead(200, { "content-type": "text/html" }); response.end(PAGE_MARKDOWN); return; }
      if (path === "/captcha") { response.writeHead(200, { "content-type": "text/html" }); response.end(PAGE_CAPTCHA); return; }
      if (path === "/big.html") { response.writeHead(200, { "content-type": "text/html" }); response.end(BIG_HTML); return; }
      if (path === "/huge.html") { response.writeHead(200, { "content-type": "text/html" }); response.end(Buffer.alloc(2 * 1024 * 1024, 97)); return; }
      if (path === "/redir") { response.writeHead(302, { location: "/markdown" }); response.end(); return; }
      if (path === "/api/file.txt") { response.writeHead(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="hello.txt"' }); response.end(FILE_BODY); return; }
      if (path === "/api/file-evil.txt") { response.writeHead(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="..\\\\..\\\\evil.txt"' }); response.end("evil"); return; }
      if (path === "/api/tool.exe") { response.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="tool.exe"' }); response.end("MZ"); return; }
      if (path === "/api/big.bin") {
        const size = BROWSER_DOWNLOAD_MAX_BYTES + 1024;
        response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(size), "content-disposition": 'attachment; filename="big.bin"' });
        const chunk = Buffer.alloc(1024 * 1024, 65);
        for (let sent = 0; sent < size; sent += chunk.length) { response.write(chunk); if (size - sent < chunk.length) break; }
        response.end();
        return;
      }
      response.writeHead(404); response.end("nope");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    root = await mkdtemp(join(tmpdir(), "coterm-browser-b4-"));
    vault = new BrowserSecretVault();
    manager = new BrowserRuntimeManager({
      userDataPath: root,
      allowPrivateNetwork: true, // test-only override — production policy blocks 127.0.0.1
      requestApproval: (req) => { approvals.push({ action: req.action, level: req.level }); return Promise.resolve(true); },
      consumeSecret: (secretRef) => Promise.resolve(vault!.consume(secretRef)),
    });
    gatedManager = new BrowserRuntimeManager({ userDataPath: join(root, "gated"), requestApproval: () => Promise.resolve(true) });
    try {
      const probe = await manager.createSession({ mode: "headless" });
      await manager.closeSession(probe.id);
      const probe2 = await gatedManager.createSession({ mode: "headless" });
      await gatedManager.closeSession(probe2.id);
    } catch (error) {
      chromiumError = error;
      if (BROWSER_LIVE_REQUIRED) {
        throw new Error(
          "COTERM_BROWSER_LIVE_REQUIRED=1 but Chromium failed to launch — install it with `npx playwright install chromium` (or fix the AV block) instead of letting the suite go green on skips.",
          { cause: error },
        );
      }
      console.warn("[browser-b4-live] Chromium unavailable, skipping live tests:", error);
    }
  }, 120_000);

  afterAll(async () => {
    if (manager) await manager.dispose().catch(() => undefined);
    if (gatedManager) await gatedManager.dispose().catch(() => undefined);
    vault?.clear();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  function requireChromium(context: { skip: () => void }): void {
    if (chromiumError) context.skip();
  }

  async function openMain(): Promise<string> {
    const session = await manager!.createSession({ mode: "headless" });
    const page = await manager!.newPage(session.id, baseUrl);
    return page.id;
  }
  it("dialog: accept/dismiss answers a parked dialog with per-request approval; level 1 dismiss needs no prompt", { timeout: 120_000 }, async (context) => {
    requireChromium(context);
    const pageId = await openMain();
    approvals.length = 0;
    // accept path: dispatch the response first with a bounded wait, then trigger the dialog.
    const respond = dispatchBrowserAction(manager!, "dialog", { pageId, response: "accept", awaitMs: 5_000 }, "http");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await dispatchBrowserAction(manager!, "click", { pageId, target: { strategy: "css", selector: "#ask" } }, "http");
    const result = (await respond) as { kind: string; message: string; responded: string };
    expect(result).toMatchObject({ kind: "confirm", responded: "accept" });
    expect(result.message).toContain("Proceed with the demo");
    // level-2 approval was asked exactly once for the accept.
    expect(approvals.filter((entry) => entry.action === "dialog")).toEqual([{ action: "dialog", level: 2 }]);
    const state = (await dispatchBrowserAction(manager!, "assert", { pageId, kind: "text", text: "accepted" }, "http")) as { passed: boolean };
    expect(state.passed).toBe(true);
    // dismiss is level 1 (safe interaction) — one level-1 prompt, never the modal-wedging level-2 gate.
    approvals.length = 0;
    const respond2 = dispatchBrowserAction(manager!, "dialog", { pageId, response: "dismiss", awaitMs: 5_000 }, "http");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await dispatchBrowserAction(manager!, "click", { pageId, target: { strategy: "css", selector: "#ask" } }, "http");
    await respond2;
    expect(approvals.filter((entry) => entry.action === "dialog")).toEqual([{ action: "dialog", level: 1 }]);
    const state2 = (await dispatchBrowserAction(manager!, "assert", { pageId, kind: "text", text: "dismissed" }, "http")) as { passed: boolean };
    expect(state2.passed).toBe(true);
    // no dialog pending and no wait budget → typed not_found, never a hang.
    await expect(dispatchBrowserAction(manager!, "dialog", { pageId, response: "accept" }, "http")).rejects.toMatchObject({ code: "not_found" });
    // bounded wait with nothing coming → timeout, not a forever-hang.
    await expect(dispatchBrowserAction(manager!, "dialog", { pageId, response: "accept", awaitMs: 400 }, "http")).rejects.toMatchObject({ code: "timeout" });
  });

  it("dialog: alert auto-answer via parked round-trip; human denial denies (no bypass)", { timeout: 120_000 }, async (context) => {
    requireChromium(context);
    const denied = new BrowserRuntimeManager({ userDataPath: root, allowPrivateNetwork: true, requestApproval: (req) => Promise.resolve(!(req.action === "dialog" && req.level >= 2)) });
    try {
      const session = await denied.createSession({ mode: "headless" });
      const page = await denied.newPage(session.id, baseUrl);
      const deniedAccept = dispatchBrowserAction(denied, "dialog", { pageId: page.id, response: "accept", awaitMs: 5_000 }, "http");
      const deniedAssertion = expect(deniedAccept).rejects.toMatchObject({ code: expect.stringMatching(/approval_denied|policy_denied/) });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const click = dispatchBrowserAction(denied, "click", { pageId: page.id, target: { strategy: "css", selector: "#alert-btn" } }, "http");
      await deniedAssertion;
      // Denial is interpreted as a fail-closed dismiss, so the page unwedges
      // immediately and no parked dialog remains for a second caller.
      await expect(click).resolves.toBeDefined();
      await expect(dispatchBrowserAction(denied, "dialog", { pageId: page.id, response: "dismiss" }, "http")).rejects.toMatchObject({ code: "not_found" });
    } finally {
      await denied.dispose().catch(() => undefined);
    }
  });

  it("download: per-request approval, sanitized filename, containment, sha256 metadata — never raw content", { timeout: 180_000 }, async (context) => {
    requireChromium(context);
    const pageId = await openMain();
    approvals.length = 0;
    await dispatchBrowserAction(manager!, "click", { pageId, target: { strategy: "css", selector: "#dl" } }, "http");
    const result = (await dispatchBrowserAction(manager!, "download", { pageId, timeoutMs: 10_000 }, "http")) as BrowserDownloadResult;
    expect(approvals.filter((entry) => entry.action === "download")).toEqual([{ action: "download", level: 2 }]);
    expect(result.fileName).toBe("hello.txt");
    expect(result.bytes).toBe(Buffer.byteLength(FILE_BODY));
    expect(result.sha256).toBe(createHash("sha256").update(FILE_BODY).digest("hex"));
    // Containment: path must live under userDataPath\browser-cache\downloads and exist after the realpath check.
    expect(result.path.startsWith(dirname(join(root, "browser-cache")))).toBe(true);
    expect(result.path).toContain(join("browser-cache", "downloads"));
    await expect(stat(result.path)).resolves.toBeDefined();

    // Traversal: the server's ../../evil.txt never escapes the cache root.
    await dispatchBrowserAction(manager!, "click", { pageId, target: { strategy: "css", selector: "#dl-evil" } }, "http");
    const evil = (await dispatchBrowserAction(manager!, "download", { pageId, timeoutMs: 10_000 }, "http")) as BrowserDownloadResult;
    expect(evil.fileName).not.toContain("..");
    expect(evil.path).toContain(join("browser-cache", "downloads"));

    // Type cap: executable extension fails closed; nothing is written.
    await dispatchBrowserAction(manager!, "click", { pageId, target: { strategy: "css", selector: "#dl-exe" } }, "http");
    await expect(dispatchBrowserAction(manager!, "download", { pageId, timeoutMs: 10_000 }, "http")).rejects.toMatchObject({ code: "permission_denied" });

    // Size cap: >64MiB declared body is saved-then-rejected (cap verified), file removed, typed permission_denied.
    await dispatchBrowserAction(manager!, "click", { pageId, target: { strategy: "css", selector: "#dl-big" } }, "http");
    await expect(dispatchBrowserAction(manager!, "download", { pageId, timeoutMs: 30_000 }, "http")).rejects.toMatchObject({ code: "permission_denied" });

    // Nothing pending → bounded wait → timeout, not a hang.
    await expect(dispatchBrowserAction(manager!, "download", { pageId, timeoutMs: 500 }, "http")).rejects.toMatchObject({ code: "timeout" });
  });

  it("fetchToMarkdown: SOP-free fetch, redirect re-validation, query redaction, size cap; SSRF fail closed without private-network override", { timeout: 120_000 }, async (context) => {
    requireChromium(context);
    const direct = (await dispatchBrowserAction(manager!, "fetchToMarkdown", { url: `${baseUrl}/markdown?api_key=sk-shouldneverleak123`, maxChars: 10_000 }, "http")) as { finalUrl: string; markdown: string; redirects: number; truncated: boolean };
    expect(direct.redirects).toBe(0);
    expect(direct.finalUrl).toContain("api_key=%5BREDACTED%5D");
    expect(direct.finalUrl).not.toContain("shouldneverleak");
    expect(direct.markdown).toContain("# Heading One");
    expect(direct.markdown).toContain("- alpha");
    expect(direct.markdown).toContain(`[second page](${baseUrl}/page2)`);
    expect(direct.markdown).not.toContain("not visible in markdown");
    const redirected = (await dispatchBrowserAction(manager!, "fetchToMarkdown", { url: `${baseUrl}/redir` }, "http")) as { redirects: number; status: number };
    expect(redirected).toMatchObject({ redirects: 1, status: 200 });
    const big = (await dispatchBrowserAction(manager!, "fetchToMarkdown", { url: `${baseUrl}/big.html`, maxChars: 100 }, "http")) as { markdown: string; truncated: boolean };
    expect(big.truncated).toBe(true);
    expect(big.markdown.length).toBeLessThanOrEqual(100);
    // SSRF: the production-policy manager has no loopback override.
    await expect(dispatchBrowserAction(gatedManager!, "fetchToMarkdown", { url: baseUrl }, "http")).rejects.toMatchObject({ code: "policy_denied" });
  });

  it("console + pageerror ring: bounded, redacted at capture, read-only", { timeout: 120_000 }, async (context) => {
    requireChromium(context);
    const pageId = await openMain();
    await new Promise((resolve) => setTimeout(resolve, 600)); // window for the pageerror setTimeout
    const log = (await dispatchBrowserAction(manager!, "consoleLog", { pageId }, "http")) as { entries: { source: string; level: string; text?: string }[]; dropped: number; limits: { maxEntries: number } };
    expect(log.limits.maxEntries).toBe(100);
    const booted = log.entries.find((entry) => entry.text?.includes("booted token"));
    expect(booted, "console.log must be captured").toBeDefined();
    expect(booted!.text).not.toContain("gsk_superSECRET");
    expect(booted!.text).toContain("[REDACTED]");
    const errorsOnly = (await dispatchBrowserAction(manager!, "consoleLog", { pageId, source: "pageerror" }, "http")) as { entries: { source: string; text?: string }[] };
    expect(errorsOnly.entries.length).toBeGreaterThanOrEqual(1);
    expect(errorsOnly.entries.every((entry) => entry.source === "pageerror")).toBe(true);
    expect(errorsOnly.entries[0]!.text ?? "").not.toContain("zztop999");
    expect(errorsOnly.entries[0]!.text ?? "").toContain("[REDACTED]");
  });

  it("assert: typed text/url/visible/value results; stale ref fails closed", { timeout: 120_000 }, async (context) => {
    requireChromium(context);
    const pageId = await openMain();
    const urlOk = (await dispatchBrowserAction(manager!, "assert", { pageId, kind: "url", url: "127.0.0.1" }, "http")) as { passed: boolean; url: string };
    expect(urlOk.passed).toBe(true);
    const urlBad = (await dispatchBrowserAction(manager!, "assert", { pageId, kind: "url", url: "example.com" }, "http")) as { passed: boolean };
    expect(urlBad.passed).toBe(false);
    expect((await dispatchBrowserAction(manager!, "assert", { pageId, kind: "text", text: "B4 Main" }, "http"))).toMatchObject({ passed: true });
    expect((await dispatchBrowserAction(manager!, "assert", { pageId, kind: "text", text: "never on the page" }, "http"))).toMatchObject({ passed: false });
    const snapshot = (await dispatchBrowserAction(manager!, "snapshot", { pageId }, "http")) as BrowserSnapshot;
    const field = Object.values(snapshot.refs).find((ref) => ref.text === "preset-value" || ref.name === "Preset field");
    expect(field, "input ref must exist").toBeDefined();
    expect((await dispatchBrowserAction(manager!, "assert", { pageId, kind: "value", target: { strategy: "ref", snapshotId: snapshot.snapshotId, ref: field!.ref }, expected: "preset-value" }, "http"))).toMatchObject({ passed: true });
    expect((await dispatchBrowserAction(manager!, "assert", { pageId, kind: "visible", target: { strategy: "ref", snapshotId: snapshot.snapshotId, ref: field!.ref } }, "http"))).toMatchObject({ passed: true });
    // Stale ref: a navigation supersedes it; the same ref must not guess.
    await dispatchBrowserAction(manager!, "navigate", { pageId, url: `${baseUrl}/markdown` }, "http");
    await expect(dispatchBrowserAction(manager!, "assert", { pageId, kind: "visible", target: { strategy: "ref", snapshotId: snapshot.snapshotId, ref: field!.ref } }, "http")).rejects.toMatchObject({ code: "stale_snapshot" });
  });

  it("elementScreenshot: ref-only, artifact metadata only", { timeout: 120_000 }, async (context) => {
    requireChromium(context);
    const pageId = await openMain();
    const snapshot = (await dispatchBrowserAction(manager!, "snapshot", { pageId }, "http")) as BrowserSnapshot;
    const target = Object.values(snapshot.refs).find((ref) => ref.text === "shot me");
    expect(target, "shot-target ref must exist").toBeDefined();
    const shot = (await dispatchBrowserAction(manager!, "elementScreenshot", { pageId, target: { strategy: "ref", snapshotId: snapshot.snapshotId, ref: target!.ref } }, "http")) as { artifactPath: string; bytes: number };
    expect(shot.artifactPath.endsWith(".png")).toBe(true);
    expect(shot.bytes).toBeGreaterThan(0);
    await expect(stat(shot.artifactPath)).resolves.toBeDefined();
    expect(Object.keys(shot).sort()).toEqual(["artifactPath", "bytes"]);
  });

  it("screenshot P2 hardening: jpeg/quality options, byte+pixel ceilings, never dataUrl over artifactOnly", { timeout: 120_000 }, async (context) => {
    requireChromium(context);
    const pageId = await openMain();
    const jpeg = (await dispatchBrowserAction(manager!, "screenshot", { pageId, artifactOnly: true, format: "jpeg", quality: 50 }, "http")) as { artifactPath: string };
    expect(jpeg.artifactPath.endsWith(".jpeg")).toBe(true);
    await expect(dispatchBrowserAction(manager!, "screenshot", { pageId, format: "png", quality: 50 }, "http")).rejects.toThrow(/quality/);
    await dispatchBrowserAction(manager!, "navigate", { pageId, url: `${baseUrl}/big.html` }, "http");
    await expect(dispatchBrowserAction(manager!, "screenshot", { pageId, fullPage: true, artifactOnly: true }, "http")).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("shadow + iframe identity: same label on both sides, clicks never confuse", { timeout: 120_000 }, async (context) => {
    requireChromium(context);
    const pageId = await openMain();
    const snapshot = (await dispatchBrowserAction(manager!, "snapshot", { pageId }, "http")) as BrowserSnapshot;
    const mainButtons = Object.values(snapshot.refs).filter((ref) => ref.name === "Save");
    expect(mainButtons.length, "main + shadow + iframe Save buttons must all be visible refs").toBeGreaterThanOrEqual(3);
    const shadowRef = mainButtons.find((ref) => ref.locatorHint?.strategy === "css" && ref.locatorHint.selector.includes(">>"));
    const frameRefs = new Set(snapshot.frames.find((frame) => frame.frameId !== "main")?.refs ?? []);
    const iframeRef = mainButtons.find((ref) => frameRefs.has(ref.ref));
    const mainRef = mainButtons.find((ref) => ref !== shadowRef && ref !== iframeRef);
    expect(shadowRef, "shadow Save ref with composed css chain").toBeDefined();
    expect(iframeRef, "iframe Save ref").toBeDefined();
    expect(mainRef, "main Save ref").toBeDefined();
    await dispatchBrowserAction(manager!, "click", { pageId, target: { strategy: "ref", snapshotId: snapshot.snapshotId, ref: shadowRef!.ref } }, "http");
    let snap2 = (await dispatchBrowserAction(manager!, "snapshot", { pageId }, "http")) as BrowserSnapshot;
    expect(Object.values(snap2.refs).some((ref) => ref.text === "shadow-clicked")).toBe(true);
    expect(Object.values(snap2.refs).some((ref) => ref.text === "main-clicked")).toBe(false);
    expect(Object.values(snap2.refs).some((ref) => ref.text === "frame-clicked")).toBe(false);
    await dispatchBrowserAction(manager!, "click", { pageId, target: { strategy: "ref", snapshotId: snap2.snapshotId, ref: snap2.refs[iframeRef!.ref]!.ref } }, "http");
    snap2 = (await dispatchBrowserAction(manager!, "snapshot", { pageId }, "http")) as BrowserSnapshot;
    expect(Object.values(snap2.refs).some((ref) => ref.text === "frame-clicked")).toBe(true);
    expect(Object.values(snap2.refs).some((ref) => ref.text === "main-clicked")).toBe(false);
    await dispatchBrowserAction(manager!, "click", { pageId, target: { strategy: "ref", snapshotId: snap2.snapshotId, ref: snap2.refs[mainRef!.ref]!.ref } }, "http");
    snap2 = (await dispatchBrowserAction(manager!, "snapshot", { pageId }, "http")) as BrowserSnapshot;
    expect(Object.values(snap2.refs).some((ref) => ref.text === "main-clicked")).toBe(true);
  });

  it("captcha wall: flagged in snapshot + fetchToMarkdown, detection only — never bypassed", { timeout: 120_000 }, async (context) => {
    requireChromium(context);
    await expect(dispatchBrowserAction(manager!, "fetchToMarkdown", { url: `${baseUrl}/captcha` }, "http")).rejects.toMatchObject({ code: "captcha_wall" });
    const session = await manager!.createSession({ mode: "headless" });
    const captchaPage = await manager!.newPage(session.id, `${baseUrl}/captcha`);
    const wall = (await dispatchBrowserAction(manager!, "snapshot", { pageId: captchaPage.id }, "http")) as BrowserSnapshot;
    expect(wall.blocked).toBe(true);
    expect(wall.blockedReason).toBe("captcha_wall");
    const clean = (await dispatchBrowserAction(manager!, "snapshot", { pageId: await (async () => { const s = await manager!.createSession({ mode: "headless" }); return (await manager!.newPage(s.id, baseUrl)).id; })() }, "http")) as BrowserSnapshot;
    expect(clean.blocked).toBeUndefined();
  });

  it("batchFill: per-field approval (password stays level 3), one-time secret handle, no value in the result", { timeout: 120_000 }, async (context) => {
    requireChromium(context);
    const pageId = await openMain();
    approvals.length = 0;
    const handle = vault!.issue("hunter2-secret", 60_000);
    const snapshot = (await dispatchBrowserAction(manager!, "snapshot", { pageId }, "http")) as BrowserSnapshot;
    const fieldRef = Object.values(snapshot.refs).find((ref) => ref.name === "Preset field")!;
    const pwRef = Object.values(snapshot.refs).find((ref) => ref.name === "Password")!;
    const result = (await dispatchBrowserAction(manager!, "batchFill", {
      pageId,
      fields: [
        { target: { strategy: "ref", snapshotId: snapshot.snapshotId, ref: fieldRef.ref }, value: "typed-plain" },
        { target: { strategy: "ref", snapshotId: snapshot.snapshotId, ref: pwRef.ref }, secretRef: handle },
      ],
    }, "http")) as { ok: boolean; fields: unknown[] };
    expect(result.ok).toBe(true);
    expect(result.fields).toHaveLength(2);
    // Per-field approval: 2 prompts; the password-shaped one escalated to level 3.
    expect(approvals).toHaveLength(2);
    expect(approvals[1]).toMatchObject({ action: "fill", level: 3 });
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(JSON.stringify(result)).not.toContain("typed-plain");
    // Typed values landed.
    expect((await dispatchBrowserAction(manager!, "assert", { pageId, kind: "value", target: { strategy: "ref", snapshotId: snapshot.snapshotId, ref: fieldRef.ref }, expected: "typed-plain" }, "http"))).toMatchObject({ passed: true });
    expect((await dispatchBrowserAction(manager!, "assert", { pageId, kind: "value", target: { strategy: "ref", snapshotId: snapshot.snapshotId, ref: pwRef.ref }, expected: "hunter2-secret" }, "http"))).toMatchObject({ passed: true });
    // One-time handle: replaying the same handle fails with a typed secret_unavailable step.
    const replay = (await dispatchBrowserAction(manager!, "batchFill", { pageId, fields: [{ target: { strategy: "ref", snapshotId: snapshot.snapshotId, ref: pwRef.ref }, secretRef: handle }] }, "http")) as { ok: boolean; fields: { ok: boolean; code?: string }[] };
    expect(replay.ok).toBe(false);
    expect(replay.fields[0]).toMatchObject({ ok: false, code: "secret_unavailable" });
    // stopOnError=false keeps going past a failed field.
    const continued = (await dispatchBrowserAction(manager!, "batchFill", {
      pageId,
      stopOnError: false,
      fields: [
        { target: { strategy: "ref", snapshotId: snapshot.snapshotId, ref: pwRef.ref }, secretRef: handle },
        { target: { strategy: "ref", snapshotId: snapshot.snapshotId, ref: fieldRef.ref }, value: "after-failure" },
      ],
    }, "http")) as { ok: boolean; fields: { ok: boolean }[]; stoppedEarly: boolean };
    expect(continued.ok).toBe(false);
    expect(continued.stoppedEarly).toBe(false);
    expect(continued.fields.map((field) => field.ok)).toEqual([false, true]);
  });
});
