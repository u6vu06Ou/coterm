/**
 * Agent resource capacity heuristic (2026-10-14, agent "resource board").
 *
 * One pure function, shared by three callers:
 *   1. GET /api/v1/agent/resources (main)     — lets Agent API agents check load
 *      BEFORE spawning N sub-agents.
 *   2. coterm_resources MCP tool (main)       — same data for MCP clients.
 *   3. Renderer soft-limit toast on openTile  — warns when the machine is
 *      saturated but never blocks the open.
 *
 * Budget model (deliberately simple and documented — not a forecast):
 *   - each agent pane costs ~0.6 GiB RAM and ~8% of total CPU;
 *   - keep 20% of total RAM and 25% of total CPU as headroom no matter what;
 *   - the dock caps panes at maxTiles, so capacity never exceeds free tiles.
 *
 * The live CPU%/RAM numbers already INCLUDE the agents that are running, so
 * busy panes are not subtracted again — capacity is computed purely from what
 * remains above the headroom floor.
 *
 * cpuPercent === null means "first sample, load unknown": the CPU constraint
 * is skipped rather than treated as 0% or 100% — neither guess is honest.
 */

export const AGENT_RAM_BUDGET_BYTES = 0.6 * 1024 * 1024 * 1024;
export const AGENT_CPU_BUDGET_PERCENT = 8;
export const CPU_HEADROOM_PERCENT = 25;
export const RAM_HEADROOM_PERCENT = 20;

export interface AgentCapacityInput {
  /** System-wide busy CPU in percent (0-100), or null when not sampled yet. */
  cpuPercent: number | null;
  memUsedBytes: number;
  memTotalBytes: number;
  /** Terminal tiles currently occupying the dock (live + dead placeholders). */
  openTerminals: number;
  /** Hard dock cap (MAX_TILES in dock-layout.ts, MAX_TERMINALS in agent-api.ts). */
  maxTiles: number;
}

export interface AgentCapacity {
  /** How many more agent panes this machine can absorb, 0..free tiles. */
  recommendedMaxNewAgents: number;
  /** Which constraint set the answer (for the UI/logger, not a decision gate). */
  limitedBy: "none" | "cpu" | "memory" | "tiles";
  memPercent: number;
  cpuCapacity: number;
  memCapacity: number;
  freeTiles: number;
}

export function estimateAgentCapacity(input: AgentCapacityInput): AgentCapacity {
  const openTerminals = Math.max(0, Math.floor(input.openTerminals) || 0);
  const maxTiles = Math.max(0, Math.floor(input.maxTiles) || 0);
  const freeTiles = Math.max(0, maxTiles - openTerminals);

  const memTotalBytes = input.memTotalBytes > 0 ? input.memTotalBytes : 0;
  const memUsedBytes = Math.max(0, input.memUsedBytes);
  // RAM budget: everything above the 20% minimum-free floor is fair game.
  const memFreeBudgetBytes = Math.max(0, memTotalBytes * (1 - RAM_HEADROOM_PERCENT / 100) - memUsedBytes);
  const memCapacity = memTotalBytes > 0 ? Math.floor(memFreeBudgetBytes / AGENT_RAM_BUDGET_BYTES) : 0;

  const memPercent = memTotalBytes > 0 ? Math.round((memUsedBytes / memTotalBytes) * 100) : 0;

  let cpuCapacity = freeTiles;
  if (input.cpuPercent !== null && Number.isFinite(input.cpuPercent)) {
    const cpu = Math.max(0, Math.min(100, input.cpuPercent));
    const cpuFreePercent = Math.max(0, 100 - CPU_HEADROOM_PERCENT - cpu);
    cpuCapacity = Math.floor(cpuFreePercent / AGENT_CPU_BUDGET_PERCENT);
  }

  const recommendedMaxNewAgents = Math.max(0, Math.min(freeTiles, memCapacity, cpuCapacity));
  const limitedBy: AgentCapacity["limitedBy"] =
    recommendedMaxNewAgents >= freeTiles && freeTiles <= memCapacity && freeTiles <= cpuCapacity
      ? "tiles"
      : recommendedMaxNewAgents === cpuCapacity && cpuCapacity <= memCapacity
        ? "cpu"
        : recommendedMaxNewAgents === memCapacity
          ? "memory"
          : "none";

  return { recommendedMaxNewAgents, limitedBy, memPercent, cpuCapacity, memCapacity, freeTiles };
}
