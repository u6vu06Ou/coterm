export type MobileComposerOpenReason =
  | "bottom-tap"
  | "toolbar"
  | "paste-fallback"
  | "dictation"
  // The phone reader's inline input drives this same controller; the floating
  // MobileCommandComposer stands down (renders nothing) while reason is
  // "reader" so the two surfaces never fight over one open/submit machine.
  | "reader";

export type MobileComposerState =
  | { status: "closed" }
  | {
      status: "opening" | "focused" | "submitting";
      terminalId: string;
      reason: MobileComposerOpenReason;
      generation: number;
    };

export interface MobileComposerSnapshot {
  state: MobileComposerState;
  draftsByTerminal: Readonly<Record<string, string>>;
  sendWithEnterByTerminal: Readonly<Record<string, boolean>>;
  pastedByTerminal: Readonly<Record<string, { text: string; entered: boolean }>>;
  error: string | null;
}

export interface MobileTerminalWrite {
  terminalId: string;
  data: string;
  source: "mobile-composer";
  clientMutationId: string;
}

export type MobileTerminalWriter = (input: MobileTerminalWrite) => Promise<void> | void;

export function buildMobilePasteData(text: string): string {
  return `\x1b[200~${text.split("\x1b").join("")}\x1b[201~`;
}

function mutationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `mobile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "送出失敗，請再試一次。";
}

/**
 * The single writer for general mobile text. React is only a view over this
 * state machine; input ownership never depends on whether the component is
 * mounted or merely hidden.
 */
export class MobileInputController {
  private snapshot: MobileComposerSnapshot = {
    state: { status: "closed" },
    draftsByTerminal: {},
    sendWithEnterByTerminal: {},
    pastedByTerminal: {},
    error: null,
  };
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private inFlight: Promise<boolean> | null = null;
  // IME composition flag kept OUT of snapshot state on purpose: toggling it
  // must not trigger a React re-render of the controlled textarea, which
  // interrupts the in-flight IME session and drops focus mid-composition.
  private composing = false;

  getSnapshot = (): MobileComposerSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  open(input: { terminalId: string; reason: MobileComposerOpenReason }): void {
    if (!input.terminalId || this.inFlight) return;
    const current = this.snapshot.state;
    if (current.status !== "closed" && current.terminalId === input.terminalId) {
      this.setSnapshot({ error: null });
      return;
    }
    this.generation += 1;
    this.setSnapshot({
      state: {
        status: "opening",
        terminalId: input.terminalId,
        reason: input.reason,
        generation: this.generation,
      },
      error: null,
    });
  }

  close(reason: "cancel" | "submitted" | "terminal-switch" | "unmount"): void {
    if (this.inFlight) return;
    if (reason === "cancel" || reason === "submitted") {
      const state = this.snapshot.state;
      if (state.status !== "closed") {
        const drafts = { ...this.snapshot.draftsByTerminal };
        delete drafts[state.terminalId];
        const sendWithEnter = { ...this.snapshot.sendWithEnterByTerminal };
        delete sendWithEnter[state.terminalId];
        this.setSnapshot({
          state: { status: "closed" },
          draftsByTerminal: drafts,
          sendWithEnterByTerminal: sendWithEnter,
          error: null,
        });
        return;
      }
    }
    this.setSnapshot({ state: { status: "closed" }, error: null });
  }

  markFocused(): void {
    const state = this.snapshot.state;
    if (state.status === "opening") this.setSnapshot({ state: { ...state, status: "focused" } });
  }

  setComposition(composing: boolean): void {
    const state = this.snapshot.state;
    if (state.status === "closed" || state.status === "submitting") return;
    this.composing = composing;
  }

  isComposing(): boolean {
    return this.composing;
  }

  setDraft(terminalId: string, draft: string): void {
    const current = this.snapshot.draftsByTerminal[terminalId];
    if (current === draft) return;
    this.setSnapshot({ draftsByTerminal: { ...this.snapshot.draftsByTerminal, [terminalId]: draft }, error: null });
  }

  insertText(terminalId: string, text: string): void {
    if (!text) return;
    this.setDraft(terminalId, `${this.snapshot.draftsByTerminal[terminalId] ?? ""}${text}`);
  }

  setSendWithEnter(terminalId: string, value: boolean): void {
    void value; // Compatibility only: mobile submission belongs to the toolbar ENTER.
    this.setSnapshot({ sendWithEnterByTerminal: { ...this.snapshot.sendWithEnterByTerminal, [terminalId]: false } });
  }

  markEntered(terminalId: string): void {
    const pasted = this.snapshot.pastedByTerminal[terminalId];
    if (pasted) this.setSnapshot({ pastedByTerminal: { ...this.snapshot.pastedByTerminal, [terminalId]: { ...pasted, entered: true } } });
  }

  recordPasted(terminalId: string, text: string): void {
    const previous = this.snapshot.pastedByTerminal[terminalId];
    const cleanText = text.split("\x1b").join("");
    const combined = previous && !previous.entered ? previous.text + cleanText : cleanText;
    this.setSnapshot({ pastedByTerminal: { ...this.snapshot.pastedByTerminal, [terminalId]: { text: combined, entered: false } } });
  }

  isOpenFor(terminalId: string): boolean {
    const state = this.snapshot.state;
    return state.status !== "closed" && state.terminalId === terminalId;
  }

  async submit(writer: MobileTerminalWriter): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    const state = this.snapshot.state;
    if (state.status === "closed" || this.composing) return false;
    const draft = this.snapshot.draftsByTerminal[state.terminalId] ?? "";
    if (!draft) return false;
    const terminalId = state.terminalId;
    // Bracketed paste keeps embedded newlines as text instead of executing them.
    const data = buildMobilePasteData(draft);
    const pending = (async (): Promise<boolean> => {
      this.setSnapshot({ state: { ...state, status: "submitting" }, error: null });
      try {
        await writer({ terminalId, data, source: "mobile-composer", clientMutationId: mutationId() });
        const drafts = { ...this.snapshot.draftsByTerminal };
        drafts[terminalId] = "";
        this.recordPasted(terminalId, draft);
        this.setSnapshot({ state: { status: "closed" }, draftsByTerminal: drafts, error: null });
        return true;
      } catch (error) {
        this.setSnapshot({ state: { ...state, status: "focused" }, error: errorText(error) });
        return false;
      }
    })();
    this.inFlight = pending;
    try {
      return await pending;
    } finally {
      this.inFlight = null;
    }
  }

  resetForTest(): void {
    this.inFlight = null;
    this.generation = 0;
    this.composing = false;
    this.snapshot = { state: { status: "closed" }, draftsByTerminal: {}, sendWithEnterByTerminal: {}, pastedByTerminal: {}, error: null };
    this.emit();
  }

  private setSnapshot(update: Partial<MobileComposerSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const mobileInputController = new MobileInputController();
