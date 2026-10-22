import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { DockLayout } from "@shared/types";
import { terminalLabelSchema } from "@shared/schema";
import type { PtyManager } from "../terminal/pty-manager";
import type { ClaudeProfile } from "../providers/profiles-config";
import { buildSessionResumeCommand } from "../providers/agent-launch";
import type { AppEventBus } from "./event-bus";
import type { DockLayoutManager, DockRestoredPane } from "./dock-layout";
import { logger } from "./logger";

/**
 * Session restore (user request, 2026-10-23)
 * -----------------------------------------
 * DockLayoutManager only persists the resize fractions (dock-layout.json);
 * tiles point at PTYs that die with the process, so a restart used to boot
 * into an empty dock. This service snapshots the dock — pane order, layout
 * fractions, selection, and per pane the cwd / shell profile / agent kind /
 * native session id — to `<userData>/session-restore.json`, saved debounced
 * on every layout change, once a minute (covers cwd drifts, which emit no
 * event), and once more on a clean quit, so even a crash leaves a recent
 * snapshot.
 *
 * On the next boot restoreTiles() respawns the panes (same layout code path
 * as openTile) and each agent pane gets its provider resume command written
 * through writeWhenShellReady — claude -> `claude --resume <id>`, codex ->
 * `codex resume <id>` — rebuilt by buildSessionResumeCommand from the
 * {profile, sessionId} metadata, never a persisted command string
 * (trusted-resume rule, ABCDEF guide §3). Coverage matches the "+agent"
 * picker: free proxy profiles AND paid/official ones (claude-official,
 * codex-official, codex-team, paid customs) — those panes were launched by
 * the user, so the API launch allowlist does not gate the restore. A resume
 * that fails on a dead session exits to the plain shell prompt; nothing
 * retries, so the pane never error-loops. Truly unknown or non-resumable
 * profiles (council, gemini without its shim) reopen as a plain shell in
 * their cwd.
 *
 * Deliberately skipped: exclusive (solo) view is transient UI state, and
 * scrollback text — pane scrollback is memory-only (the terminal_events
 * table holds command metadata, not screen text), so restoring it would
 * need a new storage path, which is out of scope here.
 */

const SESSION_RESTORE_FILE = "session-restore.json";
const SAVE_DEBOUNCE_MS = 2_000;
const SAVE_INTERVAL_MS = 60_000;

const paneSchema = z.object({
  projectId: z.string().min(1).max(200),
  cwd: z.string().min(1).max(1024),
  profile: z.enum(["powershell", "cmd", "wsl", "pwsh", "zsh", "bash"]),
  isAgent: z.boolean(),
  agentProfile: z.string().min(1).max(80).nullable().catch(null),
  nativeSessionId: z.string().min(1).max(200).nullable().catch(null),
  worktreeId: z.string().min(1).max(200).nullable().catch(null),
  label: terminalLabelSchema.nullable().catch(null),
});

export interface DockSessionSnapshot {
  version: 1;
  savedAt: string;
  panes: DockRestoredPane[];
  selectedIndex: number | null;
  rows: number[];
  cols: number[][];
  ptyCols: number;
  ptyRows: number;
}

const fractionArray = (value: unknown): number[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is number => Number.isFinite(entry) && entry > 0 && entry <= 1)
    : [];

/**
 * Build the snapshot from the live dock layout. `resolvePane` maps a live
 * terminal to its restorable description; returning null (unknown or exited
 * PTY) drops that tile and reindexes selection so the stored selectedIndex
 * always points into the persisted pane list.
 */
export function buildDockSessionSnapshot(
  layout: DockLayout,
  resolvePane: (terminalId: string) => DockRestoredPane | null,
  savedAt: string = new Date().toISOString(),
): DockSessionSnapshot {
  const panes: DockRestoredPane[] = [];
  const snapshotIndexByTileIndex = new Map<number, number>();
  layout.tiles.forEach((tile, tileIndex) => {
    const pane = resolvePane(tile.terminalId);
    if (!pane) return;
    snapshotIndexByTileIndex.set(tileIndex, panes.length);
    panes.push(pane);
  });
  const selectedTileIndex = layout.selectedTerminalId
    ? layout.tiles.findIndex((tile) => tile.terminalId === layout.selectedTerminalId)
    : -1;
  const selectedIndex = selectedTileIndex >= 0
    ? (snapshotIndexByTileIndex.get(selectedTileIndex) ?? null)
    : null;
  return {
    version: 1,
    savedAt,
    panes,
    selectedIndex,
    rows: [...layout.rows],
    cols: layout.cols.map((row) => [...row]),
    ptyCols: layout.ptyCols,
    ptyRows: layout.ptyRows,
  };
}

/**
 * Lenient reader: anything structurally off at the top level (bad JSON,
 * wrong version) → null (start fresh, never throw on boot — the
 * attention-inbox recovery rule); a single corrupt PANE is dropped while
 * the rest still restore.
 */
export function parseDockSessionSnapshot(raw: string): DockSessionSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) return null;
  if (!Array.isArray(record.panes)) return null;
  const panes: DockRestoredPane[] = [];
  for (const entry of record.panes) {
    const pane = paneSchema.safeParse(entry);
    if (pane.success) panes.push(pane.data);
  }
  const selectedIndex = typeof record.selectedIndex === "number" && Number.isInteger(record.selectedIndex)
    && record.selectedIndex >= 0 && record.selectedIndex < panes.length
    ? record.selectedIndex
    : null;
  const rows = fractionArray(record.rows);
  const cols = Array.isArray(record.cols) ? record.cols.map(fractionArray) : [];
  return {
    version: 1,
    savedAt: typeof record.savedAt === "string" ? record.savedAt : "",
    panes,
    selectedIndex,
    rows,
    cols: rows.length === cols.length ? cols : [],
    ptyCols: typeof record.ptyCols === "number" ? record.ptyCols : 100,
    ptyRows: typeof record.ptyRows === "number" ? record.ptyRows : 28,
  };
}

export interface SessionRestoreServiceDependencies {
  userDataPath: string;
  dock: DockLayoutManager;
  terminals: Pick<PtyManager, "get" | "getLiveCwd" | "setNativeSessionId" | "writeWhenShellReady">;
  events: AppEventBus;
  /** settings.restoreSessionOnLaunch — read fresh so a mid-session toggle wins. */
  getEnabled: () => boolean;
  /** Active profile table (built-ins ⊕ settings.customProfiles), for the resume allowlist. */
  getProfileTable: () => Record<string, ClaudeProfile>;
}

export class SessionRestoreService {
  private readonly filePath: string;
  private readonly unsubscribers: Array<() => void> = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> = Promise.resolve();
  private pendingSave = false;
  private stopped = false;

  constructor(private readonly dependencies: SessionRestoreServiceDependencies) {
    this.filePath = join(dependencies.userDataPath, SESSION_RESTORE_FILE);
  }

  /** Begin watching layout + terminal-list changes and the periodic save. */
  start(): void {
    if (this.stopped) return;
    this.unsubscribers.push(
      this.dependencies.dock.onLayoutChanged(() => this.scheduleSave()),
    );
    const onTerminalListChanged = (): void => this.scheduleSave();
    this.dependencies.events.on("terminalListChanged", onTerminalListChanged);
    this.unsubscribers.push(() => this.dependencies.events.off("terminalListChanged", onTerminalListChanged));
    this.interval = setInterval(() => {
      void this.saveNow().catch(() => undefined);
    }, SAVE_INTERVAL_MS);
    // Never keep the process alive for the snapshot timer.
    this.interval.unref?.();
  }

  /** Stop watching and take the final snapshot (clean-quit path). */
  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      try { unsubscribe(); } catch { /* listener teardown is best-effort */ }
    }
    await this.saveNow().catch((error: unknown) => {
      logger.warn("app", "sessionRestore.shutdown.failed", "Final session-restore snapshot failed.", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private scheduleSave(): void {
    if (this.stopped) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.saveNow().catch(() => undefined);
    }, SAVE_DEBOUNCE_MS);
    this.debounce.unref?.();
  }

  /**
   * Persist the current dock state — also with EMPTY tiles after the last
   * pane was closed, so the next launch doesn't revive long-closed panes.
   * Serialized through a promise chain: a layout burst (restore itself
   * creates N tiles) can otherwise interleave two atomic writes.
   */
  async saveNow(): Promise<void> {
    this.pendingSave = true;
    this.inFlight = this.inFlight.then(async () => {
      if (!this.pendingSave) return;
      this.pendingSave = false;
      const layout = await this.dependencies.dock.getDockLayout();
      const snapshot = buildDockSessionSnapshot(layout, (terminalId) => this.describePane(terminalId));
      await this.writeSnapshot(snapshot);
    }).catch((error: unknown) => {
      logger.warn("app", "sessionRestore.save.failed", "Failed to persist the session-restore snapshot.", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return this.inFlight;
  }

  private describePane(terminalId: string): DockRestoredPane | null {
    const info = this.dependencies.terminals.get(terminalId);
    if (!info || info.status !== "running") return null;
    return {
      projectId: info.projectId,
      cwd: this.dependencies.terminals.getLiveCwd(terminalId) ?? info.cwd,
      profile: info.profile,
      isAgent: info.isAgent,
      agentProfile: info.agentProfile,
      nativeSessionId: info.nativeSessionId,
      worktreeId: info.worktreeId,
      label: info.label ?? null,
    };
  }

  /** Atomic-ish write (tmp + rename, direct-write fallback), mirroring the
   *  attention-inbox persistence contract. */
  private async writeSnapshot(snapshot: DockSessionSnapshot): Promise<void> {
    const text = JSON.stringify(snapshot);
    await mkdir(this.dependencies.userDataPath, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    try {
      await writeFile(tmp, text, "utf8");
      await rename(tmp, this.filePath);
    } catch {
      await writeFile(this.filePath, text, "utf8");
    }
  }

  /**
   * Recreate the saved dock at startup. No-op when the toggle is off, the
   * snapshot is missing/corrupt, or it holds no panes. Agent panes are
   * relaunched with their provider resume command; a pane without a captured
   * session id relaunches the agent fresh. Returns per-pane outcome counts
   * for the boot log.
   */
  async restore(): Promise<{ restored: number; relaunched: number }> {
    if (!this.dependencies.getEnabled()) return { restored: 0, relaunched: 0 };
    let snapshot: DockSessionSnapshot | null;
    try {
      snapshot = parseDockSessionSnapshot(await readFile(this.filePath, "utf8"));
    } catch {
      return { restored: 0, relaunched: 0 };
    }
    if (!snapshot || snapshot.panes.length === 0) return { restored: 0, relaunched: 0 };
    const { created } = await this.dependencies.dock.restoreTiles(snapshot.panes, {
      selectedIndex: snapshot.selectedIndex,
      rows: snapshot.rows,
      cols: snapshot.cols,
      ptyCols: snapshot.ptyCols,
      ptyRows: snapshot.ptyRows,
    });
    const profileTable = this.dependencies.getProfileTable();
    let relaunched = 0;
    for (const { terminalId, pane } of created) {
      if (!pane.isAgent || !pane.agentProfile) continue;
      // Bind the old session id first so transcripts/sidebar resolve the
      // resumed session exactly (same as the renderer's f2 binding).
      if (pane.nativeSessionId) {
        this.dependencies.terminals.setNativeSessionId(terminalId, pane.nativeSessionId);
      }
      // Build the command against the pane's ACTUAL cwd: restoreTiles may
      // have fallen back to the project workspace when the stored directory
      // no longer exists.
      const cwd = this.dependencies.terminals.getLiveCwd(terminalId) ?? pane.cwd;
      const command = buildSessionResumeCommand(pane.agentProfile, cwd, pane.nativeSessionId, profileTable);
      if (!command) {
        logger.warn("app", "sessionRestore.relaunch.unsupported", "Restored agent pane left as a plain shell; profile is unknown or not resume-capable.", {
          agentProfile: pane.agentProfile,
        });
        continue;
      }
      // waitForShellReady buffer + trailing Enter — the same launch mechanics
      // the renderer's coterm:interactive-agent path uses (#50).
      this.dependencies.terminals.writeWhenShellReady(terminalId, `${command}\r`, "automation");
      relaunched += 1;
    }
    logger.info("app", "sessionRestore.restored", "Restored the previous dock session.", {
      requested: snapshot.panes.length,
      restored: created.length,
      relaunched,
    });
    // Reseal immediately against the LIVE state so a crash right after
    // restore doesn't relaunch the same panes a second time on top of the
    // ones that survived (new terminal ids, same session ids).
    await this.saveNow();
    return { restored: created.length, relaunched };
  }
}
