import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Repository } from "../storage/repository";
import type { PtyManager } from "../terminal/pty-manager";
import { assertAllowedPath } from "../security/path-policy";
import { git, isGitError } from "../security/git-helper";
import { createId, nowIso } from "./ids";
import { logger } from "./logger";
import type { Worktree, WorktreePermissionsPreset } from "@shared/types";

const DEFAULT_BRANCH_PREFIX = "codex/";
// git ref-name rules: no control chars, no space, no ~ ^ : ? * [ \, and cannot
// end with .lock / . or begin with . or -.
const BRANCH_NAME_RE = /^(?!\.|-)(?!.*\.\.)(?!.*[~^:?*[\]\\ ])[A-Za-z0-9./_@-]{1,180}(?<![.])$/;
// A base ref is either a branch name, a tag, or a short/full SHA.
const BASE_REF_RE = /^(?!-)[A-Za-z0-9./_@-]{1,200}$/;

export interface WorktreeManagerDependencies {
  repository: Repository;
  terminals: Pick<PtyManager, "list" | "get">;
  userDataPath: string;
}

export interface CreateWorktreeOptions {
  projectId: string;
  branch?: string | undefined;
  baseRef?: string | undefined;
  permissionsPreset?: WorktreePermissionsPreset | undefined;
}

export interface MergeDiffSummary {
  worktreeId: string;
  branch: string;
  baseRef: string;
  /** `git diff --stat` of base..worktree HEAD. */
  diffStat: string;
  /** `git log --oneline` base..HEAD (commit subjects). */
  commits: string;
  /** True when the worktree has uncommitted changes (merge refused). */
  dirty: boolean;
}

/**
 * WorktreeManager — owns the git worktree sandbox lifecycle.
 *
 * Worktrees live at `<userData>/worktrees/<projectId>/<worktreeId>`. Merge is
 * allowed only while the main workspace is clean, on the recorded base branch,
 * and has no running project PTY. A conflict is immediately aborted so main is
 * restored while the sandbox remains available for human repair.
 *
 * DB + Git/FS failures are compensated: if `git worktree add` succeeds but the
 * DB insert fails, the worktree dir is removed; if the DB row exists but the
 * dir is missing, cleanup reconciles. cleanup is idempotent.
 *
 * A worktree with a running PTY bound to it refuses merge/abort/cleanup — the
 * caller must close the terminal first. We never kill the PTY ourselves.
 */
export class WorktreeManager {
  constructor(private readonly dependencies: WorktreeManagerDependencies) {}

  private worktreesRoot(): string {
    return join(this.dependencies.userDataPath, "worktrees");
  }

  private worktreePath(projectId: string, worktreeId: string): string {
    return join(this.worktreesRoot(), projectId, worktreeId);
  }

  async create(options: CreateWorktreeOptions): Promise<Worktree> {
    const { repository } = this.dependencies;
    const project = repository.getProject(options.projectId);
    if (!project) throw new Error("Project not found.");

    // The project workspace must be a real git repo (the worktree shares its
    // .git). We do NOT create the repo — a non-repo project is a caller bug.
    await this.requireGitRepo(project.workspacePath);

    const worktreeId = createId();
    const branch = this.validateBranchName(options.branch ?? `${DEFAULT_BRANCH_PREFIX}${worktreeId.slice(0, 8)}`);
    const baseRef = await this.resolveBaseRef(project.workspacePath, options.baseRef);
    const permissionsPreset = options.permissionsPreset ?? "ask";
    const worktreePath = this.worktreePath(options.projectId, worktreeId);

    // Containment: the worktree path is under userData/worktrees. The parent
    // dir is created first so the nearest existing ancestor of the (not-yet-
    // created) worktree path is the project's worktrees dir, not userData —
    // this keeps the mustExist:false symlink-escape guard scoped to the
    // worktrees root.
    const worktreesRoot = this.worktreesRoot();
    await mkdir(join(worktreesRoot, options.projectId), { recursive: true });
    await assertAllowedPath(worktreePath, {
      roots: [worktreesRoot],
      mustExist: false,
    });
    if (await this.pathExists(worktreePath)) {
      throw new Error("Generated worktree path already exists.");
    }
    await git(["check-ref-format", "--branch", branch], { cwd: project.workspacePath });
    const branchExists = await git(
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: project.workspacePath },
    ).then(() => true).catch(() => false);
    if (branchExists) throw new Error(`Branch already exists: ${branch}`);

    // `git worktree add` shares the repo (no manual workspace copy, no
    // .env/token copy — the worktree is just a linked checkout).
    try {
      await git(
        ["worktree", "add", "-b", branch, worktreePath, baseRef],
        { cwd: project.workspacePath, timeoutMs: 60_000 },
      );
    } catch (error) {
      logger.warn("security", "worktree.create.git.failed", "git worktree add failed", {
        projectId: options.projectId,
        worktreeId,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.rollbackNewWorktree(project.workspacePath, worktreePath, branch);
      throw error;
    }

    // DB insert. If it fails, compensate by removing the worktree dir so no
    // orphan checkout is left behind.
    let worktree: Worktree;
    try {
      worktree = await repository.createWorktree({
        id: worktreeId,
        projectId: options.projectId,
        branch,
        worktreePath,
        baseRef,
        permissionsPreset,
      });
    } catch (error) {
      await this.rollbackNewWorktree(project.workspacePath, worktreePath, branch);
      throw error;
    }

    logger.audit("security", "worktree.created", "Worktree sandbox created", {
      projectId: options.projectId,
      worktreeId,
      branch,
    });
    return worktree;
  }

  list(projectId: string): Worktree[] {
    return this.dependencies.repository
      .listWorktrees(projectId)
      .map((worktree) => ({ ...worktree, hasRunningTerminal: this.hasRunningTerminal(worktree) }));
  }

  get(worktreeId: string): Worktree | null {
    const worktree = this.dependencies.repository.getWorktree(worktreeId);
    return worktree ? { ...worktree, hasRunningTerminal: this.hasRunningTerminal(worktree) } : null;
  }

  /** Read-only preflight used before project deletion closes any terminals. */
  async assertProjectCanDelete(projectId: string): Promise<void> {
    for (const worktree of this.list(projectId)) {
      if (await this.pathExists(worktree.worktreePath) && await this.isDirty(worktree)) {
        throw new Error(`Worktree ${worktree.id} has uncommitted changes; project deletion refused.`);
      }
    }
  }

  /**
   * Return a diff summary for a worktree, to show before merging. Does NOT
   * merge. The caller reviews diffStat + commits, then calls merge with
   * confirm:true.
   */
  async diffSummary(worktreeId: string): Promise<MergeDiffSummary> {
    const worktree = this.requireActiveWorktree(worktreeId);
    const dirty = await this.isDirty(worktree);
    const [diffStat, commits] = await Promise.all([
      git(["diff", "--stat", `${worktree.baseRef}...HEAD`], { cwd: worktree.worktreePath })
        .then((r) => r.stdout).catch(() => ""),
      git(["log", "--oneline", `${worktree.baseRef}..HEAD`], { cwd: worktree.worktreePath })
        .then((r) => r.stdout).catch(() => ""),
    ]);
    return {
      worktreeId: worktree.id,
      branch: worktree.branch,
      baseRef: worktree.baseRef,
      diffStat,
      commits,
      dirty,
    };
  }

  /**
   * Merge the worktree branch back into baseRef. Safety design:
   * - requires confirm:true (caller reviewed the diff summary)
   * - refuses if the worktree is dirty (uncommitted changes)
   * - refuses if a PTY is still running in the worktree
   * - requires the project workspace to be clean, on the original base branch,
   *   and free of running project terminals before touching it
   * - runs `git merge --no-ff <sandbox-branch>` in that clean base worktree
   * - on conflict, immediately `git merge --abort` restores the main worktree,
   *   records conflict metadata, and leaves the sandbox intact for a human
   * - on success, sets status=merged
   *
   * The base branch must already be checked out in the project workspace; this
   * method never switches branches. It merges the sandbox branch directly into
   * that checked-out base branch, so a successful return means the base branch
   * has advanced and the worktree lifecycle can be marked merged.
   */
  async merge(worktreeId: string, confirm: boolean): Promise<Worktree> {
    if (!confirm) throw new Error("Merge requires explicit confirmation.");
    const worktree = this.requireActiveWorktree(worktreeId);
    await this.requireNoRunningTerminal(worktree, true);
    if (await this.isDirty(worktree)) {
      throw new Error("Worktree has uncommitted changes; commit or abort before merging.");
    }
    const repo = this.dependencies.repository;
    const project = repo.getProject(worktree.projectId);
    if (!project) throw new Error("Project not found.");
    if (await this.isRepoDirty(project.workspacePath)) {
      throw new Error("Main working tree has uncommitted changes; merge refused.");
    }
    const baseBranch = await this.currentBranch(project.workspacePath);
    if (!baseBranch || baseBranch !== worktree.baseRef) {
      throw new Error(`Main working tree must be on base branch ${worktree.baseRef}; merge refused.`);
    }
    try {
      await git(["merge", "--no-ff", "--no-edit", worktree.branch], {
        cwd: project.workspacePath,
        timeoutMs: 60_000,
      });
    } catch (error) {
      const unmerged = await git(
        ["diff", "--name-only", "--diff-filter=U"],
        { cwd: project.workspacePath },
      ).then((result) => result.stdout.trim()).catch(() => "");
      // Always attempt to restore the clean main worktree before reporting.
      await git(["merge", "--abort"], { cwd: project.workspacePath }).catch(() => undefined);
      if (unmerged || (isGitError(error) && /conflict|CONFLICT/i.test(error.message))) {
        await repo.updateWorktreeStatus(worktreeId, "conflict");
        logger.warn("security", "worktree.merge.conflict", "Worktree merge conflict", {
          worktreeId, projectId: worktree.projectId,
        });
        throw new Error("Merge conflict. The worktree is left in conflict status for manual resolution.", { cause: error });
      }
      throw error;
    }
    await repo.updateWorktreeStatus(worktreeId, "merged", { closedAt: nowIso() });
    logger.audit("security", "worktree.merged", "Worktree merged", {
      worktreeId, projectId: worktree.projectId,
    });
    return repo.getWorktree(worktreeId)!;
  }

  /**
   * Abort an active/conflict sandbox lifecycle. A previous merge conflict was
   * already aborted in the main worktree; this marks the sandbox abandoned
   * without deleting its commits/files. cleanup is a separate guarded step.
   */
  async abort(worktreeId: string): Promise<Worktree> {
    const worktree = this.requireWorktreeForAbort(worktreeId);
    await this.requireNoRunningTerminal(worktree);
    const repo = this.dependencies.repository;
    // Best-effort: if a merge is in progress, abort it. No-op otherwise.
    await git(["merge", "--abort"], { cwd: worktree.worktreePath }).catch(() => undefined);
    await repo.updateWorktreeStatus(worktreeId, "aborted", { closedAt: nowIso() });
    logger.audit("security", "worktree.aborted", "Worktree aborted", {
      worktreeId, projectId: worktree.projectId,
    });
    return repo.getWorktree(worktreeId)!;
  }

  /**
   * Idempotent cleanup: remove the worktree dir (git worktree remove --force
   * if the dir exists) and delete the DB row. Refuses if a PTY is still running
   * in the worktree. Safe to call on an already-cleaned worktree (no-op).
   */
  async cleanup(worktreeId: string): Promise<void> {
    const { repository } = this.dependencies;
    const worktree = repository.getWorktree(worktreeId);
    if (!worktree) return; // idempotent: already gone
    await this.requireNoRunningTerminal(worktree);
    const project = repository.getProject(worktree.projectId);
    if (project) {
      if (await this.pathExists(worktree.worktreePath) && await this.isDirty(worktree)) {
        throw new Error("Worktree has uncommitted changes; cleanup refused.");
      }
      await this.removeWorktreeDir(project.workspacePath, worktree.worktreePath);
    } else {
      throw new Error("Project not found; refusing to remove an unverified worktree path.");
    }
    await repository.deleteWorktree(worktreeId);
    logger.audit("security", "worktree.cleaned", "Worktree cleaned up", {
      worktreeId, projectId: worktree.projectId,
    });
  }

  /**
   * Reconcile a single worktree: if the DB row says active but the dir is gone,
   * mark it closed. Called on boot for each active worktree so stale rows
   * (e.g. userData wiped out of band) don't linger as active.
   */
  async reconcile(worktreeId: string): Promise<void> {
    const { repository } = this.dependencies;
    const worktree = repository.getWorktree(worktreeId);
    if (!worktree || worktree.status !== "active") return;
    const exists = await stat(worktree.worktreePath).then(() => true).catch(() => false);
    if (!exists) {
      await repository.updateWorktreeStatus(worktreeId, "closed", { closedAt: nowIso() });
      logger.warn("security", "worktree.reconciled.closed", "Stale worktree dir gone; marked closed", {
        worktreeId, projectId: worktree.projectId,
      });
    }
  }

  // --- internals ------------------------------------------------------------

  private requireActiveWorktree(worktreeId: string): Worktree {
    const worktree = this.dependencies.repository.getWorktree(worktreeId);
    if (!worktree) throw new Error("Worktree not found.");
    if (worktree.status !== "active") {
      throw new Error(`Worktree is not active (status: ${worktree.status}).`);
    }
    return worktree;
  }

  private requireWorktreeForAbort(worktreeId: string): Worktree {
    const worktree = this.dependencies.repository.getWorktree(worktreeId);
    if (!worktree) throw new Error("Worktree not found.");
    if (worktree.status !== "active" && worktree.status !== "conflict") {
      throw new Error(`Worktree cannot be aborted (status: ${worktree.status}).`);
    }
    return worktree;
  }

  private requireNoRunningTerminal(worktree: Worktree, wholeProject = false): Promise<void> {
    const { terminals } = this.dependencies;
    // A PTY bound to this worktree is still running → refuse destructive ops.
    // We never kill it; the caller must close the terminal first.
    for (const info of terminals.list(worktree.projectId)) {
      if (info.status === "running" && (wholeProject || info.worktreeId === worktree.id)) {
        throw new Error(`A terminal is still running in this worktree (terminalId: ${info.id}). Close it first.`);
      }
    }
    return Promise.resolve();
  }

  /** Read-only: does any running PTY point at this worktree? (for UI disable) */
  private hasRunningTerminal(worktree: Worktree): boolean {
    return this.dependencies.terminals
      .list(worktree.projectId)
      .some((info) => info.status === "running" && info.worktreeId === worktree.id);
  }

  private async requireGitRepo(workspacePath: string): Promise<void> {
    try {
      await git(["rev-parse", "--git-dir"], { cwd: workspacePath });
    } catch {
      throw new Error("Project workspace is not a git repository.");
    }
  }

  private async isDirty(worktree: Worktree): Promise<boolean> {
    try {
      const result = await git(["status", "--porcelain"], { cwd: worktree.worktreePath });
      return result.stdout.trim().length > 0;
    } catch {
      // Unknown state is unsafe for destructive operations.
      return true;
    }
  }

  private async isRepoDirty(workspacePath: string): Promise<boolean> {
    const result = await git(["status", "--porcelain"], { cwd: workspacePath });
    return result.stdout.trim().length > 0;
  }

  private async currentBranch(workspacePath: string): Promise<string | null> {
    return git(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: workspacePath })
      .then((result) => result.stdout.trim() || null)
      .catch(() => null);
  }

  private async resolveBaseRef(workspacePath: string, requested?: string): Promise<string> {
    if (requested) {
      const normalized = requested.startsWith("refs/heads/")
        ? requested.slice("refs/heads/".length)
        : requested;
      if (normalized === "HEAD") {
        return this.resolveBaseRef(workspacePath);
      }
      const baseRef = this.validateBaseRef(normalized);
      await git(["rev-parse", "--verify", `${baseRef}^{commit}`], { cwd: workspacePath });
      return baseRef;
    }
    const branch = await this.currentBranch(workspacePath);
    if (branch) return this.validateBaseRef(branch);
    const commit = await git(["rev-parse", "--verify", "HEAD"], { cwd: workspacePath });
    return this.validateBaseRef(commit.stdout.trim());
  }

  private pathExists(path: string): Promise<boolean> {
    return stat(path).then(() => true).catch(() => false);
  }

  private async removeWorktreeDir(workspacePath: string, worktreePath: string): Promise<void> {
    const exists = await this.pathExists(worktreePath);
    if (!exists) {
      await git(["worktree", "prune"], { cwd: workspacePath }).catch(() => undefined);
      return;
    }
    await git(["worktree", "remove", worktreePath], {
      cwd: workspacePath,
      timeoutMs: 60_000,
    });
  }

  /** Roll back only a branch/path freshly allocated by create(). */
  private async rollbackNewWorktree(workspacePath: string, worktreePath: string, branch: string): Promise<void> {
    if (await this.pathExists(worktreePath)) {
      await git(["worktree", "remove", "--force", worktreePath], {
        cwd: workspacePath,
        timeoutMs: 60_000,
      }).catch(async () => {
        await rm(worktreePath, { recursive: true, force: true });
      });
    }
    await git(["worktree", "prune"], { cwd: workspacePath }).catch(() => undefined);
    await git(["branch", "-D", branch], { cwd: workspacePath }).catch(() => undefined);
  }

  private validateBranchName(branch: string): string {
    if (!BRANCH_NAME_RE.test(branch)) {
      throw new Error(`Invalid branch name: ${branch}`);
    }
    if (branch.endsWith(".lock")) {
      throw new Error("Branch name must not end with .lock.");
    }
    return branch;
  }

  private validateBaseRef(baseRef: string): string {
    if (!BASE_REF_RE.test(baseRef)) {
      throw new Error(`Invalid base ref: ${baseRef}`);
    }
    return baseRef;
  }
}
