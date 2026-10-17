import { createHash } from "node:crypto";
import { logger } from "../core/logger";

/**
 * Jev 注意力複判 (2026-09-26 maintainer): a second opinion from Jev — a
 * multiple-choice-only judge model (`typesafe-ai/jev` via the Vercel AI
 * Gateway `evaluation-model` endpoint) — at the ONE moment the heuristic
 * quiet-debounce is about to declare an agent terminal "done".
 *
 * The regex/quiet rules miss two things: a prompt the rules don't recognise
 * (the agent is really waiting on the human → should light attention) and a
 * long silent step (still working → "done" is premature). Jev answers one
 * choice question over the screen tail; the caller only acts on a confident
 * answer and otherwise keeps the original verdict.
 *
 * Contract:
 * - Fail-open: any error / timeout / low confidence / breaker open → null,
 *   and the caller behaves exactly as before.
 * - Privacy: only the last lines of the visible screen are sent, capped and
 *   scrubbed (home-dir user names, token-shaped strings). Nothing screen-
 *   derived is logged — only the verdict, confidence, and latency (§A.2).
 * - Opt-in: disabled unless settings.jev.enabled AND an API key is present.
 */

export type JevQuietVerdict = "waiting_input" | "turn_done" | "still_working";

function isJevQuietVerdict(v: string | undefined): v is JevQuietVerdict {
  return v === "waiting_input" || v === "turn_done" || v === "still_working";
}

export interface JevVerifierConfig {
  enabled: boolean;
  apiKey: string;
}

export interface JevVerdictResult {
  verdict: JevQuietVerdict;
  confidence: number;
}

const GATEWAY_URL = "https://ai-gateway.vercel.sh/v4/ai/evaluation-model";
const MODEL_ID = "typesafe-ai/jev";
const TIMEOUT_MS = 4_000;
const TAIL_LINES = 15;
const TAIL_CHARS = 1_200;
/** bench calibration: right answers ≈0.95, wrong ≈0.57 → act only above this. */
export const JEV_MIN_CONFIDENCE = 0.8;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 200;
const BREAKER_FAILURES = 3;
const BREAKER_COOLDOWN_MS = 10 * 60_000;
const CONFIG_TTL_MS = 5_000;

const QUESTION = {
  state: {
    type: "choice",
    instructions:
      "This is the bottom of an AI coding agent's terminal screen (Claude Code, Codex, or similar) right after its output went quiet. What is the agent doing now?",
    criteria: {
      waiting_input:
        "Waiting for the human: a permission/approval prompt, a yes/no or numbered choice, a question to the user, or a request to type something before it can continue.",
      turn_done:
        "Finished its turn: it printed a final answer or summary and the normal empty input prompt is shown, ready for a new instruction.",
      still_working:
        "Still working: a spinner, progress/thinking indicator, running tool or command, or streaming output that has not finished yet.",
    },
  },
} as const;

/**
 * Scrub secrets and identifiers BEFORE anything is cut (council 2026-09-26:
 * scrubbing an already-tail-capped string lets a token straddling the cut
 * point escape every prefix rule, because its head is gone).
 */
function scrubSensitive(text: string): string {
  // council 2026-09-26 R4 #1: gap-closed set — JWT/AIza/npm_/glpat-/full xox
  // ranges, single-quoted AND double-quoted assignment values, suffix-style
  // env names (AWS_SECRET_ACCESS_KEY=…), connection strings. The old generic
  // "40+ char blob" rule was dropped: it false-flagged git SHAs / diff lines,
  // which would have kept every verdict stuck at low confidence.
  return text
    .replace(/([A-Za-z]:[\\/]Users[\\/])[^\\/\s]+/gi, "$1<user>")
    .replace(/(\/(?:home|Users)\/)[^/\s]+/gi, "$1<user>")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[^]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer <redacted>")
    .replace(/AKIA[0-9A-Z]{16}/g, "<redacted>")
    .replace(/glpat-[A-Za-z0-9_-]{16,}/g, "<redacted>")
    .replace(/xox[baprs]-[A-Za-z0-9-]{10,}/g, "<redacted>")
    .replace(/AIza[A-Za-z0-9_-]{20,}/g, "<redacted>")
    .replace(/npm_[A-Za-z0-9]{30,}/g, "<redacted>")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "<redacted>")
    .replace(/\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s"'@/]+:[^\s"'@]+@/gi, "<redacted>")
    .replace(/((?:password|passwd|secret|token|api[_-]?key|[A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASS|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*)["']?[^\s"']{4,}["']?/gi, "$1<redacted>")
    .replace(/\b(?:sk|pk|rk|ghp|gho)[-_][A-Za-z0-9_-]{12,}/g, "<redacted>");
}

/** Last visible lines, capped and scrubbed before leaving the machine. */
export function prepareJevScreenTail(screenText: string): string {
  const scrubbed = scrubSensitive(screenText);
  const lines = scrubbed.replace(/\r/g, "").split("\n").map((line) => line.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  let tail = lines.slice(-TAIL_LINES).join("\n");
  if (tail.length > TAIL_CHARS) tail = tail.slice(-TAIL_CHARS);
  return tail;
}

export class JevVerifier {
  private readonly cache = new Map<string, { at: number; result: JevVerdictResult | null }>();
  private consecutiveFailures = 0;
  private breakerOpenUntil = 0;
  private configCache: { at: number; value: JevVerifierConfig | null } | null = null;

  constructor(
    private readonly getConfig: () => JevVerifierConfig | null,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  isEnabled(): boolean {
    return this.safeConfig() !== null;
  }

  /**
   * Fail-open config read (council 2026-09-26 #1): a throwing getSettings or a
   * non-string apiKey must NEVER escape — Jev is an optional second opinion,
   * so any config problem means "disabled". A 5s TTL (#8) keeps the per-chunk
   * isEnabled() call off the settings DB on the hot path.
   */
  private safeConfig(): JevVerifierConfig | null {
    const now = this.now();
    if (this.configCache && now - this.configCache.at < CONFIG_TTL_MS) return this.configCache.value;
    let value: JevVerifierConfig | null = null;
    try {
      const config = this.getConfig();
      if (config?.enabled && typeof config.apiKey === "string" && config.apiKey.trim()) {
        value = { enabled: true, apiKey: config.apiKey };
      }
    } catch {
      value = null;
    }
    this.configCache = { at: now, value };
    return value;
  }

  /** Confident verdict for a quiet agent screen, or null (= keep the rules). */
  async classifyQuietScreen(screenText: string | null): Promise<JevVerdictResult | null> {
    const config = this.safeConfig();
    if (!config || !screenText) return null;
    if (this.now() < this.breakerOpenUntil) return null;
    const tail = prepareJevScreenTail(screenText);
    if (!tail.trim()) return null;

    const key = createHash("sha256").update(tail).digest("hex");
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < CACHE_TTL_MS) return cached.result;

    const startedAt = this.now();
    try {
      const response = await this.fetchImpl(GATEWAY_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey.trim()}`,
          "content-type": "application/json",
          "ai-gateway-protocol-version": "0.0.1",
          "ai-evaluation-model-specification-version": "4",
          "ai-model-id": MODEL_ID,
        },
        body: JSON.stringify({ state: tail, questions: QUESTION }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as {
        answers?: { state?: { type?: string; choice?: string; probabilities?: Record<string, number> } };
      };
      const answer = body.answers?.state;
      const choice = answer?.choice;
      if (!isJevQuietVerdict(choice)) {
        throw new Error("unexpected answer shape");
      }
      const confidence = Number(answer?.probabilities?.[choice] ?? 0);
      this.consecutiveFailures = 0;
      const result = confidence >= JEV_MIN_CONFIDENCE ? { verdict: choice, confidence } : null;
      this.remember(key, result);
      logger.info("pty", "jev.quiet.verdict", "Jev judged a quiet agent screen.", {
        verdict: choice,
        confidence,
        acted: result !== null,
        latencyMs: this.now() - startedAt,
      });
      return result;
    } catch (error) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= BREAKER_FAILURES) {
        this.breakerOpenUntil = this.now() + BREAKER_COOLDOWN_MS;
        this.consecutiveFailures = 0;
      }
      logger.warn("pty", "jev.quiet.failed", "Jev second opinion failed; keeping the heuristic verdict.", {
        error: error instanceof Error ? error.message.slice(0, 120) : "unknown",
        latencyMs: this.now() - startedAt,
        breakerOpen: this.now() < this.breakerOpenUntil,
      });
      return null;
    }
  }

  private remember(key: string, result: JevVerdictResult | null): void {
    if (this.cache.size >= CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { at: this.now(), result });
  }
}
