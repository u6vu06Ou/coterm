export function parseTerminalTitles(data: string, pending = ""): { titles: string[]; pending: string } {
  if (!pending && !data.includes("\x1b")) return { titles: [], pending: "" };
  const input = `${pending}${data}`.slice(-64_000);
  // eslint-disable-next-line no-control-regex
  const pattern = /\x1b\]0;([\s\S]*?)(?:\x07|\x1b\\)/g;
  const titles: string[] = [];
  let end = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input))) {
    end = pattern.lastIndex;
    const title = (match[1] ?? "").trim();
    if (title) titles.push(title);
  }
  const start = input.lastIndexOf("\x1b]0;");
  if (start >= end) return { titles, pending: input.slice(start) };
  const tail = input.slice(end);
  for (const prefix of ["\x1b]0", "\x1b]", "\x1b"]) {
    if (tail.endsWith(prefix)) return { titles, pending: prefix };
  }
  return { titles, pending: "" };
}
