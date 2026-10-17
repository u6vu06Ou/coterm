import { useSyncExternalStore } from "react";

export type VoiceDraftPhase = "listening" | "partial" | "finalizing" | "preview-paused";

export interface VoiceDraftToken {
  terminalId: string;
  epoch: number;
}

export interface VoiceDraftEntry extends VoiceDraftToken {
  phase: VoiceDraftPhase;
  text: string;
}

export interface RecoverableVoiceDraft {
  sourceTerminalId: string;
  epoch: number;
  text: string;
}

export interface VoiceDraftSnapshot {
  byTerminal: Readonly<Record<string, VoiceDraftEntry>>;
  recoverable: RecoverableVoiceDraft | null;
}

type Listener = () => void;

class VoiceDraftStore {
  private epoch = 0;
  private listeners = new Set<Listener>();
  private snapshot: VoiceDraftSnapshot = { byTerminal: {}, recoverable: null };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): VoiceDraftSnapshot => this.snapshot;

  lock(terminalId: string): VoiceDraftToken {
    const token = { terminalId, epoch: ++this.epoch };
    this.replaceEntry(token, "listening", "");
    return token;
  }

  update(token: VoiceDraftToken, phase: VoiceDraftPhase, text?: string): void {
    const current = this.snapshot.byTerminal[token.terminalId];
    if (!current || current.epoch !== token.epoch) return;
    this.replaceEntry(token, phase, text ?? current.text);
  }

  clear(token: VoiceDraftToken): void {
    const current = this.snapshot.byTerminal[token.terminalId];
    if (!current || current.epoch !== token.epoch) return;
    const byTerminal = { ...this.snapshot.byTerminal };
    delete byTerminal[token.terminalId];
    this.publish({ ...this.snapshot, byTerminal });
  }

  recover(token: VoiceDraftToken, text: string): void {
    const normalized = text.trim();
    if (!normalized) {
      this.clear(token);
      return;
    }
    const byTerminal = { ...this.snapshot.byTerminal };
    const current = byTerminal[token.terminalId];
    if (current?.epoch === token.epoch) delete byTerminal[token.terminalId];
    this.publish({
      byTerminal,
      recoverable: {
        sourceTerminalId: token.terminalId,
        epoch: token.epoch,
        text: normalized,
      },
    });
  }

  clearRecoverable(epoch: number): void {
    if (this.snapshot.recoverable?.epoch !== epoch) return;
    this.publish({ ...this.snapshot, recoverable: null });
  }

  resetForTest(): void {
    this.epoch = 0;
    this.publish({ byTerminal: {}, recoverable: null });
  }

  private replaceEntry(token: VoiceDraftToken, phase: VoiceDraftPhase, text: string): void {
    this.publish({
      ...this.snapshot,
      byTerminal: {
        ...this.snapshot.byTerminal,
        [token.terminalId]: { ...token, phase, text },
      },
    });
  }

  private publish(next: VoiceDraftSnapshot): void {
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }
}

export const voiceDraftStore = new VoiceDraftStore();

export function useVoiceDraftSnapshot(): VoiceDraftSnapshot {
  return useSyncExternalStore(voiceDraftStore.subscribe, voiceDraftStore.getSnapshot, voiceDraftStore.getSnapshot);
}
