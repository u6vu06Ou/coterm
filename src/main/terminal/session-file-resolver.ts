import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { canonicalPath } from "../core/claude-history";

export type ResolvedSessionStatus = "ready" | "pending" | "not_found" | "ambiguous" | "unsupported";
export type SessionProvider = "claude" | "codex" | "unsupported";

export interface TerminalSessionDescriptor {
  terminalId: string;
  cwd: string;
  startedAt: string;
  nativeSessionId: string | null;
  provider: SessionProvider;
}

export interface ResolvedSessionFile {
  status: ResolvedSessionStatus;
  provider: SessionProvider;
  file: string | null;
  binding: "native-id" | "cwd-start-time" | "none";
  reasonCode?: string;
}

interface Candidate {
  file: string;
  mtimeMs: number;
  startedAtMs?: number;
}

export function mungeClaudeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Case- and separator-insensitive cwd match for Windows, where the same
 * directory surfaces as `D:\Coterm`, `d:/Coterm`, or a junction
 * alias (e.g. `C:\CloudDrive\x` vs `G:\雲端硬碟\x`). Delegates to the shared
 * `canonicalPath`, which resolves the GDrive junction, runs `resolve()`,
 * unifies separators, and lower-cases — so two aliases of the same directory
 * compare equal. No fs.realpath — it is async and throws on paths that no
 * longer exist, which a stale session cwd may be.
 */
export function sameCwd(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b);
}

/**
 * Provider-neutral, conservative session binding. It never uses “newest in
 * cwd” as a fallback: if more than one live-looking candidate remains, the
 * caller gets `ambiguous` and can keep showing raw terminal output.
 */
export class TerminalSessionFileResolver {
  private readonly bindings = new Map<string, string>();

  constructor(private readonly options: { claudeProjectsRoot: string; codexSessionsRoot: string }) {}

  async resolve(descriptor: TerminalSessionDescriptor): Promise<ResolvedSessionFile> {
    if (descriptor.provider === "unsupported") return { status: "unsupported", provider: "unsupported", file: null, binding: "none", reasonCode: "provider_not_supported" };
    if (!descriptor.cwd) return { status: "not_found", provider: descriptor.provider, file: null, binding: "none", reasonCode: "cwd_missing" };
    if (descriptor.provider === "claude") return this.resolveClaude(descriptor);
    return this.resolveCodex(descriptor);
  }

  forget(terminalId: string): void {
    this.bindings.delete(terminalId);
  }

  private async resolveClaude(descriptor: TerminalSessionDescriptor): Promise<ResolvedSessionFile> {
    const folder = join(this.options.claudeProjectsRoot, mungeClaudeCwd(descriptor.cwd));
    if (descriptor.nativeSessionId) {
      const file = join(folder, `${descriptor.nativeSessionId}.jsonl`);
      if (await exists(file)) {
        this.bindings.set(descriptor.terminalId, file);
        return { status: "ready", provider: "claude", file, binding: "native-id" };
      }
      return { status: "pending", provider: "claude", file: null, binding: "native-id", reasonCode: "native_session_not_created" };
    }
    const candidates = await this.listJsonl(folder);
    const startedMs = Date.parse(descriptor.startedAt);
    const live = Number.isFinite(startedMs)
      ? candidates.filter((candidate) => candidate.mtimeMs >= startedMs - 60_000)
      : candidates;
    if (live.length === 0) return { status: "not_found", provider: "claude", file: null, binding: "none", reasonCode: "no_matching_session" };
    if (live.length > 1) return { status: "ambiguous", provider: "claude", file: null, binding: "none", reasonCode: "multiple_matching_sessions" };
    const file = live[0]!.file;
    this.bindings.set(descriptor.terminalId, file);
    return { status: "ready", provider: "claude", file, binding: "cwd-start-time" };
  }

  private async resolveCodex(descriptor: TerminalSessionDescriptor): Promise<ResolvedSessionFile> {
    const bound = this.bindings.get(descriptor.terminalId);
    if (bound && await exists(bound)) return { status: "ready", provider: "codex", file: bound, binding: descriptor.nativeSessionId ? "native-id" : "cwd-start-time" };
    if (bound) this.bindings.delete(descriptor.terminalId);
    const startedMs = Date.parse(descriptor.startedAt);
    if (!Number.isFinite(startedMs)) return { status: "not_found", provider: "codex", file: null, binding: "none", reasonCode: "invalid_started_at" };
    const candidates = await this.listCodexRollouts(startedMs);
    const reserved = new Set([...this.bindings.entries()].filter(([id]) => id !== descriptor.terminalId).map(([, file]) => file.toLowerCase()));
    const exact = descriptor.nativeSessionId
      ? candidates.find((candidate) => candidate.file.toLowerCase().endsWith(`-${descriptor.nativeSessionId!.toLowerCase()}.jsonl`) && !reserved.has(candidate.file.toLowerCase()))
      : undefined;
    if (exact) {
      this.bindings.set(descriptor.terminalId, exact.file);
      return { status: "ready", provider: "codex", file: exact.file, binding: "native-id" };
    }
    const matches: Candidate[] = [];
    for (const candidate of candidates) {
      if (reserved.has(candidate.file.toLowerCase())) continue;
      const meta = await readCodexSessionMeta(candidate.file);
      if (!meta || !sameCwd(meta.cwd ?? "", descriptor.cwd) || meta.startedAtMs < startedMs - 60_000) continue;
      matches.push({ ...candidate, startedAtMs: meta.startedAtMs });
    }
    if (matches.length === 0) return { status: "not_found", provider: "codex", file: null, binding: "none", reasonCode: "no_matching_rollout" };
    if (matches.length > 1) return { status: "ambiguous", provider: "codex", file: null, binding: "none", reasonCode: "multiple_matching_rollouts" };
    this.bindings.set(descriptor.terminalId, matches[0]!.file);
    return { status: "ready", provider: "codex", file: matches[0]!.file, binding: "cwd-start-time" };
  }

  private async listJsonl(folder: string): Promise<Candidate[]> {
    let names: string[];
    try { names = await readdir(folder); } catch { return []; }
    const candidates: Candidate[] = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(folder, name);
      const info = await stat(file).catch(() => null);
      if (info) candidates.push({ file, mtimeMs: info.mtimeMs });
    }
    return candidates;
  }

  private async listCodexRollouts(startedMs: number): Promise<Candidate[]> {
    const directories = new Set<string>();
    for (const offset of [-1, 0, 1]) {
      const date = new Date(startedMs + offset * 86_400_000);
      directories.add(join(this.options.codexSessionsRoot, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")));
      directories.add(join(this.options.codexSessionsRoot, String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, "0"), String(date.getUTCDate()).padStart(2, "0")));
    }
    const out: Candidate[] = [];
    for (const directory of directories) {
      let names: string[];
      try { names = await readdir(directory); } catch { continue; }
      for (const name of names) {
        if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
        const file = join(directory, name);
        const info = await stat(file).catch(() => null);
        if (info && info.mtimeMs >= startedMs - 60_000) out.push({ file, mtimeMs: info.mtimeMs });
      }
    }
    return out;
  }
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true).catch(() => false);
}

// Real rollouts put "session_meta" on the TOP-LEVEL type; payload has no
// type of its own. The meta line embeds base_instructions and is routinely
// ~44KB, so read a generous head instead of the old 8KB window — a truncated
// line fails JSON.parse and the meta was silently lost.
// ponytail: 1MB head cap; observed meta lines are ≤44KB. If Codex ever writes
// bigger ones, switch to a streaming first-line reader.
const META_HEAD_BYTES = 1_048_576;

export async function readCodexSessionMeta(file: string): Promise<{ cwd: string | null; startedAtMs: number } | null> {
  const info = await stat(file).catch(() => null);
  if (!info) return null;
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(Math.min(META_HEAD_BYTES, info.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n")) {
      if (!line) continue;
      let record: unknown;
      try { record = JSON.parse(line); } catch { continue; }
      if (!record || typeof record !== "object") continue;
      const value = record as Record<string, unknown>;
      if (value.type !== "session_meta") continue;
      const rawPayload = value.payload;
      // payload.timestamp is the session's true start; the top-level
      // timestamp is when the record was written (seconds later).
      const meta = rawPayload && typeof rawPayload === "object" ? rawPayload as Record<string, unknown> : {};
      const timestamp = typeof meta.timestamp === "string" ? Date.parse(meta.timestamp)
        : typeof value.timestamp === "string" ? Date.parse(value.timestamp) : 0;
      return { cwd: typeof meta.cwd === "string" ? meta.cwd : null, startedAtMs: timestamp };
    }
  } finally {
    await handle.close();
  }
  return null;
}
