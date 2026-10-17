export function textValue(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return fallback;
}

export function isNativeWorkflowIntent(provider: string, text: string): boolean {
  return provider.startsWith("claude-") &&
    /^\s*\/?(?:ultracode\b|goal\b|deep(?:-|\s+)research\b)/i.test(text);
}

export function compactProgressText(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}

export function terminalCopyText(
  event: { key: string; ctrlKey: boolean; shiftKey: boolean },
  selection: string,
): string | null {
  return event.ctrlKey && event.key.toLowerCase() === "c" && selection ? cleanTerminalCopy(selection) : null;
}

/**
 * Tidy a terminal selection for pasting elsewhere (2026-10-06: pasted text had
 * stray spaces at every line break). Two sources of junk:
 *  1. trailing padding — TUIs paint rows full-width with spaces;
 *  2. hanging indent — agent CLIs wrap a paragraph themselves and indent every
 *     continuation row ("● text" / "  more text"), so a selection that starts
 *     at the text gets those leading spaces after each newline.
 * Only the indent shared by ALL continuation rows is removed, and only when
 * the first row is indented less — relative indentation (code) survives.
 */
export function cleanTerminalCopy(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/[ \t\u00a0]+$/u, ""));
  if (lines.length > 1) {
    const indentOf = (line: string): number => line.length - line.trimStart().length;
    const rest = lines.slice(1).filter((line) => line.length > 0);
    if (rest.length > 0) {
      const shared = Math.min(...rest.map(indentOf));
      const first = lines[0] ?? "";
      if (shared > 0 && indentOf(first) < shared) {
        for (let i = 1; i < lines.length; i++) lines[i] = lines[i]!.slice(Math.min(shared, indentOf(lines[i]!)));
      }
    }
  }
  return lines.join("\n");
}

export function userInputAnswers(
  selected: Record<string, string[]>,
  other: Record<string, string>,
): Record<string, string[]> {
  const answers: Record<string, string[]> = {};
  for (const id of new Set([...Object.keys(selected), ...Object.keys(other)])) {
    const values = [...(selected[id] ?? []), ...(other[id]?.trim() ? [other[id].trim()] : [])];
    if (values.length > 0) answers[id] = values;
  }
  return answers;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function numericValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
