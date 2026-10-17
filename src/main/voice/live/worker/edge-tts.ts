import { randomBytes } from "node:crypto";
import WebSocket from "ws";

const EDGE_ENDPOINT =
  "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4";

export const EDGE_TTS_SAMPLE_RATE = 24_000;
const MAX_SSML_TEXT_CHARS = 12_000;
const TURN_TIMEOUT_MS = 45_000;

export interface EdgeTtsChunk {
  /** raw-24khz-16bit-mono-pcm bytes, little-endian int16 */
  pcm: Uint8Array;
}

export interface EdgeTtsOptions {
  voice: string;
  signal?: AbortSignal;
  onChunk?: (chunk: EdgeTtsChunk) => void;
}

/**
 * Speaks one reply through Microsoft's consumer Edge TTS service. No SDK, no
 * upstream auth — the endpoint keys off a published client token and returns
 * raw PCM frames we can publish straight into the LiveKit room.
 *
 * The text itself is the agent's reply; it leaves the machine via this call,
 * same trust decision users already make when they enable cloud TTS.
 */
export async function synthesizeEdgeTts(text: string, options: EdgeTtsOptions): Promise<void> {
  const trimmed = text.trim().slice(0, MAX_SSML_TEXT_CHARS);
  if (!trimmed) return;
  if (options.signal?.aborted) return;

  const connectionId = randomHex(16);
  const url = `${EDGE_ENDPOINT}&ConnectionId=${connectionId}`;

  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
        Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        "Accept-Encoding": "gzip, deflate, br",
        "Accept-Language": "en-US,en;q=0.9",
      },
      perMessageDeflate: false,
    });
    let settled = false;
    let gotTurnEnd = false;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        socket.close();
      } catch {
        // closing an already-dead socket is best effort
      }
      if (error) reject(error);
      else resolve();
    };
    const ok = (): void => finish();
    const fail = (error: Error): void => finish(error);
    const timeout = setTimeout(() => {
      fail(new Error("Edge TTS turn timed out."));
    }, TURN_TIMEOUT_MS);

    const abort = () => fail(new Error("Edge TTS turn interrupted."));
    options.signal?.addEventListener("abort", abort, { once: true });

    socket.on("open", () => {
      socket.send(speechConfigMessage());
      socket.send(ssmlMessage(trimmed, options.voice, connectionId));
    });
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        const audio = extractAudioPayload(data);
        if (audio && audio.byteLength > 0) options.onChunk?.({ pcm: audio });
        return;
      }
      if (data.toString("utf8").includes("Path:turn.end")) {
        gotTurnEnd = true;
        ok();
      }
    });
    socket.on("error", (error: Error) => {
      fail(error);
    });
    socket.on("close", () => {
      if (!settled) {
        if (gotTurnEnd) ok();
        else fail(new Error("Edge TTS socket closed before turn.end."));
      }
    });
  });
}

export function escapeSsmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function speechConfigMessage(): string {
  // raw PCM keeps the pipeline simple — no container parsing in the worker.
  return [
    `X-Timestamp:${new Date().toISOString()}`,
    "Content-Type:application/json; charset=utf-8",
    "Path:speech.config",
    "",
    '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"raw-24khz-16bit-mono-pcm"}}}}',
  ].join("\r\n");
}

export function ssmlMessage(text: string, voice: string, connectionId: string): string {
  const escapedVoice = escapeSsmlText(voice);
  const ssml =
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-TW'>` +
    `<voice name='${escapedVoice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>` +
    `${escapeSsmlText(text)}</prosody></voice></speak>`;
  return [
    `X-RequestId:${connectionId}`,
    "Content-Type:application/ssml+xml",
    `X-Timestamp:${new Date().toISOString()}`,
    "Path:ssml",
    "",
    ssml,
  ].join("\r\n");
}

/**
 * Binary audio frames carry a 2-byte big-endian header length, then the
 * CRLF-terminated header block, then the PCM payload.
 */
export function extractAudioPayload(frame: Uint8Array): Uint8Array | null {
  if (frame.byteLength < 2) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const headerLength = view.getUint16(0, false);
  if (headerLength <= 0 || headerLength + 2 > frame.byteLength) return null;
  return frame.subarray(2 + headerLength);
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}
