import type { AppSettings } from "@shared/schema";
import type { ProviderAdapter } from "../providers/types";
import { redactSecrets } from "../security/redaction";

export const SUMMARY_PROMPT_LIMIT = 8_000;
export const SUMMARY_MERGE_INPUT_LIMIT = 6_000;
export const SUMMARY_FRAGMENT_LIMIT = 2_900;
export const SUMMARY_TIMEOUT_MS = 180_000;

export type FreeSummaryProfile = "claude-local-main" | "claude-local-long";

/**
 * One summary job owns one session. A failed GLM invocation permanently moves
 * the remaining map/reduce steps to Qwen. The allowlist is intentionally
 * closed: this helper can never fall through to a paid provider profile.
 */
export class FreeSummarySession {
  private profile: FreeSummaryProfile = "claude-local-main";

  constructor(
    private readonly adapters: ProviderAdapter[],
    private readonly workspacePath: string,
    private readonly permissionPreset: AppSettings["permissionPreset"],
    private readonly externalSignal?: AbortSignal,
    // null means the caller already supplied one job-wide deadline signal.
    private readonly timeoutMs: number | null = SUMMARY_TIMEOUT_MS,
  ) {}

  get activeProfile(): FreeSummaryProfile {
    return this.profile;
  }

  async invoke<T>(prompt: string, parse: (text: string) => T): Promise<T> {
    if (prompt.length > SUMMARY_PROMPT_LIMIT) {
      throw new Error("Summary prompt exceeds its size limit.");
    }
    if (this.externalSignal?.aborted) throw abortError();

    for (;;) {
      try {
        const adapter = this.adapters.find((candidate) => candidate.profiles.includes(this.profile));
        if (!adapter) throw new Error(`Provider unavailable: ${this.profile}`);
        const timeout = this.timeoutMs === null ? null : AbortSignal.timeout(this.timeoutMs);
        const signal = this.externalSignal && timeout
          ? AbortSignal.any([this.externalSignal, timeout])
          : this.externalSignal ?? timeout ?? AbortSignal.timeout(SUMMARY_TIMEOUT_MS);
        const result = await adapter.run({
          profileId: this.profile,
          workspacePath: this.workspacePath,
          prompt,
          nativeSessionId: null,
          attachmentPaths: [],
          mode: "advisory",
          permissionPreset: this.permissionPreset,
          signal,
          ephemeral: true,
          emit: () => Promise.resolve(),
        });
        if (this.externalSignal?.aborted) throw abortError();
        return parse(result.finalText);
      } catch (error) {
        if (this.externalSignal?.aborted) throw abortError();
        if (this.profile === "claude-local-long") throw error;
        this.profile = "claude-local-long";
      }
    }
  }
}

export function chunkSummaryText(text: string, limit: number): string[] {
  const parts: string[] = [];
  for (let start = 0; start < text.length; start += limit) parts.push(text.slice(start, start + limit));
  return parts;
}

export function joinedSummaryLength(parts: string[]): number {
  return parts.reduce((total, part) => total + part.length + 8, 0);
}

export function groupSummaryFragments(parts: string[], limit: number): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const part of parts) {
    const added = part.length + 8;
    if (current.length && size + added > limit) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(part);
    size += added;
  }
  if (current.length) groups.push(current);
  return groups;
}

/** Redact before any terminal or conversation content reaches a provider. */
export function redactSummaryText(text: string, workspacePath: string): string {
  const workspacePattern = workspacePath.split(/([\\/]+)/).map((part) =>
    /^[\\/]+$/.test(part) ? "[\\\\/]" : escapeRegExp(part),
  ).join("");
  return redactSecrets(text)
    .replace(new RegExp(workspacePattern, "gi"), "[PATH REDACTED]")
    .replace(/(["'])(?:[A-Za-z]:\\|\\\\)[^"'\r\n<>|?*]+\1/g, "[PATH REDACTED]")
    .replace(/(?:\b[A-Za-z]:\\|\\\\[^\\\r\n]+\\)(?:[^\\\r\n"'<>|?*]+\\)*[^\\\r\n"'<>|?*]+?\.[A-Za-z0-9]{1,10}/g, "[PATH REDACTED]")
    .replace(/(?:\b[A-Za-z]:\\|\\\\[^\\;\r\n]+\\)[^;"'<>|?*\r\n]*?(?=[;,)\]\r\n]|$)/g, "[PATH REDACTED]")
    .replace(/(?:\b[A-Za-z]:\\|\\\\[^\\\s]+\\)[^\s"'<>|?*]+/g, "[PATH REDACTED]")
    .replace(/(^|[\s("'`])\/(?:Users|home|root|mnt|tmp|var|etc)\/[^\s"'`<>]*/gim, "$1[PATH REDACTED]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[ID REDACTED]")
    .replace(/\b(?:session|sess|thread|conversation)[_-][A-Za-z0-9_-]{8,}\b/gi, "[ID REDACTED]");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function abortError(): Error {
  const error = new Error("Summary request was aborted.");
  error.name = "AbortError";
  return error;
}
