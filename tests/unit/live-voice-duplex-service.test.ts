import { describe, expect, it } from "vitest";
import { appSettingsSchema, type AppSettings } from "../../src/shared/schema";
import type { VoiceSessionRecord } from "../../src/shared/types";
import { LiveVoiceDuplexService } from "../../src/main/voice/live/live-voice-duplex-service";
import type { LivekitServerProcess } from "../../src/main/voice/live/livekit-server-process";
import type { LivekitWorkerProcess } from "../../src/main/voice/live/livekit-worker-process";
import type { LivekitWorkerProcessDeps } from "../../src/main/voice/live/livekit-worker-process";
import type { LiveVoiceWorkerEvent } from "../../src/main/voice/live/live-voice-worker-bridge";
import type { PersistentVoiceSessionController } from "../../src/main/voice/live/persistent-voice-session-controller";

function makeSession(id = "vs-test"): VoiceSessionRecord {
  return {
    id,
    status: "listening",
    startedAt: "2026-08-16T00:00:00.000Z",
    endedAt: null,
    lastActiveAt: "2026-08-16T00:00:00.000Z",
    rollingSummary: "",
    currentTopic: null,
    activeTerminalId: null,
    transport: "starting",
    sttLanguageMode: "auto",
    responseLanguage: "zh-TW",
    revision: 1,
  };
}

function makeController() {
  const calls = {
    resume: [] as Array<[string, string]>,
    interruptLike: 0,
    replyFinished: 0,
    utterances: [] as string[],
    geminiUserTurns: [] as string[],
    geminiModelReplies: [] as string[],
  };
  const controller = {
    resume: (id: string, transport?: string) => {
      calls.resume.push([id, transport ?? ""]);
      return makeSession(id);
    },
    userSpeechStarted: (id: string) => {
      calls.interruptLike += 1;
      return makeSession(id);
    },
    markReconnecting: (id: string) => makeSession(id),
    markReconnected: (id: string) => makeSession(id),
    replyFinished: (id: string) => {
      calls.replyFinished += 1;
      return makeSession(id);
    },
    submitUtterance: async (_id: string, text: string) => {
      calls.utterances.push(text);
      return { text: `回覆：${text}`, source: "direct", targetTerminalId: null };
    },
    recordUserUtterance: (_id: string, text: string) => {
      calls.geminiUserTurns.push(text);
      return makeSession(_id);
    },
    recordModelReply: (_id: string, text: string) => {
      calls.geminiModelReplies.push(text);
      return makeSession(_id);
    },
  } as unknown as PersistentVoiceSessionController;
  return { controller, calls };
}

function fakeProcess(healthy: boolean) {
  return {
    started: 0,
    stopped: 0,
    async start() { this.started += 1; },
    async stop() { this.stopped += 1; },
    async health() { return healthy; },
    onExit() { return () => undefined; },
  };
}

function fakeWorker(healthy: boolean, send?: (m: unknown) => void) {
  const proc = fakeProcess(healthy);
  const sent: unknown[] = [];
  return Object.assign(proc, {
    sent,
    send(command: unknown) {
      sent.push(command);
      send?.(command);
      return true;
    },
  });
}

interface HarnessOptions {
  workerHealthy?: boolean;
  artifactOk?: boolean;
  onWorkerEvent?: (emit: (event: LiveVoiceWorkerEvent) => void) => void;
  /** STT reachability probe the service runs before joining. Default reaches
   * nothing real so a probe result never depends on the test machine's network. */
  preflightStt?: (url: string) => Promise<boolean>;
}

function makeHarness(settings: AppSettings, options: HarnessOptions = {}) {
  let emitted: ((event: LiveVoiceWorkerEvent) => void) | null = null;
  let workerEnv: Record<string, string> | null = null;
  const { controller, calls } = makeController();
  const settingsWrites: AppSettings[] = [];
  const worker = fakeWorker(options.workerHealthy ?? true);
  const logs: string[] = [];
  const service = new LiveVoiceDuplexService({
    userDataPath: "C:\\tmp\\userdata",
    workerEntryPath: "C:\\tmp\\worker.js",
    getSettings: () => settings,
    setSettings: async (next) => {
      settingsWrites.push(next);
      settings = next;
      return next;
    },
    controller,
    logger: {
      info: (event) => logs.push(`info:${event}`),
      warn: (event) => logs.push(`warn:${event}`),
    },
    ensureArtifact: async () => options.artifactOk === false
      ? { ok: false, reason: "no network" }
      : { ok: true, path: "C:\\tmp\\livekit-server.exe" },
    issueToken: async ({ voiceSessionId, identity }) => `token:${identity}:${voiceSessionId}`,
    serverFactory: () => fakeProcess(true) as unknown as LivekitServerProcess,
    preflightStt: options.preflightStt ?? (async () => true),
    workerFactory: (({ onEvent, env }: LivekitWorkerProcessDeps) => {
      emitted = onEvent ?? null;
      workerEnv = env ?? null;
      return worker as unknown as LivekitWorkerProcess;
    }) as never,
    randomTokenMaterial: () => "r".repeat(40),
  });
  return { service, settingsWrites, worker, workerEnv: () => workerEnv, calls, logs, getSettings: () => settings, emit: (e: LiveVoiceWorkerEvent) => emitted?.(e) };
}

function settingsWith(partial: { live?: Partial<AppSettings["voice"]["live"]>; sttUrl?: string }): AppSettings {
  const base = appSettingsSchema.parse({});
  return {
    ...base,
    voice: {
      ...base.voice,
      sttUrl: partial.sttUrl ?? "http://10.0.0.1:8765",
      live: { ...base.voice.live, ...(partial.live ?? {}) },
    },
  };
}

describe("LiveVoiceDuplexService", () => {
  it("returns null + chunked transport when live duplex is disabled", async () => {
    const h = makeHarness(settingsWith({ live: { enabled: false } }));
    const join = await h.service.attach(makeSession());
    expect(join).toBeNull();
    expect(h.calls.resume).toEqual([["vs-test", "chunked"]]);
    expect(h.logs.some((l) => l.includes("degraded"))).toBe(true);
  });

  it("returns null when voice.sttUrl is empty (chunked path stays the fallback)", async () => {
    const h = makeHarness(settingsWith({ sttUrl: "" }));
    expect(await h.service.attach(makeSession())).toBeNull();
    expect(h.calls.resume).toEqual([["vs-test", "chunked"]]);
  });

  it("generates >=32-char credentials and persists them before starting", async () => {
    const h = makeHarness(settingsWith({}));
    // credentials start empty on default settings → one settings write
    await h.service.attach(makeSession());
    expect(h.settingsWrites).toHaveLength(1);
    const live = h.settingsWrites[0]!.voice.live;
    expect(live.apiKey.length).toBeGreaterThanOrEqual(32);
    expect(live.apiSecret.length).toBeGreaterThanOrEqual(32);
    // and the material never appears in logs
    expect(h.logs.join("\n")).not.toContain("r".repeat(40));
  });

  it("does not rewrite credentials that already exist", async () => {
    const settings = settingsWith({
      live: { apiKey: "a".repeat(33), apiSecret: "b".repeat(40) },
    });
    const h = makeHarness(settings);
    const join = await h.service.attach(makeSession());
    expect(h.settingsWrites).toHaveLength(0);
    expect(join).not.toBeNull();
  });

  it("degrades to chunked when the server artifact cannot be fetched", async () => {
    const h = makeHarness(settingsWith({}), { artifactOk: false });
    expect(await h.service.attach(makeSession())).toBeNull();
    expect(h.calls.resume).toEqual([["vs-test", "chunked"]]);
  });

  it("ready runtime returns join info and rewrites transport to livekit", async () => {
    const h = makeHarness(settingsWith({ live: { serverUrl: "ws://127.0.0.1:7880" } }));
    const join = await h.service.attach(makeSession("vs-live"));
    expect(join).toEqual({ url: "ws://127.0.0.1:7880", token: "token:user-vs-live:vs-live" });
    expect(h.calls.resume).toEqual([["vs-live", "livekit"]]);
  });

  it("worker that never becomes healthy yields degraded → null + chunked", async () => {
    const h = makeHarness(settingsWith({}), { workerHealthy: false });
    expect(await h.service.attach(makeSession())).toBeNull();
    expect(h.calls.resume.at(-1)).toEqual(["vs-test", "chunked"]);
  });

  it("falls back to chunked with an actionable, secret-free reason when the STT endpoint is unreachable", async () => {
    const h = makeHarness(settingsWith({}), { preflightStt: async () => false });
    const join = await h.service.attach(makeSession());
    expect(join).toBeNull();
    expect(h.calls.resume.at(-1)).toEqual(["vs-test", "chunked"]);
    const logs = h.logs.join("\n");
    // surfaces a categorized degrade (content-free), like the sibling degrade tests
    expect(h.logs.some((l) => l.includes("degraded"))).toBe(true);
    // security rule 1: never logs the generated credential material
    expect(logs).not.toContain("r".repeat(40));
    // no raw-audio markers ever reach the diagnostic log
    expect(/audio|pcm|webm|opus|buffer|base64/i.test(logs)).toBe(false);
    // no raw-audio markers ever reach the diagnostic log
    expect(/audio|pcm|webm|opus|buffer|base64/i.test(logs)).toBe(false);
  });

  it("forwards a final-utterance event into a turn and speaks the reply", async () => {
    const h = makeHarness(settingsWith({}));
    await h.service.attach(makeSession("vs-e"));
    h.emit({ type: "final-utterance", voiceSessionId: "vs-e", text: "今天天氣", atMs: 1 });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.calls.utterances).toEqual(["今天天氣"]);
    expect(h.worker.sent).toEqual([{ type: "speak", voiceSessionId: "vs-e", text: "回覆：今天天氣" }]);
  });

  it("keeps one bounded latest-stage diagnostic snapshot per active session", async () => {
    const h = makeHarness(settingsWith({}));
    await h.service.attach(makeSession("vs-diag"));
    h.emit({
      type: "stage",
      voiceSessionId: "vs-diag",
      stage: "worker-mic",
      state: "frames",
      frameCount: 120,
      framesPerSecond: 99.5,
      rms: 812,
      atMs: Date.now(),
    });
    const snapshot = h.service.diagnostics("vs-diag");
    expect(snapshot?.voiceSessionId).toBe("vs-diag");
    expect(snapshot?.stages.transport?.state).toBe("connected");
    expect(snapshot?.stages["worker-mic"]).toMatchObject({
      state: "frames",
      frameCount: 120,
      framesPerSecond: 99.5,
      rms: 812,
    });
    expect(JSON.stringify(snapshot)).not.toContain("今天天氣");
    h.emit({ type: "stage", voiceSessionId: "vs-diag", stage: "tts", state: "ended", atMs: Date.now() });
    expect(h.calls.replyFinished).toBe(1);
  });

  it("barge-in event interrupts the session and stops worker speech", async () => {
    const h = makeHarness(settingsWith({}));
    await h.service.attach(makeSession("vs-b"));
    h.emit({ type: "user-speech-started", voiceSessionId: "vs-b", atMs: 2 });
    expect(h.calls.interruptLike).toBe(1);
    expect(h.worker.sent).toEqual([{ type: "stop-speaking" }]);
  });

  it("ignores utterances from an older session id", async () => {
    const h = makeHarness(settingsWith({}));
    await h.service.attach(makeSession("vs-new"));
    h.emit({ type: "final-utterance", voiceSessionId: "vs-old", text: "舊的", atMs: 3 });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.calls.utterances).toEqual([]);
  });

  it("gemini provider without an API key degrades to chunked dictation", async () => {
    const h = makeHarness(settingsWith({
      live: { provider: "gemini", geminiApiKey: "" },
      sttUrl: "",
    }));
    expect(await h.service.attach(makeSession())).toBeNull();
    expect(h.calls.resume).toEqual([["vs-test", "chunked"]]);
  });

  it("gemini provider skips the STT preflight, wires env, and records turns without a supervisor", async () => {
    const h = makeHarness(settingsWith({
      live: {
        provider: "gemini",
        geminiApiKey: "AIza-test-key-0000000000000",
        apiKey: "a".repeat(33),
        apiSecret: "b".repeat(40),
      },
      sttUrl: "",
    }), { preflightStt: async () => { throw new Error("must not probe STT in gemini mode"); } });
    const join = await h.service.attach(makeSession("vs-g"));
    expect(join).not.toBeNull();
    expect(h.calls.resume).toEqual([["vs-g", "livekit"]]);
    const env = h.workerEnv()!;
    expect(env.COTERM_LIVEKIT_PROVIDER).toBe("gemini");
    expect(env.COTERM_LIVEKIT_GEMINI_API_KEY).toBe("AIza-test-key-0000000000000");
    expect(env.COTERM_LIVEKIT_GEMINI_MODEL).toBe("gemini-3.1-flash-live-preview");

    h.emit({ type: "final-utterance", voiceSessionId: "vs-g", text: "台灣最高的山是哪裡", atMs: 10 });
    await new Promise((r) => setTimeout(r, 10));
    // The Gemini model speaks its own reply: no supervisor turn, no speak command.
    expect(h.calls.utterances).toEqual([]);
    expect(h.calls.geminiUserTurns).toEqual(["台灣最高的山是哪裡"]);
    expect(h.worker.sent.every((m) => (m as { type?: string }).type !== "speak")).toBe(true);

    h.emit({ type: "model-utterance", voiceSessionId: "vs-g", text: "是玉山。", atMs: 12 });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.calls.geminiModelReplies).toEqual(["是玉山。"]);
  });
});
