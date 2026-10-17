import { randomUUID } from "node:crypto";
import type {
  NormalizedEvent,
  PtyStateChanged,
  TerminalTranscript,
  TerminalTranscriptMessage,
  AgentApiAgentIdentity,
  AgentApiPendingInteraction,
  AgentApiPendingInteractionOption,
  AgentApiSemanticSource,
  AgentApiSessionWorldState,
} from "@shared/types";
import { redactEgress } from "../security/redaction";
import type { AppEventBus } from "./event-bus";
import type { PendingInteractionStore } from "./agentapi-pending-interaction-store";
import type { SessionSemanticStore } from "./session-semantic-store";

const MAX_SEMANTIC_TEXT = 2_000;
const MAX_SUMMARY_TEXT = 320;
const MAX_PENDING_PROMPT = 1_500;
const MAX_PENDING_OPTIONS = 12;

export interface AgentApiSemanticProjectorDeps {
  events: AppEventBus;
  worldState: {
    getWorldState(): AgentApiSessionWorldState[];
    onWorldChanged(callback: (sessions: AgentApiSessionWorldState[]) => void): () => void;
  };
  semanticStore: SessionSemanticStore;
  pendingStore: PendingInteractionStore;
  getTranscript(terminalId: string): Promise<TerminalTranscript>;
  getScreenText(terminalId: string): string | null;
  now?: () => number;
}

/**
 * Projects existing provider/transcript/detector signals into bounded semantic
 * state. It never speaks, never writes to PTY, never calls an LLM, and never
 * stores raw screen/transcript bodies.
 */
export class AgentSemanticProjector {
  private readonly disposers: Array<() => void> = [];
  private readonly refreshGeneration = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly deps: AgentApiSemanticProjectorDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    this.syncWorld(this.deps.worldState.getWorldState());
    this.disposers.push(this.deps.worldState.onWorldChanged((sessions) => this.syncWorld(sessions)));

    const onEvent = (event: NormalizedEvent): void => this.onProviderEvent(event);
    const onPtyState = (change: PtyStateChanged): void => this.onPtyStateChanged(change);
    const onExit = (payload: { terminalId: string }): void => this.clearTerminal(payload.terminalId);
    this.deps.events.on("event", onEvent);
    this.deps.events.on("ptyStateChanged", onPtyState);
    this.deps.events.on("terminalExit", onExit);
    this.disposers.push(() => this.deps.events.off("event", onEvent));
    this.disposers.push(() => this.deps.events.off("ptyStateChanged", onPtyState));
    this.disposers.push(() => this.deps.events.off("terminalExit", onExit));
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    for (const terminalId of this.refreshGeneration.keys()) this.bumpGeneration(terminalId);
  }

  /** Exposed for focused tests and explicit one-shot hydration. */
  async refreshTranscript(terminalId: string): Promise<void> {
    const generation = this.bumpGeneration(terminalId);
    let transcript: TerminalTranscript;
    try {
      transcript = await this.deps.getTranscript(terminalId);
    } catch {
      transcript = { terminalId, status: "error", provider: "unknown", messages: [] };
    }
    if (this.refreshGeneration.get(terminalId) !== generation) return;

    const world = this.deps.worldState.getWorldState().find((session) => session.terminalId === terminalId);
    if (!world || world.lifecycleStatus !== "running") return;

    const messages = transcript.messages ?? [];
    const latest = latestSemanticMessage(messages);
    if (latest) {
      this.projectTranscriptIdentity(world, transcript, latest);
      this.projectTranscriptMessage(world, latest, transcript.updatedAt ?? undefined);
      if ((world.displayState === "waiting-input" || world.displayState === "approval")
          && !this.deps.pendingStore.getByTerminal(terminalId)) {
        this.setPending(fallbackInteractionFromText(
          world,
          latest.text,
          world.displayState === "approval" ? "approval" : "question",
          "native-transcript",
          latest.timestamp ?? transcript.updatedAt ?? new Date(this.now()).toISOString(),
        ));
      }
      return;
    }

    // Bounded screen fallback is used only when native transcript has no
    // usable semantic message. Raw screen text is never persisted.
    const screenSummary = summarizeScreenText(this.deps.getScreenText(terminalId) ?? "");
    if (!screenSummary) return;
    const observedAt = new Date(this.now()).toISOString();
    if (world.displayState === "done" || world.displayState === "idle") {
      this.deps.semanticStore.updateLastTurn(terminalId, {
        status: "completed",
        summary: screenSummary,
        finalText: null,
        completedAt: observedAt,
      }, { source: "screen-fallback", confidence: 0.5, observedAt });
    } else if (world.displayState === "waiting-input" || world.displayState === "approval") {
      if (!this.deps.pendingStore.getByTerminal(terminalId)) {
        this.setPending(fallbackInteractionFromText(
          world,
          screenSummary,
          world.displayState === "approval" ? "approval" : "question",
          "screen-fallback",
          observedAt,
        ));
      }
    } else {
      this.deps.semanticStore.updateTask(terminalId, {
        summary: screenSummary,
        phase: displayPhase(world),
      }, { source: "screen-fallback", confidence: 0.45, observedAt });
    }
  }

  private syncWorld(sessions: AgentApiSessionWorldState[]): void {
    const visible = new Set<string>();
    for (const session of sessions) {
      visible.add(session.terminalId);
      this.deps.semanticStore.updateIdentity(
        session.terminalId,
        identityFromAgentProfile(session.agentProfile),
        session.lastTransitionAt,
      );
      if (session.lifecycleStatus === "exited") {
        this.clearTerminal(session.terminalId);
      }
    }
    for (const state of this.deps.semanticStore.list()) {
      if (!visible.has(state.terminalId)) this.clearTerminal(state.terminalId);
    }
  }

  private onProviderEvent(event: NormalizedEvent): void {
    const terminalId = stringValue(event.payload?.terminalId);
    if (!terminalId) return;
    const observedAt = event.createdAt;
    const profile = stringValue(event.payload?.profileId) ?? stringValue(event.payload?.profile);
    if (profile) {
      const identity = identityFromAgentProfile(profile);
      const model = stringValue(event.payload?.model);
      if (model) identity.model = model;
      this.deps.semanticStore.updateIdentity(terminalId, identity, observedAt);
    }

    switch (event.type) {
      case "plan.updated":
      case "agent.started":
      case "agent.updated":
        this.deps.semanticStore.updateTask(terminalId, {
          summary: semanticEventSummary(event),
          phase: event.type === "plan.updated" ? "planning" : "running",
        }, { source: "provider-event", confidence: 0.98, observedAt });
        break;
      case "assistant.final": {
        const finalText = boundedText(stringValue(event.payload?.text) ?? event.summary, MAX_SEMANTIC_TEXT);
        this.deps.semanticStore.updateLastTurn(terminalId, {
          status: "completed",
          summary: summarizeText(finalText),
          finalText,
          completedAt: observedAt,
        }, { source: "provider-event", confidence: 1, observedAt });
        break;
      }
      case "agent.completed":
        this.deps.semanticStore.updateLastTurn(terminalId, {
          status: "completed",
          summary: semanticEventSummary(event),
          finalText: null,
          completedAt: observedAt,
        }, { source: "provider-event", confidence: 0.97, observedAt });
        break;
      case "user_input.requested":
        this.setPending(interactionFromProviderEvent(event, "question"));
        break;
      case "approval.requested":
        this.setPending(interactionFromProviderEvent(event, "approval"));
        break;
      case "user_input.resolved":
      case "approval.resolved":
        this.clearPending(terminalId, observedAt);
        break;
      case "error":
        this.deps.semanticStore.updateLastTurn(terminalId, {
          status: "failed",
          summary: semanticEventSummary(event),
          finalText: null,
          completedAt: observedAt,
        }, { source: "provider-event", confidence: 1, observedAt });
        break;
      case "warning":
        // Warning narration is handled by NarrationCoordinator directly.
        // Keep the task's high-level phase but do not replace it with low-level
        // warning chatter.
        break;
      default:
        break;
    }
  }

  private onPtyStateChanged(change: PtyStateChanged): void {
    const observedAt = new Date(this.now()).toISOString();
    const source: AgentApiSemanticSource = change.source === "provider" ? "provider-event" : "agent-detector";
    const confidence = source === "provider-event" ? 0.97 : 0.75;
    switch (change.state) {
      case "running":
      case "starting":
        if (change.previousState === "waiting_input" || change.previousState === "approval_required") {
          this.clearPending(change.terminalId, observedAt);
        }
        this.deps.semanticStore.updateTask(change.terminalId, {
          phase: change.state === "starting" ? "starting" : "running",
        }, { source, confidence, observedAt });
        if (change.previousState === "done" || change.previousState === "waiting_input" || change.previousState === "approval_required") {
          this.deps.semanticStore.updateLastTurn(change.terminalId, {
            status: "running",
            summary: null,
            finalText: null,
            completedAt: null,
          }, { source, confidence, observedAt });
        }
        break;
      case "done":
        this.deps.semanticStore.updateLastTurn(change.terminalId, {
          status: "completed",
          completedAt: observedAt,
        }, { source, confidence, observedAt });
        void this.refreshTranscript(change.terminalId);
        break;
      case "error":
        this.deps.semanticStore.updateLastTurn(change.terminalId, {
          status: "failed",
          summary: "Session reported an error.",
          completedAt: observedAt,
        }, { source, confidence, observedAt });
        void this.refreshTranscript(change.terminalId);
        break;
      case "waiting_input":
      case "approval_required":
        void this.refreshTranscript(change.terminalId).then(() => {
          if (this.deps.pendingStore.getByTerminal(change.terminalId)) return;
          const world = this.deps.worldState.getWorldState().find((entry) => entry.terminalId === change.terminalId);
          if (!world) return;
          this.setPending(fallbackInteractionFromText(
            world,
            change.state === "approval_required" ? "Approval is required." : "This session is waiting for your input.",
            change.state === "approval_required" ? "approval" : "question",
            "agent-detector",
            observedAt,
          ));
        });
        break;
      case "blocked":
        this.deps.semanticStore.updateTask(change.terminalId, { phase: "blocked" }, {
          source, confidence, observedAt,
        });
        break;
    }
  }

  private projectTranscriptIdentity(
    world: AgentApiSessionWorldState,
    transcript: TerminalTranscript,
    latest: TerminalTranscriptMessage,
  ): void {
    const identity = identityFromAgentProfile(world.agentProfile);
    if (latest.model) identity.model = latest.model;
    if (identity.backend === "unknown") {
      if (transcript.provider === "claude") identity.backend = "anthropic";
      if (transcript.provider === "codex") identity.backend = "openai";
    }
    this.deps.semanticStore.updateIdentity(world.terminalId, identity, latest.timestamp ?? transcript.updatedAt ?? this.now());
  }

  private projectTranscriptMessage(
    world: AgentApiSessionWorldState,
    message: TerminalTranscriptMessage,
    transcriptUpdatedAt?: string,
  ): void {
    const text = boundedText(message.text, MAX_SEMANTIC_TEXT);
    if (!text) return;
    const observedAt = message.timestamp ?? transcriptUpdatedAt ?? new Date(this.now()).toISOString();
    const confidence = message.kind === "turn_summary" ? 0.95 : 0.9;
    if (message.kind === "turn_summary" || world.displayState === "done" || world.displayState === "idle") {
      this.deps.semanticStore.updateLastTurn(world.terminalId, {
        status: "completed",
        summary: summarizeText(text),
        finalText: message.kind === "turn_summary" ? null : text,
        completedAt: observedAt,
      }, { source: "native-transcript", confidence, observedAt });
      return;
    }
    if (message.role === "assistant" && world.displayState === "running") {
      this.deps.semanticStore.updateTask(world.terminalId, {
        summary: summarizeText(text),
        phase: "running",
      }, { source: "native-transcript", confidence: 0.88, observedAt });
    }
  }

  private setPending(interaction: AgentApiPendingInteraction): void {
    const safe: AgentApiPendingInteraction = {
      ...interaction,
      prompt: boundedText(interaction.prompt, MAX_PENDING_PROMPT),
      options: interaction.options.slice(0, MAX_PENDING_OPTIONS).map((option) => ({
        ...option,
        label: boundedText(option.label, 240),
        ...(option.description ? { description: boundedText(option.description, 400) } : {}),
      })),
    };
    this.deps.pendingStore.set(safe);
    this.deps.semanticStore.setPendingInteraction(safe.terminalId, safe, safe.createdAt);
  }

  private clearPending(terminalId: string, observedAt: string | number | Date): void {
    this.deps.pendingStore.resolveByTerminal(terminalId);
    this.deps.semanticStore.setPendingInteraction(terminalId, null, observedAt);
  }

  private clearTerminal(terminalId: string): void {
    this.bumpGeneration(terminalId);
    this.deps.pendingStore.clearForTerminal(terminalId);
    this.deps.semanticStore.clear(terminalId);
  }

  private bumpGeneration(terminalId: string): number {
    const next = (this.refreshGeneration.get(terminalId) ?? 0) + 1;
    this.refreshGeneration.set(terminalId, next);
    return next;
  }
}

export function identityFromAgentProfile(profile: string | null): AgentApiAgentIdentity {
  const normalized = profile?.trim().toLowerCase() ?? "";
  let harness: AgentApiAgentIdentity["harness"] = "unknown";
  let backend: AgentApiAgentIdentity["backend"] = "unknown";
  if (normalized === "claude" || normalized.startsWith("claude-")) {
    harness = "claude-code";
    if (normalized.includes("local-long") || normalized.includes("qwen")) backend = "qwen";
    else if (normalized.includes("local-main") || normalized.includes("local-max") || normalized.includes("glm")) backend = "glm";
    else backend = "anthropic";
  } else if (normalized === "codex" || normalized.startsWith("codex-")) {
    harness = "codex-cli";
    if (normalized.includes("local-long") || normalized.includes("qwen")) backend = "qwen";
    else if (normalized.includes("local-main") || normalized.includes("local-max") || normalized.includes("glm")) backend = "glm";
    else backend = "openai";
  } else if (normalized === "powershell" || normalized === "pwsh") {
    harness = "powershell";
  } else if (normalized === "shell" || normalized === "bash" || normalized === "zsh") {
    harness = "shell";
  }
  return { harness, backend, model: null, profile };
}

export function interactionFromProviderEvent(
  event: NormalizedEvent,
  forcedType: "question" | "approval",
): AgentApiPendingInteraction {
  const terminalId = stringValue(event.payload?.terminalId) ?? "";
  const questions = arrayRecords(event.payload?.questions);
  const questionTexts = questions.map((question) => stringValue(question.question) ?? stringValue(question.prompt)).filter(isString);
  const options = questions.flatMap((question) => optionsFromUnknown(question.options));
  const directOptions = optionsFromUnknown(event.payload?.options);
  const allOptions = (options.length ? options : directOptions).slice(0, MAX_PENDING_OPTIONS);
  const prompt = questionTexts.length
    ? questionTexts.join(" / ")
    : stringValue(event.payload?.prompt) ?? stringValue(event.payload?.reason) ?? event.summary;
  return {
    id: stringValue(event.payload?.requestId) ?? event.id ?? randomUUID(),
    terminalId,
    nativeSessionId: event.providerSessionId,
    turnId: event.turnId,
    type: forcedType === "approval" ? "approval" : allOptions.length > 0 ? "choice" : "question",
    prompt: boundedText(prompt, MAX_PENDING_PROMPT),
    options: allOptions,
    source: "provider-event",
    createdAt: event.createdAt,
  };
}

function fallbackInteractionFromText(
  world: AgentApiSessionWorldState,
  text: string,
  type: "question" | "approval",
  source: AgentApiSemanticSource,
  createdAt: string,
): AgentApiPendingInteraction {
  return {
    id: `fallback:${world.terminalId}:${createdAt}`,
    terminalId: world.terminalId,
    type,
    prompt: boundedText(text, MAX_PENDING_PROMPT),
    options: inferNumberedOptions(text),
    source,
    createdAt,
  };
}

function optionsFromUnknown(value: unknown): AgentApiPendingInteractionOption[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw, index) => {
    if (typeof raw === "string") return { id: String(index + 1), label: raw };
    const record = asRecord(raw);
    const label = stringValue(record.label) ?? stringValue(record.name) ?? stringValue(record.value) ?? String(index + 1);
    const description = stringValue(record.description);
    return {
      id: stringValue(record.id) ?? stringValue(record.value) ?? String(index + 1),
      label,
      ...(description ? { description } : {}),
    };
  });
}

function inferNumberedOptions(text: string): AgentApiPendingInteractionOption[] {
  const safe = redactEgress(text);
  const matches = [...safe.matchAll(/(?:^|[\n\s])([1-9])(?:[.)、：:]|\s+-)\s*([^\n]{1,180})/g)];
  return matches.slice(0, MAX_PENDING_OPTIONS).map((match) => ({
    id: match[1]!,
    label: boundedText(match[2]!, 180),
  }));
}

function semanticEventSummary(event: NormalizedEvent): string {
  const candidates = [
    event.payload?.task,
    event.payload?.description,
    event.payload?.explanation,
    event.payload?.text,
    event.payload?.message,
  ];
  for (const candidate of candidates) {
    const text = stringValue(candidate);
    if (text) return summarizeText(text);
  }
  return summarizeText(event.summary);
}

function latestSemanticMessage(messages: TerminalTranscriptMessage[]): TerminalTranscriptMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "assistant" && message.text.trim()) return message;
  }
  return null;
}

function summarizeScreenText(text: string): string {
  const lines = redactEgress(text)
    // ANSI CSI begins with ESC; matching it is intentional terminal cleanup.
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";
  return summarizeText(lines.slice(-3).join(" "));
}

function summarizeText(text: string): string {
  const safe = boundedText(text, MAX_SEMANTIC_TEXT).replace(/\s+/g, " ").trim();
  if (!safe) return "";
  const match = /^(.{1,300}?[。！？!?]|.{1,300}\.\s)/u.exec(safe);
  return boundedText(match?.[1] ?? safe, MAX_SUMMARY_TEXT);
}

function boundedText(text: string, max: number): string {
  // Intentional C0 control stripping before semantic state/speech boundaries.
  // eslint-disable-next-line no-control-regex
  return redactEgress(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);
}

function displayPhase(world: AgentApiSessionWorldState): string {
  return world.displayState === "starting" ? "starting" : world.displayState;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isString(value: string | null): value is string {
  return value !== null;
}
