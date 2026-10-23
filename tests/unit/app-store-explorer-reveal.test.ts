import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../src/renderer/src/store/app-store";

const originalState = useAppStore.getState();

beforeAll(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
});

afterEach(() => {
  useAppStore.setState(originalState, true);
  vi.restoreAllMocks();
});

describe("requestExplorerReveal", () => {
  it("records the reveal request and opens the explorer", () => {
    const before = Date.now();
    useAppStore.getState().requestExplorerReveal("D:\\proj\\src\\a.ts", "proj-1");
    const after = Date.now();

    const state = useAppStore.getState();
    expect(state.explorerOpen).toBe(true);
    expect(state.explorerRevealRequest?.path).toBe("D:\\proj\\src\\a.ts");
    expect(state.explorerRevealRequest?.projectId).toBe("proj-1");
    expect(state.explorerRevealRequest?.at).toBeGreaterThanOrEqual(before);
    expect(state.explorerRevealRequest?.at).toBeLessThanOrEqual(after);
  });

  it("refreshes on repeat clicks", () => {
    const store = useAppStore.getState();

    store.requestExplorerReveal("D:\\proj\\src\\a.ts", "proj-1");
    const first = useAppStore.getState().explorerRevealRequest;
    expect(first).not.toBeNull();

    store.requestExplorerReveal("D:\\proj\\src\\a.ts", "proj-2");
    const second = useAppStore.getState().explorerRevealRequest;

    expect(second).not.toBeNull();
    expect(second?.at).toBeGreaterThanOrEqual(first!.at);
    expect(second?.path).toBe("D:\\proj\\src\\a.ts");
    expect(second?.projectId).toBe("proj-2");
    expect(second).not.toBe(first);
  });
});
