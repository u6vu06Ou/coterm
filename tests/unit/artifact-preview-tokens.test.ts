import { join } from "node:path";
import { assertExistingPath } from "../../src/main/security/path-policy";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearArtifactPreviewTokens,
  mintArtifactPreviewToken,
  resolveArtifactPreviewToken,
} from "../../src/main/web/artifact-preview-tokens";

afterEach(() => {
  vi.useRealTimers();
  clearArtifactPreviewTokens();
});

describe("artifact preview tokens", () => {
  it("resolves a minted token to its directory and rejects anything else", () => {
    const token = mintArtifactPreviewToken("D:\\work\\preview");
    expect(resolveArtifactPreviewToken(token)).toBe("D:\\work\\preview");
    expect(resolveArtifactPreviewToken("not-a-token")).toBeNull();
    // Two mints are two distinct grants — a token is never guessable from another one.
    expect(mintArtifactPreviewToken("D:\\work\\preview")).not.toBe(token);
  });

  it("expires after ten minutes so a leaked URL is not a permanent file server", () => {
    vi.useFakeTimers();
    const token = mintArtifactPreviewToken("D:\\work\\preview");
    vi.advanceTimersByTime(9 * 60 * 1000);
    expect(resolveArtifactPreviewToken(token)).toBe("D:\\work\\preview");
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(resolveArtifactPreviewToken(token)).toBeNull();
  });

  it("bounds how many grants can pile up", () => {
    const tokens = Array.from({ length: 40 }, (_, index) => mintArtifactPreviewToken(`D:\\dir${index}`));
    const live = tokens.filter((token) => resolveArtifactPreviewToken(token) !== null);
    expect(live.length).toBeLessThanOrEqual(32);
    // The most recent preview must always still work.
    expect(resolveArtifactPreviewToken(tokens.at(-1)!)).toBe("D:\\dir39");
  });
});

describe("shell-out path policy", () => {
  it("canonicalizes any existing path but still rejects missing ones", async () => {
    // reveal / open-external are desktop IPC only, so they take any file the user clicked —
    // that is the whole point of dropping containment. Non-existent paths must still fail.
    const here = await assertExistingPath(process.cwd());
    expect(here.length).toBeGreaterThan(0);
    await expect(assertExistingPath(join(process.cwd(), "definitely-not-here-9e3f.png"))).rejects.toThrow("Path does not exist.");
  });
});
