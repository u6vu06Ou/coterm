// Phase 6 (§11.2): free OS/Browser TTS layer.
//
// Hard rules from the work order:
//   - browser/Electron speechSynthesis or OS-installed voices ONLY (no paid
//     TTS service can ever appear here)
//   - (任務中心 agentapi.tts* 設定已移除 — 相關設定不復存在，固定用預設值)
//   - long answers are spoken as SENTENCE CHUNKS — the first sentence starts
//     immediately instead of waiting for the whole reply
//   - no usable voice → clean text fallback (the panel keeps showing text;
//     TTS reports { spoken: false } instead of pretending)
//
// Redaction is NOT duplicated here by design: spoken text arrives already
// egress-redacted from the main-process orchestrator (contract-pinned). This
// module's only last-guard is never speaking control characters / huge blobs.

import type { AppSettings } from "@shared/types";

export interface VoiceAgentSpeechConfig {
  voiceUri: string | null;
  rate: number;
  volume: number;
  muted: boolean;
}

// 任務中心 TTS 設定已移除 — 無生產呼叫端（整個 renderer voice-agent 只被
// 已刪除的 AgentApiPanel 使用）；保留簽名讓既有測試與潛在呼叫端仍可編譯。
export function ttsConfigFromSettings(settings: AppSettings | null | undefined): VoiceAgentSpeechConfig {
  void settings;
  return { voiceUri: null, rate: 1, volume: 1, muted: false };
}

/** §11.2 sentence chunking: zh/en terminators, newline boundaries, and a
 * hard cap so a pathological runaway sentence is broken at comma/pause
 * marks (then by raw length) instead of blocking the speech queue. */
export const SPEECH_CHUNK_MAX_CHARS = 220;

export function splitSpeechSentences(text: string, maxChars = SPEECH_CHUNK_MAX_CHARS): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  const raw: string[] = [];
  let current = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    current += char;
    const isAsciiDot = char === "."
      && (index + 1 === normalized.length || /[\s]/.test(normalized[index + 1]!));
    if (/[。！？!?；;\n]/.test(char) || isAsciiDot) {
      if (current.trim()) raw.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) raw.push(current.trim());
  const chunks: string[] = [];
  for (const sentence of raw) {
    if (sentence.length <= maxChars) {
      chunks.push(sentence);
      continue;
    }
    // Oversized sentence: re-split at soft pause marks, then by raw length.
    let rest = sentence;
    while (rest.length > maxChars) {
      const windowText = rest.slice(0, maxChars);
      const soft = Math.max(
        windowText.lastIndexOf("，"), windowText.lastIndexOf("、"),
        windowText.lastIndexOf(","), windowText.lastIndexOf(" "),
      );
      const cut = soft > maxChars / 3 ? soft + 1 : maxChars;
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut);
    }
    if (rest.trim()) chunks.push(rest.trim());
  }
  return chunks.filter(Boolean);
}

/** Minimal structural view the coordinator needs; jsdom tests inject fakes. */
export interface VoiceAgentTtsSynth {
  getVoices(): Array<{ voiceURI: string; lang?: string; name?: string }>;
  speak(utterance: unknown): void;
  cancel(): void;
  onvoiceschanged?: (() => void) | null;
}

export interface VoiceAgentSpeechOutcome {
  /** False when no voice exists / muted — caller falls back to text-only
   * display without pretending audio played. */
  spoken: boolean;
  /** True when completion came from cancel() (barge-in/interrupt). */
  cancelled: boolean;
}

export interface TtsVoice {
  id: string;
  name: string;
  lang?: string;
}

export interface TtsCapabilities {
  supportsVoiceSelection: boolean;
  supportsRate: boolean;
  supportsVolume: boolean;
  streaming?: boolean;
}

export interface TtsProvider {
  readonly id: string;
  listVoices(): Promise<TtsVoice[]>;
  speak(
    text: string,
    voice: TtsVoice | null,
    options: { rate: number; volume: number; signal?: AbortSignal },
  ): Promise<VoiceAgentSpeechOutcome>;
  stop(): void;
  capabilities(): TtsCapabilities;
}

export function speechSynthesisAvailable(): VoiceAgentTtsSynth | null {
  const synth = (globalThis as { speechSynthesis?: VoiceAgentTtsSynth }).speechSynthesis;
  if (typeof synth?.speak !== "function" || typeof synth?.cancel !== "function") return null;
  return synth;
}

/** iOS Safari routes ALL playback to the quiet earpiece while a mic capture
 * session is held. Declaring `playback` around TTS forces loudspeaker/media
 * volume; other platforms/exposed-less browsers simply no-op. */
type AudioSessionLike = { type: string };

function audioSession(): AudioSessionLike | null {
  const session = (globalThis as { navigator?: { audioSession?: AudioSessionLike } }).navigator?.audioSession;
  return session && typeof session.type === "string" ? session : null;
}

/** First provider implementation. It is deliberately a thin wrapper around
 * the proven speechSynthesis path so provider abstraction changes ownership,
 * not speech behaviour. */
export class BrowserSpeechSynthesisProvider implements TtsProvider {
  readonly id = "browser-speech";

  constructor(private readonly synth: VoiceAgentTtsSynth) {}

  listVoices(): Promise<TtsVoice[]> {
    return Promise.resolve(this.synth.getVoices().map((voice) => ({
      id: voice.voiceURI,
      name: voice.name ?? voice.voiceURI,
      ...(voice.lang ? { lang: voice.lang } : {}),
    })));
  }

  speak(
    text: string,
    voice: TtsVoice | null,
    options: { rate: number; volume: number; signal?: AbortSignal },
  ): Promise<VoiceAgentSpeechOutcome> {
    return speakSpeechText(this.synth, text, {
      voiceUri: voice?.id ?? null,
      rate: options.rate,
      volume: options.volume,
      muted: false,
    }, options.signal ? { signal: options.signal } : {});
  }

  stop(): void {
    this.synth.cancel();
  }

  capabilities(): TtsCapabilities {
    return {
      supportsVoiceSelection: true,
      supportsRate: true,
      supportsVolume: true,
      streaming: false,
    };
  }
}

export function browserSpeechProvider(): BrowserSpeechSynthesisProvider | null {
  const synth = speechSynthesisAvailable();
  return synth ? new BrowserSpeechSynthesisProvider(synth) : null;
}

/**
 * Voice-resolution helper: an empty voice list is the standard
 * "starting up / headless" signal on Chromium — treat it as unavailable so
 * the UI degrades to text instead of queueing silence.
 */
export function resolveSpeechVoice(
  synth: VoiceAgentTtsSynth,
  voiceUri: string | null,
): { voiceURI: string } | null {
  const voices = synth.getVoices();
  if (voices.length === 0) return null;
  if (!voiceUri) return voices[0] ?? null;
  return voices.find((voice) => voice.voiceURI === voiceUri) ?? voices[0] ?? null;
}

/**
 * Speak `text` as sentence chunks. Sequential utterance chaining keeps the
 * queue bounded (never more than one pending utterance ahead of the engine),
 * and `signal` aborts exactly like barge-in: cancel() + drop pending
 * sentences + resolve cancelled instead of finishing the old queue (§11.3).
 * Returns immediately with { spoken: false } when muted or voiceless.
 */
export async function speakSpeechText(
  synth: VoiceAgentTtsSynth,
  text: string,
  config: VoiceAgentSpeechConfig,
  options: { signal?: AbortSignal; createUtterance?: (text: string) => unknown } = {},
): Promise<VoiceAgentSpeechOutcome> {
  if (config.muted) return { spoken: false, cancelled: false };
  const voice = resolveSpeechVoice(synth, config.voiceUri);
  if (!voice) return { spoken: false, cancelled: false };
  const chunks = splitSpeechSentences(text);
  if (chunks.length === 0) return { spoken: false, cancelled: false };
  const createUtterance =
    options.createUtterance ??
    ((chunk: string) => {
      const utterance = new SpeechSynthesisUtterance(chunk) as unknown as Record<string, unknown> & {
        onend: (() => void) | null;
        onerror: (() => void) | null;
      };
      utterance.voice = voice;
      utterance.rate = config.rate;
      utterance.volume = config.volume;
      return utterance;
    });
  const signal = options.signal;
  if (signal?.aborted) return { spoken: false, cancelled: true };
  const session = audioSession();
  const previousSessionType = session?.type;
  if (session) session.type = "playback";
  return new Promise<VoiceAgentSpeechOutcome>((resolve) => {
    let index = 0;
    let settled = false;
    const settle = (outcome: VoiceAgentSpeechOutcome): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (session && previousSessionType !== undefined && session.type === "playback") {
        session.type = previousSessionType;
      }
      resolve(outcome);
    };
    const onAbort = (): void => {
      // Barge-in path: engine cancel clears BOTH the current utterance and
      // every queued one, so no leftover sentence can play after the epoch
      // bump (§11.3 step 1+3).
      synth.cancel();
      settle({ spoken: true, cancelled: true });
    };
    signal?.addEventListener("abort", onAbort);
    const speakNext = (): void => {
      if (index >= chunks.length) {
        settle({ spoken: true, cancelled: false });
        return;
      }
      const chunk = chunks[index]!;
      index += 1;
      const utterance = createUtterance(chunk) as {
        onend: (() => void) | null;
        onerror: (() => void) | null;
      };
      utterance.onend = () => {
        if (signal?.aborted) return settle({ spoken: true, cancelled: true });
        speakNext();
      };
      utterance.onerror = () => {
        if (signal?.aborted) return settle({ spoken: true, cancelled: true });
        settle({ spoken: false, cancelled: false });
      };
      synth.speak(utterance);
    };
    speakNext();
  });
}
