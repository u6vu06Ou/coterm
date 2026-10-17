import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LedgerSearchIndex, MAX_SEARCH_BODY_CHARS } from "../../src/main/storage/search-index";
import { dropSearchIndexIfOversized } from "../../src/main/storage/search-index-sync";

describe("search sidecar housekeeping", () => {
  let directory = "";
  let indexPath = "";

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "coterm-sidecar-"));
    indexPath = join(directory, "index.sqlite");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("caps indexed bodies so terminal payloads cannot balloon a doc", () => {
    const index = new LedgerSearchIndex(indexPath);
    try {
      index.upsert("project", 1, {
        kind: "project",
        id: "cap-project",
        projectId: "cap-project",
        conversationId: null,
        terminalId: null,
        title: "cap",
        body: "x".repeat(MAX_SEARCH_BODY_CHARS * 4),
      });
      const hits = index.search(["cap"]);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.body).toBe("x".repeat(MAX_SEARCH_BODY_CHARS));
    } finally {
      index.close();
    }
  });

  it("drops an oversized sidecar so the next sync rebuilds from scratch", () => {
    writeFileSync(indexPath, "0123456789");
    dropSearchIndexIfOversized(indexPath, 8);
    expect(() => statSync(indexPath)).toThrow();
  });

  it("keeps a sidecar at or under the budget", () => {
    writeFileSync(indexPath, "0123456789");
    dropSearchIndexIfOversized(indexPath, 10);
    expect(statSync(indexPath).size).toBe(10);
    dropSearchIndexIfOversized(indexPath);
    expect(statSync(indexPath).size).toBe(10);
  });
});
