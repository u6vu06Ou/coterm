// Agent Attention Center — metadata-only notification inbox for terminals that
// need a human (waiting_input / approval_required / blocked / error).
//
// Subscribes to ptyStateChanged. Only attention states file a notification.
// Notifications are deduped (one unresolved per terminal), bounded (max MAX),
// and auto-resolved when the terminal leaves the attention state. Persisted to
// a single bounded JSON file in userData (atomic write, corruption fallback).
//
// Privacy (logging-api §A.2): a notification carries ONLY ids + state + source
// + timestamps. The triggering prompt/approval text/command is never stored —
// PtyManager classifies then discards it before emitting ptyStateChanged.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import type { AppEventBus } from "./event-bus";
import { logger } from "./logger";
import { createId } from "./ids";
import { isAttentionState } from "@shared/pty-state";
import { attentionNotificationSchema } from "@shared/schema";
import type { AttentionNotification, PtyStateChanged } from "@shared/types";

const MAX_NOTIFICATIONS = 200;

export interface AttentionCenterOptions {
  userDataPath: string;
  events: AppEventBus;
}

interface AttentionCenterEvents {
  changed: [AttentionNotification];
}

export class AttentionCenter {
  private readonly notifications = new Map<string, AttentionNotification>();
  private readonly byTerminal = new Map<string, string>();
  private readonly filePath: string;
  private readonly disposers: Array<() => void> = [];
  private readonly emitter = new EventEmitter<AttentionCenterEvents>();
  private loaded = false;
  private writeTimer: NodeJS.Timeout | null = null;
  private persistInFlight: Promise<void> = Promise.resolve();

  constructor(options: AttentionCenterOptions) {
    this.filePath = join(options.userDataPath, "attention-inbox.json");
    // Subscribe to state changes. Only attention states file a notification;
    // leaving an attention state auto-resolves the open one.
    const listener = (change: PtyStateChanged): void => {
      this.onStateChange(change);
    };
    options.events.on("ptyStateChanged", listener);
    this.disposers.push(() => options.events.off("ptyStateChanged", listener));
  }

  /** Subscribe to notification changes (filed / resolved). Returns unsubscribe. */
  onAttentionChanged(callback: (notification: AttentionNotification) => void): () => void {
    this.emitter.on("changed", callback);
    return () => this.emitter.off("changed", callback);
  }

  /** Load persisted unresolved notifications. Safe to call once at boot. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as { notifications?: unknown };
      const list = Array.isArray(parsed.notifications) ? parsed.notifications : [];
      for (const item of list) {
        const n = this.validate(item);
        if (!n) continue;
        if (n.resolvedAt) continue; // drop already-resolved on reload
        if (this.byTerminal.has(n.terminalId)) continue;
        if (this.notifications.size >= MAX_NOTIFICATIONS) break;
        this.notifications.set(n.id, n);
        this.byTerminal.set(n.terminalId, n.id);
      }
    } catch (error) {
      // Corruption / missing file: start empty. Never throw on boot.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        logger.warn("pty", "attention.load.failed", "Attention inbox load failed; starting empty", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** List unresolved notifications (newest first), metadata only. */
  list(): AttentionNotification[] {
    return [...this.notifications.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Mark a notification resolved by id. No-op if not found. */
  resolve(notificationId: string): void {
    const n = this.notifications.get(notificationId);
    if (!n || n.resolvedAt) return;
    const resolved: AttentionNotification = {
      ...n,
      resolvedAt: new Date().toISOString(),
    };
    this.notifications.delete(notificationId);
    this.byTerminal.delete(n.terminalId);
    this.scheduleWrite();
    this.emitter.emit("changed", resolved);
  }

  /**
   * File an attention notification from OUTSIDE the pty-state pipeline (the
   * agent-mail loop guard uses this when it pauses a chatty pane pair). Filed
   * as state "blocked" from the lowest-authority source so the real state
   * pipeline never treats it as evidence; persists until the user resolves it
   * from the inbox (or the pane next leaves an attention state).
   */
  fileExternalNotification(input: { terminalId: string; projectId: string }): void {
    this.fileNotification({
      terminalId: input.terminalId,
      projectId: input.projectId,
      state: "blocked",
      previousState: null,
      source: "heuristic",
    });
  }

  private onStateChange(change: PtyStateChanged): void {
    const { terminalId, state } = change;
    if (isAttentionState(state)) {
      this.fileNotification(change);
    } else {
      // Leaving an attention state → auto-resolve the open notification for
      // this terminal (if any). This is the normal "user acted / agent moved
      // on" path; explicit resolve() is for the inbox click.
      const existingId = this.byTerminal.get(terminalId);
      if (existingId) this.resolve(existingId);
    }
  }

  private fileNotification(change: PtyStateChanged): void {
    const { terminalId, projectId, state, source } = change;
    // Dedupe: one unresolved notification per terminal. If the state changed
    // (e.g. waiting_input → approval_required), update the existing record
    // rather than filing a second one.
    const existingId = this.byTerminal.get(terminalId);
    if (existingId) {
      const existing = this.notifications.get(existingId);
      if (
        existing &&
        existing.state === state &&
        existing.source === source &&
        existing.resolvedAt === null
      ) {
        return; // same state, already filed — no-op
      }
      if (existing) {
        // Keep the same id so every IPC/WS client replaces the row instead of
        // retaining a stale entry for the previous attention state.
        const updated: AttentionNotification = {
          ...existing,
          projectId,
          state,
          source,
          createdAt: new Date().toISOString(),
        };
        this.notifications.set(existingId, updated);
        this.scheduleWrite();
        this.emitter.emit("changed", updated);
        return;
      }
    }
    const notification: AttentionNotification = {
      id: createId(),
      terminalId,
      projectId,
      state,
      source,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
    this.notifications.set(notification.id, notification);
    this.byTerminal.set(terminalId, notification.id);
    this.enforceCapacity();
    this.scheduleWrite();
    this.emitter.emit("changed", notification);
  }

  private enforceCapacity(): void {
    if (this.notifications.size <= MAX_NOTIFICATIONS) return;
    const oldestFirst = [...this.notifications.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const n of oldestFirst) {
      if (this.notifications.size <= MAX_NOTIFICATIONS) break;
      this.notifications.delete(n.id);
      this.byTerminal.delete(n.terminalId);
      // Tell already-connected clients to remove the evicted row too.
      this.emitter.emit("changed", { ...n, resolvedAt: new Date().toISOString() });
    }
  }

  private validate(item: unknown): AttentionNotification | null {
    const parsed = attentionNotificationSchema.safeParse(item);
    if (!parsed.success || !isAttentionState(parsed.data.state)) return null;
    return parsed.data;
  }

  private scheduleWrite(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    // Coalesce bursts: a rapid waiting_input→approval_required→resolved cycle
    // should hit disk once. 500ms is well under the WS replay window.
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.queuePersist();
    }, 500);
  }

  private queuePersist(): void {
    this.persistInFlight = this.persistInFlight.then(() => this.persist());
  }

  private async persist(): Promise<void> {
    const payload = { notifications: [...this.notifications.values()] };
    const tmp = `${this.filePath}.tmp`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(tmp, JSON.stringify(payload), "utf8");
      // Atomic-ish rename. On Windows a rename over an existing file works;
      // if it fails we fall back to a direct write (corruption-tolerant load).
      try {
        await rename(tmp, this.filePath);
      } catch {
        await writeFile(this.filePath, JSON.stringify(payload), "utf8");
      }
    } catch (error) {
      logger.warn("pty", "attention.persist.failed", "Attention inbox persist failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async dispose(): Promise<void> {
    for (const disposer of this.disposers) disposer();
    this.disposers.length = 0;
    const hadPendingWrite = this.writeTimer !== null;
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    await this.persistInFlight;
    if (hadPendingWrite) await this.persist();
  }
}
