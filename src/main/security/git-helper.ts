import { spawn } from "node:child_process";

export interface GitHelperOptions {
  /** Per-call cwd. Required — git never runs without an explicit working dir. */
  cwd: string;
  /** Hard kill timeout (ms). Defaults to 30s; callers may raise for long ops. */
  timeoutMs?: number;
  /** Max stdout bytes retained (tail kept). Defaults to 1 MB. */
  maxOutputBytes?: number;
  /** Optional bounded stdin. Used for generated patches; never invokes a shell. */
  input?: string;
}

export interface GitResult {
  stdout: string;
  exitCode: number;
  truncated: boolean;
}

export interface GitError extends Error {
  exitCode: number | null;
  /** Bounded stdout retained for commands such as `git diff --no-index`
   * which use exit code 1 to mean "differences found". */
  stdout: string;
  truncated: boolean;
  stderr: string;
  args: readonly string[];
  cwd: string;
}

/** Safe git wrapper: argument array, no shell, bounded output, hard timeout. */
export function git(
  args: readonly string[],
  options: GitHelperOptions,
): Promise<GitResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxOutputBytes ?? 1_000_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("git timeout must be positive.");
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error("git output cap must be a positive integer.");
  if (options.input !== undefined && Buffer.byteLength(options.input, "utf8") > 256 * 1024) {
    throw new Error("git input exceeds the 256 KB safety limit.");
  }

  return new Promise<GitResult>((resolvePromise, rejectPromise) => {
    const child = spawn("git", [...args], {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let timedOut = false;
    let settled = false;
    let stdoutTruncated = false;

    child.stdin.end(options.input ?? "", "utf8");

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > maxBytes) stdoutTruncated = true;
      stdout = appendTail(stdout, chunk, maxBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendTail(stderr, chunk, Math.min(maxBytes, 64_000));
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(makeGitError(args, options.cwd, null, stdout, stderr, error.message));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0 && !timedOut) {
        resolvePromise({ stdout: stdout.toString("utf8"), exitCode: 0, truncated: stdoutTruncated });
        return;
      }
      const detail = timedOut
        ? `timed out after ${timeoutMs}ms`
        : stderr.toString("utf8") || `exited with code ${code ?? "unknown"}`;
      const error = makeGitError(args, options.cwd, code, stdout, stderr, detail, stdoutTruncated);
      rejectPromise(error);
    });
  });
}

function appendTail(
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
  maxBytes: number,
): Buffer<ArrayBufferLike> {
  if (chunk.length >= maxBytes) return Buffer.from(chunk.subarray(chunk.length - maxBytes));
  if (current.length + chunk.length <= maxBytes) return Buffer.concat([current, chunk]);
  const keep = maxBytes - chunk.length;
  return Buffer.concat([current.subarray(current.length - keep), chunk]);
}

function makeGitError(
  args: readonly string[],
  cwd: string,
  exitCode: number | null,
  stdout: Buffer<ArrayBufferLike>,
  stderr: Buffer<ArrayBufferLike>,
  detail: string,
  truncated = false,
): GitError {
  const safeDetail = tailText(detail, 2_000);
  const wrapped = new Error(
    `git ${args.join(" ")} failed${exitCode !== null ? ` (exit ${exitCode})` : ""}: ${safeDetail}`,
  ) as GitError;
  wrapped.exitCode = exitCode;
  wrapped.stdout = tailText(stdout.toString("utf8"), 1_000_000);
  wrapped.truncated = truncated;
  wrapped.stderr = tailText(stderr.toString("utf8"), 2_000);
  wrapped.args = args;
  wrapped.cwd = cwd;
  return wrapped;
}

function tailText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(-maxChars);
}

export function isGitError(value: unknown): value is GitError {
  return value instanceof Error && Array.isArray((value as GitError).args);
}
