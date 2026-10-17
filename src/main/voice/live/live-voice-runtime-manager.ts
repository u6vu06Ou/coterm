export type LiveVoiceRuntimeState = "stopped" | "starting" | "ready" | "degraded";

export interface LiveVoiceManagedProcess {
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<boolean> | boolean;
  onExit?(listener: (reason?: unknown) => void): () => void;
}

export interface LiveVoiceRuntimeManagerDeps {
  server: LiveVoiceManagedProcess;
  worker: LiveVoiceManagedProcess;
  onStateChanged?: (state: LiveVoiceRuntimeState, reason?: string) => void;
}

/**
 * Owns optional realtime processes without coupling their lifecycle to Coterm.
 * A crash becomes `degraded`; it is never escalated to process.exit or PTY
 * shutdown. Concrete LiveKit process adapters are supplied after dependency
 * approval.
 */
export class LiveVoiceRuntimeManager {
  private state: LiveVoiceRuntimeState = "stopped";
  private unsubs: Array<() => void> = [];

  constructor(private readonly deps: LiveVoiceRuntimeManagerDeps) {}

  getState(): LiveVoiceRuntimeState {
    return this.state;
  }

  async start(): Promise<LiveVoiceRuntimeState> {
    if (this.state === "ready" || this.state === "starting") return this.state;
    this.setState("starting");
    this.bindExitHandlers();
    try {
      await this.deps.server.start();
      await this.deps.worker.start();
      const [serverHealthy, workerHealthy] = await Promise.all([
        this.deps.server.health(),
        this.deps.worker.health(),
      ]);
      if (!serverHealthy || !workerHealthy) {
        this.setState("degraded", "Live Voice process health check failed.");
        return this.state;
      }
      this.setState("ready");
    } catch (error) {
      this.setState("degraded", safeReason(error));
    }
    return this.state;
  }

  async health(): Promise<LiveVoiceRuntimeState> {
    if (this.state === "stopped") return this.state;
    try {
      const [serverHealthy, workerHealthy] = await Promise.all([
        this.deps.server.health(),
        this.deps.worker.health(),
      ]);
      this.setState(serverHealthy && workerHealthy ? "ready" : "degraded",
        serverHealthy && workerHealthy ? undefined : "Live Voice process health check failed.");
    } catch (error) {
      this.setState("degraded", safeReason(error));
    }
    return this.state;
  }

  async stop(): Promise<void> {
    const tasks = [this.deps.worker.stop(), this.deps.server.stop()];
    await Promise.allSettled(tasks);
    this.unbindExitHandlers();
    this.setState("stopped");
  }

  private bindExitHandlers(): void {
    this.unbindExitHandlers();
    for (const process of [this.deps.server, this.deps.worker]) {
      const unsub = process.onExit?.((reason) => this.setState("degraded", safeReason(reason ?? "Live Voice process exited.")));
      if (unsub) this.unsubs.push(unsub);
    }
  }

  private unbindExitHandlers(): void {
    for (const unsub of this.unsubs.splice(0)) unsub();
  }

  private setState(state: LiveVoiceRuntimeState, reason?: string): void {
    this.state = state;
    this.deps.onStateChanged?.(state, reason);
  }
}

function safeReason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 240);
}
