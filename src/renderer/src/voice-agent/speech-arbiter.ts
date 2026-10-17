import type { TtsProvider, TtsVoice, VoiceAgentSpeechOutcome } from "./tts";

export type SpeechRole = "supervisor" | "session" | "system";
export type SpeechPriority = "user-interaction" | "needs-input" | "error" | "completed" | "progress";

export interface SpeechRequest {
  id: string;
  role: SpeechRole;
  text: string;
  priority: SpeechPriority;
  terminalId?: string;
  dedupeKey?: string;
  interruptible: boolean;
  createdAt: number;
}

export interface SpeechRoleProfile {
  voiceId: string | null;
  rate: number;
  volume: number;
}

export interface SpeechArbiterConfig {
  profileFor(role: SpeechRole): SpeechRoleProfile;
  maxQueueAgeMs?: number;
  dedupeWindowMs?: number;
  now?: () => number;
}

export interface SpeechHandle {
  outcome: Promise<VoiceAgentSpeechOutcome>;
}

const PRIORITY: Record<SpeechPriority, number> = {
  "user-interaction": 0,
  "needs-input": 1,
  error: 2,
  completed: 4,
  progress: 5,
};

interface QueueEntry {
  request: SpeechRequest;
  resolve: (outcome: VoiceAgentSpeechOutcome) => void;
  sequence: number;
}

export class SpeechArbiter {
  private readonly now: () => number;
  private readonly maxQueueAgeMs: number;
  private readonly dedupeWindowMs: number;
  private readonly queue: QueueEntry[] = [];
  private readonly recentDedupe = new Map<string, number>();
  private current: { entry: QueueEntry; abort: AbortController } | null = null;
  private sequence = 0;
  private pumping = false;

  constructor(private readonly provider: TtsProvider, private readonly config: SpeechArbiterConfig) {
    this.now = config.now ?? (() => Date.now());
    this.maxQueueAgeMs = config.maxQueueAgeMs ?? 15_000;
    this.dedupeWindowMs = config.dedupeWindowMs ?? 20_000;
  }

  request(request: SpeechRequest): SpeechHandle {
    if (!request.text.trim() || this.isDuplicate(request)) {
      return { outcome: Promise.resolve({ spoken: false, cancelled: false }) };
    }
    let resolve!: (outcome: VoiceAgentSpeechOutcome) => void;
    const outcome = new Promise<VoiceAgentSpeechOutcome>((done) => { resolve = done; });
    const entry: QueueEntry = { request, resolve, sequence: this.sequence++ };
    this.queue.push(entry);
    this.sortQueue();
    void this.pump();
    return { outcome };
  }

  /** User barge-in owns the acoustic channel immediately: cancel current and
   * discard low-value queued progress/completion so stale narration cannot
   * resume after the fresh user turn. */
  bargeIn(): void {
    this.cancelCurrent();
    this.dropQueued((request) => request.priority === "progress" || request.priority === "completed");
  }

  cancelAll(): void {
    this.cancelCurrent();
    this.dropQueued(() => true);
  }

  dispose(): void {
    this.cancelAll();
  }

  private cancelCurrent(): void {
    if (!this.current) return;
    this.current.abort.abort();
    this.provider.stop();
  }

  private dropQueued(predicate: (request: SpeechRequest) => boolean): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const entry = this.queue[index]!;
      if (!predicate(entry.request)) continue;
      this.queue.splice(index, 1);
      entry.resolve({ spoken: false, cancelled: true });
    }
  }

  private isDuplicate(request: SpeechRequest): boolean {
    if (!request.dedupeKey) return false;
    const now = this.now();
    for (const [key, at] of this.recentDedupe) {
      if (now - at > this.dedupeWindowMs) this.recentDedupe.delete(key);
    }
    const seenAt = this.recentDedupe.get(request.dedupeKey);
    if (seenAt !== undefined && now - seenAt <= this.dedupeWindowMs) return true;
    if (this.current?.entry.request.dedupeKey === request.dedupeKey) return true;
    if (this.queue.some((entry) => entry.request.dedupeKey === request.dedupeKey)) return true;
    return false;
  }

  private sortQueue(): void {
    this.queue.sort((a, b) => {
      const priority = PRIORITY[a.request.priority] - PRIORITY[b.request.priority];
      return priority !== 0 ? priority : a.sequence - b.sequence;
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.current && this.queue.length > 0) {
        const entry = this.queue.shift()!;
        if (this.now() - entry.request.createdAt > this.maxQueueAgeMs) {
          entry.resolve({ spoken: false, cancelled: true });
          continue;
        }
        const abort = new AbortController();
        this.current = { entry, abort };
        const profile = this.config.profileFor(entry.request.role);
        const voices = await this.provider.listVoices();
        const voice: TtsVoice | null = profile.voiceId
          ? voices.find((item) => item.id === profile.voiceId) ?? voices[0] ?? null
          : voices[0] ?? null;
        let outcome: VoiceAgentSpeechOutcome;
        try {
          outcome = await this.provider.speak(entry.request.text, voice, {
            rate: profile.rate,
            volume: profile.volume,
            signal: abort.signal,
          });
        } catch {
          outcome = { spoken: false, cancelled: abort.signal.aborted };
        }
        if (entry.request.dedupeKey && outcome.spoken && !outcome.cancelled) {
          this.recentDedupe.set(entry.request.dedupeKey, this.now());
        }
        entry.resolve(outcome);
        if (this.current?.entry === entry) this.current = null;
      }
    } finally {
      this.pumping = false;
      if (!this.current && this.queue.length > 0) void this.pump();
    }
  }
}
