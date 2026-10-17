// Speech-to-text language hints, shared by the chunked dictation path
// (src/main/voice/transcribe.ts) and the plain-Node LiveKit worker pipeline,
// which cannot import anything under src/main.
// Whisper-shaped endpoints want ISO-639-1 codes, not BCP-47 tags.
export const STT_LANG_CODE: Record<string, string> = { "zh-TW": "zh", "zh-CN": "zh", "en-US": "en" };

// pitfall #9 (local-dictate): faster-whisper truncates initial_prompt from the
// FRONT, so a long vocabulary list eats the "answer in Traditional Chinese"
// instruction and the output starts coming back Simplified. Keep this short.
export const STT_PROMPT: Record<string, string> = {
  "zh-TW": "以下是繁體中文的口述內容。",
  "zh-CN": "以下是简体中文的口述内容。",
};
