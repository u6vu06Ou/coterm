import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserRuntimeManager, NETWORK_BODY_MAX_CHARS } from "../../src/main/browser/browser-runtime-manager";
import { dispatchBrowserAction } from "../../src/main/browser/browser-action-registry";
import type { BrowserNetworkLogResult, BrowserSnapshot, BrowserSnapshotDiff } from "../../src/shared/browser-types";

/**
 * Phase 7 live fixture (work order §12.5): REAL Chromium against a loopback
 * fixture server — not a mock. The manager opts into allowPrivateNetwork here
 * (a test-only override) because production policy blocks 127.0.0.1 by default.
 *
 * If the Chromium binary is unavailable (AV block, missing download), every
 * test is explicitly marked SKIP with the real launch error. Returning early
 * would be a false PASS, so the tests use Vitest's runtime skip API.
 *
 * Gate: COTERM_BROWSER_LIVE_REQUIRED=1 turns the SKIP into a hard FAIL — a CI
 * lane that promises live browser coverage must not go green without Chromium.
 */

const BROWSER_LIVE_REQUIRED = process.env.COTERM_BROWSER_LIVE_REQUIRED === "1";

const BIG_TEXT = `B${"i".repeat(120_000)}g`;

const PAGE_ONE = `<!doctype html><html><head><title>Fixture One</title></head><body>
<h1>Fixture One</h1>
<button id="add">Add</button>
<span role="status" aria-label="clicks" id="count">0</span>
<p role="note" id="remove-me">remove me</p>
<div id="transient">vanish me</div>
<div style="height:3000px">spacer</div>
<div id="bottom-marker">bottom</div>
<script>
document.getElementById("add").addEventListener("click", () => {
  window.__n = (window.__n || 0) + 1;
  const p = document.createElement("p");
  p.className = "added";
  p.setAttribute("role", "note");
  p.textContent = "extra " + window.__n;
  document.body.appendChild(p);
  document.getElementById("count").textContent = String(window.__n);
  document.getElementById("remove-me")?.remove();
});
setTimeout(() => document.getElementById("transient")?.remove(), 500);
setTimeout(() => {
  const d = document.createElement("div");
  d.id = "late";
  d.textContent = "late text";
  document.body.appendChild(d);
}, 250);
fetch("/api/data.json?api_key=sk-testsecret12345678&keep=1").catch(() => undefined);
fetch("/api/chunked.json").catch(() => undefined);
</script>
</body></html>`;

const PAGE_TWO = `<!doctype html><html><head><title>Fixture Two</title></head><body>
<h1>Fixture Two</h1>
<script>fetch("/api/big.txt").catch(() => undefined);</script>
</body></html>`;

describe("browser superpowers live fixture (real Chromium + loopback)", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let root = "";
  let manager: BrowserRuntimeManager | undefined;
  let chromiumError: unknown = null;
  const sessionIds: string[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (path === "/") { response.writeHead(200, { "content-type": "text/html" }); response.end(PAGE_ONE); return; }
      if (path === "/page2") { response.writeHead(200, { "content-type": "text/html" }); response.end(PAGE_TWO); return; }
      if (path === "/api/data.json") { const payload = JSON.stringify({ ok: true, token: "gsk_abcdefghij123456" }); response.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) }); response.end(payload); return; }
      if (path === "/api/chunked.json") { response.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" }); response.write('{"bounded":'); response.end("true}"); return; }
      if (path === "/api/big.txt") { response.writeHead(200, { "content-type": "text/plain", "content-length": String(BIG_TEXT.length) }); response.end(BIG_TEXT); return; }
      response.writeHead(404); response.end("nope");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    root = await mkdtemp(join(tmpdir(), "coterm-browser-live-"));
    manager = new BrowserRuntimeManager({
      userDataPath: root,
      allowPrivateNetwork: true, // test-only override — production default blocks 127.0.0.1
      requestApproval: () => Promise.resolve(true),
    });
    // Availability probe: launch once through the manager so a missing/blocked
    // binary marks every test here skipped with the real error preserved.
    try {
      const probe = await manager.createSession({ mode: "headless" });
      sessionIds.push(probe.id);
      await manager.closeSession(probe.id);
    } catch (error) {
      chromiumError = error;
      if (BROWSER_LIVE_REQUIRED) {
        throw new Error(
          "COTERM_BROWSER_LIVE_REQUIRED=1 but Chromium failed to launch — install it with `npx playwright install chromium` (or fix the AV block) instead of letting the suite go green on skips.",
          { cause: error },
        );
      }
      console.warn("[browser-live] Chromium unavailable, skipping live tests:", error);
    }
  }, 120_000);

  afterAll(async () => {
    if (manager) await manager.dispose().catch(() => undefined);
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  function requireChromium(context: { skip: (note?: string) => unknown }): void {
    if (chromiumError !== null) {
      const detail = chromiumError instanceof Error
        ? chromiumError.message
        : typeof chromiumError === "string" ? chromiumError : "unknown launch error";
      context.skip(`Chromium unavailable: ${detail}`);
    }
  }

  async function openPageOne(): Promise<{ sessionId: string; pageId: string }> {
    const session = await manager!.createSession({ mode: "headless" });
    sessionIds.push(session.id);
    const pageId = session.pages[0]!.id;
    const nav = (await dispatchBrowserAction(manager!, "navigate", { pageId, url: `${baseUrl}/` }, "http")) as { id: string };
    return { sessionId: session.id, pageId: nav.id };
  }

  async function snapshot(pageId: string, includeBoundingBoxes = false): Promise<BrowserSnapshot> {
    return (await dispatchBrowserAction(manager!, "snapshot", { pageId, mode: "full", includeBoundingBoxes, maxChars: 100_000 }, "http")) as BrowserSnapshot;
  }

  function refByName(snap: BrowserSnapshot, name: string): string {
    const entry = Object.entries(snap.refs).find(([, value]) => value.name === name);
    if (!entry) throw new Error(`ref with name "${name}" not found in snapshot`);
    return entry[0];
  }

  it("P0 actions dispatch over the registry against a live page (click/hover/scroll/scrollIntoView)", { timeout: 120_000 }, async (context) => {
    requireChromium(context);
    const { pageId } = await openPageOne();
    const snap = await snapshot(pageId);
    const add = refByName(snap, "Add");
    await dispatchBrowserAction(manager!, "click", { pageId, target: { strategy: "ref", snapshotId: snap.snapshotId, ref: add }, returnSnapshot: false }, "http");
    const waited = (await dispatchBrowserAction(manager!, "waitFor", { pageId, condition: "text", text: "extra 1", exact: true }, "http")) as { satisfied: boolean };
    expect(waited.satisfied).toBe(true);
    const hovered = (await dispatchBrowserAction(manager!, "hover", { pageId, target: { strategy: "css", selector: "#add" }, returnSnapshot: false }, "http")) as { ok: boolean };
    expect(hovered.ok).toBe(true);
    const scrolled = (await dispatchBrowserAction(manager!, "scroll", { pageId, deltaY: 900 }, "http")) as { ok: boolean; scroll: { y: number } };
    expect(scrolled.scroll.y).toBeGreaterThan(0);
    const into = (await dispatchBrowserAction(manager!, "scrollIntoView", { pageId, target: { strategy: "css", selector: "#bottom-marker" }, returnSnapshot: false }, "http")) as { ok: boolean };
    expect(into.ok).toBe(true);
  });

  it("stale ref after navigation NEVER acts — old refs and old coordinates die with stale_snapshot", { timeout: 120_000 }, async (context) => {
    requireChromium(context);
    const { pageId } = await openPageOne();
    const snap = await snapshot(pageId, true);
    const add = refByName(snap, "Add");
    await dispatchBrowserAction(manager!, "navigate", { pageId, url: `${baseUrl}/page2` }, "http");
    await expect(
      dispatchBrowserAction(manager!, "click", { pageId, target: { strategy: "ref", snapshotId: snap.snapshotId, ref: add }, returnSnapshot: false }, "http"),
    ).rejects.toMatchObject({ code: "stale_snapshot" });
    await expect(
      dispatchBrowserAction(manager!, "clickCoordinates", { pageId, x: 10, y: 10, coordinateSpace: "viewport", snapshotId: snap.snapshotId, returnSnapshot: false }, "http"),
    ).rejects.toMatchObject({ code: "stale_snapshot" });
  });

  it("stale ref after a NEW snapshot (no navigation) dies with stale_snapshot", { timeout: 120_000 }, async (context) => {
    requireChromium(context);
    const { pageId } = await openPageOne();
    const first = await snapshot(pageId);
    const add = refByName(first, "Add");
    await snapshot(pageId); // supersedes the first snapshot (staleAfter: new_snapshot)
    await expect(
      dispatchBrowserAction(manager!, "click", { pageId, target: { strategy: "ref", snapshotId: first.snapshotId, ref: add }, returnSnapshot: false }, "http"),
    ).rejects.toMatchObject({ code: "stale_snapshot" });
  });

  it("snapshot diff: added/changed/removed refs are correct, diff is smaller than the full snapshot, stale baseline -> stale_snapshot", { timeout: 120_000 }, async (context) => {
    requireChromium(context);
    const { pageId } = await openPageOne();
    const baseline = await snapshot(pageId);
    const add = refByName(baseline, "Add");
    await dispatchBrowserAction(manager!, "click", { pageId, target: { strategy: "ref", snapshotId: baseline.snapshotId, ref: add }, returnSnapshot: false }, "http");
    const diff = (await dispatchBrowserAction(manager!, "snapshotDiff", { pageId, changedSinceSnapshotId: baseline.snapshotId }, "http")) as BrowserSnapshotDiff;
    expect(diff.kind).toBe("diff");
    expect(diff.baselineSnapshotId).toBe(baseline.snapshotId);
    // The appended <p role=note>extra 1</p> is a genuinely new element.
    expect(diff.added.length).toBeGreaterThanOrEqual(1);
    // The <span role=status aria-label=clicks> kept identity but changed text 0 -> 1.
    const counter = diff.changed.find((change) => change.changes.includes("text"));
    expect(counter, "counter ref must show a text change").toBeDefined();
    expect(diff.removed.length, "the removed note must appear in the diff").toBeGreaterThanOrEqual(1);
    // Diff result is materially smaller than a fresh full snapshot of the same page.
    const full = await dispatchBrowserAction(manager!, "snapshot", { pageId, mode: "full", includeBoundingBoxes: true, maxChars: 100_000 }, "http");
    expect(JSON.stringify(diff).length).toBeLessThan(JSON.stringify(full).length);
    // The baseline was superseded by the diff's fresh capture: reuse = stale.
    await expect(
      dispatchBrowserAction(manager!, "snapshotDiff", { pageId, changedSinceSnapshotId: baseline.snapshotId }, "http"),
    ).rejects.toMatchObject({ code: "stale_snapshot" });
  });

  it("waitFor: appear / disappear / text / url / networkidle all resolve; a miss is code timeout (bounded)", { timeout: 120_000 }, async (context) => {
    requireChromium(context);
    const { pageId } = await openPageOne();
    const appeared = (await dispatchBrowserAction(manager!, "waitFor", { pageId, condition: "appear", target: { strategy: "css", selector: "#late" } }, "http")) as { satisfied: boolean };
    expect(appeared.satisfied).toBe(true);
    const disappeared = (await dispatchBrowserAction(manager!, "waitFor", { pageId, condition: "disappear", target: { strategy: "css", selector: "#transient" } }, "http")) as { satisfied: boolean };
    expect(disappeared.satisfied).toBe(true);
    const text = (await dispatchBrowserAction(manager!, "waitFor", { pageId, condition: "text", text: "late text", exact: true }, "http")) as { satisfied: boolean };
    expect(text.satisfied).toBe(true);
    const idle = (await dispatchBrowserAction(manager!, "waitFor", { pageId, condition: "networkidle" }, "http")) as { satisfied: boolean };
    expect(idle.satisfied).toBe(true);
    // url condition: start waiting, then navigate — the waiter must resolve.
    const urlWait = dispatchBrowserAction(manager!, "waitFor", { pageId, condition: "url", url: "/page2" }, "http");
    await dispatchBrowserAction(manager!, "navigate", { pageId, url: `${baseUrl}/page2` }, "http");
    await expect(urlWait).resolves.toMatchObject({ satisfied: true, condition: "url" });
    // Bounded miss: 600ms, typed timeout — never a silent hang.
    await expect(
      dispatchBrowserAction(manager!, "waitFor", { pageId, condition: "appear", target: { strategy: "css", selector: "#never-exists" }, timeoutMs: 600 }, "http"),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("networkLog: bounded text/JSON bodies, query values redacted, no cookies/keys, truncation markers", { timeout: 120_000 }, async (context) => {
    requireChromium(context);
    const { pageId } = await openPageOne();
    await dispatchBrowserAction(manager!, "waitFor", { pageId, condition: "networkidle" }, "http");
    const log = (await dispatchBrowserAction(manager!, "networkLog", { pageId }, "http")) as BrowserNetworkLogResult;
    expect(log.limits).toMatchObject({ maxEntries: 50, maxTotalChars: 5 * 1024 * 1024, perBodyChars: NETWORK_BODY_MAX_CHARS });
    const data = log.entries.find((entry) => entry.url.includes("/api/data.json"));
    expect(data, "the fixture JSON response must be captured").toBeDefined();
    // Query redaction: values stripped (URL-encoded [REDACTED]), secret query value never present.
    expect(data!.url).toContain("api_key=%5BREDACTED%5D");
    expect(data!.url).not.toContain("testsecret");
    expect(data!.method).toBe("GET");
    expect(data!.status).toBe(200);
    // Body captured and egress-redacted at read: the gsk_ token in the body never leaks.
    expect(data!.bodyText).toContain('"ok":true');
    expect(data!.bodyText).not.toContain("gsk_");
    const chunked = log.entries.find((entry) => entry.url.includes("/api/chunked.json"));
    expect(chunked, "unknown-length bodies must retain metadata").toMatchObject({ truncated: true });
    expect(chunked!.bodyText, "unknown-length bodies are never read into memory").toBeUndefined();
    // Structural: entries carry no request headers or cookies at all.
    for (const entry of log.entries) {
      expect(Object.keys(entry).sort()).toEqual(["bodyText", "capturedAt", "contentType", "id", "method", "status", "truncated", "url"].filter((key) => key !== "bodyText" || entry.bodyText !== undefined).sort());
    }
    await dispatchBrowserAction(manager!, "navigate", { pageId, url: `${baseUrl}/page2` }, "http");
    await dispatchBrowserAction(manager!, "waitFor", { pageId, condition: "networkidle" }, "http");
    const log2 = (await dispatchBrowserAction(manager!, "networkLog", { pageId, urlContains: "big.txt" }, "http")) as BrowserNetworkLogResult;
    const big = log2.entries[0];
    expect(big).toBeDefined();
    expect(big!.truncated).toBe(true);
    expect(big!.bodyText!.length).toBeLessThanOrEqual(NETWORK_BODY_MAX_CHARS);
  });
});
