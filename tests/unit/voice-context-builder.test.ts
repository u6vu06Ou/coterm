import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../../src/main/storage/database";
import { VoiceContextBuilder } from "../../src/main/voice/live/voice-context-builder";
import { VoiceSessionRepository } from "../../src/main/voice/live/voice-session-repository";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("VoiceContextBuilder", () => {
  it("keeps deep-path context bounded after 100+ turns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coterm-voice-context-"));
    cleanup.push(dir);
    const database = new AppDatabase(join(dir, "test.sqlite"));
    await database.open();
    const repository = new VoiceSessionRepository(database);
    repository.create({
      id: "vs-context",
      transport: "pending-livekit",
      sttLanguageMode: "auto",
      responseLanguage: "zh-TW",
    });
    repository.updateContext({ id: "vs-context", rollingSummary: "S".repeat(10_000), currentTopic: "Coterm" });
    for (let index = 0; index < 120; index += 1) {
      repository.appendTurn({ voiceSessionId: "vs-context", role: "user", text: `turn-${index}-${"x".repeat(2500)}`, source: "supervisor" });
    }
    const context = new VoiceContextBuilder(repository, 16).build("vs-context");
    expect(context.recentTurns).toHaveLength(16);
    expect(context.rollingSummary).toHaveLength(8_000);
    expect(context.recentTurns.every((turn) => turn.text.length <= 2_000)).toBe(true);
    database.close();
  }, 60_000);
});
