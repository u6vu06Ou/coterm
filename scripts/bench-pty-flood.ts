/**
 * PTY flood benchmark (2026-09-27, per .review/2026-09-27-perf-size-eval.md A ③).
 *
 * Simulates 8 terminals flooding output through a real PtyManager, once in the
 * synchronous per-chunk mode ({ outputFlushMs: 0 } — the pre-coalescing baseline)
 * and once with the default 16ms coalescing window. Each bus "terminalData"
 * emission = one downstream handler invocation (in the real app each one fans
 * out to an IPC JSON forward per window + a WS frame per subscribed client), so
 * the emission count is the number the coalescer exists to crush.
 *
 * No real PTY processes are spawned: fixtures are injected into the manager's
 * terminal map and driven through the same chunk-ingest path the onData handler
 * uses. The agent worst-case arm tracks a real AgentDetectionEngine (MAX_TRACKED
 * is exactly 8) so the per-flush agent pipeline cost lands in the same loop.
 *
 * Synthetic handler-invocation benchmark only — visual echo latency and main
 * CPU% during a real flood remain the real-world checks from the eval doc.
 *
 * Run: npx tsx scripts/bench-pty-flood.ts
 */

import { AppEventBus } from "../src/main/core/event-bus";
import { PtyManager } from "../src/main/terminal/pty-manager";
import { DecModeTracker } from "../src/main/terminal/dec-modes";

const TERMINALS = 8;
const CHUNKS_PER_TERMINAL = 200;
const CHUNK_CHARS = 4096;

/** Minimal shape of a ManagedTerminal fixture (exactly the fields the flush path touches). */
interface FixtureLike {
  info: {
    id: string;
    projectId: string;
    isAgent: boolean;
    agentProfile: string | null;
    status: "running" | "exited";
  };
  scrollback: string[];
  scrollbackLength: number;
  decModes: DecModeTracker;
  ptyState: string;
  ptyStateSource: string;
}

/** Manager internals + private chunk ingest, cast once. */
interface ManagerInternals {
  terminals: Map<string, FixtureLike>;
  _onPtyChunk(t: FixtureLike, chunk: string): void;
  events: AppEventBus;
  agentDetection: {
    trackTerminal(input: { terminalId: string; agentProfile: string; cols: number; rows: number }): void;
  };
}

/** One 4096-char single-line chunk per terminal per round; no ESC bytes. */
function buildChunk(id: string, round: number): string {
  return `${id}_${round}x`.padEnd(CHUNK_CHARS, "x");
}

function makeFixture(id: string): FixtureLike {
  return {
    info: {
      id,
      projectId: "proj-bench",
      isAgent: false,
      agentProfile: null,
      status: "running",
    },
    scrollback: [],
    scrollbackLength: 0,
    decModes: new DecModeTracker(),
    ptyState: "done",
    ptyStateSource: "process",
  };
}

/**
 * Drain until stable: the 16ms flush timers and the 50ms agent evaluation
 * timer both keep running after the drive loop, so wait in 30ms steps until
 * the emission count is unchanged across two consecutive steps (min ~90ms).
 */
async function settle(emissionCount: () => number): Promise<number> {
  const start = performance.now();
  let last = -1;
  let stable = 0;
  for (let i = 0; i < 20 && stable < 2; i += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30);
    });
    const total = emissionCount();
    if (total === last) stable += 1;
    else stable = 0;
    last = total;
  }
  return performance.now() - start;
}

async function runFlood(opts: {
  flushMs: number;
  agentPipeline: boolean;
}): Promise<{ driveMs: number; emissions: number; settleMs: number; bytes: number }> {
  const manager = new PtyManager(new AppEventBus(), 2, undefined, {
    outputFlushMs: opts.flushMs,
  });
  const internals = manager as unknown as ManagerInternals;

  let emissions = 0;
  let bytes = 0;
  internals.events.on("terminalData", (message) => {
    emissions += 1;
    bytes += message.data.length;
  });
  const fixtures = new Map<string, FixtureLike>();
  for (let i = 0; i < TERMINALS; i += 1) {
    const id = `bench-${i}`;
    const fixture = makeFixture(id);
    fixtures.set(id, fixture);
    internals.terminals.set(id, fixture);
  }
  if (opts.agentPipeline) {
    for (const fixture of fixtures.values()) {
      fixture.info.isAgent = true;
      internals.agentDetection.trackTerminal({
        terminalId: fixture.info.id,
        agentProfile: "claude-code",
        cols: 100,
        rows: 28,
      });
    }
  }

  const driveStart = performance.now();
  for (let round = 0; round < CHUNKS_PER_TERMINAL; round += 1) {
    for (const fixture of fixtures.values()) {
      internals._onPtyChunk(fixture, buildChunk(fixture.info.id, round));
    }
    // Real floods arrive with event-loop turns; yield so 16ms flush timers and
    // the 50ms agent evaluation timer get their turns too.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const driveMs = performance.now() - driveStart;

  const settleMs = await settle(() => emissions);
  return { driveMs, emissions, settleMs, bytes };
}

async function main(): Promise<void> {
  const expectedBytes = TERMINALS * CHUNKS_PER_TERMINAL * CHUNK_CHARS;

  const phases: Array<{ label: string; agentPipeline: boolean; flushMs: number }> = [
    { label: "shell, sync per-chunk (baseline)", agentPipeline: false, flushMs: 0 },
    { label: "shell, coalesced 16ms", agentPipeline: false, flushMs: 16 },
    { label: "agent pipeline, sync per-chunk", agentPipeline: true, flushMs: 0 },
    { label: "agent pipeline, coalesced 16ms", agentPipeline: true, flushMs: 16 },
  ];

  const rows: string[] = [];
  for (const phase of phases) {
    const result = await runFlood({
      flushMs: phase.flushMs,
      agentPipeline: phase.agentPipeline,
    });
    const ok = result.bytes === expectedBytes;
    rows.push(
      `${phase.label.padEnd(34)} ${result.driveMs.toFixed(1).padStart(9)} ms  ` +
      `${String(result.emissions).padStart(5)} emissions  ` +
      `${(result.emissions / TERMINALS).toFixed(1).padStart(6)} /terminal  ` +
      `${result.settleMs.toFixed(0).padStart(4)} ms settle` +
      (ok ? "" : `  !! bytes mismatch: got ${result.bytes}`)
    );
  }

  console.log("PTY flood benchmark — 8 terminals x 200 chunks x 4096 chars");
  console.log("one terminalData emission = 1 downstream handler invocation");
  console.log("");
  console.log(
    "phase".padEnd(34) +
    "ingest".padStart(13) +
    "emissions".padStart(12) +
    "/terminal".padStart(11) +
    "settle".padStart(8)
  );
  for (const row of rows) console.log(row);
  console.log("");
  console.log("Synthetic handler-invocation benchmark; visual echo latency and");
  console.log("main CPU% in the real app remain the real-world flood checks.");
}

main().catch((error) => {
  console.error("Bench failed:", error);
  process.exit(1);
});
