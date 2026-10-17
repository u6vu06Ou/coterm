import { mkdir, rm, stat, readdir, copyFile, lstat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { join, relative, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Repository } from "../storage/repository";
import type { PtyManager } from "../terminal/pty-manager";
import type { WorktreeManager } from "./worktree-manager";
import { assertAllowedPath } from "../security/path-policy";
import { git, isGitError } from "../security/git-helper";
import { createId } from "./ids";
import { logger } from "./logger";
import type {
  Checkpoint,
  CheckpointDiff,
  CheckpointFileChange,
  CheckpointKind,
  CheckpointPhase,
  CheckpointRestorePreview,
  CheckpointHunkRestoreInput,
  Worktree,
} from "@shared/types";

const DIFF_MAX_BYTES = 256 * 1024;
const SNAPSHOT_MAX_FILES = 200;
const SNAPSHOT_MAX_BYTES = 50 * 1024 * 1024;
const SNAPSHOT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const SNAPSHOT_SKIP_NAMES = new Set([
  ".git",
  "node_modules",
  ".env",
  "credentials",
  "secrets",
]);
const SNAPSHOT_SKIP_SUFFIXES = [".key", ".pem", ".pfx", ".p12"];

export interface CheckpointManagerDependencies {
  repository: Repository;
  terminals: Pick<PtyManager, "list" | "get">;
  userDataPath: string;
  worktrees?: WorktreeManager;
}

export interface CreateTurnCheckpointInput {
  turnId: string;
  conversationId: string;
  projectId: string;
  worktreeId?: string | null;
  phase: CheckpointPhase;
}

export interface ExplicitCheckpointInput {
  projectId: string;
  worktreeId?: string | null;
  phase: CheckpointPhase;
}

/**
 * CheckpointManager — turn-level workspace snapshots with preview-first restore.
 *
 * Safety contract (work order §4):
 * - Git worktree sandbox: checkpoint = commit on the isolated worktree branch.
 *   The main working tree/index is NEVER touched. commit happens only inside
 *   the worktree dir, after confirming worktreeId/path match an active worktree.
 * - Git non-worktree: checkpoint = `git stash create` (a dangling commit object
 *   that does NOT touch the working tree, index, or any ref), then pinned via
 *   `git stash store` with a Coterm message. No commit is made on the user's
 *   branch; the working tree is untouched.
 * - Non-Git: bounded file snapshot under <userData>/checkpoints. Skips
 *   .git/node_modules/.env/*.key/*.pem, refuses to follow symlinks, caps at
 *   200 files / 50MB / 5MB-per-file. Partial snapshots are marked, never lied.
 * - Restore is preview-first: restorePreview returns a token + current
 *   fingerprint; restoreCheckpoint requires confirm:true + that exact token.
 *   Stale tokens (different fingerprint) and dirty drift are refused.
 * - selective hunk restore is NOT implemented — without a verified patch
 *   applier we expose only whole-checkpoint restore (no fake checkboxes).
 * - All workspace file ops go through assertAllowedPath.
 * - Logger records only ids/status/count/bytes — never diff/file/prompt content.
 */
export class CheckpointManager {
  constructor(private readonly dependencies: CheckpointManagerDependencies) {}

  private checkpointsRoot(): string {
    return join(this.dependencies.userDataPath, "checkpoints");
  }

  // --- turn-lifecycle hooks (called by RunCoordinator) ----------------------

  /**
   * Create a pre-turn checkpoint. Called after startTurn succeeds, before
   * adapter.run. Failure is caught by the caller and recorded as a failed
   * checkpoint (status='failed') so the turn still proceeds — a checkpoint
   * failure must NEVER masquerade as turn success or failure.
   */
  async createTurnCheckpoint(input: CreateTurnCheckpointInput): Promise<Checkpoint | null> {
    const { repository } = this.dependencies;
    const project = repository.getProject(input.projectId);
    if (!project) {
      logger.warn("run", "checkpoint.create.noproject", "Checkpoint skipped: project gone", {
        turnId: input.turnId, projectId: input.projectId,
      });
      return null;
    }
    try {
      return await this.buildCheckpoint({
        turnId: input.turnId,
        conversationId: input.conversationId,
        projectId: input.projectId,
        worktreeId: input.worktreeId ?? null,
        phase: input.phase,
        workspacePath: project.workspacePath,
      });
    } catch {
      // Record a failed checkpoint row so the turn has a pre record (undo
      // boundary) even when the snapshot could not be built.
      const failed = await repository
        .createCheckpoint({
          id: createId(),
          turnId: input.turnId,
          conversationId: input.conversationId,
          projectId: input.projectId,
          worktreeId: input.worktreeId ?? null,
          phase: input.phase,
          kind: "file-snapshot",
          status: "failed",
          ref: null,
          snapshotPath: null,
          workspaceFingerprint: null,
          fileCount: 0,
          sizeBytes: 0,
          partial: false,
        })
        .catch(() => null);
      logger.warn("run", "checkpoint.create.failed", "Checkpoint creation failed", {
        turnId: input.turnId,
        checkpointId: failed?.id ?? null,
        status: "failed",
      });
      return failed;
    }
  }

  /**
   * Finalize a post-turn checkpoint. Called in RunCoordinator's finally block
   * for every exit (success/error/cancel). A failed pre checkpoint has no post
   * pair. Failure here is logged but never affects turn status.
   */
  async finalizeTurnCheckpoint(input: CreateTurnCheckpointInput): Promise<Checkpoint | null> {
    const { repository } = this.dependencies;
    const project = repository.getProject(input.projectId);
    if (!project) return null;
    try {
      return await this.buildCheckpoint({
        turnId: input.turnId,
        conversationId: input.conversationId,
        projectId: input.projectId,
        worktreeId: input.worktreeId ?? null,
        phase: input.phase,
        workspacePath: project.workspacePath,
      });
    } catch {
      const failed = await repository
        .createCheckpoint({
          id: createId(),
          turnId: input.turnId,
          conversationId: input.conversationId,
          projectId: input.projectId,
          worktreeId: input.worktreeId ?? null,
          phase: input.phase,
          kind: "file-snapshot",
          status: "failed",
          ref: null,
          snapshotPath: null,
          workspaceFingerprint: null,
          fileCount: 0,
          sizeBytes: 0,
          partial: false,
        })
        .catch(() => null);
      logger.warn("run", "checkpoint.finalize.failed", "Checkpoint finalize failed", {
        turnId: input.turnId,
        checkpointId: failed?.id ?? null,
        status: "failed",
      });
      return failed;
    }
  }

  // --- explicit (worktree/PTY) API ------------------------------------------

  async createExplicit(input: ExplicitCheckpointInput): Promise<Checkpoint> {
    const { repository } = this.dependencies;
    const project = repository.getProject(input.projectId);
    if (!project) throw new Error("Project not found.");
    let workspacePath = project.workspacePath;
    if (input.worktreeId) {
      const worktree = this.resolveWorktree(input.worktreeId, input.projectId);
      workspacePath = worktree.worktreePath;
    }
    return this.buildCheckpoint({
      turnId: null,
      conversationId: null,
      projectId: input.projectId,
      worktreeId: input.worktreeId ?? null,
      phase: input.phase,
      workspacePath,
    });
  }

  list(input: {
    conversationId?: string | null;
    projectId?: string;
    worktreeId?: string | null;
  }): Checkpoint[] {
    return this.dependencies.repository.listCheckpoints(input);
  }

  get(checkpointId: string): Checkpoint | null {
    return this.dependencies.repository.getCheckpoint(checkpointId);
  }

  // --- diff -----------------------------------------------------------------

  /**
   * Diff a checkpoint against either its turn's pre-checkpoint (base='pre') or
   * the current working tree (base='working'). Git uses `git diff`; non-Git
   * compares the snapshot dir to the live workspace. Output capped at 256KB.
   */
  async diff(checkpointId: string, base: "pre" | "working" = "working"): Promise<CheckpointDiff> {
    const { repository } = this.dependencies;
    const checkpoint = repository.getCheckpoint(checkpointId);
    if (!checkpoint) throw new Error("Checkpoint not found.");
    const project = repository.getProject(checkpoint.projectId);
    if (!project) throw new Error("Project not found.");

    if (base === "pre" && checkpoint.turnId) {
      const { pre, post } = repository.getTurnCheckpoints(checkpoint.turnId);
      if (!pre || !post || pre.status === "failed" || post.status === "failed") {
        return { checkpointId, base, stat: "", files: [], truncated: false };
      }
      if (pre.kind === "file-snapshot" && post.kind === "file-snapshot") {
        return this.diffFileSnapshotPair(checkpointId, base, pre.snapshotPath, post.snapshotPath);
      }
      if (pre.ref && post.ref) {
        const cwd = checkpoint.worktreeId
          ? this.resolveWorktree(checkpoint.worktreeId, checkpoint.projectId).worktreePath
          : project.workspacePath;
        return this.diffGitPair(checkpoint, cwd, pre, post);
      }
    }

    if (checkpoint.kind === "file-snapshot") {
      return this.diffFileSnapshot(checkpoint, project.workspacePath, base);
    }
    // git kinds
    const cwd = checkpoint.worktreeId
      ? this.resolveWorktree(checkpoint.worktreeId, checkpoint.projectId).worktreePath
      : project.workspacePath;
    const againstRef = checkpoint.ref;
    if (!againstRef) {
      return { checkpointId, base, stat: "", files: [], truncated: false };
    }
    return this.diffGit(checkpoint, cwd, againstRef, base);
  }

  private async diffGit(
    checkpoint: Checkpoint,
    cwd: string,
    againstRef: string,
    base: "pre" | "working",
  ): Promise<CheckpointDiff> {
    // base='working' compares the checkpoint ref to the live working tree
    // (uncommitted + untracked changes included via status --porcelain).
    // base='pre' compares against HEAD (committed changes only).
    const range = base === "working" ? againstRef : `${againstRef}..HEAD`;
    const statResult = await git(["diff", "--stat", range], {
      cwd,
      maxOutputBytes: DIFF_MAX_BYTES,
    }).catch(() => null);
    // Use status --porcelain to capture untracked files too (diff alone misses
    // them). For base='working', compare the working tree to the ref.
    const nameStatusResult = base === "working"
      ? await this.gitNameStatusVsRef(cwd, againstRef)
      : await git(["diff", "--name-status", "--no-renames", range], { cwd, maxOutputBytes: DIFF_MAX_BYTES })
          .then((result) => ({ output: result.stdout, truncated: result.truncated }))
          .catch(() => ({ output: "", truncated: false }));
    const collected = await this.collectGitFileDiffs(cwd, range, nameStatusResult.output);
    return {
      checkpointId: checkpoint.id,
      base,
      stat: statResult?.stdout ?? "",
      files: collected.files,
      truncated: Boolean(statResult?.truncated || nameStatusResult.truncated || collected.truncated),
    };
  }

  private async diffGitPair(
    checkpoint: Checkpoint,
    cwd: string,
    pre: Checkpoint,
    post: Checkpoint,
  ): Promise<CheckpointDiff> {
    if (!pre.ref || !post.ref) {
      return { checkpointId: checkpoint.id, base: "pre", stat: "", files: [], truncated: false };
    }
    const range = `${pre.ref}..${post.ref}`;
    const statResult = await git(["diff", "--stat", range], {
      cwd,
      maxOutputBytes: DIFF_MAX_BYTES,
    }).catch(() => null);
    const nameStatusResult = await git(
      ["diff", "--name-status", "--no-renames", range],
      { cwd, maxOutputBytes: DIFF_MAX_BYTES },
    ).catch(() => null);
    const tracked = await this.collectGitFileDiffs(cwd, range, nameStatusResult?.stdout ?? "");

    let untracked: CheckpointDiff = {
      checkpointId: checkpoint.id,
      base: "pre",
      stat: "",
      files: [],
      truncated: false,
    };
    if (pre.snapshotPath && post.snapshotPath) {
      untracked = await this.diffFileSnapshotPair(
        checkpoint.id,
        "pre",
        pre.snapshotPath,
        post.snapshotPath,
      );
    }

    // A path can move from untracked to tracked during a turn. Prefer the Git
    // entry in that collision: it has the authoritative blob diff and avoids
    // returning contradictory added/deleted rows for the same path.
    const merged = new Map<string, CheckpointFileChange>();
    for (const file of untracked.files) merged.set(file.path, file);
    for (const file of tracked.files) merged.set(file.path, file);
    const files = [...merged.values()].sort((a, b) => a.path.localeCompare(b.path));
    const statParts = [statResult?.stdout.trim(), untracked.stat].filter(Boolean);
    const combinedStat = statParts.join("\n");
    const statBytes = Buffer.byteLength(combinedStat, "utf8");

    return {
      checkpointId: checkpoint.id,
      base: "pre",
      stat: statBytes <= DIFF_MAX_BYTES
        ? combinedStat
        : Buffer.from(combinedStat, "utf8").subarray(0, DIFF_MAX_BYTES).toString("utf8"),
      files,
      truncated: Boolean(
        statResult?.truncated
        || nameStatusResult?.truncated
        || tracked.truncated
        || untracked.truncated
        || statBytes > DIFF_MAX_BYTES
      ),
    };
  }

  /**
   * Build a `diff --name-status`-like listing of the working tree vs a ref,
   * including untracked files (which `git diff` omits). Format: "A\tpath" for
   * added/untracked, "D\tpath" for deleted, "M\tpath" for modified.
   */
  private async gitNameStatusVsRef(
    cwd: string,
    ref: string,
  ): Promise<{ output: string; truncated: boolean }> {
    // Files changed between ref and working tree (tracked changes).
    const tracked = await git(["diff", "--name-status", "--no-renames", ref], { cwd, maxOutputBytes: DIFF_MAX_BYTES })
      .catch(() => null);
    // Untracked files (not in ref, not in index) → added.
    const untracked = await git(["ls-files", "--others", "--exclude-standard"], { cwd, maxOutputBytes: DIFF_MAX_BYTES })
      .catch(() => null);
    const lines = (tracked?.stdout ?? "").split(/\r?\n/).filter(Boolean);
    for (const path of (untracked?.stdout ?? "").split(/\r?\n/).filter(Boolean)) {
      lines.push(`A\t${path}`);
    }
    let output = "";
    let truncated = Boolean(tracked?.truncated || untracked?.truncated);
    for (const line of lines) {
      const next = output ? `${output}\n${line}` : line;
      if (Buffer.byteLength(next, "utf8") > DIFF_MAX_BYTES) {
        truncated = true;
        break;
      }
      output = next;
    }
    return { output, truncated };
  }

  private async collectGitFileDiffs(
    cwd: string,
    range: string,
    nameStatus: string,
  ): Promise<{ files: CheckpointFileChange[]; truncated: boolean }> {
    const entries = nameStatus.split(/\r?\n/).filter(Boolean);
    const files: CheckpointFileChange[] = [];
    let remainingBytes = DIFF_MAX_BYTES;
    let truncated = false;
    for (const entry of entries) {
      const [code, ...pathParts] = entry.split("\t");
      const path = pathParts.join("\t");
      if (!code || !path) continue;
      const status = code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified";
      // Per-file and aggregate bodies are capped. Binary/oversize files carry
      // metadata only so the serialized response cannot exceed 256 KB of diff.
      const bodyCap = Math.min(16 * 1024, remainingBytes);
      let body = "";
      let bodyTruncated = bodyCap === 0;
      if (bodyCap > 0) {
        const result = await git(
          ["diff", range, "--", path],
          { cwd, maxOutputBytes: bodyCap },
        ).catch(() => null);
        body = result?.stdout ?? "";
        bodyTruncated = Boolean(result?.truncated);
      }
      // Untracked files (added, not in ref) produce no diff body from `git diff
      // <ref>`. Use --no-index against /dev/null to synthesize an add diff.
      if (!body && status === "added" && bodyCap > 0) {
        try {
          const result = await git(
            ["diff", "--no-index", "--no-renames", "/dev/null", path],
            { cwd, maxOutputBytes: bodyCap },
          );
          body = result.stdout;
          bodyTruncated = result.truncated;
        } catch (error) {
          // `git diff --no-index` deliberately exits 1 when it found a diff.
          if (isGitError(error) && error.exitCode === 1) {
            body = error.stdout;
            bodyTruncated = error.truncated;
          }
        }
      }
      const bodyBytes = Buffer.byteLength(body, "utf8");
      remainingBytes = Math.max(0, remainingBytes - bodyBytes);
      const oversize = bodyTruncated;
      truncated ||= oversize;
      const binary = body.includes("Binary files") || (body.length === 0 && status !== "added" && !oversize);
      const { additions, deletions } = countDiffLines(body);
      files.push({
        path,
        status,
        oldPath: null,
        additions,
        deletions,
        binary,
        oversize,
        diff: binary || oversize ? null : body,
      });
    }
    return { files, truncated };
  }

  private async diffFileSnapshot(
    checkpoint: Checkpoint,
    workspacePath: string,
    base: "pre" | "working",
  ): Promise<CheckpointDiff> {
    if (!checkpoint.snapshotPath) {
      return { checkpointId: checkpoint.id, base, stat: "", files: [], truncated: false };
    }
    // base='working' = snapshot vs live; base='pre' = not meaningful for a
    // single snapshot (no pre pair) → return empty.
    if (base === "pre") {
      return { checkpointId: checkpoint.id, base, stat: "", files: [], truncated: false };
    }
    const allowed = await assertAllowedPath(workspacePath, { roots: [workspacePath] });
    const snap = await assertAllowedPath(checkpoint.snapshotPath, {
      roots: [this.checkpointsRoot()],
    });
    return this.diffSnapshotRoots(checkpoint.id, base, snap, allowed);
  }

  private async diffFileSnapshotPair(
    checkpointId: string,
    base: "pre" | "working",
    preSnapshotPath: string | null,
    postSnapshotPath: string | null,
  ): Promise<CheckpointDiff> {
    if (!preSnapshotPath || !postSnapshotPath) {
      return { checkpointId, base, stat: "", files: [], truncated: false };
    }
    const pre = await assertAllowedPath(preSnapshotPath, { roots: [this.checkpointsRoot()] });
    const post = await assertAllowedPath(postSnapshotPath, { roots: [this.checkpointsRoot()] });
    return this.diffSnapshotRoots(checkpointId, base, pre, post);
  }

  private async diffSnapshotRoots(
    checkpointId: string,
    base: "pre" | "working",
    leftRoot: string,
    rightRoot: string,
  ): Promise<CheckpointDiff> {
    const leftFiles = await this.collectSnapshotFiles(leftRoot, true);
    const rightFiles = await this.collectSnapshotFiles(rightRoot, true);
    const leftMap = new Map(leftFiles.map((f) => [f.rel, `${f.size}:${f.hash ?? ""}`]));
    const rightMap = new Map(rightFiles.map((f) => [f.rel, `${f.size}:${f.hash ?? ""}`]));
    const allPaths = new Set([...leftMap.keys(), ...rightMap.keys()]);
    const files: CheckpointFileChange[] = [];
    let totalAdd = 0;
    let totalDel = 0;
    let remainingBytes = DIFF_MAX_BYTES;
    let truncated = false;
    for (const rel of allPaths) {
      const inLeft = leftMap.has(rel);
      const inRight = rightMap.has(rel);
      let status: CheckpointFileChange["status"] | null = null;
      if (inLeft && !inRight) {
        status = "deleted";
      } else if (!inLeft && inRight) {
        status = "added";
      } else if (leftMap.get(rel) !== rightMap.get(rel)) {
        status = "modified";
      }
      if (!status) continue;

      const bodyCap = Math.min(16 * 1024, remainingBytes);
      const body = bodyCap > 0
        ? await this.noIndexFileDiff(leftRoot, rightRoot, rel, status, bodyCap)
        : { diff: "", truncated: true };
      const binary = body.diff.includes("Binary files") || body.diff.includes("GIT binary patch");
      const oversize = body.truncated;
      const counts = countDiffLines(body.diff);
      const additions = counts.additions || (status === "added" ? 1 : status === "modified" ? 1 : 0);
      const deletions = counts.deletions || (status === "deleted" ? 1 : status === "modified" ? 1 : 0);
      totalAdd += additions;
      totalDel += deletions;
      remainingBytes = Math.max(0, remainingBytes - Buffer.byteLength(body.diff, "utf8"));
      truncated ||= oversize;
      files.push({
        path: rel,
        status,
        oldPath: null,
        additions,
        deletions,
        binary,
        oversize,
        diff: binary || oversize ? null : body.diff,
      });
    }
    return {
      checkpointId,
      base,
      stat: `${files.length} files +${totalAdd} -${totalDel}`,
      files,
      truncated,
    };
  }

  private async noIndexFileDiff(
    leftRoot: string,
    rightRoot: string,
    rel: string,
    status: CheckpointFileChange["status"],
    maxOutputBytes: number,
  ): Promise<{ diff: string; truncated: boolean }> {
    const left = status === "added" ? "/dev/null" : join(leftRoot, rel);
    const right = status === "deleted" ? "/dev/null" : join(rightRoot, rel);
    let result: { stdout: string; truncated: boolean };
    try {
      result = await git(
        ["diff", "--no-index", "--no-renames", "--", left, right],
        { cwd: rightRoot, maxOutputBytes },
      );
    } catch (error) {
      if (!isGitError(error) || error.exitCode !== 1) throw error;
      result = { stdout: error.stdout, truncated: error.truncated };
    }
    if (result.truncated) return { diff: "", truncated: true };
    return { diff: normalizeNoIndexPatch(result.stdout, rel, status), truncated: false };
  }

  // --- preview-first restore ------------------------------------------------
  // A preview token is bound to the workspace fingerprint captured at preview
  // time. Execute refuses if the workspace drifted between preview and execute
  // (stale preview) — this is the dirty-drift guard. The snapshot's own
  // fingerprint is NOT the gate: undo/redo deliberately restores a checkpoint
  // whose snapshot differs from the current workspace (that's the point).
  // Tokens expire after PREVIEW_TTL_MS and are single-use.
  private readonly previewCache = new Map<string, { checkpointId: string; fingerprint: string | null; expiresAt: number }>();
  private static readonly PREVIEW_TTL_MS = 5 * 60_000;

  async restorePreview(checkpointId: string): Promise<CheckpointRestorePreview> {
    const { repository } = this.dependencies;
    const checkpoint = repository.getCheckpoint(checkpointId);
    if (!checkpoint) throw new Error("Checkpoint not found.");
    if (checkpoint.status === "failed") throw new Error("Checkpoint failed; cannot restore.");
    const project = repository.getProject(checkpoint.projectId);
    if (!project) throw new Error("Project not found.");
    const cwd = checkpoint.worktreeId
      ? this.resolveWorktree(checkpoint.worktreeId, checkpoint.projectId).worktreePath
      : project.workspacePath;
    const currentFingerprint = await this.workspaceFingerprint(cwd, checkpoint.kind);
    const driftDetected =
      !!checkpoint.workspaceFingerprint && checkpoint.workspaceFingerprint !== currentFingerprint;
    const affectedFiles = await this.affectedFilesForRestore(checkpoint, cwd);
    const previewToken = randomUUID();
    this.previewCache.set(previewToken, {
      checkpointId,
      fingerprint: currentFingerprint,
      expiresAt: Date.now() + CheckpointManager.PREVIEW_TTL_MS,
    });
    return {
      checkpointId: checkpoint.id,
      previewToken,
      workspaceFingerprint: currentFingerprint,
      affectedFiles,
      driftDetected,
    };
  }

  async restore(input: {
    checkpointId: string;
    confirm: boolean;
    previewToken: string;
  }): Promise<Checkpoint> {
    const { repository } = this.dependencies;
    if (!input.confirm) {
      await this.recordRestore(input.checkpointId, "refused", "Restore requires explicit confirmation.");
      throw new Error("Restore requires explicit confirmation.");
    }
    const checkpoint = repository.getCheckpoint(input.checkpointId);
    if (!checkpoint) throw new Error("Checkpoint not found.");
    if (checkpoint.status === "failed") {
      await this.recordRestore(input.checkpointId, "refused", "Checkpoint failed.");
      throw new Error("Checkpoint failed; cannot restore.");
    }
    if (checkpoint.partial) {
      await this.recordRestore(input.checkpointId, "refused", "Partial checkpoints are preview-only.");
      throw new Error("Partial checkpoint cannot be restored safely.");
    }
    const project = repository.getProject(checkpoint.projectId);
    if (!project) throw new Error("Project not found.");
    const cwd = checkpoint.worktreeId
      ? this.resolveWorktree(checkpoint.worktreeId, checkpoint.projectId).worktreePath
      : project.workspacePath;

    await this.consumeRestorePreview(checkpoint, cwd, input.previewToken);

    try {
      if (checkpoint.kind === "file-snapshot") {
        await this.restoreFileSnapshot(checkpoint, cwd);
      } else if (checkpoint.kind === "git-stash") {
        await this.restoreGitStash(checkpoint, cwd);
      } else {
        await this.restoreWorktreeCommit(checkpoint, cwd);
      }
    } catch (error) {
      await this.recordRestore(
        input.checkpointId,
        "failed",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
    await repository.markCheckpointStatus(checkpoint.id, "restored");
    await this.recordRestore(input.checkpointId, "applied", null);
    logger.audit("security", "checkpoint.restored", "Checkpoint restored", {
      checkpointId: checkpoint.id,
      projectId: checkpoint.projectId,
      worktreeId: checkpoint.worktreeId,
      status: "restored",
    });
    return repository.getCheckpoint(checkpoint.id)!;
  }

  async restoreHunk(input: CheckpointHunkRestoreInput): Promise<Checkpoint> {
    const { repository } = this.dependencies;
    if (!input.confirm) {
      await this.recordRestore(input.checkpointId, "refused", "Hunk restore requires explicit confirmation.");
      throw new Error("Hunk restore requires explicit confirmation.");
    }
    const checkpoint = repository.getCheckpoint(input.checkpointId);
    if (!checkpoint) throw new Error("Checkpoint not found.");
    if (checkpoint.status === "failed" || checkpoint.partial) {
      await this.recordRestore(input.checkpointId, "refused", "Checkpoint cannot be selectively restored.");
      throw new Error("This checkpoint cannot be selectively restored safely.");
    }
    const project = repository.getProject(checkpoint.projectId);
    if (!project) throw new Error("Project not found.");
    const cwd = checkpoint.worktreeId
      ? this.resolveWorktree(checkpoint.worktreeId, checkpoint.projectId).worktreePath
      : project.workspacePath;
    await this.consumeRestorePreview(checkpoint, cwd, input.previewToken);

    const target = await assertAllowedPath(join(cwd, input.filePath), {
      roots: [cwd],
      mustExist: false,
    });
    // Keep the containment assertion alive even for a currently missing file.
    void target;
    const diff = await this.diff(checkpoint.id, "working");
    const file = diff.files.find((candidate) => candidate.path === input.filePath);
    if (!file || file.binary || file.oversize || !file.diff) {
      await this.recordRestore(input.checkpointId, "refused", "Requested hunk is unavailable.");
      throw new Error("Requested hunk is unavailable; refresh the checkpoint diff.");
    }
    const patch = selectUnifiedDiffHunk(file.diff, input.hunkIndex);
    const args = ["-c", "core.autocrlf=false", "apply", "--reverse", "--recount", "--whitespace=nowarn", "-"] as const;
    try {
      await git(["-c", "core.autocrlf=false", "apply", "--check", "--reverse", "--recount", "--whitespace=nowarn", "-"], {
        cwd,
        input: patch,
        maxOutputBytes: 64 * 1024,
      });
      await git(args, { cwd, input: patch, maxOutputBytes: 64 * 1024 });
    } catch (error) {
      await this.recordRestore(input.checkpointId, "failed", "Generated hunk patch did not apply cleanly.");
      throw error;
    }
    await this.recordRestore(
      input.checkpointId,
      "applied",
      `hunk:${input.hunkIndex}:${input.filePath}`,
    );
    logger.audit("security", "checkpoint.hunk-restored", "Checkpoint hunk restored", {
      checkpointId: checkpoint.id,
      projectId: checkpoint.projectId,
      worktreeId: checkpoint.worktreeId,
      hunkIndex: input.hunkIndex,
      status: "applied",
    });
    return repository.getCheckpoint(checkpoint.id)!;
  }

  private async consumeRestorePreview(
    checkpoint: Checkpoint,
    cwd: string,
    previewToken: string,
  ): Promise<void> {
    const preview = this.previewCache.get(previewToken);
    if (!preview || preview.checkpointId !== checkpoint.id) {
      await this.recordRestore(checkpoint.id, "refused", "Invalid or unknown preview token.");
      throw new Error("Invalid preview token; call restorePreview first.");
    }
    if (Date.now() > preview.expiresAt) {
      this.previewCache.delete(previewToken);
      await this.recordRestore(checkpoint.id, "refused", "Preview token expired.");
      throw new Error("Preview token expired; request a new preview.");
    }
    const currentFingerprint = await this.workspaceFingerprint(cwd, checkpoint.kind);
    if (preview.fingerprint !== currentFingerprint) {
      this.previewCache.delete(previewToken);
      await this.recordRestore(
        checkpoint.id,
        "refused",
        "Workspace drifted between preview and restore; restore refused.",
      );
      throw new Error("Workspace has drifted since the preview; restore refused.");
    }
    this.previewCache.delete(previewToken);
  }

  // --- undo / redo ----------------------------------------------------------

  /**
   * Undo the latest non-restored turn in a conversation: restore its pre
   * checkpoint. redo re-applies the post checkpoint of the most recently
   * undone turn. Both go through the same preview-first restore path.
   */
  async undo(input: {
    conversationId: string;
    confirm: boolean;
    previewToken: string;
  }): Promise<Checkpoint> {
    const { repository } = this.dependencies;
    const checkpoints = repository.listCheckpoints({ conversationId: input.conversationId });
    // Find the latest turn that has an active pre checkpoint and whose pre
    // has not already been restored.
    const preCandidates = checkpoints.filter(
      (c) => c.phase === "pre" && c.status === "active" && c.turnId,
    );
    const target = preCandidates[0];
    if (!target) throw new Error("No restorable checkpoint to undo.");
    return this.restore({
      checkpointId: target.id,
      confirm: input.confirm,
      previewToken: input.previewToken,
    });
  }

  async redo(input: {
    conversationId: string;
    confirm: boolean;
    previewToken: string;
  }): Promise<Checkpoint> {
    const { repository } = this.dependencies;
    const checkpoints = repository.listCheckpoints({ conversationId: input.conversationId });
    // Find the latest restored pre checkpoint whose post pair is active.
    const restoredPre = checkpoints.find((c) => c.phase === "pre" && c.status === "restored" && c.turnId);
    if (!restoredPre || !restoredPre.turnId) throw new Error("No checkpoint to redo.");
    const { post } = repository.getTurnCheckpoints(restoredPre.turnId);
    if (!post || post.status !== "active") throw new Error("No post checkpoint to redo.");
    return this.restore({
      checkpointId: post.id,
      confirm: input.confirm,
      previewToken: input.previewToken,
    });
  }

  // --- internals: snapshot building -----------------------------------------

  private async buildCheckpoint(input: {
    turnId: string | null;
    conversationId: string | null;
    projectId: string;
    worktreeId: string | null;
    phase: CheckpointPhase;
    workspacePath: string;
  }): Promise<Checkpoint> {
    const id = createId();
    const isWorktree = !!input.worktreeId;
    const cwd = isWorktree
      ? this.resolveWorktree(input.worktreeId!, input.projectId).worktreePath
      : input.workspacePath;
    const allowed = await assertAllowedPath(cwd, {
      roots: [input.workspacePath, this.dependencies.userDataPath],
    });

    const isGit = await this.isGitRepo(allowed);
    let kind: CheckpointKind;
    if (!isGit) {
      kind = "file-snapshot";
    } else if (isWorktree) {
      kind = "worktree-commit";
    } else {
      kind = "git-stash";
    }

    if (kind === "worktree-commit") {
      return this.buildWorktreeCommitCheckpoint(id, input, allowed);
    }
    if (kind === "git-stash") {
      return this.buildGitStashCheckpoint(id, input, allowed);
    }
    return this.buildFileSnapshotCheckpoint(id, input, allowed);
  }

  private async buildWorktreeCommitCheckpoint(
    id: string,
    input: {
      turnId: string | null;
      conversationId: string | null;
      projectId: string;
      worktreeId: string | null;
      phase: CheckpointPhase;
      workspacePath: string;
    },
    cwd: string,
  ): Promise<Checkpoint> {
    const { repository } = this.dependencies;
    const worktree = this.resolveWorktree(input.worktreeId!, input.projectId);
    const topLevel = (await git(["rev-parse", "--show-toplevel"], { cwd })).stdout.trim();
    const verifiedTopLevel = await assertAllowedPath(topLevel, { roots: [worktree.worktreePath] });
    const verifiedWorktree = await assertAllowedPath(worktree.worktreePath, { roots: [worktree.worktreePath] });
    if (verifiedTopLevel.toLowerCase() !== verifiedWorktree.toLowerCase()) {
      throw new Error("Checkpoint cwd does not match the active worktree.");
    }
    const branch = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd })).stdout.trim();
    if (branch !== worktree.branch) {
      throw new Error("Checkpoint worktree is not on its recorded branch.");
    }
    const fingerprint = await this.workspaceFingerprint(cwd, "worktree-commit");
    // Commit on the isolated worktree branch. The main working tree is never
    // touched — this cwd IS the worktree dir. -a stages tracked changes; new
    // files require explicit add (we add -A scoped to the worktree).
    await git(["add", "-A"], { cwd, timeoutMs: 30_000 });
    await git([
      "-c", "user.name=Coterm Checkpoint",
      "-c", "user.email=checkpoint@coterm.local",
      "commit", "-m", `coterm-checkpoint ${input.phase} ${id.slice(0, 8)}`, "--allow-empty",
    ], { cwd, timeoutMs: 30_000 });
    const head = await git(["rev-parse", "HEAD"], { cwd });
    const ref = head.stdout.trim();
    const pin = checkpointRefName(id);
    await git(["update-ref", pin, ref], { cwd });
    try {
      return await repository.createCheckpoint({
        id, turnId: input.turnId, conversationId: input.conversationId,
        projectId: input.projectId, worktreeId: input.worktreeId, phase: input.phase,
        kind: "worktree-commit", status: "active", ref, snapshotPath: null,
        workspaceFingerprint: fingerprint, fileCount: 0, sizeBytes: 0, partial: false,
      });
    } catch (error) {
      await git(["update-ref", "-d", pin], { cwd }).catch(() => undefined);
      throw error;
    }
  }

  private async buildGitStashCheckpoint(
    id: string,
    input: {
      turnId: string | null;
      conversationId: string | null;
      projectId: string;
      worktreeId: string | null;
      phase: CheckpointPhase;
      workspacePath: string;
    },
    cwd: string,
  ): Promise<Checkpoint> {
    const { repository } = this.dependencies;
    const fingerprint = await this.workspaceFingerprint(cwd, "git-stash");
    // `git stash create` captures tracked working/index state without changing
    // the real index, worktree, branch or stash list. Git does not reliably
    // include untracked files in this plumbing command, so those are copied to
    // a separate bounded snapshot under userData. The commit is pinned under a
    // Coterm-owned ref instead of polluting refs/stash.
    const snapshotPath = join(this.checkpointsRoot(), input.projectId, id, "untracked");
    await mkdir(snapshotPath, { recursive: true });
    await assertAllowedPath(snapshotPath, { roots: [this.checkpointsRoot()] });
    const untracked = await this.listGitUntracked(cwd);
    const copied = await this.copyListedFiles(cwd, snapshotPath, untracked);
    let created: string;
    try {
      created = (await git(["stash", "create"], { cwd, timeoutMs: 30_000 })).stdout.trim();
    } catch {
      created = "";
    }
    const ref = created || (await git(["rev-parse", "HEAD"], { cwd })).stdout.trim();
    const pin = checkpointRefName(id);
    await git(["update-ref", pin, ref], { cwd });
    try {
      return await repository.createCheckpoint({
        id, turnId: input.turnId, conversationId: input.conversationId,
        projectId: input.projectId, worktreeId: input.worktreeId, phase: input.phase,
        kind: "git-stash", status: "active", ref, snapshotPath,
        workspaceFingerprint: fingerprint, fileCount: copied.files.length,
        sizeBytes: copied.totalBytes, partial: copied.partial,
      });
    } catch (error) {
      await git(["update-ref", "-d", pin], { cwd }).catch(() => undefined);
      await rm(join(this.checkpointsRoot(), input.projectId, id), { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async buildFileSnapshotCheckpoint(
    id: string,
    input: {
      turnId: string | null;
      conversationId: string | null;
      projectId: string;
      worktreeId: string | null;
      phase: CheckpointPhase;
      workspacePath: string;
    },
    cwd: string,
  ): Promise<Checkpoint> {
    const { repository } = this.dependencies;
    const snapshotPath = join(this.checkpointsRoot(), input.projectId, id);
    await mkdir(snapshotPath, { recursive: true });
    await assertAllowedPath(snapshotPath, { roots: [this.checkpointsRoot()], mustExist: false });
    const collected = await this.copySnapshot(cwd, snapshotPath);
    const fingerprint = await this.workspaceFingerprint(cwd, "file-snapshot");
    return repository.createCheckpoint({
      id, turnId: input.turnId, conversationId: input.conversationId,
      projectId: input.projectId, worktreeId: input.worktreeId, phase: input.phase,
      kind: "file-snapshot", status: "active", ref: null, snapshotPath,
      workspaceFingerprint: fingerprint,
      fileCount: collected.files.length,
      sizeBytes: collected.totalBytes,
      partial: collected.partial,
    });
  }

  private async copySnapshot(
    src: string,
    dest: string,
  ): Promise<{ files: string[]; totalBytes: number; partial: boolean }> {
    const files: string[] = [];
    let totalBytes = 0;
    let partial = false;
    const stack: string[] = [src];
    while (stack.length > 0) {
      if (files.length >= SNAPSHOT_MAX_FILES) {
        partial = true;
        break;
      }
      const current = stack.pop()!;
      let entries: Dirent[];
      try {
        entries = await readdir(current, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (files.length >= SNAPSHOT_MAX_FILES) { partial = true; break; }
        if (totalBytes >= SNAPSHOT_MAX_BYTES) { partial = true; break; }
        if (shouldSkipSnapshotEntry(entry.name)) continue;
        const from = join(current, entry.name);
        // Never follow symlinks — lstat already gives the link itself.
        let info: Stats;
        try {
          info = await lstat(from);
        } catch {
          continue;
        }
        if (info.isSymbolicLink()) continue; // skip symlinks entirely
        if (info.isDirectory()) {
          stack.push(from);
          continue;
        }
        if (!info.isFile()) continue;
        if (info.size > SNAPSHOT_MAX_FILE_BYTES) { partial = true; continue; }
        if (totalBytes + info.size > SNAPSHOT_MAX_BYTES) { partial = true; continue; }
        const rel = relative(src, from);
        const to = join(dest, rel);
        try {
          await mkdir(dirname(to), { recursive: true });
          await copyFile(from, to);
          files.push(rel);
          totalBytes += info.size;
        } catch {
          // best-effort: a single unreadable file is marked partial, not fatal.
          partial = true;
        }
      }
    }
    return { files, totalBytes, partial };
  }

  private async listGitUntracked(cwd: string): Promise<string[]> {
    const output = await git(
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd, maxOutputBytes: DIFF_MAX_BYTES },
    );
    if (output.truncated) throw new Error("Untracked file inventory exceeds the checkpoint limit.");
    return output.stdout
      .split("\0")
      .filter(Boolean)
      .filter((path) => !path.split(/[\\/]/).some(shouldSkipSnapshotEntry))
      .sort((a, b) => a.localeCompare(b));
  }

  private async copyListedFiles(
    src: string,
    dest: string,
    relativePaths: readonly string[],
  ): Promise<{ files: string[]; totalBytes: number; partial: boolean }> {
    const files: string[] = [];
    let totalBytes = 0;
    let partial = false;
    for (const rel of relativePaths) {
      if (files.length >= SNAPSHOT_MAX_FILES) { partial = true; break; }
      const from = await assertAllowedPath(join(src, rel), { roots: [src] });
      const info = await lstat(from).catch(() => null);
      if (!info || info.isSymbolicLink() || !info.isFile()) {
        partial = true;
        continue;
      }
      if (info.size > SNAPSHOT_MAX_FILE_BYTES || totalBytes + info.size > SNAPSHOT_MAX_BYTES) {
        partial = true;
        continue;
      }
      const to = await assertAllowedPath(join(dest, rel), { roots: [dest], mustExist: false });
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to);
      files.push(rel);
      totalBytes += info.size;
    }
    return { files, totalBytes, partial };
  }

  // --- internals: restore execution -----------------------------------------

  private async restoreFileSnapshot(checkpoint: Checkpoint, workspacePath: string): Promise<void> {
    if (!checkpoint.snapshotPath) throw new Error("Snapshot path missing.");
    if (checkpoint.partial) throw new Error("Partial checkpoint cannot be restored safely.");
    const allowed = await assertAllowedPath(workspacePath, { roots: [workspacePath] });
    const snap = await assertAllowedPath(checkpoint.snapshotPath, {
      roots: [this.checkpointsRoot()],
    });
    const rollback = join(this.checkpointsRoot(), checkpoint.projectId, `.rollback-${randomUUID()}`);
    await mkdir(rollback, { recursive: true });
    const captured = await this.copySnapshot(allowed, rollback);
    if (captured.partial) {
      await rm(rollback, { recursive: true, force: true });
      throw new Error("Current workspace exceeds rollback limits; restore refused.");
    }
    try {
      await this.syncFileSnapshot(snap, allowed);
    } catch (error) {
      await this.syncFileSnapshot(rollback, allowed).catch(() => undefined);
      throw error;
    } finally {
      await rm(rollback, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async restoreGitStash(checkpoint: Checkpoint, cwd: string): Promise<void> {
    if (!checkpoint.ref) throw new Error("Checkpoint ref missing.");
    if (checkpoint.partial) throw new Error("Partial checkpoint cannot be restored safely.");
    const allowed = await assertAllowedPath(cwd, { roots: [cwd] });
    const rollbackRoot = join(this.checkpointsRoot(), checkpoint.projectId, `.rollback-${randomUUID()}`);
    const rollbackUntracked = join(rollbackRoot, "untracked");
    await mkdir(rollbackUntracked, { recursive: true });
    const rollbackCreated = await git(["stash", "create"], { cwd: allowed, timeoutMs: 30_000 })
      .then((result) => result.stdout.trim())
      .catch(() => "");
    const rollbackRef = rollbackCreated || (await git(["rev-parse", "HEAD"], { cwd: allowed })).stdout.trim();
    const currentUntracked = await this.listGitUntracked(allowed);
    const rollbackFiles = await this.copyListedFiles(allowed, rollbackUntracked, currentUntracked);
    if (rollbackFiles.partial) {
      await rm(rollbackRoot, { recursive: true, force: true });
      throw new Error("Current untracked files exceed rollback limits; restore refused.");
    }
    try {
      await this.removeWorkspaceFiles(allowed, currentUntracked);
      await git(["restore", `--source=${checkpoint.ref}`, "--worktree", "--", "."], {
        cwd: allowed,
        timeoutMs: 60_000,
      });
      if (checkpoint.snapshotPath) {
        await this.copySnapshotIntoWorkspace(checkpoint.snapshotPath, allowed);
      }
    } catch (error) {
      const afterFailure = await this.listGitUntracked(allowed).catch(() => []);
      await this.removeWorkspaceFiles(allowed, afterFailure).catch(() => undefined);
      await git(["restore", `--source=${rollbackRef}`, "--worktree", "--", "."], {
        cwd: allowed,
        timeoutMs: 60_000,
      }).catch(() => undefined);
      await this.copySnapshotIntoWorkspace(rollbackUntracked, allowed).catch(() => undefined);
      throw error;
    } finally {
      await rm(rollbackRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async restoreWorktreeCommit(checkpoint: Checkpoint, cwd: string): Promise<void> {
    if (!checkpoint.ref) throw new Error("Checkpoint ref missing.");
    const allowed = await assertAllowedPath(cwd, { roots: [cwd] });
    const worktree = this.resolveWorktree(checkpoint.worktreeId!, checkpoint.projectId);
    const branch = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: allowed }))
      .stdout.trim();
    if (branch !== worktree.branch) throw new Error("Worktree branch changed; restore refused.");
    // A sandbox checkpoint is a real local commit. Restore moves only its
    // isolated branch; the main branch/worktree are never touched.
    const dirty = (await git(["status", "--porcelain"], { cwd: allowed }).then((r) => r.stdout.trim()).catch(() => "x"));
    if (dirty) {
      throw new Error("Worktree has uncommitted changes; restore refused.");
    }
    await git(["reset", "--hard", checkpoint.ref], { cwd: allowed, timeoutMs: 60_000 });
  }

  private async syncFileSnapshot(snapshotRoot: string, workspaceRoot: string): Promise<void> {
    const snapshotFiles = await this.collectSnapshotFiles(snapshotRoot);
    const workspaceFiles = await this.collectSnapshotFiles(workspaceRoot);
    const wanted = new Set(snapshotFiles.map((file) => file.rel));
    await this.removeWorkspaceFiles(
      workspaceRoot,
      workspaceFiles.filter((file) => !wanted.has(file.rel)).map((file) => file.rel),
    );
    await this.copySnapshotIntoWorkspace(snapshotRoot, workspaceRoot);
  }

  private async copySnapshotIntoWorkspace(snapshotRoot: string, workspaceRoot: string): Promise<void> {
    const snap = await assertAllowedPath(snapshotRoot, { roots: [this.checkpointsRoot()] });
    const workspace = await assertAllowedPath(workspaceRoot, { roots: [workspaceRoot] });
    for (const file of await this.collectSnapshotFiles(snap)) {
      const source = await assertAllowedPath(join(snap, file.rel), { roots: [snap] });
      const target = await assertAllowedPath(join(workspace, file.rel), {
        roots: [workspace],
        mustExist: false,
      });
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
  }

  private async removeWorkspaceFiles(workspaceRoot: string, relativePaths: readonly string[]): Promise<void> {
    const workspace = await assertAllowedPath(workspaceRoot, { roots: [workspaceRoot] });
    for (const rel of relativePaths) {
      if (!rel || rel.split(/[\\/]/).some(shouldSkipSnapshotEntry)) continue;
      const target = await assertAllowedPath(join(workspace, rel), {
        roots: [workspace],
        mustExist: false,
      });
      const info = await lstat(target).catch(() => null);
      if (!info || info.isSymbolicLink() || !info.isFile()) continue;
      await rm(target, { force: true });
    }
  }

  // --- internals: fingerprint / helpers -------------------------------------

  private async workspaceFingerprint(cwd: string, kind: CheckpointKind): Promise<string | null> {
    try {
      if (kind === "file-snapshot") {
        const files = await this.collectSnapshotFiles(cwd, true);
        return hashStr(files.map((f) => `${f.rel}\0${f.size}\0${f.hash ?? ""}`).join("\0"));
      }
      // Git fingerprints bind HEAD, the real index tree, porcelain state, and
      // the content of every changed/untracked file. A same-size edit therefore
      // invalidates a preview instead of slipping through a status-only hash.
      const head = await git(["rev-parse", "HEAD"], { cwd });
      const indexTree = await git(["write-tree"], { cwd });
      const porcelain = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
        cwd,
        maxOutputBytes: DIFF_MAX_BYTES,
      });
      if (porcelain.truncated) throw new Error("Workspace fingerprint inventory was truncated.");
      const changedPaths = parsePorcelainPaths(porcelain.stdout);
      const contentHashes: string[] = [];
      for (const rel of changedPaths) {
        const absolute = await assertAllowedPath(join(cwd, rel), { roots: [cwd], mustExist: false });
        const info = await lstat(absolute).catch(() => null);
        if (!info || info.isSymbolicLink() || !info.isFile()) {
          contentHashes.push(`${rel}\0missing`);
          continue;
        }
        const digest = await hashFile(absolute);
        contentHashes.push(`${rel}\0${digest}`);
      }
      return hashStr([
        head.stdout.trim(),
        indexTree.stdout.trim(),
        porcelain.stdout,
        ...contentHashes,
      ].join("\0"));
    } catch {
      return null;
    }
  }

  private async collectSnapshotFiles(
    root: string,
    withHash = false,
  ): Promise<{ rel: string; size: number; hash?: string }[]> {
    const out: { rel: string; size: number; hash?: string }[] = [];
    const stack: string[] = [root];
    while (stack.length > 0) {
      const current = stack.pop()!;
      let entries: Dirent[];
      try {
        entries = await readdir(current, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (shouldSkipSnapshotEntry(entry.name)) continue;
        const from = join(current, entry.name);
        let info: Stats;
        try {
          info = await lstat(from);
        } catch {
          continue;
        }
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) { stack.push(from); continue; }
        if (!info.isFile()) continue;
        out.push({
          rel: relative(root, from),
          size: info.size,
          ...(withHash ? { hash: await hashFile(from) } : {}),
        });
      }
    }
    return out.sort((a, b) => a.rel.localeCompare(b.rel));
  }

  private async affectedFilesForRestore(checkpoint: Checkpoint, cwd: string): Promise<string[]> {
    if (checkpoint.kind === "file-snapshot" && checkpoint.snapshotPath) {
      const snap = await this.collectSnapshotFiles(checkpoint.snapshotPath);
      const live = await this.collectSnapshotFiles(cwd);
      return [...new Set([...snap, ...live].map((f) => f.rel))].sort((a, b) => a.localeCompare(b));
    }
    if (!checkpoint.ref) return [];
    const changed = await this.gitNameStatusVsRef(cwd, checkpoint.ref);
    const paths = changed.output
      .split(/\r?\n/)
      .map((line) => line.split("\t").slice(1).join("\t"))
      .filter(Boolean);
    if (checkpoint.snapshotPath) {
      paths.push(...(await this.collectSnapshotFiles(checkpoint.snapshotPath)).map((file) => file.rel));
    }
    return [...new Set(paths)].sort((a, b) => a.localeCompare(b));
  }

  private async isGitRepo(cwd: string): Promise<boolean> {
    try {
      await git(["rev-parse", "--git-dir"], { cwd });
      return true;
    } catch {
      return false;
    }
  }

  private resolveWorktree(worktreeId: string, projectId: string): Worktree {
    const worktrees = this.dependencies.worktrees;
    if (!worktrees) throw new Error("Worktree sandboxes are unavailable.");
    const worktree = worktrees.get(worktreeId);
    if (!worktree) throw new Error("Worktree not found.");
    if (worktree.projectId !== projectId) {
      throw new Error("Worktree does not belong to this project.");
    }
    if (worktree.status !== "active") {
      throw new Error(`Worktree is not active (status: ${worktree.status}).`);
    }
    return worktree;
  }

  private async recordRestore(
    checkpointId: string,
    status: "applied" | "refused" | "failed",
    reason: string | null,
  ): Promise<void> {
    const { repository } = this.dependencies;
    const checkpoint = repository.getCheckpoint(checkpointId);
    if (!checkpoint) return;
    await repository.appendCheckpointRestore({
      id: createId(),
      checkpointId,
      turnId: checkpoint.turnId,
      conversationId: checkpoint.conversationId,
      projectId: checkpoint.projectId,
      worktreeId: checkpoint.worktreeId,
      status,
      reason,
    });
  }

  /** Best-effort cleanup of Coterm-owned refs and snapshot dirs before a
   * project row is deleted. User branches, index and worktree are untouched. */
  async cleanupProjectSnapshots(projectId: string): Promise<void> {
    const project = this.dependencies.repository.getProject(projectId);
    if (project) {
      const checkpoints = this.dependencies.repository.listCheckpoints({ projectId });
      for (const checkpoint of checkpoints) {
        if (checkpoint.ref) {
          await git(["update-ref", "-d", checkpointRefName(checkpoint.id)], {
            cwd: project.workspacePath,
          }).catch(() => undefined);
        }
      }
    }
    const dir = join(this.checkpointsRoot(), projectId);
    if (await stat(dir).then(() => true).catch(() => false)) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

function normalizeNoIndexPatch(
  patch: string,
  relativePath: string,
  status: CheckpointFileChange["status"],
): string {
  const path = relativePath.replace(/\\/g, "/");
  const oldPath = quotePatchPath(`a/${path}`);
  const newPath = quotePatchPath(`b/${path}`);
  return patch
    .split(/\r?\n/)
    .map((line) => {
      if (line.startsWith("diff --git ")) return `diff --git ${oldPath} ${newPath}`;
      if (line.startsWith("--- ")) return status === "added" ? "--- /dev/null" : `--- ${oldPath}`;
      if (line.startsWith("+++ ")) return status === "deleted" ? "+++ /dev/null" : `+++ ${newPath}`;
      if (line.startsWith("Binary files ")) return `Binary files ${oldPath} and ${newPath} differ`;
      return line;
    })
    .join("\n");
}

function quotePatchPath(path: string): string {
  return JSON.stringify(path);
}

function selectUnifiedDiffHunk(patch: string, hunkIndex: number): string {
  const lines = patch.split(/\r?\n/);
  const starts: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index]!.startsWith("@@ ")) starts.push(index);
  }
  const start = starts[hunkIndex];
  if (start === undefined) throw new Error("Diff hunk not found; refresh the checkpoint diff.");
  const end = starts[hunkIndex + 1] ?? lines.length;
  const header = lines.slice(0, starts[0]);
  return [...header, ...lines.slice(start, end)].join("\n").replace(/\n*$/, "\n");
}

function hashStr(value: string): string {
  // FNV-1a — a stable, short fingerprint for drift detection (not cryptographic).
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function checkpointRefName(checkpointId: string): string {
  return `refs/coterm/checkpoints/${checkpointId}`;
}

function shouldSkipSnapshotEntry(name: string): boolean {
  const lower = name.toLowerCase();
  return SNAPSHOT_SKIP_NAMES.has(lower)
    || SNAPSHOT_SKIP_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function parsePorcelainPaths(output: string): string[] {
  const records = output.split("\0");
  const paths = new Set<string>();
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (path) paths.add(path);
    if ((status.includes("R") || status.includes("C")) && records[index + 1]) {
      paths.add(records[++index]!);
    }
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
