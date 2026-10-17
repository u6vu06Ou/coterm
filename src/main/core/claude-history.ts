import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import type { Project, ProviderProfileId } from "@shared/types";
import { redactSecrets } from "../security/redaction";

const HEAD_BYTES = 256_000;
const TAIL_BYTES = 4_000_000;
const MAX_MESSAGES = 200;
const MAX_TEXT = 200_000;
/** Concurrent inspection of changed files while listing project history. */
const INSPECT_POOL = 8;
/** Background warm-up concurrency so the cache fills without spiking disk. */
const WARM_POOL = 4;

export interface ClaudeHistorySession {
  key: string;
  projectId: string;
  title: string;
  aiTitle: string | null;
  firstPrompt: string | null;
  profileId: ProviderProfileId;
  updatedAt: string;
  nativeSessionId: string;
  sizeBytes: number;
}

export interface ClaudeHistoryTranscript {
  session: ClaudeHistorySession;
  messages: Array<{ role: "user" | "assistant"; text: string }>;
  truncated: boolean;
}

export interface ClaudeHistoryResolution {
  file: string;
  nativeSessionId: string;
  session: ClaudeHistorySession;
}

/**
 * Project-independent head metadata for one session jsonl, shared across
 * projects. Ownership (cwd → project.id) is computed per call.
 */
interface ClaudeFileMeta {
  cwd: string;
  title: string;
  timestamp: string;
  aiTitle: string | null;
  firstPrompt: string | null;
  model: string;
}

/** Change stamp: a file is re-inspected only when (mtimeMs, size) changes. */
interface ClaudeFileStamp {
  mtimeMs: number;
  size: number;
}

interface ClaudeFileCacheEntry {
  stamp: ClaudeFileStamp;
  meta: ClaudeFileMeta;
}

export class ClaudeHistory {
  private readonly metaCache = new Map<string, ClaudeFileCacheEntry>();

  constructor(private readonly root: string) {}

  async list(project: Project, projects: Project[]): Promise<ClaudeHistorySession[]> {
    const files = await this.files();
    const sessions: ClaudeHistorySession[] = [];
    await this.eachWithPool(files, INSPECT_POOL, async (file) => {
      // Tolerate files that vanish or fail mid-scan; the other sessions still list.
      const inspected = await this.inspect(file, project, projects).catch(() => null);
      if (inspected) sessions.push(inspected.session);
    });
    return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /** Pre-populate the head-metadata cache so the first project-history click is instant. Per-file failures are ignored. */
  async warm(): Promise<void> {
    const files = await this.files();
    await this.eachWithPool(files, WARM_POOL, async (file) => {
      const info = await stat(file).catch(() => null);
      if (!info) return;
      const stamp: ClaudeFileStamp = { mtimeMs: info.mtimeMs, size: info.size };
      await this.metaFor(file, stamp).catch(() => null);
    });
  }

  async read(project: Project, projects: Project[], key: string): Promise<ClaudeHistoryTranscript> {
    const resolved = await this.find(project, projects, key);
    const info = await stat(resolved.file);
    const start = Math.max(0, info.size - TAIL_BYTES);
    const messages: ClaudeHistoryTranscript["messages"] = [];
    let total = 0;
    let dropped = false;
    await readJsonLines(resolved.file, start, undefined, (record) => {
      const message = projectedMessage(record);
      if (!message) return;
      messages.push(message);
      total += message.text.length;
      while (messages.length > MAX_MESSAGES || total > MAX_TEXT) {
        const removed = messages.shift();
        total -= removed?.text.length ?? 0;
        dropped = true;
      }
    });
    return {
      session: resolved.session,
      messages,
      truncated: start > 0 || dropped,
    };
  }

  resolve(project: Project, projects: Project[], key: string): Promise<ClaudeHistoryResolution> {
    return this.find(project, projects, key);
  }

  private async find(project: Project, projects: Project[], key: string): Promise<ClaudeHistoryResolution> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid Claude history key.");
    for (const file of await this.files()) {
      if (historyKey(this.root, file) !== key) continue;
      const inspected = await this.inspect(file, project, projects);
      if (inspected) return inspected;
      break;
    }
    throw new Error("Claude history session not found.");
  }

  private async inspect(
    file: string,
    project: Project,
    projects: Project[],
  ): Promise<ClaudeHistoryResolution | null> {
    const info = await stat(file).catch(() => null);
    if (!info) return null;
    const stamp: ClaudeFileStamp = { mtimeMs: info.mtimeMs, size: info.size };
    const meta = await this.metaFor(file, stamp);
    const session = this.sessionFor(file, meta, stamp, project, projects);
    return session ? { file, nativeSessionId: basename(file, ".jsonl"), session } : null;
  }

  /** Cached head metadata: a stat-only hit unless the file changed. */
  private async metaFor(file: string, stamp: ClaudeFileStamp): Promise<ClaudeFileMeta> {
    const cached = this.metaCache.get(file);
    if (cached && cached.stamp.mtimeMs === stamp.mtimeMs && cached.stamp.size === stamp.size) {
      return cached.meta;
    }
    const meta = await this.extractMeta(file);
    this.metaCache.set(file, { stamp, meta });
    return meta;
  }

  private async extractMeta(file: string): Promise<ClaudeFileMeta> {
    let cwd = "";
    let title = "";
    let timestamp = "";
    let aiTitle: string | null = null;
    let firstPrompt: string | null = null;
    let model = "";
    await readJsonLines(file, 0, HEAD_BYTES - 1, (record) => {
      if (!cwd && typeof record.cwd === "string") cwd = record.cwd;
      if (!timestamp && typeof record.timestamp === "string") timestamp = record.timestamp;
      // aiTitle: LLM-native summary set by Claude Code CLI (top-level field).
      if (!aiTitle && typeof record.aiTitle === "string" && record.aiTitle.trim()) {
        aiTitle = record.aiTitle.trim();
      }
      // model: from message.model (assistant records carry it).
      if (!model) {
        const message = record.message;
        if (message && typeof message === "object") {
          const msgModel = (message as Record<string, unknown>).model;
          if (typeof msgModel === "string" && msgModel) model = msgModel;
        }
      }
      // firstPrompt + title fallback: first user message text.
      if (!title) {
        const message = projectedMessage(record);
        if (message?.role === "user") {
          const text = message.text.replace(/\s+/g, " ").slice(0, 100);
          title = text;
          if (!firstPrompt) firstPrompt = text;
        }
      }
    });
    return { cwd, title, timestamp, aiTitle, firstPrompt, model };
  }

  /** Ownership filter + session assembly; pure given cached meta. */
  private sessionFor(
    file: string,
    meta: ClaudeFileMeta,
    stamp: ClaudeFileStamp,
    project: Project,
    projects: Project[],
  ): ClaudeHistorySession | null {
    if (!meta.cwd || owningProject(meta.cwd, projects)?.id !== project.id) return null;
    const updatedAt = Number.isNaN(Date.parse(meta.timestamp)) ? new Date(stamp.mtimeMs).toISOString() : meta.timestamp;
    const nativeSessionId = basename(file, ".jsonl");
    return {
      key: historyKey(this.root, file),
      projectId: project.id,
      title: meta.title || `Claude ${updatedAt.slice(0, 10)}`,
      aiTitle: meta.aiTitle,
      firstPrompt: meta.firstPrompt,
      profileId: inferProfileId(meta.model),
      updatedAt,
      nativeSessionId,
      sizeBytes: stamp.size,
    };
  }

  private async files(): Promise<string[]> {
    const root = resolve(this.root);
    const directories = await readdir(root, { withFileTypes: true }).catch(() => []);
    const files: string[] = [];
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      const folder = join(root, directory.name);
      for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join(folder, entry.name));
      }
    }
    return files;
  }

  /** Worker pool of `poolSize` over one shared queue. */
  private async eachWithPool<T>(items: T[], poolSize: number, visit: (item: T) => Promise<void>): Promise<void> {
    const queue = [...items];
    const workers = Array.from({ length: Math.min(poolSize, queue.length) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (item !== undefined) await visit(item);
      }
    });
    await Promise.all(workers);
  }
}

async function readJsonLines(
  file: string,
  start: number,
  end: number | undefined,
  visit: (record: Record<string, unknown>) => void,
): Promise<void> {
  const lines = createInterface({ input: createReadStream(file, { start, end }), crlfDelay: Infinity });
  let first = true;
  for await (const line of lines) {
    if (first && start > 0) {
      first = false;
      continue;
    }
    first = false;
    try {
      const record = JSON.parse(line) as unknown;
      if (record && typeof record === "object") visit(record as Record<string, unknown>);
    } catch {
      // Partial and malformed history lines are ignored.
    }
  }
}

function projectedMessage(record: Record<string, unknown>): { role: "user" | "assistant"; text: string } | null {
  const message = record.message;
  if (!message || typeof message !== "object") return null;
  const value = message as Record<string, unknown>;
  if (value.role !== "user" && value.role !== "assistant") return null;
  const content = value.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.flatMap((block) => {
          if (!block || typeof block !== "object") return [];
          const item = block as Record<string, unknown>;
          return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
        }).join("\n")
      : "";
  const redacted = redactSecrets(text).trim().slice(0, 20_000);
  return redacted ? { role: value.role, text: redacted } : null;
}

export function owningProject(cwd: string, projects: Project[]): Project | undefined {
  const candidate = canonicalPath(cwd);
  return [...projects]
    .sort((left, right) => canonicalPath(right.workspacePath).length - canonicalPath(left.workspacePath).length)
    .find((project) => {
      const root = canonicalPath(project.workspacePath);
      return candidate === root || candidate.startsWith(`${root}${sep}`);
    });
}

export function canonicalPath(value: string): string {
  const driveSafe = value.replace(/^g:\\雲端硬碟(?=\\|$)/i, "C:\\CloudDrive");
  return resolve(driveSafe).replace(/[\\/]+/g, sep).replace(/[\\/]$/, "").toLowerCase();
}

function historyKey(root: string, file: string): string {
  return createHash("sha256").update(relative(resolve(root), resolve(file))).digest("hex");
}

/**
 * Infer a Coterm profileId from a Claude Code jsonl model name. The jsonl's
 * `message.model` field carries the underlying model (e.g. "my-glm-legacy",
 * "claude-sonnet-4-6"); map it to the Coterm profile that routes there.
 * Unknown/empty → claude-official (native CLI default). Exported for testing.
 */
export function inferProfileId(model: string): ProviderProfileId {
  const lower = model.toLowerCase();
  if (lower.includes("kimi")) {
    // Historical label only: "claude-local-big" is no longer a selectable profile
    // (dead upstream model), but old jsonl sessions must still group under the
    // bucket they used to launch under. Since the hot-model registry widened
    // ProviderProfileId to an open string id, no cast is needed; the string is
    // inert — Sidebar shows it as the session's provenance label and
    // canResumeProfile blocks re-launching it.
    return "claude-local-big";
  }
  if (lower.includes("my-legacy-model")) {
    // Same treatment for "claude-local-legacy": my-legacy-model went dark 2026-08-29 (the
    // fleet swapped it for my-glm-max) and the profile left the built-in
    // list. Old jsonl sessions carry the gateway's real ids
    // ("my-legacy-model" / "my-legacy-model"), so a lowercase "my-legacy-model"
    // needle catches both. Historical label only — canResumeProfile blocks
    // re-launching it.
    return "claude-local-legacy";
  }
  if (lower.includes("glm")) return "claude-local-main";
  if (lower.includes("qwen")) return "claude-local-long";
  if (lower.includes("gpt") || lower.includes("codex")) return "codex-local-main";
  // Official Claude model names (sonnet/opus/haiku) and unknowns default to
  // claude-official — the native CLI's default backend.
  return "claude-official";
}
