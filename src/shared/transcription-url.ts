/**
 * URL resolution for OpenAI-shaped /v1/audio/transcriptions endpoints. Shared
 * by the main-process dictation path and the LiveKit voice worker (which runs
 * in a plain-Node fork and cannot import main-process modules).
 */
export function resolveTranscriptionUrl(base: string): URL {
  const url = new URL(base);
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/v1/audio/transcriptions")) {
    url.pathname = path;
  } else if (path.endsWith("/v1")) {
    url.pathname = `${path}/audio/transcriptions`;
  } else {
    url.pathname = `${path}/v1/audio/transcriptions`.replace(/^\/?/, "/");
  }
  return url;
}
