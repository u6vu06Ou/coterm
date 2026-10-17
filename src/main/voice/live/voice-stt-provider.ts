import type { AppSettings } from "@shared/types";
import { transcribeVoice, type VoiceTranscriptionResult } from "../transcribe";

export type VoiceSttProviderId = "existing-cloud" | "local-transcribe-cpp";

export interface VoiceSttProviderRequest {
  audio: ArrayBuffer;
  mimeType: string;
  language: string;
  settings: AppSettings["voice"];
}

export interface VoiceSttProvider {
  readonly id: VoiceSttProviderId;
  isAvailable(request: VoiceSttProviderRequest): boolean;
  transcribe(request: VoiceSttProviderRequest): Promise<VoiceTranscriptionResult>;
}

/** Existing OpenAI-shaped STT endpoint, wrapped behind the Live Voice seam. */
export class ExistingCloudVoiceSttProvider implements VoiceSttProvider {
  readonly id = "existing-cloud" as const;

  isAvailable(request: VoiceSttProviderRequest): boolean {
    return request.settings.sttUrl.trim().length > 0;
  }

  transcribe(request: VoiceSttProviderRequest): Promise<VoiceTranscriptionResult> {
    return transcribeVoice({
      audio: request.audio,
      mimeType: request.mimeType,
      lang: request.language,
      serverUrl: request.settings.sttUrl,
      model: request.settings.sttModel,
      apiKey: request.settings.sttApiKey || undefined,
    });
  }
}

/**
 * Provider registry used by Live Voice only. Fallback is availability-based,
 * not error-based: a transient local failure must never silently exfiltrate
 * microphone audio to a cloud provider the user did not select.
 */
export class VoiceSttProviderRegistry {
  constructor(private readonly providers: readonly VoiceSttProvider[]) {}

  resolve(request: VoiceSttProviderRequest, preferred: VoiceSttProviderId = "existing-cloud"): VoiceSttProvider {
    const preferredProvider = this.providers.find((provider) => provider.id === preferred);
    if (preferredProvider?.isAvailable(request)) return preferredProvider;
    const fallback = this.providers.find((provider) => provider.isAvailable(request));
    if (fallback) return fallback;
    throw new Error("No Live Voice STT provider is available.");
  }

  transcribe(
    request: VoiceSttProviderRequest,
    preferred: VoiceSttProviderId = "existing-cloud",
  ): Promise<VoiceTranscriptionResult> {
    return this.resolve(request, preferred).transcribe(request);
  }
}

export const defaultVoiceSttProviders = new VoiceSttProviderRegistry([
  new ExistingCloudVoiceSttProvider(),
]);
