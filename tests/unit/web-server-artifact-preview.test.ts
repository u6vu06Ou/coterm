import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWebServer, type RunningWebServer } from "../../src/main/web/web-server";
import { clearArtifactPreviewTokens, mintArtifactPreviewToken } from "../../src/main/web/artifact-preview-tokens";

/**
 * Artifact previews must run their own scripts (inline + CDN) and be iframeable
 * inside the artifact panel, so the route drops CSP and X-Frame-Options. Every
 * other route keeps the strict pair.
 */

let dir = "";
let server: RunningWebServer;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "coterm-preview-"));
  await writeFile(
    join(dir, "x.html"),
    "<!doctype html><html><body><script>window.__ran=1</script><div id=\"bottom\">tail</div></body></html>",
    "utf8",
  );
  await writeFile(join(dir, "index.html"), "<!doctype html><html><body>renderer</body></html>", "utf8");
  server = await startWebServer({
    port: 0,
    allowedOrigin: "http://127.0.0.1",
    verifyAccess: async () => ({ email: "test@example.com" }),
    operations: {} as never,
    rendererPath: dir,
  });
});

afterAll(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
  clearArtifactPreviewTokens();
});

describe("artifact preview headers", () => {
  it("serves the whole preview file without CSP or X-Frame-Options", async () => {
    const token = mintArtifactPreviewToken(dir);
    const response = await fetch(`http://127.0.0.1:${server.port}/artifact-preview/${token}/x.html`);
    expect(response.status).toBe(200);
    // Scripts run, but in an opaque origin: no script-src limits, sandbox on.
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/^sandbox /);
    expect(csp).toContain("allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).not.toContain("default-src");
    expect(response.headers.get("x-frame-options")).toBeNull();
    const body = await response.text();
    expect(body).toContain('<div id="bottom">');
  });

  it("keeps the strict CSP on other routes", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
  });
});
