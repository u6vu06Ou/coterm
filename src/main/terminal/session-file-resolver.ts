import { open, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { canonicalPath } from "../core/claude-history";

export type ResolvedSessionStatus = "ready" | "pending" | "not_found" | "ambiguous" | "unsupported";
export type SessionProvider = "claude" | "codex" | "unsupported";

export interface TerminalSessionDescriptor {
  terminalId: string;
  cwd: string;
  startedAt: string;
  nativeSessionId: string | null;
  provider: SessionProvider;
  /** Native session ids owned by OTHER live terminals — never hop onto those files. */
  reservedSessionIds?: readonly string[];
}

export interface ResolvedSessionFile {
  status: ResolvedSessionStatus;
  provider: SessionProvider;
  file: string | null;
  binding: "native-id" | "cwd-start-time" | "none";
  reasonCode?: string;
  /** Set when the agent moved to a new session file inside the same terminal (/clear, /new, /resume). */
  reboundSessionId?: string;
}

interface Candidate {
  file: string;
  mtimeMs: number;
  /** When the file was created (birthtime, ctime fallback). */
  bornMs: number;
  startedAtMs?: number;
}

// A session file counts as "replaced" only when the successor was born no
// earlier than this long before the old file's last write — /clear, /new and
// an in-session /resume all stop writing the old file as the new one starts.
const SUCCESSOR_SLACK_MS = 5_000;

function sessionIdOf(file: string): string {
  return basename(file, ".jsonl");
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
    const startedMs = Date.parse(descriptor.startedAt);
    let anchor: string | null = null;
    let binding: ResolvedSessionFile["binding"] = "cwd-start-time";
    if (descriptor.nativeSessionId) {
      const file = join(folder, `${descriptor.nativeSessionId}.jsonl`);
      // Keep following a hop made earlier (the native id may lag one refresh behind).
      const bound = this.bindings.get(descriptor.terminalId);
      if (await exists(file)) anchor = bound && await exists(bound) ? bound : file;
      else if (bound && await exists(bound)) anchor = bound;
      else return { status: "pending", provider: "claude", file: null, binding: "native-id", reasonCode: "native_session_not_created" };
      binding = "native-id";
    }
    const candidates = await this.listJsonl(folder);
    const reserved = this.reservedFiles(descriptor, candidates);
    if (!anchor) {
      const bound = this.bindings.get(descriptor.terminalId);
      if (bound && await exists(bound)) {
        anchor = bound;
      } else {
        const live = (Number.isFinite(startedMs)
          ? candidates.filter((candidate) => candidate.mtimeMs >= startedMs - 60_000)
          : candidates).filter((candidate) => !reserved.has(candidate.file.toLowerCase()));
        if (live.length === 0) return { status: "not_found", provider: "claude", file: null, binding: "none", reasonCode: "no_matching_session" };
        if (live.length > 1) return { status: "ambiguous", provider: "claude", file: null, binding: "none", reasonCode: "multiple_matching_sessions" };
        anchor = live[0]!.file;
      }
    }
    const file = followSuccessors(anchor, candidates, reserved, startedMs);
    this.bindings.set(descriptor.terminalId, file);
    const rebound = descriptor.nativeSessionId !== null && sessionIdOf(file) !== descriptor.nativeSessionId;
    return {
      status: "ready", provider: "claude", file, binding,
      ...(rebound ? { reboundSessionId: sessionIdOf(file) } : {}),
    };
  }

  /** Files that belong to other terminals: their native ids and their current bindings. */
  private reservedFiles(descriptor: TerminalSessionDescriptor, candidates: Candidate[]): Set<string> {
    const reserved = new Set([...this.bindings.entries()]
      .filter(([id]) => id !== descriptor.terminalId).map(([, file]) => file.toLowerCase()));
    const ids = (descriptor.reservedSessionIds ?? []).map((id) => id.toLowerCase());
    for (const candidate of candidates) {
      const name = basename(candidate.file).toLowerCase();
      if (ids.some((id) => name === `${id}.jsonl` || name.endsWith(`-${id}.jsonl`))) reserved.add(candidate.file.toLowerCase());
    }
    return reserved;
  }

  private async resolveCodex(descriptor: TerminalSessionDescriptor): Promise<ResolvedSessionFile> {
    const startedMs = Date.parse(descriptor.startedAt);
    if (!Number.isFinite(startedMs)) return { status: "not_found", provider: "codex", file: null, binding: "none", reasonCode: "invalid_started_at" };
    const candidates = await this.listCodexRollouts(startedMs);
    const reserved = this.reservedFiles(descriptor, candidates);
    const bound = this.bindings.get(descriptor.terminalId);
    if (bound && await exists(bound)) {
      // A /new (or resume) inside the same Codex starts a fresh rollout in this cwd; follow it.
      const sameCwdCandidates: Candidate[] = [];
      for (const candidate of candidates) {
        if (candidate.file.toLowerCase() === bound.toLowerCase()) { sameCwdCandidates.push(candidate); continue; }
        const meta = await readCodexSessionMeta(candidate.file);
        if (meta && sameCwd(meta.cwd ?? "", descriptor.cwd)) sameCwdCandidates.push(candidate);
      }
      const file = followSuccessors(bound, sameCwdCandidates, reserved, startedMs);
      this.bindings.set(descriptor.terminalId, file);
      return { status: "ready", provider: "codex", file, binding: descriptor.nativeSessionId ? "native-id" : "cwd-start-time" };
    }
    if (bound) this.bindings.delete(descriptor.terminalId);
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
      if (info) candidates.push({ file, mtimeMs: info.mtimeMs, bornMs: info.birthtimeMs || info.ctimeMs });
    }
    return candidates;
  }

  private async listCodexRollouts(startedMs: number): Promise<Candidate[]> {
    const directories = new Set<string>();
    // Around the terminal's start, plus today: a terminal left open for days still finds a fresh /new rollout.
    for (const anchorMs of [startedMs - 86_400_000, startedMs, startedMs + 86_400_000, Date.now()]) {
      const date = new Date(anchorMs);
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
        if (info && info.mtimeMs >= startedMs - 60_000) out.push({ file, mtimeMs: info.mtimeMs, bornMs: info.birthtimeMs || info.ctimeMs });
      }
    }
    return out;
  }
}

/**
 * Walk from the terminal's current session file to the file the agent is writing now. A successor
 * must be unclaimed, born after the terminal started, and born no earlier than the current file's
 * last write (minus slack). Only an unambiguous single successor is followed at each step.
 */
function followSuccessors(anchor: string, candidates: Candidate[], reserved: Set<string>, startedMs: number): string {
  const byFile = new Map(candidates.map((candidate) => [candidate.file.toLowerCase(), candidate]));
  const visited = new Set<string>();
  let current = anchor;
  for (;;) {
    const key = current.toLowerCase();
    visited.add(key);
    const currentInfo = byFile.get(key);
    if (!currentInfo) return current;
    const next = candidates.filter((candidate) => {
      const candidateKey = candidate.file.toLowerCase();
      return !visited.has(candidateKey) && !reserved.has(candidateKey)
        && (!Number.isFinite(startedMs) || candidate.bornMs >= startedMs - 60_000)
        && candidate.bornMs >= currentInfo.mtimeMs - SUCCESSOR_SLACK_MS
        && candidate.mtimeMs > currentInfo.mtimeMs;
    });
    if (next.length !== 1) return current;
    current = next[0]!.file;
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
