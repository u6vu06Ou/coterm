import type { AiTerminalApi } from "@shared/ipc";

declare global {
  interface SpeechRecognitionResultLike {
    readonly transcript: string;
  }

  interface SpeechRecognitionAlternativeListLike {
    readonly length: number;
    [index: number]: SpeechRecognitionResultLike;
  }

  interface SpeechRecognitionResultListLike {
    readonly length: number;
    [index: number]: SpeechRecognitionAlternativeListLike;
  }

  interface SpeechRecognitionEventLike extends Event {
    readonly results: SpeechRecognitionResultListLike;
  }

  interface SpeechRecognitionLike extends EventTarget {
    lang: string;
    interimResults: boolean;
    maxAlternatives: number;
    onstart: (() => void) | null;
    onend: (() => void) | null;
    onerror: (() => void) | null;
    onresult: ((event: SpeechRecognitionEventLike) => void) | null;
    start(): void;
    stop(): void;
  }

  type SpeechRecognitionConstructorLike = new () => SpeechRecognitionLike;

  interface Window {
    aiTerminal: AiTerminalApi;
    SpeechRecognition?: SpeechRecognitionConstructorLike;
    webkitSpeechRecognition?: SpeechRecognitionConstructorLike;
  }
}

export {};
