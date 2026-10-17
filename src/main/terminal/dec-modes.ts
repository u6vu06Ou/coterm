/**
 * DEC private mode tracker (#47 layer 1).
 *
 * The scrollback ring truncates from the front, so a long fullscreen session
 * (e.g. Claude Code with CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT on ConPTY)
 * eventually evicts the mode-setting bytes from the start of the session
 * (?1049h alt screen, ?1000/1002/1003h + ?1006h mouse reporting,
 * ?2004h bracketed paste...). Any client that hydrates late — a phone
 * connecting, a window refresh, a reconnect — then replays a byte stream that
 * starts mid-alt-screen with no modes set, leaving its xterm in
 * bufferType "normal" with mouse reporting off (no wheel listener, no
 * bracketed paste).
 *
 * This tracker watches the PTY byte stream as it passes and keeps a compact
 * "currently enabled" mode set. snapshots() prepends the reconstructed
 * preamble so every hydrate renders with the same terminal mode state a
 * live client had. The state lives outside the ring, so truncation cannot
 * evict it.
 */

// eslint-disable-next-line no-control-regex -- terminal escape parsing needs CSI literals
const MODE_RE = /\x1b\[\?([0-9]+(?:;[0-9]+)*)([hl])/g;

/** DEC private modes whose xterm default is OFF: emitted as `h` when on. */
const OFF_BY_DEFAULT = new Set([
  1, // application cursor keys (DECCKM)
  9, // X10 mouse
  47, // legacy alt buffer
  1000, // X11 mouse (click)
  1002, // drag mouse
  1003, // any-event mouse
  1005, // UTF-8 mouse coords
  1006, // SGR mouse coords
  1015, // urxvt mouse coords
  1047, // alt buffer
  1048, // save/restore cursor
  1049, // alt buffer + save/restore cursor
  2004, // bracketed paste
]);

/** DEC private modes whose xterm default is ON: emitted as `l` when off. */
const ON_BY_DEFAULT = new Set([
  7, // autowrap (DECAWM)
  25, // cursor visible (DECTCEM)
]);

// eslint-disable-next-line no-control-regex -- terminal escape parsing needs ESC literals
const TAIL_PREFIX_RE = /^\x1b(?:\[\??[0-9;]*)?$/;
/** Max length of a carried-over partial escape; longer fragments are dropped. */
const MAX_TAIL = 32;

export class DecModeTracker {
  private readonly modes = new Map<number, boolean>();
  private tail = "";

  /** Consume one PTY output chunk; O(chunk length). */
  ingest(data: string): void {
    if (this.tail.length === 0 && !data.includes("\x1b")) return;
    const text = this.tail + data;
    MODE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MODE_RE.exec(text)) !== null) {
      const enabled = match[2] === "h";
      for (const part of (match[1] ?? "").split(";")) {
        const mode = Number(part);
        if (OFF_BY_DEFAULT.has(mode) || ON_BY_DEFAULT.has(mode)) {
          this.modes.set(mode, enabled);
        }
      }
    }
    this.tail = extractTail(text);
  }

  /**
   * Escape sequence that brings a fresh xterm to the currently tracked mode
   * state. Empty when no tracked mode was ever set (plain shells replay
   * byte-identically to before). Mode order is numeric; mouse modes and alt
   * screen are final-state bits, so order does not change the outcome.
   */
  preamble(): string {
    let out = "";
    for (const mode of [...this.modes.keys()].sort((a, b) => a - b)) {
      const enabled = this.modes.get(mode);
      if (enabled && OFF_BY_DEFAULT.has(mode)) out += `\x1b[?${mode}h`;
      else if (!enabled && ON_BY_DEFAULT.has(mode)) out += `\x1b[?${mode}l`;
    }
    return out;
  }

  /** Exposed for tests. */
  isEnabled(mode: number): boolean {
    return this.modes.get(mode) ?? false;
  }
}

/**
 * Keep the trailing fragment of `text` if it could still grow into a DEC mode
 * sequence in the next chunk (e.g. the stream splits "\x1b[?104" | "9h").
 */
function extractTail(text: string): string {
  const escIndex = text.lastIndexOf("\x1b");
  if (escIndex === -1) return "";
  const fragment = text.slice(escIndex);
  if (fragment.length > MAX_TAIL) return "";
  return TAIL_PREFIX_RE.test(fragment) ? fragment : "";
}
