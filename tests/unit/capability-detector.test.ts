import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import {
  classifyPing,
  detectProviders,
  resetProviderProbeCache,
} from "../../src/main/providers/capability-detector";
import type { AgentOption } from "../../src/shared/types";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>;

function fakeChild(output: string, ok = true) {
  const handlers: Record<string, ((arg: unknown) => void)[]> = {};
  return {
    stdout: { on: (_: string, cb: (arg: unknown) => void) => (handlers.stdout = [cb]) },
    stderr: { on: (_: string, cb: (arg: unknown) => void) => (handlers.stderr = [cb]) },
    once: (event: string, cb: (arg: unknown) => void) => {
      if (event === "exit") {
        handlers.stdout?.[0]?.(Buffer.from(output));
        handlers.stderr?.[0]?.(Buffer.from(""));
        cb(ok ? 0 : 1);
      }
    },
    kill: () => undefined,
  };
}

interface Reply {
  status: number;
  body?: string;
  throws?: boolean;
}

interface Harness {
  fetchMock: ReturnType<typeof vi.spyOn>;
  /** Every /v1/messages ping as `model`, in call order. */
  pings: string[];
  modelsCalls: () => number;
  maxConcurrent: () => number;
}

/**
 * Bridge double: /v1/models answers the alias table (the membership source),
 * everything else is decided by `ping` (default: a live 200).
 */
function installFetch(
  opts: { models?: string[]; modelsFails?: boolean; ping?: (url: string, body: string) => Reply } = {},
): Harness {
  let inFlight = 0;
  let peak = 0;
  let modelsCalls = 0;
  const pings: string[] = [];
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
    async (raw: unknown, rawInit?: RequestInit) => {
      const url = String(raw);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        if (url.endsWith("/v1/models")) {
          modelsCalls += 1;
          if (opts.modelsFails) {
            return { ok: false, status: 503, json: async () => ({}), text: async () => "" } as unknown as Response;
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: (opts.models ?? []).map((id) => ({ id })) }),
            text: async () => "",
          } as unknown as Response;
        }
        const body = typeof rawInit?.body === "string" ? rawInit.body : "";
        pings.push(String((JSON.parse(body) as { model?: string }).model ?? ""));
        const reply = opts.ping?.(url, body) ?? { status: 200, body: "{}" };
        if (reply.throws) throw new Error("ECONNREFUSED");
        return {
          ok: reply.status >= 200 && reply.status < 300,
          status: reply.status,
          json: async () => ({}),
          text: async () => reply.body ?? "",
        } as unknown as Response;
      } finally {
        inFlight -= 1;
      }
    },
  );
  return {
    fetchMock,
    pings,
    modelsCalls: () => modelsCalls,
    maxConcurrent: () => peak,
  };
}

function localOption(id: string, model: string, harness: "claude" | "codex" = "claude"): AgentOption {
  return {
    id,
    label: id,
    local: true,
    harness,
    launchKind: harness === "codex" ? "codex" : "claude",
    model,
    env: {},
  } as unknown as AgentOption;
}

const PROXY = { proxyUrl: "http://127.0.0.1:8787", authToken: "ccr-local" };
const ANY = "brand-new-model";

beforeEach(() => {
  resetProviderProbeCache();
  mockSpawn.mockImplementation(() => fakeChild("1.0.0"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("provider capability detection", () => {
  it("lists a hot-registered model at all, and reads it from the alias table", async () => {
    // The old fixed roster had no row for a custom profile, so a live model
    // rendered as「未安裝」. Membership now follows the active profile table.
    installFetch({ models: ["my-kimi", "my-glm-flash"] });
    const providers = await detectProviders({
      ...PROXY,
      options: [localOption("claude-local-big", "my-kimi")],
    });
    const kimi = providers.find((provider) => provider.id === "claude-local-big");
    expect(kimi?.installed).toBe(true);
    expect(kimi?.online).toBe(true);
    expect(kimi?.state).toBe("online");
    expect(kimi?.backend).toBe("my-kimi");
    expect(kimi?.checkedAt).toBeGreaterThan(0);
  });

  it("calls a retired model 已停用 even though the proxy still lists it", async () => {
    // The alias table is static: it still advertises my-glm-max, which answers 502.
    // A stale table may never light a retired row up.
    const harness = installFetch({
      models: ["my-glm-max", "my-glm-flash"],
      ping: () => ({ status: 502, body: "no healthy upstream" }),
    });
    const providers = await detectProviders({
      ...PROXY,
      options: [localOption("claude-local-max", "my-glm-max")],
    });
    const retired = providers.find((provider) => provider.id === "claude-local-max");
    expect(retired?.state).toBe("retired");
    expect(retired?.online).toBe(false);
    expect(retired?.detail).toContain("my-glm-flash");
    // A retired name is never even pinged.
    expect(harness.pings).toEqual([]);
  });

  it("probes one backend once, not once per alias and harness", async () => {
    const harness = installFetch({ models: ["my-glm-flash"] });
    const providers = await detectProviders({
      ...PROXY,
      options: [
        localOption("claude-new", ANY),
        localOption("codex-new", ANY, "codex"),
        localOption("claude-old-glm", "my-glm-flash"),
        localOption("codex-old-glm", "my-glm-flash", "codex"),
      ],
    });
    // Two harnesses on one unlisted model share a route, and the two GLM
    // spellings resolve to the family the alias table already answered.
    expect(providers.filter((provider) => provider.backend === ANY)).toHaveLength(2);
    expect(harness.pings.filter((model) => model === ANY)).toHaveLength(1);
    expect(harness.pings).not.toContain("my-glm-flash");
    expect(providers.filter((provider) => provider.backend === "my-glm-flash").every((p) => p.online)).toBe(true);
  });

  it("answers 429 with 今日額度, not 離線 and not 線上", async () => {
    installFetch({ models: [], ping: () => ({ status: 429, body: "daily quota exceeded" }) });
    const providers = await detectProviders({
      ...PROXY,
      options: [localOption("claude-quota", "quota-model")],
    });
    const quota = providers.find((provider) => provider.id === "claude-quota");
    expect(quota?.state).toBe("rate_limited");
    expect(quota?.online).toBe(false);
    expect(quota?.detail).toContain("額度");
  });

  it("marks every free route offline when the bridge is unreachable, without pinging", async () => {
    const harness = installFetch({ modelsFails: true });
    const providers = await detectProviders({
      ...PROXY,
      options: [localOption("claude-local-main", "my-glm-flash")],
    });
    expect(providers.find((provider) => provider.id === "claude-local-main")?.state).toBe("offline");
    expect(harness.pings).toEqual([]);
  });

  it("re-reads the cache within the TTL and re-probes past it", async () => {
    const harness = installFetch({ models: ["my-glm-flash"] });
    const options = [localOption("claude-probe", ANY)];
    let clock = 1_000;
    await detectProviders({ ...PROXY, options, now: () => clock });
    const afterFirst = harness.fetchMock.mock.calls.length;
    await detectProviders({ ...PROXY, options, now: () => clock });
    expect(harness.fetchMock.mock.calls.length).toBe(afterFirst);
    clock += 5 * 60_000;
    await detectProviders({ ...PROXY, options, now: () => clock });
    expect(harness.fetchMock.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it("lets the 重探钮 skip the TTL", async () => {
    const harness = installFetch({ models: ["my-glm-flash"] });
    const options = [localOption("claude-local-main", "my-glm-flash")];
    await detectProviders({ ...PROXY, options });
    expect(harness.modelsCalls()).toBe(1);
    await detectProviders({ ...PROXY, options });
    expect(harness.modelsCalls()).toBe(1);
    await detectProviders({ ...PROXY, options, force: true });
    expect(harness.modelsCalls()).toBe(2);
  });

  it("caps pings per round instead of scanning the whole list", async () => {
    const models = Array.from({ length: 12 }, (_unused, index) => `model-${index}`);
    const harness = installFetch({ models: ["my-glm-flash"] });
    await detectProviders({
      ...PROXY,
      options: models.map((name) => localOption(`claude-${name}`, name)),
    });
    expect(harness.pings.length).toBeLessThanOrEqual(6);
    expect(harness.maxConcurrent()).toBeLessThanOrEqual(4);
  });

  it("sends the focus rows to the head of the ping queue", async () => {
    const models = Array.from({ length: 10 }, (_unused, index) => `model-${index}`);
    const harness = installFetch({
      models: ["my-glm-flash"],
      ping: () => ({ status: 200, body: "{}" }),
    });
    await detectProviders({
      ...PROXY,
      options: models.map((name) => localOption(`claude-${name}`, name)),
      focus: ["claude-model-9"],
    });
    expect(harness.pings[0]).toBe("model-9");
  });

  it("keeps judging paid routes by the CLI, never by the bridge", async () => {
    const harness = installFetch({ modelsFails: true });
    mockSpawn.mockImplementation((_command: string, args: string[]) =>
      fakeChild(args?.[0] === "auth" ? '{"loggedIn":true}' : "1.0.0"));
    const providers = await detectProviders({
      ...PROXY,
      options: [
        {
          id: "claude-official",
          label: "Claude Official",
          local: false,
          harness: "claude",
          launchKind: "claude",
          env: {},
        } as unknown as AgentOption,
      ],
    });
    const official = providers.find((provider) => provider.id === "claude-official");
    expect(official?.state).toBe("online");
    expect(official?.source).toBe("cli");
    expect(official?.authenticated).toBe(true);
    expect(harness.pings).toEqual([]);
  });

  it("still answers the legacy positional call used by older callers", async () => {
    installFetch({ models: ["my-glm-flash"] });
    const providers = await detectProviders("http://127.0.0.1:8787", "ccr-local");
    expect(providers.find((provider) => provider.id === "claude-local-main")?.state).toBe("online");
    expect(providers.find((provider) => provider.id === "claude-local-main")?.online).toBe(true);
  });
});

describe("probe classification", () => {
  it("separates quota, missing model, and upstream failure", () => {
    expect(classifyPing(200, "", 0).state).toBe("online");
    expect(classifyPing(429, "", 0).state).toBe("rate_limited");
    expect(classifyPing(400, "invalid model name", 0).state).toBe("offline");
    expect(classifyPing(503, "no healthy upstream", 0).state).toBe("offline");
    // A 401 still proves the route exists; only the login posture is unclear.
    expect(classifyPing(401, "unauthorized", 0).state).toBe("online");
    expect(classifyPing(401, "unauthorized", 0).confirmed).toBe(true);
  });
});
