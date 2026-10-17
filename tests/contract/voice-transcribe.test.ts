import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { transcribeVoice } from "../../src/main/voice/transcribe";

const AUDIO = new Uint8Array([1, 2, 3, 4]).buffer;
let server: Server | null = null;

afterEach(async () => {
  // A timed-out attempt can leave a socket open; close() alone would wait for it.
  server?.closeAllConnections?.();
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  server = null;
});

describe("OpenAI transcription HTTP contract", () => {
  it("posts the expected multipart fields to exactly one v1 transcription path", async () => {
    const request = await captureRequest(JSON.stringify({ text: "  繁體中文結果  " }));
    const result = await transcribeVoice({
      audio: AUDIO,
      mimeType: "audio/webm",
      lang: "zh-TW",
      serverUrl: `${request.origin}/v1`,
      model: "large-v3",
    });

    expect(result).toEqual({ text: "繁體中文結果" });
    expect(request.received.url).toBe("/v1/audio/transcriptions");
    expect(request.received.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(request.received.body).toContain('name="file"; filename="clip.webm"');
    expect(request.received.body).toContain('name="model"');
    expect(request.received.body).toContain("large-v3");
    // A local faster_whisper_server reads `model_name`, not `model`, and falls
    // back to whisper-1 silently — the configured sttModel was ignored until
    // both spellings were sent (survey 2026-09-20).
    expect(request.received.body).toContain('name="model_name"');
    expect(request.received.body).toContain('name="language"');
    expect(request.received.body).toContain("\r\nzh\r\n");
  });

  // Every desktop clip arrives as `audio/webm;codecs=opus` — rejecting the
  // codec parameter made the mic look dead with "Unsupported recording MIME type".
  it("accepts the parameterised MIME type MediaRecorder actually reports", async () => {
    const request = await captureRequest(JSON.stringify({ text: "ok" }));
    const result = await transcribeVoice({
      audio: AUDIO,
      mimeType: "audio/webm;codecs=opus",
      lang: "en-US",
      serverUrl: `${request.origin}/v1`,
      model: "whisper-1",
    });

    expect(result).toEqual({ text: "ok" });
    expect(request.received.body).toContain('name="file"; filename="clip.webm"');
  });

  it("rejects invalid JSON and oversized responses", async () => {
    const invalid = await captureRequest("not-json");
    await expect(transcribeVoice({
      audio: AUDIO,
      mimeType: "audio/webm",
      lang: "en-US",
      serverUrl: invalid.origin,
      model: "whisper-1",
    })).rejects.toThrow(/invalid response/i);
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    server = null;

    const oversized = await captureRequest(JSON.stringify({ text: "x".repeat(1_100_000) }));
    await expect(transcribeVoice({
      audio: AUDIO,
      mimeType: "audio/webm",
      lang: "en-US",
      serverUrl: oversized.origin,
      model: "whisper-1",
    })).rejects.toThrow(/response too large/i);
  });
  it("retries once without the prompt field when the server 5xx's (Groq rejects non-ASCII prompts)", async () => {
    const bodies: string[] = [];
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        bodies.push(Buffer.concat(chunks).toString("latin1"));
        if (bodies.length === 1) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Internal Server Error" } }));
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ text: "重試成功" }));
        }
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server!.address();
    if (!address || typeof address === "string") throw new Error("Mock server did not bind.");

    const result = await transcribeVoice({
      audio: AUDIO,
      mimeType: "audio/webm",
      lang: "zh-TW",
      serverUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "whisper-large-v3",
    });

    expect(result).toEqual({ text: "重試成功" });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain('name="prompt"');
    expect(bodies[1]).not.toContain('name="prompt"');
  });

  // Issue #95: a 30s hard abort with no retry turned the STT box's ~40s respawn
  // window into a silently lost clip. The clip itself is fine on a timeout, so
  // the upload is resent instead of dropped.
  it("resends the clip when the server times out, and succeeds on a later attempt", async () => {
    process.env.COTERM_STT_TIMEOUT_MS = "1000";
    process.env.COTERM_STT_RETRY_DELAY_MS = "1";
    try {
      let requests = 0;
      server = createServer((req, res) => {
        requests += 1;
        req.on("data", () => undefined);
        req.on("end", () => {
          if (requests < 3) return; // hang → client-side timeout
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ text: "空窗後的補射" }));
        });
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const address = server!.address();
      if (!address || typeof address === "string") throw new Error("Mock server did not bind.");

      const result = await transcribeVoice({
        audio: AUDIO,
        mimeType: "audio/webm",
        lang: "zh-TW",
        serverUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "large-v3",
      });

      expect(result).toEqual({ text: "空窗後的補射" });
      expect(requests).toBe(3);
    } finally {
      delete process.env.COTERM_STT_TIMEOUT_MS;
      delete process.env.COTERM_STT_RETRY_DELAY_MS;
    }
  }, 30_000);

  // The retry is bounded — a genuinely dead server must still surface as the
  // (now actionable) unreachable error rather than retrying forever.
  it("gives up after the retry budget and reports the timeout", async () => {
    process.env.COTERM_STT_TIMEOUT_MS = "1000";
    process.env.COTERM_STT_RETRY_DELAY_MS = "1";
    try {
      let requests = 0;
      server = createServer((req) => {
        requests += 1;
        req.on("data", () => undefined);
        // Never respond.
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const address = server!.address();
      if (!address || typeof address === "string") throw new Error("Mock server did not bind.");

      await expect(transcribeVoice({
        audio: AUDIO,
        mimeType: "audio/webm",
        lang: "zh-TW",
        serverUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "large-v3",
      })).rejects.toThrow(/unreachable/i);
      expect(requests).toBe(3); // first attempt + 2 retries
    } finally {
      delete process.env.COTERM_STT_TIMEOUT_MS;
      delete process.env.COTERM_STT_RETRY_DELAY_MS;
    }
  }, 30_000);

  // 2026-10-17: utterances after an idle stretch died here — a server reloading
  // its model refuses/reset sockets, and only timeouts were retried. Socket
  // failures on an intact clip join the same bounded resend budget now.
  it("resends the clip when the socket dies mid-request (server reload window)", async () => {
    process.env.COTERM_STT_RETRY_DELAY_MS = "1";
    try {
      let requests = 0;
      server = createServer((req, res) => {
        requests += 1;
        if (requests < 3) {
          req.socket.destroy();
          return;
        }
        req.on("data", () => undefined);
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ text: "重載後接住" }));
        });
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const address = server!.address();
      if (!address || typeof address === "string") throw new Error("Mock server did not bind.");

      const result = await transcribeVoice({
        audio: AUDIO,
        mimeType: "audio/webm",
        lang: "zh-TW",
        serverUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "large-v3",
      });

      expect(result).toEqual({ text: "重載後接住" });
      expect(requests).toBe(3);
    } finally {
      delete process.env.COTERM_STT_RETRY_DELAY_MS;
    }
  }, 30_000);
});

async function captureRequest(responseBody: string): Promise<{
  origin: string;
  received: { url: string; contentType: string; body: string };
}> {
  const received = { url: "", contentType: "", body: "" };
  server = createServer((req, res) => {
    received.url = req.url ?? "";
    received.contentType = String(req.headers["content-type"] ?? "");
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.body = Buffer.concat(chunks).toString("latin1");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(responseBody);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock server did not bind.");
  return { origin: `http://127.0.0.1:${address.port}`, received };
}
