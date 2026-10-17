// Phase 6 contract pins (work order §11/§14). Static cross-module
// invariants: the IPC/RPC surface shape, key-stays-in-main audio channel,
// redaction wiring, memory-only history, and the feature-flag schema.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appSettingsPatchSchema, appSettingsSchema } from "../../src/shared/schema";
import { IPC } from "../../src/shared/ipc";
import { bindWebOperations, isRpcMethod } from "../../src/main/web/routes";
import { AGENTAPI_VOICE_HISTORY_MAX_TURNS } from "../../src/main/core/agentapi-voice-orchestrator";
import { AGENTAPI_VOICE_PANE_MAX_TURNS } from "../../src/renderer/src/voice-agent/agent-coordinator";
import { MAX_VOICE_AGENT_BASE64_CHARS } from "../../src/main/voice/agent-transcribe";

const MAIN_ORCHESTRATOR = readFileSync(resolve("src/main/core/agentapi-voice-orchestrator.ts"), "utf8");
const RENDERER_COORDINATOR = readFileSync(resolve("src/renderer/src/voice-agent/agent-coordinator.ts"), "utf8");
const RENDERER_TTS = readFileSync(resolve("src/renderer/src/voice-agent/tts.ts"), "utf8");
const PRELOAD = readFileSync(resolve("src/preload/index.ts"), "utf8");

describe("voice IPC + RPC surface (§11)", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("exposes exactly the pinned Phase 6 channels", () => {
    expect(IPC.agentapiWorldSnapshot).toBe("agentapi:world-snapshot");
    expect(IPC.agentapiWorldChanged).toBe("agentapi:world-changed");
    expect(IPC.agentapiVoiceTurn).toBe("agentapi:voice-turn");
    expect(IPC.agentapiVoiceInterrupt).toBe("agentapi:voice-interrupt");
    expect(IPC.transcribeVoiceAgent).toBe("voice:agent-transcribe");
  });

  it("preload forwards every channel (no silent drops)", () => {
    for (const channel of [
      "IPC.agentapiWorldSnapshot",
      "IPC.agentapiWorldChanged",
      "IPC.agentapiVoiceTurn",
      "IPC.agentapiVoiceInterrupt",
      "IPC.transcribeVoiceAgent",
    ]) {
      expect(PRELOAD).toContain(channel);
    }
  });

  it("web RPC exposes the same methods on the authenticated surface", () => {
    for (const method of [
      "getAgentApiWorldSnapshot",
      "agentapiVoiceTurn",
      "interruptAgentApiVoice",
      "transcribeVoiceAgent",
    ]) {
      expect(isRpcMethod(method)).toBe(true);
    }
  });

  it("voice methods degrade gracefully when the voice surface is not wired", () => {
    const operations = bindWebOperations({} as Parameters<typeof bindWebOperations>[0]);
    expect(operations.getAgentApiWorldSnapshot).toBeUndefined();
    expect(operations.agentapiVoiceTurn).toBeUndefined();
    expect(operations.transcribeVoiceAgent).toBeUndefined();
    expect(operations.bootstrap).toBeTypeOf("function");
  });

  it("the transcribe surface never accepts a client-supplied STT key", () => {
    // The audio channel is {audioBase64, mimeType, lang} only — server URL,
    // model and key are read from settings in main (see routes.ts/register-ipc.ts).
    expect(PRELOAD).not.toMatch(/transcribeVoiceAgent[\s\S]{0,300}apiKey/);
  });

  it("rejects malformed and oversized mobile audio before any STT request", async () => {
    const settings = appSettingsSchema.parse({});
    const operations = bindWebOperations({} as Parameters<typeof bindWebOperations>[0], undefined, {
      agentapiState: { getWorldState: () => [] },
      agentapiVoice: { turn: async () => null, interrupt: () => ({ epoch: 1, aborted: false }) },
      getSettings: () => settings,
    });
    const transcribe = operations.transcribeVoiceAgent!;
    await expect(Promise.resolve().then(() => transcribe(null))).rejects.toThrow(/audio payload/i);
    await expect(Promise.resolve().then(() => transcribe({ audioBase64: "not-base64!" })))
      .rejects.toThrow(/base64/i);
    await expect(Promise.resolve().then(() => transcribe({ audioBase64: "A".repeat(MAX_VOICE_AGENT_BASE64_CHARS + 1) })))
      .rejects.toThrow(/base64/i);
  });

  it("uses only the main-owned STT key even when the client sends an apiKey field", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const settings = appSettingsSchema.parse({
      voice: {
        sttUrl: "https://stt.example.test/v1/audio/transcriptions",
        sttModel: "whisper-test",
        sttApiKey: "main-owned-key",
      },
    });
    const operations = bindWebOperations({} as Parameters<typeof bindWebOperations>[0], undefined, {
      agentapiState: { getWorldState: () => [] },
      agentapiVoice: { turn: async () => null, interrupt: () => ({ epoch: 1, aborted: false }) },
      getSettings: () => settings,
    });
    await expect(operations.transcribeVoiceAgent!({
      audioBase64: Buffer.from([1, 2, 3]).toString("base64"),
      mimeType: "audio/webm",
      lang: "zh-TW",
      apiKey: "client-injected-key",
    })).resolves.toEqual({ text: "ok" });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers).toEqual({ authorization: "Bearer main-owned-key" });
  });
});

describe("redaction + memory-only history (§11.2/§14)", () => {
  it("the main orchestrator is the single redaction boundary", () => {
    expect(MAIN_ORCHESTRATOR).toContain("redactEgress");
  });

  it("TTS never decides privacy: it only speaks pre-redacted text", () => {
    expect(RENDERER_TTS).not.toContain("redactEgress");
    expect(RENDERER_TTS).toContain("egress-redacted");
  });

  it("nothing on the voice path writes SQLite (bounded memory-only turns)", () => {
    expect(AGENTAPI_VOICE_HISTORY_MAX_TURNS).toBeLessThanOrEqual(8);
    expect(AGENTAPI_VOICE_PANE_MAX_TURNS).toBeLessThanOrEqual(8);
    for (const source of [MAIN_ORCHESTRATOR, RENDERER_COORDINATOR, RENDERER_TTS]) {
      expect(source).not.toMatch(/better-sqlite|from ["']node:sqlite|\.prepare\(|INSERT INTO/i);
    }
  });
});

describe("feature flags + settings schema (§14)", () => {
  it("defaults hide the feature flag; removed keys are stripped", () => {
    const settings = appSettingsSchema.parse({
      agentapi: { sidebar: true, supervisorProfile: "claude-local-main", ttsMuted: false },
    });
    expect(settings.agentapi).toEqual({ voiceAgent: false });
    const fresh = appSettingsSchema.parse({});
    expect(fresh.agentapi?.voiceAgent).toBe(false);
  });

  it("accepts the surviving voiceAgent patch field", () => {
    const patch = appSettingsPatchSchema.parse({ agentapi: { voiceAgent: true } });
    expect(patch.agentapi?.voiceAgent).toBe(true);
  });
});
