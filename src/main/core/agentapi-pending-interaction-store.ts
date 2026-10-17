import type { AgentApiPendingInteraction } from "@shared/types";

/** Memory-only interaction detail store. Prompt/options intentionally do not
 * enter AttentionCenter or SQLite. */
export class PendingInteractionStore {
  private readonly interactions = new Map<string, AgentApiPendingInteraction>();

  set(interaction: AgentApiPendingInteraction): void {
    this.interactions.set(interaction.terminalId, clone(interaction));
  }

  getByTerminal(terminalId: string): AgentApiPendingInteraction | null {
    const value = this.interactions.get(terminalId);
    return value ? clone(value) : null;
  }

  getActive(): AgentApiPendingInteraction[] {
    return [...this.interactions.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(clone);
  }

  resolveByTerminal(terminalId: string): void {
    this.interactions.delete(terminalId);
  }

  resolve(id: string): void {
    for (const [terminalId, value] of this.interactions) {
      if (value.id === id) {
        this.interactions.delete(terminalId);
        return;
      }
    }
  }

  clearForTerminal(terminalId: string): void {
    this.interactions.delete(terminalId);
  }
}

function clone(value: AgentApiPendingInteraction): AgentApiPendingInteraction {
  return { ...value, options: value.options.map((option) => ({ ...option })) };
}
