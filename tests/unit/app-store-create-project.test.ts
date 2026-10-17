import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Project } from "@shared/types";
import { isPendingProject, useAppStore } from "../../src/renderer/src/store/app-store";

const originalState = useAppStore.getState();

const existingProject: Project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Existing",
  workspacePath: "D:\\code\\existing",
  pinned: false,
  order: 0,
  archived: false,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

function makeResolvedProject(workspacePath: string): Project {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    name: workspacePath.split(/[\\/]/).filter(Boolean).at(-1) ?? "Workspace",
    workspacePath,
    pinned: false,
    order: 0,
    archived: false,
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
  };
}

beforeAll(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
});

afterEach(() => {
  useAppStore.setState(originalState, true);
  vi.restoreAllMocks();
});

describe("createProject placeholder (issue #17)", () => {
  it("shows the placeholder before the create IPC resolves, then swaps it in", async () => {
    let resolveCreate!: (project: Project) => void;
    const createPromise = new Promise<Project>((done) => { resolveCreate = done; });
    const createProject = vi.fn(() => createPromise);
    Object.defineProperty(window, "aiTerminal", {
      configurable: true,
      value: {
        pickWorkspace: vi.fn().mockResolvedValue("D:\\code\\new-project"),
        createProject,
      },
    });
    useAppStore.setState({ projects: [existingProject], error: null });

    const started = performance.now();
    const request = useAppStore.getState().createProject();

    // Let the picker resolve and the placeholder state update flush.
    await vi.waitFor(() => {
      expect(useAppStore.getState().projects.some(isPendingProject)).toBe(true);
    });
    const placeholderVisibleMs = performance.now() - started;

    // Issue #17 acceptance: user sees feedback in the list under 500ms.
    console.info(`[#17] placeholder visible in ${placeholderVisibleMs.toFixed(1)} ms while the create IPC is still in flight`);
    expect(placeholderVisibleMs).toBeLessThan(500);

    const state = useAppStore.getState();
    const placeholder = state.projects.find(isPendingProject);
    expect(placeholder).toBeDefined();
    expect(placeholder!.name).toBe("new-project");
    expect(placeholder!.workspacePath).toBe("D:\\code\\new-project");
    // Placeholder goes first so it appears at the top of the list.
    expect(state.projects[0]!.id).toBe(placeholder!.id);

    // The creation completes later — row swaps to the real project in place.
    const real = makeResolvedProject("D:\\code\\new-project");
    resolveCreate(real);
    await request;

    const after = useAppStore.getState().projects;
    expect(after.some(isPendingProject)).toBe(false);
    expect(after[0]).toEqual(real);
    expect(after).toHaveLength(2);
  });

  it("removes the placeholder and exposes the error when creation fails", async () => {
    let rejectCreate!: (error: Error) => void;
    const createPromise = new Promise<Project>((_resolve, reject) => { rejectCreate = reject; });
    Object.defineProperty(window, "aiTerminal", {
      configurable: true,
      value: {
        pickWorkspace: vi.fn().mockResolvedValue("D:\\code\\broken"),
        createProject: vi.fn(() => createPromise),
      },
    });
    useAppStore.setState({ projects: [existingProject], error: null });

    const request = useAppStore.getState().createProject();
    await vi.waitFor(() => {
      expect(useAppStore.getState().projects.some(isPendingProject)).toBe(true);
    });

    rejectCreate(new Error("disk full"));
    await request;

    expect(useAppStore.getState().projects).toEqual([existingProject]);
    expect(useAppStore.getState().error).toBe("disk full");
  });

  it("does not create duplicate rows while a placeholder for the same workspace is pending", async () => {
    const neverResolving = new Promise<Project>(() => {});
    const createProject = vi.fn(() => neverResolving);
    Object.defineProperty(window, "aiTerminal", {
      configurable: true,
      value: {
        pickWorkspace: vi.fn().mockResolvedValue("D:\\code\\dup"),
        createProject,
      },
    });
    useAppStore.setState({ projects: [existingProject], error: null });

    const first = useAppStore.getState().createProject();
    await vi.waitFor(() => {
      expect(useAppStore.getState().projects.some(isPendingProject)).toBe(true);
    });

    const second = useAppStore.getState().createProject();
    await second;

    expect(createProject).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().projects.filter(isPendingProject)).toHaveLength(1);
    // Keep the hanging promise alive without leaking the test.
    void first;
  });
});
