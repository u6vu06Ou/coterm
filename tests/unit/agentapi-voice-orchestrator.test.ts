// Phase 6 (work order §11.4/§14): main-side voice turn routing contract.
// Fast intents never touch the supervisor; voiceAgent-off keeps fast paths
// but degrades deep paths; relay is exact-target atomic send or a spoken
// clarification (never a guess); interrupt bumps the epoch so late output
// is discarded; every outbound text is egress-redacted; memory is bounded.
import { describe, expect, it } from "vitest";
import { appSettingsSchema } from "../../src/shared/schema";
import type { AppSettings, AgentApiSessionWorldState } from "../../src/shared/types";
import { PendingInteractionStore } from "../../src/main/core/agentapi-pending-interaction-store";
import {
  detectSummaryIntent,
  isContextualPendingReply,
  parseRelayIntent,
  AGENTAPI_VOICE_HISTORY_MAX_TURNS,
  AgentApiVoiceOrchestrator,
  type AgentApiVoiceOrchestratorDeps,
} from "../../src/main/core/agentapi-voice-orchestrator";

function session(over: Partial<AgentApiSessionWorldState>): AgentApiSessionWorldState {
  return {
    terminalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    projectId: "11111111-1111-4111-8111-111111111111",
    displayName: "alpha",
    projectLabel: "proj",
    agentProfile: "claude-local-big",
    canonicalState: "running" as AgentApiSessionWorldState["canonicalState"],
    lifecycleStatus: "running",
    displayState: "running",
    source: "process",
    attentionNotificationId: null,
    lastTransitionAt: "2026-08-04T00:00:00.000Z",
    ageMs: 1000,
    selected: false,
    scrollbackMode: "normal",
    ...over,
  };
}

function makeOrchestrator(options: {
  voiceAgent?: boolean;
  sessions?: AgentApiSessionWorldState[];
  pendingStore?: PendingInteractionStore;
  askImpl?: (utterance: string, opts?: { signal?: AbortSignal }) => Promise<string>;
} = {}) {
  const settings: AppSettings = appSettingsSchema.parse({
    agentapi: { voiceAgent: options.voiceAgent === true },
  });
  const calls = {
    ask: 0,
    summarize: 0,
    sent: [] as Array<{ terminalId: string; message: string; clientMutationId: string }>,
  };
  const sessions = options.sessions ?? [];
  const deps: AgentApiVoiceOrchestratorDeps = {
    worldState: {
      getWorldState: () => sessions,
      answerFastIntent: (kind) => `FAST:${kind}`,
    },
    supervisor: {
      ask: (utterance, opts) => {
        calls.ask += 1;
        return (options.askImpl ?? (async () => `SUP:${utterance}`))(utterance, opts);
      },
      summarizeAllSessions: async () => {
        calls.summarize += 1;
        return "SUMMARY";
      },
    },
    pendingStore: options.pendingStore ?? new PendingInteractionStore(),
    sendToSession: (input) => {
      calls.sent.push(input);
      return { ok: true };
    },
    getSettings: () => settings,
  };
  return { orchestrator: new AgentApiVoiceOrchestrator(deps), calls };
}

describe("fast-path routing (§11.4: never touches the supervisor)", () => {
  it("answers status intents with voiceAgent ON and OFF, supervisor untouched", async () => {
    for (const voiceAgent of [true, false]) {
      const { orchestrator, calls } = makeOrchestrator({ voiceAgent });
      const result = await orchestrator.turn("現在有幾個視窗在運行？");
      expect(result).toMatchObject({ source: "fast", text: "FAST:running-count" });
      expect(calls.ask).toBe(0);
      expect(calls.summarize).toBe(0);
      expect(calls.sent).toEqual([]);
    }
  });

  it("degrades deep/summary/relay paths to a spoken notice when voiceAgent is off", async () => {
    const { orchestrator, calls } = makeOrchestrator({
      voiceAgent: false,
      sessions: [session({})],
    });
    const deep = await orchestrator.turn("幫我分析為什麼 build 壞了");
    expect(deep?.source).toBe("supervisor");
    expect(deep?.text).toContain("關閉");
    const summary = await orchestrator.turn("幫我摘要每個視窗");
    expect(summary?.source).toBe("summary");
    const relay = await orchestrator.turn("幫我跟alpha視窗說 git status");
    expect(relay?.source).toBe("relay");
    expect(relay?.text).toContain("關閉");
    expect(calls.ask).toBe(0);
    expect(calls.summarize).toBe(0);
    expect(calls.sent).toEqual([]);
  });

  it("rejects empty/oversized utterances at the schema boundary", async () => {
    const { orchestrator } = makeOrchestrator();
    await expect(orchestrator.turn("   ")).rejects.toThrow();
    await expect(orchestrator.turn("字".repeat(2_001))).rejects.toThrow();
  });
});

describe("summary + relay intents (§11.4)", () => {
  it("detectSummaryIntent is conservative (zh/en whitelist)", () => {
    expect(detectSummaryIntent("幫我摘要每個視窗")).toBe(true);
    expect(detectSummaryIntent("summarize all windows")).toBe(true);
    expect(detectSummaryIntent("摘要")).toBe(false);
    expect(detectSummaryIntent("summarize this window")).toBe(false);
  });

  it("summary fan-in uses bounded briefs + supervisor synthesis", async () => {
    const { orchestrator, calls } = makeOrchestrator({ voiceAgent: true });
    const result = await orchestrator.turn("幫我摘要每個視窗");
    expect(result).toMatchObject({ source: "summary", text: "SUMMARY" });
    expect(calls.summarize).toBe(1);
    expect(calls.ask).toBe(0);
  });

  it("parseRelayIntent is exact-match only, zh + en, send filler stripped", () => {
    expect(parseRelayIntent("幫我跟alpha視窗說 git status")).toEqual({
      target: "alpha",
      message: "git status",
    });
    expect(parseRelayIntent("幫我跟alpha說 跑測試，並送出")).toEqual({
      target: "alpha",
      message: "跑測試",
    });
    expect(parseRelayIntent("tell the build window to say deploy done")).toEqual({
      target: "build",
      message: "deploy done",
    });
    expect(parseRelayIntent("幫我跟這個視窗說 pwd")).toEqual({
      target: "__selected__",
      message: "pwd",
    });
    expect(parseRelayIntent("今天天氣如何")).toBeNull();
  });

  it("unique target relays atomically with a clientMutationId", async () => {
    const { orchestrator, calls } = makeOrchestrator({
      voiceAgent: true,
      sessions: [session({ terminalId: "tid-1", displayName: "alpha" })],
    });
    const result = await orchestrator.turn("幫我跟alpha視窗說 git status");
    expect(result?.source).toBe("relay");
    expect(result?.targetTerminalId).toBe("tid-1");
    expect(calls.sent).toHaveLength(1);
    expect(calls.sent[0]).toMatchObject({ terminalId: "tid-1", message: "git status" });
    expect(calls.sent[0]?.clientMutationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("ambiguous targets become a spoken clarification — never a guess", async () => {
    const { orchestrator, calls } = makeOrchestrator({
      voiceAgent: true,
      sessions: [
        session({ terminalId: "tid-1", displayName: "alpha" }),
        session({ terminalId: "tid-2", displayName: "alpha" }),
      ],
    });
    const result = await orchestrator.turn("幫我跟alpha視窗說 hi");
    expect(calls.sent).toEqual([]);
    expect(result?.clarification?.candidates).toHaveLength(2);
    expect(result?.text).toContain("2 個視窗");
  });

  it("missing targets say so; selected-window shorthand uses the selection", async () => {
    const { orchestrator, calls } = makeOrchestrator({
      voiceAgent: true,
      sessions: [session({ terminalId: "tid-9", displayName: "beta", selected: true })],
    });
    const missing = await orchestrator.turn("幫我跟ghost視窗說 hi");
    expect(missing?.targetTitle).toBe("ghost");
    expect(calls.sent).toEqual([]);
    const selected = await orchestrator.turn("幫我跟這個視窗說 hi");
    expect(calls.sent).toHaveLength(1);
    expect(calls.sent[0]?.terminalId).toBe("tid-9");
    expect(selected?.targetTerminalId).toBe("tid-9");
  });
});

describe("pending interaction contextual reply", () => {
  it("recognizes only compact reply-like utterances", () => {
    expect(isContextualPendingReply("2")).toBe(true);
    expect(isContextualPendingReply("好")).toBe(true);
    expect(isContextualPendingReply("繼續")).toBe(true);
    expect(isContextualPendingReply("幫我分析第二個方案的風險")).toBe(false);
  });

  it("routes a unique pending reply to the exact originating session", async () => {
    const pendingStore = new PendingInteractionStore();
    pendingStore.set({
      id: "p-1", terminalId: "tid-1", type: "choice", prompt: "Pick one",
      options: [{ id: "1", label: "One" }, { id: "2", label: "Two" }],
      source: "provider-event", createdAt: "2026-08-15T00:00:00.000Z",
    });
    const { orchestrator, calls } = makeOrchestrator({
      voiceAgent: true,
      pendingStore,
      sessions: [session({ terminalId: "tid-1", displayName: "alpha", displayState: "waiting-input" })],
    });
    const result = await orchestrator.turn("2");
    expect(result).toMatchObject({ source: "relay", targetTerminalId: "tid-1" });
    expect(calls.sent).toHaveLength(1);
    expect(calls.sent[0]).toMatchObject({ terminalId: "tid-1", message: "2" });
  });

  it("with two pending interactions asks which window and sends nothing", async () => {
    const pendingStore = new PendingInteractionStore();
    for (const [id, terminalId] of [["p-1", "tid-1"], ["p-2", "tid-2"]] as const) {
      pendingStore.set({ id, terminalId, type: "question", prompt: "Answer?", options: [], source: "provider-event", createdAt: "2026-08-15T00:00:00.000Z" });
    }
    const { orchestrator, calls } = makeOrchestrator({
      voiceAgent: true,
      pendingStore,
      sessions: [session({ terminalId: "tid-1", displayName: "alpha" }), session({ terminalId: "tid-2", displayName: "beta" })],
    });
    const result = await orchestrator.turn("好");
    expect(calls.sent).toEqual([]);
    expect(result?.clarification?.candidates).toHaveLength(2);
    expect(result?.text).toContain("2 個視窗");
  });

  it("resolved pending interaction cannot receive a stale short reply", async () => {
    const pendingStore = new PendingInteractionStore();
    pendingStore.set({ id: "p-1", terminalId: "tid-1", type: "question", prompt: "Answer?", options: [], source: "provider-event", createdAt: "2026-08-15T00:00:00.000Z" });
    pendingStore.resolve("p-1");
    const { orchestrator, calls } = makeOrchestrator({
      voiceAgent: true,
      pendingStore,
      sessions: [session({ terminalId: "tid-1", displayName: "alpha" })],
    });
    const result = await orchestrator.turn("2");
    expect(calls.sent).toEqual([]);
    expect(result?.source).toBe("supervisor");
  });
});

describe("interrupt + epoch (§11.3 late-output discard)", () => {
  it("a superseded deep turn resolves null even when the answer arrives late", async () => {
    let resolveAsk: (text: string) => void = () => undefined;
    const { orchestrator } = makeOrchestrator({
      voiceAgent: true,
      askImpl: () => new Promise<string>((resolve) => { resolveAsk = resolve; }),
    });
    const pending = orchestrator.turn("分析這段 log");
    const interrupted = orchestrator.interrupt();
    expect(interrupted.aborted).toBe(true);
    resolveAsk("遲到的答案");
    await expect(pending).resolves.toBeNull();
  });

  it("every new turn supersedes the previous one (epoch monotonic)", async () => {
    const { orchestrator } = makeOrchestrator({ voiceAgent: true });
    const first = await orchestrator.turn("幾個在運行？");
    const second = await orchestrator.turn("幾個在運行？");
    expect(first!.epoch).toBeLessThan(second!.epoch);
    expect(orchestrator.getEpoch()).toBe(second!.epoch);
  });
});

describe("redaction + bounded memory (§11.2/§14)", () => {
  it("supervisor answers are egress-redacted before they can be spoken", async () => {
    const secret = "gsk_ABCDEFGHIJKL123456";
    const { orchestrator } = makeOrchestrator({
      voiceAgent: true,
      askImpl: async () => `金鑰是 ${secret}，別外洩`,
    });
    const result = await orchestrator.turn("分析一下這個");
    expect(result?.text).not.toContain(secret);
    expect(result?.text).toContain("別外洩");
  });

  it("a supervisor failure becomes a redacted spoken-friendly answer, not a throw", async () => {
    const { orchestrator } = makeOrchestrator({
      voiceAgent: true,
      askImpl: async () => { throw new Error("proxy exploded gsk_ABCDEFGHIJKL123456"); },
    });
    const result = await orchestrator.turn("隨便問點什麼");
    expect(result?.source).toBe("supervisor");
    expect(result?.text).toContain("暫時無法回應");
    expect(result?.text).not.toContain("gsk_ABCDEFGHIJKL123456");
  });

  it("the recent-turn ring is bounded, memory-only, and redacted", async () => {
    const secret = "gsk_ZZZZZZZZZZZZ999999";
    const { orchestrator } = makeOrchestrator({ voiceAgent: true });
    for (let index = 0; index < AGENTAPI_VOICE_HISTORY_MAX_TURNS + 4; index += 1) {
      await orchestrator.turn(`第 ${index} 輪，key ${secret}`);
    }
    const history = orchestrator.recentTurnHistory();
    expect(history.length).toBe(AGENTAPI_VOICE_HISTORY_MAX_TURNS);
    expect(AGENTAPI_VOICE_HISTORY_MAX_TURNS).toBeLessThanOrEqual(8);
    for (const entry of history) expect(entry.utterance).not.toContain(secret);
  });
});
