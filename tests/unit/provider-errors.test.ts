import { describe, expect, it } from "vitest";
import {
  classifyClaudeError,
  combineCapturedOutput,
} from "../../src/main/providers/claude-adapter";
import { classifyCodexError } from "../../src/main/providers/codex-app-server";

describe("provider error classification", () => {
  it("classifies Codex quota, rate-limit, auth, and transient network errors", () => {
    expect(classifyCodexError("You've hit your usage limit").code).toBe("quota_exceeded");
    expect(classifyCodexError("HTTP 429 too many requests")).toMatchObject({
      code: "rate_limited",
      retryable: true,
    });
    expect(classifyCodexError("HTTP 503 service unavailable")).toMatchObject({
      code: "network",
      retryable: true,
    });
    expect(classifyCodexError("Login required").code).toBe("auth_expired");
  });

  it("classifies Claude proxy 429/502/503 failures as retryable", () => {
    expect(classifyClaudeError("429 rate limit")).toMatchObject({
      code: "rate_limited",
      retryable: true,
    });
    expect(classifyClaudeError("502 bad gateway")).toMatchObject({
      code: "network",
      retryable: true,
    });
    expect(classifyClaudeError("503 unavailable")).toMatchObject({
      code: "network",
      retryable: true,
    });
  });

  it("classifies a raw Claude HTTP 401 as expired authentication", () => {
    expect(classifyClaudeError("HTTP 401 from provider").code).toBe("auth_expired");
    expect(classifyClaudeError("HTTP 401: authentication credential not found").code)
      .toBe("auth_expired");
    expect(classifyClaudeError("provider code 1401").code).toBe("unknown");
  });

  it("combines short captured stderr without duplicating overlapping text", () => {
    expect(combineCapturedOutput("auth failed", "auth failed", 11)).toBe("auth failed");
  });
});
