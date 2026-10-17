import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const baseUrl = process.env.COTERM_STT_URL;
const audioPath = process.env.COTERM_STT_AUDIO;
const model = process.env.COTERM_STT_MODEL ?? "whisper-1";
// Hosted endpoints (Groq/OpenAI) need Bearer auth. The key itself is never
// logged — only whether it was provided.
const apiKey = process.env.COTERM_STT_API_KEY?.trim() ?? "";

if (!baseUrl || !audioPath) {
  throw new Error("Set COTERM_STT_URL and COTERM_STT_AUDIO for the opt-in live STT check.");
}

// Same resolution as src/main/voice/transcribe.ts: bare hosts and /v1 roots
// both land on the OpenAI-shaped transcriptions route.
const url = new URL(baseUrl);
const path = url.pathname.replace(/\/+$/, "");
if (path.endsWith("/v1/audio/transcriptions")) {
  url.pathname = path;
} else if (path.endsWith("/v1")) {
  url.pathname = `${path}/audio/transcriptions`;
} else {
  url.pathname = `${path}/v1/audio/transcriptions`.replace(/^\/?/, "/");
}

if (!apiKey && /(^|\.)groq\.com$/i.test(url.hostname)) {
  throw new Error("COTERM_STT_API_KEY is required for the Groq endpoint — set it and re-run instead of debugging a bare 401.");
}

const form = new FormData();
form.append("file", new Blob([await readFile(audioPath)]), basename(audioPath));
form.append("model", model);
form.append("response_format", "json");
form.append("language", "zh");
const response = await fetch(url, {
  method: "POST",
  body: form,
  headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
  signal: AbortSignal.timeout(120_000),
});
if (!response.ok) {
  const hint = response.status === 401 && !apiKey ? " (no COTERM_STT_API_KEY was set)" : "";
  throw new Error(`STT returned HTTP ${response.status} from ${url.host}${hint}.`);
}
const body = await response.json() as { text?: unknown };
if (typeof body.text !== "string" || !body.text.trim()) throw new Error("STT returned an empty transcript.");
console.log(JSON.stringify({ ok: true, host: url.host, auth: apiKey ? "bearer" : "none", chars: body.text.trim().length }));
