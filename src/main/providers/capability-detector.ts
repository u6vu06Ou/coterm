import { spawn } from "node:child_process";
import {
  type AgentOption,
  type ProviderProbeState,
  type ProviderStatus,
} from "@shared/types";
import { deriveAgentOptions } from "@shared/agent-options";
import type { CustomProfileEntry } from "@shared/schema";
import { resolveModelFamily, type ResolvedModelFamily } from "@shared/model-families";
import { resolveCliExecutable, type CliName } from "./executables";

// Provider capability + liveness detection.
//
// Two rules this file exists to enforce:
//
// 1. Membership follows the ACTIVE profile table (built-ins ⊕ the hot model
//    registry), never a hand-written list. The old fixed 11-entry table left
//    every hot-registered model (my-kimi, deepseek, …) without a status row, so
//    the picker rendered a live model as「未安裝」.
// 2. A state is only shown when a probe observed it. The proxy's /v1/models
//    alias table is static — it still advertises my-glm-max, which answers 502 —
//    so 線上 requires a confirmed 2xx, 已下架 comes from the family table, and
//    429/額度 is its own state instead of「離線」or「線上」.
//
// Cost control (the 全域搜尋 LAG lesson: never turn opening a dialog into a
// full-list scan): the alias table is ONE GET and doubles as the proxy-alive
// probe; CLI presence/auth is one cached spawn set; per-model pings are
// TTL-cached, in-flight-deduped, capped in concurrency and capped per call,
// with the caller's `focus` rows taking the slots first. Callers render from
// the previous set and refill asynchronously.

export const PROXY_MODELS_TTL_MS = 45_000;
export const MODEL_PING_TTL_MS = 90_000;
export const CLI_PROBE_TTL_MS = 120_000;
const PROXY_MODELS_TIMEOUT_MS = 4_000;
const MODEL_PING_TIMEOUT_MS = 5_000;
const PING_CONCURRENCY = 3;
const PING_BUDGET_PER_CALL = 6;
const OFFLINE_CATALOG_TTL_MS = 20_000;
const QUOTA_HINT = /(429|quota|rate.?limit|limit exceeded|額度)/i;
const UNAVAILABLE_HINT = /(invalid model|unknown model|no such model|not found|unavailable|下架|退役)/i;

/** Only the per-profile endpoint fields this detector consumes. */
export type ProfileRouteOverrides = Record<
  string,
  { baseUrl?: string | undefined; authToken?: string | undefined } | undefined
>;

export interface DetectProvidersInput {
  proxyUrl: string;
  authToken: string;
  /** ACTIVE profile table (built-ins ⊕ settings.customProfiles): endpoint overrides. */
  profiles?: ProfileRouteOverrides | null;
  /**
   * settings.customProfiles, used to derive the roster when `options` is not
   * passed. Kept separate from `profiles` because the built-in table carries a
   * wider env shape than the settings entries the registry derives from.
   */
  customProfiles?: Record<string, CustomProfileEntry> | null;
  /** Pre-derived roster; defaults to deriveAgentOptions(profiles). */
  options?: AgentOption[] | null;
  /** Ignore every TTL and re-probe (the picker's 重探钮). */
  force?: boolean;
  /** Profile ids the user is looking at: they get this call's ping budget. */
  focus?: readonly string[] | null;
  /** Per-probe TTL override for tests; omit in production. */
  now?: () => number;
  cliCooldownMs?: number;
}

interface ProbeResult {
  state: ProviderProbeState;
  detail: string;
  /** Only a confirmed HTTP 2xx (or a logged-in CLI) may read as 線上. */
  confirmed: boolean;
  checkedAt: number;
}

interface ProxyCatalog {
  online: boolean;
  aliases: Set<string>;
  result: ProbeResult;
}

interface CliSet {
  claude: CommandResult;
  codex: CommandResult;
  gemini: CommandResult;
  claudeAuth: boolean | null;
  codexAuth: boolean;
}

interface CommandResult {
  ok: boolean;
  output: string;
}

interface ProbePlan {
  key: string;
  kind: "catalog" | "ping" | "proxy-down";
  baseUrl: string;
  authToken: string;
  model: string;
  members: string[];
  /** Set when the alias table does not carry this model name. */
  note?: string | undefined;
  result?: ProbeResult | undefined;
}

interface Row {
  option: AgentOption;
  family: ResolvedModelFamily;
  plan: ProbePlan | null;
}

const probeCache = new Map<string, { value: ProbeResult; expiresAt: number }>();
const inFlight = new Map<string, Promise<ProbeResult>>();
let catalogCache: { key: string; expiresAt: number; value: ProxyCatalog } | null = null;
let cliCache: { value: CliSet; at: number } | null = null;
let pingCursor = 0;
let councilResult: ProbeResult | null = null;

function runCommand(command: CliName, args: string[], timeoutMs = 8_000): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(resolveCliExecutable(command), args, {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, output: "" });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: Buffer.concat(chunks).toString("utf8").trim() });
    });
  });
}

/**
 * CLI presence + login for all three harnesses in one batch. Spawning five
 * Node CLIs costs seconds, so non-interactive callers (diagnostics, /health,
 * the agent launcher) reuse the last set; only the picker's 重探钮 forces a
 * fresh spawn.
 */
async function cliSet(force: boolean, now: number, params: DetectProvidersInput): Promise<CliSet> {
  const cooldown = params.cliCooldownMs ?? CLI_PROBE_TTL_MS;
  if (!force && cliCache && now - cliCache.at < cooldown) return cliCache.value;
  const [claude, codex, gemini, claudeAuthResult, codexAuthResult] = await Promise.all([
    runCommand("claude", ["--version"]),
    runCommand("codex", ["--version"]),
    runCommand("gemini", ["--version"]),
    runCommand("claude", ["auth", "status", "--json"]),
    runCommand("codex", ["login", "status"]),
  ]);
  const value: CliSet = {
    claude,
    codex,
    gemini,
    claudeAuth: parseClaudeAuth(claudeAuthResult.output),
    codexAuth: codexAuthResult.ok && /logged in/i.test(codexAuthResult.output),
  };
  cliCache = { value, at: now };
  return value;
}

/** One GET for the whole alias table; its failure IS the proxy-offline signal. */
async function proxyCatalog(
  baseUrl: string,
  authToken: string,
  force: boolean,
  now: number,
): Promise<ProxyCatalog> {
  const key = `${norm(baseUrl)}|${digest(authToken)}`;
  if (!force && catalogCache && catalogCache.key === key && catalogCache.expiresAt > now) {
    return catalogCache.value;
  }
  let value: ProxyCatalog;
  try {
    const response = await fetch(`${norm(baseUrl)}/v1/models`, {
      headers: { "x-api-key": authToken, authorization: `Bearer ${authToken}` },
      signal: AbortSignal.timeout(PROXY_MODELS_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = (await response.json()) as { data?: { id?: unknown }[] };
    const aliases = new Set<string>();
    for (const entry of parsed.data ?? []) {
      if (typeof entry?.id === "string") aliases.add(entry.id.trim().toLowerCase());
    }
    value = {
      online: true,
      aliases,
      result: {
        state: "online",
        detail: `橋接 proxy 在線（${aliases.size || "?"} 個別名）。`,
        confirmed: true,
        checkedAt: now,
      },
    };
  } catch {
    value = {
      online: false,
      aliases: new Set(),
      result: {
        state: "offline",
        detail: "橋接 proxy 連不上（連別名表都拿不到）。",
        confirmed: false,
        checkedAt: now,
      },
    };
  }
  catalogCache = {
    key,
    value,
    expiresAt: now + (value.online ? PROXY_MODELS_TTL_MS : OFFLINE_CATALOG_TTL_MS),
  };
  return value;
}

export function classifyPing(status: number, body: string, checkedAt: number): ProbeResult {
  if (status >= 200 && status < 300) {
    return { state: "online", detail: "模型回應正常。", confirmed: true, checkedAt };
  }
  if (status === 429 || QUOTA_HINT.test(body)) {
    return {
      state: "rate_limited",
      detail: "今日額度用完（隔天重置後自動恢復）。",
      confirmed: false,
      checkedAt,
    };
  }
  if (status >= 500) {
    return { state: "offline", detail: `上游錯誤 HTTP ${status}。`, confirmed: false, checkedAt };
  }
  if (UNAVAILABLE_HINT.test(body)) {
    return {
      state: "offline",
      detail: `這個模型現在找不到（HTTP ${status}）。`,
      confirmed: false,
      checkedAt,
    };
  }
  // Any other 4xx still proves the route itself resolved and is wired up.
  return { state: "online", detail: `路線已接通（HTTP ${status}）。`, confirmed: true, checkedAt };
}

function pingCacheKey(baseUrl: string, authToken: string, model: string): string {
  return `ping:${norm(baseUrl)}|${norm(model)}|${digest(authToken)}`;
}

/** One tiny completion per backend: 200 confirms the chain all the way up. */
async function pingModel(
  baseUrl: string,
  authToken: string,
  model: string,
  now: number,
): Promise<ProbeResult> {
  const key = pingCacheKey(baseUrl, authToken, model);
  const cached = probeCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const probe = (async (): Promise<ProbeResult> => {
    try {
      const response = await fetch(`${norm(baseUrl)}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": authToken },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
        signal: AbortSignal.timeout(MODEL_PING_TIMEOUT_MS),
      });
      const body = response.ok ? "" : (await response.text().catch(() => "")).slice(0, 400);
      const value = classifyPing(response.status, body, now);
      probeCache.set(key, { value, expiresAt: now + MODEL_PING_TTL_MS });
      return value;
    } catch (error) {
      const value: ProbeResult = {
        state: "offline",
        detail: `連線失敗：${error instanceof Error ? error.message : String(error)}`,
        confirmed: false,
        checkedAt: now,
      };
      probeCache.set(key, { value, expiresAt: now + OFFLINE_CATALOG_TTL_MS });
      return value;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, probe);
  return probe;
}

export async function detectProviders(
  input: string | DetectProvidersInput,
  legacyAuthToken = "",
): Promise<ProviderStatus[]> {
  const params: DetectProvidersInput =
    typeof input === "string" ? { proxyUrl: input, authToken: legacyAuthToken } : input;
  const now = params.now?.() ?? Date.now();
  const force = params.force === true;
  const roster = params.options?.length
    ? params.options
    : deriveAgentOptions(params.customProfiles ?? null);
  const cli = await cliSet(force, now, params);
  const catalog = await proxyCatalog(params.proxyUrl, params.authToken, force, now);

  // One plan per distinct route: claude-local-main and codex-local-main are the same model on
  // the same bridge, so they share a probe instead of costing four requests.
  const plans = new Map<string, ProbePlan>();
  const rows: Row[] = roster.map((option) => {
    const family = resolveModelFamily(
      option.model ?? option.codex?.model ?? option.id,
    );
    const plan = planRoute(option, family, params, catalog);
    if (plan) {
      const existing = plans.get(plan.key);
      if (existing) {
        if (!existing.members.includes(option.id)) existing.members.push(option.id);
        return { option, family, plan: existing };
      }
      plans.set(plan.key, plan);
    }
    return { option, family, plan };
  });

  const focus = new Set(params.focus ?? []);
  const targets = selectProbeTargets(
    [...plans.values()].filter((plan) => plan.kind === "ping"),
    focus,
    now,
  );
  await runBounded(targets, async (plan) => {
    plan.result = await pingModel(plan.baseUrl, plan.authToken, plan.model, now);
  });
  // Routes outside this round's budget keep no result and render 偵測中. They
  // are deliberately NOT probed here: "finish the rest" is exactly the
  // full-list scan this cap exists to prevent; the next round picks them up.
  councilResult = summarizeCouncil([...plans.values()], now, catalog);

  return rows.map((row) => buildStatus(row, params, cli, catalog, now));
}

function planRoute(
  option: AgentOption,
  family: ResolvedModelFamily,
  params: DetectProvidersInput,
  catalog: ProxyCatalog,
): ProbePlan | null {
  // Official/paid rows are answered by the CLI, gemini by its own binary:
  // neither may be judged by a proxy ping.
  if (!option.local || option.harness === "other" || option.id === "council") return null;
  if (family.retired) return null;
  const model = (option.model ?? option.codex?.model ?? family.canonical).trim();
  const baseUrl = profileBaseUrl(option.id, params);
  const listed =
    catalog.aliases.has(norm(model)) || catalog.aliases.has(norm(family.canonical));
  if (!catalog.online) {
    return {
      key: `down:${baseUrl}`,
      kind: "proxy-down",
      baseUrl,
      authToken: profileAuthToken(option.id, params),
      model,
      members: [option.id],
      result: catalog.result,
    };
  }
  // A known alias riding on a live catalog is already answered by that single
  // GET; anything unlisted (or a profile with its own endpoint) needs the ping.
  const knownAlias = family.family !== null && listed && baseUrl === norm(params.proxyUrl);
  if (knownAlias) {
    return {
      key: `catalog:${norm(params.proxyUrl)}|${family.canonical}`,
      kind: "catalog",
      baseUrl,
      authToken: profileAuthToken(option.id, params),
      model,
      members: [option.id],
      result: catalog.result,
    };
  }
  return {
    key: `ping:${norm(baseUrl)}|${family.canonical}`,
    kind: "ping",
    baseUrl,
    authToken: profileAuthToken(option.id, params),
    model,
    members: [option.id],
    ...(listed
      ? {}
      : { note: "proxy 別名表查無此模型名（可能尚未登記或已換代）。" }),
  };
}

function summarizeCouncil(plans: ProbePlan[], now: number, catalog: ProxyCatalog): ProbeResult | null {
  const seats = plans.filter((plan) => plan.kind !== "proxy-down");
  if (seats.length === 0) {
    return catalog.online ? null : { ...catalog.result, checkedAt: now };
  }
  const online = seats.some((plan) => plan.result?.state === "online");
  const quota = seats.some((plan) => plan.result?.state === "rate_limited");
  return {
    state: online ? "online" : quota ? "rate_limited" : "offline",
    detail: online
      ? "免費席位至少一席回應正常，council 可開席。"
      : quota
        ? "免費席位今日額度用完（隔天重置後自動恢復）。"
        : "免費席位全都叫不動，council 暫停開席。",
    confirmed: online,
    checkedAt: now,
  };
}

/**
 * Ping budget. Catalog-decided routes never reach here, so the budget only goes
 * to models that need proof: focus rows first, then a rotating slice so a
 * long-tail model is not starved by whichever model happens to sort first.
 */
function selectProbeTargets(
  plans: ProbePlan[],
  focus: Set<string>,
  now: number,
): ProbePlan[] {
  const stale = plans.filter(
    (plan) => !isPingFresh(plan.baseUrl, plan.authToken, plan.model, now),
  );
  if (stale.length === 0) return [];
  const focused = stale.filter((plan) => plan.members.some((id) => focus.has(id)));
  const rest = stale.filter((plan) => !plan.members.some((id) => focus.has(id)));
  // The budget caps the round even when the caller focused everything: a list
  // of twelve converges in two rounds instead of firing twelve requests.
  const head = focused.slice(0, PING_BUDGET_PER_CALL);
  const slots = Math.max(0, PING_BUDGET_PER_CALL - head.length);
  const start = rest.length > 0 ? pingCursor % rest.length : 0;
  pingCursor = rest.length > 0 ? (start + 1) % rest.length : 0;
  return [...head, ...rotate(rest, start).slice(0, slots)];
}

function rotate<T>(items: T[], start: number): T[] {
  if (items.length === 0) return [];
  const point = ((start % items.length) + items.length) % items.length;
  return [...items.slice(point), ...items.slice(0, point)];
}

function isPingFresh(baseUrl: string, authToken: string, model: string, now: number): boolean {
  const cached = probeCache.get(pingCacheKey(baseUrl, authToken, model));
  return cached !== undefined && cached.expiresAt > now;
}

async function runBounded<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(PING_CONCURRENCY, items.length) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const item = items[index];
        if (item === undefined) return;
        await work(item);
      }
    }),
  );
}

function buildStatus(
  row: Row,
  params: DetectProvidersInput,
  cli: CliSet,
  catalog: ProxyCatalog,
  now: number,
): ProviderStatus {
  const { option, family } = row;
  const base = {
    id: option.id,
    label: option.label ?? option.id,
    backend: family.canonical,
    ...(family.family ? { backendLabel: family.label } : {}),
  };
  const capabilities = capabilitiesFor(option);

  if (!option.local || option.harness === "other") {
    const local = localProbe(option, cli);
    return {
      ...base,
      version: local.version,
      installed: local.installed,
      authenticated: local.auth,
      online: local.state === "online",
      state: local.state,
      source: "cli",
      checkedAt: now,
      detail: local.detail,
      capabilities,
    };
  }

  if (option.id === "council") {
    const probe = councilResult ?? { ...catalog.result, checkedAt: now };
    return {
      ...base,
      version: "native-v1",
      installed: cli.claude.ok,
      authenticated: probe.confirmed,
      online: probe.confirmed,
      state: probe.state,
      source: "inherited",
      checkedAt: probe.checkedAt,
      detail: probe.detail,
      capabilities,
    };
  }

  if (family.retired) {
    return {
      ...base,
      version: null,
      installed: true,
      authenticated: false,
      online: false,
      state: "retired",
      source: "registry",
      checkedAt: now,
      detail: family.note ?? "這個模型已永久下架。",
      capabilities,
    };
  }

  const probe = row.plan?.result ?? {
    state: catalog.online ? ("unknown" as const) : ("offline" as const),
    detail: catalog.online ? "本輪偵測額度已用罄，下次開啟清單會補偵測。" : catalog.result.detail,
    confirmed: false,
    checkedAt: now,
  };
  return {
    ...base,
    version: null,
    installed: true,
    authenticated: probe.confirmed,
    online: probe.confirmed,
    state: probe.state,
    source: profileBaseUrl(option.id, params) === norm(params.proxyUrl) ? "proxy" : "direct",
    checkedAt: probe.checkedAt,
    detail: probe.detail,
    capabilities,
  };
}

interface LocalProbe {
  installed: boolean;
  version: string | null;
  auth: boolean | null;
  state: ProviderProbeState;
  detail: string;
}

/**
 * Official/paid rows are judged by the CLI's own login, never by a proxy ping
 * (a free-bridge outage says nothing about a real Claude/Codex login).
 */
function localProbe(option: AgentOption, cli: CliSet): LocalProbe {
  if (option.harness === "other" || option.id === "gemini") {
    return {
      installed: cli.gemini.ok,
      version: cli.gemini.output || null,
      auth: cli.gemini.ok ? true : null,
      state: cli.gemini.ok ? "online" : "offline",
      detail: cli.gemini.ok ? "Gemini CLI 就緒（啟動時注入金鑰）。" : "找不到 Gemini CLI。",
    };
  }
  if (option.id === "codex-official") {
    return {
      installed: cli.codex.ok,
      version: cli.codex.output || null,
      auth: cli.codex.ok ? cli.codexAuth : null,
      state: cli.codex.ok && cli.codexAuth ? "online" : "offline",
      detail: !cli.codex.ok
        ? "找不到 Codex CLI。"
        : cli.codexAuth
          ? "Codex app-server 協定可用且已登入。"
          : "Codex 未登入。",
    };
  }
  return {
    installed: cli.claude.ok,
    version: cli.claude.output || null,
    auth: cli.claude.ok ? cli.claudeAuth : null,
    state: cli.claude.ok && cli.claudeAuth ? "online" : "offline",
    detail: !cli.claude.ok
      ? "找不到 Claude Code CLI。"
      : cli.claudeAuth === true
        ? "沿用既有 Claude Code 登入。"
        : "Claude Code 未登入（或 token 失效）。",
  };
}

const FREE_CLAUDE_CAPABILITIES = {
  sessions: true,
  structuredEvents: true,
  tools: true,
  mcp: true,
  skills: true,
  images: true,
  approvals: false,
  tokenUsage: true,
};
const CODEX_CAPABILITIES = {
  sessions: true,
  structuredEvents: true,
  tools: true,
  mcp: true,
  skills: true,
  images: false,
  approvals: true,
  tokenUsage: true,
};

function capabilitiesFor(option: AgentOption): ProviderStatus["capabilities"] {
  if (option.id === "council") {
    return {
      sessions: false,
      structuredEvents: true,
      tools: false,
      mcp: false,
      skills: false,
      images: false,
      approvals: false,
      tokenUsage: false,
    };
  }
  if (option.harness === "codex") return { ...CODEX_CAPABILITIES };
  if (option.harness === "other") {
    return {
      sessions: true,
      structuredEvents: false,
      tools: true,
      mcp: true,
      skills: true,
      images: true,
      approvals: true,
      tokenUsage: false,
    };
  }
  return { ...FREE_CLAUDE_CAPABILITIES };
}

function profileBaseUrl(profileId: string, params: DetectProvidersInput): string {
  return norm(params.profiles?.[profileId]?.baseUrl || params.proxyUrl);
}

function profileAuthToken(profileId: string, params: DetectProvidersInput): string {
  return params.profiles?.[profileId]?.authToken || params.authToken;
}

function norm(value: string): string {
  return value.replace(/\/+$/, "").trim().toLowerCase();
}

/** Short non-cryptographic digest: stable cache keys without holding tokens. */
function digest(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function parseClaudeAuth(output: string): boolean | null {
  try {
    const parsed = JSON.parse(output) as { loggedIn?: unknown };
    return typeof parsed.loggedIn === "boolean" ? parsed.loggedIn : null;
  } catch {
    return null;
  }
}

/** For tests and the 重探钮: drop every TTL so the next call re-probes. */
export function resetProviderProbeCache(): void {
  probeCache.clear();
  inFlight.clear();
  catalogCache = null;
  cliCache = null;
  pingCursor = 0;
  councilResult = null;
}
