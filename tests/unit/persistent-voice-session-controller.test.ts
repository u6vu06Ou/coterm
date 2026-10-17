import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppDatabase } from "../../src/main/storage/database";
import { PersistentVoiceSessionController } from "../../src/main/voice/live/persistent-voice-session-controller";
import { VoiceSessionRepository } from "../../src/main/voice/live/voice-session-repository";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeController() {
  const dir = await mkdtemp(join(tmpdir(), "coterm-persistent-voice-"));
  cleanup.push(dir);
  const database = new AppDatabase(join(dir, "test.sqlite"));
  await database.open();
  const repository = new VoiceSessionRepository(database);
  const interrupt = vi.fn(() => ({ epoch: 1, aborted: false }));
  const turn = vi.fn(async (utterance: unknown) => ({
    epoch: 1,
    text: `answer:${String(utterance)}`,
    source: "fast" as const,
    spoken: true,
    targetTerminalId: null,
    targetTitle: null,
    clarification: null,
  }));
  const controller = new PersistentVoiceSessionController({ repository, agentapi: { interrupt, turn } });
  return { database, repository, controller, interrupt, turn };
}

describe("PersistentVoiceSessionController", () => {
  it("starts listening; mute/reconnect do not end; only end ends", async () => {
    const { database, controller } = await makeController();
    const session = controller.start();
    expect(session.status).toBe("listening");
    expect(session.sttLanguageMode).toBe("auto");
    expect(controller.mute(session.id).status).toBe("muted");
    expect(controller.unmute(session.id).status).toBe("listening");
    expect(controller.markReconnecting(session.id).status).toBe("reconnecting");
    expect(controller.markReconnected(session.id).status).toBe("listening");
    expect(controller.end(session.id).status).toBe("ended");
    database.close();
  });

  it("returns to listening after a spoken reply and interrupts on barge-in", async () => {
    const { database, repository, controller, interrupt } = await makeController();
    const session = controller.start();
    expect(controller.userSpeechStarted(session.id).status).toBe("user-speaking");
    const result = await controller.submitUtterance(session.id, "status");
    expect(result?.text).toBe("answer:status");
    expect(repository.require(session.id).status).toBe("speaking");
    expect(controller.replyFinished(session.id).status).toBe("listening");
    controller.userSpeechStarted(session.id);
    expect(interrupt).toHaveBeenCalled();
    expect(repository.listRecentTurns(session.id).map((turn) => turn.role)).toEqual(["user", "agentapi"]);
    database.close();
  });
});
