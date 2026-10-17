// @vitest-environment node
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NormalizedEvent } from "../../src/shared/types";
import { reduceBrowserApprovals } from "../../src/renderer/src/store/app-store";

function approvalEvent(type: "approval.requested" | "approval.resolved", payload: Record<string, unknown>): NormalizedEvent {
  return {
    id: randomUUID(),
    conversationId: "00000000-0000-4000-8000-000000000133",
    turnId: randomUUID(),
    providerSessionId: null,
    turnGroupId: null,
    type,
    createdAt: "2026-08-02T00:00:00.000Z",
    sequence: 0,
    summary: "",
    payload,
  };
}

describe("reduceBrowserApprovals (AT-133)", () => {
  it("collects a browser approval.requested event into a pending prompt", () => {
    const requestId = randomUUID();
    const result = reduceBrowserApprovals([], approvalEvent("approval.requested", {
      browser: true,
      requestId,
      action: "evaluate",
      level: 3,
      origin: "https://viewer.example",
      locatorStrategy: "css",
      sessionId: "s1",
      pageId: "p1",
    }));
    expect(result).toEqual([{
      requestId,
      action: "evaluate",
      level: 3,
      origin: "https://viewer.example",
      locatorStrategy: "css",
      sessionId: "s1",
      pageId: "p1",
      askedAt: "2026-08-02T00:00:00.000Z",
    }]);
  });

  it("carries the evaluate script preview through to the prompt", () => {
    const requestId = randomUUID();
    const result = reduceBrowserApprovals([], approvalEvent("approval.requested", {
      browser: true,
      requestId,
      action: "evaluate",
      level: 3,
      origin: "https://viewer.example",
      previewScript: "document.title",
      previewTruncated: true,
    }));
    expect(result[0]).toMatchObject({ previewScript: "document.title", previewTruncated: true });
  });

  it("drops the prompt on the matching approval.resolved event", () => {
    const requestId = randomUUID();
    const withPrompt = reduceBrowserApprovals([], approvalEvent("approval.requested", { browser: true, requestId, action: "upload", origin: "https://example.com" }));
    const cleared = reduceBrowserApprovals(withPrompt, approvalEvent("approval.resolved", { browser: true, requestId }));
    expect(cleared).toEqual([]);
  });

  it("replaces rather than stacks a repeated requestId", () => {
    const requestId = randomUUID();
    const once = reduceBrowserApprovals([], approvalEvent("approval.requested", { browser: true, requestId, action: "upload", origin: "https://a.example" }));
    const twice = reduceBrowserApprovals(once, approvalEvent("approval.requested", { browser: true, requestId, action: "upload", origin: "https://b.example" }));
    expect(twice).toHaveLength(1);
    expect(twice[0]!.origin).toBe("https://b.example");
  });

  it("ignores provider approval events (payload.browser is absent there)", () => {
    const event = approvalEvent("approval.requested", { requestId: randomUUID(), name: "Bash", input: {} });
    expect(reduceBrowserApprovals([], event)).toEqual([]);
    const resolved = approvalEvent("approval.resolved", { requestId: randomUUID(), decision: "accept" });
    expect(reduceBrowserApprovals([], resolved)).toEqual([]);
  });

  it("ignores unrelated event types entirely", () => {
    const event = approvalEvent("approval.resolved", { browser: true });
    event.type = "tool.completed";
    expect(reduceBrowserApprovals([], event)).toEqual([]);
  });
});
