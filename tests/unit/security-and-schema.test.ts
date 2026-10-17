import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  appSettingsSchema,
  councilInputSchema,
  artifactWriteInputSchema,
  artifactPreviewSchema,
  attachmentSaveInputSchema,
  messageInputSchema,
  terminalCommandInputSchema,
  workspaceListInputSchema,
} from "@shared/schema";
import { textValue } from "@shared/value";
import { assertAllowedPath } from "../../src/main/security/path-policy";
import { redactEgressValue, redactSecrets, safeErrorMessage } from "../../src/main/security/redaction";
import { sanitizedChildEnvironment } from "../../src/main/security/environment";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("security and shared schemas", () => {
  it("redacts common credentials from logs and errors", () => {
    const source =
      "sk-1234567890abcdefghijkl ghp_1234567890abcdefghijkl Bearer abcdefghijklmnop";
    const redacted = redactSecrets(source);

    expect(redacted).not.toContain("1234567890abcdefghijkl");
    expect(redacted.match(/\[REDACTED\]/g)).toHaveLength(3);
    expect(safeErrorMessage(new Error("auth_token=super-secret-value"))).toContain("[REDACTED]");
    expect(
      safeErrorMessage(new Error("ANTHROPIC_AUTH_TOKEN=super-secret-value")),
    ).not.toContain("super-secret-value");
    expect(
      safeErrorMessage(new Error("MY_CUSTOM_API_KEY=another-secret-value")),
    ).not.toContain("another-secret-value");
    // Stage 2: per-profile credentials also arrive camelCase / JSON-encoded
    // ("authToken":"…"); the UPPER-only generic pass must not miss them.
    expect(
      safeErrorMessage(new Error('profile {"authToken":"opaque-token-Zx91QvLm7g2k"} rejected')),
    ).not.toContain("opaque-token-Zx91QvLm7g2k");
    expect(
      redactSecrets("authToken=orange-token-AA11BB22"),
    ).toContain("[REDACTED]");
    expect(redactSecrets("my-file-name_status=healthy")).toBe("my-file-name_status=healthy");
    expect(redactSecrets("FOO=ordinary-private-value SHORT='x' $env:QUOTED=\"tiny\""))
      .toBe("FOO=[REDACTED] SHORT=[REDACTED] $env:QUOTED=[REDACTED]");
    expect(redactEgressValue({ value: "FOO=ordinary-private-value", intact: "JSON syntax" }))
      .toEqual({ value: "FOO=[REDACTED]", intact: "JSON syntax" });
  });

  it("accepts supported attachments and locked-down settings", () => {
    expect(
      attachmentSaveInputSchema.parse({
        conversationId: "8ec86d2c-b761-4470-a138-9dc070fc6204",
        name: "畫面.png",
        mimeType: "image/png",
        dataBase64: "AA==",
      }).mimeType,
    ).toBe("image/png");
    expect(() =>
      attachmentSaveInputSchema.parse({
        conversationId: "8ec86d2c-b761-4470-a138-9dc070fc6204",
        name: "payload.svg",
        mimeType: "image/svg+xml",
        dataBase64: "PHN2Zz4=",
      }),
    ).toThrow();
    expect(appSettingsSchema.parse({}).telemetry).toBe(false);
    expect(appSettingsSchema.parse({}).codeTheme).toBe("auto");
    expect(appSettingsSchema.parse({}).terminalTheme).toBe("auto");
    expect(appSettingsSchema.parse({}).claudeKeepaliveHours).toBe(2);
    expect(workspaceListInputSchema.parse({
      projectId: "8ec86d2c-b761-4470-a138-9dc070fc6204",
    }).path).toBeNull();
    for (const command of ["status", "session", "compact-status"] as const) {
      expect(terminalCommandInputSchema.parse({
        conversationId: "8ec86d2c-b761-4470-a138-9dc070fc6204",
        command,
      }).command).toBe(command);
    }
    expect(() => terminalCommandInputSchema.parse({
      conversationId: "8ec86d2c-b761-4470-a138-9dc070fc6204",
      command: "shell",
    })).toThrow();
    expect(attachmentSaveInputSchema.parse({
      conversationId: "8ec86d2c-b761-4470-a138-9dc070fc6204",
      name: "notes.md",
      mimeType: "text/markdown",
      dataBase64: "Iw==",
    }).mimeType).toBe("text/markdown");
    expect(attachmentSaveInputSchema.parse({
      conversationId: "8ec86d2c-b761-4470-a138-9dc070fc6204",
      name: "rows.csv",
      mimeType: "text/csv",
      dataBase64: "bmFtZSx2YWx1ZQ==",
    }).mimeType).toBe("text/csv");
    expect(messageInputSchema.parse({
      conversationId: "8ec86d2c-b761-4470-a138-9dc070fc6204",
      profileId: "claude-local-main",
      text: "ultracode investigate",
      attachmentIds: [],
      nativeWorkflow: true,
    }).nativeWorkflow).toBe(true);
    expect(councilInputSchema.parse({
      conversationId: "8ec86d2c-b761-4470-a138-9dc070fc6204",
      question: "review",
      chairman: "glm",
    }).chairman).toBe("glm");
    expect(artifactWriteInputSchema.parse({
      projectId: "8ec86d2c-b761-4470-a138-9dc070fc6204",
      path: "D:\\work\\README.md",
      text: "# Coterm",
    }).text).toBe("# Coterm");
    expect(() => appSettingsSchema.parse({ telemetry: true })).toThrow();
  });

  it("validates artifact previews crossing the preload boundary", () => {
    expect(artifactPreviewSchema.parse({
      kind: "code",
      mimeType: "text/typescript",
      path: "D:\\work\\app.ts",
      size: 12,
      text: "const ok = true;",
      language: "typescript",
    }).kind).toBe("code");
    expect(() => artifactPreviewSchema.parse({ kind: "executable", path: "app.exe" })).toThrow();
  });

  it("keeps unknown structured values out of display strings", () => {
    expect(textValue("繁體中文")).toBe("繁體中文");
    expect(textValue(42)).toBe("42");
    expect(textValue({ secret: "value" }, "fallback")).toBe("fallback");
  });

  it("does not forward credential-shaped environment variables to child processes", () => {
    expect(
      sanitizedChildEnvironment({
        PATH: "C:\\Windows",
        SESSIONNAME: "Console",
        GITHUB_TOKEN: "secret",
        OPENAI_API_KEY: "secret",
        ANTHROPIC_AUTH_TOKEN: "secret",
      }),
    ).toEqual({
      PATH: "C:\\Windows",
      SESSIONNAME: "Console",
    });
  });

  it("allows paths inside a workspace and rejects traversal outside it", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-terminal-path-"));
    tempPaths.push(root);
    const child = join(root, "project", "src");
    await mkdir(child, { recursive: true });

    await expect(assertAllowedPath(child, { roots: [root] })).resolves.toBe(await realpath(child));
    await expect(assertAllowedPath(tmpdir(), { roots: [child] })).rejects.toThrow(
      "outside the allowed workspace",
    );
  });
});
