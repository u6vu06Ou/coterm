/**
 * Environment variable contract between the main process and the plain-Node
 * voice worker fork (per-process env only — work order red line forbids
 * setx/global env). Values include the LiveKit api key/secret; they are never
 * logged on either side.
 */
export const LIVEKIT_WORKER_ENV = {
  url: "COTERM_LIVEKIT_URL",
  apiKey: "COTERM_LIVEKIT_API_KEY",
  apiSecret: "COTERM_LIVEKIT_API_SECRET",
  room: "COTERM_LIVEKIT_ROOM",
  voiceSessionId: "COTERM_LIVEKIT_VOICE_SESSION_ID",
  sttUrl: "COTERM_LIVEKIT_STT_URL",
  sttModel: "COTERM_LIVEKIT_STT_MODEL",
  sttApiKey: "COTERM_LIVEKIT_STT_API_KEY",
  ttsVoice: "COTERM_LIVEKIT_TTS_VOICE",
  provider: "COTERM_LIVEKIT_PROVIDER",
  geminiApiKey: "COTERM_LIVEKIT_GEMINI_API_KEY",
  geminiModel: "COTERM_LIVEKIT_GEMINI_MODEL",
  geminiLanguage: "COTERM_LIVEKIT_GEMINI_LANGUAGE",
} as const;
