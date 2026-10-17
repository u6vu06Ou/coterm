import { describe, expect, it } from "vitest";
import {
  parseWorkerCommand,
  sendWorkerCommand,
  serializeWorkerCommand,
} from "../../src/main/voice/live/livekit-worker-commands";

describe("live voice worker commands (main → worker)", () => {
  it("parses the three allowed command types", () => {
    expect(parseWorkerCommand({ type: "shutdown" })).toEqual({ type: "shutdown" });
    expect(parseWorkerCommand({ type: "stop-speaking" })).toEqual({ type: "stop-speaking" });
    expect(parseWorkerCommand({ type: "speak", voiceSessionId: "vs-1", text: " 哈囉 " })).toEqual({
      type: "speak",
      voiceSessionId: "vs-1",
      text: "哈囉",
    });
  });

  it("rejects audio-shaped fields — the no-raw-audio rule also applies here", () => {
    expect(() => parseWorkerCommand({ type: "speak", voiceSessionId: "vs-1", text: "x", pcm: "AAAA" }))
      .toThrow(/audio/i);
    expect(() => parseWorkerCommand({ type: "speak", voiceSessionId: "vs-1", text: "x", buffer: [1] }))
      .toThrow(/audio/i);
  });

  it("rejects unknown types, empty text, and oversized ids", () => {
    expect(() => parseWorkerCommand({ type: "yell", voiceSessionId: "vs-1" })).toThrow(/unknown/i);
    expect(() => parseWorkerCommand({ type: "speak", voiceSessionId: "vs-1", text: "   " })).toThrow(/text/i);
    expect(() => parseWorkerCommand({ type: "speak", voiceSessionId: "x".repeat(200), text: "hi" })).toThrow(/id/i);
  });

  it("bounds speak text to 12k chars and round-trips through serialize", () => {
    const long = "a".repeat(20_000);
    const parsed = parseWorkerCommand({ type: "speak", voiceSessionId: "vs-1", text: long });
    expect(parsed.type === "speak" && parsed.text.length).toBe(12_000);
    const roundTrip = JSON.parse(serializeWorkerCommand({ type: "speak", voiceSessionId: "vs-1", text: "回覆文字" }));
    expect(roundTrip).toEqual({ type: "speak", voiceSessionId: "vs-1", text: "回覆文字" });
  });

  it("sendWorkerCommand is best-effort: null target and throwing send both yield false", () => {
    expect(sendWorkerCommand(null, { type: "shutdown" })).toBe(false);
    expect(sendWorkerCommand({ send: () => { throw new Error("closed"); } }, { type: "shutdown" })).toBe(false);
    const sent: unknown[] = [];
    expect(sendWorkerCommand({ send: (m) => { sent.push(m); return true; } }, { type: "stop-speaking" })).toBe(true);
    expect(sent).toEqual([{ type: "stop-speaking" }]);
  });
});
