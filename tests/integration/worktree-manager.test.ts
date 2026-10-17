import { mkdtemp, rm, writeFile, mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDatabase } from "../../src/main/storage/database";
import { Repository } from "../../src/main/storage/repository";
import { WorktreeManager } from "../../src/main/core/worktree-manager";
import { DockLayoutManager } from "../../src/main/core/dock-layout";
import { git } from "../../src/main/security/git-helper";
import { assertAllowedPath } from "../../src/main/security/path-policy";
import type { TerminalCreateInput, TerminalInfo, Worktree } from "../../src/shared/types";

const execFileAsync = promisify(execFile);

async function initBareRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main"], { cwd: dir, shell: false, windowsHide: true });
  await execFileAsync("git", ["config", "user.email", "test@coterm.dev"], { cwd: dir, shell: false, windowsHide: true });
  await execFileAsync("git", ["config", "user.name", "Coterm Test"], { cwd: dir, shell: false, windowsHide: true });
  await writeFile(join(dir, "README.md"), "# initial\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: dir, shell: false, windowsHide: true });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: dir, shell: false, windowsHide: true });
}

function fakeTerminals(running: TerminalInfo[]): { list: (projectId: string) => TerminalInfo[]; get: (id: string) => TerminalInfo | null } {
  return {
    list: (projectId: string) => running.filter((t) => t.projectId === projectId),
    get: (id: string) => running.find((t) => t.id === id) ?? null,
  };
}

describe("WorktreeManager (disposable git repo)", () => {
  let directory: string;
  let userData: string;
  let database: AppDatabase;
  let repository: Repository;
  let projectWorkspace: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "coterm-worktree-"));
    userData = await mkdtemp(join(tmpdir(), "coterm-worktree-ud-"));
    projectWorkspace = join(directory, "repo");
    await mkdir(projectWorkspace, { recursive: true });
    await initBareRepo(projectWorkspace);
    database = new AppDatabase(join(userData, "state.sqlite"));
    await database.open();
    repository = new Repository(database);
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function makeManager(terminals: TerminalInfo[] = []) {
    return Promise.resolve(new WorktreeManager({
      repository,
      terminals: fakeTerminals(terminals),
      userDataPath: userData,
    }));
  }

  it("creates a worktree with the right branch + path, and lists it", async () => {
    const project = await repository.createProject("Repo", projectWorkspace);
    const manager = await makeManager();
    const worktree = await manager.create({ projectId: project.id, branch: "codex/feature-a" });

    expect(worktree.status).toBe("active");
    expect(worktree.branch).toBe("codex/feature-a");
    expect(worktree.baseRef).toBe("main");
    expect(worktree.nativeSessionId).toBeNull();
    expect(worktree.worktreePath).toContain(join("worktrees", project.id));
    // The worktree dir exists and is a real git worktree.
    const branch = await git(["branch", "--show-current"], { cwd: worktree.worktreePath });
    expect(branch.stdout.trim()).toBe("codex/feature-a");
    // README is present (shared checkout).
    const listed = manager.list(project.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(worktree.id);
  });

  it("opens a worktree tile in the exact sandbox cwd and rejects cross-project binding", async () => {
    const project = await repository.createProject("Repo", projectWorkspace);
    const otherProject = await repository.createProject("Other", projectWorkspace);
    const manager = await makeManager();
    const worktree = await manager.create({ projectId: project.id, branch: "codex/dock" });
    const create = vi.fn((input: TerminalCreateInput): TerminalInfo => ({
      id: randomUUID(),
      projectId: input.projectId,
      profile: input.profile,
      title: "pwsh",
      cwd: input.cwd,
      cols: 100,
      rows: 28,
      status: "running",
      startedAt: new Date().toISOString(),
      closedAt: null,
      lastExitCode: null,
      isAgent: input.isAgent,
      agentProfile: input.agentProfile,
      ownedByAgentApi: false,
      pid: 0,
      nativeSessionId: null,
      worktreeId: input.worktreeId ?? null,
      contextUsage: null,
    }));
    const dock = new DockLayoutManager({
      terminals: { create, kill: vi.fn(), get: vi.fn().mockReturnValue(null) },
      repository,
      userDataPath: userData,
      tempPath: userData,
      worktrees: manager,
    });

    await dock.openTile(project.id, "claude-local-main", worktree.id);
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({
      projectId: project.id,
      cwd: await realpath(worktree.worktreePath),
      worktreeId: worktree.id,
    }));
    await expect(dock.openTile(otherProject.id, "claude-local-main", worktree.id))
      .rejects.toThrow(/does not belong/);
  });

  it("rejects an invalid branch name (argument safety, no shell injection)", async () => {
    const project = await repository.createProject("Repo", projectWorkspace);
    const manager = await makeManager();
    await expect(manager.create({ projectId: project.id, branch: "evil; rm -rf /" }))
      .rejects.toThrow(/Invalid branch name/);
  });

  it("rejects a non-existent project workspace (not a git repo)", async () => {
    const notARepo = await mkdtemp(join(tmpdir(), "coterm-notrepo-"));
    try {
      const project = await repository.createProject("NotRepo", notARepo);
      const manager = await makeManager();
      await expect(manager.create({ projectId: project.id }))
        .rejects.toThrow(/not a git repository/);
    } finally {
      await rm(notARepo, { recursive: true, force: true });
    }
  });

  it("compensates DB failure: no orphan worktree dir left", async () => {
    const project = await repository.createProject("Repo", projectWorkspace);
    vi.spyOn(repository, "createWorktree").mockRejectedValueOnce(new Error("injected DB failure"));
    const manager = await makeManager();
    await expect(manager.create({ projectId: project.id, branch: "codex/orphan" }))
      .rejects.toThrow();
    // The worktree dir must NOT exist (compensated cleanup).
    const worktrees = await git(["worktree", "list"], { cwd: projectWorkspace });
    expect(worktrees.stdout).not.toContain("codex/orphan");
    const branches = await git(["branch", "--list", "codex/orphan"], { cwd: projectWorkspace });
    expect(branches.stdout.trim()).toBe("");
  });

  it("refuses merge/abort/cleanup while a terminal is running in the worktree", async () => {
    const project = await repository.createProject("Repo", projectWorkspace);
    const manager = await makeManager();
    const worktree = await manager.create({ projectId: project.id, branch: "codex/running" });
    const runningTerminal: TerminalInfo = {
      id: "11111111-1111-4111-8111-111111111111",
      projectId: project.id,
      profile: "pwsh",
      title: "agent",
      cwd: worktree.worktreePath,
      cols: 100, rows: 28,
      status: "running",
      startedAt: new Date().toISOString(),
      closedAt: null, lastExitCode: null,
      isAgent: true, agentProfile: "claude-local-main",
      ownedByAgentApi: false, pid: 0,
      nativeSessionId: null, worktreeId: worktree.id,
      contextUsage: null,
    };
    const managerWithRunning = await makeManager([runningTerminal]);
    await expect(managerWithRunning.merge(worktree.id, true)).rejects.toThrow(/still running/);
    await expect(managerWithRunning.abort(worktree.id)).rejects.toThrow(/still running/);
    await expect(managerWithRunning.cleanup(worktree.id)).rejects.toThrow(/still running/);
  });

  it("merge: refuses without confirm, refuses when dirty, succeeds when clean", async () => {
    const project = await repository.createProject("Repo", projectWorkspace);
    const manager = await makeManager();
    const worktree = await manager.create({ projectId: project.id, branch: "codex/mergeable" });

    // No confirm → refused.
    await expect(manager.merge(worktree.id, false)).rejects.toThrow(/confirmation/);

    // Dirty (uncommitted change) → refused.
    await writeFile(join(worktree.worktreePath, "new.txt"), "uncommitted\n");
    await expect(manager.merge(worktree.id, true)).rejects.toThrow(/uncommitted changes/);

    // Commit the change → merge succeeds.
    await execFileAsync("git", ["add", "new.txt"], { cwd: worktree.worktreePath, shell: false, windowsHide: true });
    await execFileAsync("git", ["config", "user.email", "test@coterm.dev"], { cwd: worktree.worktreePath, shell: false, windowsHide: true });
    await execFileAsync("git", ["config", "user.name", "Coterm Test"], { cwd: worktree.worktreePath, shell: false, windowsHide: true });
    await execFileAsync("git", ["commit", "-m", "add new.txt"], { cwd: worktree.worktreePath, shell: false, windowsHide: true });
    const merged = await manager.merge(worktree.id, true);
    expect(merged.status).toBe("merged");
    // The sandbox branch is genuinely merged back into the clean base branch.
    const mainLog = await git(["log", "--oneline"], { cwd: projectWorkspace });
    expect(mainLog.stdout).toContain("initial");
    expect(mainLog.stdout).toContain("add new.txt");
    expect((await readFile(join(projectWorkspace, "new.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("uncommitted\n");
  });

  it("diff summary compares the sandbox branch to the recorded base branch", async () => {
    const project = await repository.createProject("Repo", projectWorkspace);
    const manager = await makeManager();
    const worktree = await manager.create({ projectId: project.id, branch: "codex/diff" });
    await writeFile(join(worktree.worktreePath, "feature.txt"), "feature\n");
    await execFileAsync("git", ["add", "feature.txt"], { cwd: worktree.worktreePath, shell: false, windowsHide: true });
    await execFileAsync("git", ["commit", "-m", "feature diff"], { cwd: worktree.worktreePath, shell: false, windowsHide: true });

    const summary = await manager.diffSummary(worktree.id);
    expect(summary.diffStat).toContain("feature.txt");
    expect(summary.commits).toContain("feature diff");
  });

  it("refuses a dirty main tree before merge", async () => {
    const project = await repository.createProject("Repo", projectWorkspace);
    const manager = await makeManager();
    const worktree = await manager.create({ projectId: project.id, branch: "codex/main-dirty" });
    await writeFile(join(worktree.worktreePath, "feature.txt"), "feature\n");
    await execFileAsync("git", ["add", "feature.txt"], { cwd: worktree.worktreePath, shell: false, windowsHide: true });
    await execFileAsync("git", ["commit", "-m", "feature"], { cwd: worktree.worktreePath, shell: false, windowsHide: true });
    await writeFile(join(projectWorkspace, "local.txt"), "do not touch\n");

    await expect(manager.merge(worktree.id, true)).rejects.toThrow(/Main working tree has uncommitted changes/);
    expect(await readFile(join(projectWorkspace, "local.txt"), "utf8")).toBe("do not touch\n");
  });

  it("aborts a merge conflict and restores the main worktree", async () => {
    const project = await repository.createProject("Repo", projectWorkspace);
    const manager = await makeManager();
    const worktree = await manager.create({ projectId: project.id, branch: "codex/conflict" });
    await writeFile(join(worktree.worktreePath, "README.md"), "sandbox\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: worktree.worktreePath, shell: false, windowsHide: true });
    await execFileAsync("git", ["commit", "-m", "sandbox readme"], { cwd: worktree.worktreePath, shell: false, windowsHide: true });
    await writeFile(join(projectWorkspace, "README.md"), "main\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: projectWorkspace, shell: false, windowsHide: true });
    await execFileAsync("git", ["commit", "-m", "main readme"], { cwd: projectWorkspace, shell: false, windowsHide: true });

    await expect(manager.merge(worktree.id, true)).rejects.toThrow(/Merge conflict/);
    expect(repository.getWorktree(worktree.id)?.status).toBe("conflict");
    expect((await git(["status", "--porcelain"], { cwd: projectWorkspace })).stdout.trim()).toBe("");
    expect((await readFile(join(projectWorkspace, "README.md"), "utf8")).replace(/\r\n/g, "\n")).toBe("main\n");
    await expect(manager.abort(worktree.id)).resolves.toMatchObject({ status: "aborted" });
  }, 15_000);

  it("refuses cleanup when uncommitted work would be lost", async () => {
    const project = await repository.createProject("Repo", projectWorkspace);
    const manager = await makeManager();
    const worktree = await manager.create({ projectId: project.id, branch: "codex/dirty-cleanup" });
    await writeFile(join(worktree.worktreePath, "valuable.txt"), "keep me\n");

    await expect(manager.cleanup(worktree.id)).rejects.toThrow(/uncommitted changes/);
    expect(repository.getWorktree(worktree.id)).not.toBeNull();
    expect(await readFile(join(worktree.worktreePath, "valuable.txt"), "utf8")).toBe("keep me\n");
  });

  it("abort marks the worktree aborted; cleanup removes dir + DB row (idempotent)", async () => {
    const project = await repository.createProject("Repo", projectWorkspace);
    const manager = await makeManager();
    const worktree = await manager.create({ projectId: project.id, branch: "codex/abort-me" });
    const aborted = await manager.abort(worktree.id);
    expect(aborted.status).toBe("aborted");

    await manager.cleanup(worktree.id);
    expect(repository.getWorktree(worktree.id)).toBeNull();
    // Idempotent: second cleanup is a no-op.
    await expect(manager.cleanup(worktree.id)).resolves.toBeUndefined();
  });

  it("deleteProject cascades to worktree rows", async () => {
    const project = await repository.createProject("Repo", projectWorkspace);
    const manager = await makeManager();
    await manager.create({ projectId: project.id, branch: "codex/cascade-1" });
    await manager.create({ projectId: project.id, branch: "codex/cascade-2" });
    expect(repository.listWorktrees(project.id)).toHaveLength(2);
    await repository.deleteProject(project.id);
    expect(repository.listWorktrees(project.id)).toHaveLength(0);
  });
});

describe("trusted resume (AppOperations.resumeWorktree)", () => {
  let directory: string;
  let userData: string;
  let database: AppDatabase;
  let repository: Repository;
  let projectWorkspace: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "coterm-resume-"));
    userData = await mkdtemp(join(tmpdir(), "coterm-resume-ud-"));
    projectWorkspace = join(directory, "repo");
    await mkdir(projectWorkspace, { recursive: true });
    await initBareRepo(projectWorkspace);
    database = new AppDatabase(join(userData, "state.sqlite"));
    await database.open();
    repository = new Repository(database);
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function makeOperations(terminals: TerminalInfo[] = []) {
    const { AppOperations } = await import("../../src/main/core/app-operations");
    const { WorktreeManager } = await import("../../src/main/core/worktree-manager");
    const { AppEventBus } = await import("../../src/main/core/event-bus");
    const worktrees = new WorktreeManager({
      repository,
      terminals: fakeTerminals(terminals),
      userDataPath: userData,
    });
    return new AppOperations({
      repository,
      runs: { send: vi.fn(), cancel: vi.fn(), command: vi.fn() },
      approvals: { resolve: vi.fn() },
      council: { start: vi.fn(), cancel: vi.fn() },
      attention: { list: vi.fn().mockReturnValue([]), resolve: vi.fn(), onAttentionChanged: vi.fn().mockReturnValue(() => undefined) },
      events: new AppEventBus(),
      terminals: {
        create: vi.fn(), write: vi.fn(), writeWhenShellReady: vi.fn(), resize: vi.fn(), rename: vi.fn(), setLabel: vi.fn(), markAgent: vi.fn(), markAgentOwned: vi.fn(),
        setNativeSessionId: vi.fn(), kill: vi.fn(),
        list: vi.fn().mockReturnValue(terminals),
        snapshots: vi.fn().mockReturnValue([]),
        get: vi.fn((id: string) => terminals.find((terminal) => terminal.id === id) ?? null),
        getPtyState: vi.fn().mockReturnValue(null), getLastCommand: vi.fn().mockReturnValue(null), dashboardSnapshot: vi.fn().mockReturnValue([]), setTerminalKeepalive: vi.fn().mockReturnValue(null), listTerminalKeepaliveStates: vi.fn().mockReturnValue([]),
      },
      appVersion: "1.0.0",
      userDataPath: userData,
      tempPath: userData,
      worktrees,
    });
  }

  function terminalFor(worktree: Worktree, overrides: Partial<TerminalInfo> = {}): TerminalInfo {
    return {
      id: "44444444-4444-4444-8444-444444444444",
      projectId: worktree.projectId,
      profile: "pwsh",
      title: "agent",
      cwd: worktree.worktreePath,
      cols: 100,
      rows: 28,
      status: "running",
      startedAt: new Date().toISOString(),
      closedAt: null,
      lastExitCode: null,
      isAgent: true,
      agentProfile: "claude-local-main",
      ownedByAgentApi: false,
      pid: 0,
      nativeSessionId: null,
      worktreeId: worktree.id,
      contextUsage: null,
      ...overrides,
    };
  }

  it("rebuilds the launch command from the profile allowlist; a tampered resume_command cannot inject an arbitrary command", async () => {
    const project = await repository.createProject("Repo", projectWorkspace);
    const terminals: TerminalInfo[] = [];
    const operations = await makeOperations(terminals);
    const worktree = await operations.createWorktree({ projectId: project.id, branch: "codex/resume-me" });
    const terminal = terminalFor(worktree);
    terminals.push(terminal);

    // Bind a session the legitimate way.
    await repository.bindWorktreeSession(
      worktree.id,
      "abc123-session-id",
      JSON.stringify({ profile: "claude-local-main", sessionId: "abc123-session-id" }),
    );

    const result = await operations.resumeWorktree({ worktreeId: worktree.id, terminalId: terminal.id });
    // The rebuilt command is the allowlisted claude resume form, NOT the raw
    // persisted string. It must reference the worktree path + --resume.
    expect(result.command).toContain("claude");
    expect(result.command).toContain("--resume 'abc123-session-id'");
    expect(result.command).toContain(worktree.worktreePath);

    // Now tamper: write a resume_command that tries to inject a shell command.
    await repository.bindWorktreeSession(
      worktree.id,
      "abc123-session-id",
      JSON.stringify({ profile: "claude-local-main; rm -rf /", sessionId: "abc123-session-id" }),
    );
    // The tampered profile is not in the allowlist → resume refuses.
    await expect(operations.resumeWorktree({ worktreeId: worktree.id, terminalId: terminal.id }))
      .rejects.toThrow(/not allowed|missing|failed|does not match/i);
  });

  it("refuses resume when the worktree has no bound session", async () => {
    const project = await repository.createProject("Repo", projectWorkspace);
    const operations = await makeOperations();
    const worktree = await operations.createWorktree({ projectId: project.id, branch: "codex/no-session" });
    await expect(operations.resumeWorktree({
      worktreeId: worktree.id,
      terminalId: "44444444-4444-4444-8444-444444444444",
    }))
      .rejects.toThrow(/no bound native session id/);
  });

  it("refuses resume when sessionId does not match the bound native session id", async () => {
    const project = await repository.createProject("Repo", projectWorkspace);
    const terminals: TerminalInfo[] = [];
    const operations = await makeOperations(terminals);
    const worktree = await operations.createWorktree({ projectId: project.id, branch: "codex/mismatch" });
    const terminal = terminalFor(worktree);
    terminals.push(terminal);
    await repository.bindWorktreeSession(
      worktree.id,
      "real-session-id",
      JSON.stringify({ profile: "claude-local-main", sessionId: "tampered-different-id" }),
    );
    await expect(operations.resumeWorktree({ worktreeId: worktree.id, terminalId: terminal.id }))
      .rejects.toThrow(/does not match/);
  });

  it("refuses resume into a terminal whose cwd does not match the worktree", async () => {
    const project = await repository.createProject("Repo", projectWorkspace);
    const terminals: TerminalInfo[] = [];
    const operations = await makeOperations(terminals);
    const worktree = await operations.createWorktree({ projectId: project.id, branch: "codex/wrong-cwd" });
    const terminal = terminalFor(worktree, { cwd: projectWorkspace });
    terminals.push(terminal);
    await repository.bindWorktreeSession(
      worktree.id,
      "abc123-session-id",
      JSON.stringify({ profile: "claude-local-main", sessionId: "abc123-session-id" }),
    );

    await expect(operations.resumeWorktree({ worktreeId: worktree.id, terminalId: terminal.id }))
      .rejects.toThrow(/cwd does not match/);
  });

  it("phase-2 native session binding updates only the terminal's exact worktree", async () => {
    const project = await repository.createProject("Repo", projectWorkspace);
    const terminals: TerminalInfo[] = [];
    const operations = await makeOperations(terminals);
    const worktree = await operations.createWorktree({ projectId: project.id, branch: "codex/bind" });
    const terminal = terminalFor(worktree);
    terminals.push(terminal);

    await operations.setTerminalNativeSessionId({
      terminalId: terminal.id,
      nativeSessionId: "bound-session-1",
    });

    expect(repository.getWorktree(worktree.id)).toMatchObject({
      nativeSessionId: "bound-session-1",
    });
    expect(repository.getWorktree(worktree.id)?.resumeCommand).toContain('"profile":"claude-local-main"');

    const second = await operations.createWorktree({ projectId: project.id, branch: "codex/unrelated" });
    const plain = terminalFor(second, {
      id: "55555555-5555-4555-8555-555555555555",
      cwd: projectWorkspace,
      worktreeId: null,
      contextUsage: null,
      agentProfile: null,
      isAgent: false,
    });
    terminals.push(plain);
    await operations.setTerminalNativeSessionId({ terminalId: plain.id, nativeSessionId: "plain-session" });
    expect(repository.getWorktree(second.id)?.nativeSessionId).toBeNull();
  });

  it("project deletion physically removes clean linked worktrees before DB cascade", async () => {
    const project = await repository.createProject("Repo", projectWorkspace);
    const operations = await makeOperations();
    const worktree = await operations.createWorktree({ projectId: project.id, branch: "codex/delete-project" });

    await operations.deleteProject({ projectId: project.id });

    expect(repository.getProject(project.id)).toBeNull();
    expect(repository.getWorktree(worktree.id)).toBeNull();
    const linked = await git(["worktree", "list"], { cwd: projectWorkspace });
    expect(linked.stdout).not.toContain(worktree.worktreePath);
  });
});

describe("path-policy mustExist option", () => {
  it("accepts a workspace through a symlink/junction root and its canonical alias", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "coterm-pp-link-root-"));
    try {
      const target = join(sandbox, "target");
      const workspace = join(target, "workspace");
      const linkedRoot = join(sandbox, "linked-root");
      await mkdir(workspace, { recursive: true });
      await symlink(target, linkedRoot, process.platform === "win32" ? "junction" : "dir");

      const linkedWorkspace = join(linkedRoot, "workspace");
      const canonicalWorkspace = await realpath(workspace);
      await expect(assertAllowedPath(linkedWorkspace, { roots: [linkedWorkspace] }))
        .resolves.toBe(canonicalWorkspace);
      // Existing-path callers may feed the canonical cwd returned above back
      // into the policy while the project root remains stored via the junction.
      await expect(assertAllowedPath(canonicalWorkspace, { roots: [linkedWorkspace] }))
        .resolves.toBe(canonicalWorkspace);
      await expect(assertAllowedPath(join(linkedWorkspace, "future"), {
        roots: [linkedWorkspace],
        mustExist: false,
      })).resolves.toBe(join(linkedWorkspace, "future"));

      const outside = join(sandbox, "outside");
      const escape = join(workspace, "escape");
      await mkdir(outside);
      await symlink(outside, escape, process.platform === "win32" ? "junction" : "dir");
      await expect(assertAllowedPath(join(linkedWorkspace, "escape"), {
        roots: [linkedWorkspace],
      })).rejects.toThrow(/outside the allowed workspace/);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("allows a non-existent child under an existing root", async () => {
    const root = await mkdtemp(join(tmpdir(), "coterm-pp-"));
    try {
      const child = join(root, "does", "not", "exist", "yet");
      const resolved = await assertAllowedPath(child, { roots: [root], mustExist: false });
      expect(resolved).toBe(child);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects .. traversal even with mustExist:false", async () => {
    const root = await mkdtemp(join(tmpdir(), "coterm-pp-"));
    try {
      const escape = join(root, "..", "evil");
      await expect(assertAllowedPath(escape, { roots: [root], mustExist: false }))
        .rejects.toThrow(/outside the allowed workspace/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("default mustExist:true still rejects non-existent paths (regression)", async () => {
    const root = await mkdtemp(join(tmpdir(), "coterm-pp-"));
    try {
      const child = join(root, "missing");
      await expect(assertAllowedPath(child, { roots: [root] }))
        .rejects.toThrow(/does not exist/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a non-existent child beneath a symlink/junction that escapes the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "coterm-pp-root-"));
    const outside = await mkdtemp(join(tmpdir(), "coterm-pp-outside-"));
    try {
      const link = join(root, "escape-link");
      await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
      await expect(assertAllowedPath(join(link, "future"), { roots: [root], mustExist: false }))
        .rejects.toThrow(/outside the allowed workspace/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("git-helper", () => {
  it("uses an argument array in a Unicode/space cwd and retains only the configured output tail", async () => {
    const parent = await mkdtemp(join(tmpdir(), "coterm-git-"));
    const dir = join(parent, "空 白 repo");
    try {
      await mkdir(dir);
      await execFileAsync("git", ["init"], { cwd: dir, shell: false, windowsHide: true });
      const result = await git(["rev-parse", "--is-inside-work-tree"], { cwd: dir });
      expect(result.stdout.trim()).toBe("true");
      expect(result.exitCode).toBe(0);
      await writeFile(join(dir, "large.txt"), `${"a".repeat(4_096)}TAIL\n`);
      await execFileAsync("git", ["add", "large.txt"], { cwd: dir, shell: false, windowsHide: true });
      const capped = await git(["show", ":large.txt"], { cwd: dir, maxOutputBytes: 128 });
      expect(Buffer.byteLength(capped.stdout, "utf8")).toBeLessThanOrEqual(128);
      expect(capped.stdout).toContain("TAIL");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("surfaces structured error metadata on failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coterm-git-"));
    try {
      await expect(git(["status"], { cwd: dir })).rejects.toThrow(/failed/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("kills a git invocation that exceeds the configured timeout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coterm-git-timeout-"));
    try {
      await execFileAsync("git", ["init"], { cwd: dir, shell: false, windowsHide: true });
      await expect(git([
        "-c",
        'alias.coterm-wait=!node -e "setTimeout(()=>{},2000)"',
        "coterm-wait",
      ], { cwd: dir, timeoutMs: 50 })).rejects.toThrow(/timed out/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
