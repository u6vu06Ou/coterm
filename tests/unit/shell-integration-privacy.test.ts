import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../../src/main/storage/database";
import { Repository } from "../../src/main/storage/repository";
import { initLogger, getRecentLogEntries } from "../../src/main/core/logger";
import { PtyManager, sanitizeCommand } from "../../src/main/terminal/pty-manager";
import { AppEventBus } from "../../src/main/core/event-bus";

const SECRET = "api_key=super-secret-token-value";

describe("shell integration — privacy / redaction boundary", () => {
  let directory: string;
  let database: AppDatabase;
  let repository: Repository;
  let logDir: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "coterm-osc-priv-"));
    logDir = await mkdtemp(join(tmpdir(), "coterm-osc-log-"));
    database = new AppDatabase(join(directory, "state.sqlite"));
    await database.open();
    repository = new Repository(database);
    initLogger({ userDataDir: logDir, level: "debug" });
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
    await rm(logDir, { recursive: true, force: true });
  });

  it("sanitizeCommand redacts the secret before it can reach a CommandResult", () => {
    const safe = sanitizeCommand(`curl -H ${SECRET} https://x`);
    expect(safe).not.toContain("super-secret-token-value");
    expect(safe).toContain("[REDACTED]");
  });

  it("repository.appendTerminalEvent re-redacts the command in the payload", async () => {
    // Simulate the register-ipc terminalCommand path: it passes the (already
    // redacted) command into appendTerminalEvent. Even if a raw secret slipped
    // through, the payload sanitizer must catch it.
    const project = await repository.createProject("priv-test", directory);
    const terminalId = "22222222-2222-4222-8222-222222222222";
    await repository.appendTerminalEvent({
      projectId: project.id,
      terminalId,
      type: "terminal.command.finished",
      summary: "Command exited with code 1 after 100ms.",
      payload: {
        exitCode: 1,
        durationMs: 100,
        // Pretend the redaction upstream failed — the sanitizer is the backstop.
        command: `curl -H ${SECRET} https://x`,
      },
    });
    const events = repository.listRecentTerminalEvents(project.id, 10);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("super-secret-token-value");
    expect(serialized).toContain("[REDACTED]");
  });

  it("logger metadata for terminal.command.finished carries no command text", () => {
    const manager = new PtyManager(new AppEventBus());
    const terminalId = "11111111-1111-4111-8111-111111111111";
    const managed = {
      info: {
        id: terminalId,
        projectId: "22222222-2222-4222-8222-222222222222",
        cwd: "D:\\project",
      },
      oscCarry: "",
      shellCwd: "D:\\project",
      lifecycle: null,
      lastCommand: null,
    };
    (manager as unknown as { terminals: Map<string, typeof managed> }).terminals.set(terminalId, managed);
    const feed = (manager as unknown as { _parseOsc(value: typeof managed, data: string): void })._parseOsc.bind(manager);
    feed(managed, `\x1b]633;E;curl -H ${SECRET} https://x\x07`);
    feed(managed, "\x1b]633;C\x07");
    feed(managed, "\x1b]633;D;0\x07");

    const entries = getRecentLogEntries({ q: "terminal.command.finished", limit: 10 });
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain('"command"');
    expect(serialized).not.toContain("super-secret-token-value");
    expect(serialized).toContain("exitCode");
    expect(serialized).toContain("durationMs");
    (manager as unknown as { terminals: Map<string, unknown> }).terminals.clear();
  });
});
