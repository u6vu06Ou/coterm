import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { AppEventBus } from "../../src/main/core/event-bus";
import { AgentMailbox } from "../../src/main/core/agent-mailbox";
import { handleAgentMailRequest } from "../../src/main/web/agent-mail";
import { agentApi, createAgentRateBuckets } from "../../src/main/web/agent-api";
import type { PtyState } from "../../src/shared/types";
import type { AppSettings } from "../../src/shared/types";

/**
 * Route-level tests for POST /api/v1/mail/*. The main-process web-server seams
 * (loopback + Host gate) live in web-server.ts; here we drive the handler
 * directly with fake req/res objects.
 */

interface FakeResponse extends ServerResponse {
  body: string;
  headers: Record<string, string>;
}

function makeRequest(options: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}): IncomingMessage {
  const stream = Readable.from(options.body !== undefined ? [Buffer.from(options.body, "utf8")] : []);
  const request = stream as unknown as IncomingMessage;
  request.method = options.method;
  request.url = options.url;
  request.headers = options.headers ?? {};
  return request;
}

function makeResponse(): FakeResponse {
  const response = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    writeHead(code: number, headers?: Record<string, string>) {
      this.statusCode = code;
      Object.assign(this.headers, headers ?? {});
      return this;
    },
    end(body?: string | Buffer) {
      this.body = body?.toString() ?? "";
      return this;
    },
  };
  return response as unknown as FakeResponse;
}

async function request(options: Parameters<typeof makeRequest>[0]): Promise<FakeResponse> {
  const response = makeResponse();
  await handleAgentMailRequest(makeRequest(options), response, routeDeps);
  return response;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

const routeDeps: { mailbox: AgentMailbox } = { mailbox: null as unknown as AgentMailbox };
const states = new Map<string, PtyState>();
const delivered: Array<{ terminalId: string; data: string }> = [];

function freshMailbox(): { mailbox: AgentMailbox; tokens: { a: string; b: string } } {
  states.clear();
  delivered.length = 0;
  const mailbox = new AgentMailbox({ events: new AppEventBus() });
  mailbox.bind({
    getState: (id) => states.get(id) ?? null,
    getContext: () => null,
    deliver: (id, data) => {
      delivered.push({ terminalId: id, data });
      return true;
    },
  });
  const tokens = {
    a: mailbox.onSpawn({ terminalId: "tA", isAgent: true, agentProfile: "claude" }).env.COTERM_MAIL_TOKEN!,
    b: mailbox.onSpawn({ terminalId: "tB", isAgent: true, agentProfile: "codex" }).env.COTERM_MAIL_TOKEN!,
  };
  routeDeps.mailbox = mailbox;
  return { mailbox, tokens };
}

describe("agent mail routes", () => {
  it("rejects everything that is not POST", async () => {
    const { mailbox } = freshMailbox();
    const res = await request({ method: "GET", url: "/api/v1/mail/who", headers: bearer("x") });
    expect(res.statusCode).toBe(405);
    mailbox.dispose();
  });

  it("rejects a missing or wrong bearer token with 401", async () => {
    const { mailbox } = freshMailbox();
    for (const headers of [{}, bearer("000000000000000000000000000000000000000000000000")]) {
      const res = await request({ method: "POST", url: "/api/v1/mail/who", headers });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body)).toEqual({ ok: false, error: "Invalid pane token." });
    }
    mailbox.dispose();
  });

  it("delivers and reports one short text line in text mode", async () => {
    const { mailbox, tokens } = freshMailbox();
    states.set("tB", "done");
    const res = await request({
      method: "POST",
      url: "/api/v1/mail/send",
      headers: { ...bearer(tokens.a), accept: "text/plain", "content-type": "application/json" },
      body: JSON.stringify({ to: "@codex-1", text: "tests green" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("sent -> @codex-1\n");
    expect(delivered).toEqual([{ terminalId: "tB", data: "[@claude-1] tests green\r" }]);
    mailbox.dispose();
  });

  it("delivers immediately even while the target is busy working", async () => {
    const { mailbox, tokens } = freshMailbox();
    states.set("tB", "running");
    const res = await request({
      method: "POST",
      url: "/api/v1/mail/send",
      headers: { ...bearer(tokens.a), accept: "text/plain" },
      body: JSON.stringify({ to: "codex-1", text: "ping" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("sent -> @codex-1\n");
    expect(delivered).toEqual([{ terminalId: "tB", data: "[@claude-1] ping\r" }]);
    mailbox.dispose();
  });

  it("queues while an approval prompt is showing", async () => {
    const { mailbox, tokens } = freshMailbox();
    states.set("tB", "approval_required");
    const res = await request({
      method: "POST",
      url: "/api/v1/mail/send",
      headers: { ...bearer(tokens.a), accept: "text/plain" },
      body: JSON.stringify({ to: "codex-1", text: "ping" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("queued -> @codex-1\n");
    expect(delivered).toEqual([]);
    mailbox.dispose();
  });

  it("maps error outcomes to status + a one-line reason", async () => {
    const { mailbox, tokens } = freshMailbox();
    const unknown = await request({
      method: "POST",
      url: "/api/v1/mail/send",
      headers: { ...bearer(tokens.a), accept: "text/plain" },
      body: JSON.stringify({ to: "@nobody-9", text: "hi" }),
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.body).toContain("unknown handle");

    const self = await request({
      method: "POST",
      url: "/api/v1/mail/send",
      headers: { ...bearer(tokens.a), accept: "text/plain" },
      body: JSON.stringify({ to: "@claude-1", text: "hi" }),
    });
    expect(self.statusCode).toBe(400);
    expect(self.body).toContain("cannot mail yourself");
    mailbox.dispose();
  });

  it("returns 400 for non-JSON or shape-wrong bodies and 413 for oversized ones", async () => {
    const { mailbox, tokens } = freshMailbox();
    const bad = await request({
      method: "POST",
      url: "/api/v1/mail/send",
      headers: bearer(tokens.a),
      body: "not-json{",
    });
    expect(bad.statusCode).toBe(400);
    const wrongShape = await request({
      method: "POST",
      url: "/api/v1/mail/send",
      headers: bearer(tokens.a),
      body: JSON.stringify({ to: "codex-1" }),
    });
    expect(wrongShape.statusCode).toBe(400);
    const huge = await request({
      method: "POST",
      url: "/api/v1/mail/send",
      headers: bearer(tokens.a),
      body: "x".repeat(1_000_001),
    });
    expect(huge.statusCode).toBe(413);
    mailbox.dispose();
  });

  it("returns the rate limit as 429", async () => {
    const { mailbox, tokens } = freshMailbox();
    states.set("tB", "running");
    let last: FakeResponse | null = null;
    for (let i = 0; i < 11; i += 1) {
      last = await request({
        method: "POST",
        url: "/api/v1/mail/send",
        headers: bearer(tokens.a),
        body: JSON.stringify({ to: "codex-1", text: `m${i}` }),
      });
    }
    expect(last!.statusCode).toBe(429);
    mailbox.dispose();
  });

  it("who answers with tab-separated rows in text mode", async () => {
    const { mailbox, tokens } = freshMailbox();
    states.set("tA", "done");
    const res = await request({
      method: "POST",
      url: "/api/v1/mail/who",
      headers: { ...bearer(tokens.a), accept: "text/plain" },
      body: "{}",
    });
    expect(res.statusCode).toBe(200);
    // text() appends one trailing "\n"; drop it (a trim would also eat the
    // final row's trailing tab for the empty cwd field).
    const lines = res.body.replace(/\n$/, "").split("\n");
    expect(lines[0]).toBe("you: claude-1");
    expect(lines).toContain("claude-1\tclaude\tdone\t");
    expect(lines).toContain("codex-1\tcodex\tunknown\t");
    mailbox.dispose();
  });

  it("surfaces dropped-mail notices after the outcome line", async () => {
    const { mailbox, tokens } = freshMailbox();
    states.set("tB", "approval_required");
    await request({
      method: "POST",
      url: "/api/v1/mail/send",
      headers: bearer(tokens.a),
      body: JSON.stringify({ to: "codex-1", text: "will be lost" }),
    });
    mailbox.release("tB");
    mailbox.onSpawn({ terminalId: "tC", isAgent: true, agentProfile: "gemini" });
    states.set("tC", "done");
    const res = await request({
      method: "POST",
      url: "/api/v1/mail/send",
      headers: { ...bearer(tokens.a), accept: "text/plain" },
      body: JSON.stringify({ to: "gemini-1", text: "next task" }),
    });
    expect(res.statusCode).toBe(200);
    const lines = res.body.trimEnd().split("\n");
    expect(lines[0]).toBe("sent -> @gemini-1");
    expect(lines[1]).toBe("1 message to codex-1 dropped (target exited).");
    mailbox.dispose();
  });
});

describe("agent mail token scoping", () => {
  it("a per-pane mail token can NOT drive the agent API", async () => {
    const { tokens } = freshMailbox();
    const res = makeResponse();
    const handled = await agentApi.handle(
      makeRequest({
        method: "GET",
        url: "/api/v1/agent/sessions",
        headers: { ...bearer(tokens.a), host: "127.0.0.1:43127" },
      }),
      res,
      {
        // The scoping path returns before any operation runs, so operations can
        // stay empty; the cast is the test-only stand-in for the full surface.
        operations: {} as Parameters<typeof agentApi.handle>[2]["operations"],
        getSettings: () =>
          ({ agentApi: { enabled: true, token: "full-agent-api-token" } }) as unknown as AppSettings,
        port: 43127,
        rateBuckets: createAgentRateBuckets(),
      },
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
  });

  it("the full agent-API token can NOT send pane mail", async () => {
    const { mailbox } = freshMailbox();
    const res = await request({
      method: "POST",
      url: "/api/v1/mail/send",
      headers: bearer("full-agent-api-token"),
      body: JSON.stringify({ to: "codex-1", text: "hi" }),
    });
    expect(res.statusCode).toBe(401);
    mailbox.dispose();
  });
});
