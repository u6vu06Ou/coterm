import { parseWorkerCommand } from "../livekit-worker-commands";
import { LIVEKIT_WORKER_ENV } from "../livekit-worker-env";
import type { LiveVoiceWorkerEvent } from "../live-voice-worker-bridge";

/**
 * Live Voice worker entry. Forked by LivekitWorkerProcess with
 * ELECTRON_RUN_AS_NODE=1, so this file runs as plain Node — it must not
 * import anything from src/main that touches Electron or the app logger.
 *
 * Secrets arrive only through env (work order §1.1) and are never logged or
 * echoed back over ipc.
 */

interface LiveVoiceEngine {
  start(): Promise<void>;
  speak(text: string): void;
  stopSpeaking(): void;
  dispose(): Promise<void>;
}

function required(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new Error(`Missing worker env ${name}.`);
  return value;
}

const send = (event: LiveVoiceWorkerEvent): void => {
  try {
    process.send?.(event);
  } catch {
    // ipc channel gone; shutdown is imminent anyway
  }
};

async function main(): Promise<void> {
  if (!process.send) {
    throw new Error("live-voice-worker must be started with an ipc channel (child_process.fork).");
  }

  let engine: LiveVoiceEngine;
  let shutdownSideEffects: () => Promise<void> = () => Promise.resolve();
  const provider = process.env[LIVEKIT_WORKER_ENV.provider] || "cascade";
  if (provider === "gemini") {
    // Engines load lazily inside main(): a missing optional native
    // dependency (e.g. a broken livekit ffi install) must reject
    // here so the catch at the bottom emits a clean degraded-health event,
    // instead of dying at module load where no event can be sent.
    const { GeminiLiveEngine } = await import("./gemini-live-engine");
    const { shutdownWorkerSideEffects } = await import("./duplex-engine");
    shutdownSideEffects = shutdownWorkerSideEffects;
    const geminiApiKey = required(LIVEKIT_WORKER_ENV.geminiApiKey);
    engine = new GeminiLiveEngine(
      {
        url: required(LIVEKIT_WORKER_ENV.url),
        apiKey: required(LIVEKIT_WORKER_ENV.apiKey),
        apiSecret: required(LIVEKIT_WORKER_ENV.apiSecret),
        room: required(LIVEKIT_WORKER_ENV.room),
        voiceSessionId: required(LIVEKIT_WORKER_ENV.voiceSessionId),
        geminiApiKey,
        geminiModel: process.env[LIVEKIT_WORKER_ENV.geminiModel] || "gemini-3.1-flash-live-preview",
        responseLanguage: process.env[LIVEKIT_WORKER_ENV.geminiLanguage] || "zh-TW",
      },
      { emit: send },
    );
  } else {
    const { DuplexEngine, shutdownWorkerSideEffects } = await import("./duplex-engine");
    shutdownSideEffects = shutdownWorkerSideEffects;
    engine = new DuplexEngine(
      {
        url: required(LIVEKIT_WORKER_ENV.url),
        apiKey: required(LIVEKIT_WORKER_ENV.apiKey),
        apiSecret: required(LIVEKIT_WORKER_ENV.apiSecret),
        room: required(LIVEKIT_WORKER_ENV.room),
        voiceSessionId: required(LIVEKIT_WORKER_ENV.voiceSessionId),
        sttUrl: required(LIVEKIT_WORKER_ENV.sttUrl),
        sttModel: process.env[LIVEKIT_WORKER_ENV.sttModel] ?? "whisper-1",
        sttApiKey: process.env[LIVEKIT_WORKER_ENV.sttApiKey] ?? "",
        ttsVoice: process.env[LIVEKIT_WORKER_ENV.ttsVoice] || "zh-TW-HsiaoChenNeural",
      },
      { emit: send },
    );
  }

  let shuttingDown = false;
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await engine.dispose().catch(() => undefined);
    await shutdownSideEffects();
    process.exit(code);
  };

  process.on("message", (raw: unknown) => {
    let command: ReturnType<typeof parseWorkerCommand>;
    try {
      command = parseWorkerCommand(raw);
    } catch {
      return; // malformed commands are dropped, never echoed
    }
    if (command.type === "speak") engine.speak(command.text);
    else if (command.type === "stop-speaking") engine.stopSpeaking();
    else void shutdown(0);
  });
  process.on("disconnect", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));

  await engine.start();
}

main().catch((_error: unknown) => {
  // stderr is the only diagnostics channel for a worker that dies before
  // logging exists; print name+message only (grabs no env, no secrets).
  process.stderr.write(
    `live-voice-worker start failed: ${_error instanceof Error ? `${_error.name}: ${_error.message}` : "unknown"}`.slice(0, 300) + "\n",
  );
  send({
    type: "health",
    state: "degraded",
    atMs: Date.now(),
    reasonCode: "worker-start-failed",
  });
  // Without ipc this is a fork misconfiguration; exit so main sees the death.
  process.exit(1);
});
