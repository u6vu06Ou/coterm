/**
 * Global keydown shortcuts (Ctrl+K, Ctrl+Shift+P, …) must NOT fire while the
 * user is typing somewhere: inside an xterm the raw chord still reaches the
 * PTY (Ctrl+K is \x0B, kill-to-EOL in readline), so stealing focus there is
 * a double bug — the shell reacts AND the cursor jumps to a search box.
 * Same story for ordinary inputs and IME composition.
 *
 * Returns true when the global listener should stand down.
 */
export function shouldDeferGlobalShortcut(event: KeyboardEvent): boolean {
  if (event.isComposing) return true;
  const target = event.target;
  if (!(target instanceof Element)) return false;
  if (target.closest(".xterm-helper-textarea")) return true;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return false;
}
