/**
 * Main → worker control channel (work order §1.4). Three message types ride
 * on child_process IPC `send`: speak / stop-speaking / shutdown. The reverse
 * direction stays on the original 4-event LiveVoiceWorkerEvent protocol, and
 * the no-raw-audio rule applies here as well.
 */
export type LiveVoiceWorkerCommand =
  | { type: "speak"; voiceSessionId: string; text: string }
  | { type: "stop-speaking" }
  | { type: "shutdown" };

const MAX_SPEAK_CHARS = 12_000;
const MAX_ID_CHARS = 160;

export function parseWorkerCommand(raw: unknown): LiveVoiceWorkerCommand {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid live voice worker command.");
  const input = raw as Record<string, unknown>;
  rejectAudioCommandFields(input);
  if (input.type === "shutdown") return { type: "shutdown" };
  if (input.type === "stop-speaking") return { type: "stop-speaking" };
  if (input.type === "speak") {
    const voiceSessionId = boundedId(input.voiceSessionId);
    const text = typeof input.text === "string" ? input.text.trim().slice(0, MAX_SPEAK_CHARS) : "";
    if (!text) throw new Error("Speak command text is required.");
    return { type: "speak", voiceSessionId, text };
  }
  throw new Error("Unknown live voice worker command.");
}

export function serializeWorkerCommand(command: LiveVoiceWorkerCommand): string {
  return JSON.stringify(parseWorkerCommand(JSON.parse(JSON.stringify(command))));
}

export interface SendTarget {
  send(message: unknown): boolean;
}

/** Best-effort send; false when the child is gone or IPC is closed. */
export function sendWorkerCommand(target: SendTarget | null | undefined, command: LiveVoiceWorkerCommand): boolean {
  if (!target) return false;
  try {
    return target.send(command);
  } catch {
    return false;
  }
}

function rejectAudioCommandFields(input: Record<string, unknown>): void {
  for (const key of Object.keys(input)) {
    if (/audio|pcm|webm|opus|buffer|bytes|base64/i.test(key)) {
      throw new Error("Raw audio is forbidden on the live voice worker control channel.");
    }
  }
}

function boundedId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.length > MAX_ID_CHARS) throw new Error("Invalid live voice session id.");
  return id;
}
