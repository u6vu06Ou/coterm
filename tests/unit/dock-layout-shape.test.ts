import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DockLayoutManager, isDockLayoutShapeValid } from "../../src/main/core/dock-layout";
import type { DockLayout, Project, TerminalInfo } from "../../src/shared/types";

/** Build a dock with N tiles (ids t0..tN-1) over a real temp workspace dir. */
async function makeDock(tileCount: number): Promise<{ dock: DockLayoutManager; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "coterm-dock-reorder-"));
  let counter = 0;
  const terminals = {
    create: vi.fn((input: { cwd: string }) => {
      const id = `t${counter++}`;
      return { id, cwd: input.cwd } as TerminalInfo;
    }),
    kill: vi.fn(),
    get: vi.fn().mockReturnValue(null),
  };
  const repository = {
    getProject: vi.fn(
      (id: string): Project =>
        ({ id, name: id, workspacePath: dir, lastOpenedAt: null, collapsed: false, pinned: false, sortOrder: 0 }) as unknown as Project,
    ),
    // No agentProfile on these tiles → buildProfileEnv is skipped, so a bare
    // defaultShell is enough for the create() call.
    getSettings: vi.fn(() => ({ defaultShell: "pwsh" })),
  };
  const dock = new DockLayoutManager({
    terminals: terminals as never,
    repository: repository as never,
    userDataPath: dir,
    tempPath: dir,
  });
  for (let i = 0; i < tileCount; i++) await dock.openTile(`p-${i}`);
  return { dock, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const tileIds = (layout: DockLayout): string[] => layout.tiles.map((t) => t.terminalId);

describe("dock layout shape guard", () => {
  it("accepts a complete four-tile 2x2 projection", () => {
    expect(isDockLayoutShapeValid([0.5, 0.5], [[0.5, 0.5], [0.5, 0.5]], 4)).toBe(true);
  });

  it("rejects the stale three-tile callback that used to hide tile four", () => {
    expect(isDockLayoutShapeValid([0.5, 0.5], [[0.5, 0.5], [1]], 4)).toBe(false);
  });

  it("rejects invalid fractions and mismatched row metadata", () => {
    expect(isDockLayoutShapeValid([1], [[0, 1]], 2)).toBe(false);
    expect(isDockLayoutShapeValid([1], [[1], [1]], 2)).toBe(false);
  });
});

describe("DockLayoutManager.reorderTile (drag reorder, 1.5.47)", () => {
  // 拖曳排序: 把某 tile 搬到新 index，tiles 順序隨之變，rows/cols 保留。
  it("moves the second tile to the front and keeps the rest in order", async () => {
    const { dock, cleanup } = await makeDock(3);
    try {
      const layout = await dock.reorderTile("t1", 0);
      expect(tileIds(layout)).toEqual(["t1", "t0", "t2"]);
    } finally {
      await cleanup();
    }
  });

  // 同 index = 位置不變，但仍 authoritative re-broadcast（不 persist、不縮排）。
  it("keeps the order but still re-broadcasts when the target equals the current index", async () => {
    const { dock, cleanup } = await makeDock(3);
    try {
      const broadcasts: DockLayout[] = [];
      dock.onLayoutChanged((layout) => broadcasts.push(layout));
      const layout = await dock.reorderTile("t1", 1);
      expect(tileIds(layout)).toEqual(["t0", "t1", "t2"]);
      expect(broadcasts).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it("rejects an unknown terminal id with a clear message", async () => {
    const { dock, cleanup } = await makeDock(2);
    try {
      await expect(dock.reorderTile("missing", 0)).rejects.toThrow("Tile not found in the dock.");
    } finally {
      await cleanup();
    }
  });

  // 越界 clamp：toIndex 大於最後一個 index → 搬到最後一位，不拋錯。
  it("clamps an out-of-range target index to the last slot", async () => {
    const { dock, cleanup } = await makeDock(3);
    try {
      const layout = await dock.reorderTile("t0", 99);
      expect(tileIds(layout)).toEqual(["t1", "t2", "t0"]);
    } finally {
      await cleanup();
    }
  });
});
