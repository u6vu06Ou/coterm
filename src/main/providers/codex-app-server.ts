import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, extname } from "node:path";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import {
  resolveCodexAuthToken,
  resolveCodexBaseUrl,
  resolveCodexProfileSpec,
  type CodexProfileSource,
} from "@shared/codex-profiles";
import { asRecord, numericValue, textValue } from "@shared/value";
import type { ApprovalBroker, UserInputAnswers } from "../core/approval-broker";
import { safeErrorMessage } from "../security/redaction";
import { sanitizedChildEnvironment } from "../security/environment";
import { resolveCliExecutable } from "./executables";
import { DEFAULT_AUTH_TOKEN, DEFAULT_PROXY_URL } from "./profiles-config";
import { ProviderError, type ProviderAdapter, type ProviderEvent, type ProviderRunContext, type ProviderRunResult } from "./types";

interface JsonRpcResponse {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

type CodexProfileId =
  | "codex-official"
  | "codex-local-main"
  | "codex-local-max"
  | "codex-local-long"
  | "codex-local-long2"
  | (string & {});

export interface CodexAppServerSecurityOptions {
  /** Force the app-server thread/turn to a read-only sandbox with approval=never. */
  forceReadOnly?: boolean;
  /** Decline command/file approval callbacks without involving the human broker. */
  denyApprovalRequests?: boolean;
  /** Refuse non-loopback proxy URLs before spawning the app-server. */
  requireLoopbackProxy?: boolean;
}

export function isLoopbackProxyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:"
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname === "::1");
  } catch {
    return false;
  }
}

export function codexRuntimePolicy(
  permissionPreset: ProviderRunContext["permissionPreset"],
  security: CodexAppServerSecurityOptions = {},
): { approvalPolicy: "never" | "on-request"; sandbox: "read-only" | "workspace-write" } {
  return {
    approvalPolicy: security.forceReadOnly || permissionPreset === "trusted" ? "never" : "on-request",
    sandbox: security.forceReadOnly ? "read-only" : "workspace-write",
  };
}

export function codexUserInputResponse(answers: UserInputAnswers): Record<string, unknown> {
  return {
    answers: Object.fromEntries(
      Object.entries(answers).map(([id, values]) => [id, { answers: values }]),
    ),
  };
}

/**
 * Stage 2 (codex half): app-server args are derived from the shared codex
 * spec table (@shared/codex-profiles) — built-in rows are field-verbatim the
 * old hand-written branches (identity pinned by tests). Optional fields are
 * only emitted when the spec carries them, so a custom entry without a
 * contextWindow keeps codex's own default. Unknown/no-spec ids (incl.
 * codex-official) keep the bare official-like args; the old final else was
 * dead code under the closed union and is now this fallback, minus the
 * duplicate glm row that differed only in max_output_tokens (32768 vs
 * MYGLM_CODEX_MAX_OUTPUT_TOKENS — same value).
 */
export function buildCodexAppServerArguments(
  profileId: string,
  proxyUrl: string,
  customProfiles?: Record<string, CodexProfileSource> | null,
  loadConfigProfile: (name: string) => Record<string, unknown> = readCodexConfigProfile,
): string[] {
  const args = ["app-server", "--listen", "stdio://"];
  const spec = resolveCodexProfileSpec(profileId, customProfiles);
  if (!spec) return args;
  if (spec.home === "official") return [...args, ...codexConfigArguments(loadConfigProfile(spec.configProfile!))];
  const baseUrl = `${resolveCodexBaseUrl(profileId, proxyUrl, customProfiles).replace(/\/+$/, "")}/v1`;
  return [
    ...args,
    "-c", `model_provider="${spec.provider}"`,
    ...(spec.model !== undefined ? ["-c", `model="${spec.model}"`] : []),
    ...(spec.contextWindow !== undefined ? ["-c", `model_context_window=${spec.contextWindow}`] : []),
    ...(spec.maxOutputTokens !== undefined ? ["-c", `model_max_output_tokens=${spec.maxOutputTokens}`] : []),
    ...(spec.autoCompactTokenLimit !== undefined ? ["-c", `model_auto_compact_token_limit=${spec.autoCompactTokenLimit}`] : []),
    ...(spec.autoCompactScope !== undefined ? ["-c", `model_auto_compact_token_limit_scope="${spec.autoCompactScope}"`] : []),
    ...(spec.reasoningEffort !== undefined ? ["-c", `model_reasoning_effort="${spec.reasoningEffort}"`] : []),
    ...(spec.providerName !== undefined ? ["-c", `model_providers.${spec.provider}.name="${spec.providerName}"`] : []),
    "-c", `model_providers.${spec.provider}.base_url=${JSON.stringify(baseUrl)}`,
    "-c", `model_providers.${spec.provider}.env_key="${spec.envKey}"`,
    "-c", `model_providers.${spec.provider}.wire_api="responses"`,
  ];
}

function readCodexConfigProfile(name: string): Record<string, unknown> {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) throw new Error("Invalid Codex config profile");
  const path = join(homedir(), ".codex", `${name}.config.toml`);
  try {
    return parseToml(readFileSync(path, "utf8"));
  } catch (error) {
    // A missing profile file makes Codex silently run as plain Codex — fail
    // with the reason instead of a raw ENOENT stack (codex-team gets the
    // dedicated retry hint from the setup module).
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(name === "codex-team"
        ? "Codex Team 設定檔不存在，請重開 Coterm 讓它自動產生"
        : `Codex 設定檔 ~/.codex/${name}.config.toml 不存在，請確認檔案是否存在。`, { cause: error });
    }
    throw error;
  }
}

export function codexConfigArguments(config: Record<string, unknown>, prefix = ""): string[] {
  const args: string[] = [];
  const encode = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(encode).join(", ")}]`;
    if (value && typeof value === "object") return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)} = ${encode(v)}`).join(", ")}}`;
    if (value === null || value === undefined) throw new Error("Unsupported null in Codex profile");
    return JSON.stringify(value);
  };
  for (const [key, value] of Object.entries(config)) {
    const name = prefix ? `${prefix}.${JSON.stringify(key)}` : JSON.stringify(key);
    if (value && typeof value === "object" && !Array.isArray(value)) args.push(...codexConfigArguments(value as Record<string, unknown>, name));
    else args.push("-c", `${name}=${encode(value)}`);
  }
  return args;
}

/**
 * Stage 2 (work item 2): the app-server env consumes the profile's own
 * authToken (explicit env > field > the built-in dev token) instead of the
 * global DEFAULT_AUTH_TOKEN constant, and keys off the spec's env_key.
 */
export function codexAppServerEnvironment(
  profileId: string,
  source: NodeJS.ProcessEnv = process.env,
  customProfiles?: Record<string, CodexProfileSource> | null,
): NodeJS.ProcessEnv {
  if (profileId === "codex-official") return { ...source };
  const spec = resolveCodexProfileSpec(profileId, customProfiles);
  if (spec?.home === "official") return { ...source, CODEX_HOME: join(homedir(), ".codex") };
  if (!spec) {
    // Unregistered codex- id: legacy GLM posture (the old dead else branch).
    return { ...sanitizedChildEnvironment(source), GLM_API_KEY: resolveCodexAuthToken(profileId, null, customProfiles, DEFAULT_AUTH_TOKEN) };
  }
  const token = resolveCodexAuthToken(profileId, spec, customProfiles, DEFAULT_AUTH_TOKEN);
  return { ...sanitizedChildEnvironment(source), [spec.envKey]: token };
}

export function codexCompactionEvent(
  profileId: CodexProfileId,
  threadId: string,
  params: Record<string, unknown>,
  compactedAt = new Date().toISOString(),
): ProviderEvent {
  return {
    type: "warning",
    summary: "Codex compacted the context window.",
    payload: {
      provider: profileId,
      nativeSessionId: threadId,
      compactedAt: textValue(params.compactedAt, compactedAt),
      reason: textValue(params.reason) || null,
      tokenUsageBefore: params.tokenUsageBefore ?? null,
      tokenUsageAfter: params.tokenUsageAfter ?? null,
      summaryAvailable: false,
    },
  };
}

export class CodexAppServer implements ProviderAdapter {
  readonly profiles: readonly CodexProfileId[];
  private child: ChildProcessWithoutNullStreams | null = null;
  private requestId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Set<(message: JsonRpcResponse) => void>();
  private readonly turnWaiters = new Map<string, (error: Error) => void>();
  private initialized = false;
  private starting: Promise<void> | null = null;
  private readonly stderrLines: string[] = [];
  private static readonly STDERR_RING_SIZE = 50;

  constructor(
    private readonly approvals: ApprovalBroker,
    private readonly profileId: CodexProfileId = "codex-official",
    private readonly getProxyUrl: () => string = () => DEFAULT_PROXY_URL,
    private readonly security: CodexAppServerSecurityOptions = {},
    // Hot model registry (stage 2): getter (not snapshot) so each start
    // resolves the custom codex profile entries fresh from the DB.
    private readonly getCustomProfiles: () => Record<string, CodexProfileSource> | null = () => null,
  ) {
    this.profiles = [profileId];
  }

  async run(context: ProviderRunContext): Promise<ProviderRunResult> {
    if (context.signal.aborted) {
      throw new ProviderError("cancelled", "Codex run was cancelled.");
    }
    if (this.security.requireLoopbackProxy) {
      // Fail closed on the EFFECTIVE base URL: a reviewer profile cannot be
      // re-pointed at an external provider via a per-profile baseUrl override.
      const baseUrl = resolveCodexBaseUrl(this.profileId, this.getProxyUrl(), this.getCustomProfiles());
      if (!isLoopbackProxyUrl(baseUrl)) {
        throw new ProviderError("protocol", "Codex reviewer requires an explicit loopback proxy URL.");
      }
    }
    await raceCodexAbort(this.ensureStarted(), context.signal);
    const threadId = await raceCodexAbort(this.ensureThread(context), context.signal);
    await raceCodexAbort(context.emit({
      type: "assistant.progress",
      summary: "Codex session initialized.",
      payload: { sessionId: threadId, sessionOnly: true },
    }), context.signal);
    const { approvalPolicy } = codexRuntimePolicy(context.permissionPreset, this.security);
    let finalText = "";
    let turnId = "";
    let tokenUsage: ProviderRunResult["tokenUsage"];

    const handler = (message: JsonRpcResponse) => {
      const params = message.params ?? {};
      if (params.threadId !== threadId) return;
      if (turnId && params.turnId && params.turnId !== turnId) return;
      void (async () => {
        switch (message.method) {
          case "turn/plan/updated":
            await context.emit({
              type: "plan.updated",
              summary: "Codex updated the plan.",
              payload: { explanation: params.explanation ?? null, plan: params.plan ?? [] },
            });
            break;
          case "thread/tokenUsage/updated": {
            const usage = asRecord(params.tokenUsage);
            const total = asRecord(usage.total);
            tokenUsage = {
              input: numericValue(total.inputTokens),
              output: numericValue(total.outputTokens),
              contextWindow: numericValue(usage.modelContextWindow),
            };
            break;
          }
          case "item/started":
          case "item/completed": {
            const item = asRecord(params.item);
            const completed = message.method === "item/completed";
            const normalized = normalizeCodexItem(item, completed);
            if (normalized) {
              if (normalized.type === "assistant.final") {
                finalText = textValue(normalized.payload?.text, finalText);
              }
              await context.emit(normalized);
            }
            break;
          }
          case "thread/compacted":
            {
              const compacted: ProviderEvent = codexCompactionEvent(this.profileId, threadId, params);
              await context.emit(compacted);
            }
            break;
          case "approval/requested":
            await context.emit({
              type: "approval.requested",
              summary:
                params.approvalKind === "command"
                  ? textValue(params.command, "Codex requests command approval.")
                  : textValue(params.reason, "Codex requests file change approval."),
              payload: params,
            });
            break;
          case "approval/resolved":
            await context.emit({
              type: "approval.resolved",
              summary:
                params.decision === "accept" || params.decision === "acceptForSession"
                  ? "Codex approval granted."
                  : "Codex approval declined.",
              payload: params,
            });
            break;
          case "user_input/requested":
            await context.emit({
              type: "user_input.requested",
              summary: "Codex needs your input.",
              payload: params,
            });
            break;
          case "user_input/resolved":
            await context.emit({
              type: "user_input.resolved",
              summary: "Codex received your input.",
              payload: params,
            });
            break;
          case "warning":
          case "guardianWarning":
          case "configWarning":
            await context.emit({
              type: "warning",
              summary: textValue(params.message, "Codex warning"),
              payload: params,
            });
            break;
          case "error":
            await context.emit({
              type: "error",
              summary: textValue(params.message, "Codex error"),
              payload: params,
            });
            break;
        }
      })();
    };
    this.notificationHandlers.add(handler);

    try {
      const imagePaths = context.attachmentPaths.filter((path) =>
        [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extname(path).toLowerCase()),
      );
      const documentPaths = context.attachmentPaths.filter((path) => !imagePaths.includes(path));
      const prompt = documentPaths.length
        ? `${context.prompt}\n\nLocal attachments available to inspect:\n${documentPaths.map((path) => `- ${path}`).join("\n")}`
        : context.prompt;
      const response = asRecord(
        await raceCodexAbort(this.request("turn/start", {
          threadId,
          input: [
            { type: "text", text: prompt, text_elements: [] },
            ...imagePaths.map((path) => ({ type: "localImage", path })),
          ],
          cwd: context.workspacePath,
          runtimeWorkspaceRoots: [
            ...new Set([context.workspacePath, ...context.attachmentPaths.map(dirname)]),
          ],
          approvalPolicy,
          effort: "medium",
          summary: "concise",
        }), context.signal),
      );
      turnId = textValue(asRecord(response.turn).id);
      await this.waitForTurn(threadId, turnId, context.signal);
    } finally {
      this.notificationHandlers.delete(handler);
    }

    return {
      nativeSessionId: threadId,
      finalText: finalText || "Codex completed without a final text result.",
      ...(tokenUsage ? { tokenUsage } : {}),
    };
  }

  dispose(): Promise<void> {
    this.child?.kill();
    this.child = null;
    this.initialized = false;
    this.starting = null;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new ProviderError("cancelled", "Codex app-server stopped."));
    }
    this.pending.clear();
    return Promise.resolve();
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && this.initialized) return;
    if (this.starting) return this.starting;
    this.starting = this.start();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async start(): Promise<void> {
    this.child = spawn(
      resolveCliExecutable("codex"),
      buildCodexAppServerArguments(this.profileId, this.getProxyUrl(), this.getCustomProfiles()),
      {
        env: codexAppServerEnvironment(this.profileId, process.env, this.getCustomProfiles()),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child.once("exit", () => {
      this.child = null;
      this.initialized = false;
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new ProviderError("protocol", "Codex app-server exited."));
      }
      this.pending.clear();
      // Turn waits resolve via notifications, not pending requests, so reject them
      // here too — otherwise a mid-run crash leaves the run hung in "executing".
      for (const reject of this.turnWaiters.values()) {
        reject(new ProviderError("protocol", "Codex app-server exited."));
      }
      this.turnWaiters.clear();
      this.notificationHandlers.clear();
    });
    this.child.on("error", (error) => {
      this.pushStderr(`child process error: ${safeErrorMessage(error)}`);
      this.child = null;
      this.initialized = false;
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new ProviderError("protocol", "Codex app-server crashed."));
      }
      this.pending.clear();
      for (const reject of this.turnWaiters.values()) {
        reject(new ProviderError("protocol", "Codex app-server crashed."));
      }
      this.turnWaiters.clear();
      this.notificationHandlers.clear();
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      // App-server diagnostics are kept in a ring buffer for error context but
      // never forwarded to the renderer or normal logs.
      this.pushStderr(chunk.toString("utf8"));
    });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    void (async () => {
      for await (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.handleMessage(JSON.parse(line) as JsonRpcResponse);
        } catch {
          // Non-protocol stdout is ignored and never forwarded to the renderer.
        }
      }
    })();
    try {
      await this.request("initialize", {
        clientInfo: { name: "ai-terminal", title: "Coterm", version: "1.0.0" },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: ["item/agentMessage/delta"],
        },
      });
    } catch (error) {
      // initialize failed (timeout, protocol error, etc.) — kill the partially
      // spawned child so the next ensureStarted starts fresh instead of reusing
      // a hung process. Without this, this.child would still point at the hang.
      const tail = this.stderrLines.length
        ? `\nCodex stderr (last ${this.stderrLines.length} lines):\n${this.stderrLines.join("")}`
        : "";
      this.child?.kill();
      this.child = null;
      this.initialized = false;
      throw new ProviderError(
        "protocol",
        `${safeErrorMessage(error)}${tail}`,
      );
    }
    this.notify("initialized");
    this.initialized = true;
  }

  private pushStderr(text: string): void {
    const parts = text.split(/\r?\n/);
    for (const part of parts) {
      if (part.length === 0) continue;
      this.stderrLines.push(part.endsWith("\n") ? part : `${part}\n`);
      while (this.stderrLines.length > CodexAppServer.STDERR_RING_SIZE) {
        this.stderrLines.shift();
      }
    }
  }

  private async ensureThread(context: ProviderRunContext): Promise<string> {
    const { approvalPolicy, sandbox } = codexRuntimePolicy(context.permissionPreset, this.security);
    if (context.nativeSessionId) {
      const response = asRecord(
        await this.request("thread/resume", {
          threadId: context.nativeSessionId,
          cwd: context.workspacePath,
          runtimeWorkspaceRoots: [context.workspacePath],
          approvalPolicy,
          sandbox,
          excludeTurns: true,
        }),
      );
      return String(asRecord(response.thread).id);
    }
    const response = asRecord(
      await this.request("thread/start", {
        cwd: context.workspacePath,
        runtimeWorkspaceRoots: [context.workspacePath],
        approvalPolicy,
        sandbox,
        threadSource: "user",
      }),
    );
    return String(asRecord(response.thread).id);
  }

  private waitForTurn(threadId: string, turnId: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiterKey = `${threadId}:${turnId}`;
      const onAbort = () => {
        void this.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
        cleanup();
        reject(new ProviderError("cancelled", "Codex run was cancelled."));
      };
      const handler = (message: JsonRpcResponse) => {
        if (message.method !== "turn/completed") return;
        const params = message.params ?? {};
        const turn = asRecord(params.turn);
        if (params.threadId !== threadId || turn.id !== turnId) return;
        cleanup();
        const status = textValue(turn.status);
        if (status === "failed") {
          reject(
            classifyCodexError(textValue(asRecord(turn.error).message, "Codex failed.")),
          );
        } else {
          resolve();
        }
      };
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
        this.notificationHandlers.delete(handler);
        this.turnWaiters.delete(waiterKey);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      this.notificationHandlers.add(handler);
      this.turnWaiters.set(waiterKey, reject);
    });
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 60_000,
  ): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new ProviderError("protocol", "Codex app-server is offline."));
    const id = ++this.requestId;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ProviderError(
            "protocol",
            `Codex app-server timed out while handling ${method}.`,
            true,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new ProviderError("protocol", safeErrorMessage(error)));
      }
    }
    return promise;
  }

  private notify(method: string): void {
    this.child?.stdin.write(`${JSON.stringify({ method })}\n`);
  }

  private handleMessage(message: JsonRpcResponse): void {
    if (message.id !== undefined && !message.method) {
      const id = Number(message.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(classifyCodexError(message.error.message ?? "Codex error."));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.id !== undefined && message.method) {
      void this.handleServerRequest(message);
      return;
    }
    for (const handler of this.notificationHandlers) handler(message);
  }

  private async handleServerRequest(message: JsonRpcResponse): Promise<void> {
    const method = message.method ?? "";
    if (method === "item/tool/requestUserInput") {
      if (this.security.denyApprovalRequests) {
        // AgentApi reviews are non-interactive and must fail closed. Reply
        // immediately so the app-server cannot hang, then reject the active
        // turn so the workflow becomes recoverable needs_human/failed.
        this.respond(message.id, codexUserInputResponse({}));
        const error = new ProviderError("protocol", "Codex reviewer requested user input.");
        const params = message.params ?? {};
        const key = `${textValue(params.threadId)}:${textValue(params.turnId)}`;
        let target = this.turnWaiters.get(key);
        let targetKey = key;
        // Older protocol revisions may omit identity. Fail one waiter closed
        // only when it is unambiguous; never kill a concurrent review.
        if (!target && this.turnWaiters.size === 1) {
          const only = this.turnWaiters.entries().next().value as [string, (error: Error) => void] | undefined;
          targetKey = only?.[0] ?? key;
          target = only?.[1];
        }
        target?.(error);
        if (target) this.turnWaiters.delete(targetKey);
        return;
      }
      const { requestId, answers } = this.approvals.requestInput();
      const params = message.params ?? {};
      for (const handler of this.notificationHandlers) {
        handler({ method: "user_input/requested", params: { ...params, requestId } });
      }
      const result = await answers;
      for (const handler of this.notificationHandlers) {
        handler({ method: "user_input/resolved", params: { ...params, requestId } });
      }
      this.respond(message.id, codexUserInputResponse(result ?? {}));
      return;
    }
    if (
      method !== "item/commandExecution/requestApproval" &&
      method !== "item/fileChange/requestApproval"
    ) {
      this.respond(message.id, { decision: "decline" });
      return;
    }
    if (this.security.denyApprovalRequests) {
      const params = message.params ?? {};
      for (const handler of this.notificationHandlers) {
        handler({
          method: "approval/resolved",
          params: {
            ...params,
            approvalKind: method.includes("commandExecution") ? "command" : "fileChange",
            decision: "decline",
          },
        });
      }
      this.respond(message.id, { decision: "decline" });
      return;
    }
    const { requestId, decision } = this.approvals.request();
    const params = message.params ?? {};
    for (const handler of this.notificationHandlers) {
      handler({
        method: "approval/requested",
        params: {
          ...params,
          requestId,
          approvalKind: method.includes("commandExecution") ? "command" : "fileChange",
        },
      });
    }
    const result = await decision;
    for (const handler of this.notificationHandlers) {
      handler({
        method: "approval/resolved",
        params: { ...params, requestId, decision: result },
      });
    }
    this.respond(message.id, { decision: result });
  }

  private respond(id: string | number | undefined, result: unknown): void {
    if (id === undefined) return;
    this.child?.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }
}

function raceCodexAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new ProviderError("cancelled", "Codex run was cancelled."));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new ProviderError("cancelled", "Codex run was cancelled."));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error: unknown) => { cleanup(); reject(error instanceof Error ? error : new Error(String(error))); },
    );
  });
}

function normalizeCodexItem(
  item: Record<string, unknown>,
  completed: boolean,
): {
  type:
    | "assistant.progress"
    | "assistant.final"
    | "reasoning.summary"
    | "plan.updated"
    | "command.started"
    | "command.completed"
    | "file.changed"
    | "tool.started"
    | "tool.completed"
    | "artifact.created";
  summary: string;
  payload: Record<string, unknown>;
} | null {
  switch (item.type) {
    case "agentMessage":
      if (!completed) return null;
      return {
        type: item.phase === "final_answer" && completed ? "assistant.final" : "assistant.progress",
        summary: item.phase === "final_answer" ? "Codex completed." : "Codex update.",
        payload: { text: item.text ?? "", phase: item.phase ?? null },
      };
    case "reasoning":
      if (!completed) return null;
      return {
        type: "reasoning.summary",
        summary: "Codex reasoning summary.",
        payload: { summary: item.summary ?? [], content: item.content ?? [] },
      };
    case "plan":
      if (!completed) return null;
      return { type: "plan.updated", summary: "Codex plan.", payload: { text: item.text ?? "" } };
    case "commandExecution":
      return {
        type: completed ? "command.completed" : "command.started",
        summary: textValue(item.command, "Command"),
        payload: item,
      };
    case "fileChange":
      if (!completed) return null;
      return { type: "file.changed", summary: "Codex changed files.", payload: item };
    case "mcpToolCall":
    case "dynamicToolCall":
      return {
        type: completed ? "tool.completed" : "tool.started",
        summary: textValue(item.tool, "Tool"),
        payload: item,
      };
    case "imageView":
    case "imageGeneration":
      if (!completed) return null;
      return { type: "artifact.created", summary: "Codex image artifact.", payload: item };
    default:
      return null;
  }
}

export function classifyCodexError(message: string): ProviderError {
  const safe = safeErrorMessage(message);
  const lower = safe.toLowerCase();
  if (
    lower.includes("usage limit") ||
    lower.includes("quota") ||
    lower.includes("purchase more credits") ||
    lower.includes("insufficient credits")
  ) {
    return new ProviderError("quota_exceeded", safe);
  }
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("too many requests")) {
    return new ProviderError("rate_limited", safe, true);
  }
  if (
    lower.includes("502") ||
    lower.includes("503") ||
    lower.includes("network") ||
    lower.includes("connect") ||
    lower.includes("timeout")
  ) {
    return new ProviderError("network", safe, true);
  }
  if (lower.includes("auth") || lower.includes("login") || lower.includes("unauthorized")) {
    return new ProviderError("auth_expired", safe);
  }
  return new ProviderError("protocol", safe);
}
