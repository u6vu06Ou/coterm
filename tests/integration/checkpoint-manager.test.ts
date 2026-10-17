import { mkdtemp, rm, writeFile, mkdir, readFile, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../../src/main/storage/database";
import { Repository } from "../../src/main/storage/repository";
import { WorktreeManager } from "../../src/main/core/worktree-manager";
import { CheckpointManager } from "../../src/main/core/checkpoint-manager";
import { git } from "../../src/main/security/git-helper";
import type { TerminalInfo } from "../../src/shared/types";

const execFileAsync = promisify(execFile);

async function gitIndexPath(cwd: string): Promise<string> {
  const value = (await git(["rev-parse", "--git-path", "index"], { cwd })).stdout.trim();
  return isAbsolute(value) ? value : resolve(cwd, value);
}

async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main"], { cwd: dir, shell: false, windowsHide: true });
  await execFileAsync("git", ["config", "user.email", "test@coterm.dev"], { cwd: dir, shell: false, windowsHide: true });
  await execFileAsync("git", ["config", "user.name", "Coterm Test"], { cwd: dir, shell: false, windowsHide: true });
  await writeFile(join(dir, "README.md"), "# initial\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: dir, shell: false, windowsHide: true });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: dir, shell: false, windowsHide: true });
}

function fakeTerminals(running: TerminalInfo[] = []) {
  return {
    list: (projectId: string) => running.filter((t) => t.projectId === projectId),
    get: (id: string) => running.find((t) => t.id === id) ?? null,
  };
}

describe("CheckpointManager — git non-worktree (stash mode)", () => {
  let directory: string;
  let userData: string;
  let database: AppDatabase;
  let repository: Repository;
  let projectWorkspace: string;
  let manager: CheckpointManager;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "coterm-cp-"));
    userData = await mkdtemp(join(tmpdir(), "coterm-cp-ud-"));
    projectWorkspace = join(directory, "repo");
    await mkdir(projectWorkspace, { recursive: true });
    await initRepo(projectWorkspace);
    database = new AppDatabase(join(userData, "state.sqlite"));
    await database.open();
    repository = new Repository(database);
    const project = await repository.createProject("Repo", projectWorkspace);
    manager = new CheckpointManager({
      repository,
      terminals: fakeTerminals(),
      userDataPath: userData,
    });
    void project;
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("creates a git-stash checkpoint without mutating the working tree or index", async () => {
    const project = repository.listProjects()[0]!;
    // Make a dirty working tree.
    const indexPath = await gitIndexPath(projectWorkspace);
    const indexBefore = await readFile(indexPath);
    const stashBefore = (await git(["stash", "list"], { cwd: projectWorkspace })).stdout;
    const branchBefore = (await git(["branch", "--show-current"], { cwd: projectWorkspace })).stdout;
    await writeFile(join(projectWorkspace, "new.txt"), "uncommitted\n");
    const cp = await manager.createExplicit({ projectId: project.id, phase: "pre" });
    expect(cp.kind).toBe("git-stash");
    expect(cp.status).toBe("active");
    expect(cp.ref).toBeTruthy();
    // The working tree is UNCHANGED — stash create does not touch it.
    expect(await readFile(join(projectWorkspace, "new.txt"), "utf8")).toBe("uncommitted\n");
    // The index/working tree porcelain still shows the file as untracked.
    const status = await git(["status", "--porcelain"], { cwd: projectWorkspace });
    expect(status.stdout).toContain("new.txt");
    expect(await readFile(indexPath)).toEqual(indexBefore);
    expect((await git(["stash", "list"], { cwd: projectWorkspace })).stdout).toBe(stashBefore);
    expect((await git(["branch", "--show-current"], { cwd: projectWorkspace })).stdout).toBe(branchBefore);
    expect((await git(["show-ref", `refs/coterm/checkpoints/${cp.id}`], { cwd: projectWorkspace })).stdout)
      .toContain(cp.ref!);
  }, 15_000);

  it("diff: pre..working shows changed files with additions/deletions", async () => {
    const project = repository.listProjects()[0]!;
    await manager.createExplicit({ projectId: project.id, phase: "pre" });
    await writeFile(join(projectWorkspace, "feature.txt"), "line1\nline2\n");
    const cps = manager.list({ projectId: project.id });
    const diff = await manager.diff(cps[0]!.id, "working");
    expect(diff.files.some((f) => f.path === "feature.txt" && f.status === "added")).toBe(true);
    const feature = diff.files.find((f) => f.path === "feature.txt")!;
    expect(feature.additions).toBeGreaterThan(0);
  }, 15_000);

  it("diff: pre..post compares the paired turn refs and untracked snapshots", async () => {
    const project = repository.listProjects()[0]!;
    const conversation = await repository.createConversation(project.id, "Diff pair", "claude-local-main");
    const turnId = await repository.startTurn(conversation.id, null);
    await writeFile(join(projectWorkspace, "untracked.txt"), "before\n");
    const pre = await manager.createTurnCheckpoint({
      turnId,
      conversationId: conversation.id,
      projectId: project.id,
      worktreeId: null,
      phase: "pre",
    });
    await writeFile(join(projectWorkspace, "README.md"), "# after\n");
    await writeFile(join(projectWorkspace, "untracked.txt"), "after\n");
    await writeFile(join(projectWorkspace, "new.txt"), "new\n");
    const post = await manager.finalizeTurnCheckpoint({
      turnId,
      conversationId: conversation.id,
      projectId: project.id,
      worktreeId: null,
      phase: "post",
    });
    expect(pre?.status).toBe("active");
    expect(post?.status).toBe("active");

    const diff = await manager.diff(post!.id, "pre");
    expect(diff.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "README.md", status: "modified" }),
      expect.objectContaining({ path: "untracked.txt", status: "modified" }),
      expect.objectContaining({ path: "new.txt", status: "added" }),
    ]));
  }, 15_000);

  it("caps aggregate diff bodies at 256 KB and exposes oversize files as metadata", async () => {
    const project = repository.listProjects()[0]!;
    const cp = await manager.createExplicit({ projectId: project.id, phase: "pre" });
    for (let index = 0; index < 17; index++) {
      await writeFile(
        join(projectWorkspace, `large-${index}.txt`),
        Array.from({ length: 2_000 }, (_, line) => `line-${index}-${line}`).join("\n"),
      );
    }
    const diff = await manager.diff(cp.id, "working");
    expect(diff.truncated).toBe(true);
    expect(diff.files).toHaveLength(17);
    expect(diff.files.every((file) => file.oversize && file.diff === null)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(diff), "utf8")).toBeLessThanOrEqual(256 * 1024);
  }, 30_000);

  it("restore: refuses without confirm", async () => {
    const project = repository.listProjects()[0]!;
    const cp = await manager.createExplicit({ projectId: project.id, phase: "pre" });
    const preview = await manager.restorePreview(cp.id);
    await expect(
      manager.restore({ checkpointId: cp.id, confirm: false, previewToken: preview.previewToken }),
    ).rejects.toThrow(/confirmation/);
    // A refused restore row is recorded.
    const restores = repository.listCheckpointRestores(cp.id);
    expect(restores.some((r) => r.status === "refused")).toBe(true);
  });

  it("restore: refuses a stale preview (workspace drifted between preview and execute)", async () => {
    const project = repository.listProjects()[0]!;
    const cp = await manager.createExplicit({ projectId: project.id, phase: "pre" });
    const preview = await manager.restorePreview(cp.id);
    // Drift AFTER the preview — the execute must refuse.
    await writeFile(join(projectWorkspace, "drift.txt"), "drift\n");
    await expect(
      manager.restore({ checkpointId: cp.id, confirm: true, previewToken: preview.previewToken }),
    ).rejects.toThrow(/drifted/);
    // The drift file is NOT overwritten.
    expect(await readFile(join(projectWorkspace, "drift.txt"), "utf8")).toBe("drift\n");
  });

  it("restore: refuses same-size content drift after preview", async () => {
    const project = repository.listProjects()[0]!;
    await writeFile(join(projectWorkspace, "same.txt"), "aaaa\n");
    const cp = await manager.createExplicit({ projectId: project.id, phase: "pre" });
    await writeFile(join(projectWorkspace, "same.txt"), "bbbb\n");
    const preview = await manager.restorePreview(cp.id);
    await writeFile(join(projectWorkspace, "same.txt"), "cccc\n");
    await expect(
      manager.restore({ checkpointId: cp.id, confirm: true, previewToken: preview.previewToken }),
    ).rejects.toThrow(/drifted/);
    expect(await readFile(join(projectWorkspace, "same.txt"), "utf8")).toBe("cccc\n");
  });

  it("restore: refuses an unknown preview token (no preview issued)", async () => {
    const project = repository.listProjects()[0]!;
    const cp = await manager.createExplicit({ projectId: project.id, phase: "pre" });
    await expect(
      manager.restore({ checkpointId: cp.id, confirm: true, previewToken: "never-issued-token" }),
    ).rejects.toThrow(/preview token/i);
  });

  it("restore: applies a stash checkpoint and restores the stashed content", async () => {
    const project = repository.listProjects()[0]!;
    // Commit v1, then build a dirty-tree stash checkpoint capturing v2.
    await writeFile(join(projectWorkspace, "tracked.txt"), "v1\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: projectWorkspace, shell: false, windowsHide: true });
    await execFileAsync("git", ["commit", "-m", "v1"], { cwd: projectWorkspace, shell: false, windowsHide: true });
    await writeFile(join(projectWorkspace, "tracked.txt"), "v2\n");
    const cp = await manager.createExplicit({ projectId: project.id, phase: "pre" });
    expect(cp.kind).toBe("git-stash");
    // Preview + execute while the tree is unchanged (no drift between the two).
    const preview = await manager.restorePreview(cp.id);
    const restored = await manager.restore({
      checkpointId: cp.id,
      confirm: true,
      previewToken: preview.previewToken,
    });
    expect(restored.status).toBe("restored");
    // The stashed "v2" content is back in the working tree.
    expect((await readFile(join(projectWorkspace, "tracked.txt"), "utf8")).trim()).toBe("v2");
  });

  it("restore: round-trips untracked files without changing the real index or branch", async () => {
    const project = repository.listProjects()[0]!;
    await writeFile(join(projectWorkspace, "captured.txt"), "checkpoint\n");
    const cp = await manager.createExplicit({ projectId: project.id, phase: "pre" });
    const indexPath = await gitIndexPath(projectWorkspace);
    const indexBefore = await readFile(indexPath);
    const branchBefore = (await git(["branch", "--show-current"], { cwd: projectWorkspace })).stdout;
    await writeFile(join(projectWorkspace, "captured.txt"), "later\n");
    await writeFile(join(projectWorkspace, "extra.txt"), "remove-me\n");
    const preview = await manager.restorePreview(cp.id);
    await manager.restore({ checkpointId: cp.id, confirm: true, previewToken: preview.previewToken });
    expect(await readFile(join(projectWorkspace, "captured.txt"), "utf8")).toBe("checkpoint\n");
    await expect(readFile(join(projectWorkspace, "extra.txt"), "utf8")).rejects.toThrow();
    expect(await readFile(indexPath)).toEqual(indexBefore);
    expect((await git(["branch", "--show-current"], { cwd: projectWorkspace })).stdout).toBe(branchBefore);
  });

  it("restores only the selected Git diff hunk", async () => {
    const project = repository.listProjects()[0]!;
    const original = Array.from({ length: 24 }, (_, index) => `line-${index + 1}`);
    await writeFile(join(projectWorkspace, "hunks.txt"), `${original.join("\n")}\n`);
    await execFileAsync("git", ["add", "hunks.txt"], { cwd: projectWorkspace, shell: false, windowsHide: true });
    await execFileAsync("git", ["commit", "-m", "hunk base"], { cwd: projectWorkspace, shell: false, windowsHide: true });
    const cp = await manager.createExplicit({ projectId: project.id, phase: "pre" });
    const changed = [...original];
    changed[1] = "changed-first";
    changed[21] = "changed-second";
    await writeFile(join(projectWorkspace, "hunks.txt"), `${changed.join("\n")}\n`);
    const diff = await manager.diff(cp.id, "working");
    expect(diff.files.find((file) => file.path === "hunks.txt")?.diff?.match(/^@@ /gm)).toHaveLength(2);

    const preview = await manager.restorePreview(cp.id);
    await manager.restoreHunk({
      checkpointId: cp.id,
      filePath: "hunks.txt",
      hunkIndex: 0,
      confirm: true,
      previewToken: preview.previewToken,
    });
    const content = await readFile(join(projectWorkspace, "hunks.txt"), "utf8");
    expect(content).not.toContain("\r");
    const after = content.split(/\r?\n/);
    expect(after[1]).toBe("line-2");
    expect(after[21]).toBe("changed-second");
    expect(repository.listCheckpointRestores(cp.id).at(-1)?.reason).toBe("hunk:0:hunks.txt");
  }, 15_000);

  it("binary file diff is marked binary with no body", async () => {
    const project = repository.listProjects()[0]!;
    await manager.createExplicit({ projectId: project.id, phase: "pre" });
    await writeFile(join(projectWorkspace, "blob.bin"), Buffer.from([0, 1, 2, 3, 255]));
    await execFileAsync("git", ["add", "blob.bin"], { cwd: projectWorkspace, shell: false, windowsHide: true });
    const cps = manager.list({ projectId: project.id });
    const diff = await manager.diff(cps[0]!.id, "working");
    const blob = diff.files.find((f) => f.path === "blob.bin");
    expect(blob).toBeTruthy();
    expect(blob!.binary).toBe(true);
    expect(blob!.diff).toBeNull();
  });

  it("delete + rename are reported in diff name-status", async () => {
    const project = repository.listProjects()[0]!;
    await writeFile(join(projectWorkspace, "orig.txt"), "orig\n");
    await execFileAsync("git", ["add", "orig.txt"], { cwd: projectWorkspace, shell: false, windowsHide: true });
    await execFileAsync("git", ["commit", "-m", "orig"], { cwd: projectWorkspace, shell: false, windowsHide: true });
    const cp = await manager.createExplicit({ projectId: project.id, phase: "pre" });
    // Delete orig.txt.
    await execFileAsync("git", ["rm", "orig.txt"], { cwd: projectWorkspace, shell: false, windowsHide: true });
    const diff = await manager.diff(cp.id, "working");
    expect(diff.files.some((f) => f.path === "orig.txt" && f.status === "deleted")).toBe(true);
  });
});

describe("CheckpointManager — worktree sandbox (commit mode)", () => {
  let directory: string;
  let userData: string;
  let database: AppDatabase;
  let repository: Repository;
  let projectWorkspace: string;
  let worktrees: WorktreeManager;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "coterm-cp-wt-"));
    userData = await mkdtemp(join(tmpdir(), "coterm-cp-wt-ud-"));
    projectWorkspace = join(directory, "repo");
    await mkdir(projectWorkspace, { recursive: true });
    await initRepo(projectWorkspace);
    database = new AppDatabase(join(userData, "state.sqlite"));
    await database.open();
    repository = new Repository(database);
    await repository.createProject("Repo", projectWorkspace);
    worktrees = new WorktreeManager({
      repository,
      terminals: fakeTerminals(),
      userDataPath: userData,
    });
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("snapshot commits on the isolated worktree branch; main working tree untouched", async () => {
    const project = repository.listProjects()[0]!;
    const worktree = await worktrees.create({ projectId: project.id, branch: "codex/cp" });
    const manager = new CheckpointManager({
      repository, terminals: fakeTerminals(), userDataPath: userData, worktrees,
    });
    // Make a dirty main working tree — it must NOT be touched by the worktree checkpoint.
    await writeFile(join(projectWorkspace, "main-local.txt"), "main\n");
    const cp = await manager.createExplicit({
      projectId: project.id, worktreeId: worktree.id, phase: "pre",
    });
    expect(cp.kind).toBe("worktree-commit");
    expect(cp.status).toBe("active");
    expect(cp.ref).toBeTruthy();
    // Main working tree file is intact.
    expect(await readFile(join(projectWorkspace, "main-local.txt"), "utf8")).toBe("main\n");
    // The checkpoint commit exists on the worktree branch, not main.
    const mainLog = await git(["log", "--oneline"], { cwd: projectWorkspace });
    expect(mainLog.stdout).not.toContain("coterm-checkpoint");
    const wtLog = await git(["log", "--oneline"], { cwd: worktree.worktreePath });
    expect(wtLog.stdout).toContain("coterm-checkpoint");
  });

  it("restore refuses when the worktree has uncommitted changes (dirty drift)", async () => {
    const project = repository.listProjects()[0]!;
    const worktree = await worktrees.create({ projectId: project.id, branch: "codex/cp-dirty" });
    const manager = new CheckpointManager({
      repository, terminals: fakeTerminals(), userDataPath: userData, worktrees,
    });
    const cp = await manager.createExplicit({
      projectId: project.id, worktreeId: worktree.id, phase: "pre",
    });
    // Dirty the worktree, then preview (captures the dirty fingerprint), then
    // dirty AGAIN before execute → drift between preview and execute → refused.
    await writeFile(join(worktree.worktreePath, "uncommitted.txt"), "x\n");
    const preview = await manager.restorePreview(cp.id);
    await writeFile(join(worktree.worktreePath, "more.txt"), "y\n");
    await expect(
      manager.restore({ checkpointId: cp.id, confirm: true, previewToken: preview.previewToken }),
    ).rejects.toThrow(/drifted/);
    // The uncommitted files are NOT deleted.
    expect(await readFile(join(worktree.worktreePath, "uncommitted.txt"), "utf8")).toBe("x\n");
  });

  it("restore moves only the isolated branch and keeps it attached", async () => {
    const project = repository.listProjects()[0]!;
    const worktree = await worktrees.create({ projectId: project.id, branch: "codex/cp-restore" });
    const manager = new CheckpointManager({
      repository, terminals: fakeTerminals(), userDataPath: userData, worktrees,
    });
    const pre = await manager.createExplicit({
      projectId: project.id, worktreeId: worktree.id, phase: "pre",
    });
    await writeFile(join(worktree.worktreePath, "sandbox.txt"), "sandbox\n");
    await manager.createExplicit({ projectId: project.id, worktreeId: worktree.id, phase: "post" });
    const mainHeadBefore = (await git(["rev-parse", "HEAD"], { cwd: projectWorkspace })).stdout.trim();
    const preview = await manager.restorePreview(pre.id);
    await manager.restore({ checkpointId: pre.id, confirm: true, previewToken: preview.previewToken });
    expect((await git(["branch", "--show-current"], { cwd: worktree.worktreePath })).stdout.trim())
      .toBe(worktree.branch);
    expect((await git(["rev-parse", "HEAD"], { cwd: projectWorkspace })).stdout.trim()).toBe(mainHeadBefore);
    await expect(readFile(join(worktree.worktreePath, "sandbox.txt"), "utf8")).rejects.toThrow();
  }, 15_000);

  it("cross-project worktreeId is rejected", async () => {
    const project = repository.listProjects()[0]!;
    const otherProject = await repository.createProject("Other", projectWorkspace);
    const worktree = await worktrees.create({ projectId: project.id, branch: "codex/cp-x" });
    const manager = new CheckpointManager({
      repository, terminals: fakeTerminals(), userDataPath: userData, worktrees,
    });
    await expect(
      manager.createExplicit({ projectId: otherProject.id, worktreeId: worktree.id, phase: "pre" }),
    ).rejects.toThrow(/does not belong/);
  });
});

describe("CheckpointManager — non-Git file snapshot", () => {
  let directory: string;
  let userData: string;
  let database: AppDatabase;
  let repository: Repository;
  let projectWorkspace: string;
  let manager: CheckpointManager;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "coterm-cp-ng-"));
    userData = await mkdtemp(join(tmpdir(), "coterm-cp-ng-ud-"));
    projectWorkspace = join(directory, "workspace");
    await mkdir(projectWorkspace, { recursive: true });
    // NOT a git repo.
    await writeFile(join(projectWorkspace, "readme.txt"), "hello\n");
    database = new AppDatabase(join(userData, "state.sqlite"));
    await database.open();
    repository = new Repository(database);
    await repository.createProject("NonGit", projectWorkspace);
    manager = new CheckpointManager({
      repository, terminals: fakeTerminals(), userDataPath: userData,
    });
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("snapshots files, skips .env and secrets, restores on demand", async () => {
    const project = repository.listProjects()[0]!;
    await writeFile(join(projectWorkspace, ".env"), "SECRET=abc\n");
    await writeFile(join(projectWorkspace, "key.pem"), "PRIVATE\n");
    await mkdir(join(projectWorkspace, "node_modules"), { recursive: true });
    await writeFile(join(projectWorkspace, "node_modules", "pkg.txt"), "pkg\n");
    await mkdir(join(projectWorkspace, "credentials"), { recursive: true });
    await writeFile(join(projectWorkspace, "credentials", "token.txt"), "secret\n");
    await mkdir(join(projectWorkspace, "secrets"), { recursive: true });
    await writeFile(join(projectWorkspace, "secrets", "token.txt"), "secret\n");
    await mkdir(join(projectWorkspace, "sub"), { recursive: true });
    await writeFile(join(projectWorkspace, "sub", "note.txt"), "note\n");

    const cp = await manager.createExplicit({ projectId: project.id, phase: "pre" });
    expect(cp.kind).toBe("file-snapshot");
    expect(cp.status).toBe("active");
    expect(cp.fileCount).toBeGreaterThan(0);
    // .env / .pem / node_modules excluded.
    expect(cp.sizeBytes).toBeGreaterThan(0);
    await expect(readFile(join(cp.snapshotPath!, ".env"), "utf8")).rejects.toThrow();
    await expect(readFile(join(cp.snapshotPath!, "key.pem"), "utf8")).rejects.toThrow();
    await expect(readFile(join(cp.snapshotPath!, "credentials", "token.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(join(cp.snapshotPath!, "secrets", "token.txt"), "utf8")).rejects.toThrow();

    // Modify + delete files, then restore (preview + execute with no drift
    // between them — the restore resets the workspace to the snapshot).
    await writeFile(join(projectWorkspace, "readme.txt"), "changed\n");
    await rm(join(projectWorkspace, "sub", "note.txt"), { force: true });
    await writeFile(join(projectWorkspace, "added-after.txt"), "remove on restore\n");
    const preview = await manager.restorePreview(cp.id);
    const restored = await manager.restore({
      checkpointId: cp.id, confirm: true, previewToken: preview.previewToken,
    });
    expect(restored.status).toBe("restored");
    expect(await readFile(join(projectWorkspace, "readme.txt"), "utf8")).toBe("hello\n");
    expect(await readFile(join(projectWorkspace, "sub", "note.txt"), "utf8")).toBe("note\n");
    await expect(readFile(join(projectWorkspace, "added-after.txt"), "utf8")).rejects.toThrow();
    // Secrets were never snapshotted, so they remain as-is on disk.
    expect(await readFile(join(projectWorkspace, ".env"), "utf8")).toBe("SECRET=abc\n");
  });

  it("marks a snapshot partial when the file cap is hit", async () => {
    const project = repository.listProjects()[0]!;
    // Create more than 200 files.
    for (let i = 0; i < 210; i++) {
      await writeFile(join(projectWorkspace, `f${i}.txt`), `content ${i}\n`);
    }
    const cp = await manager.createExplicit({ projectId: project.id, phase: "pre" });
    expect(cp.partial).toBe(true);
    expect(cp.fileCount).toBeLessThanOrEqual(200);
    const preview = await manager.restorePreview(cp.id);
    await expect(manager.restore({
      checkpointId: cp.id,
      confirm: true,
      previewToken: preview.previewToken,
    })).rejects.toThrow(/Partial checkpoint/);
  });

  it("marks files over 5 MB partial and never copies them", async () => {
    const project = repository.listProjects()[0]!;
    const huge = join(projectWorkspace, "huge.bin");
    await writeFile(huge, "");
    await truncate(huge, 5 * 1024 * 1024 + 1);
    const cp = await manager.createExplicit({ projectId: project.id, phase: "pre" });
    expect(cp.partial).toBe(true);
    await expect(readFile(join(cp.snapshotPath!, "huge.bin"))).rejects.toThrow();
  });

  it("does not follow symlinks", async () => {
    const project = repository.listProjects()[0]!;
    const target = await mkdtemp(join(tmpdir(), "coterm-cp-sym-target-"));
    await writeFile(join(target, "outside.txt"), "outside\n");
    // Create a symlink inside the workspace pointing outside.
    try {
      await import("node:fs/promises").then((fs) => fs.symlink(target, join(projectWorkspace, "link")));
    } catch {
      // Symlink creation may need admin on some Windows setups; skip gracefully.
      await rm(target, { recursive: true, force: true });
      return;
    }
    const cp = await manager.createExplicit({ projectId: project.id, phase: "pre" });
    // The symlink target's file must NOT appear in the snapshot file count path.
    expect(cp.status).toBe("active");
    await expect(readFile(join(cp.snapshotPath!, "link", "outside.txt"), "utf8")).rejects.toThrow();
    await rm(target, { recursive: true, force: true });
  });

  it("diff reports added/modified/deleted between snapshot and live workspace", async () => {
    const project = repository.listProjects()[0]!;
    const cp = await manager.createExplicit({ projectId: project.id, phase: "pre" });
    await writeFile(join(projectWorkspace, "new.txt"), "new\n");
    await writeFile(join(projectWorkspace, "readme.txt"), "changed\n");
    const diff = await manager.diff(cp.id, "working");
    expect(diff.files.some((f) => f.path === "new.txt" && f.status === "added")).toBe(true);
    expect(diff.files.some((f) => f.path === "readme.txt" && f.status === "modified")).toBe(true);
  });

  it("diff compares paired non-Git pre and post turn snapshots", async () => {
    const project = repository.listProjects()[0]!;
    const conversation = await repository.createConversation(project.id, "NonGit pair", "claude-local-main");
    const turnId = await repository.startTurn(conversation.id, null);
    const pre = await manager.createTurnCheckpoint({
      turnId,
      conversationId: conversation.id,
      projectId: project.id,
      worktreeId: null,
      phase: "pre",
    });
    await writeFile(join(projectWorkspace, "readme.txt"), "after\n");
    await writeFile(join(projectWorkspace, "new.txt"), "new\n");
    const post = await manager.finalizeTurnCheckpoint({
      turnId,
      conversationId: conversation.id,
      projectId: project.id,
      worktreeId: null,
      phase: "post",
    });
    expect(pre?.status).toBe("active");
    expect(post?.status).toBe("active");

    const diff = await manager.diff(post!.id, "pre");
    expect(diff.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "readme.txt", status: "modified" }),
      expect.objectContaining({ path: "new.txt", status: "added" }),
    ]));
  });

  it("restores only the selected non-Git diff hunk", async () => {
    const project = repository.listProjects()[0]!;
    const original = Array.from({ length: 24 }, (_, index) => `line-${index + 1}`);
    await writeFile(join(projectWorkspace, "hunks.txt"), `${original.join("\n")}\n`);
    const cp = await manager.createExplicit({ projectId: project.id, phase: "pre" });
    const changed = [...original];
    changed[1] = "changed-first";
    changed[21] = "changed-second";
    await writeFile(join(projectWorkspace, "hunks.txt"), `${changed.join("\n")}\n`);
    const diff = await manager.diff(cp.id, "working");
    expect(diff.files.find((file) => file.path === "hunks.txt")?.diff?.match(/^@@ /gm)).toHaveLength(2);

    const preview = await manager.restorePreview(cp.id);
    await manager.restoreHunk({
      checkpointId: cp.id,
      filePath: "hunks.txt",
      hunkIndex: 1,
      confirm: true,
      previewToken: preview.previewToken,
    });
    const content = await readFile(join(projectWorkspace, "hunks.txt"), "utf8");
    expect(content).not.toContain("\r");
    const after = content.split(/\r?\n/);
    expect(after[1]).toBe("changed-first");
    expect(after[21]).toBe("line-22");
  });
});

describe("CheckpointManager — undo/redo chain", () => {
  let directory: string;
  let userData: string;
  let database: AppDatabase;
  let repository: Repository;
  let projectWorkspace: string;
  let manager: CheckpointManager;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "coterm-cp-ur-"));
    userData = await mkdtemp(join(tmpdir(), "coterm-cp-ur-ud-"));
    projectWorkspace = join(directory, "repo");
    await mkdir(projectWorkspace, { recursive: true });
    await initRepo(projectWorkspace);
    database = new AppDatabase(join(userData, "state.sqlite"));
    await database.open();
    repository = new Repository(database);
    await repository.createProject("Repo", projectWorkspace);
    manager = new CheckpointManager({
      repository, terminals: fakeTerminals(), userDataPath: userData,
    });
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("undo restores the pre-checkpoint of the latest turn (dirty-tree stash)", async () => {
    const project = repository.listProjects()[0]!;
    const conversation = await repository.createConversation(project.id, "C", "claude-local-main");
    const turnId = await repository.startTurn(conversation.id, null);
    // Pre snapshot over a dirty tree (stash object with real content).
    await writeFile(join(projectWorkspace, "working.txt"), "v1\n");
    const pre = await manager.createTurnCheckpoint({
      turnId,
      conversationId: conversation.id,
      projectId: project.id,
      worktreeId: null,
      phase: "pre",
    });
    expect(pre).toBeTruthy();
    expect(pre!.kind).toBe("git-stash");
    // The turn modifies the working file further.
    await writeFile(join(projectWorkspace, "working.txt"), "v2-changed\n");
    await manager.finalizeTurnCheckpoint({
      turnId,
      conversationId: conversation.id,
      projectId: project.id,
      worktreeId: null,
      phase: "post",
    });
    // Undo: restore the pre stash → working.txt returns to "v1".
    const preview = await manager.restorePreview(pre!.id);
    const undone = await manager.undo({
      conversationId: conversation.id,
      confirm: true,
      previewToken: preview.previewToken,
    });
    expect(undone.status).toBe("restored");
    expect((await readFile(join(projectWorkspace, "working.txt"), "utf8")).trim()).toBe("v1");
    const { post } = repository.getTurnCheckpoints(turnId);
    expect(post).toBeTruthy();
    const redoPreview = await manager.restorePreview(post!.id);
    const redone = await manager.redo({
      conversationId: conversation.id,
      confirm: true,
      previewToken: redoPreview.previewToken,
    });
    expect(redone.status).toBe("restored");
    expect((await readFile(join(projectWorkspace, "working.txt"), "utf8")).trim()).toBe("v2-changed");
  }, 15_000);

  it("undo throws when there is no restorable checkpoint", async () => {
    const project = repository.listProjects()[0]!;
    const conversation = await repository.createConversation(project.id, "C2", "claude-local-main");
    await expect(
      manager.undo({ conversationId: conversation.id, confirm: true, previewToken: "valid-token-1234" }),
    ).rejects.toThrow(/No restorable/);
    void project;
  });
});

describe("CheckpointManager — failed checkpoint does not break the turn", () => {
  it("createTurnCheckpoint records a failed row and returns it (never throws)", async () => {
    const userData = await mkdtemp(join(tmpdir(), "coterm-cp-fail-"));
    const database = new AppDatabase(join(userData, "state.sqlite"));
    await database.open();
    const repository = new Repository(database);
    const project = await repository.createProject("Ghost", join(userData, "does-not-exist"));
    const conversation = await repository.createConversation(project.id, "C", "claude-local-main");
    // Create the turn row first so the checkpoints FK is satisfied (mirrors the
    // real flow where startTurn runs before createTurnCheckpoint).
    const turnId = await repository.startTurn(conversation.id, null);
    const manager = new CheckpointManager({
      repository, terminals: fakeTerminals(), userDataPath: userData,
    });
    const cp = await manager.createTurnCheckpoint({
      turnId,
      conversationId: conversation.id,
      projectId: project.id,
      worktreeId: null,
      phase: "pre",
    });
    // A failed row is returned (not null, not a throw) so the turn proceeds.
    expect(cp).not.toBeNull();
    expect(cp!.status).toBe("failed");
    database.close();
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
});

describe("CheckpointManager — deleteProject cascade", () => {
  it("cascades checkpoint rows when a project is deleted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coterm-cp-cascade-"));
    const userData = await mkdtemp(join(tmpdir(), "coterm-cp-cascade-ud-"));
    const projectWorkspace = join(directory, "repo");
    await mkdir(projectWorkspace, { recursive: true });
    await initRepo(projectWorkspace);
    const database = new AppDatabase(join(userData, "state.sqlite"));
    await database.open();
    const repository = new Repository(database);
    const project = await repository.createProject("Repo", projectWorkspace);
    const manager = new CheckpointManager({
      repository, terminals: fakeTerminals(), userDataPath: userData,
    });
    await manager.createExplicit({ projectId: project.id, phase: "pre" });
    expect(repository.listCheckpoints({ projectId: project.id })).toHaveLength(1);
    await repository.deleteProject(project.id);
    expect(repository.listCheckpoints({ projectId: project.id })).toHaveLength(0);
    database.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
});

// Logger privacy: checkpoint logs must carry only ids/status/count/bytes,
// never diff/file content/prompt. Static source contract check — the logger is
// a Proxy that can't be spied at runtime, so we verify the source never passes
// diff/content/prompt fields to logger calls.
describe("CheckpointManager — logger privacy (static contract)", () => {
  it("checkpoint-manager source never logs diff/content/prompt fields", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const source = readFileSync(path.resolve("src/main/core/checkpoint-manager.ts"), "utf8");
    // Every logger.* call site: extract the context object literal and assert
    // it does not mention diff/content/prompt keys.
    const loggerCalls = source.match(/logger\.\w+\([^)]*\{[^}]*\}/gs) ?? [];
    for (const call of loggerCalls) {
      expect(call, `logger call leaks diff: ${call}`).not.toMatch(/\bdiff\b\s*:/);
      expect(call, `logger call leaks content: ${call}`).not.toMatch(/\bcontent\b\s*:/);
      expect(call, `logger call leaks prompt: ${call}`).not.toMatch(/\bprompt\b\s*:/);
      expect(call, `logger call leaks command: ${call}`).not.toMatch(/\bcommand\b\s*:/);
    }
  });
});
