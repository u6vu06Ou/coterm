import { resolveTranscriptionUrl } from "@shared/transcription-url";

/**
 * Default wall-clock budget for a single STT reachability probe (work order §4).
 */
export const PREFLIGHT_STT_TIMEOUT_MS = 4_000;

/**
 * Lightweight reachability probe for an OpenAI-shaped STT endpoint. Returns
 * `true` when the host answers at HTTP level (any status, including 405 on HEAD
 * or 404), and `false` on refused/timeout/unreachable.
 *
 * It deliberately sends only a HEAD with no body and never any transcription
 * file: its only purpose is to distinguish "endpoint is down" from "Live Voice
 * failed for another reason", so the failure can be surfaced with an actionable
 * message instead of dropping into a chunked path that cannot transcribe either
 * (Live Voice and chunked dictation share the same STT URL). Never logs the URL
 * or any response body.
 */
export async function preflightSttReachable(url: string, timeoutMs = PREFLIGHT_STT_TIMEOUT_MS): Promise<boolean> {
  try {
    const response = await fetch(resolveTranscriptionUrl(url).toString(), {
      method: "HEAD",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.status > 0;
  } catch {
    return false;
  }
}
