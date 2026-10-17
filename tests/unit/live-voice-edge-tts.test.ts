import { describe, expect, it } from "vitest";
import {
  escapeSsmlText,
  extractAudioPayload,
  speechConfigMessage,
  ssmlMessage,
  EDGE_TTS_SAMPLE_RATE,
} from "../../src/main/voice/live/worker/edge-tts";

describe("escapeSsmlText", () => {
  it("escapes all five XML entities", () => {
    expect(escapeSsmlText("a & b < c > d \" e ' f")).toBe(
      "a &amp; b &lt; c &gt; d &quot; e &apos; f",
    );
  });

  it("returns plain text unchanged", () => {
    expect(escapeSsmlText("今天天氣很好")).toBe("今天天氣很好");
  });
});

describe("speechConfigMessage", () => {
  it("includes the PCM output format", () => {
    const msg = speechConfigMessage();
    expect(msg).toContain("raw-24khz-16bit-mono-pcm");
    expect(msg).toContain("Path:speech.config");
    expect(msg).toContain("Content-Type:application/json");
  });

  it("has the expected sample rate", () => {
    expect(EDGE_TTS_SAMPLE_RATE).toBe(24_000);
  });
});

describe("ssmlMessage", () => {
  it("embeds escaped text and request id", () => {
    const msg = ssmlMessage("hello <world>", "zh-TW-HsiaoChenNeural", "abc123");
    expect(msg).toContain("X-RequestId:abc123");
    expect(msg).toContain("Path:ssml");
    expect(msg).toContain("hello &lt;world&gt;");
    expect(msg).toContain("zh-TW-HsiaoChenNeural");
    expect(msg).toContain("xml:lang='zh-TW'");
  });

  it("escapes the voice name", () => {
    const msg = ssmlMessage("text", "voice<evil>", "id");
    expect(msg).toContain("voice&lt;evil&gt;");
  });
});

describe("extractAudioPayload", () => {
  it("parses a valid binary frame", () => {
    const header = Buffer.from("X-Custom:test\r\n\r\n", "utf8");
    const pcm = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const headerLen = header.byteLength;
    const frame = new Uint8Array(2 + headerLen + pcm.byteLength);
    const view = new DataView(frame.buffer);
    view.setUint16(0, headerLen, false); // big-endian
    frame.set(header, 2);
    frame.set(pcm, 2 + headerLen);
    const payload = extractAudioPayload(frame);
    expect(payload).not.toBeNull();
    expect(Array.from(payload!)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("returns null for frames shorter than 2 bytes", () => {
    expect(extractAudioPayload(new Uint8Array([0]))).toBeNull();
  });

  it("returns null for zero header length", () => {
    const frame = new Uint8Array([0, 0, 1, 2]);
    expect(extractAudioPayload(frame)).toBeNull();
  });

  it("returns null when header length exceeds frame", () => {
    const frame = new Uint8Array([0xff, 0xff, 1]);
    expect(extractAudioPayload(frame)).toBeNull();
  });
});
