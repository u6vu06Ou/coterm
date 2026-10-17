import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { query, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { asRecord, numericValue, textValue } from "@shared/value";
import { createId } from "../core/ids";
import type { UserInputAnswers } from "../core/approval-broker";
import type { ApprovalBroker } from "../core/approval-broker";
import { safeErrorMessage } from "../security/redaction";
import { sanitizedChildEnvironment } from "../security/environment";
import { resolveCliExecutable } from "./executables";
import {
  DEFAULT_AUTH_TOKEN,
  DEFAULT_PROFILES,
  DEFAULT_PROXY_URL,
  type ClaudeProfile,
} from "./profiles-config";
import { ProviderError, type ProviderAdapter, type ProviderRunContext, type ProviderRunResult } from "./types";

export type { ClaudeProfile } from "./profiles-config";

type ClaudeProfileId =
  | "claude-official"
  | "claude-local-long"
  | "claude-local-freeform"
  | "claude-local-main"
  | "claude-local-long2";

interface ClaudeJsonRecord {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: Record<string, unknown>;
  task_id?: string;
  tool_use_id?: string;
  description?: string;
  subagent_type?: string;
  task_type?: string;
  prompt?: string;
  status?: string;
  summary?: string;
  patch?: Record<string, unknown>;
  message?: {
    content?: Array<Record<string, unknown>>;
  };
  tool_use_result?: Record<string, unknown>;
  event?: {
    type?: string;
    delta?: Record<string, unknown>;
  };
  workflow_progress?: Array<Record<string, unknown>>;
}

interface ClaudeTool {
  name: string;
  input: Record<string, unknown>;
}

export class ClaudeAdapter implements ProviderAdapter {
  private readonly running = new Map<string, ChildProcessWithoutNullStreams>();
  /**
   * Hot model registry (stage 1): the profile table can be supplied as a
   * getter (DEFAULT_PROFILES ⊕ settings.customProfiles) so runs resolve the
   * ACTIVE table at call time instead of caching a snapshot in this closure.
   */
  private readonly resolveProfileTable: () => Record<string, ClaudeProfile>;

  constructor(
    private readonly getProxyUrl: () => string = () => DEFAULT_PROXY_URL,
    private readonly approvals?: ApprovalBroker,
    profileTable: Record<string, ClaudeProfile> | (() => Record<string, ClaudeProfile>) = DEFAULT_PROFILES,
  ) {
    this.resolveProfileTable = typeof profileTable === "function" ? profileTable : () => profileTable;
  }

  get profiles(): readonly ClaudeProfileId[] {
    return Object.keys(this.resolveProfileTable()) as ClaudeProfileId[];
  }

  async run(context: ProviderRunContext): Promise<ProviderRunResult> {
    if (context.signal.aborted) {
      throw new ProviderError("cancelled", "Claude run was cancelled.");
    }
    if (!(context.profileId in this.resolveProfileTable())) {
      throw new ProviderError("protocol", `Unsupported Claude profile: ${context.profileId}`);
    }
    return this.runProfile(context.profileId as ClaudeProfileId, context);
  }

  dispose(): Promise<void> {
    for (const child of this.running.values()) {
      child.kill();
    }
    this.running.clear();
    return Promise.resolve();
  }

  private async runProfile(
    profileId: ClaudeProfileId,
    context: ProviderRunContext,
  ): Promise<ProviderRunResult> {
    if (profileId === "claude-official" && context.mode === "agent" && this.approvals) {
      return this.runOfficialProfile(context);
    }
    const profile = this.resolveProfileTable()[profileId]!;
    const sessionId = context.nativeSessionId ?? createId();
    const selectedModel = profileId === "claude-official"
      ? context.claudeModel === "default" ? undefined : context.claudeModel
      : profile.model;
    const args = buildClaudeArguments(context, selectedModel, sessionId);

    const env: NodeJS.ProcessEnv = sanitizedChildEnvironment();
    for (const [key, value] of Object.entries(profile.env)) {
      if (value === undefined) {
        delete env[key];
      } else {
        env[key] = value;
      }
    }
    // Stage 2: same precedence as buildProfileEnv — explicit profile.env values
    // (undefined = strip, applied in the loop above) > profile.baseUrl/authToken
    // fields > the adapter's global proxy URL / the built-in dev token. The
    // token used to ride in via localBaseEnv; it is injected here now.
    if (profile.local) {
      if (!("ANTHROPIC_BASE_URL" in profile.env)) {
        env.ANTHROPIC_BASE_URL = profile.baseUrl ?? this.getProxyUrl();
      }
      if (!("ANTHROPIC_AUTH_TOKEN" in profile.env)) {
        env.ANTHROPIC_AUTH_TOKEN = profile.authToken ?? DEFAULT_AUTH_TOKEN;
      }
    }
    env.PYTHONIOENCODING = "utf-8";

    const child = spawn(resolveCliExecutable("claude"), args, {
      cwd: context.workspacePath,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const runId = createId();
    this.running.set(runId, child);

    const abort = () => child.kill();
    context.signal.addEventListener("abort", abort, { once: true });

    let finalText = "";
    let actualSessionId: string | null = context.ephemeral ? null : sessionId;
    let stderrHead = "";
    let stderrTail = "";
    let stderrLength = 0;
    let tokenUsage: ProviderRunResult["tokenUsage"];
    const tools = new Map<string, ClaudeTool>();

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderrLength += text.length;
      if (stderrHead.length < 4_000) {
        stderrHead = `${stderrHead}${text}`.slice(0, 4_000);
      }
      stderrTail = `${stderrTail}${text}`.slice(-28_000);
    });

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const lineTask = (async () => {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let record: ClaudeJsonRecord;
        try {
          record = JSON.parse(line) as ClaudeJsonRecord;
        } catch {
          await context.emit({
            type: "assistant.progress",
            summary: "Claude emitted non-JSON output.",
            payload: { text: line.slice(0, 2_000) },
          });
          continue;
        }

        if (record.session_id && !context.ephemeral) actualSessionId = record.session_id;
        await normalizeClaudeRecord(record, context, tools);

        if (record.type === "result") {
          finalText = record.result ?? finalText;
          const usage = record.usage ?? {};
          tokenUsage = {
            input: numericValue(usage.input_tokens),
            output: numericValue(usage.output_tokens),
          };
        }
      }
    })();

    child.stdin.end(buildPrompt(context));
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    }).catch((error: unknown) => {
      throw new ProviderError("not_installed", safeErrorMessage(error));
    });

    try {
      await lineTask;
    } finally {
      context.signal.removeEventListener("abort", abort);
      this.running.delete(runId);
    }

    if (context.signal.aborted) {
      throw new ProviderError("cancelled", "Claude run was cancelled.");
    }
    if (exitCode !== 0) {
      const stderr = combineCapturedOutput(stderrHead, stderrTail, stderrLength);
      throw classifyClaudeError(stderr || `Claude exited with code ${exitCode}.`);
    }
    if (!finalText) {
      finalText = "Claude completed without a final text result.";
    }
    return {
      nativeSessionId: context.ephemeral ? null : actualSessionId,
      finalText,
      ...(tokenUsage ? { tokenUsage } : {}),
    };
  }

  private async runOfficialProfile(context: ProviderRunContext): Promise<ProviderRunResult> {
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    context.signal.addEventListener("abort", abort, { once: true });
    let finalText = "";
    let actualSessionId: string | null = context.ephemeral ? null : context.nativeSessionId;
    let tokenUsage: ProviderRunResult["tokenUsage"];
    const tools = new Map<string, ClaudeTool>();
    const canUseTool: CanUseTool = async (toolName, input, options) => {
      if (context.signal.aborted) {
        return { behavior: "deny", message: "cancelled" };
      }
      if (toolName === "AskUserQuestion") {
        const { requestId, answers } = this.approvals!.requestInput();
        await context.emit({
          type: "user_input.requested",
          summary: "Claude needs your input.",
          payload: { requestId, questions: claudeQuestions(input) },
        });
        const result = await awaitApproval(answers, context.signal);
        await context.emit({
          type: "user_input.resolved",
          summary: result ? "Claude received your input." : "Claude input request was cancelled.",
          payload: { requestId },
        });
        return result
          ? { behavior: "allow", updatedInput: claudeQuestionResult(input, result) }
          : { behavior: "deny", message: "cancelled" };
      }
      const { requestId, decision } = this.approvals!.request();
      await context.emit({
        type: "approval.requested",
        summary: options.title ?? `Claude wants to use ${toolName}.`,
        payload: { requestId, name: toolName, input, toolUseId: options.toolUseID },
      });
      const result = await awaitApproval(decision, context.signal);
      await context.emit({
        type: "approval.resolved",
        summary: result === "accept" || result === "acceptForSession"
          ? "Claude approval granted."
          : "Claude approval declined.",
        payload: { requestId, decision: result ?? "cancel" },
      });
      if (result === "accept" || result === "acceptForSession") {
        return {
          behavior: "allow",
          updatedInput: input,
          ...(result === "acceptForSession" && options.suggestions
            ? { updatedPermissions: options.suggestions }
            : {}),
        };
      }
      if (result === null) {
        return { behavior: "deny", message: "cancelled" };
      }
      return { behavior: "deny", message: "The user declined this tool request." };
    };

    try {
      const stream = query({
        prompt: buildPrompt(context),
        options: {
          abortController,
          canUseTool,
          cwd: context.workspacePath,
          env: sanitizedChildEnvironment(),
          includePartialMessages: true,
          ...(context.claudeModel === "default" ? {} : { model: context.claudeModel }),
          pathToClaudeCodeExecutable: resolveCliExecutable("claude"),
          permissionMode: context.permissionPreset === "trusted" ? "acceptEdits" : "default",
          ...(context.nativeSessionId
            ? { resume: context.nativeSessionId }
            : { sessionId: createId() }),
          ...(context.nativeWorkflow ? { allowedTools: ["Workflow"] } : {}),
        },
      });
      for await (const message of stream) {
        const record = message as ClaudeJsonRecord;
        if (record.session_id && !context.ephemeral) actualSessionId = record.session_id;
        await normalizeClaudeRecord(record, context, tools);
        if (record.type === "result") {
          finalText = record.result ?? finalText;
          const usage = record.usage ?? {};
          tokenUsage = {
            input: numericValue(usage.input_tokens),
            output: numericValue(usage.output_tokens),
          };
        }
      }
    } catch (error) {
      if (context.signal.aborted) throw new ProviderError("cancelled", "Claude run was cancelled.");
      throw classifyClaudeError(safeErrorMessage(error));
    } finally {
      context.signal.removeEventListener("abort", abort);
    }
    return {
      nativeSessionId: context.ephemeral ? null : actualSessionId,
      finalText: finalText || "Claude completed without a final text result.",
      ...(tokenUsage ? { tokenUsage } : {}),
    };
  }
}

function claudeQuestions(input: Record<string, unknown>): Array<Record<string, unknown>> {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  return questions.map((value) => {
    const question = asRecord(value);
    const text = textValue(question.question);
    return { ...question, id: text, isOther: true, isSecret: false };
  });
}

export function claudeQuestionResult(
  input: Record<string, unknown>,
  answers: UserInputAnswers,
): Record<string, unknown> {
  return {
    ...input,
    answers: Object.fromEntries(
      Object.entries(answers).map(([question, values]) => [question, values.join(", ")]),
    ),
  };
}

export function buildClaudeArguments(
  context: ProviderRunContext,
  model: string | undefined,
  sessionId: string,
): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    context.mode === "advisory"
      ? "dontAsk"
      : context.permissionPreset === "trusted"
        ? "acceptEdits"
        : "default",
  ];
  if (context.mode === "advisory") {
    args.push(
      "--safe-mode",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--disable-slash-commands",
      "--tools",
      "",
      "--system-prompt",
      "Answer only the user's supplied question. Do not inspect the workspace, call tools, invoke skills, or infer a different task from local files. Follow the requested output format precisely.",
    );
  }
  if (context.nativeWorkflow && context.mode === "agent") {
    args.push("--allowedTools", "Workflow");
  }
  if (context.ephemeral) {
    args.push("--no-session-persistence");
  } else if (context.nativeSessionId) {
    args.push("--resume", context.nativeSessionId);
  } else {
    args.push("--session-id", sessionId);
  }
  if (model) {
    args.push("--model", model);
  }
  return args;
}

export async function normalizeClaudeRecord(
  record: ClaudeJsonRecord,
  context: ProviderRunContext,
  tools: Map<string, ClaudeTool>,
): Promise<void> {
  if (record.type === "result" && record.is_error) {
    throw classifyClaudeError(record.result ?? "Claude run failed.");
  }
  if (record.type === "system" && record.subtype === "task_started") {
    await context.emit({
      type: "agent.started",
      summary: record.description ?? "Claude subagent started.",
      payload: {
        taskId: record.task_id ?? record.tool_use_id ?? null,
        toolUseId: record.tool_use_id ?? null,
        description: record.description ?? "Claude subagent",
        subagentType: record.subagent_type ?? null,
        taskType: record.task_type ?? null,
        prompt: record.prompt ?? null,
        status: "running",
      },
    });
    return;
  }
  if (record.type === "system" && record.subtype === "task_progress") {
    for (const progress of record.workflow_progress ?? []) {
      if (progress.type !== "workflow_agent" || !textValue(progress.agentId)) continue;
      const state = textValue(progress.state, "running");
      const phase = textValue(progress.phaseTitle);
      const label = textValue(progress.label, "Workflow agent");
      await context.emit({
        type: state === "done" || state === "completed" ? "agent.completed" : "agent.updated",
        summary: phase ? `${phase}: ${label}` : label,
        payload: {
          taskId: textValue(progress.agentId, record.task_id ?? "workflow-agent"),
          status: state === "done" ? "completed" : state,
          description: phase ? `${phase}: ${label}` : label,
          totalTokens: numericValue(progress.tokens),
          toolUses: numericValue(progress.toolCalls),
          durationMs: numericValue(progress.durationMs),
        },
      });
    }
    return;
  }
  if (record.type === "system" && record.subtype === "task_updated") {
    await context.emit({
      type: "agent.updated",
      summary: `Claude subagent ${textValue(record.patch?.status, record.status ?? "updated")}.`,
      payload: {
        taskId: record.task_id ?? null,
        status: textValue(record.patch?.status, record.status ?? "updated"),
        endTime: record.patch?.end_time ?? null,
      },
    });
    return;
  }
  if (record.type === "system" && record.subtype === "task_notification") {
    const usage = record.usage ?? {};
    await context.emit({
      type: "agent.completed",
      summary: record.summary ?? "Claude subagent completed.",
      payload: {
        taskId: record.task_id ?? record.tool_use_id ?? null,
        toolUseId: record.tool_use_id ?? null,
        status: record.status ?? "completed",
        summary: record.summary ?? null,
        totalTokens: numericValue(usage.total_tokens),
        toolUses: numericValue(usage.tool_uses),
        durationMs: numericValue(usage.duration_ms),
      },
    });
    return;
  }
  if (record.type === "system" && record.subtype === "init") {
    await context.emit({
      type: "assistant.progress",
      summary: "Claude session initialized.",
      payload: { sessionId: record.session_id ?? null },
    });
    return;
  }
  if (record.type === "stream_event") {
    const delta = record.event?.delta;
    if (record.event?.type === "content_block_delta" && delta?.type === "text_delta") {
      await context.emit({
        type: "assistant.progress",
        summary: "Claude is responding.",
        payload: { delta: textValue(delta.text) },
      });
    }
    return;
  }
  if (record.type === "assistant") {
    const text = (record.message?.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => textValue(block.text))
      .filter(Boolean)
      .join("\n");
    if (text) {
      await context.emit({
        type: "assistant.progress",
        summary: "Claude update.",
        payload: { text },
      });
    }
    for (const block of record.message?.content ?? []) {
      if (block.type !== "tool_use") continue;
      const toolUseId = textValue(block.id);
      const tool: ClaudeTool = {
        name: textValue(block.name, "Claude tool"),
        input: asRecord(block.input),
      };
      if (toolUseId) tools.set(toolUseId, tool);
      const command = textValue(tool.input.command, tool.name);
      await context.emit({
        type: tool.name === "Bash" ? "command.started" : "tool.started",
        summary: tool.name === "Bash" ? command : tool.name,
        payload: { toolUseId: toolUseId || null, name: tool.name, input: tool.input },
      });
    }
    return;
  }
  if (record.type === "user") {
    for (const block of record.message?.content ?? []) {
      if (block.type !== "tool_result") continue;
      const toolUseId = textValue(block.tool_use_id);
      const tool = tools.get(toolUseId) ?? { name: "Claude tool", input: {} };
      const result = asRecord(record.tool_use_result);
      const isError = block.is_error === true;
      if (tool.name === "Bash") {
        const output = truncateOutput(
          [textValue(result.stdout), textValue(result.stderr)]
            .filter(Boolean)
            .join("\n"),
        );
        if (output) {
          await context.emit({
            type: "command.output",
            summary: "Claude command output.",
            payload: { toolUseId, output },
          });
        }
        await context.emit({
          type: "command.completed",
          summary: textValue(tool.input.command, "Claude command"),
          payload: { toolUseId, isError },
        });
      } else {
        if (["Write", "Edit", "NotebookEdit"].includes(tool.name)) {
          await context.emit({
            type: "file.changed",
            summary: `${tool.name} changed a file.`,
            payload: {
              toolUseId,
              path:
                textValue(result.filePath) ||
                textValue(tool.input.file_path) ||
                textValue(tool.input.notebook_path) ||
                null,
            },
          });
        }
        await context.emit({
          type: "tool.completed",
          summary: `${tool.name} ${isError ? "failed" : "completed"}.`,
          payload: {
            toolUseId,
            name: tool.name,
            isError,
            result: truncateOutput(textValue(block.content)),
          },
        });
      }
      tools.delete(toolUseId);
    }
    return;
  }
  if (record.type === "result") {
    await context.emit({
      type: record.is_error ? "error" : "assistant.final",
      summary: record.is_error ? "Claude run failed." : "Claude completed.",
      payload: {
        text: record.result ?? "",
        usage: record.usage ?? {},
        totalCostUsd: record.total_cost_usd ?? null,
      },
    });
  }
}

function buildPrompt(context: ProviderRunContext): string {
  const attachmentSection =
    context.attachmentPaths.length === 0
      ? ""
      : `\n\nLocal attachments available to inspect:\n${context.attachmentPaths
          .map((path) => `- ${path}`)
          .join("\n")}`;
  return `${context.prompt}${attachmentSection}`;
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ProviderError("cancelled", "Claude run was cancelled."));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new ProviderError("cancelled", "Claude run was cancelled."));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(new Error(typeof error === "string" ? error : String(error)));
      },
    );
  });
}

async function awaitApproval<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T | null> {
  try {
    return await raceWithAbort(promise, signal);
  } catch (error) {
    if (error instanceof ProviderError && error.code === "cancelled") return null;
    throw error;
  }
}

function truncateOutput(value: string, limit = 20_000): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n[output truncated]`;
}

export function combineCapturedOutput(head: string, tail: string, totalLength: number): string {
  const overlap = Math.max(0, head.length + tail.length - totalLength);
  return `${head}${tail.slice(overlap)}`.slice(0, 32_000);
}

export function classifyClaudeError(message: string): ProviderError {
  const lower = message.toLowerCase();
  if (/\b401\b/.test(lower)) {
    return new ProviderError("auth_expired", safeErrorMessage(message));
  }
  if (lower.includes("not recognized") || lower.includes("not found")) {
    return new ProviderError("not_installed", "Claude Code is not installed.");
  }
  if (
    lower.includes("auth") ||
    lower.includes("login") ||
    lower.includes("unauthorized")
  ) {
    return new ProviderError("auth_expired", safeErrorMessage(message));
  }
  if (lower.includes("429") || lower.includes("rate limit")) {
    return new ProviderError("rate_limited", safeErrorMessage(message), true);
  }
  if (lower.includes("quota")) {
    return new ProviderError("quota_exceeded", safeErrorMessage(message));
  }
  if (
    lower.includes("502") ||
    lower.includes("503") ||
    lower.includes("connect") ||
    lower.includes("network") ||
    lower.includes("timeout")
  ) {
    return new ProviderError("network", safeErrorMessage(message), true);
  }
  return new ProviderError("unknown", safeErrorMessage(message));
}
