import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { UsageSlot } from "../../src/shared/types";
import {
  parseClaudeUsageEndpoint,
  parseCodexTokenCount,
  readClaudeAccessToken,
  readClaudeUsage,
  readCodexRolloutTail,
  readCodexUsage,
  UsageMonitor,
} from "../../src/main/terminal/usage-monitor";

describe("readClaudeUsage", () => {
  it("parses five_hour + seven_day percentages and reset epochs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coterm-claude-"));
    const file = join(dir, "usage-cache.json");
    await writeFile(
      file,
      JSON.stringify({
        fetchedAt: 1784126550866,
        rate_limits: {
          five_hour: { used_percentage: 54, resets_at: 1784128800 },
          seven_day: { used_percentage: 18, resets_at: 1784671200 },
        },
      }),
      "utf8",
    );
    try {
      const result = await readClaudeUsage(file);
      expect(result).not.toBeNull();
      expect(result!.fiveHour).toEqual<UsageSlot>({
        percent: 54,
        resetAt: 1784128800,
        updatedAt: expect.any(Number),
        source: "claude",
      });
      expect(result!.sevenDay?.percent).toBe(18);
      expect(result!.sevenDay?.resetAt).toBe(1784671200);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null when the file is missing", async () => {
    await expect(readClaudeUsage(join(tmpdir(), "nope-cache.json"))).resolves.toBeNull();
  });

  it("returns null when rate_limits is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coterm-claude-"));
    const file = join(dir, "usage-cache.json");
    await writeFile(file, JSON.stringify({ fetchedAt: 1 }), "utf8");
    try {
      await expect(readClaudeUsage(file)).resolves.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("clamps percentages above 100 to 100", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coterm-claude-"));
    const file = join(dir, "usage-cache.json");
    await writeFile(
      file,
      JSON.stringify({
        rate_limits: {
          five_hour: { used_percentage: 250, resets_at: 1 },
          seven_day: { used_percentage: -5, resets_at: 2 },
        },
      }),
      "utf8",
    );
    try {
      const result = await readClaudeUsage(file);
      expect(result!.fiveHour?.percent).toBe(100);
      expect(result!.sevenDay?.percent).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("parseCodexTokenCount", () => {
  const mtime = 1_700_000_000_000;

  it("parses a weekly (window_minutes=10080) token_count record", () => {
    const record = {
      timestamp: "2026-03-27T15:34:37.821Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: null,
        rate_limits: {
          limit_id: "codex",
          primary: { used_percent: 12.0, window_minutes: 10080, resets_at: 1775193139 },
          secondary: null,
          credits: null,
          plan_type: "free",
        },
      },
    };
    expect(parseCodexTokenCount(record, mtime)).toEqual<UsageSlot>({
      percent: 12,
      resetAt: 1775193139,
      updatedAt: mtime,
      source: "codex",
    });
  });

  it("returns null for a non-weekly window (e.g. 300 min)", () => {
    const record = {
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: { primary: { used_percent: 5, window_minutes: 300, resets_at: 1 } },
      },
    };
    expect(parseCodexTokenCount(record, mtime)).toBeNull();
  });

  it("finds the weekly window in secondary when primary is the short window", () => {
    const record = {
      payload: {
        type: "token_count",
        rate_limits: {
          primary: { used_percent: 5, window_minutes: 300, resets_at: 1 },
          secondary: { used_percent: 42, window_minutes: 10080, resets_at: 2 },
        },
      },
    };
    expect(parseCodexTokenCount(record, mtime)).toEqual<UsageSlot>({
      percent: 42,
      resetAt: 2,
      updatedAt: mtime,
      source: "codex",
    });
  });

  it("returns null when payload.type is not token_count", () => {
    const record = { type: "event_msg", payload: { type: "response_item", rate_limits: {} } };
    expect(parseCodexTokenCount(record, mtime)).toBeNull();
  });

  it("returns null for malformed records", () => {
    expect(parseCodexTokenCount(null, mtime)).toBeNull();
    expect(parseCodexTokenCount({}, mtime)).toBeNull();
    expect(parseCodexTokenCount({ payload: { type: "token_count" } }, mtime)).toBeNull();
    expect(
      parseCodexTokenCount(
        { payload: { type: "token_count", rate_limits: { primary: { used_percent: "NaN" } } } },
        mtime,
      ),
    ).toBeNull();
  });

  it("clamps used_percent to 0–100", () => {
    const record = {
      payload: {
        type: "token_count",
        rate_limits: { primary: { used_percent: 150, window_minutes: 10080, resets_at: 1 } },
      },
    };
    expect(parseCodexTokenCount(record, mtime)?.percent).toBe(100);
  });
});

describe("readCodexUsage", () => {
  it("skips newer rollouts that carry no rate-limit reading", async () => {
    const root = await mkdtemp(join(tmpdir(), "coterm-codex-usage-"));
    const day = join(root, "2026", "10", "18");
    await mkdir(day, { recursive: true });
    const withReading = join(day, "rollout-a.jsonl");
    await writeFile(withReading, JSON.stringify({
      payload: { type: "token_count", rate_limits: { primary: { used_percent: 6, window_minutes: 10080, resets_at: 1 } } },
    }) + "\n", "utf8");
    const past = new Date(Date.now() - 60_000);
    await utimes(withReading, past, past);
    // Newest file: a just-started (or free proxy) session with no token_count at all.
    await writeFile(join(day, "rollout-b.jsonl"), JSON.stringify({ type: "session_meta", payload: {} }) + "\n", "utf8");
    try {
      expect((await readCodexUsage(root))?.percent).toBe(6);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("readCodexRolloutTail", () => {
  it("finds the newest weekly token_count in the tail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coterm-codex-"));
    const file = join(dir, "rollout-test.jsonl");
    const lines = [
      JSON.stringify({ payload: { type: "response_item" } }),
      JSON.stringify({
        payload: {
          type: "token_count",
          rate_limits: { primary: { used_percent: 8, window_minutes: 10080, resets_at: 100 } },
        },
      }),
      JSON.stringify({ payload: { type: "response_item" } }),
      JSON.stringify({
        payload: {
          type: "token_count",
          rate_limits: { primary: { used_percent: 33, window_minutes: 10080, resets_at: 200 } },
        },
      }),
    ];
    await writeFile(file, lines.join("\n") + "\n", "utf8");
    try {
      const slot = await readCodexRolloutTail(file);
      // newest weekly token_count wins (33, not 8)
      expect(slot?.percent).toBe(33);
      expect(slot?.resetAt).toBe(200);
      expect(slot?.source).toBe("codex");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null when no weekly token_count exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coterm-codex-"));
    const file = join(dir, "rollout-test.jsonl");
    await mkdir(dir, { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        payload: {
          type: "token_count",
          rate_limits: { primary: { used_percent: 5, window_minutes: 300, resets_at: 1 } },
        },
      }) + "\n",
      "utf8",
    );
    try {
      await expect(readCodexRolloutTail(file)).resolves.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null for a missing file", async () => {
    await expect(readCodexRolloutTail(join(tmpdir(), "nope-rollout.jsonl"))).resolves.toBeNull();
  });
});

describe("parseClaudeUsageEndpoint", () => {
  it("maps utilization + ISO resets_at into used-percent slots stamped at fetch time", () => {
    const now = 1_790_000_000_000;
    const result = parseClaudeUsageEndpoint({
      five_hour: { utilization: 3.0, resets_at: "2026-09-22T20:10:00.135357+00:00" },
      seven_day: { utilization: 97.0, resets_at: "2026-09-22T22:00:00.135382+00:00" },
    }, now);
    expect(result).not.toBeNull();
    expect(result!.fiveHour?.percent).toBe(3);
    expect(result!.fiveHour?.resetAt).toBe(Math.floor(Date.parse("2026-09-22T20:10:00.135357+00:00") / 1000));
    expect(result!.sevenDay?.percent).toBe(97);
    expect(result!.sevenDay?.updatedAt).toBe(now);
    expect(result!.sevenDay?.source).toBe("claude");
  });

  it("degrades a missing window to null while keeping the other", () => {
    const result = parseClaudeUsageEndpoint(
      { seven_day: { utilization: 60, resets_at: "2026-09-30T00:00:00Z" } },
      1_790_000_000_000,
    );
    expect(result?.fiveHour).toBeNull();
    expect(result?.sevenDay?.percent).toBe(60);
  });

  it("returns null for a body with no usable window", () => {
    expect(parseClaudeUsageEndpoint({ error: "unauthorized" }, 1_790_000_000_000)).toBeNull();
    expect(parseClaudeUsageEndpoint(null, 1_790_000_000_000)).toBeNull();
  });
});

describe("readClaudeAccessToken", () => {
  it("returns the token when it is unexpired", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coterm-creds-"));
    const file = join(dir, ".credentials.json");
    const now = 1_790_000_000_000;
    await writeFile(file, JSON.stringify({
      claudeAiOauth: { accessToken: "sk-test", expiresAt: now + 60_000 },
    }), "utf8");
    try {
      await expect(readClaudeAccessToken(file, now)).resolves.toBe("sk-test");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses an expired or inside-skew token (no doomed API round trip)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coterm-creds-"));
    const file = join(dir, ".credentials.json");
    const now = 1_790_000_000_000;
    await writeFile(file, JSON.stringify({
      claudeAiOauth: { accessToken: "sk-test", expiresAt: now + 10_000 },
    }), "utf8");
    try {
      await expect(readClaudeAccessToken(file, now)).resolves.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null for a missing or malformed credentials file", async () => {
    const now = 1_790_000_000_000;
    await expect(readClaudeAccessToken(join(tmpdir(), "nope-credentials.json"), now)).resolves.toBeNull();
    const dir = await mkdtemp(join(tmpdir(), "coterm-creds-"));
    const file = join(dir, ".credentials.json");
    await writeFile(file, "not json", "utf8");
    try {
      await expect(readClaudeAccessToken(file, now)).resolves.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("UsageMonitor claude OAuth refresh", () => {
  function stubFetch(body: unknown, status = 200) {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      } as Response;
    }) as typeof fetch;
    return { fetchImpl, calls: () => calls };
  }

  it("refreshes from the OAuth endpoint when the cache file is stale, in-memory only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coterm-usage-mon-"));
    const cache = join(dir, "usage-cache.json");
    const creds = join(dir, ".credentials.json");
    const now = 1_790_000_000_000;
    // Stale cache: written 3 hours before "now".
    await writeFile(cache, JSON.stringify({
      fetchedAt: now - 10_800_000,
      rate_limits: {
        five_hour: { used_percentage: 90, resets_at: 1 },
        seven_day: { used_percentage: 90, resets_at: 1 },
      },
    }), "utf8");
    const past = new Date(now - 10_800_000);
    await utimes(cache, past, past);
    await writeFile(creds, JSON.stringify({
      claudeAiOauth: { accessToken: "sk-test", expiresAt: now + 3_600_000 },
    }), "utf8");
    const { fetchImpl, calls } = stubFetch({
      five_hour: { utilization: 3, resets_at: "2026-09-22T20:10:00Z" },
      seven_day: { utilization: 41, resets_at: "2026-09-29T20:10:00Z" },
    });
    try {
      const monitor = new UsageMonitor({
        events: { emit: () => undefined },
        claudeCachePath: cache,
        claudeCredentialsPath: creds,
        codexSessionsRoot: join(dir, "no-codex"),
        fetchImpl,
        now: () => now,
        intervalMs: 60_000,
      });
      await (monitor as unknown as { tick: () => Promise<void> }).tick();
      expect(calls()).toBe(1);
      const snapshot = monitor.getSnapshot();
      // Fresh endpoint data wins: percent 3, NOT the stale file's 90 — and the
      // slot is stamped at fetch time so the HUD never shows a frozen number.
      expect(snapshot.claude5h?.percent).toBe(3);
      expect(snapshot.claude5h?.updatedAt).toBe(now);
      // Second tick inside the refresh interval: throttle — no new request,
      // same in-memory reading.
      await (monitor as unknown as { tick: () => Promise<void> }).tick();
      expect(calls()).toBe(1);
      expect(monitor.getSnapshot().claude5h?.percent).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the honest stale file data when the endpoint rejects the refresh", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coterm-usage-mon-"));
    const cache = join(dir, "usage-cache.json");
    const creds = join(dir, ".credentials.json");
    const now = 1_790_000_000_000;
    await writeFile(cache, JSON.stringify({
      fetchedAt: now - 10_800_000,
      rate_limits: {
        five_hour: { used_percentage: 55, resets_at: 1 },
        seven_day: { used_percentage: 70, resets_at: 1 },
      },
    }), "utf8");
    const past = new Date(now - 10_800_000);
    await utimes(cache, past, past);
    await writeFile(creds, JSON.stringify({
      claudeAiOauth: { accessToken: "sk-test", expiresAt: now + 3_600_000 },
    }), "utf8");
    const { fetchImpl, calls } = stubFetch({ error: "unauthorized" }, 401);
    try {
      const monitor = new UsageMonitor({
        events: { emit: () => undefined },
        claudeCachePath: cache,
        claudeCredentialsPath: creds,
        codexSessionsRoot: join(dir, "no-codex"),
        fetchImpl,
        now: () => now,
        intervalMs: 60_000,
      });
      await (monitor as unknown as { tick: () => Promise<void> }).tick();
      expect(calls()).toBe(1);
      const snapshot = monitor.getSnapshot();
      // Falls back to the file WITH its old mtime — the HUD marks it stale
      // (過期 N 天) instead of parading a frozen number as current quota.
      expect(snapshot.claude5h?.percent).toBe(55);
      expect(snapshot.claude5h?.updatedAt).toBeLessThan(now - 3_600_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never hits the network when the token is expired", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coterm-usage-mon-"));
    const creds = join(dir, ".credentials.json");
    const now = 1_790_000_000_000;
    await writeFile(creds, JSON.stringify({
      claudeAiOauth: { accessToken: "sk-test", expiresAt: now - 1_000 },
    }), "utf8");
    const { fetchImpl, calls } = stubFetch({});
    try {
      const monitor = new UsageMonitor({
        events: { emit: () => undefined },
        claudeCachePath: join(dir, "missing-cache.json"),
        claudeCredentialsPath: creds,
        codexSessionsRoot: join(dir, "no-codex"),
        fetchImpl,
        now: () => now,
        intervalMs: 60_000,
      });
      await (monitor as unknown as { tick: () => Promise<void> }).tick();
      expect(calls()).toBe(0);
      expect(monitor.getSnapshot().claude5h).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
