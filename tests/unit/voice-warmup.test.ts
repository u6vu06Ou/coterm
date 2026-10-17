import { afterEach, describe, expect, it, vi } from "vitest";
import { startVoiceKeepalive, warmLocalVoice } from "../../src/main/voice/warmup";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("local dictation warming", () => {
  it("never calls a hosted or unrecognized endpoint", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await warmLocalVoice("https://api.openai.com/v1");
    await warmLocalVoice("http://127.0.0.1:8765");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does nothing when the local model is already warm", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, loaded: true, model: "large-v3" })));
    vi.stubGlobal("fetch", fetch);
    await warmLocalVoice("http://127.0.0.1:8766");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("deduplicates cold warming and uploads only valid silent PCM", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, loaded: false, model: "large-v3" })))
      .mockResolvedValueOnce(new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    await Promise.all([warmLocalVoice("http://127.0.0.1:8766"), warmLocalVoice("http://127.0.0.1:8766")]);
    expect(fetch).toHaveBeenCalledTimes(2);
    const body = fetch.mock.calls[1]![1].body as FormData;
    const wav = await (body.get("file") as Blob).arrayBuffer();
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(new Uint8Array(wav.slice(44)).every((v) => v === 0)).toBe(true);
  });
  it("tolerates an unavailable local server", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(warmLocalVoice("http://127.0.0.1:8766")).resolves.toBeUndefined();
  });
});

describe("local dictation keep-alive", () => {
  const okHealth = () => new Response(JSON.stringify({ ok: true, loaded: true, model: "large-v3" }));

  it("pings the server even when the model is already loaded — the ping itself resets the idle timer", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation((_url: URL) => Promise.resolve(_url.href.includes("/health") ? okHealth() : new Response("{}")));
    vi.stubGlobal("fetch", fetch);
    const stop = startVoiceKeepalive({
      getTarget: () => ({ serverUrl: "http://127.0.0.1:8766", model: "large-v3" }),
      startupDelayMs: 1_000,
      intervalMs: 240_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch).toHaveBeenCalledTimes(2); // health + silent-wav POST
    await vi.advanceTimersByTimeAsync(240_000);
    expect(fetch).toHaveBeenCalledTimes(4); // next tick did it again
    stop();
    await vi.advanceTimersByTimeAsync(480_000);
    expect(fetch).toHaveBeenCalledTimes(4); // stopped: no more pings
  });

  it("never pings hosted or unrecognized endpoints, and no-ops on an empty URL", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue(okHealth());
    vi.stubGlobal("fetch", fetch);
    let serverUrl = "https://api.groq.com/openai/v1";
    const stop = startVoiceKeepalive({
      getTarget: () => ({ serverUrl, model: "whisper-large-v3" }),
      startupDelayMs: 1_000,
      intervalMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).not.toHaveBeenCalled();
    serverUrl = "http://192.168.1.10:8766"; // LAN box: still not the loopback contract
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).not.toHaveBeenCalled();
    serverUrl = ""; // dictation not configured
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).not.toHaveBeenCalled();
    stop();
  });

  it("survives a dead server and pings again after it comes back", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation((_url: unknown) => Promise.resolve(String(_url).includes("/health") ? okHealth() : new Response("{}")));
    vi.stubGlobal("fetch", fetch);
    const stop = startVoiceKeepalive({
      getTarget: () => ({ serverUrl: "http://127.0.0.1:8766", model: "large-v3" }),
      startupDelayMs: 1_000,
      intervalMs: 240_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch).toHaveBeenCalledTimes(1); // failed health check, swallowed
    await vi.advanceTimersByTimeAsync(240_000);
    expect(fetch).toHaveBeenCalledTimes(3); // recovered: health + POST
    stop();
  });
});
