import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppEventBus } from "../../src/main/core/event-bus";
import { PtyManager } from "../../src/main/terminal/pty-manager";
import { JevVerifier, prepareJevScreenTail, type JevVerdictResult } from "../../src/main/terminal/jev-verifier";

function jevResponse(choice: string, probability: number): Response {
  return new Response(JSON.stringify({
    answers: { state: { type: "choice", choice, probabilities: { [choice]: probability } } },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("JevVerifier", () => {
  const enabled = () => ({ enabled: true, apiKey: "test-key" });

  it("is inert without a key or when disabled (never calls the network)", async () => {
    const fetchImpl = vi.fn();
    const off = new JevVerifier(() => ({ enabled: false, apiKey: "k" }), fetchImpl as unknown as typeof fetch);
    const noKey = new JevVerifier(() => ({ enabled: true, apiKey: " " }), fetchImpl as unknown as typeof fetch);
    expect(off.isEnabled()).toBe(false);
    expect(noKey.isEnabled()).toBe(false);
    expect(await off.classifyQuietScreen("Do you want to proceed?")).toBeNull();
    expect(await noKey.classifyQuietScreen("Do you want to proceed?")).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns a confident verdict and sends the gateway evaluation headers", async () => {
    const fetchImpl = vi.fn(async () => jevResponse("waiting_input", 0.97));
    const verifier = new JevVerifier(enabled, fetchImpl as unknown as typeof fetch);
    expect(await verifier.classifyQuietScreen("Do you want to proceed?\n> 1. Yes\n  2. No")).toEqual({
      verdict: "waiting_input",
      confidence: 0.97,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/evaluation-model");
    const headers = init.headers as Record<string, string>;
    expect(headers["ai-model-id"]).toBe("typesafe-ai/jev");
    expect(headers.authorization).toBe("Bearer test-key");
  });

  it("drops low-confidence answers (fail-open to the rules)", async () => {
    const verifier = new JevVerifier(enabled, (async () => jevResponse("turn_done", 0.55)) as unknown as typeof fetch);
    expect(await verifier.classifyQuietScreen("some screen")).toBeNull();
  });

  it("caches identical screens and opens the breaker after repeated failures", async () => {
    let now = 1_000;
    const ok = vi.fn(async () => jevResponse("turn_done", 0.9));
    const cached = new JevVerifier(enabled, ok as unknown as typeof fetch, () => now);
    await cached.classifyQuietScreen("same screen");
    await cached.classifyQuietScreen("same screen");
    expect(ok).toHaveBeenCalledTimes(1);

    const failing = vi.fn(async () => new Response("nope", { status: 500 }));
    const verifier = new JevVerifier(enabled, failing as unknown as typeof fetch, () => now);
    for (let i = 0; i < 3; i += 1) expect(await verifier.classifyQuietScreen(`screen ${i}`)).toBeNull();
    await verifier.classifyQuietScreen("screen 4");
    expect(failing).toHaveBeenCalledTimes(3);
    now += 11 * 60_000;
    await verifier.classifyQuietScreen("screen 5");
    expect(failing).toHaveBeenCalledTimes(4);
  });

  it("sends only a capped, scrubbed screen tail", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    lines.push("C:\\Users\\alice\\repo> sk-abcdefghijklmnopqrstuv");
    const tail = prepareJevScreenTail(lines.join("\n"));
    expect(tail).not.toContain("line 0");
    expect(tail).toContain("line 39");
    expect(tail).not.toContain("alice");
    expect(tail).not.toContain("sk-abcdefghijklmnopqrstuv");
    expect(tail.length).toBeLessThanOrEqual(1_200);
  });

  // council 2026-09-26 #2: a token straddling the 1200-char cut must still be
  // scrubbed (previously the truncate ran first and the headless tail escaped
  // every prefix rule).
  it("scrubs a secret that straddles the cap boundary", () => {
    const prefix = "x".repeat(1_300);
    const tail = prepareJevScreenTail(`${prefix} sk-abcdefghijklmnopqrstuvwxyz1234 end`);
    expect(tail).toContain("<redacted>");
    expect(tail).not.toMatch(/abcdefghijklmnopqrstuvwxyz1234/);
  });

  it("scrubs the council-listed shapes: AKIA, Bearer, key=value, private key", () => {
    const dirty = [
      "aws_key: AKIAIOSFODNN7EXAMPLE",
      "Authorization: Bearer abcdefghijklmnop12345678",
      "api_key = \"that-is-a-secret-value\"",
      "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBg\\n-----END PRIVATE KEY-----",
    ].join("\n");
    const tail = prepareJevScreenTail(dirty);
    expect(tail).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(tail).not.toContain("abcdefghijklmnop12345678");
    expect(tail).not.toContain("that-is-a-secret-value");
    expect(tail).not.toContain("MIIEvQIBADANBg");
    expect(tail).toContain("<redacted>");
  });
});

describe("PtyManager quiet debounce with a Jev second opinion", () => {
  let events: AppEventBus;

  beforeEach(() => {
    vi.useFakeTimers();
    events = new AppEventBus();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(answers: Array<JevVerdictResult | null>) {
    const classifyQuietScreen = vi.fn(async () => answers.shift() ?? null);
    const manager = new PtyManager(events, 2, undefined, {
      jevVerifier: { isEnabled: () => true, classifyQuietScreen },
    });
    const id = randomUUID();
    const terminals = (manager as unknown as { terminals: Map<string, unknown> }).terminals;
    terminals.set(id, {
      info: {
        id, projectId: "00000000-0000-4000-8000-000000000000", profile: "pwsh", title: "pwsh",
        cwd: "D:\\fixture", cols: 100, rows: 28, status: "running", startedAt: new Date().toISOString(),
        closedAt: null, lastExitCode: null, isAgent: true, agentProfile: "claude-official",
        ownedByAgentApi: false, pid: 0, nativeSessionId: null, worktreeId: null,
      },
      process: { kill: () => undefined, write: () => undefined },
      resizeTimer: null, scrollback: "", dataDisposer: null, exitDisposer: null,
      ptyState: "starting", ptyStateSource: "process", titleBuffer: "", oscCarry: "",
      shellCwd: "D:\\fixture", lifecycle: null, lastCommand: null, quietTimer: null,
    });
    const feed = (data: string) => {
      const t = terminals.get(id);
      (manager as unknown as { _detectPtyState: (t: unknown, d: string) => void })._detectPtyState(t, data);
    };
    return { manager, id, feed, classifyQuietScreen };
  }

  it("a confident waiting_input turns the quiet screen into attention (after a submitted turn)", async () => {
    const { manager, id, feed } = setup([{ verdict: "waiting_input", confidence: 0.95 }]);
    // Dirty-input gate (2026-09-27): confident Jev waiting_input only files
    // attention when a user turn is pending. Submit one via HUMAN Enter first.
    manager.write(id, "allow this edit\r", "human");
    feed("Allow this edit? (y/n)\n");
    await vi.advanceTimersByTimeAsync(2_501);
    expect(manager.getPtyState(id)).toBe("waiting_input");
  });

  it("no opinion keeps the heuristic done", async () => {
    const { manager, id, feed } = setup([null]);
    feed("all done\n");
    await vi.advanceTimersByTimeAsync(2_501);
    expect(manager.getPtyState(id)).toBe("done");
  });

  it("still_working defers done, but only a bounded number of times", async () => {
    const working = { verdict: "still_working" as const, confidence: 0.9 };
    const { manager, id, feed, classifyQuietScreen } = setup([working, working, working]);
    feed("running tests...\n");
    await vi.advanceTimersByTimeAsync(2_501);
    expect(manager.getPtyState(id)).toBe("running");
    await vi.advanceTimersByTimeAsync(2_501);
    expect(manager.getPtyState(id)).toBe("running");
    await vi.advanceTimersByTimeAsync(2_501);
    expect(manager.getPtyState(id)).toBe("done");
    expect(classifyQuietScreen).toHaveBeenCalledTimes(3);
  });
});
