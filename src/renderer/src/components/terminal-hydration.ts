export interface TerminalSnapshotInput {
  ready: boolean;
  revision: number;
  data: string;
  /** Manual recovery may intentionally redraw an already-applied revision. */
  force?: boolean;
}

export interface TerminalLiveInput {
  revision: number;
  data: string;
}

export type TerminalHydrationAction =
  | { kind: "none" }
  | { kind: "buffer" }
  | { kind: "append"; data: string; revision: number }
  | { kind: "replace"; snapshot: string; trailing: string; revision: number };

/**
 * Orders an authoritative PTY snapshot against live chunks.
 *
 * The main process assigns a monotonically increasing revision to each output
 * chunk and captures that same revision beside each workspace snapshot. That
 * boundary lets a late snapshot replace the renderer without duplicating
 * chunks already present in it or dropping chunks emitted after it.
 */
export class TerminalHydrationCoordinator {
  private appliedRevision: number | null = null;
  private pending: TerminalLiveInput[] = [];

  acceptLive(input: TerminalLiveInput): TerminalHydrationAction {
    if (!Number.isSafeInteger(input.revision) || input.revision < 0 || !input.data) return { kind: "none" };
    if (this.appliedRevision === null) {
      this.pending.push(input);
      return { kind: "buffer" };
    }
    if (input.revision <= this.appliedRevision) return { kind: "none" };
    this.appliedRevision = input.revision;
    return { kind: "append", data: input.data, revision: input.revision };
  }

  acceptSnapshot(input: TerminalSnapshotInput): TerminalHydrationAction {
    if (!input.ready || !Number.isSafeInteger(input.revision) || input.revision < 0) return { kind: "none" };
    if (!input.force && this.appliedRevision !== null && input.revision <= this.appliedRevision) {
      return { kind: "none" };
    }

    const trailing = this.pending
      .filter((chunk) => chunk.revision > input.revision)
      .sort((left, right) => left.revision - right.revision);
    this.pending = [];
    const revision = trailing.at(-1)?.revision ?? input.revision;
    this.appliedRevision = revision;
    return {
      kind: "replace",
      snapshot: input.data,
      trailing: trailing.map((chunk) => chunk.data).join(""),
      revision,
    };
  }
}
