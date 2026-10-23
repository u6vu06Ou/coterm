import { homedir } from "node:os";
import { join } from "node:path";
import type { TerminalTranscript, TerminalTranscriptMessage } from "@shared/types";
import { TerminalSessionFileResolver, type ResolvedSessionFile, type SessionProvider } from "./session-file-resolver";
import { IncrementalTranscriptCache, TranscriptParserRegistry } from "./transcript-parser-registry";

export interface TerminalTranscriptQuery {
  terminalId: string;
  cwd: string;
  startedAt: string;
  nativeSessionId: string | null;
  agentProfile: string | null;
  /** Native session ids of the other live terminals, so a session hop never lands on theirs. */
  reservedSessionIds?: readonly string[];
  /** Called when the agent switched to a new session file in this terminal (/clear, /resume). */
  onRebind?: (sessionId: string) => void;
}

export class TerminalTranscriptService {
  private readonly resolver: TerminalSessionFileResolver;
  private readonly parsers = new TranscriptParserRegistry();
  private readonly cache = new IncrementalTranscriptCache();

  constructor(options: { claudeProjectsRoot?: string; codexSessionsRoot?: string } = {}) {
    this.resolver = new TerminalSessionFileResolver({
      claudeProjectsRoot: options.claudeProjectsRoot ?? join(homedir(), ".claude", "projects"),
      codexSessionsRoot: options.codexSessionsRoot ?? join(homedir(), ".codex", "sessions"),
    });
  }

  /**
   * Where the session file resolver currently points this terminal (the same
   * binding + rebind logic as `get`, minus the parsing). Used by the pane
   * header "Session 資訊" block, which only needs the absolute path.
   */
  async resolveSessionFile(query: TerminalTranscriptQuery): Promise<ResolvedSessionFile> {
    const provider = providerFor(query.agentProfile);
    if (provider === "unsupported") {
      return { status: "unsupported", provider, file: null, binding: "none", reasonCode: "provider_not_supported" };
    }
    const { onRebind, ...descriptor } = query;
    const resolved = await this.resolver.resolve({ ...descriptor, provider });
    if (resolved.reboundSessionId) onRebind?.(resolved.reboundSessionId);
    return resolved;
  }

  /**
   * Drop the resolver's followed binding for a terminal. Required after an
   * EXTERNAL nativeSessionId rebind (the live-session follower catching an
   * in-session /resume to an older conversation): the resolver otherwise keeps
   * anchoring on the file it followed earlier — which the successor walk can
   * never leave for an older-birth file — and the reader stays on the wrong
   * session. The onRebind path needs no forget: its binding is set to the
   * rebound file inside resolve() itself.
   */
  forgetBinding(terminalId: string): void {
    this.resolver.forget(terminalId);
  }

  async get(query: TerminalTranscriptQuery): Promise<TerminalTranscript> {
    const provider = providerFor(query.agentProfile);
    const base = {
      terminalId: query.terminalId,
      provider: provider === "unsupported" ? "unsupported" as const : provider,
      messages: [] as TerminalTranscriptMessage[],
      updatedAt: new Date().toISOString(),
      stale: false,
    };
    if (provider === "unsupported") return { ...base, status: "unsupported", sessionBinding: "none", reasonCode: "provider_not_supported" };
    const { onRebind, ...descriptor } = query;
    const resolved = await this.resolver.resolve({ ...descriptor, provider });
    if (resolved.reboundSessionId) onRebind?.(resolved.reboundSessionId);
    if (resolved.status !== "ready" || !resolved.file) {
      return { ...base, status: resolved.status, sessionBinding: resolved.binding, ...(resolved.reasonCode ? { reasonCode: resolved.reasonCode } : {}) };
    }
    try {
      const raw = await this.cache.read(resolved.file, this.parsers.get(provider));
      // Codex rollouts record every message twice (event_msg + response_item,
      // always adjacent in file order) — collapse identical neighbors so the
      // reader doesn't show every bubble twice.
      const messages = provider === "codex"
        ? raw.filter((msg, i) => i === 0 || msg.role !== raw[i - 1]!.role || msg.text !== raw[i - 1]!.text)
        : raw;
      return { ...base, status: messages.length ? "ready" : "empty", sessionBinding: resolved.binding, messages };
    } catch {
      return { ...base, status: "error", sessionBinding: resolved.binding, reasonCode: "transcript_read_failed" };
    }
  }
}

export function providerFor(profile: string | null): SessionProvider {
  if (profile === "codex" || (profile && profile.startsWith("codex-"))) return "codex";
  if (profile === "claude" || (profile && profile.startsWith("claude-"))) return "claude";
  return "unsupported";
}
