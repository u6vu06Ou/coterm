import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../../src/main/storage/database";
import { Repository } from "../../src/main/storage/repository";

describe("settings locale persistence", () => {
  let directory: string;
  let databasePath: string;
  let database: AppDatabase;
  let repository: Repository;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "coterm-locale-"));
    databasePath = join(directory, "state.sqlite");
    database = new AppDatabase(databasePath);
    await database.open();
    repository = new Repository(database);
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("normalizes legacy settings to zh-TW and persists an English switch", async () => {
    const legacy = repository.getSettings();
    const { locale: _locale, ...withoutLocale } = legacy;
    database.run(
      "INSERT INTO settings(key, value_json, updated_at) VALUES ('app', ?, ?)",
      [JSON.stringify(withoutLocale), new Date().toISOString()],
    );
    expect(repository.getSettings().locale).toBe("zh-TW");

    await repository.setSettings({ ...repository.getSettings(), locale: "en-US" });
    database.close();
    database = new AppDatabase(databasePath);
    await database.open();
    repository = new Repository(database);
    expect(repository.getSettings().locale).toBe("en-US");
  });
});
