import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync } from "fflate";

// livekit-server is fetched once from the official release and pinned twice:
// the zip SHA256 and the extracted livekit-server.exe SHA256 (work order §6).
// Verified on 2026-08-16 against
// https://github.com/livekit/livekit/releases/tag/v1.13.5
export const LIVEKIT_SERVER_VERSION = "1.13.5";
export const LIVEKIT_SERVER_ZIP_URL =
  `https://github.com/livekit/livekit/releases/download/v${LIVEKIT_SERVER_VERSION}/livekit_${LIVEKIT_SERVER_VERSION}_windows_amd64.zip`;
export const LIVEKIT_SERVER_ZIP_SHA256 = "3ec7eaa76ef64063bf21f78364733703e0969612cb92ffd60661ed45fa4a8906";
export const LIVEKIT_SERVER_EXE_SHA256 = "0caf64f2ca235af462c9bcbaa2670c7420a4229753bb067eabb6b93557701ca1";
export const LIVEKIT_SERVER_EXE_NAME = "livekit-server.exe";

export type EnsureServerArtifactResult =
  | { ok: true; path: string }
  | { ok: false; reason: string };

export interface LiveVoiceServerArtifactDeps {
  /** Injectable so tests never touch the network (work order §6: mock
   * downloads, CI must not depend on the internet). Defaults to fetch. */
  download?: (url: string) => Promise<Uint8Array>;
  /** Hash pins are injectable so tests can verify forged artifacts without
   * bundling the real 54MB binary; production callers never override these. */
  expectedZipSha256?: string;
  expectedExeSha256?: string;
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Ensures `<targetDir>/livekit-server.exe` exists and matches the pinned
 * hashes. Corrupt/missing artifacts trigger exactly one re-download attempt;
 * verification failures resolve to ok:false so the runtime manager degrades
 * instead of crashing (open-box rule: chunked fallback must take over).
 */
export async function ensureLivekitServerExecutable(
  targetDir: string,
  deps: LiveVoiceServerArtifactDeps = {},
): Promise<EnsureServerArtifactResult> {
  const download = deps.download ?? defaultDownload;
  const expectedExeSha256 = deps.expectedExeSha256 ?? LIVEKIT_SERVER_EXE_SHA256;
  const target = join(targetDir, LIVEKIT_SERVER_EXE_NAME);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await readVerified(target, expectedExeSha256);
    if (existing.ok) return existing;
    const downloaded = await downloadAndVerify(targetDir, target, download, deps);
    if (!downloaded.ok) return downloaded;
  }
  return { ok: false, reason: "LiveKit server artifact could not be verified." };
}

async function readVerified(target: string, expectedExeSha256: string): Promise<EnsureServerArtifactResult> {
  try {
    const info = await stat(target);
    if (!info.isFile() || info.size <= 0) return { ok: false, reason: "LiveKit server artifact is empty." };
  } catch {
    return { ok: false, reason: "LiveKit server artifact is missing." };
  }
  try {
    const { readFile } = await import("node:fs/promises");
    const bytes = new Uint8Array(await readFile(target));
    if (sha256Hex(bytes) !== expectedExeSha256) {
      return { ok: false, reason: "LiveKit server artifact hash mismatch." };
    }
    return { ok: true, path: target };
  } catch (error) {
    return { ok: false, reason: boundedReason(error) };
  }
}

async function downloadAndVerify(
  targetDir: string,
  target: string,
  download: (url: string) => Promise<Uint8Array>,
  deps: LiveVoiceServerArtifactDeps,
): Promise<EnsureServerArtifactResult> {
  const expectedZipSha256 = deps.expectedZipSha256 ?? LIVEKIT_SERVER_ZIP_SHA256;
  const expectedExeSha256 = deps.expectedExeSha256 ?? LIVEKIT_SERVER_EXE_SHA256;
  let zip: Uint8Array;
  try {
    zip = await download(LIVEKIT_SERVER_ZIP_URL);
  } catch (error) {
    return { ok: false, reason: boundedReason(error) };
  }
  if (sha256Hex(zip) !== expectedZipSha256) {
    return { ok: false, reason: "LiveKit server archive hash mismatch." };
  }
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip);
  } catch (error) {
    return { ok: false, reason: boundedReason(error) };
  }
  const exe = entries[LIVEKIT_SERVER_EXE_NAME];
  if (!exe) return { ok: false, reason: "LiveKit server executable not found in archive." };
  if (sha256Hex(exe) !== expectedExeSha256) {
    return { ok: false, reason: "LiveKit server executable hash mismatch." };
  }
  try {
    await mkdir(targetDir, { recursive: true });
    // Atomic-ish replace: write a sibling temp file first, then swap. The old
    // file is removed if present so Windows rename cannot fail on overwrite.
    const tmp = `${target}.download`;
    await writeFile(tmp, exe);
    await rm(target, { force: true });
    await rename(tmp, target);
  } catch (error) {
    return { ok: false, reason: boundedReason(error) };
  }
  const confirm = await readVerified(target, expectedExeSha256);
  if (!confirm.ok) return confirm;
  return { ok: true, path: target };
}

async function defaultDownload(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`LiveKit server download failed (HTTP ${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

function boundedReason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 240);
}
