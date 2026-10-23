import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { mungeClaudeCwd } from "./session-file-resolver";

/**
 * Live-session following for Claude panes (the /resume-to-older bug).
 *
 * A pane's nativeSessionId is issued once at launch (--session-id). When the
 * user runs /resume inside Claude Code and lands on an OLDER conversation, the
 * transcript resolver's successor walk can never find it — that walk only
 * follows files BORN after the anchor, and a resumed file predates it.
 *
 * Claude Code itself publishes ground truth at ~/.claude/sessions/<pid>.json:
 *   { pid, sessionId, cwd, startedAt, status, updatedAt, ... }
 * and updates sessionId there on /resume. The <pid> is the claude process, a
 * descendant of the pane's PTY shell. This module resolves a pane to the
 * session its live claude process is actually in:
 *
 *   1. Walk the process tree below the pane's shell pid (one cached system-wide
 *      listing) and read the session files of descendant pids. Tree membership
 *      is proof of ownership, so no ambiguity rules apply there.
 *   2. Fallback (tree listing failed or no in-tree session file): a session
 *      file whose cwd equals the pane cwd (case-insensitive), started at/after
 *      the pane start minus a slack, and not claimed by another pane — only
 *      when exactly one matches.
 *
 * A candidate only wins when its transcript file exists and it differs from the
 * pane's current nativeSessionId; otherwise null (= keep the current binding).
 */

export interface ProcessEntry {
  pid: number;
  ppid: number;
}

interface ClaudeSessionFile {
  pid: number;
  sessionId: string;
  cwd: string;
  /** epoch ms when this claude process started (NOT the resumed session's birth). */
  startedAt: number;
  updatedAt: number;
}

export interface LiveSessionPane {
  terminalId: string;
  /** node-pty shell pid (TerminalInfo.pid). 0/negative disables following. */
  shellPid: number;
  cwd: string;
  /** ISO timestamp the pane was spawned. */
  startedAt: string;
  nativeSessionId: string | null;
  /** nativeSessionIds claimed by OTHER panes — never bind onto those. */
  reservedSessionIds: readonly string[];
}

export interface ClaudeLiveSessionTrackerDeps {
  /** Override ~/.claude/sessions for tests. */
  sessionsDir?: string | undefined;
  /** Override ~/.claude/projects for tests. */
  claudeProjectsRoot?: string | undefined;
  /** Test hook: fake process table. Production lists the real one. */
  listProcesses?: (() => Promise<ProcessEntry[]>) | undefined;
  now?: (() => number) | undefined;
  /** Process-listing cache TTL; the listing is shared by all panes in a tick. */
  processCacheMs?: number | undefined;
}

const PROCESS_CACHE_MS = 5_000;
const FALLBACK_START_SLACK_MS = 60_000;

/** All pids at or below `rootPid` (the pane shell) in the process table. */
export function collectDescendants(rootPid: number, entries: readonly ProcessEntry[]): Set<number> {
  const children = new Map<number, number[]>();
  for (const entry of entries) {
    const list = children.get(entry.ppid);
    if (list) list.push(entry.pid);
    else children.set(entry.ppid, [entry.pid]);
  }
  const out = new Set<number>();
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.pop()!;
    if (out.has(pid)) continue; // a pid cycle in a corrupt table must not spin
    out.add(pid);
    for (const child of children.get(pid) ?? []) queue.push(child);
  }
  return out;
}

/**
 * One system-wide process listing. Windows: a single Get-CimInstance through
 * the in-box PowerShell 5.1 (headless — windowsHide, no console flash), no
 * wmic. Elsewhere: `ps -eo pid=,ppid=`. Throws on failure so the caller can
 * fall back to cwd matching instead of trusting an empty table.
 */
export async function listSystemProcesses(platform: NodeJS.Platform = process.platform): Promise<ProcessEntry[]> {
  if (platform === "win32") {
    const powershell = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
    );
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        powershell,
        [
          "-NoProfile", "-NonInteractive", "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress",
        ],
        { encoding: "utf8", timeout: 15_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => (error ? reject(new Error(error.message)) : resolve(stdout)),
      );
    });
    const parsed: unknown = JSON.parse(stdout.trim() || "[]");
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const out: ProcessEntry[] = [];
    for (const row of rows) {
      const record = row as Record<string, unknown> | null;
      const pid = Number(record?.ProcessId);
      const ppid = Number(record?.ParentProcessId);
      if (Number.isInteger(pid) && pid > 0 && Number.isInteger(ppid) && ppid >= 0) {
        out.push({ pid, ppid });
      }
    }
    return out;
  }
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile("ps", ["-eo", "pid=,ppid="], { encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => (error ? reject(new Error(error.message)) : resolve(stdout)));
  });
  const out: ProcessEntry[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) out.push({ pid: Number(match[1]), ppid: Number(match[2]) });
  }
  return out;
}

/** Unify separators and drop trailing slashes (drives both equality and munging). */
function normalizeCwd(value: string): string {
  return value.replace(/\//g, "\\").replace(/\\+$/, "");
}

/** Case-insensitive cwd equality with separator/trailing-slash tolerance. */
function equalCwd(a: string, b: string): boolean {
  return normalizeCwd(a).toLowerCase() === normalizeCwd(b).toLowerCase();
}

function parseSessionFile(text: string): ClaudeSessionFile | null {
  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch {
    return null;
  }
  if (!record || typeof record !== "object") return null;
  const value = record as Record<string, unknown>;
  if (typeof value.sessionId !== "string" || !value.sessionId) return null;
  if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) return null;
  return {
    pid: value.pid,
    sessionId: value.sessionId,
    cwd: typeof value.cwd === "string" ? value.cwd : "",
    startedAt: typeof value.startedAt === "number" ? value.startedAt : 0,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
  };
}

export class ClaudeLiveSessionTracker {
  private readonly sessionsDir: string;
  private readonly projectsRoot: string;
  private readonly listProcesses: () => Promise<ProcessEntry[]>;
  private readonly now: () => number;
  private readonly processCacheMs: number;
  private processCache: { at: number; entries: ProcessEntry[] } | null = null;
  /** claude pid -> its ancestor pids. A process's ancestry never changes, so
   *  the system-wide listing (a pwsh spawn) only runs when a session file
   *  appears for a pid we have not seen yet — not on every tick. */
  private readonly ancestry = new Map<number, Set<number>>();

  constructor(deps: ClaudeLiveSessionTrackerDeps = {}) {
    this.sessionsDir = deps.sessionsDir ?? join(homedir(), ".claude", "sessions");
    this.projectsRoot = deps.claudeProjectsRoot ?? join(homedir(), ".claude", "projects");
    this.listProcesses = deps.listProcesses ?? (() => listSystemProcesses());
    this.now = deps.now ?? (() => Date.now());
    this.processCacheMs = deps.processCacheMs ?? PROCESS_CACHE_MS;
  }

  /**
   * The session id this pane's live claude process is in, when it differs from
   * the pane's current binding and the transcript file exists. null = keep the
   * current binding (no signal, ambiguous signal, or already in step).
   */
  async follow(pane: LiveSessionPane): Promise<string | null> {
    if (!pane.cwd || pane.shellPid <= 0) return null;
    const reserved = new Set(pane.reservedSessionIds.map((id) => id.toLowerCase()));
    const candidate = (await this.findInProcessTree(pane)) ?? (await this.findByCwdFallback(pane, reserved));
    if (!candidate) return null;
    if (candidate.sessionId === pane.nativeSessionId) return null;
    if (reserved.has(candidate.sessionId.toLowerCase())) return null;
    // /clear (new id) writes its transcript a beat after the pid file flips;
    // /resume (old id) always has one. Never bind to a session with no file.
    if (!(await this.transcriptExists(candidate.cwd || pane.cwd, candidate.sessionId))) return null;
    return candidate.sessionId;
  }

  /** Session file of a claude process inside the pane's own process tree. */
  private async findInProcessTree(pane: LiveSessionPane): Promise<ClaudeSessionFile | null> {
    const pids = await this.sessionPids();
    if (pids.some((pid) => !this.ancestry.has(pid))) {
      const entries = await this.processes();
      if (!entries) return null; // listing failed → caller falls back
      const parentOf = new Map(entries.map((entry) => [entry.pid, entry.ppid]));
      for (const pid of pids) {
        if (this.ancestry.has(pid)) continue;
        const chain = new Set<number>([pid]);
        for (let at = parentOf.get(pid); at !== undefined && at > 0 && !chain.has(at); at = parentOf.get(at)) chain.add(at);
        this.ancestry.set(pid, chain);
      }
    }
    const found: ClaudeSessionFile[] = [];
    for (const pid of pids) {
      if (!this.ancestry.get(pid)?.has(pane.shellPid)) continue;
      const session = await this.readSessionPid(pid);
      if (session) found.push(session);
    }
    if (found.length === 0) return null;
    if (found.length === 1) return found[0]!;
    // Two claude processes in one pane (nested/parallel): prefer the one whose
    // cwd matches the pane, then the most recently active.
    found.sort((a, b) => {
      const aCwd = a.cwd && equalCwd(a.cwd, pane.cwd) ? 1 : 0;
      const bCwd = b.cwd && equalCwd(b.cwd, pane.cwd) ? 1 : 0;
      if (aCwd !== bCwd) return bCwd - aCwd;
      return (b.updatedAt || b.startedAt) - (a.updatedAt || a.startedAt);
    });
    return found[0]!;
  }

  /**
   * Fallback when the process tree yields nothing: exactly one unclaimed
   * session whose cwd equals the pane's and whose claude process started
   * at/after the pane (slack for shell startup skew).
   */
  private async findByCwdFallback(
    pane: LiveSessionPane,
    reserved: ReadonlySet<string>,
  ): Promise<ClaudeSessionFile | null> {
    const paneStartedMs = Date.parse(pane.startedAt);
    if (!Number.isFinite(paneStartedMs)) return null;
    const sessions = await this.readAllSessions();
    const byId = new Map<string, ClaudeSessionFile>();
    for (const session of sessions) {
      if (!session.cwd || !equalCwd(session.cwd, pane.cwd)) continue;
      if (session.startedAt < paneStartedMs - FALLBACK_START_SLACK_MS) continue;
      if (reserved.has(session.sessionId.toLowerCase())) continue;
      if (!byId.has(session.sessionId)) byId.set(session.sessionId, session);
    }
    if (byId.size !== 1) return null;
    return [...byId.values()][0]!;
  }

  private async processes(): Promise<ProcessEntry[] | null> {
    const at = this.now();
    if (this.processCache && at - this.processCache.at < this.processCacheMs) {
      return this.processCache.entries;
    }
    let entries: ProcessEntry[];
    try {
      entries = await this.listProcesses();
    } catch {
      return null;
    }
    this.processCache = { at, entries };
    return entries;
  }

  private async sessionPids(): Promise<number[]> {
    const names = await readdir(this.sessionsDir).catch(() => [] as string[]);
    return names.flatMap((name) => {
      const match = /^(\d+)\.json$/u.exec(name);
      return match ? [Number(match[1])] : [];
    });
  }

  private async readSessionPid(pid: number): Promise<ClaudeSessionFile | null> {
    const text = await readFile(join(this.sessionsDir, `${pid}.json`), "utf8").catch(() => null);
    if (text === null) return null;
    const session = parseSessionFile(text);
    // Sanity: the filename pid and the payload pid must agree or the file is
    // not the live-session record we think it is.
    return session && session.pid === pid ? session : null;
  }

  private async readAllSessions(): Promise<ClaudeSessionFile[]> {
    const names = await readdir(this.sessionsDir).catch(() => [] as string[]);
    const out: ClaudeSessionFile[] = [];
    for (const name of names) {
      if (!/^\d+\.json$/u.test(name)) continue; // skip <pid>.<hash>.key sidecars
      const text = await readFile(join(this.sessionsDir, name), "utf8").catch(() => null);
      if (text === null) continue;
      const session = parseSessionFile(text);
      if (session && `${session.pid}.json` === name) out.push(session);
    }
    return out;
  }

  private async transcriptExists(cwd: string, sessionId: string): Promise<boolean> {
    if (!cwd) return false;
    const file = join(this.projectsRoot, mungeClaudeCwd(normalizeCwd(cwd)), `${sessionId}.jsonl`);
    return stat(file).then(() => true).catch(() => false);
  }
}
