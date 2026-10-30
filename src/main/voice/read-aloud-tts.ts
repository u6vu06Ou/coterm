import { EdgeTTS } from "node-edge-tts";

/**
 * One-shot Edge TTS → mp3 for the 朗讀 button, via the `node-edge-tts`
 * package (MIT, no API key). We deliberately ride the package instead of a
 * hand-rolled socket: Microsoft rotated the consumer endpoint in 2025 and
 * gated the new one (api.msedgeservices.com) with a CS64-SHA256 demo-token
 * scheme; the package tracks that churn upstream so we don't have to.
 *
 * The mp3 is returned as bytes: the renderer plays it in an <audio> element,
 * which keeps playing on a locked phone screen once started (the whole point
 * of producing a file instead of using speechSynthesis).
 *
 * The text leaves the machine to Microsoft's consumer speech service — the
 * same trust decision users already make for Live Voice cloud TTS.
 */

const MAX_INPUT_CHARS = 4_000;
const TTS_TIMEOUT_MS = 30_000;
const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

/**
 * Synthesize the full text and return the collected mp3 bytes. Resolves
 * empty when the text is empty; rejects on socket/timeout failure.
 */
/** Edge voices are fixed tokens like `zh-TW-HsiaoChenNeural`; anything else
 *  is caller misuse (the voice string is interpolated into the TTS request). */
const VOICE_TOKEN = /^[\w-]+$/;

export async function synthesizeSpeechMp3(text: string, voice: string): Promise<Uint8Array> {
  if (!VOICE_TOKEN.test(voice)) throw new Error(`read-aloud: invalid voice token`);
  // council review: slice is code-unit based and could sever a surrogate pair
  // at the cap — truncate by code points instead.
  const trimmed = Array.from(text.trim()).slice(0, MAX_INPUT_CHARS).join("");
  if (!trimmed) return new Uint8Array(0);
  const tts = new EdgeTTS({ voice, outputFormat: OUTPUT_FORMAT, timeout: TTS_TIMEOUT_MS });
  const chunks: Buffer[] = [];
  for await (const chunk of tts.streamAudio(trimmed)) {
    // The stream also yields subtitle metadata lines (non-Buffer); audio is
    // Buffer chunks — collect those only.
    if (Buffer.isBuffer(chunk) && chunk.byteLength > 0) chunks.push(chunk);
  }
  if (chunks.length === 0) throw new Error("edge-tts stream produced no audio");
  // Buffer IS a Uint8Array — concat and return directly (no second copy).
  return Buffer.concat(chunks);
}
