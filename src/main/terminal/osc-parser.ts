// OSC 133 / 633 shell-integration sequence parser + OSC 9/99/777 notifications.
//
// Contract (VS Code FinalTerm / 633):
//   OSC 633 ; A          prompt start
//   OSC 633 ; B          prompt end
//   OSC 633 ; C          pre-execution (command is about to run)
//   OSC 633 ; D [;exit]  finished (optional exit code)
//   OSC 633 ; E ; <cmd>  escaped exact command (633 only)
//   OSC 133 ; A/B/C/D    the original (pre-633) set — same semantics, no E
//
// Notification markers (agent attention signals — iTerm2 / FinalTerm / rxvt):
//   OSC 9 ; <message>                 iTerm2 growl-style user notification
//   OSC 99 ; i=...; <message>         iTerm2 inline alert (args optional)
//   OSC 777 ; notify ; <title> ; <body>  rxvt-unicode notify
// These carry a free-form message used ONLY as a transient classification
// input — PtyManager maps it to an attention state, then discards it. The
// message is never stored on the marker, logged, or sent to AttentionCenter
// (logging-api §A.2: no raw PTY / prompt / approval text in coterm.log).
//
// Both BEL (\x07) and ST (\x1b\\) terminate an OSC. A sequence may be split
// across arbitrary PTY chunk boundaries, so the parser is stateful: feed it
// chunks via parseOscChunk, collect emitted markers, and the carryover it
// returns is the unparsed tail to prepend to the next chunk.
//
// 633 E command escaping (official): \\xAB → byte 0xAB, \\\\ → literal backslash.
// Only a rich lifecycle (E + C + D) yields a CommandResult; OSC 133 has no E,
// so it can never fabricate a command — getLastCommand returns null instead.
//
// This parser is deliberately independent of PtyManager's titleBuffer (which
// parses OSC 0 titles) so the two concerns never share mutable state.

const ESC = "\x1b";
const BEL = "\x07";

export type OscMarkerKind =
  | "promptStart" // 633/133 A
  | "promptEnd" // 633/133 B
  | "preExec" // 633/133 C
  | "finished" // 633/133 D (exitCode may be null)
  | "command" // 633 E (escaped exact command)
  | "cwd" // 633 P;Cwd=<escaped path>
  | "notification"; // OSC 9 / 99 / 777 attention marker

/**
 * Coarse classification of a notification marker's intent. Derived from the
 * message text ONLY as a transient hint — never persisted. PtyManager maps
 * these to canonical attention states; the message itself is discarded.
 */
export type NotificationKind =
  | "approval" // "approve", "permission", "allow"
  | "input" // "input", "waiting for", "prompt"
  | "blocked" // "blocked", "stuck", "waiting for lock"
  | "error" // "error", "failed", "panic"
  | "done" // "done", "complete", "finished"
  | "info"; // everything else (not an attention state)

export interface OscMarker {
  kind: OscMarkerKind;
  /** Exit code for `finished`, decoded command for `command`, cwd for `cwd`. null otherwise. */
  value: number | string | null;
  /** For `notification`: the coarse classification (message text is NOT kept). */
  notificationKind?: NotificationKind;
}

/**
 * Decode a 633 E (escaped exact command) payload per the official rule:
 *   \\xAB  → byte 0xAB (hex escape)
 *   \\\\   → literal backslash
 * Any other backslash sequence is left as-is (bounded: we do not invent rules).
 */
export function decodeEscapedCommand(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === "\\") {
      out += "\\";
      i += 1;
    } else if (next === "x" || next === "X") {
      const hex = raw.slice(i + 2, i + 4);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        i += 3;
      } else {
        // Malformed hex — leave the backslash, bounded fallback.
        out += ch;
      }
    } else {
      // Unknown escape — leave the backslash, bounded fallback.
      out += ch;
    }
  }
  return out;
}

/**
 * Parse one PTY chunk for OSC 133/633 markers. Returns the emitted markers and
 * the carryover tail (unparsed bytes that may complete a sequence in the next
 * chunk). `carryIn` is the tail returned by the previous call ("" on first).
 *
 * Bounded: a sequence longer than MAX_SEQ_LEN is flushed as plain text (no
 * marker) so a runaway stream cannot grow the carryover without limit.
 */
export function parseOscChunk(chunk: string, carryIn = ""): {
  markers: OscMarker[];
  carry: string;
} {
  const MAX_SEQ_LEN = 8192;
  const markers: OscMarker[] = [];
  const buf = carryIn + chunk;
  let carry = "";

  let i = 0;
  while (i < buf.length) {
    // An OSC starts with ESC ] only when ESC is at a sequence boundary. We
    // only begin scanning for a new sequence when not mid-carryover.
    if (buf[i] !== ESC || buf[i + 1] !== "]") {
      i += 1;
      continue;
    }
    const seqStart = i;

    // Find the terminator (BEL or ST) starting from the char after ESC ].
    let end = -1;
    let endLen = 0;
    for (let j = i + 2; j < buf.length; j += 1) {
      if (buf[j] === BEL) {
        end = j;
        endLen = 1;
        break;
      }
      if (buf[j] === ESC && buf[j + 1] === "\\") {
        end = j;
        endLen = 2;
        break;
      }
    }
    if (end === -1) {
      // No terminator yet. If the partial sequence is huge, drop it (bounded).
      const partial = buf.slice(seqStart);
      if (partial.length > MAX_SEQ_LEN) {
        i = buf.length;
      } else {
        carry = partial;
        i = buf.length;
      }
      break;
    }

    const body = buf.slice(i + 2, end);
    const marker = parseOscBody(body);
    if (marker) markers.push(marker);
    // Plain text between sequences is discarded (parser only emits markers).
    i = end + endLen;
  }

  // If we broke out without setting carry but ended mid-ESC, preserve a
  // trailing ESC (could be the start of ST or a new OSC).
  if (!carry && i >= buf.length && buf.length > 0) {
    const tail = buf[buf.length - 1];
    if (tail === ESC) carry = ESC;
  }

  return { markers, carry };
}

/** Parse the body between `ESC ]` and the terminator. Returns null for non-133/633/9/99/777. */
function parseOscBody(body: string): OscMarker | null {
  // OSC 633 ; <code> [; <arg>]
  if (body.startsWith("633;")) {
    return parseFinalTerm(body.slice(4), "633");
  }
  // OSC 133 ; <code> [; <arg>]  (original set, no E)
  if (body.startsWith("133;")) {
    return parseFinalTerm(body.slice(4), "133");
  }
  // OSC 9 ; <message>  (iTerm2 user notification)
  if (body.startsWith("9;")) {
    return parseNotification(body.slice(2));
  }
  // OSC 99 ; [args;] <message>  (iTerm2 inline alert; args like i=ID:d=...)
  if (body.startsWith("99;")) {
    return parseNotification(body.slice(3));
  }
  // OSC 777 ; notify ; <title> ; <body>  (rxvt-unicode)
  if (body.startsWith("777;")) {
    return parseNotification777(body.slice(4));
  }
  return null;
}

/**
 * Coarse-classify a notification message into an attention kind. Used ONLY as
 * a transient hint — the message text is never stored, logged, or forwarded.
 * Conservative: defaults to "info" (not an attention state) so ordinary agent
 * progress chatter does not light up the inbox.
 */
export function classifyNotificationMessage(message: string): NotificationKind {
  const lower = message.toLowerCase();
  // Order matters: check the most specific attention signals first.
  if (/\b(approve|approval|permission|allow|authorize|consent)\b/.test(lower)) return "approval";
  if (/\b(blocked|stuck|waiting for lock|deadlock|cannot proceed)\b/.test(lower)) return "blocked";
  if (/\b(error|failed|failure|panic|fatal|exception|crash)\b/.test(lower)) return "error";
  if (/\b(waiting for input|waiting for your|enter input|your input|prompt for)\b/.test(lower)) return "input";
  if (/\b(done|complete|completed|finished|succeeded|success)\b/.test(lower)) return "done";
  return "info";
}

function parseNotification(rest: string): OscMarker | null {
  // rest may be "message" (OSC 9) or "args;message" (OSC 99). For OSC 99 the
  // args segment (i=..., d=...) carries no attention signal we use; take the
  // last semicolon-separated segment as the message.
  const lastSemi = rest.lastIndexOf(";");
  const message = lastSemi === -1 ? rest : rest.slice(lastSemi + 1);
  const trimmed = message.trim();
  if (!trimmed) return null;
  return {
    kind: "notification",
    value: null,
    notificationKind: classifyNotificationMessage(trimmed),
  };
}

function parseNotification777(rest: string): OscMarker | null {
  // rest = "notify ; <title> ; <body>" (leading "notify" already present).
  // Strip the leading "notify" sub-command, then join title + body.
  const parts = rest.split(";");
  if (parts.length < 2) return null;
  // parts[0] === "notify" (possibly with whitespace). Title/body follow.
  const title = (parts[1] ?? "").trim();
  const body = parts.slice(2).join(";").trim();
  const message = body || title;
  if (!message) return null;
  return {
    kind: "notification",
    value: null,
    notificationKind: classifyNotificationMessage(message),
  };
}

function parseFinalTerm(rest: string, source: "633" | "133"): OscMarker | null {
  // rest = "<code>" or "<code>;<arg>"
  const semi = rest.indexOf(";");
  const code = semi === -1 ? rest : rest.slice(0, semi);
  const arg = semi === -1 ? "" : rest.slice(semi + 1);

  switch (code) {
    case "A":
      return { kind: "promptStart", value: null };
    case "B":
      return { kind: "promptEnd", value: null };
    case "C":
      return { kind: "preExec", value: null };
    case "D": {
      // 633 D may carry ;exit. 133 D historically carries no exit in practice,
      // but if an arg is present we honour it. Empty arg → null (unknown).
      if (arg === "") return { kind: "finished", value: null };
      if (/^-?\d+$/.test(arg)) return { kind: "finished", value: Number(arg) };
      return { kind: "finished", value: null };
    }
    case "E": {
      // 633 only. 133 has no E; if a 133 shell ever emits E we still decode it
      // (harmless) but the lifecycle builder requires source 633 for command.
      if (source !== "633") return null;
      // A raw semicolon can only delimit the optional nonce because the
      // command itself must encode semicolons as \x3b.
      const nonceSeparator = arg.indexOf(";");
      const escapedCommand = nonceSeparator === -1 ? arg : arg.slice(0, nonceSeparator);
      return { kind: "command", value: decodeEscapedCommand(escapedCommand) };
    }
    case "P": {
      if (source !== "633" || !arg.startsWith("Cwd=")) return null;
      return { kind: "cwd", value: decodeEscapedCommand(arg.slice(4)) };
    }
    default:
      return null;
  }
}
