import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalBroker } from "../../src/main/core/approval-broker";

afterEach(() => {
  vi.useRealTimers();
});

describe("ApprovalBroker", () => {
  it("resolves an explicit decision exactly once", async () => {
    const broker = new ApprovalBroker();
    const request = broker.request();

    broker.resolve(request.requestId, "accept");

    await expect(request.decision).resolves.toBe("accept");
    // A duplicate resolve is a no-op rather than a throw: the decision has
    // already been delivered and the request is no longer pending.
    expect(() => broker.resolve(request.requestId, "decline")).not.toThrow();
  });

  it("cancels timed out and shutdown approvals", async () => {
    vi.useFakeTimers();
    const broker = new ApprovalBroker();
    const timed = broker.request(100);
    const shutdown = broker.request(10_000);

    await vi.advanceTimersByTimeAsync(100);
    broker.cancelAll();

    await expect(timed.decision).resolves.toBe("cancel");
    await expect(shutdown.decision).resolves.toBe("cancel");
  });

  it("resolves structured user input exactly once", async () => {
    const broker = new ApprovalBroker();
    const request = broker.requestInput();
    const answers = { architecture: ["Agent SDK"] };

    broker.resolveInput(request.requestId, answers);

    await expect(request.answers).resolves.toEqual(answers);
    // A duplicate resolve is a no-op rather than a throw.
    expect(() => broker.resolveInput(request.requestId, answers)).not.toThrow();
  });
});

describe("ApprovalBroker — terminal-context signals", () => {
  it("emits pending + resolved with the terminal context when provided", () => {
    const broker = new ApprovalBroker();
    const signals: Array<{ kind: string; state: string; hasContext: boolean }> = [];
    broker.onSignal((s) => signals.push({ kind: s.kind, state: s.state, hasContext: !!s.context }));

    const ctx = { terminalId: "t1", projectId: "p1" };
    const req = broker.request(10_000, ctx);
    broker.resolve(req.requestId, "accept");

    expect(signals).toEqual([
      { kind: "approval", state: "pending", hasContext: true },
      { kind: "approval", state: "resolved", hasContext: true },
    ]);
  });

  it("emits context=null when no terminal context is provided (interactive path)", () => {
    const broker = new ApprovalBroker();
    const signals: Array<{ hasContext: boolean }> = [];
    broker.onSignal((s) => signals.push({ hasContext: !!s.context }));

    const req = broker.request(10_000); // no context
    broker.resolve(req.requestId, "decline");

    expect(signals).toEqual([
      { hasContext: false },
      { hasContext: false },
    ]);
  });

  it("input requests emit input signals with context", () => {
    const broker = new ApprovalBroker();
    const kinds: string[] = [];
    broker.onSignal((s) => kinds.push(s.kind));
    const ctx = { terminalId: "t2", projectId: "p1" };
    const req = broker.requestInput(10_000, ctx);
    broker.resolveInput(req.requestId, null);
    expect(kinds).toEqual(["input", "input"]);
  });

  it("emits resolved when approval and input requests time out", async () => {
    vi.useFakeTimers();
    const broker = new ApprovalBroker();
    const signals: string[] = [];
    broker.onSignal((s) => signals.push(`${s.kind}:${s.state}`));
    const approval = broker.request(50, { terminalId: "t1", projectId: "p1" });
    const input = broker.requestInput(50, { terminalId: "t2", projectId: "p1" });

    await vi.advanceTimersByTimeAsync(50);

    await expect(approval.decision).resolves.toBe("cancel");
    await expect(input.answers).resolves.toBeNull();
    expect(signals).toEqual([
      "approval:pending",
      "input:pending",
      "approval:resolved",
      "input:resolved",
    ]);
  });
});

describe("ApprovalBroker — requestId + payload signals (AT-133)", () => {
  it("carries requestId and the display payload on pending and resolved signals", () => {
    const broker = new ApprovalBroker();
    const signals: Array<{ state: string; requestId: string; payload: unknown }> = [];
    broker.onSignal((s) => signals.push({ state: s.state, requestId: s.requestId, payload: s.payload }));

    const ctx = { kind: "browser" as const, origin: "https://example.com", sessionId: "s1", pageId: "p1" };
    const display = { action: "upload", level: 2, origin: "https://example.com", locatorStrategy: "css" };
    const req = broker.request(10_000, ctx, display);
    broker.resolve(req.requestId, "accept");

    expect(signals).toEqual([
      { state: "pending", requestId: req.requestId, payload: display },
      { state: "resolved", requestId: req.requestId, payload: display },
    ]);
  });

  it("keeps the no-payload shape undefined (backward compat for codex callers)", () => {
    const broker = new ApprovalBroker();
    const signals: Array<{ context: unknown; payload: unknown }> = [];
    broker.onSignal((s) => signals.push({ context: s.context, payload: s.payload }));

    const req = broker.request(); // legacy shape: no context, no payload
    broker.resolve(req.requestId, "decline");

    expect(signals).toEqual([
      { context: null, payload: undefined },
      { context: null, payload: undefined },
    ]);
  });

  it("exposes the requestId on timeout so listeners can close the matching prompt", async () => {
    vi.useFakeTimers();
    const broker = new ApprovalBroker();
    const signals: Array<{ state: string; requestId: string }> = [];
    broker.onSignal((s) => signals.push({ state: s.state, requestId: s.requestId }));
    const req = broker.request(50, { kind: "browser", origin: "https://example.com", sessionId: "s1", pageId: "p1" });

    await vi.advanceTimersByTimeAsync(50);

    await expect(req.decision).resolves.toBe("cancel");
    expect(signals).toEqual([
      { state: "pending", requestId: req.requestId },
      { state: "resolved", requestId: req.requestId },
    ]);
  });
});
