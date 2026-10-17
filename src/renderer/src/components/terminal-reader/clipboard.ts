// Copy-to-clipboard for the reader overlay. Mobile browsers served over the
// non-secure WS relay (http://) reject navigator.clipboard, so fall back to a
// temporary off-screen READONLY textarea + document.execCommand("copy") —
// readonly so no soft keyboard pops on phones while copying.
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Non-secure context or permission denied — fall through to execCommand.
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.readOnly = true;
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.left = "-9999px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}
