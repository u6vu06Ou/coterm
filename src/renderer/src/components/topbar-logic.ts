export function shouldSendMobileTileSelection(
  targetTerminalId: string,
  activeTerminalId: string | null,
  pendingTerminalId: string | null,
): boolean {
  return targetTerminalId !== activeTerminalId && targetTerminalId !== pendingTerminalId;
}

/**
 * Resolve where voice dictation goes. The pin (lastLocalSelectedTerminalId)
 * tracks the terminal THIS window's user last picked with a local pointer
 * gesture; the main-owned global selection (selectedTerminalId) is broadcast
 * over WS and can be stolen mid-utterance by another client (e.g. Agent API opening
 * a tile). Prefer the pin; fall back to global selection when there is no pin
 * or the pinned terminal no longer exists. Pure.
 */
export function resolveVoiceTargetTerminalId(
  pinnedTerminalId: string | null,
  tileTerminalIds: readonly string[],
  selectedTerminalId: string | null,
): string | null {
  if (pinnedTerminalId && tileTerminalIds.includes(pinnedTerminalId)) return pinnedTerminalId;
  return selectedTerminalId;
}

/**
 * Build the writeTerminal payload for the mobile input overlay's commit action.
 * When sendWithEnter is true, append "\r" so the inner TUI submits; when false,
 * send the raw text (cursor stays on the input line). Empty value → null (no
 * write). Pure: the component passes the current inputValue + toggle state.
 */
export function buildInputOverlayPayload(
  value: string,
  sendWithEnter: boolean,
): { data: string } | null {
  if (!value) return null;
  return { data: sendWithEnter ? value + "\r" : value };
}

/**
 * Count the lines in the input value for the multiline warning. Returns 0 for
 * empty input (no warning), 1 for single-line, N for N-line. Pure.
 */
export function inputOverlayLineCount(value: string): number {
  if (!value) return 0;
  return value.split("\n").length;
}

/**
 * Whether a keydown event should trigger a commit. Only Ctrl/Cmd+Enter, and
 * only when NOT mid-IME-composition (the IME owns Enter while composing a
 * candidate). Pure: the component passes the event + composing flag.
 */
export function shouldCommitOnKeyDown(
  event: { key: string; metaKey: boolean; ctrlKey: boolean },
  composing: boolean,
): boolean {
  if (composing) return false;
  return event.key === "Enter" && (event.metaKey || event.ctrlKey);
}
