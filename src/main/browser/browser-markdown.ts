import type { BrowserDocument } from "@shared/browser-types";

export function documentToMarkdown(document: BrowserDocument, maxChars = 100_000): string {
  const lines: string[] = ["---", `url: ${yaml(document.source.finalUrl)}`, `title: ${yaml(document.source.title)}`, `fetched_at: ${yaml(document.source.fetchedAt)}`, "---", "", `# ${document.source.title || "Untitled page"}`, ""];
  for (const heading of document.headings) lines.push(`${"#".repeat(Math.max(1, Math.min(6, heading.level)))} ${heading.text}`, "");
  for (const paragraph of document.paragraphs) {
    lines.push(paragraph.format === "code" ? "```\n" + paragraph.text + "\n```" : paragraph.text, "");
  }
  for (const list of document.lists) {
    list.items.forEach((item, index) => lines.push(`${list.ordered ? `${index + 1}.` : "-"} ${item}`));
    lines.push("");
  }
  for (const table of document.tables) {
    lines.push(`| ${table.headers.join(" | ")} |`, `| ${table.headers.map(() => "---").join(" | ")} |`);
    for (const row of table.rows) lines.push(`| ${row.join(" | ")} |`);
    lines.push("");
  }
  if (document.links.length > 0) {
    lines.push("## Links", "");
    for (const link of document.links) lines.push(`- [${link.text || link.url}](${link.url})`);
    lines.push("");
  }
  return lines.join("\n").slice(0, maxChars);
}

function yaml(value: string): string {
  return JSON.stringify(value.replace(/[\r\n]+/g, " "));
}

export interface HtmlToMarkdownResult {
  title: string;
  /** Plain visible text (pre-markdown) — the wall detector's input. */
  text: string;
  markdown: string;
}

/**
 * Regex-based HTML → markdown for fetchToMarkdown (§12.2): deliberately NOT a
 * browser render — no cookies, no JS execution, no subresource loads. Handles
 * the structural tags agents need (headings, paragraphs, lists, links) and
 * drops everything else. Input is already byte-bounded by the caller.
 */
export function htmlToMarkdown(html: string, finalUrl: string): HtmlToMarkdownResult {
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim();
  let work = html;
  // Whole-element removals (greedy-safe, case-insensitive).
  work = work.replace(/<!--[\s\S]*?-->/g, " ");
  work = work.replace(/<(script|style|noscript|template|svg|head|iframe|form|button|select)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  // Headings → markdown markers.
  for (let level = 6; level >= 1; level -= 1) {
    const marker = "#".repeat(level);
    work = work.replace(new RegExp(`<h${level}[^>]*>`, "gi"), `\n\n${marker} `);
    work = work.replace(new RegExp(`</h${level}>`, "gi"), "\n");
  }
  // List items and block boundaries → newlines.
  work = work.replace(/<li[^>]*>/gi, "\n- ");
  work = work.replace(/<(p|div|section|article|header|footer|nav|main|aside|blockquote|pre|table|tr|ul|ol|dl|figure)[^>]*>/gi, "\n\n");
  work = work.replace(/<\/(p|div|section|article|header|footer|nav|main|aside|blockquote|pre|table|tr|ul|ol|dl|figure)>/gi, "\n");
  work = work.replace(/<br[^>]*\/?>/gi, "\n");
  // Links → [text](url), resolved against the final URL; protocol-relative and
  // non-http schemes are dropped to the bare text.
  work = work.replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_whole, href: string, body: string) => {
    const text = body.replace(/<[^>]+>/g, " ").trim();
    let target = "";
    try {
      const resolved = new URL(href, finalUrl);
      if (resolved.protocol === "http:" || resolved.protocol === "https:") target = resolved.toString();
    } catch { target = ""; }
    if (target === "" || text === "") return text;
    return `[${text}](${target})`;
  });
  // Everything else: strip the tags, keep the text.
  work = work.replace(/<[^>]+>/g, " ");
  const text = decodeEntities(work).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return { title: decodeEntities(title), text, markdown: text };
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_whole, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_whole, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}