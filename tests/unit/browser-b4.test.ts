import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  browserAssertInputSchema, browserBatchFillInputSchema, browserConsoleInputSchema,
  browserDialogInputSchema, browserDownloadInputSchema, browserElementScreenshotInputSchema,
  browserFetchMarkdownInputSchema, BROWSER_BATCH_MAX_STEPS, BROWSER_FETCH_MARKDOWN_MAX_BYTES,
  BROWSER_CONSOLE_MAX_ENTRIES, BROWSER_DOWNLOAD_MAX_BYTES,
} from "../../src/shared/browser-schema";
import { browserActionRegistry, dispatchBrowserAction } from "../../src/main/browser/browser-action-registry";
import { BrowserServiceError } from "../../src/main/browser/browser-errors";
import type { BrowserRuntimeManager } from "../../src/main/browser/browser-runtime-manager";

const PAGE_ID = "11111111-1111-4111-8111-111111111111";

describe("B4 action schemas (work order §12.2/§12.3)", () => {
  it("batchFill: exactly one of value/secretRef; ≥1 and ≤20 fields; stopOnError default true", () => {
    const ref = { strategy: "ref", snapshotId: PAGE_ID, ref: "e1" } as const;
    expect(() => browserBatchFillInputSchema.parse({ pageId: PAGE_ID, fields: [{ target: ref }] })).toThrow(z.ZodError);
    expect(() => browserBatchFillInputSchema.parse({ pageId: PAGE_ID, fields: [{ target: ref, value: "a", secretRef: "secret://x" }] })).toThrow(z.ZodError);
    expect(() => browserBatchFillInputSchema.parse({ pageId: PAGE_ID, fields: [{ target: ref, secretRef: "not-a-handle" }] })).toThrow(z.ZodError);
    const ok = browserBatchFillInputSchema.parse({ pageId: PAGE_ID, fields: [{ target: ref, secretRef: "secret://good" }] });
    expect(ok.stopOnError).toBe(true);
    expect(ok.returnSnapshot).toBe(false);
    const many = Array.from({ length: BROWSER_BATCH_MAX_STEPS + 1 }, () => ({ target: ref, value: "x" }));
    expect(() => browserBatchFillInputSchema.parse({ pageId: PAGE_ID, fields: many })).toThrow(z.ZodError);
  });

  it("dialog: response enum, bounded awaitMs, promptText cap", () => {
    expect(() => browserDialogInputSchema.parse({ pageId: PAGE_ID, response: "hijack" })).toThrow(z.ZodError);
    expect(() => browserDialogInputSchema.parse({ pageId: PAGE_ID, response: "accept", awaitMs: 30_001 })).toThrow(z.ZodError);
    const parsed = browserDialogInputSchema.parse({ pageId: PAGE_ID, response: "prompt", promptText: "a".repeat(2_000), awaitMs: 1_000 });
    expect(parsed.promptText).toHaveLength(2_000);
    expect(() => browserDialogInputSchema.parse({ pageId: PAGE_ID, response: "prompt", promptText: "a".repeat(2_001) })).toThrow(z.ZodError);
    expect(parsed.awaitMs).toBe(1_000);
    expect(browserDialogInputSchema.parse({ pageId: PAGE_ID, response: "dismiss" }).awaitMs).toBe(0);
  });

  it("download: bounded timeout", () => {
    expect(BROWSER_DOWNLOAD_MAX_BYTES).toBe(64 * 1024 * 1024);
    expect(() => browserDownloadInputSchema.parse({ pageId: PAGE_ID, timeoutMs: 30_001 + 30_000 })).toThrow(z.ZodError);
    expect(browserDownloadInputSchema.parse({ pageId: PAGE_ID }).timeoutMs).toBe(10_000);
  });

  it("fetchToMarkdown: url required, bounded maxChars/timeout", () => {
    expect(BROWSER_FETCH_MARKDOWN_MAX_BYTES).toBe(1_048_576);
    expect(() => browserFetchMarkdownInputSchema.parse({ url: "ftp://example.com" })).toThrow(z.ZodError);
    expect(() => browserFetchMarkdownInputSchema.parse({ url: "https://example.com", maxChars: 100_001 })).toThrow(z.ZodError);
    expect(browserFetchMarkdownInputSchema.parse({ url: "https://example.com" }).maxChars).toBe(4_000);
  });

  it("elementScreenshot: ref-only target; jpeg quality pin", () => {
    expect(() => browserElementScreenshotInputSchema.parse({ pageId: PAGE_ID, target: { strategy: "css", selector: "#x" } })).toThrow(z.ZodError);
    expect(() => browserElementScreenshotInputSchema.parse({ pageId: PAGE_ID, target: { strategy: "ref", snapshotId: PAGE_ID, ref: "e1" }, format: "png", quality: 80 })).toThrow(z.ZodError);
    const ok = browserElementScreenshotInputSchema.parse({ pageId: PAGE_ID, target: { strategy: "ref", snapshotId: PAGE_ID, ref: "e1" }, format: "jpeg", quality: 80 });
    expect(ok.format).toBe("jpeg");
  });

  it("console + assert: caps and per-kind requirements", () => {
    expect(BROWSER_CONSOLE_MAX_ENTRIES).toBe(100);
    expect(() => browserConsoleInputSchema.parse({ pageId: PAGE_ID, limit: 101 })).toThrow(z.ZodError);
    expect(() => browserAssertInputSchema.parse({ pageId: PAGE_ID, kind: "text" })).toThrow(z.ZodError);
    expect(() => browserAssertInputSchema.parse({ pageId: PAGE_ID, kind: "visible" })).toThrow(z.ZodError);
    expect(() => browserAssertInputSchema.parse({ pageId: PAGE_ID, kind: "value", target: { strategy: "ref", snapshotId: PAGE_ID, ref: "e1" } })).toThrow(z.ZodError);
    const ok = browserAssertInputSchema.parse({ pageId: PAGE_ID, kind: "url", url: "https://example.com" });
    expect(ok.exact).toBe(false);
  });
});

describe("B4 registry actions (§12.1#6: same schema/risk/approval/timeout across transports)", () => {
  const ids = ["page.batchFill", "page.dialog", "page.download", "page.fetchToMarkdown", "page.elementScreenshot", "page.consoleLog", "page.assert"];
  it("each action is registered with http+mcp names, risk, approval, timeout and p1 tier", () => {
    for (const id of ids) {
      const definition = browserActionRegistry.find((item) => item.id === id);
      expect(definition, `missing ${id}`).toBeDefined();
      expect(definition!.tier).toBe("p1");
      expect(definition!.httpName).not.toBe("");
      expect(definition!.mcpName).toMatch(/^coterm_browser_/);
      expect(definition!.timeoutMs).toBeGreaterThan(0);
      expect(definition!.composite).toBeUndefined();
    }
    // approval matrix: dialog/download/batchFill are per-request (risk 2/3); reads stay level 0.
    const byId = (id: string) => browserActionRegistry.find((item) => item.id === id)!;
    expect(byId("page.dialog").risk).toBe(2);
    expect(byId("page.dialog").approval).toBe("per-request");
    expect(byId("page.download").risk).toBe(2);
    expect(byId("page.download").approval).toBe("per-request");
    expect(byId("page.batchFill").risk).toBe(3);
    expect(byId("page.batchFill").approval).toBe("per-request");
    for (const id of ["page.fetchToMarkdown", "page.elementScreenshot", "page.consoleLog", "page.assert"]) {
      expect(byId(id).approval).toBe("none");
    }
    expect(byId("page.fetchToMarkdown").mutability).toBe("mutation"); // network egress counts against the shared bucket
    expect(byId("page.consoleLog").mutability).toBe("read");
    expect(byId("page.assert").mutability).toBe("read");
    expect(byId("page.elementScreenshot").mutability).toBe("read");
  });

  it("P1 flag off → every B4 action fails closed (policy_denied) before any browser work", async () => {
    const browser = { superpowersEnabled: () => false } as unknown as BrowserRuntimeManager;
    const inputs: Record<string, Record<string, unknown>> = {
      batchFill: { pageId: PAGE_ID, fields: [{ target: { strategy: "ref", snapshotId: PAGE_ID, ref: "e1" }, value: "x" }] },
      dialog: { pageId: PAGE_ID, response: "accept" },
      download: { pageId: PAGE_ID },
      fetchToMarkdown: { url: "https://example.com" },
      elementScreenshot: { pageId: PAGE_ID, target: { strategy: "ref", snapshotId: PAGE_ID, ref: "e1" } },
      consoleLog: { pageId: PAGE_ID },
      assert: { pageId: PAGE_ID, kind: "url", url: "https://example.com" },
    };
    for (const [name, input] of Object.entries(inputs)) {
      await expect(dispatchBrowserAction(browser, name, input, "http")).rejects.toMatchObject({ code: "policy_denied" } satisfies Partial<BrowserServiceError>);
    }
  });
});
