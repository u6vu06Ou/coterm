import { open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { cleanSessionTitle } from "@shared/terminal";
import { parseClaudeTranscriptRecord } from "./claude-transcript-parser";

/**
 * Claude-family header summary derived from the session transcript itself.
 *
 * Why this exists (2026-11-04 claude-team regression): claude-team routes
 * Claude Code's auto session-title call through the free proxy, where it
 * returns 200 without ever producing the `ai-title` JSONL record — so the CLI
 * never writes a real OSC title either, and the pane header fell through to
 * the screen projection, which surfaced Claude's status line ("Opus 5.5 |
 * path | 69k/1000k (7%) | ▸▸ bypass permissions on …") as the "summary".
 * No fix may send the title call to paid Anthropic, so Coterm derives the
 * summary locally from the transcript, in this order:
 *   1. latest `ai-title` / `custom-title` record (provider/user-authored),
 *   2. the away-summary recap (its "(disable recaps in /config)" footer
 *      stripped),
 *   3. the latest REAL user prompt (tool results, system reminders and
 *      slash-command noise excluded by parseClaudeTranscriptRecord plus the
 *      bare-command rule below).
 * The derived text is published through agentSummaryTitle, the same channel
 * Codex's state-DB title uses, so the pane header, top-bar tab and sidebar
 * row all render the identical string off one source.
 */

export interface ClaudeSummaryScanResult {
  /** Latest ai-title/custom-title record value, in file order. */
  title: string | null;
  /** Latest away_summary recap, footer stripped. */
  recap: string | null;
  /** Latest real user prompt. */
  lastPrompt: string | null;
}

export function createClaudeSummaryScan(): ClaudeSummaryScanResult {
  return { title: null, recap: null, lastPrompt: null };
}

/** The CLI appends this opt-out hint to every away_summary recap. */
export function stripClaudeRecapSuffix(text: string): string {
  return text.replace(/\s*\(disable recaps in \/config\)\s*$/u, "").trim();
}

// A bare slash invocation ("/compact", "/clear") is command noise, not a
// prompt; "/review src/foo" keeps its arguments and stays eligible. Letters
// and hyphens only — a bare absolute path ("/usr/local/bin") is a real prompt.
const BARE_SLASH_COMMAND = /^\/[a-zA-Z][a-zA-Z0-9-]*$/;
const MAX_STORED_PROMPT_CHARS = 2_000;

/** Fold one parsed JSONL record into the running scan. Pure; exported for tests. */
export function applyClaudeSummaryRecord(record: unknown, result: ClaudeSummaryScanResult): void {
  if (!record || typeof record !== "object") return;
  const value = record as Record<string, unknown>;
  if (value.isSidechain === true) return;
  if (value.type === "ai-title" && typeof value.aiTitle === "string" && value.aiTitle.trim()) {
    result.title = value.aiTitle.trim();
    return;
  }
  if (value.type === "custom-title" && typeof value.customTitle === "string") {
    // A blank customTitle is the user clearing the rename — drop the stale one.
    result.title = value.customTitle.trim() || null;
    return;
  }
  if (value.type === "system" && value.subtype === "away_summary" && typeof value.content === "string") {
    const recap = stripClaudeRecapSuffix(value.content);
    if (recap) result.recap = recap;
    return;
  }
  const message = parseClaudeTranscriptRecord(record);
  if (message?.role !== "user") return;
  const text = message.text.replace(/\s+/g, " ").trim();
  if (!text || BARE_SLASH_COMMAND.test(text)) return;
  // Bound the stored prompt: a terminal-wide paste would otherwise sit in
  // memory per scanner (the projection cap below is applied later).
  result.lastPrompt = Array.from(text).slice(0, MAX_STORED_PROMPT_CHARS).join("");
}

const MAX_SUMMARY_CHARS = 180;
const MAX_PARTIAL_CHARS = 1_048_576;

/**
 * The header summary for a scanned transcript: ai-title/custom-title first,
 * then the recap, then the latest real user prompt. The winner still goes
 * through the shared junk guards, so a chrome-looking or empty candidate
 * falls to the next source instead of publishing garbage.
 */
export function claudeSessionSummaryFromScan(scan: ClaudeSummaryScanResult): string | null {
  for (const candidate of [scan.title, scan.recap, scan.lastPrompt]) {
    if (!candidate) continue;
    const compact = candidate.replace(/\s+/g, " ").trim();
    const cleaned = cleanSessionTitle(compact);
    if (!cleaned) continue;
    const chars = Array.from(cleaned);
    return chars.length <= MAX_SUMMARY_CHARS ? cleaned : `${chars.slice(0, MAX_SUMMARY_CHARS - 1).join("")}…`;
  }
  return null;
}

/**
 * Incremental JSONL reader behind claudeSessionSummaryFromScan. A session
 * file only ever grows (a /clear or /resume starts a NEW file, which the case
 * below treats as a rebinding), so each poll decodes just the bytes appended
 * since the previous one — the ai-title written near the head is seen on the
 * first attach, and the whole file is never re-read on every 10s tick.
 */
export class ClaudeSessionSummaryScanner {
  readonly result: ClaudeSummaryScanResult = createClaudeSummaryScan();
  private file: string | null = null;
  private offset = 0;
  private partial = "";
  private decoder = new StringDecoder("utf8");
  /** Serializes update(): overlapping polls must not interleave offset/partial writes. */
  private updating: Promise<void> | null = null;

  update(file: string): Promise<void> {
    const run = (this.updating ?? Promise.resolve()).then(() => this.read(file));
    this.updating = run.catch(() => undefined);
    return run;
  }

  private async read(file: string): Promise<void> {
    if (file !== this.file) this.reset(file);
    const info = await stat(file).catch(() => null);
    if (!info) return;
    if (info.size < this.offset) {
      // Truncated or replaced in place — never trust offsets across that.
      this.reset(file);
    }
    if (info.size === this.offset) return;
    const handle = await open(file, "r").catch(() => null);
    if (!handle) return;
    let text: string;
    try {
      const buffer = Buffer.alloc(info.size - this.offset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset);
      text = this.decoder.write(buffer.subarray(0, bytesRead));
      this.offset += bytesRead;
    } catch {
      // Read failure: keep state, retry from the same offset next poll.
      return;
    } finally {
      await handle.close();
    }
    const body = this.partial + text;
    const lines = body.split("\n");
    // The tail segment may be a half-written line; hold it for the next poll.
    // A tail that never terminates (a single record larger than the cap) is
    // dropped rather than buffered forever.
    this.partial = lines.pop()!;
    if (this.partial.length > MAX_PARTIAL_CHARS) this.partial = "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let record: unknown;
      try { record = JSON.parse(trimmed); } catch { continue; }
      applyClaudeSummaryRecord(record, this.result);
    }
  }

  private reset(file: string): void {
    this.file = file;
    this.offset = 0;
    this.partial = "";
    this.decoder = new StringDecoder("utf8");
    this.result.title = null;
    this.result.recap = null;
    this.result.lastPrompt = null;
  }
}
