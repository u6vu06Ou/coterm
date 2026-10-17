// Phase 6 (work order §11): main-side voice turn orchestrator. It is the
// single route every voice/typed utterance takes, so desktop and mobile share
// ONE tool/policy path (§11.5):
//
//   1. deterministic fast intent  → AgentApiStateService template, no LLM
//   2. summary intent             → bounded briefs + supervisor synthesis
//                                   (disabled answer — supervisor removed
//                                   with the task center 2026-10-15)
//   3. relay intent               → unique-target atomic send+Enter, or a
//                                   spoken clarification (never guesses)
//   4. everything else            → supervisor bounded loop (same disabled
//                                   answer path)
//
// Safety contract the renderer leans on:
//   - every outbound answer passes redactEgress (§11.2: never read a key,
//     token, or secret-bearing path aloud — terminal titles/utterances can
//     contain planted secrets, so redaction wraps ALL sources)
//   - one in-flight deep-path turn at a time; `interrupt()` aborts it and
//     bumps the epoch so late output is unambiguously discardable (§11.3)
//   - memory turns are bounded and memory-only; nothing here writes SQLite
//   - deep paths (summary/relay/supervisor) require agentapi.voiceAgent; fast
//     status intents stay available even with the flag off (§14)

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  AppSettings,
  AgentApiPendingInteraction,
  AgentApiSessionWorldState,
  AgentApiVoiceTurnClarificationCandidate,
  AgentApiVoiceTurnResult,
  AgentApiVoiceTurnSource,
} from "@shared/types";
import { redactEgress } from "../security/redaction";
import { classifyAgentApiFastIntent, type AgentApiFastIntentKind, type AgentApiLocale } from "./agentapi-state-service";

// §10.4 target resolution (moved here from agentapi-tool-gateway when the
// task-center supervisor runtime was removed 2026-10-15 — the live-voice
// relay path is the only remaining consumer).
export const targetQuerySchema = z.object({
  terminalId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(160).optional(),
  label: z.string().trim().min(1).max(160).optional(),
  selected: z.boolean().optional(),
}).strict().refine(
  (value) => value.terminalId !== undefined || value.title !== undefined || value.label !== undefined || value.selected === true,
  "Provide a target: terminalId, title, label, or selected.",
);

export type AgentApiTargetQuery = z.infer<typeof targetQuerySchema>;

export interface AgentApiTargetCandidate {
  terminalId: string;
  title: string;
  projectLabel: string;
  displayState: string;
}

export type AgentApiTargetResolution =
  | { status: "ok"; session: AgentApiSessionWorldState }
  | { status: "not_found" }
  | { status: "ambiguous"; candidates: AgentApiTargetCandidate[] };

const MAX_SESSIONS_PER_LIST = 8;

/**
 * Target resolution. Order of authority: explicit terminalId, selected
 * session, unique title, unique project/session label. ANY input that matches
 * zero or more than one session is returned to the caller (the voice answer
 * turns `ambiguous` into a spoken clarification question) — never a guess.
 */
export function resolveAgentApiTarget(
  query: AgentApiTargetQuery,
  sessions: AgentApiSessionWorldState[],
): AgentApiTargetResolution {
  const visible = sessions.filter((session) => session.lifecycleStatus === "running");
  let matches: AgentApiSessionWorldState[];
  if (query.terminalId) {
    matches = visible.filter((session) => session.terminalId === query.terminalId);
  } else if (query.selected === true) {
    matches = visible.filter((session) => session.selected);
  } else if (query.title) {
    const wanted = query.title.trim().toLowerCase();
    matches = visible.filter((session) => session.displayName.trim().toLowerCase() === wanted);
  } else if (query.label) {
    const wanted = query.label.trim().toLowerCase();
    matches = visible.filter(
      (session) =>
        session.displayName.trim().toLowerCase() === wanted ||
        session.projectLabel.trim().toLowerCase() === wanted,
    );
  } else {
    matches = [];
  }
  if (matches.length === 1) return { status: "ok", session: matches[0]! };
  if (matches.length === 0) return { status: "not_found" };
  return {
    status: "ambiguous",
    candidates: matches.slice(0, MAX_SESSIONS_PER_LIST).map((session) => ({
      terminalId: session.terminalId,
      title: session.displayName,
      projectLabel: session.projectLabel,
      displayState: session.displayState,
    })),
  };
}

/**
 * Supervisor surface used by the voice deep paths (summary/supervisor). The
 * task-center supervisor runtime was removed 2026-10-15, so this dep is
 * optional; when absent, those turns answer with the disabled text while the
 * live-voice fast/relay paths stay fully available.
 */
export interface AgentApiVoiceSupervisorSurface {
  ask(question: string, options?: { signal?: AbortSignal }): Promise<string>;
  summarizeAllSessions(options?: { signal?: AbortSignal }): Promise<string>;
}

/** §11.1: bounded recent turns, memory-only. Never persisted to SQLite. */
export const AGENTAPI_VOICE_HISTORY_MAX_TURNS = 8;

const MAX_UTTERANCE_CHARS = 2_000;
const MAX_ANSWER_CHARS = 2_000;
const MAX_CLARIFICATION_CANDIDATES = 4;
const MAX_HISTORY_UTTERANCE_CHARS = 200;

const utteranceSchema = z.string().trim().min(1).max(MAX_UTTERANCE_CHARS);

export interface AgentApiVoiceOrchestratorDeps {
  worldState: {
    getWorldState(): AgentApiSessionWorldState[];
    answerFastIntent(kind: AgentApiFastIntentKind, locale?: AgentApiLocale): string;
  };
  /** Deep-path LLM loop. The task-center supervisor is gone 2026-10-15;
   * absent = summary/supervisor turns get the disabled answer. */
  supervisor?: AgentApiVoiceSupervisorSurface;
  pendingStore: {
    getActive(): AgentApiPendingInteraction[];
    getByTerminal(terminalId: string): AgentApiPendingInteraction | null;
  };
  /** Exact-once atomic send (payload + Enter is ONE PTY write). */
  sendToSession(input: { terminalId: string; message: string; clientMutationId: string }): unknown;
  getSettings(): AppSettings;
  now?: () => number;
}

export interface AgentApiVoiceRecentTurn {
  at: string;
  epoch: number;
  utterance: string;
  source: AgentApiVoiceTurnSource;
}

export class AgentApiVoiceOrchestrator {
  private epoch = 0;
  private currentController: AbortController | null = null;
  private readonly recentTurns: AgentApiVoiceRecentTurn[] = [];
  private readonly now: () => number;

  constructor(private readonly deps: AgentApiVoiceOrchestratorDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  getEpoch(): number {
    return this.epoch;
  }

  /** Bounded, memory-only diagnostics for the panel/dry-run view. */
  recentTurnHistory(): AgentApiVoiceRecentTurn[] {
    return this.recentTurns.map((turn) => ({ ...turn }));
  }

  /**
   * §11.3 barge-in: bump the epoch, then abort the in-flight deep-path turn.
   * The aborted turn's late output is never delivered: `turn()` checks its
   * epoch stamp before returning, so a superseded resolve drops its text.
   */
  interrupt(): { epoch: number; aborted: boolean } {
    this.epoch += 1;
    const controller = this.currentController;
    this.currentController = null;
    if (controller && !controller.signal.aborted) {
      controller.abort();
      return { epoch: this.epoch, aborted: true };
    }
    return { epoch: this.epoch, aborted: false };
  }

  /**
   * One voice turn. Returns null when the turn was interrupted before it
   * could produce an answer (the renderer drops the result regardless).
   *
   * Never throws for model-path failures: a degraded supervisor becomes a
   * short spoken-friendly answer instead of an IPC error (§14 failure
   * isolation — voice failure must not ripple into terminal/browser).
   */
  async turn(rawUtterance: unknown): Promise<AgentApiVoiceTurnResult | null> {
    const utterance = utteranceSchema.parse(rawUtterance);
    // Supersede any previous turn before routing.
    this.interrupt();
    const epoch = this.epoch;
    const controller = new AbortController();
    this.currentController = controller;
    const signal = controller.signal;
    const locale: AgentApiLocale = this.deps.getSettings().voice.responseLanguage;

    const finish = (
      source: AgentApiVoiceTurnSource,
      text: string,
      extra: Partial<Pick<AgentApiVoiceTurnResult, "targetTerminalId" | "targetTitle" | "clarification" | "spoken">> = {},
    ): AgentApiVoiceTurnResult | null => {
      // Late output from a superseded/aborted turn is discarded here (§11.3),
      // not at the caller: the result object itself is never handed out.
      if (signal.aborted || epoch !== this.epoch) return null;
      if (this.currentController === controller) this.currentController = null;
      const spokenText = redactEgress(text.slice(0, MAX_ANSWER_CHARS));
      this.recordTurn(epoch, utterance, source);
      return {
        epoch,
        text: spokenText,
        source,
        spoken: extra.spoken ?? true,
        targetTerminalId: extra.targetTerminalId ?? null,
        targetTitle: extra.targetTitle ?? null,
        clarification: extra.clarification ?? null,
      };
    };

    // 1. Deterministic fast intents: metadata-only template, no supervisor.
    const fastKind = classifyAgentApiFastIntent(utterance);
    if (fastKind) {
      return finish("fast", this.deps.worldState.answerFastIntent(fastKind, locale));
    }

    const voiceAgentOn = this.deps.getSettings().agentapi.voiceAgent === true;
    const disabledAnswer = (): string => voiceAgentDisabledText(locale);

    // 2. Contextual reply to an active pending interaction. Keep this before
    // summary/supervisor routing so a bare "2"/"好"/"繼續" can never be
    // interpreted as a fresh general question. With more than one pending
    // interaction we MUST ask which window; never pick selected/first by
    // accident. A resolved interaction disappears from the store, so stale
    // short replies cannot reach the old session.
    if (isContextualPendingReply(utterance)) {
      if (!voiceAgentOn) return finish("relay", disabledAnswer());
      const pending = this.deps.pendingStore.getActive();
      if (pending.length === 1) {
        const target = pending[0]!;
        const session = this.deps.worldState.getWorldState().find((entry) =>
          entry.terminalId === target.terminalId && entry.lifecycleStatus === "running");
        if (session && this.deps.pendingStore.getByTerminal(session.terminalId)?.id === target.id) {
          this.deps.sendToSession({
            terminalId: session.terminalId,
            message: utterance,
            clientMutationId: randomUUID(),
          });
          return finish("relay", pendingReplySentText(locale, session.displayName || session.projectLabel, utterance), {
            targetTerminalId: session.terminalId,
            targetTitle: session.displayName,
          });
        }
      }
      if (pending.length > 1) {
        const sessions = this.deps.worldState.getWorldState();
        const candidates: AgentApiVoiceTurnClarificationCandidate[] = pending
          .map((interaction) => sessions.find((entry) => entry.terminalId === interaction.terminalId))
          .filter((entry): entry is AgentApiSessionWorldState => Boolean(entry && entry.lifecycleStatus === "running"))
          .slice(0, MAX_CLARIFICATION_CANDIDATES)
          .map((entry) => ({
            terminalId: entry.terminalId,
            title: entry.displayName,
            projectLabel: entry.projectLabel,
            displayState: entry.displayState,
          }));
        if (candidates.length > 1) {
          return finish("relay", ambiguousPendingText(locale, candidates), {
            clarification: { candidates },
          });
        }
      }
      // No active pending interaction: do NOT reuse an old binding. Fall
      // through to the supervisor so the utterance is treated as fresh text.
    }

    // 3. Summary fan-in (§11.4): bounded briefs + supervisor synthesis.
    if (detectSummaryIntent(utterance)) {
      if (!voiceAgentOn || !this.deps.supervisor) return finish("summary", disabledAnswer());
      try {
        const text = await this.deps.supervisor.summarizeAllSessions({ signal });
        return finish("summary", text);
      } catch (error) {
        if (signal.aborted || epoch !== this.epoch) return null;
        return finish("summary", supervisorErrorText(locale, error));
      }
    }

    // 4. Deterministic relay intent (§11.4): unique target → atomic
    //    send+Enter; ambiguous/not-found → spoken clarification, never guess.
    const relay = parseRelayIntent(utterance);
    if (relay) {
      if (!voiceAgentOn) return finish("relay", disabledAnswer());
      return this.resolveRelay(relay, locale, finish);
    }

    // 5. Deep path: hidden supervisor bounded tool loop.
    if (!voiceAgentOn || !this.deps.supervisor) return finish("supervisor", disabledAnswer());
    try {
      const text = await this.deps.supervisor.ask(utterance, { signal });
      return finish("supervisor", text);
    } catch (error) {
      if (signal.aborted || epoch !== this.epoch) return null;
      return finish("supervisor", supervisorErrorText(locale, error));
    }
  }

  private resolveRelay(
    relay: { target: string; message: string },
    locale: AgentApiLocale,
    finish: (
      source: AgentApiVoiceTurnSource,
      text: string,
      extra?: Partial<Pick<AgentApiVoiceTurnResult, "targetTerminalId" | "targetTitle" | "clarification" | "spoken">>,
    ) => AgentApiVoiceTurnResult | null,
  ): AgentApiVoiceTurnResult | null {
    const sessions = this.deps.worldState.getWorldState();
    // Explicit-name resolution, title first then label (never a fuzzy guess).
    let resolution = relay.target === "__selected__"
      ? resolveAgentApiTarget({ selected: true }, sessions)
      : resolveAgentApiTarget({ title: relay.target }, sessions);
    if (resolution.status === "not_found" && relay.target !== "__selected__") {
      resolution = resolveAgentApiTarget({ label: relay.target }, sessions);
    }
    if (resolution.status === "ambiguous") {
      const candidates: AgentApiVoiceTurnClarificationCandidate[] =
        resolution.candidates.slice(0, MAX_CLARIFICATION_CANDIDATES).map((candidate) => {
          const session = sessions.find((entry) => entry.terminalId === candidate.terminalId);
          return {
            terminalId: candidate.terminalId,
            title: candidate.title,
            projectLabel: candidate.projectLabel,
            displayState: session?.displayState ?? "running",
          };
        });
      return finish("relay", ambiguousTargetText(locale, candidates), {
        clarification: { candidates },
        spoken: true,
      });
    }
    if (resolution.status === "not_found") {
      return finish("relay", targetNotFoundText(locale, relay.target), {
        targetTitle: relay.target === "__selected__" ? null : relay.target,
      });
    }
    const session = resolution.session;
    // Atomic exactly-once: single PTY write, idempotent via clientMutationId.
    this.deps.sendToSession({
      terminalId: session.terminalId,
      message: relay.message,
      clientMutationId: randomUUID(),
    });
    return finish("relay", relaySentText(locale, session.displayName || session.projectLabel, relay.message), {
      targetTerminalId: session.terminalId,
      targetTitle: session.displayName,
    });
  }

  private recordTurn(epoch: number, utterance: string, source: AgentApiVoiceTurnSource): void {
    this.recentTurns.push({
      at: new Date(this.now()).toISOString(),
      epoch,
      // The history is diagnostics-only but still crosses surfaces; redact
      // and truncate before it joins the in-memory ring. Never persisted.
      utterance: redactEgress(utterance.slice(0, MAX_HISTORY_UTTERANCE_CHARS)),
      source,
    });
    while (this.recentTurns.length > AGENTAPI_VOICE_HISTORY_MAX_TURNS) this.recentTurns.shift();
  }
}

/** §11.4 summary intent: zh + en, conservative whitelist of summary words. */
export function detectSummaryIntent(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  if (/摘要|總結|總覽|概覽/.test(normalized) && /每|各|全部|所有|念給我/.test(normalized)) return true;
  return /summar/i.test(normalized)
    && /\b(all|every|each)\b/.test(normalized)
    && /\b(windows?|panes?|sessions?|terminals?)\b/i.test(normalized);
}

/**
 * Deterministic relay parse (§11.4). Conservative by design — anything that
 * does not match EXACTLY falls through to the supervisor, which asks instead
 * of guessing. The trailing "並送出" filler is stripped because send+Enter is
 * already atomic in the exact-once path.
 */
export function parseRelayIntent(text: string): { target: string; message: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const zh = /^(?:請)?幫我(?:跟|和|向|對)(?<target>.+?)(?:視窗|窗|session)?(?:說|講|告訴(?:它|他|她)?)(?<message>.+)$/u.exec(trimmed);
  const en = /^tell\s/i.test(trimmed)
    ? /^tell\s+(?:the\s+)?(?<target>.+?)\s+(?:window|pane|session|terminal)\s+(?:to\s+say\s+|that\s+|I\s+want\s+)?(?<message>.+)$/i.exec(trimmed)
    : null;
  const match = zh ?? en;
  if (!match?.groups) return null;
  const target = cleanRelayTarget(match.groups.target ?? "");
  const message = (match.groups.message ?? "")
    .replace(/[，,、\s]*(?:並且?送出|幫我送出|and\s+send\s+it|then\s+press\s+enter)[。.\s]*$/iu, "")
    .trim();
  if (!target || !message || message.length > MAX_UTTERANCE_CHARS) return null;
  const targetIsSelected = /^(這個|這|目前|current|selected|current one)$/iu.test(target);
  return { target: targetIsSelected ? "__selected__" : target, message };
}

/** Conservative short-reply detector for pending interactions. It deliberately
 * does not match arbitrary prose: only compact acknowledgements, numeric/
 * letter choices, and common continuation/approval words are routed without
 * an explicit target. */
export function isContextualPendingReply(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized || normalized.length > 40) return false;
  if (/^(?:\d{1,2}|[a-z])(?:[.)、]?)$/i.test(normalized)) return true;
  return /^(?:好|好的|可以|同意|批准|繼續|继续|下一步|照做|就這樣|就这样|ok|okay|yes|no|continue|approve|approved|go ahead)$/iu.test(normalized);
}

function cleanRelayTarget(raw: string): string {
  return raw
    .trim()
    .replace(/^[「『"“']+/, "")
    .replace(/[」』"”']+$/, "")
    .trim();
}

function voiceAgentDisabledText(locale: AgentApiLocale): string {
  if (locale === "zh-TW") return "任務中心目前關閉；只能回答狀態類查詢。可在設定開啟語音助理。";
  if (locale === "zh-CN") return "任务中心目前关闭；只能回答状态类查询。可在设置中开启语音助理。";
  return "Mission Control is turned off; only status questions are available. Enable the voice agent in Settings.";
}

export function ambiguousTargetText(locale: AgentApiLocale, candidates: AgentApiTargetCandidate[]): string {
  const names = candidates.map((candidate) => candidate.title || candidate.projectLabel).slice(0, MAX_CLARIFICATION_CANDIDATES);
  if (locale === "zh-TW") return `有 ${candidates.length} 個視窗符合，請指定其中一個：${names.join("、")}。`;
  if (locale === "zh-CN") return `有 ${candidates.length} 个窗口符合，请指定其中一个：${names.join("、")}。`;
  return `${candidates.length} windows match; please name one of: ${names.join(", ")}.`;
}

export function targetNotFoundText(locale: AgentApiLocale, target: string): string {
  if (locale === "zh-TW") return `找不到名為「${target}」的視窗。`;
  if (locale === "zh-CN") return `找不到名为「${target}」的窗口。`;
  return `No window named "${target}" was found.`;
}

export function relaySentText(locale: AgentApiLocale, title: string, message: string): string {
  if (locale === "zh-TW") return `已送出到「${title}」，內容：${message}`;
  if (locale === "zh-CN") return `已发送到「${title}」，内容：${message}`;
  return `Sent to "${title}": ${message}`;
}

export function pendingReplySentText(locale: AgentApiLocale, title: string, message: string): string {
  if (locale === "zh-TW") return `已回覆「${title}」：${message}`;
  if (locale === "zh-CN") return `已回复「${title}」：${message}`;
  return `Replied to "${title}": ${message}`;
}

export function ambiguousPendingText(locale: AgentApiLocale, candidates: AgentApiVoiceTurnClarificationCandidate[]): string {
  const names = candidates.map((candidate) => candidate.title || candidate.projectLabel);
  if (locale === "zh-TW") return `有 ${candidates.length} 個視窗正在等你的回答：${names.join("、")}。你要回哪一個？`;
  if (locale === "zh-CN") return `有 ${candidates.length} 个窗口正在等你的回答：${names.join("、")}。你要回哪一个？`;
  return `${candidates.length} windows are waiting for your reply: ${names.join(", ")}. Which one should I answer?`;
}

function supervisorErrorText(locale: AgentApiLocale, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  const safe = redactEgress(reason).slice(0, 120);
  if (locale === "zh-TW") return `任務中心暫時無法回應（${safe}）。狀態查詢仍可正常運作。`;
  if (locale === "zh-CN") return `任务中心暂时无法回应（${safe}）。状态查询仍可正常运行。`;
  return `Mission Control could not answer (${safe}). Status queries still work.`;
}
