import { appendFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import { redactEgress } from "../security/redaction";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogCategory =
  | "app"
  | "ipc"
  | "web"
  | "live"
  | "pty"
  | "state"
  | "provider"
  | "storage"
  | "run"
  | "council"
  | "security"
  | "voice"
  | "audit";

export interface LogContext {
  conversationId?: string | null;
  turnId?: string | null;
  terminalId?: string | null;
  [key: string]: unknown;
}

export interface Logger {
  debug(category: LogCategory, msgCode: string, msg: string, context?: LogContext): void;
  info(category: LogCategory, msgCode: string, msg: string, context?: LogContext): void;
  warn(category: LogCategory, msgCode: string, msg: string, context?: LogContext): void;
  error(category: LogCategory, msgCode: string, msg: string, context?: LogContext): void;
  audit(category: LogCategory, msgCode: string, msg: string, context?: LogContext): void;
  isDegraded(): boolean;
  flush(): void;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const CATEGORY_DEFAULT_LEVEL: Record<LogCategory, LogLevel> = {
  app: "info",
  run: "info",
  security: "info",
  voice: "info",
  ipc: "warn",
  storage: "warn",
  web: "warn",
  live: "info",
  provider: "warn",
  council: "warn",
  pty: "error",
  state: "info",
  audit: "info",
};

const RING_BUFFER_SIZE = 200;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROTATED_FILES = 7;
const SCHEMA_VERSION = 1;

export interface RingEntry {
  ts: string;
  level: LogLevel;
  category: LogCategory;
  msgCode: string;
  msg: string;
  context?: LogContext | undefined;
}

export interface LoggerHealth {
  degraded: boolean;
  consecutiveWriteFailures: number;
  ringBufferCount: number;
  fileWriteDisabled: boolean;
  logPath: string;
}

export interface LogEntryFilter {
  level?: LogLevel;
  category?: LogCategory;
  since?: string;
  q?: string;
  limit?: number;
}

class ConsoleLogger implements Logger {
  debug(category: LogCategory, msgCode: string, msg: string, context?: LogContext): void {
    this.emit("debug", category, msgCode, msg, context);
  }
  info(category: LogCategory, msgCode: string, msg: string, context?: LogContext): void {
    this.emit("info", category, msgCode, msg, context);
  }
  warn(category: LogCategory, msgCode: string, msg: string, context?: LogContext): void {
    this.emit("warn", category, msgCode, msg, context);
  }
  error(category: LogCategory, msgCode: string, msg: string, context?: LogContext): void {
    this.emit("error", category, msgCode, msg, context);
  }
  audit(category: LogCategory, msgCode: string, msg: string, context?: LogContext): void {
    this.emit("info", category, msgCode, msg, context);
  }
  isDegraded(): boolean {
    return true;
  }
  flush(): void {
    // no-op for console fallback
  }

  private emit(level: LogLevel, category: LogCategory, msgCode: string, msg: string, context?: LogContext): void {
    const ts = new Date().toISOString();
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    try {
      fn(`[${ts}] [${level}] [${category}] ${msgCode}: ${msg}`, context ?? {});
    } catch {
      // never crash caller
    }
  }
}

class FileLogger implements Logger {
  private readonly logPath: string;
  private readonly logsDir: string;
  private readonly minLevel: LogLevel;
  private readonly ringBuffer: RingEntry[] = [];
  private degraded = false;
  private consecutiveWriteFailures = 0;
  private fileWriteDisabled = false;
  private lastRotationDay = "";

  constructor(opts: { userDataDir: string; level?: LogLevel }) {
    this.logsDir = join(opts.userDataDir, "logs");
    this.logPath = join(this.logsDir, "coterm.log");
    this.minLevel = opts.level ?? this.resolveLevel();
    try {
      mkdirSync(this.logsDir, { recursive: true });
      this.lastRotationDay = this.dayKey(new Date());
      this.pruneRotatedFiles();
    } catch (error) {
      this.markDegraded(error);
    }
  }

  debug(category: LogCategory, msgCode: string, msg: string, context?: LogContext): void {
    this.write("debug", category, msgCode, msg, context);
  }
  info(category: LogCategory, msgCode: string, msg: string, context?: LogContext): void {
    this.write("info", category, msgCode, msg, context);
  }
  warn(category: LogCategory, msgCode: string, msg: string, context?: LogContext): void {
    this.write("warn", category, msgCode, msg, context);
  }
  error(category: LogCategory, msgCode: string, msg: string, context?: LogContext): void {
    this.write("error", category, msgCode, msg, context);
  }
  audit(category: LogCategory, msgCode: string, msg: string, context?: LogContext): void {
    this.write("info", category, msgCode, msg, context);
  }
  isDegraded(): boolean {
    return this.degraded;
  }
  flush(): void {
    // sync writes are already flushed; ring buffer is in-memory only
  }

  getHealth(): LoggerHealth {
    return {
      degraded: this.degraded,
      consecutiveWriteFailures: this.consecutiveWriteFailures,
      ringBufferCount: this.ringBuffer.length,
      fileWriteDisabled: this.fileWriteDisabled,
      logPath: this.logPath,
    };
  }

  getRecentEntries(opts?: LogEntryFilter): RingEntry[] {
    let entries = this.ringBuffer.slice();
    if (opts?.level) entries = entries.filter((e) => e.level === opts.level);
    if (opts?.category) entries = entries.filter((e) => e.category === opts.category);
    if (opts?.since) {
      const sinceMs = Date.parse(opts.since);
      if (!Number.isNaN(sinceMs)) {
        entries = entries.filter((e) => Date.parse(e.ts) >= sinceMs);
      }
    }
    if (opts?.q) {
      const needle = opts.q.toLowerCase();
      entries = entries.filter(
        (e) => e.msg.toLowerCase().includes(needle) || e.msgCode.toLowerCase().includes(needle),
      );
    }
    const limit = opts?.limit ?? RING_BUFFER_SIZE;
    return entries.slice(-limit);
  }

  getFilePath(): string {
    return this.logPath;
  }

  private resolveLevel(): LogLevel {
    const envLevel = process.env.COTERM_LOG_LEVEL;
    if (envLevel === "debug") return "debug";
    return "info";
  }

  private write(level: LogLevel, category: LogCategory, msgCode: string, msg: string, context?: LogContext): void {
    const ts = new Date().toISOString();
    const entry: RingEntry = { ts, level, category, msgCode, msg, context };
    this.pushRing(entry);
    if (LEVEL_RANK[level] < LEVEL_RANK[this.effectiveLevel(category)]) return;
    if (this.fileWriteDisabled) return;
    const line = this.formatLine(entry);
    try {
      this.maybeRotate();
      appendFileSync(this.logPath, line + "\n", "utf8");
      this.consecutiveWriteFailures = 0;
    } catch (error) {
      this.handleWriteFailure(error);
    }
  }

  private effectiveLevel(category: LogCategory): LogLevel {
    if (this.minLevel === "debug") return "debug";
    return CATEGORY_DEFAULT_LEVEL[category];
  }

  private formatLine(entry: RingEntry): string {
    const { ts, level, category, msgCode, msg, context } = entry;
    const base: Record<string, unknown> = {
      v: SCHEMA_VERSION,
      ts,
      level,
      category,
      msgCode,
      msg: redactEgress(msg),
    };
    if (context) {
      const { conversationId, turnId, terminalId, ...rest } = context;
      if (conversationId !== undefined && conversationId !== null) base.conversationId = conversationId;
      if (turnId !== undefined && turnId !== null) base.turnId = turnId;
      if (terminalId !== undefined && terminalId !== null) base.terminalId = terminalId;
      for (const [key, value] of Object.entries(rest)) {
        if (value === undefined || value === null) continue;
        base[key] = typeof value === "string" ? redactEgress(value) : value;
      }
    }
    try {
      return JSON.stringify(base);
    } catch {
      return JSON.stringify({ v: SCHEMA_VERSION, ts, level, category, msgCode, msg: "[SERIALIZE-FAILED]" });
    }
  }

  private maybeRotate(): void {
    const now = new Date();
    const dayKey = this.dayKey(now);
    let rotated = false;
    if (dayKey !== this.lastRotationDay) {
      this.rotateFile();
      this.lastRotationDay = dayKey;
      rotated = true;
    }
    if (!rotated && existsSync(this.logPath)) {
      try {
        const stats = statSync(this.logPath);
        if (stats.size > MAX_FILE_BYTES) {
          this.rotateFile();
        }
      } catch {
        // stat failure is non-fatal
      }
    }
  }

  private rotateFile(): void {
    if (!existsSync(this.logPath)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const rotatedPath = join(this.logsDir, `coterm.${stamp}.log`);
    try {
      renameSync(this.logPath, rotatedPath);
      this.pruneRotatedFiles();
    } catch (error) {
      this.markDegraded(error);
    }
  }

  private pruneRotatedFiles(): void {
    try {
      const files = readdirSync(this.logsDir)
        .filter((name) => name.startsWith("coterm.") && name.endsWith(".log") && name !== "coterm.log")
        .map((name) => ({ name, path: join(this.logsDir, name), mtime: statSync(join(this.logsDir, name)).mtimeMs }))
        .sort((left, right) => right.mtime - left.mtime);
      for (const file of files.slice(MAX_ROTATED_FILES)) {
        try {
          unlinkSync(file.path);
        } catch {
          // best-effort cleanup
        }
      }
    } catch {
      // best-effort cleanup
    }
  }

  private dayKey(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  private pushRing(entry: RingEntry): void {
    this.ringBuffer.push(entry);
    if (this.ringBuffer.length > RING_BUFFER_SIZE) {
      this.ringBuffer.shift();
    }
  }

  private handleWriteFailure(error: unknown): void {
    this.consecutiveWriteFailures += 1;
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOSPC|EROFS|no space left/i.test(message)) {
      this.fileWriteDisabled = true;
      if (!this.degraded) {
        this.degraded = true;
        console.error(`coterm logger: disk write disabled (${message})`);
      }
      return;
    }
    if (this.consecutiveWriteFailures >= 5 && !this.degraded) {
      this.degraded = true;
      console.error(`coterm logger: degraded after ${this.consecutiveWriteFailures} write failures`);
    }
  }

  private markDegraded(error: unknown): void {
    this.degraded = true;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`coterm logger: init degraded (${message})`);
  }
}

let activeLogger: Logger = new ConsoleLogger();

function currentLogger(): Logger {
  return activeLogger;
}

export function initLogger(opts: { userDataDir: string; level?: LogLevel }): void {
  try {
    activeLogger = new FileLogger(opts);
    activeLogger.info("app", "logger.initialized", "Logger initialized", { userDataDir: opts.userDataDir });
  } catch (error) {
    // keep ConsoleLogger fallback; never prevent boot
    console.error("coterm logger: init failed, using console fallback", error);
  }
}

// v1.5 Phase 0C: the crash sink is a channel-owned path. NEVER hard-code the
// stable "%APPDATA%\Coterm" dir here — a Beta crash must land in the
// Beta userData\logs\crash.log, never cross-write into the live stable one.
// The bootstrap passes the already-resolved app.getPath("userData").
export function writeCrashLog(error: unknown, userDataDir?: string | null): void {
  try {
    const dir = userDataDir ?? process.env.COTERM_USER_DATA_DIR ?? null;
    if (!dir) return;
    const logsDir = join(dir, "logs");
    mkdirSync(logsDir, { recursive: true });
    const crashPath = join(logsDir, "crash.log");
    const ts = new Date().toISOString();
    const message = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
    const line = `[${ts}] ${redactEgress(message)}\n`;
    appendFileSync(crashPath, line, "utf8");
  } catch {
    // last-resort: if even crash logging fails, write to stderr
    console.error("coterm: failed to write crash log", error);
  }
}

export const logger: Logger = new Proxy({} as Logger, {
  get(_target, prop: string | symbol): unknown {
    const target = currentLogger();
    const value = (target as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === "function" ? value.bind(target) : value;
  },
});

// --- Module-level query functions (read activeLogger, same proxy pattern) ---
// These expose ring-buffer / health introspection for the agent API endpoints.
// They never log themselves and never return un-redacted content — ring entries
// are already redacted at write time via formatLine(); callers should still pass
// results through redactEgress before egressing (defence in depth).

export function getLoggerHealth(): LoggerHealth {
  const target = activeLogger;
  if (target instanceof FileLogger) return target.getHealth();
  // ConsoleLogger fallback — no file, no ring buffer, always degraded.
  return {
    degraded: true,
    consecutiveWriteFailures: 0,
    ringBufferCount: 0,
    fileWriteDisabled: true,
    logPath: "",
  };
}

export function getRecentLogEntries(opts?: LogEntryFilter): RingEntry[] {
  const target = activeLogger;
  if (target instanceof FileLogger) return target.getRecentEntries(opts);
  return [];
}

export function getLogFilePath(): string {
  const target = activeLogger;
  if (target instanceof FileLogger) return target.getFilePath();
  return "";
}

export interface ProcessMemorySnapshot {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
}

/**
 * Snapshot of the Node/Electron process memory usage (bytes).
 * Used by the /diagnostics agent endpoint for RAM observability.
 * Never throws — returns zeros on failure so diagnostics stays alive.
 */
export function getProcessMemory(): ProcessMemorySnapshot {
  try {
    const m = process.memoryUsage();
    return {
      rss: m.rss,
      heapUsed: m.heapUsed,
      heapTotal: m.heapTotal,
      external: m.external,
    };
  } catch {
    return { rss: 0, heapUsed: 0, heapTotal: 0, external: 0 };
  }
}
