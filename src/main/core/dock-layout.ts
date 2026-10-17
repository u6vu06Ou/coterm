import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { DockLayout, DockTile, TerminalLabel } from "@shared/types";
import type { PtyManager } from "../terminal/pty-manager";
import type { Repository } from "../storage/repository";
import { assertAllowedPath } from "../security/path-policy";
import { buildActiveProfiles, buildProfileEnv } from "../providers/profiles-config";
import { logger } from "./logger";
import type { WorktreeManager } from "./worktree-manager";

// Raised 8 -> 9 (work order v1.5.41), then 9 -> 12 (1.5.43). Keep in lockstep
// with MAX_TERMINALS in src/main/web/agent-api.ts — the agent API reports its
// own cap and a drift between the two makes the reported availableSlots a lie.
const MAX_TILES = 12;
const DOCK_LAYOUT_FILE = "dock-layout.json";

function validFractions(values: number[]): boolean {
  return values.length > 0 && values.every((value) => Number.isFinite(value) && value > 0);
}

function normalizeFractions(values: number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  return values.map((value) => value / total);
}

/**
 * Resize events are delivered asynchronously. A callback from the previous
 * N-tile render can arrive after tile N+1 opens; accepting that stale shape
 * makes the new tile exist in `tiles` but disappear from the 2D projection.
 */
export function isDockLayoutShapeValid(
  rows: number[],
  cols: number[][],
  tileCount: number,
): boolean {
  if (tileCount === 0) return rows.length === 0 && cols.length === 0;
  if (rows.length !== cols.length || !validFractions(rows)) return false;
  if (cols.some((row) => !validFractions(row))) return false;
  return cols.reduce((count, row) => count + row.length, 0) === tileCount;
}

/**
 * DockLayoutManager — the single source of truth for the terminal dock.
 *
 * Holds an in-memory `DockLayout` (tiles + selection + 2D resize fractions),
 * persists it to a small JSON file under userData, and broadcasts every
 * mutation to all clients (desktop renderer via IPC, web/mobile via WS).
 *
 * See docs/superpowers/specs/2026-06-28-terminal-first-overhaul-design.md
 */
export class DockLayoutManager {
  private layout: DockLayout = { tiles: [], selectedTerminalId: null, exclusiveTerminalId: null, rows: [], cols: [], ptyCols: 100, ptyRows: 28 };
  private readonly filePath: string;
  private readonly listeners = new Set<(layout: DockLayout) => void>();
  private loaded = false;
  private lastExclusiveToggleAt = 0;
  private exclusiveBurstCount = 0;

  constructor(
    private readonly dependencies: {
      terminals: Pick<PtyManager, "create" | "kill" | "get">;
      repository: Pick<Repository, "getProject" | "getSettings">;
      userDataPath: string;
      tempPath: string;
      worktrees?: WorktreeManager;
    },
  ) {
    this.filePath = join(dependencies.userDataPath, DOCK_LAYOUT_FILE);
  }

  /**
   * Register a callback fired on every layout mutation. Returns an unsubscribe.
   * Used by register-ipc.ts (IPC push to desktop renderer) and live-socket.ts
   * (WS push to web/mobile).
   */
  onLayoutChanged(callback: (layout: DockLayout) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /** Lazy-load persisted layout on first access. */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<DockLayout>;
      // Only restore the structural fractions; tiles reference PTYs that no
      // longer exist after a restart, so we start with an empty tile set.
      // The rows/cols fractions are kept so a user's custom layout survives.
      this.layout = {
        tiles: [],
        selectedTerminalId: null,
        exclusiveTerminalId: null,
        rows: Array.isArray(parsed.rows) ? parsed.rows : [],
        cols: Array.isArray(parsed.cols) ? parsed.cols : [],
        ptyCols: typeof parsed.ptyCols === "number" ? parsed.ptyCols : 100,
        ptyRows: typeof parsed.ptyRows === "number" ? parsed.ptyRows : 28,
      };
    } catch {
      // No persisted layout yet — start empty.
      this.layout = { tiles: [], selectedTerminalId: null, exclusiveTerminalId: null, rows: [], cols: [], ptyCols: 100, ptyRows: 28 };
    }
  }

  private async persist(): Promise<void> {
    try {
      // Only persist the resize fractions, not the tiles (PTYs don't survive restart).
      const snapshot = {
        rows: this.layout.rows,
        cols: this.layout.cols,
        ptyCols: this.layout.ptyCols,
        ptyRows: this.layout.ptyRows,
      };
      await mkdir(this.dependencies.userDataPath, { recursive: true });
      await writeFile(this.filePath, JSON.stringify(snapshot), "utf8");
    } catch (error) {
      logger.warn("app", "dockLayout.persist.failed", "Failed to persist dock layout.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private broadcast(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.layout);
      } catch {
        // A listener error must not break other listeners.
      }
    }
  }

  async getDockLayout(): Promise<DockLayout> {
    await this.ensureLoaded();
    return this.layout;
  }

  async openTile(projectId: string, agentProfile?: string, worktreeId?: string, label?: TerminalLabel): Promise<DockLayout> {
    await this.ensureLoaded();
    if (this.layout.tiles.length >= MAX_TILES) {
      throw new Error(`The dock is full (max ${MAX_TILES} tiles).`);
    }
    const project = this.dependencies.repository.getProject(projectId);
    if (!project) throw new Error("Project not found.");
    // A — when a worktreeId is given, the tile runs inside that worktree
    // sandbox: verify the worktree is active and use its path as cwd. No
    // worktreeId → plain project cwd (unchanged behaviour).
    let cwd: string;
    let resolvedWorktreeId: string | undefined;
    if (worktreeId) {
      const worktrees = this.dependencies.worktrees;
      if (!worktrees) throw new Error("Worktree sandboxes are unavailable.");
      const worktree = worktrees.get(worktreeId);
      if (!worktree) throw new Error("Worktree not found.");
      if (worktree.projectId !== projectId) {
        throw new Error("Worktree does not belong to this project.");
      }
      if (worktree.status !== "active") {
        throw new Error(`Worktree is not active (status: ${worktree.status}).`);
      }
      cwd = await assertAllowedPath(worktree.worktreePath, {
        roots: [join(this.dependencies.userDataPath, "worktrees")],
      });
      resolvedWorktreeId = worktreeId;
    } else {
      cwd = await assertAllowedPath(project.workspacePath, {
        roots: [project.workspacePath, this.dependencies.userDataPath, this.dependencies.tempPath],
      });
    }
    const settings = this.dependencies.repository.getSettings();
    // Agent tile: inject profile env at spawn (no terminal echo). Plain tile
    // when agentProfile is absent. Env built from profiles-config (single SoT
    // shared with claude-adapter) — renderer never touches the auth token.
    const agentEnv = agentProfile
      ? buildProfileEnv(agentProfile, settings.proxyUrl, buildActiveProfiles(settings.customProfiles))
      : undefined;
    const terminal = this.dependencies.terminals.create({
      projectId,
      profile: settings.defaultShell,
      cwd,
      isAgent: Boolean(agentProfile),
      agentProfile: agentProfile ?? null,
      agentEnv,
      ...(resolvedWorktreeId ? { worktreeId: resolvedWorktreeId } : {}),
      ...(label ? { label } : {}),
    });
    const tile: DockTile = {
      terminalId: terminal.id,
      projectId,
      weight: 1,
      agentProfile: agentProfile ?? null,
      label: label ?? null,
    };
    this.layout = {
      tiles: [...this.layout.tiles, tile],
      selectedTerminalId: terminal.id,
      exclusiveTerminalId: null,
      rows: [],
      cols: [],
      ptyCols: this.layout.ptyCols,
      ptyRows: this.layout.ptyRows,
    };
    this.recomputeEvenSplit();
    await this.persist();
    this.broadcast();
    return this.layout;
  }

  async closeTile(terminalId: string): Promise<DockLayout> {
    await this.ensureLoaded();
    const index = this.layout.tiles.findIndex((t) => t.terminalId === terminalId);
    if (index === -1) throw new Error("Tile not found in the dock.");
    // Kill the PTY (best-effort — it may have already exited).
    try {
      this.dependencies.terminals.kill(terminalId);
    } catch {
      // PTY may already be gone; continue removing the tile.
    }
    return this.removeTileAt(index, terminalId);
  }

  /**
   * 殭屍格回收（1.5.44, next-rev board「開窗失敗留空白殭屍分頁」）: a PTY that
   * exits on its own (immediate spawn death, `exit`, crash) leaves its tile in
   * the dock — PtyManager deletes the registry entry, so the renderer can no
   * longer hydrate the pane and it becomes a permanently blank "Loading
   * terminal..." placeholder with no close button that still counts toward
   * MAX_TILES. Retrying window opens then fill the dock with dead panes until
   * "dock is full". Hook: every terminalExit event removes the matching tile.
   * Idempotent: closeTile also kills (which emits terminalExit), so this must
   * no-op when the tile is already gone or was never in the dock.
   */
  async handleTerminalExit(terminalId: string): Promise<void> {
    await this.ensureLoaded();
    const index = this.layout.tiles.findIndex((t) => t.terminalId === terminalId);
    if (index === -1) return;
    logger.info("app", "dockLayout.tile.reclaim", "Reclaimed dock tile of an exited terminal.", {
      terminalId,
      tileCount: this.layout.tiles.length - 1,
    });
    await this.removeTileAt(index, terminalId);
  }

  /** Shared tile-removal core for closeTile / handleTerminalExit. */
  private async removeTileAt(index: number, terminalId: string): Promise<DockLayout> {
    const remaining = this.layout.tiles.filter((t) => t.terminalId !== terminalId);
    // Reselect: prefer the neighbor to the right, else the previous tile, else null.
    let selected: string | null = null;
    if (remaining.length > 0) {
      selected = (remaining[index]?.terminalId ?? remaining[index - 1]?.terminalId ?? remaining[0]!.terminalId);
    }
    // Clear exclusive if it pointed at the closed tile (or a stale id).
    const exclusive = this.layout.exclusiveTerminalId && remaining.some((t) => t.terminalId === this.layout.exclusiveTerminalId)
      ? this.layout.exclusiveTerminalId
      : null;
    this.layout = {
      tiles: remaining,
      selectedTerminalId: selected,
      exclusiveTerminalId: exclusive,
      rows: [],
      cols: [],
      ptyCols: this.layout.ptyCols,
      ptyRows: this.layout.ptyRows,
    };
    this.recomputeEvenSplit();
    await this.persist();
    this.broadcast();
    return this.layout;
  }

  /**
   * 拖曳排序（next-rev board, 1.5.47）: move a tile to a new index. Tile count
   * is unchanged, so the 2D rows/cols fractions stay exactly as the user sized
   * them — only the row-major projection order follows the new tile order.
   * No-op (but still authoritatively re-broadcast) when the target equals the
   * current index or the tile/shape is invalid.
   */
  async reorderTile(terminalId: string, toIndex: number): Promise<DockLayout> {
    await this.ensureLoaded();
    const fromIndex = this.layout.tiles.findIndex((t) => t.terminalId === terminalId);
    if (fromIndex === -1) throw new Error("Tile not found in the dock.");
    const clamped = Math.max(0, Math.min(this.layout.tiles.length - 1, Math.trunc(toIndex)));
    if (clamped !== fromIndex) {
      const tiles = [...this.layout.tiles];
      const [moved] = tiles.splice(fromIndex, 1);
      tiles.splice(clamped, 0, moved!);
      this.layout = { ...this.layout, tiles };
      await this.persist();
    }
    this.broadcast();
    return this.layout;
  }

  async selectTile(terminalId: string): Promise<DockLayout> {
    await this.ensureLoaded();
    const exists = this.layout.tiles.some((t) => t.terminalId === terminalId);
    if (!exists) throw new Error("Tile not found in the dock.");
    this.layout = { ...this.layout, selectedTerminalId: terminalId };
    this.broadcast();
    return this.layout;
  }

  async setExclusive(terminalId: string | null): Promise<DockLayout> {
    await this.ensureLoaded();
    // Issue #15 diagnostics: the reported app hang follows a rapid
    // 展開→單一→展開 toggle sequence after long uptime. Log every toggle with
    // the gap since the previous one so a live occurrence leaves evidence in
    // coterm.log, and warn on a bursty pattern (≥4 toggles inside ~400ms
    // windows) which is the trigger shape from the report.
    const now = Date.now();
    const msSincePrevious = this.lastExclusiveToggleAt === 0 ? null : now - this.lastExclusiveToggleAt;
    this.lastExclusiveToggleAt = now;
    if (msSincePrevious !== null && msSincePrevious < 400) {
      this.exclusiveBurstCount += 1;
    } else {
      this.exclusiveBurstCount = 0;
    }
    logger.info("app", "dockLayout.exclusive.toggle", "Exclusive terminal view toggled.", {
      terminalId: terminalId ?? "all",
      tileCount: this.layout.tiles.length,
      msSincePrevious: msSincePrevious ?? "first",
    });
    if (this.exclusiveBurstCount === 3) {
      logger.warn("app", "dockLayout.exclusive.burst", "Rapid exclusive/grid layout toggling detected; renderer coalescing should have collapsed this burst.", {
        tileCount: this.layout.tiles.length,
      });
    }
    if (terminalId !== null) {
      const exists = this.layout.tiles.some((t) => t.terminalId === terminalId);
      if (!exists) throw new Error("Tile not found in the dock.");
      // Entering exclusive also selects — keeps the two in sync (design point ③).
      this.layout = { ...this.layout, exclusiveTerminalId: terminalId, selectedTerminalId: terminalId };
    } else {
      this.layout = { ...this.layout, exclusiveTerminalId: null };
    }
    this.broadcast();
    return this.layout;
  }

  async setDockLayout(rows: number[], cols: number[][]): Promise<DockLayout> {
    await this.ensureLoaded();
    if (!isDockLayoutShapeValid(rows, cols, this.layout.tiles.length)) {
      logger.warn("app", "dockLayout.resize.stale", "Ignored a stale or invalid dock resize shape.", {
        tileCount: this.layout.tiles.length,
        rowCount: rows.length,
        projectedTileCount: cols.reduce((count, row) => count + row.length, 0),
      });
      // Return and re-broadcast the authoritative shape so a stale renderer
      // heals immediately instead of waiting for the next tile mutation.
      this.broadcast();
      return this.layout;
    }
    this.layout = {
      ...this.layout,
      rows: normalizeFractions(rows),
      cols: cols.map(normalizeFractions),
    };
    await this.persist();
    this.broadcast();
    return this.layout;
  }

  /**
   * Update the shared PTY geometry (cols/rows) — the main-process SoT.
   * Called by app-operations.resizeTerminal after resizing the actual PTY,
   * so all clients (web/mobile) receive the new geometry via broadcast and
   * resize their local xterm to match, preventing re-wrap garble.
   */
  async setPtyGeometry(cols: number, rows: number): Promise<DockLayout> {
    await this.ensureLoaded();
    if (this.layout.ptyCols === cols && this.layout.ptyRows === rows) return this.layout;
    this.layout = { ...this.layout, ptyCols: cols, ptyRows: rows };
    await this.persist();
    this.broadcast();
    return this.layout;
  }

  /**
   * Even-split helper: row-major grid with `ceil(sqrt(n))` columns.
   * 1→1×1, 2→1×2, 3-4→2×2, 5-6→2×3, 7-8→2×4.
   * Resets rows/cols to even fractions; called after tile add/remove.
   */
  private recomputeEvenSplit(): void {
    const n = this.layout.tiles.length;
    if (n === 0) {
      this.layout.rows = [];
      this.layout.cols = [];
      return;
    }
    const numCols = Math.ceil(Math.sqrt(n));
    const numRows = Math.ceil(n / numCols);
    this.layout.rows = Array.from({ length: numRows }, () => 1 / numRows);
    this.layout.cols = [];
    for (let row = 0; row < numRows; row++) {
      const start = row * numCols;
      const count = Math.min(numCols, n - start);
      this.layout.cols.push(Array.from({ length: count }, () => 1 / count));
    }
  }
}
