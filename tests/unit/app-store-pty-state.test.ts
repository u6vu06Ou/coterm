import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../src/renderer/src/store/app-store";
import { computeFleetCounts } from "../../src/renderer/src/components/fleet-state";
import type { PtyState, TerminalDashboardEntry } from "../../src/shared/types";

const originalState = useAppStore.getState();

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

beforeAll(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
});

afterEach(() => {
  useAppStore.setState(originalState, true);
  vi.restoreAllMocks();
});

function makeEntry(id: string, ptyState: PtyState): TerminalDashboardEntry {
  return {
    id,
    pid: 1234,
    projectId: "00000000-0000-4000-8000-000000000000",
    cwd: "C:\\proj",
    profile: "pwsh",
    agentProfile: null,
    title: "",
    ptyState,
    weight: 1,
    selected: false,
    isAgent: false,
    ownedByAgentApi: false,
    lastCommand: null,
  };
}

describe("app-store canonical PtyState projection (Issue #2)", () => {
  it("hydratePtyStates seeds ptyStates from the dashboard snapshot", async () => {
    const getTerminalDashboard = vi.fn().mockResolvedValue([
      makeEntry(T1, "running"),
      makeEntry(T2, "error"),
    ]);
    Object.defineProperty(window, "aiTerminal", {
      configurable: true,
      value: { getTerminalDashboard },
    });

    await useAppStore.getState().hydratePtyStates();

    const states = useAppStore.getState().ptyStates;
    expect(states[T1]).toBe("running");
    expect(states[T2]).toBe("error");
    expect(getTerminalDashboard).toHaveBeenCalledTimes(1);
  });

  it("hydratePtyStates is best-effort — a rejected dashboard does not throw", async () => {
    const getTerminalDashboard = vi.fn().mockRejectedValue(new Error("rpc down"));
    Object.defineProperty(window, "aiTerminal", {
      configurable: true,
      value: { getTerminalDashboard },
    });

    await expect(useAppStore.getState().hydratePtyStates()).resolves.toBeUndefined();
    expect(useAppStore.getState().ptyStates).toEqual({});
  });

  it("fleet counts recompute from the canonical map (no stored counters)", () => {
    useAppStore.setState({
      ptyStates: { [T1]: "running", [T2]: "waiting_input" },
    });
    const states = useAppStore.getState().ptyStates;
    const tiles = [
      { terminalId: T1, isAgent: true },
      { terminalId: T2, isAgent: true },
    ];
    const counts = computeFleetCounts(tiles, states);
    expect(counts.running).toBe(1);
    expect(counts.needYou).toBe(1);
    expect(counts.total).toBe(2);
  });

  it("ptyStates starts empty before hydration", () => {
    useAppStore.setState(originalState, true);
    expect(useAppStore.getState().ptyStates).toEqual({});
  });
});
