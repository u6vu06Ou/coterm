import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../src/shared/ipc";
import { BrowserSecretVault } from "../../src/main/browser/browser-secret-vault";
import type { AppOperations } from "../../src/main/core/app-operations";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("../../src/main/core/logger", () => ({
  logger: { audit: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("electron", () => ({
  app: { getVersion: () => "1.0.0", getPath: () => "D:\\tmp", quit: vi.fn(), relaunch: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => handlers.set(channel, listener),
    removeHandler: (channel: string) => handlers.delete(channel),
    on: vi.fn(), removeListener: vi.fn(),
  },
  shell: { showItemInFolder: vi.fn() },
}));

function minimalDeps(browserSecrets?: Pick<BrowserSecretVault, "issue">) {
  return {
    repository: {} as never, database: {} as never, runs: {} as never,
    council: {} as never, approvals: {} as never, terminals: {} as never,
    events: { on: vi.fn(), off: vi.fn() } as never,
    operations: {
      onDockLayoutChanged: () => () => undefined,
      onAttentionChanged: () => () => undefined,
      onUsageChanged: () => () => undefined,
    } as unknown as AppOperations,
    browserSecrets,
  };
}

describe("browser secret issue IPC (§12.2 — renderer-only, secrets never cross HTTP/MCP)", () => {
  beforeEach(() => handlers.clear());

  it("issues an opaque handle; the raw value never appears in the response", async () => {
    const { registerIpc } = await import("../../src/main/ipc/register-ipc");
    const vault = new BrowserSecretVault();
    registerIpc(minimalDeps(vault));
    const handler = handlers.get(IPC.browserSecretIssue);
    expect(handler, "browser:secret:issue handler registered").toBeDefined();
    const issued = await handler?.({}, { value: "hunter2-secret-value", ttlMs: 60_000 }) as { handle: string; expiresInMs: number };
    expect(issued.handle).toMatch(/^secret:\/\//);
    expect(issued.expiresInMs).toBe(60_000);
    expect(JSON.stringify(issued)).not.toContain("hunter2");
    // One-time: the minted handle resolves once through the vault.
    expect(vault.consume(issued.handle)).toBe("hunter2-secret-value");
    // One-time semantics: a replayed handle fails closed with a typed error
    // (batchFill surfaces it as the per-field secret_unavailable step code).
    expect(() => vault.consume(issued.handle)).toThrow(/unavailable/i);
  });

  it("rejects empty / oversized / malformed input and fails closed without a vault", async () => {
    const { registerIpc } = await import("../../src/main/ipc/register-ipc");
    registerIpc(minimalDeps(new BrowserSecretVault()));
    const handler = handlers.get(IPC.browserSecretIssue)!;
    await expect((handler as (...args: unknown[]) => Promise<unknown>)({}, {})).rejects.toThrow();
    await expect((handler as (...args: unknown[]) => Promise<unknown>)({}, { value: "" })).rejects.toThrow();
    await expect((handler as (...args: unknown[]) => Promise<unknown>)({}, { value: "x".repeat(4_097) })).rejects.toThrow();
    await expect((handler as (...args: unknown[]) => Promise<unknown>)({}, { value: "ok", ttlMs: 500 })).rejects.toThrow(); // below the 1s floor
    handlers.clear();
    registerIpc(minimalDeps(undefined));
    await expect(handlers.get(IPC.browserSecretIssue)!({}, { value: "x" }) as Promise<unknown>).rejects.toThrow(/Vault|unavailable/i);
  });
});
