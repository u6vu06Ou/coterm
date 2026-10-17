import { NO_SERVER_CODE } from "@shared/ipc";
import { STT_LANG_CODE, STT_PROMPT } from "@shared/stt-language";
import { resolveTranscriptionUrl } from "@shared/transcription-url";
import { logger } from "../core/logger";

export interface VoiceTranscribeRequest {
  audio: ArrayBuffer;
  mimeType: string;
  lang: string;
  /** From settings, read in main — never trusted from the renderer. */
  serverUrl: string;
  model: string;
  /** Hosted endpoints (Groq/OpenAI) need Bearer auth; empty = no header. */
  apiKey?: string | undefined;
}

export interface VoiceTranscriptionResult {
  text: string;
  /** Provider-reported only. Never inferred from the requested language. */
  detectedLanguage?: string | null;
}

// 90s, not 30s: a cold whisper model load is 8-10s and the STT box respawns
// often, so a 30s ceiling turned a ~40s server gap into a permanently lost clip.
const DEFAULT_TIMEOUT_MS = 90_000;
const TIMEOUT_RETRY_LIMIT = 2;
const DEFAULT_RETRY_DELAY_MS = 2_500;

/** Same escape hatch as the other COTERM_* env overrides: it lets a real
 *  machine (or a test) reproduce a timing-sensitive failure without a rebuild. */
function envMs(name: string, fallback: number, minimum: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= minimum ? raw : fallback;
}

function timeoutMs(): number {
  return envMs("COTERM_STT_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 1_000);
}

function retryDelayMs(): number {
  return envMs("COTERM_STT_RETRY_DELAY_MS", DEFAULT_RETRY_DELAY_MS, 1);
}

const MAX_CLIP_BYTES = 25 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1_000_000;

// Language codes/prompts live in @shared/stt-language so the LiveKit worker
// (plain Node, no src/main imports) uses the same hints.
const LANG_CODE = STT_LANG_CODE;
const PROMPT = STT_PROMPT;

/**
 * POST one recorded clip to an OpenAI-shaped /v1/audio/transcriptions endpoint.
 *
 * ponytail: no bespoke protocol and no bundled Python — every local whisper
 * server already speaks this request, so the client is one fetch and the user
 * can point it at whatever box has the GPU. Ceiling: no `hotwords`, so a custom
 * vocabulary needs a server that accepts an extra field.
 */
export async function transcribeVoice(request: VoiceTranscribeRequest): Promise<VoiceTranscriptionResult> {
  const base = request.serverUrl.trim();
  if (!base) throw new Error(`${NO_SERVER_CODE}: no speech-to-text server configured (Settings → Voice input).`);
  let url: URL;
  try {
    url = resolveTranscriptionUrl(base);
  } catch {
    throw new Error(`Invalid speech-to-text server URL: ${base}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Speech-to-text server URL must be http(s): ${base}`);
  }
  if (request.audio.byteLength === 0) throw new Error("Empty recording.");
  if (request.audio.byteLength > MAX_CLIP_BYTES) throw new Error("Recording too long.");
  // MediaRecorder reports `audio/webm;codecs=opus`, which the bare type regex
  // rejected — every desktop clip died here. Validate and forward the essence;
  // whisper servers key off the filename extension, not the codec parameter.
  const mimeType = (request.mimeType.split(";", 1)[0] ?? "").trim().toLowerCase();
  if (!/^audio\/[a-z0-9.+-]+$/.test(mimeType)) throw new Error("Unsupported recording MIME type.");
  const model = request.model.trim();
  if (!model) throw new Error("Speech-to-text model is required.");

  const post = (withPrompt: string | undefined): Promise<Response> => {
    const form = new FormData();
    form.append("file", new Blob([request.audio], { type: mimeType }), recordingFilename(mimeType));
    // OpenAI-shaped servers (speaches/OpenAI/Groq) read `model`; a local
    // faster_whisper_server reads `model_name` and silently falls back to its
    // own default otherwise, so the configured sttModel was being ignored.
    // Send both — each ignores the field it does not know.
    form.append("model", model);
    form.append("model_name", model);
    form.append("response_format", "json");
    const code = LANG_CODE[request.lang];
    if (code) form.append("language", code);
    if (withPrompt) form.append("prompt", withPrompt);
    const headers: Record<string, string> = request.apiKey ? { authorization: `Bearer ${request.apiKey}` } : {};
    const budgetMs = timeoutMs();
    return fetch(url, {
      method: "POST",
      body: form,
      headers,
      signal: AbortSignal.timeout(budgetMs),
    }).catch((error: unknown) => {
      if (isTimeoutError(error)) {
        logger.warn("voice", "transcribe.timeout", "Speech-to-text server did not answer within the per-attempt budget.", {
          host: url.host,
          budgetMs,
        });
      }
      throw error;
    });
  };

  // A timeout is the classic failure worth retrying blindly: the clip is intact
  // and the server was merely busy (cold model load / respawn window). The 5xx
  // path below still swaps the prompt on its own retry; this wraps both.
  // 2026-10-17: socket-level rejections (fetch → TypeError on a refused/reset
  // connection) join the budget — a server mid-respawn refuses connections, and
  // that was still a silently lost dictation utterance. HTTP answers (4xx/5xx)
  // are never retried here: the server answered, so the problem is the request.
  const postWithTimeoutRetry = async (withPrompt: string | undefined): Promise<Response> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await post(withPrompt);
      } catch (error) {
        const socket = isSocketError(error);
        if ((!isTimeoutError(error) && !socket) || attempt >= TIMEOUT_RETRY_LIMIT) throw error;
        logger.warn(
          "voice",
          socket ? "transcribe.socket_retry" : "transcribe.timeout_retry",
          socket
            ? "Speech-to-text server refused the connection; resending the clip."
            : "Speech-to-text server timed out; resending the clip.",
          { host: url.host, attempt: attempt + 1 },
        );
        await delay(retryDelayMs());
      }
    }
  };

  const prompt = PROMPT[request.lang];
  const started = Date.now();
  let response: Response;
  try {
    response = await postWithTimeoutRetry(prompt);
    // Groq 500s on any non-ASCII prompt; retry once without it so zh dictation
    // degrades to language-hint-only instead of hard-failing.
    if (!response.ok && response.status >= 500 && prompt) {
      logger.warn("voice", "transcribe.retry_no_prompt", "Speech-to-text server 5xx'd on the prompt field; retrying without it.", {
        host: url.host,
        status: response.status,
      });
      response = await postWithTimeoutRetry(undefined);
    }
  } catch (error) {
    // Fail loudly: there is no second engine to fall back to on desktop, and a
    // silent failure reads as "the mic is broken".
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn("voice", "transcribe.unreachable", "Speech-to-text server unreachable.", {
      host: url.host,
      reason,
      timeout: isTimeoutError(error),
    });
    throw new Error(`Speech-to-text server unreachable (${url.host}): ${reason}`, { cause: error });
  }
  if (!response.ok) {
    logger.warn("voice", "transcribe.http_error", "Speech-to-text server rejected the clip.", {
      host: url.host,
      status: response.status,
    });
    throw new Error(`Speech-to-text server returned ${response.status}.`);
  }
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error("Speech-to-text response too large.");
  }
  const rawBody = await response.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("Speech-to-text response too large.");
  }
  let body: {
    text?: unknown;
    language?: unknown;
    detected_language?: unknown;
    detectedLanguage?: unknown;
  };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    throw new Error("Speech-to-text server returned an invalid response.");
  }
  if (typeof body.text !== "string") {
    throw new Error("Speech-to-text server returned an invalid response.");
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const detectedLanguageRaw = body.detectedLanguage ?? body.detected_language ?? body.language;
  const detectedLanguage = typeof detectedLanguageRaw === "string" && detectedLanguageRaw.trim()
    ? detectedLanguageRaw.trim().slice(0, 35)
    : null;
  // Metadata only — the transcript itself never reaches coterm.log.
  logger.info("voice", "transcribe.ok", "Transcribed a dictation clip.", {
    host: url.host,
    bytes: request.audio.byteLength,
    ms: Date.now() - started,
    chars: text.length,
  });
  return detectedLanguage ? { text, detectedLanguage } : { text };
}

// resolveTranscriptionUrl now lives in @shared/transcription-url so the plain-Node
// LiveKit worker can reuse the exact same resolution without importing this
// main-process module. Re-exported here to avoid touching existing callers.
export { resolveTranscriptionUrl };

function isTimeoutError(error: unknown): boolean {
  if (error instanceof DOMException) return error.name === "TimeoutError" || error.name === "AbortError";
  const name = (error as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

// fetch() rejects with a TypeError when the socket never connects or dies
// mid-request (ECONNREFUSED/ECONNRESET/"fetch failed" = server mid-respawn).
// The timeout/abort signals above are DOMExceptions, disjoint from this.
function isSocketError(error: unknown): boolean {
  return error instanceof TypeError;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recordingFilename(mimeType: string): string {
  if (/ogg/i.test(mimeType)) return "clip.ogg";
  if (/wav/i.test(mimeType)) return "clip.wav";
  if (/mpeg|mp3/i.test(mimeType)) return "clip.mp3";
  if (/mp4|m4a/i.test(mimeType)) return "clip.m4a";
  return "clip.webm";
}
