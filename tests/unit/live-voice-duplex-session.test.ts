import { describe, expect, it, vi } from "vitest";
import type { VoiceSessionCommand, VoiceSessionCommandResult } from "@shared/types";

vi.mock("livekit-client", () => ({
  ConnectionState: { Disconnected: 0, Connected: 1, Reconnecting: 2 },
  Room: class {},
  RoomEvent: {
    TrackSubscribed: "trackSubscribed",
    TrackUnsubscribed: "trackUnsubscribed",
    Reconnecting: "reconnecting",
    Reconnected: "reconnected",
    Disconnected: "disconnected",
  },
  Track: { Kind: { Audio: "audio", Video: "video" } },
}));

import { RoomEvent } from "livekit-client";
import { LivekitDuplexSession, type LivekitRendererStage } from "../../src/renderer/src/voice-agent/livekit-duplex";

function makeFakeRoom() {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const room = {
    state: 1,
    published: [] as unknown[],
    micEnabled: [] as boolean[],
    connectedWith: null as { url: string; token: string } | null,
    disconnectCount: 0,
    on(event: string, cb: (...args: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), cb]);
      return room;
    },
    async connect(url: string, token: string) {
      room.connectedWith = { url, token };
    },
    localParticipant: {
      async publishTrack(track: unknown, options: unknown) {
        room.published.push({ track, options });
      },
      async setMicrophoneEnabled(enabled: boolean) {
        room.micEnabled.push(enabled);
      },
    },
    async disconnect() {
      room.disconnectCount++;
    },
    emit(event: string, ...args: unknown[]) {
      for (const cb of listeners.get(event) ?? []) cb(...args);
    },
  };
  return room;
}

const FAKE_MIC_TRACK = { stop: vi.fn() } as unknown as MediaStreamTrack;

function makeDeps(overrides?: { onDisconnected?: () => void; onStage?: (stage: LivekitRendererStage) => void }) {
  const commands: VoiceSessionCommand[] = [];
  const room = makeFakeRoom();
  const playedTracks: unknown[] = [];
  const deps = {
    url: "ws://127.0.0.1:7880",
    token: "t",
    voiceSessionId: "vs-1",
    sendCommand: async (command: VoiceSessionCommand) => {
      commands.push(command);
      return {} as VoiceSessionCommandResult;
    },
    playTrack: (track: MediaStreamTrack) => {
      playedTracks.push(track);
      return vi.fn();
    },
    createRoom: () => room as never,
    getUserMedia: async () =>
      ({ getAudioTracks: () => [FAKE_MIC_TRACK] }) as unknown as MediaStream,
    ...(overrides ?? {}),
  };
  return { room, deps, commands, playedTracks };
}

describe("LivekitDuplexSession (BDD, mocked transport)", () => {
  it("guards browser-only AudioContext APIs in Node", () => {
    const { deps } = makeDeps();
    const session = new LivekitDuplexSession(deps);
    const originalWindow = globalThis.window;
    vi.stubGlobal("window", undefined);
    try {
      expect((session as unknown as { startMicMeter: (stream: MediaStream) => unknown })
        .startMicMeter({} as MediaStream)).toBeNull();
    } finally {
      vi.stubGlobal("window", originalWindow);
    }
  });

  it("joins the room and publishes the mic as user-mic", async () => {
    const { room, deps } = makeDeps();
    const session = new LivekitDuplexSession(deps);
    const transport = await session.start();
    expect(room.connectedWith).toEqual({ url: "ws://127.0.0.1:7880", token: "t" });
    expect(room.published).toHaveLength(1);
    expect((room.published[0] as { options: { name: string } }).options.name).toBe("user-mic");
    expect(transport.connectionState()).toBe(1);
  });

  it("reports renderer sound-path stages without media payloads", async () => {
    const stages: LivekitRendererStage[] = [];
    const { room, deps } = makeDeps({ onStage: (stage) => stages.push(stage) });
    const session = new LivekitDuplexSession(deps);
    await session.start();
    expect(stages.map((stage) => `${stage.stage}:${stage.state}`)).toEqual(expect.arrayContaining([
      "room:connecting",
      "room:connected",
      "permission:requested",
      "permission:granted",
      "mic-capture:track-ready",
      "publish:published",
    ]));

    const track = { mediaStreamTrack: {} as MediaStreamTrack, kind: "audio" };
    const participant = { identity: "agent-vs-1" };
    room.emit(RoomEvent.TrackSubscribed, track, { kind: "audio" }, participant);
    expect(stages.some((stage) => stage.stage === "speaker" && stage.state === "playing")).toBe(true);
    expect(JSON.stringify(stages)).not.toContain("token");
    await session.stop();
  });

  it("plays the agent audio track and reports reply-finished when it ends", async () => {
    const { room, deps, commands, playedTracks } = makeDeps();
    const session = new LivekitDuplexSession(deps);
    await session.start();
    const mediaStreamTrack = {} as MediaStreamTrack;
    const track = { mediaStreamTrack, kind: "audio" };
    const participant = { identity: "agent-vs-1" };
    room.emit(RoomEvent.TrackSubscribed, track, { kind: "audio" }, participant);
    expect(playedTracks).toHaveLength(1);
    room.emit(RoomEvent.TrackUnsubscribed, track, { kind: "audio" }, participant);
    expect(commands).toContainEqual({ action: "reply-finished", voiceSessionId: "vs-1" });
  });

  it("ignores tracks that are not audio or not from the agent", async () => {
    const { room, deps, playedTracks } = makeDeps();
    const session = new LivekitDuplexSession(deps);
    await session.start();
    const track = { mediaStreamTrack: {} as MediaStreamTrack, kind: "video" };
    room.emit(RoomEvent.TrackSubscribed, track, { kind: "video" }, { identity: "agent-x" });
    const audioTrack = { mediaStreamTrack: {} as MediaStreamTrack, kind: "audio" };
    room.emit(RoomEvent.TrackSubscribed, audioTrack, { kind: "audio" }, { identity: "user-y" });
    expect(playedTracks).toHaveLength(0);
  });

  it("maps reconnecting/reconnected/disconnected onto session commands", async () => {
    const disconnected: string[] = [];
    const { room, deps, commands } = makeDeps({ onDisconnected: () => disconnected.push("d") });
    const session = new LivekitDuplexSession(deps);
    await session.start();
    room.emit(RoomEvent.Reconnecting);
    room.emit(RoomEvent.Reconnected);
    expect(commands).toContainEqual({ action: "reconnecting", voiceSessionId: "vs-1" });
    expect(commands).toContainEqual({
      action: "reconnected",
      voiceSessionId: "vs-1",
      transport: "livekit",
    });
    room.emit(RoomEvent.Disconnected);
    expect(disconnected).toHaveLength(1);
    // After stop() a stray Disconnected must not re-fire the callback.
    await session.stop();
    room.emit(RoomEvent.Disconnected);
    expect(disconnected).toHaveLength(1);
  });

  it("mute toggles the room microphone and stop tears down exactly once", async () => {
    const { room, deps } = makeDeps();
    const session = new LivekitDuplexSession(deps);
    const transport = await session.start();
    await transport.setMicrophoneMuted(true);
    await transport.setMicrophoneMuted(false);
    expect(room.micEnabled).toEqual([false, true]);
    await session.stop();
    await session.stop();
    expect((FAKE_MIC_TRACK.stop as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    expect(room.disconnectCount).toBe(1);
  });

  it("cleans the mic and room when publish fails during start", async () => {
    const { room, deps } = makeDeps();
    const stop = vi.fn();
    const micTrack = { stop } as unknown as MediaStreamTrack;
    deps.getUserMedia = async () => ({ getAudioTracks: () => [micTrack] }) as unknown as MediaStream;
    room.localParticipant.publishTrack = async () => { throw new Error("publish failed"); };
    const session = new LivekitDuplexSession(deps);
    await expect(session.start()).rejects.toThrow("publish failed");
    expect(stop).toHaveBeenCalledOnce();
    expect(room.disconnectCount).toBe(1);
  });
});
