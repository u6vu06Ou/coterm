import { fork, type ChildProcess } from "node:child_process";
import type { LiveVoiceManagedProcess } from "./live-voice-runtime-manager";
import { parseWorkerEvent, type LiveVoiceWorkerEvent } from "./live-voice-worker-bridge";
import { sendWorkerCommand, type LiveVoiceWorkerCommand } from "./livekit-worker-commands";

export interface LivekitWorkerProcessDeps {
  workerEntryPath: string;
  /** COTERM_LIVEKIT_* map from livekit-worker-env. Carries secrets; never log. */
  env: Record<string, string>;
  forkFn?: typeof fork;
  /** Sink for validated worker→main events (the LiveVoiceWorkerBridge). */
  onEvent?: (event: LiveVoiceWorkerEvent) => void;
  /**
   * Bounded wall-clock budget to wait for the worker's explicit ready handshake
   * (work order §1). Replaces the old fixed 250 ms guess. Injectable for tests.
   */
  startupTimeoutMs?: number;
}

type WorkerPhase = "starting" | "ready" | "terminated" | "exited";

/**
 * Forks the worker entry as plain Node (ELECTRON_RUN_AS_NODE=1 on the child
 * env only). Worker→main stays on the original 4-event protocol; an
 * unrecognized message is dropped, a malformed one never reaches the bridge.
 *
 * Startup is driven by the worker's own `health:"ready"` message rather than a
 * fixed delay: the worker only signals ready once its LiveKit room has
 * connected. A bounded `startMs` caps the wait; a startup error, an early exit,
 * or the timeout itself surfaces a safe, content-free reason.
 */
export class LivekitWorkerProcess implements LiveVoiceManagedProcess {
  private child: ChildProcess | null = null;
  private lastHealth: "ready" | "degraded" | null = null;
  private phase: WorkerPhase = "exited";
  private readonly exitListeners = new Set<(reason?: unknown) => void>();
  private readyResolve: (() => void) | null = null;
  private readyReject: ((reason: Error) => void) | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: LivekitWorkerProcessDeps) {}

  async start(): Promise<void> {
    if (this.child) return;
    const timeoutMs = this.deps.startupTimeoutMs ?? LIVEKIT_WORKER_STARTUP_TIMEOUT_MS;
    const forkFn = this.deps.forkFn ?? fork;

    const ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = (reason: Error) => reject(reason);
    });

    const child = forkFn(this.deps.workerEntryPath, [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...this.deps.env },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.child = child;
    this.phase = "starting";

    const settleStartup = (reason: Error): boolean => {
      // First terminal signal wins; once ready (or already settled) is a no-op.
      if (this.phase !== "starting") return false;
      this.phase = "terminated";
      this.clearStartupTimer();
      this.child = null;
      const reject = this.readyReject;
      this.readyResolve = null;
      this.readyReject = null;
      reject?.(reason);
      return true;
    };

    child.once("error", (error) => {
      settleStartup(error instanceof Error ? error : new Error("Live Voice worker failed to start."));
    });
    child.once("exit", (code, signal) => {
      if (code === 0 && this.phase === "ready") return;
      settleStartup(new Error(`Live Voice worker exited after fork (code=${code ?? "null"}, signal=${signal ?? "null"}).`));
    });

    const timer = setTimeout(() => {
      settleStartup(new Error(`Live Voice worker failed to report ready within ${timeoutMs} ms.`));
    }, timeoutMs);
    // Never keep the Node loop alive just for a startup deadline.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.startupTimer = timer;

    child.on("message", (raw: unknown) => this.acceptMessage(raw));
    // Runtime death *after* ready surfaces through exit listeners (manager-level
    // degradation). Startup-phase death is handled by settleStartup above.
    const onRuntimeDeath = (): void => {
      if (this.phase !== "ready") return;
      this.notifyExit(new Error("Live Voice worker ended."));
    };
    child.on("error", onRuntimeDeath);
    child.on("exit", onRuntimeDeath);

    await ready;
  }

  private clearStartupTimer(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  send(command: LiveVoiceWorkerCommand): boolean {
    return sendWorkerCommand(this.child, command);
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.lastHealth = null;
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.phase === "starting") {
      // Startup handshake never completed; settle the pending promise so it does
      // not linger until the (much larger) startup timeout.
      const reject = this.readyReject;
      this.readyResolve = null;
      this.readyReject = null;
      this.phase = "exited";
      reject?.(new Error("Live Voice worker stopped during startup."));
      if (!child) return;
    } else {
      this.phase = "exited";
      this.readyResolve = null;
      this.readyReject = null;
    }
    if (!child) return;
    sendWorkerCommand(child, { type: "shutdown" });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
        resolve();
      }, 3_000);
      (timer as unknown as { unref?: () => void }).unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  health(): boolean {
    return this.child === null || this.child.exitCode !== null ? false : this.lastHealth === "ready";
  }

  onExit(listener: (reason?: unknown) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  private acceptMessage(raw: unknown): void {
    try {
      const event = parseWorkerEvent(raw);
      if (event.type === "health") {
        this.lastHealth = event.state;
        this.deps.onEvent?.(event);
        // Only the FIRST ready signal ends the startup wait; any later
        // degraded/reconnect health still reaches onEvent for diagnostics.
        if (event.state === "ready" && this.phase === "starting") {
          this.clearStartupTimer();
          this.phase = "ready";
          const resolve = this.readyResolve;
          this.readyResolve = null;
          this.readyReject = null;
          resolve?.();
        }
      }
      // transport / stage / speech events flow through unchanged.
    } catch {
      // Worker emitted garbage — the bridge validation already rejected it.
    }
  }

  private notifyExit(reason?: unknown): void {
    for (const listener of [...this.exitListeners]) listener(reason);
  }
}

/**
 * Default wall-clock budget for a worker to report ready. A LiveKit WS connect
 * plus token verify + track subscribe takes well under this on a healthy loop,
 * but a bounded value keeps a wedged worker from pinning the runtime forever.
 */
export const LIVEKIT_WORKER_STARTUP_TIMEOUT_MS = 20_000;
