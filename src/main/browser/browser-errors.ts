import type { BrowserActionErrorCode } from "@shared/browser-types";

export class BrowserServiceError extends Error {
  readonly code: BrowserActionErrorCode;
  constructor(code: BrowserActionErrorCode, message: string) {
    super(message);
    this.name = "BrowserServiceError";
    this.code = code;
  }
}

export function browserErrorCode(error: unknown): BrowserActionErrorCode {
  if (error instanceof BrowserServiceError) return error.code;
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  // Navigating straight at a download (Content-Disposition: attachment) aborts
  // the goto with this message — report the real cause, not a generic crash.
  if (message.includes("download is starting")) return "download_blocked";
  if (message.includes("timeout")) return "navigation_timeout";
  if (message.includes("not visible")) return "not_visible";
  if (message.includes("not enabled")) return "not_enabled";
  if (message.includes("detached")) return "detached";
  return "browser_crashed";
}
