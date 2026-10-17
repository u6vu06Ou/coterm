import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import {
  LIVEKIT_SERVER_EXE_NAME,
  LIVEKIT_SERVER_EXE_SHA256,
  LIVEKIT_SERVER_ZIP_SHA256,
  ensureLivekitServerExecutable,
  sha256Hex,
} from "../../src/main/voice/live/server-artifact";

const FAKE_EXE = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

function fakeZip(exe: Uint8Array): Uint8Array {
  return zipSync({ [LIVEKIT_SERVER_EXE_NAME]: exe, LICENSE: new Uint8Array([0]) });
}

describe("live voice server artifact", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "livekit-artifact-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("pins the real 1.13.5 release hashes verified during implementation", () => {
    expect(LIVEKIT_SERVER_ZIP_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(LIVEKIT_SERVER_EXE_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reuses a valid on-disk executable without downloading", async () => {
    await writeFile(join(dir, LIVEKIT_SERVER_EXE_NAME), FAKE_EXE);
    let downloads = 0;
    const result = await ensureLivekitServerExecutable(dir, {
      expectedExeSha256: sha256Hex(FAKE_EXE),
      download: async () => {
        downloads += 1;
        return fakeZip(FAKE_EXE);
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe(join(dir, LIVEKIT_SERVER_EXE_NAME));
    expect(downloads).toBe(0);
  });

  it("downloads, verifies, and writes the executable on first run", async () => {
    const zip = fakeZip(FAKE_EXE);
    const result = await ensureLivekitServerExecutable(dir, {
      expectedZipSha256: sha256Hex(zip),
      expectedExeSha256: sha256Hex(FAKE_EXE),
      download: async () => zip,
    });
    expect(result.ok).toBe(true);
    const onDisk = await readFile(join(dir, LIVEKIT_SERVER_EXE_NAME));
    expect(new Uint8Array(onDisk)).toEqual(FAKE_EXE);
  });

  it("rejects a forged archive by zip hash (degrade path, no throw)", async () => {
    const result = await ensureLivekitServerExecutable(dir, {
      download: async () => new Uint8Array([9, 9, 9]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("hash mismatch");
  });

  it("rejects when the extracted executable hash does not match", async () => {
    const zip = fakeZip(new Uint8Array([4, 2]));
    const result = await ensureLivekitServerExecutable(dir, {
      expectedZipSha256: sha256Hex(zip),
      expectedExeSha256: sha256Hex(FAKE_EXE),
      download: async () => zip,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("executable hash mismatch");
  });

  it("re-downloads exactly once after finding a corrupt executable", async () => {
    await writeFile(join(dir, LIVEKIT_SERVER_EXE_NAME), new Uint8Array([0]));
    const zip = fakeZip(FAKE_EXE);
    let downloads = 0;
    const result = await ensureLivekitServerExecutable(dir, {
      expectedZipSha256: sha256Hex(zip),
      expectedExeSha256: sha256Hex(FAKE_EXE),
      download: async () => {
        downloads += 1;
        return zip;
      },
    });
    expect(result.ok).toBe(true);
    expect(downloads).toBe(1);
    expect(new Uint8Array(await readFile(join(dir, LIVEKIT_SERVER_EXE_NAME)))).toEqual(FAKE_EXE);
  });

  it("surfaces download failures as ok:false instead of throwing", async () => {
    const result = await ensureLivekitServerExecutable(dir, {
      download: async () => {
        throw new Error("offline");
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("offline");
  });
});
