import type {
  AppSettings,
  Conversation,
  EventType,
  ProviderProfileId,
} from "@shared/schema";

export type ProviderErrorCode =
  | "auth_expired"
  | "rate_limited"
  | "quota_exceeded"
  | "network"
  | "not_installed"
  | "protocol"
  | "cancelled"
  | "unknown";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface ProviderEvent {
  type: EventType;
  summary: string;
  payload?: Record<string, unknown>;
}

export interface ProviderRunContext {
  profileId: ProviderProfileId;
  claudeModel?: Conversation["claudeModel"];
  workspacePath: string;
  prompt: string;
  nativeSessionId: string | null;
  attachmentPaths: string[];
  mode: "agent" | "advisory";
  permissionPreset: AppSettings["permissionPreset"];
  signal: AbortSignal;
  ephemeral?: boolean;
  nativeWorkflow?: boolean;
  emit(event: ProviderEvent): Promise<void>;
}

export interface ProviderRunResult {
  nativeSessionId: string | null;
  finalText: string;
  tokenUsage?: {
    input: number;
    output: number;
    contextWindow?: number;
  };
}

export interface ProviderAdapter {
  readonly profiles: readonly ProviderProfileId[];
  run(context: ProviderRunContext): Promise<ProviderRunResult>;
  interrupt?(nativeSessionId: string | null): Promise<void>;
  dispose?(): Promise<void>;
}
