import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../../src/main/storage/database";
import { VoiceSessionRepository } from "../../src/main/voice/live/voice-session-repository";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeRepository(): Promise<{ database: AppDatabase; repository: VoiceSessionRepository }> {
  const dir = await mkdtemp(join(tmpdir(), "coterm-voice-session-"));
  cleanup.push(dir);
  const database = new AppDatabase(join(dir, "test.sqlite"));
  await database.open();
  return { database, repository: new VoiceSessionRepository(database) };
}

describe("VoiceSessionRepository", () => {
  it("persists logical session state and text turns without any audio columns", async () => {
    const { database, repository } = await makeRepository();
    const created = repository.create({
      id: "vs-1",
      transport: "pending-livekit",
      sttLanguageMode: "auto",
      responseLanguage: "zh-TW",
      now: "2026-08-15T12:00:00.000Z",
    });
    expect(created.status).toBe("starting");
    expect(repository.setStatus(created.id, "listening", "2026-08-15T12:00:01.000Z").status).toBe("listening");

    repository.appendTurn({
      id: "turn-1",
      voiceSessionId: created.id,
      role: "user",
      text: "幫我 check Codex",
      source: "supervisor",
      createdAt: "2026-08-15T12:00:02.000Z",
    });
    expect(repository.listRecentTurns(created.id)).toHaveLength(1);

    const columns = database.queryAll<{ name: string }>("PRAGMA table_info(voice_sessions)").map((row) => row.name);
    expect(columns).not.toContain("audio");
    expect(columns).not.toContain("raw_pcm");
    expect(columns).not.toContain("webm");
    database.close();
  });

  it("caps recent-turn reads even after 100+ turns", async () => {
    const { database, repository } = await makeRepository();
    repository.create({
      id: "vs-many",
      transport: "pending-livekit",
      sttLanguageMode: "auto",
      responseLanguage: "zh-TW",
    });
    for (let index = 0; index < 105; index += 1) {
      repository.appendTurn({
        voiceSessionId: "vs-many",
        role: index % 2 === 0 ? "user" : "agentapi",
        text: `turn ${index}`,
        source: "fast",
      });
    }
    expect(repository.countTurns("vs-many")).toBe(105);
    expect(repository.listRecentTurns("vs-many", 20)).toHaveLength(20);
    expect(repository.listRecentTurns("vs-many", 999)).toHaveLength(50);
    database.close();
  }, 60_000);
});
