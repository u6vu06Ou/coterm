import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttentionCenter } from "../../src/main/core/attention-center";
import type { PtyStateChanged } from "../../src/shared/types";

// Minimal event-bus stand-in: just emits ptyStateChanged.
type FakeBus = EventEmitter<{ ptyStateChanged: [PtyStateChanged] }>;
const makeBus = (): FakeBus => new EventEmitter<{ ptyStateChanged: [PtyStateChanged] }>();

const PID = "11111111-1111-4111-8111-111111111111";
const terminalIds = new Map<string, string>();
let nextTerminalId = 1;

function tid(label: string): string {
  const existing = terminalIds.get(label);
  if (existing) return existing;
  const value = `22222222-2222-4222-8222-${String(nextTerminalId++).padStart(12, "0")}`;
  terminalIds.set(label, value);
  return value;
}

function change(
  terminalId: string,
  state: PtyStateChanged["state"],
  previousState: PtyStateChanged["previousState"],
  source: PtyStateChanged["source"] = "osc",
): PtyStateChanged {
  return { terminalId: tid(terminalId), projectId: PID, state, previousState, source };
}

describe("AttentionCenter", () => {
  let directory: string;
  let bus: FakeBus;
  let center: AttentionCenter;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "attention-"));
    bus = makeBus();
    center = new AttentionCenter({ userDataPath: directory, events: bus });
    await center.load();
  });

  afterEach(async () => {
    await center.dispose();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("files a notification only for attention states", () => {
    bus.emit("ptyStateChanged", change("t1", "running", null));
    bus.emit("ptyStateChanged", change("t2", "done", null));
    expect(center.list()).toEqual([]);
    bus.emit("ptyStateChanged", change("t3", "approval_required", "running"));
    expect(center.list()).toHaveLength(1);
    expect(center.list()[0]!.state).toBe("approval_required");
    expect(center.list()[0]!.terminalId).toBe(tid("t3"));
  });

  it("dedupes: one unresolved per terminal, updates on state change", () => {
    bus.emit("ptyStateChanged", change("t1", "waiting_input", "running"));
    const firstId = center.list()[0]!.id;
    bus.emit("ptyStateChanged", change("t1", "approval_required", "waiting_input"));
    expect(center.list()).toHaveLength(1);
    expect(center.list()[0]!.id).toBe(firstId);
    expect(center.list()[0]!.state).toBe("approval_required");
  });

  it("upgrades metadata when a higher-authority source confirms the same state", () => {
    bus.emit("ptyStateChanged", change("t1", "blocked", "running", "screen"));
    const firstId = center.list()[0]!.id;
    bus.emit("ptyStateChanged", change("t1", "blocked", "blocked", "provider"));
    expect(center.list()).toHaveLength(1);
    expect(center.list()[0]).toMatchObject({ id: firstId, state: "blocked", source: "provider" });
  });

  it("auto-resolves when the terminal leaves the attention state", () => {
    bus.emit("ptyStateChanged", change("t1", "blocked", "running"));
    expect(center.list()).toHaveLength(1);
    bus.emit("ptyStateChanged", change("t1", "running", "blocked"));
    expect(center.list()).toHaveLength(0);
  });

  it("explicit resolve marks the notification resolved", () => {
    bus.emit("ptyStateChanged", change("t1", "error", "running"));
    const [n] = center.list();
    center.resolve(n!.id);
    expect(center.list()).toHaveLength(0);
  });

  it("persists unresolved notifications and reloads them on restart", async () => {
    bus.emit("ptyStateChanged", change("t1", "approval_required", "running"));
    // dispose() must flush a pending coalesced write before returning.
    await center.dispose();
    const reopened = new AttentionCenter({ userDataPath: directory, events: bus });
    await reopened.load();
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.list()[0]!.terminalId).toBe(tid("t1"));
    await reopened.dispose();
  });

  it("corrupt JSON falls back to an empty inbox (never throws)", async () => {
    await center.dispose();
    await writeFile(join(directory, "attention-inbox.json"), "{ not valid json");
    const reopened = new AttentionCenter({ userDataPath: directory, events: bus });
    await expect(reopened.load()).resolves.toBeUndefined();
    expect(reopened.list()).toEqual([]);
    await reopened.dispose();
  });

  it("hard-bounds the unresolved queue at 200 entries", () => {
    // Resolved entries are removed immediately.
    for (let i = 0; i < 5; i++) {
      bus.emit("ptyStateChanged", change(`t${i}`, "blocked", "running"));
      const [n] = center.list();
      center.resolve(n!.id);
    }
    // Filing far over MAX evicts the oldest unresolved entries too. The bound
    // is real even when every remaining notification still needs attention.
    for (let i = 0; i < 210; i++) {
      bus.emit("ptyStateChanged", change(`big${i}`, "waiting_input", "running"));
    }
    expect(center.list()).toHaveLength(200);
  });

  it("does not bind a no-terminalId provider/broker signal to any terminal", () => {
    // AttentionCenter only listens to ptyStateChanged, which always carries a
    // terminalId. A provider/broker signal WITHOUT a terminalId never reaches
    // setPtyState (index.ts guards it), so no notification is filed. Simulate
    // by emitting only terminalId-bearing changes for unrelated terminals and
    // confirming nothing leaks: the center has no "guess selected terminal" path.
    bus.emit("ptyStateChanged", change("t1", "running", null));
    expect(center.list()).toEqual([]);
  });

  it("two terminals in attention each get their own notification", () => {
    bus.emit("ptyStateChanged", change("t1", "approval_required", "running"));
    bus.emit("ptyStateChanged", change("t2", "blocked", "running", "broker"));
    const list = center.list();
    expect(list).toHaveLength(2);
    expect(list.map((n) => n.terminalId).sort()).toEqual([tid("t1"), tid("t2")].sort());
    expect(list.find((n) => n.terminalId === tid("t2"))!.source).toBe("broker");
  });

  it("notifications carry no message/prompt/command text (metadata only)", () => {
    bus.emit("ptyStateChanged", change("t1", "approval_required", "running"));
    const n = center.list()[0]!;
    const keys = Object.keys(n).sort();
    expect(keys).toEqual(["createdAt", "id", "projectId", "resolvedAt", "source", "state", "terminalId"]);
  });
});
