import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import type { LiveVoiceManagedProcess } from "./live-voice-runtime-manager";

export interface LivekitServerProcessDeps {
  executablePath: string;
  apiKey: string;
  apiSecret: string;
  host?: string;
  port?: number;
  /** Injectable for tests. */
  spawnFn?: typeof spawn;
  connectFn?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  readyTimeoutMs?: number;
}

/**
 * Runs the pinned livekit-server binary bound to loopback. The API key/secret
 * ride in spawn args and are never logged (work order §1.1/§1.7). Health is a
 * bare TCP connect — no HTTP, no auth material on the wire from this side.
 */
export class LivekitServerProcess implements LiveVoiceManagedProcess {
  private child: ChildProcess | null = null;
  private readonly exitListeners = new Set<(reason?: unknown) => void>();

  constructor(private readonly deps: LivekitServerProcessDeps) {}

  async start(): Promise<void> {
    if (this.child) return;
    const host = this.deps.host ?? "127.0.0.1";
    const port = this.deps.port ?? 7880;
    const spawnFn = this.deps.spawnFn ?? spawn;
    const child = spawnFn(
      this.deps.executablePath,
      ["--bind", host, "--port", String(port), "--keys", `${this.deps.apiKey}: ${this.deps.apiSecret}`],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
    );
    this.child = child;
    child.on("error", (error) => this.notifyExit(error));
    child.on("exit", (code, signal) => {
      this.child = null;
      this.notifyExit(code === 0 ? undefined : new Error(`livekit-server exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`));
    });
    // Give the process a moment to fail on spawn errors (missing exe, etc.).
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), 250);
      child.once("error", (error) => {
        clearTimeout(timer);
        this.child = null;
        reject(error);
      });
      if (child.exitCode !== null) {
        clearTimeout(timer);
        reject(new Error("livekit-server exited immediately after spawn."));
      }
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
        resolve();
      }, 3_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill();
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  async health(): Promise<boolean> {
    if (!this.child) return false;
    const connectFn = this.deps.connectFn ?? tcpConnect;
    return connectFn(this.deps.host ?? "127.0.0.1", this.deps.port ?? 7880, this.deps.readyTimeoutMs ?? 1_500);
  }

  onExit(listener: (reason?: unknown) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  private notifyExit(reason?: unknown): void {
    for (const listener of [...this.exitListeners]) listener(reason);
  }
}

function tcpConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
