import { open, stat } from "node:fs/promises";
import type { TerminalTranscriptMessage } from "@shared/types";
import { parseClaudeTranscriptRecord } from "./claude-transcript-parser";
import { parseCodexTranscriptRecord } from "./codex-transcript-parser";

export type TranscriptParser = (record: unknown, index?: number) => TerminalTranscriptMessage | null;

export class TranscriptParserRegistry {
  private readonly parsers = new Map<string, TranscriptParser>([
    ["claude", parseClaudeTranscriptRecord],
    ["codex", parseCodexTranscriptRecord],
  ]);

  get(provider: "claude" | "codex"): TranscriptParser {
    const parser = this.parsers.get(provider);
    if (!parser) throw new Error(`No transcript parser registered for ${provider}.`);
    return parser;
  }
}

interface CacheEntry {
  size: number;
  mtimeMs: number;
  offset: number;
  partial: string;
  messages: TerminalTranscriptMessage[];
}

/** Incremental JSONL cache; rotation/truncation causes a safe rebuild. */
export class IncrementalTranscriptCache {
  private readonly entries = new Map<string, CacheEntry>();

  async read(file: string, parser: TranscriptParser, maxMessages = 200): Promise<TerminalTranscriptMessage[]> {
    const info = await stat(file);
    let entry = this.entries.get(file);
    if (!entry || info.size < entry.offset || info.mtimeMs < entry.mtimeMs) {
      entry = { size: info.size, mtimeMs: info.mtimeMs, offset: 0, partial: "", messages: [] };
      this.entries.set(file, entry);
    }
    if (info.size === entry.offset && info.mtimeMs === entry.mtimeMs) return [...entry.messages];
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(Math.max(0, info.size - entry.offset));
      if (buffer.length > 0) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, entry.offset);
        entry.partial += buffer.subarray(0, bytesRead).toString("utf8");
      }
      entry.offset = info.size;
      entry.size = info.size;
      entry.mtimeMs = info.mtimeMs;
    } finally {
      await handle.close();
    }
    const lines = entry.partial.split("\n");
    entry.partial = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = parser(JSON.parse(line), entry.messages.length);
        if (message) {
          entry.messages.push(message);
          while (entry.messages.length > maxMessages) entry.messages.shift();
        }
      } catch {
        // Ignore malformed/partial records without logging transcript content.
      }
    }
    return [...entry.messages];
  }

  clear(file?: string): void {
    if (file) this.entries.delete(file);
    else this.entries.clear();
  }
}
