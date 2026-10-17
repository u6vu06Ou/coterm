import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Room } from "@livekit/rtc-node";
import { ensureLivekitServerExecutable } from "../src/main/voice/live/server-artifact";
import { LivekitServerProcess } from "../src/main/voice/live/livekit-server-process";
import {
  issueLiveVoiceToken,
  liveVoiceRoomName,
  userIdentityForSession,
} from "../src/main/voice/live/livekit-token";

/**
 * Opt-in, true-machine verification for the LiveKit duplex voice pipeline.
 * NOT part of CI — phase A downloads the pinned livekit-server binary once
 * from GitHub releases (work order §6: one real download, hashes verified).
 *
 * Usage: npx tsx scripts/verify-live-duplex.ts --phase=a
 */
const phase = process.argv.find((arg) => arg.startsWith("--phase="))?.split("=")[1] ?? "";
if (phase !== "a") {
  throw new Error("Only --phase=a is implemented (server spawn + room join/leave).");
}

const targetDir = process.env.COTERM_LIVEKIT_VERIFY_DIR?.trim() || join(tmpdir(), "coterm-livekit-verify");
const voiceSessionId = "verify-a";
const apiKey = `verify-${randomBytes(16).toString("hex")}`;
const apiSecret = randomBytes(24).toString("base64url");

console.log(JSON.stringify({ step: "artifact", targetDir }));
const artifact = await ensureLivekitServerExecutable(targetDir);
if (!artifact.ok) throw new Error(`artifact: ${artifact.reason}`);

const server = new LivekitServerProcess({ executablePath: artifact.path, apiKey, apiSecret });
let room: Room | null = null;
try {
  await server.start();
  let healthy = false;
  for (let i = 0; i < 40 && !healthy; i += 1) {
    healthy = await server.health();
    if (!healthy) await new Promise((r) => setTimeout(r, 250));
  }
  if (!healthy) throw new Error("livekit-server did not open its port within 10s.");
  console.log(JSON.stringify({ step: "server", port: 7880, healthy: true }));

  const token = await issueLiveVoiceToken({
    voiceSessionId,
    apiKey,
    apiSecret,
    identity: userIdentityForSession(voiceSessionId),
  });
  const { ConnectionState, Room, RoomEvent } = await import("@livekit/rtc-node");
  room = new Room();
  const states: string[] = [];
  room.on(RoomEvent.ConnectionStateChanged, (state) => states.push(String(state)));
  await room.connect("ws://127.0.0.1:7880", token);
  if (room.connectionState !== ConnectionState.CONN_CONNECTED) {
    throw new Error(`room did not reach connected state (state=${room.connectionState}).`);
  }
  await room.disconnect();
  room = null;
  console.log(JSON.stringify({
    ok: true,
    phase: "a",
    room: liveVoiceRoomName(voiceSessionId),
    identity: userIdentityForSession(voiceSessionId),
    states,
  }));
} finally {
  if (room) await room.disconnect().catch(() => undefined);
  await server.stop().catch(() => undefined);
}
// rtc-node's native FFI keeps the event loop alive after disconnect; force exit.
process.exit(0);
