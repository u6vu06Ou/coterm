// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { randomUUID } from "node:crypto";
import type { BrowserApprovalPrompt } from "../../src/renderer/src/store/app-store";

// Mock the app-store before importing the component — zustand singletons do not
// suit per-test state. The mock serves useAppStore() the mutable stub. NOTE:
// the real reduceBrowserApprovals lives in this module too, so pure-reducer
// tests live in browser-approvals.test.ts against the REAL store import.
const storeState: Record<string, unknown> = {
  browserApprovals: [],
  resolveApproval: () => Promise.resolve(),
};

vi.mock("../../src/renderer/src/store/app-store", () => ({
  // The component subscribes with selectors — the mock must apply them.
  useAppStore: Object.assign(
    (selector?: (state: Record<string, unknown>) => unknown) => (typeof selector === "function" ? selector(storeState) : storeState),
    { getState: () => storeState, setState: () => undefined },
  ),
}));

// Echo the key (so assertions verify which strings the dialog consumes) plus any
// interpolation vars.
vi.mock("../../src/renderer/src/i18n", () => ({
  useI18n: () => ({
    locale: "en-US",
    t: (key: string, vars?: Record<string, string | number>) => (vars ? key + JSON.stringify(vars) : key),
  }),
}));

describe("BrowserApprovalDialog", () => {
  it("renders nothing when no browser approval is pending", async () => {
    storeState.browserApprovals = [];
    const { BrowserApprovalDialog } = await import("../../src/renderer/src/components/BrowserApprovalDialog");
    expect(renderToStaticMarkup(React.createElement(BrowserApprovalDialog))).toBe("");
  });

  it("renders action, origin, risk, and the accept/decline pair for the oldest prompt", async () => {
    const prompt: BrowserApprovalPrompt = {
      requestId: randomUUID(),
      action: "evaluate",
      level: 3,
      origin: "https://viewer.example",
      locatorStrategy: null,
      sessionId: "s1",
      pageId: "p1",
      askedAt: "2026-08-02T00:00:00.000Z",
    };
    storeState.browserApprovals = [prompt];
    const { BrowserApprovalDialog } = await import("../../src/renderer/src/components/BrowserApprovalDialog");
    const html = renderToStaticMarkup(React.createElement(BrowserApprovalDialog));
    expect(html).toContain('role="dialog"');
    expect(html).toContain("evaluate");
    expect(html).toContain("https://viewer.example");
    expect(html).toContain("browserApproval.level3");
    expect(html).toContain('data-action-id="browserApproval.accept"');
    expect(html).toContain('data-action-id="browserApproval.decline"');
    // No locator presented → no locator row.
    expect(html).not.toContain("browserApproval.locator");
  });

  it("shows the locator strategy when the request carries one and flags the queue depth", async () => {
    storeState.browserApprovals = [
      { requestId: "r1", action: "upload", level: 2, origin: "https://files.example", locatorStrategy: "css", sessionId: "s1", pageId: "p1", askedAt: "2026-08-02T00:00:00.000Z" },
      { requestId: "r2", action: "fill", level: 3, origin: "https://auth.example", locatorStrategy: null, sessionId: "s1", pageId: "p2", askedAt: "2026-08-02T00:00:01.000Z" },
    ];
    const { BrowserApprovalDialog } = await import("../../src/renderer/src/components/BrowserApprovalDialog");
    const html = renderToStaticMarkup(React.createElement(BrowserApprovalDialog));
    expect(html).toContain("browserApproval.locator");
    expect(html).toContain("css");
    expect(html).toContain("browserApproval.more{&quot;count&quot;:1}");
    // Only the oldest prompt is surfaced.
    expect(html).toContain("upload");
    expect(html).not.toContain("auth.example");
  });

  it("renders the evaluate script preview and flags truncation, and hides it for non-evaluate prompts", async () => {
    storeState.browserApprovals = [{
      requestId: "r1",
      action: "evaluate",
      level: 3,
      origin: "https://viewer.example",
      locatorStrategy: null,
      sessionId: "s1",
      pageId: "p1",
      askedAt: "2026-08-02T00:00:00.000Z",
      previewScript: "document.querySelector('canvas').dataset",
      previewTruncated: true,
    }];
    const { BrowserApprovalDialog } = await import("../../src/renderer/src/components/BrowserApprovalDialog");
    const html = renderToStaticMarkup(React.createElement(BrowserApprovalDialog));
    expect(html).toContain("browserApproval.scriptPreview");
    expect(html).toContain("document.querySelector");
    expect(html).toContain("browserApproval.scriptTruncated");
    expect(html).toContain("<pre");

    storeState.browserApprovals = [{
      requestId: "r2",
      action: "upload",
      level: 2,
      origin: "https://files.example",
      locatorStrategy: null,
      sessionId: "s1",
      pageId: "p1",
      askedAt: "2026-08-02T00:00:01.000Z",
    }];
    const withoutPreview = renderToStaticMarkup(React.createElement(BrowserApprovalDialog));
    expect(withoutPreview).not.toContain("browserApproval.scriptPreview");
  });
});
