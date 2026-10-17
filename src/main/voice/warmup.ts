// Local dictation only. Never send a speculative request to a paid endpoint.
// The existing local server unloads after five idle minutes. Two defences:
//  1. Press-time warm (warmLocalVoice): start its cold load while the user is
//     speaking instead of waiting until the clip is stopped.
//  2. Keep-alive (startVoiceKeepalive, 2026-10-17): ping it with 100ms of
//     silence every four minutes so the model simply never unloads while
//     Coterm runs. Without it the first 1–2 utterances after any few quiet
//     minutes were eaten by the cold load, and the same loss came back after
//     every idle stretch — exactly the report this file existed for anyway.
import { logger } from "../core/logger";

interface VoiceServerHealth {
  loaded: boolean;
  model: string | null;
}

let pending: Promise<void> | null = null;

/**
 * The one endpoint family speculative traffic is allowed to touch: the user's
 * own loopback dictation server. Anything hosted (Groq/OpenAI) must never get
 * a request the user did not explicitly speak into being.
 */
export function isLocalDictationServer(serverUrl: string): boolean {
  let url: URL;
  try { url = new URL(serverUrl); } catch { return false; }
  return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port === "8766";
}

export async function warmLocalVoice(serverUrl: string): Promise<void> {
  if (!isLocalDictationServer(serverUrl)) return;
  if (pending) return pending;
  pending = (async () => {
    try {
      const health = await fetchHealth(serverUrl);
      if (!health || health.loaded !== false || !health.model) return;
      await postSilentWarmup(serverUrl, health.model);
    } catch { /* Optional warming must never prevent actual dictation. */ }
  })();
  try { await pending; } finally { pending = null; }
}

/** Every four minutes — below the server's five-minute model idle timeout. */
export const VOICE_KEEPALIVE_INTERVAL_MS = 4 * 60_000;

export interface VoiceKeepaliveOptions {
  /** Read settings fresh each tick so a changed/cleared URL takes effect. */
  getTarget: () => { serverUrl: string; model: string };
  intervalMs?: number;
  /** First tick delay after boot, so startup work is not competing with it. */
  startupDelayMs?: number;
}

/**
 * Keeps the local dictation model loaded for as long as Coterm runs. Returns
 * a stop function for shutdown. Only ever talks to isLocalDictationServer
 * URLs; a hosted or unrecognized URL makes every tick a no-op.
 */
export function startVoiceKeepalive(options: VoiceKeepaliveOptions): () => void {
  const intervalMs = options.intervalMs ?? VOICE_KEEPALIVE_INTERVAL_MS;
  const startupDelayMs = options.startupDelayMs ?? 10_000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Log only on reachability transitions, not every tick — a server left off
  // all day must not spray a warning line every four minutes.
  let lastReachable: boolean | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const target = options.getTarget();
    if (target.serverUrl.trim() && isLocalDictationServer(target.serverUrl)) {
      // A press-time warm already in flight covers this window; skip the tick.
      if (!pending) {
        const reachable = await keepLocalVoiceAlive(target.serverUrl, target.model);
        if (reachable !== lastReachable) {
          lastReachable = reachable;
          const host = "127.0.0.1:8766";
          if (reachable) {
            logger.info("voice", "keepalive.ok", "Local dictation server is warm and held.", { host });
          } else {
            logger.warn("voice", "keepalive.unreachable", "Local dictation server did not answer a keep-alive ping.", { host });
          }
        }
      }
    }
    if (!stopped) schedule(intervalMs);
  };
  const schedule = (delay: number): void => {
    timer = setTimeout(() => void tick(), delay);
    // Never hold the event loop (or a test process) open for a keep-alive.
    (timer as unknown as { unref?: () => void }).unref?.();
  };
  schedule(startupDelayMs);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

/**
 * One silent-wav transcription request, sent even when the model is already
 * loaded — the inference itself is what resets the server's idle timer. The
 * clip is 100ms of zeros; no microphone data ever crosses this path.
 */
async function keepLocalVoiceAlive(serverUrl: string, fallbackModel: string): Promise<boolean> {
  try {
    const health = await fetchHealth(serverUrl);
    if (!health) return false;
    const model = health.model ?? fallbackModel.trim();
    if (!model) return false;
    await postSilentWarmup(serverUrl, model);
    return true;
  } catch {
    return false;
  }
}

async function fetchHealth(serverUrl: string): Promise<VoiceServerHealth | null> {
  const url = new URL(serverUrl);
  const response = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(2000) });
  if (!response.ok) return null;
  const body = await response.json() as { ok?: boolean; loaded?: boolean; model?: string };
  if (body.ok !== true || typeof body.loaded !== "boolean") return null;
  return { loaded: body.loaded, model: typeof body.model === "string" && body.model ? body.model : null };
}

async function postSilentWarmup(serverUrl: string, model: string): Promise<void> {
  const url = new URL(serverUrl);
  // 100ms of silent PCM, no microphone data and no returned text is used.
  const wav = new ArrayBuffer(44 + 3200);
  const view = new DataView(wav);
  const label = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  label(0, "RIFF"); view.setUint32(4, wav.byteLength - 8, true); label(8, "WAVE");
  label(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  label(36, "data"); view.setUint32(40, 3200, true);
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "warmup.wav");
  form.append("model", model);
  form.append("model_name", model);
  form.append("language", "zh");
  const warmed = await fetch(new URL("/v1/audio/transcriptions", url), {
    method: "POST", body: form, signal: AbortSignal.timeout(90000),
  });
  await warmed.body?.cancel();
}
