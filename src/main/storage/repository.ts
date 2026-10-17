import {
  appSettingsSchema,
  appSettingsPatchSchema,
  attachmentSchema,
  conversationSummarySchema,
  conversationSchema,
  normalizedEventSchema,
  projectHistorySessionSchema,
  projectSchema,
  providerSessionSchema,
  worktreeSchema,
  checkpointSchema,
  checkpointRestoreRecordSchema,
  terminalHandoffPacketSchema,
  agentapiWorkflowSchema,
  agentapiWorkflowStepSchema,
  agentapiWorkflowOutcomeSchema,
} from "@shared/schema";
import type { ConversationSummary } from "@shared/schema";
import { mergeAppSettingsPatch } from "@shared/settings-patch";
import type {
  AppSettings,
  Attachment,
  Conversation,
  GlobalSearchInput,
  GlobalSearchResult,
  NormalizedEvent,
  Project,
  ProviderProfileId,
  ProviderSession,
  Worktree,
  WorktreePermissionsPreset,
  WorktreeStatus,
  Checkpoint,
  CheckpointKind,
  CheckpointPhase,
  CheckpointStatus,
  CheckpointRestoreRecord,
  TerminalHandoffPacket,
  AgentApiWorkflow,
  AgentApiWorkflowCreate,
  AgentApiWorkflowState,
  AgentApiWorkflowStep,
  AgentApiStepKind,
  AgentApiStepStatus,
} from "@shared/types";
import { createId, nowIso } from "../core/ids";
import { logger } from "../core/logger";
import { redactEgress, redactEgressValue } from "../security/redaction";
import type { AppDatabase } from "./database";
import { LedgerSearchIndex, type LedgerSearchKind } from "./search-index";
import { SearchIndexWorkerClient } from "./search-index-worker-client";

interface ProjectRow {
  id: string;
  name: string;
  workspace_path: string;
  pinned: number;
  project_order: number;
  archived: number;
  created_at: string;
  updated_at: string;
}

interface ConversationRow {
  id: string;
  project_id: string;
  name: string;
  active_provider: ProviderProfileId;
  primary_provider: ProviderProfileId | null;
  claude_model: Conversation["claudeModel"];
  continued_from_conversation_id: string | null;
  handoff_source_conversation_id: string | null;
  archived: number;
  created_at: string;
  updated_at: string;
  summary_json: string | null;
}

interface ProviderSessionRow {
  id: string;
  conversation_id: string;
  profile_id: ProviderProfileId;
  native_session_id: string | null;
  status: ProviderSession["status"];
  created_at: string;
  updated_at: string;
}

interface ProjectHistorySessionRow extends ProviderSessionRow {
  project_id: string;
  conversation_name: string;
  conversation_updated_at: string;
  summary_json: string | null;
}

interface EventRow {
  id: string;
  conversation_id: string;
  turn_id: string;
  provider_session_id: string | null;
  turn_group_id: string | null;
  type: NormalizedEvent["type"];
  created_at: string;
  sequence: number;
  summary: string;
  payload_json: string;
}

/** Union of the per-source columns read when syncing the FTS search index. */
interface TerminalEventRow {
  id: string;
  project_id: string;
  terminal_id: string;
  type: string;
  created_at: string;
  sequence: number;
  summary: string;
  payload_json: string;
}

interface TerminalHandoffRow {
  id: string;
  request_fingerprint: string;
  packet_json: string;
  source_kind: TerminalHandoffPacket["source"];
  summarizer_profile: "claude-local-main" | "claude-local-long" | "deterministic";
  input_bytes: number;
  packet_bytes: number;
  token_estimate: number;
  created_at: string;
}

interface AgentApiWorkflowRow {
  id: string;
  project_id: string;
  task: string;
  idempotency_key: string;
  branch: string | null;
  base_ref: string | null;
  implementer: "claude-local-main";
  reviewer: "codex-local-main";
  state: AgentApiWorkflowState;
  resume_state: AgentApiWorkflowState | null;
  review_loop: number;
  worktree_id: string | null;
  worktree_path: string | null;
  terminal_id: string | null;
  session_id: string | null;
  handoff_id: string | null;
  last_outcome_json: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface AgentApiWorkflowStepRow {
  id: string;
  workflow_id: string;
  kind: AgentApiStepKind;
  attempt: number;
  idempotency_key: string;
  status: AgentApiStepStatus;
  terminal_id: string | null;
  session_id: string | null;
  handoff_id: string | null;
  outcome_json: string | null;
  revision: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface WorktreeRow {
  id: string;
  project_id: string;
  branch: string;
  worktree_path: string;
  base_ref: string;
  status: WorktreeStatus;
  native_session_id: string | null;
  resume_command: string | null;
  pr_url: string | null;
  permissions_preset: WorktreePermissionsPreset;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

interface CheckpointRow {
  id: string;
  turn_id: string | null;
  conversation_id: string | null;
  project_id: string;
  worktree_id: string | null;
  phase: CheckpointPhase;
  kind: CheckpointKind;
  status: CheckpointStatus;
  ref: string | null;
  snapshot_path: string | null;
  workspace_fingerprint: string | null;
  file_count: number;
  size_bytes: number;
  partial: number;
  created_at: string;
  finalized_at: string | null;
}

interface CheckpointRestoreRow {
  id: string;
  checkpoint_id: string;
  turn_id: string | null;
  conversation_id: string | null;
  project_id: string;
  worktree_id: string | null;
  status: "applied" | "refused" | "failed";
  reason: string | null;
  created_at: string;
}

interface TerminalLedgerEvent {
  id: string;
  projectId: string;
  terminalId: string;
  type: string;
  createdAt: string;
  sequence: number;
  summary: string;
  payload: Record<string, unknown>;
}

interface ConversationSummaryEvent {
  sequence: number;
  type: "user.message" | "assistant.final";
  text: string;
  originalLength: number;
}

export const CONVERSATION_SUMMARY_EVENT_WINDOW = 200;
export const CONVERSATION_SUMMARY_TEXT_LIMIT = 20_000;

// Hard rolling caps for terminal_events, on top of the day-based retention
// (which users can turn off): an uncapped ledger grew ai-terminal.sqlite to
// 1.37 GB and made every write stall on a full-db export. Whichever cap trips
// first deletes oldest rows. Caps are constants, not settings — they are a
// safety bound, not a user preference.
export const TERMINAL_EVENTS_MAX_ROWS = 50_000;
export const TERMINAL_EVENTS_MAX_PAYLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
// Amortization: the cap check reads the trigger-maintained storage_counters
// rows (two primary-key lookups) and only pays for a pruning pass when a cap
// is actually exceeded. Runs at startup and once every N terminal-event
// appends.
const OVERFLOW_CHECK_EVERY_APPENDS = 256;

const defaultSettings = appSettingsSchema.parse({});

export class Repository {
  // Lazy: the sidecar index file is only created once a search actually runs.
  private ledgerSearchIndex: LedgerSearchIndex | null = null;
  private searchIndexDirty = true;
  private searchIndexSyncScheduled = false;
  private searchIndexSyncRunning = false;
  private searchIndexClosed = false;
  private searchIndexSyncEnabled = false;
  /** null 直到第一次從儲存設定讀取（開機 timer 可能比任何 setSettings 都早）。 */
  private searchIndexBuildEnabled: boolean | null = null;
  private searchIndexSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly searchIndexWorker = new SearchIndexWorkerClient();
  private appendsSinceOverflowCheck = 0;

  constructor(private readonly database: AppDatabase) {}

  listProjects(): Project[] {
    return this.database
      .queryAll<ProjectRow>(
        "SELECT * FROM projects WHERE archived = 0 ORDER BY pinned DESC, COALESCE(project_order, 0) ASC, id ASC",
      )
      .map(mapProject);
  }

  listArchivedProjects(): Project[] {
    return this.database
      .queryAll<ProjectRow>("SELECT * FROM projects WHERE archived = 1 ORDER BY updated_at DESC")
      .map(mapProject);
  }

  getProject(projectId: string): Project | null {
    const row = this.database.queryOne<ProjectRow>("SELECT * FROM projects WHERE id = $id", {
      $id: projectId,
    });
    return row ? mapProject(row) : null;
  }

  async createProject(name: string, workspacePath: string): Promise<Project> {
    const timestamp = nowIso();
    const project = projectSchema.parse({
      id: createId(),
      name,
      workspacePath,
      pinned: false,
      order: this.nextProjectOrder(),
      archived: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.database.transaction(() => {
      this.database.run(
        `INSERT INTO projects(
          id, name, workspace_path, pinned, archived, project_order, created_at, updated_at
        ) VALUES ($id, $name, $workspacePath, 0, 0, $projectOrder, $createdAt, $updatedAt)`,
        {
          $id: project.id,
          $name: project.name,
          $projectOrder: project.order,
          $workspacePath: project.workspacePath,
          $createdAt: project.createdAt,
          $updatedAt: project.updatedAt,
        },
      );
    });
    this.markSearchIndexDirty();
    return project;
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.database.transaction(() => {
      // Cascade delete all child tables in dependency order (mirrors deleteConversation).
      this.database.run(
        "DELETE FROM turn_group_members WHERE turn_group_id IN (SELECT id FROM turn_groups WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id = $id))",
        { $id: projectId },
      );
      this.database.run(
        "DELETE FROM peer_reviews WHERE turn_group_id IN (SELECT id FROM turn_groups WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id = $id))",
        { $id: projectId },
      );
      this.database.run(
        "DELETE FROM chairman_syntheses WHERE turn_group_id IN (SELECT id FROM turn_groups WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id = $id))",
        { $id: projectId },
      );
      this.database.run("DELETE FROM turn_groups WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id = $id)", { $id: projectId });
      this.database.run("DELETE FROM handoffs WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id = $id)", { $id: projectId });
      this.database.run("DELETE FROM attachments WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id = $id)", { $id: projectId });
      this.database.run("DELETE FROM events WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id = $id)", { $id: projectId });
      this.database.run("DELETE FROM turns WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id = $id)", { $id: projectId });
      this.database.run("DELETE FROM provider_sessions WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id = $id)", { $id: projectId });
      this.database.run("DELETE FROM conversations WHERE project_id = $id", { $id: projectId });
      this.database.run("DELETE FROM terminal_events WHERE project_id = $id", { $id: projectId });
      this.database.run("DELETE FROM terminal_panes WHERE project_id = $id", { $id: projectId });
      this.database.run("DELETE FROM terminal_workspaces WHERE project_id = $id", { $id: projectId });
      this.database.run("DELETE FROM worktrees WHERE project_id = $id", { $id: projectId });
      this.database.run("DELETE FROM checkpoint_restores WHERE project_id = $id", { $id: projectId });
      this.database.run("DELETE FROM checkpoints WHERE project_id = $id", { $id: projectId });
      this.database.run("DELETE FROM projects WHERE id = $id", { $id: projectId });
    });
    this.markSearchIndexDirty();
  }

  // --- A — Worktree sandbox CRUD -------------------------------------------

  listWorktrees(projectId: string): Worktree[] {
    return this.database
      .queryAll<WorktreeRow>(
        "SELECT * FROM worktrees WHERE project_id = $projectId ORDER BY created_at DESC",
        { $projectId: projectId },
      )
      .map(mapWorktree);
  }

  listActiveWorktrees(): Worktree[] {
    return this.database
      .queryAll<WorktreeRow>(
        "SELECT * FROM worktrees WHERE status = 'active' ORDER BY created_at DESC",
      )
      .map(mapWorktree);
  }

  getWorktree(worktreeId: string): Worktree | null {
    const row = this.database.queryOne<WorktreeRow>(
      "SELECT * FROM worktrees WHERE id = $id",
      { $id: worktreeId },
    );
    return row ? mapWorktree(row) : null;
  }

  getWorktreeByPath(worktreePath: string): Worktree | null {
    const row = this.database.queryOne<WorktreeRow>(
      "SELECT * FROM worktrees WHERE worktree_path = $path",
      { $path: worktreePath },
    );
    return row ? mapWorktree(row) : null;
  }

  async createWorktree(input: {
    id: string;
    projectId: string;
    branch: string;
    worktreePath: string;
    baseRef: string;
    permissionsPreset: WorktreePermissionsPreset;
  }): Promise<Worktree> {
    const timestamp = nowIso();
    const worktree = worktreeSchema.parse({
      id: input.id,
      projectId: input.projectId,
      branch: input.branch,
      worktreePath: input.worktreePath,
      baseRef: input.baseRef,
      status: "active",
      nativeSessionId: null,
      resumeCommand: null,
      prUrl: null,
      permissionsPreset: input.permissionsPreset,
      createdAt: timestamp,
      updatedAt: timestamp,
      closedAt: null,
    });
    await this.database.transaction(() => {
      this.database.run(
        `INSERT INTO worktrees(
          id, project_id, branch, worktree_path, base_ref, status,
          native_session_id, resume_command, pr_url, permissions_preset,
          created_at, updated_at, closed_at
        ) VALUES (
          $id, $projectId, $branch, $worktreePath, $baseRef, $status,
          NULL, NULL, NULL, $permissionsPreset,
          $createdAt, $updatedAt, NULL
        )`,
        {
          $id: worktree.id,
          $projectId: worktree.projectId,
          $branch: worktree.branch,
          $worktreePath: worktree.worktreePath,
          $baseRef: worktree.baseRef,
          $status: worktree.status,
          $permissionsPreset: worktree.permissionsPreset,
          $createdAt: worktree.createdAt,
          $updatedAt: worktree.updatedAt,
        },
      );
    });
    return worktree;
  }

  async updateWorktreeStatus(
    worktreeId: string,
    status: WorktreeStatus,
    extra?: { closedAt?: string | null },
  ): Promise<void> {
    await this.database.transaction(() => {
      this.database.run(
        `UPDATE worktrees SET status = $status, updated_at = $updatedAt,
         closed_at = $closedAt WHERE id = $id`,
        {
          $id: worktreeId,
          $status: status,
          $updatedAt: nowIso(),
          $closedAt: extra?.closedAt ?? null,
        },
      );
    });
  }

  async bindWorktreeSession(
    worktreeId: string,
    nativeSessionId: string,
    resumeCommand: string,
  ): Promise<void> {
    await this.database.transaction(() => {
      this.database.run(
        `UPDATE worktrees SET native_session_id = $nativeSessionId,
         resume_command = $resumeCommand, updated_at = $updatedAt
         WHERE id = $id`,
        {
          $id: worktreeId,
          $nativeSessionId: nativeSessionId,
          $resumeCommand: resumeCommand,
          $updatedAt: nowIso(),
        },
      );
    });
  }

  async deleteWorktree(worktreeId: string): Promise<void> {
    await this.database.transaction(() => {
      this.database.run("DELETE FROM worktrees WHERE id = $id", { $id: worktreeId });
    });
  }

  // --- B — Checkpoint / undo-redo rail CRUD ---------------------------------

  listCheckpoints(input: {
    conversationId?: string | null;
    projectId?: string;
    worktreeId?: string | null;
  }): Checkpoint[] {
    const where: string[] = [];
    const params: Record<string, string | null> = {};
    if (input.conversationId) {
      where.push("conversation_id = $conversationId");
      params.$conversationId = input.conversationId;
    }
    if (input.projectId) {
      where.push("project_id = $projectId");
      params.$projectId = input.projectId;
    }
    if (input.worktreeId) {
      where.push("worktree_id = $worktreeId");
      params.$worktreeId = input.worktreeId;
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return this.database
      .queryAll<CheckpointRow>(
        `SELECT * FROM checkpoints ${clause} ORDER BY created_at DESC`,
        params,
      )
      .map(mapCheckpoint);
  }

  getCheckpoint(checkpointId: string): Checkpoint | null {
    const row = this.database.queryOne<CheckpointRow>(
      "SELECT * FROM checkpoints WHERE id = $id",
      { $id: checkpointId },
    );
    return row ? mapCheckpoint(row) : null;
  }

  /**
   * The pre/post checkpoints for a turn, ordered pre-then-post. Either may be
   * absent (failed/never finalized). Used by undo/redo to walk the chain.
   */
  getTurnCheckpoints(turnId: string): { pre: Checkpoint | null; post: Checkpoint | null } {
    const rows = this.database.queryAll<CheckpointRow>(
      "SELECT * FROM checkpoints WHERE turn_id = $turnId ORDER BY phase ASC",
      { $turnId: turnId },
    );
    const pre = rows.find((row) => row.phase === "pre") ?? null;
    const post = rows.find((row) => row.phase === "post") ?? null;
    return { pre: pre ? mapCheckpoint(pre) : null, post: post ? mapCheckpoint(post) : null };
  }

  async createCheckpoint(input: {
    id: string;
    turnId: string | null;
    conversationId: string | null;
    projectId: string;
    worktreeId: string | null;
    phase: CheckpointPhase;
    kind: CheckpointKind;
    status: CheckpointStatus;
    ref: string | null;
    snapshotPath: string | null;
    workspaceFingerprint: string | null;
    fileCount: number;
    sizeBytes: number;
    partial: boolean;
  }): Promise<Checkpoint> {
    const timestamp = nowIso();
    const checkpoint = checkpointSchema.parse({
      id: input.id,
      turnId: input.turnId,
      conversationId: input.conversationId,
      projectId: input.projectId,
      worktreeId: input.worktreeId,
      phase: input.phase,
      kind: input.kind,
      status: input.status,
      ref: input.ref,
      snapshotPath: input.snapshotPath,
      workspaceFingerprint: input.workspaceFingerprint,
      fileCount: input.fileCount,
      sizeBytes: input.sizeBytes,
      partial: input.partial,
      createdAt: timestamp,
      finalizedAt: null,
    });
    await this.database.transaction(() => {
      this.database.run(
        `INSERT INTO checkpoints(
          id, turn_id, conversation_id, project_id, worktree_id, phase, kind, status,
          ref, snapshot_path, workspace_fingerprint, file_count, size_bytes, partial,
          created_at, finalized_at
        ) VALUES (
          $id, $turnId, $conversationId, $projectId, $worktreeId, $phase, $kind, $status,
          $ref, $snapshotPath, $workspaceFingerprint, $fileCount, $sizeBytes, $partial,
          $createdAt, NULL
        )`,
        {
          $id: checkpoint.id,
          $turnId: checkpoint.turnId,
          $conversationId: checkpoint.conversationId,
          $projectId: checkpoint.projectId,
          $worktreeId: checkpoint.worktreeId,
          $phase: checkpoint.phase,
          $kind: checkpoint.kind,
          $status: checkpoint.status,
          $ref: checkpoint.ref,
          $snapshotPath: checkpoint.snapshotPath,
          $workspaceFingerprint: checkpoint.workspaceFingerprint,
          $fileCount: checkpoint.fileCount,
          $sizeBytes: checkpoint.sizeBytes,
          $partial: checkpoint.partial ? 1 : 0,
          $createdAt: checkpoint.createdAt,
        },
      );
    });
    return checkpoint;
  }

  async finalizeCheckpoint(
    checkpointId: string,
    update: {
      status: CheckpointStatus;
      ref?: string | null;
      snapshotPath?: string | null;
      workspaceFingerprint?: string | null;
      fileCount?: number;
      sizeBytes?: number;
      partial?: boolean;
    },
  ): Promise<void> {
    await this.database.transaction(() => {
      this.database.run(
        `UPDATE checkpoints SET status = $status,
         ${update.ref !== undefined ? "ref = $ref, " : ""}
         ${update.snapshotPath !== undefined ? "snapshot_path = $snapshotPath, " : ""}
         ${update.workspaceFingerprint !== undefined ? "workspace_fingerprint = $workspaceFingerprint, " : ""}
         ${update.fileCount !== undefined ? "file_count = $fileCount, " : ""}
         ${update.sizeBytes !== undefined ? "size_bytes = $sizeBytes, " : ""}
         ${update.partial !== undefined ? "partial = $partial, " : ""}
         finalized_at = $finalizedAt
         WHERE id = $id`,
        {
          $id: checkpointId,
          $status: update.status,
          $ref: update.ref ?? null,
          $snapshotPath: update.snapshotPath ?? null,
          $workspaceFingerprint: update.workspaceFingerprint ?? null,
          $fileCount: update.fileCount ?? 0,
          $sizeBytes: update.sizeBytes ?? 0,
          $partial: update.partial ? 1 : 0,
          $finalizedAt: nowIso(),
        },
      );
    });
  }

  async markCheckpointStatus(checkpointId: string, status: CheckpointStatus): Promise<void> {
    await this.database.transaction(() => {
      this.database.run(
        "UPDATE checkpoints SET status = $status WHERE id = $id",
        { $id: checkpointId, $status: status },
      );
    });
  }

  async appendCheckpointRestore(input: {
    id: string;
    checkpointId: string;
    turnId: string | null;
    conversationId: string | null;
    projectId: string;
    worktreeId: string | null;
    status: "applied" | "refused" | "failed";
    reason: string | null;
  }): Promise<CheckpointRestoreRecord> {
    const timestamp = nowIso();
    const record = checkpointRestoreRecordSchema.parse({
      id: input.id,
      checkpointId: input.checkpointId,
      turnId: input.turnId,
      conversationId: input.conversationId,
      projectId: input.projectId,
      worktreeId: input.worktreeId,
      status: input.status,
      reason: input.reason,
      createdAt: timestamp,
    });
    await this.database.transaction(() => {
      this.database.run(
        `INSERT INTO checkpoint_restores(
          id, checkpoint_id, turn_id, conversation_id, project_id, worktree_id, status, reason, created_at
        ) VALUES (
          $id, $checkpointId, $turnId, $conversationId, $projectId, $worktreeId, $status, $reason, $createdAt
        )`,
        {
          $id: record.id,
          $checkpointId: record.checkpointId,
          $turnId: record.turnId,
          $conversationId: record.conversationId,
          $projectId: record.projectId,
          $worktreeId: record.worktreeId,
          $status: record.status,
          $reason: record.reason,
          $createdAt: record.createdAt,
        },
      );
    });
    return record;
  }

  listCheckpointRestores(checkpointId: string): CheckpointRestoreRecord[] {
    return this.database
      .queryAll<CheckpointRestoreRow>(
        "SELECT * FROM checkpoint_restores WHERE checkpoint_id = $id ORDER BY created_at DESC",
        { $id: checkpointId },
      )
      .map(mapCheckpointRestore);
  }

  async renameProject(projectId: string, name: string): Promise<Project> {
    await this.database.transaction(() => {
      this.database.run(
        "UPDATE projects SET name = $name, updated_at = $updatedAt WHERE id = $id",
        { $id: projectId, $name: name, $updatedAt: nowIso() },
      );
    });
    const project = this.getProject(projectId);
    if (!project) throw new Error("Project not found.");
    this.markSearchIndexDirty();
    return project;
  }

  async setProjectPinned(projectId: string, pinned: boolean): Promise<Project> {
    await this.database.transaction(() => {
      this.database.run(
        "UPDATE projects SET pinned = $pinned, updated_at = $updatedAt WHERE id = $id",
        { $id: projectId, $pinned: pinned ? 1 : 0, $updatedAt: nowIso() },
      );
    });
    const project = this.getProject(projectId);
    if (!project) throw new Error("Project not found.");
    this.markSearchIndexDirty();
    return project;
  }

  async reorderProjects(projectIds: string[]): Promise<Project[]> {
    const current = this.database.queryAll<{ id: string }>(
      "SELECT id FROM projects WHERE archived = 0 ORDER BY pinned DESC, COALESCE(project_order, 0) ASC, id ASC",
    );
    const expected = current.map((row) => row.id);
    const expectedSet = new Set(expected);
    if (projectIds.length !== expected.length || new Set(projectIds).size !== projectIds.length
      || projectIds.some((id) => !expectedSet.has(id))) {
      throw new Error("Project order is stale; refresh and try again.");
    }
    await this.database.transaction(() => {
      projectIds.forEach((id, index) => {
        this.database.run("UPDATE projects SET project_order = $order WHERE id = $id", {
          $id: id,
          $order: index,
        });
      });
    });
    return this.listProjects();
  }

  /**
   * 最近開過置頂 (2026-09-26 maintainer): opening a terminal in a project floats it
   * to the top of its pin group, so the folders with the freshest sessions
   * stack at the top. Manual drag-reorder still works afterwards; this only
   * rewrites one row's project_order. Returns the new active-project id order
   * when something moved, or null when the project was already on top.
   */
  async bumpProjectToTop(projectId: string): Promise<string[] | null> {
    // council 2026-09-26 R3 #4: EVERYTHING runs inside the write transaction —
    // the lookup, the head check, the MIN, and the UPDATE. A stale read
    // outside the tx could let a concurrent bump double-write or float a
    // just-archived project. MIN is scoped to the project's own pin group (an
    // unpinned bump must not outrank the pinned block) and NULL orders
    // coalesce so an ancient NULL row can't pin the head forever.
    let moved = false;
    await this.database.transaction(() => {
      const project = this.getProject(projectId);
      if (!project || project.archived) return;
      const head = this.database.queryOne<{ id: string }>(
        "SELECT id FROM projects WHERE archived = 0 AND pinned = $pinned ORDER BY COALESCE(project_order, 0) ASC, id ASC LIMIT 1",
        { $pinned: project.pinned ? 1 : 0 },
      );
      if (head?.id === projectId) return;
      const row = this.database.queryOne<{ min_order: number | null }>(
        "SELECT MIN(COALESCE(project_order, 0)) AS min_order FROM projects WHERE archived = 0 AND pinned = $pinned",
        { $pinned: project.pinned ? 1 : 0 },
      );
      const order = row?.min_order === null || row?.min_order === undefined ? 0 : row.min_order - 1;
      this.database.run(
        "UPDATE projects SET project_order = $order WHERE id = $id AND archived = 0 AND pinned = $pinned",
        { $id: projectId, $order: order, $pinned: project.pinned ? 1 : 0 },
      );
      moved = true;
    });
    // council R3 #12: id-only select for the event payload (not full rows).
    return moved ? this.listProjectIds() : null;
  }

  private listProjectIds(): string[] {
    return this.database
      .queryAll<{ id: string }>(
        "SELECT id FROM projects WHERE archived = 0 ORDER BY pinned DESC, COALESCE(project_order, 0) ASC, id ASC",
      )
      .map((row) => row.id);
  }

  private nextProjectOrder(): number {
    // New projects are unpinned, so the min is scoped to the unpinned group
    // (same rule as bumpProjectToTop) and NULLs coalesce.
    const row = this.database.queryOne<{ min_order: number | null }>(
      "SELECT MIN(COALESCE(project_order, 0)) AS min_order FROM projects WHERE archived = 0 AND pinned = 0",
    );
    return row?.min_order === null || row?.min_order === undefined ? 0 : row.min_order - 1;
  }

  async setProjectArchived(projectId: string, archived: boolean): Promise<Project> {
    await this.database.transaction(() => {
      this.database.run(
        "UPDATE projects SET archived = $archived, updated_at = $updatedAt WHERE id = $id",
        { $id: projectId, $archived: archived ? 1 : 0, $updatedAt: nowIso() },
      );
    });
    const project = this.getProject(projectId);
    if (!project) throw new Error("Project not found.");
    this.markSearchIndexDirty();
    return project;
  }

  listConversations(projectId?: string): Conversation[] {
    const rows = projectId
      ? this.database.queryAll<ConversationRow>(
          `SELECT c.* FROM conversations c
           JOIN projects p ON p.id = c.project_id
           WHERE c.project_id = $projectId AND c.archived = 0 AND p.archived = 0
           ORDER BY c.updated_at DESC`,
          { $projectId: projectId },
        )
      : this.database.queryAll<ConversationRow>(
          `SELECT c.* FROM conversations c
           JOIN projects p ON p.id = c.project_id
           WHERE c.archived = 0 AND p.archived = 0
           ORDER BY c.updated_at DESC`,
        );
    return rows.map(mapConversation);
  }

  listProjectSessions(projectId: string) {
    return this.database.queryAll<ProjectHistorySessionRow>(
      `SELECT
         s.*,
         c.project_id,
         c.name AS conversation_name,
         c.updated_at AS conversation_updated_at,
         c.summary_json
       FROM provider_sessions s
       JOIN conversations c ON c.id = s.conversation_id
       JOIN projects p ON p.id = c.project_id
       WHERE c.project_id = $projectId AND c.archived = 0 AND p.archived = 0
       ORDER BY c.updated_at DESC, s.updated_at DESC`,
      { $projectId: projectId },
    ).map(mapProjectHistorySession);
  }

  listArchivedConversations(): Conversation[] {
    return this.database
      .queryAll<ConversationRow>(
        `SELECT c.* FROM conversations c
         JOIN projects p ON p.id = c.project_id
         WHERE c.archived = 1 OR p.archived = 1
         ORDER BY c.updated_at DESC`,
      )
      .map(mapConversation);
  }

  getConversation(conversationId: string): Conversation | null {
    const row = this.database.queryOne<ConversationRow>(
      "SELECT * FROM conversations WHERE id = $id",
      { $id: conversationId },
    );
    return row ? mapConversation(row) : null;
  }

  async createConversation(
    projectId: string,
    name: string,
    provider: ProviderProfileId,
  ): Promise<Conversation> {
    const timestamp = nowIso();
    const conversation = conversationSchema.parse({
      id: createId(),
      projectId,
      name,
      activeProvider: provider,
      primaryProvider: provider,
      claudeModel: "default",
      continuedFromConversationId: null,
      handoffSourceConversationId: null,
      archived: false,
      summary: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.database.transaction(() => {
      this.database.run(
        `INSERT INTO conversations(
          id, project_id, name, active_provider, primary_provider, claude_model,
          continued_from_conversation_id, handoff_source_conversation_id,
          archived, created_at, updated_at
        ) VALUES (
          $id, $projectId, $name, $provider, $provider, $claudeModel,
          NULL, NULL, 0, $createdAt, $updatedAt
        )`,
        {
          $id: conversation.id,
          $projectId: conversation.projectId,
          $name: conversation.name,
          $provider: conversation.activeProvider,
          $claudeModel: conversation.claudeModel,
          $createdAt: conversation.createdAt,
          $updatedAt: conversation.updatedAt,
        },
      );
    });
    this.markSearchIndexDirty();
    return conversation;
  }

  async createContinuationConversation(
    sourceConversationId: string,
    targetProvider: ProviderProfileId,
  ): Promise<Conversation> {
    const source = this.getConversation(sourceConversationId);
    if (!source) throw new Error("Conversation not found.");
    const timestamp = nowIso();
    const conversation = conversationSchema.parse({
      id: createId(),
      projectId: source.projectId,
      name: source.name,
      activeProvider: targetProvider,
      primaryProvider: targetProvider,
      claudeModel: source.claudeModel,
      continuedFromConversationId: source.id,
      handoffSourceConversationId: source.id,
      archived: false,
      summary: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.database.transaction(() => {
      this.database.run(
        `INSERT INTO conversations(
          id, project_id, name, active_provider, primary_provider, claude_model,
          continued_from_conversation_id, handoff_source_conversation_id,
          archived, created_at, updated_at
        ) VALUES (
          $id, $projectId, $name, $activeProvider, $primaryProvider, $claudeModel,
          $continuedFromConversationId, $handoffSourceConversationId,
          0, $createdAt, $updatedAt
        )`,
        {
          $id: conversation.id,
          $projectId: conversation.projectId,
          $name: conversation.name,
          $activeProvider: conversation.activeProvider,
          $primaryProvider: conversation.primaryProvider,
          $claudeModel: conversation.claudeModel,
          $continuedFromConversationId: conversation.continuedFromConversationId,
          $handoffSourceConversationId: conversation.handoffSourceConversationId,
          $createdAt: conversation.createdAt,
          $updatedAt: conversation.updatedAt,
        },
      );
    });
    this.markSearchIndexDirty();
    return conversation;
  }

  async renameConversation(conversationId: string, name: string): Promise<Conversation> {
    await this.database.transaction(() => {
      this.database.run(
        "UPDATE conversations SET name = $name, updated_at = $updatedAt WHERE id = $id",
        { $id: conversationId, $name: name, $updatedAt: nowIso() },
      );
    });
    const conversation = this.getConversation(conversationId);
    if (!conversation) throw new Error("Conversation not found.");
    this.markSearchIndexDirty();
    return conversation;
  }

  async setConversationClaudeModel(
    conversationId: string,
    model: Conversation["claudeModel"],
  ): Promise<Conversation> {
    await this.database.transaction(() => {
      this.database.run(
        "UPDATE conversations SET claude_model = $model, updated_at = $updatedAt WHERE id = $id",
        { $id: conversationId, $model: model, $updatedAt: nowIso() },
      );
    });
    const conversation = this.getConversation(conversationId);
    if (!conversation) throw new Error("Conversation not found.");
    return conversation;
  }

  async saveConversationSummary(
    conversationId: string,
    name: string,
    summary: ConversationSummary,
  ): Promise<Conversation> {
    const existing = this.getConversation(conversationId);
    if (!existing) throw new Error("Conversation not found.");
    const parsed = conversationSchema.parse({
      ...existing,
      name,
      summary: conversationSummarySchema.parse(summary),
      updatedAt: summary.updatedAt,
    });
    await this.database.transaction(() => {
      this.database.run(
        `UPDATE conversations
         SET name = $name, summary_json = $summary, updated_at = $updatedAt
         WHERE id = $id`,
        {
          $id: conversationId,
          $name: parsed.name,
          $summary: JSON.stringify(parsed.summary),
          $updatedAt: parsed.updatedAt,
        },
      );
    });
    this.markSearchIndexDirty();
    return this.getConversation(conversationId)!;
  }

  async setConversationArchived(
    conversationId: string,
    archived: boolean,
  ): Promise<Conversation> {
    await this.database.transaction(() => {
      this.database.run(
        "UPDATE conversations SET archived = $archived, updated_at = $updatedAt WHERE id = $id",
        { $id: conversationId, $archived: archived ? 1 : 0, $updatedAt: nowIso() },
      );
    });
    const conversation = this.getConversation(conversationId);
    if (!conversation) throw new Error("Conversation not found.");
    this.markSearchIndexDirty();
    return conversation;
  }

  /**
   * Permanently delete a conversation and all its related records.
   * Returns the attachment local_paths so the caller can remove the files.
   * NOTE: terminal_events are scoped to project/terminal, not conversation,
   * so they are intentionally left untouched.
   */
  async deleteConversation(conversationId: string): Promise<string[]> {
    const attachmentPaths = this.database.queryAll<{ local_path: string }>(
      "SELECT local_path FROM attachments WHERE conversation_id = $id",
      { $id: conversationId },
    ).map((row) => row.local_path);
    await this.database.transaction(() => {
      this.database.run(
        "DELETE FROM turn_group_members WHERE turn_group_id IN (SELECT id FROM turn_groups WHERE conversation_id = $id)",
        { $id: conversationId },
      );
      this.database.run(
        "DELETE FROM peer_reviews WHERE turn_group_id IN (SELECT id FROM turn_groups WHERE conversation_id = $id)",
        { $id: conversationId },
      );
      this.database.run(
        "DELETE FROM chairman_syntheses WHERE turn_group_id IN (SELECT id FROM turn_groups WHERE conversation_id = $id)",
        { $id: conversationId },
      );
      this.database.run("DELETE FROM turn_groups WHERE conversation_id = $id", { $id: conversationId });
      this.database.run("DELETE FROM handoffs WHERE conversation_id = $id", { $id: conversationId });
      this.database.run("DELETE FROM attachments WHERE conversation_id = $id", { $id: conversationId });
      this.database.run("DELETE FROM events WHERE conversation_id = $id", { $id: conversationId });
      this.database.run("DELETE FROM turns WHERE conversation_id = $id", { $id: conversationId });
      this.database.run("DELETE FROM provider_sessions WHERE conversation_id = $id", { $id: conversationId });
      this.database.run("DELETE FROM conversations WHERE id = $id", { $id: conversationId });
    });
    this.markSearchIndexDirty();
    return attachmentPaths;
  }

  async setActiveProvider(
    conversationId: string,
    profileId: ProviderProfileId,
  ): Promise<void> {
    await this.database.transaction(() => {
      this.database.run(
        "UPDATE conversations SET active_provider = $provider, updated_at = $updatedAt WHERE id = $id",
        { $provider: profileId, $updatedAt: nowIso(), $id: conversationId },
      );
    });
  }

  async getOrCreateProviderSession(
    conversationId: string,
    profileId: ProviderProfileId,
  ): Promise<ProviderSession> {
    const timestamp = nowIso();
    const session = providerSessionSchema.parse({
      id: createId(),
      conversationId,
      profileId,
      nativeSessionId: null,
      status: "idle",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return this.database.transaction(() => {
      const existing = this.database.queryOne<ProviderSessionRow>(
        "SELECT * FROM provider_sessions WHERE conversation_id = $conversationId AND profile_id = $profileId",
        { $conversationId: conversationId, $profileId: profileId },
      );
      if (existing) return mapProviderSession(existing);
      this.database.run(
        `INSERT INTO provider_sessions(
          id, conversation_id, profile_id, native_session_id, status, created_at, updated_at
        ) VALUES ($id, $conversationId, $profileId, NULL, 'idle', $createdAt, $updatedAt)`,
        {
          $id: session.id,
          $conversationId: session.conversationId,
          $profileId: session.profileId,
          $createdAt: session.createdAt,
          $updatedAt: session.updatedAt,
        },
      );
      return session;
    });
  }

  findProviderSession(
    conversationId: string,
    profileId: ProviderProfileId,
  ): ProviderSession | null {
    const row = this.database.queryOne<ProviderSessionRow>(
      "SELECT * FROM provider_sessions WHERE conversation_id = $conversationId AND profile_id = $profileId",
      { $conversationId: conversationId, $profileId: profileId },
    );
    return row ? mapProviderSession(row) : null;
  }

  findConversationByNativeSession(
    profileId: ProviderProfileId,
    nativeSessionId: string,
  ): Conversation | null {
    const row = this.database.queryOne<ConversationRow>(
      `SELECT c.* FROM conversations c
       JOIN provider_sessions s ON s.conversation_id = c.id
       WHERE s.profile_id = $profileId AND s.native_session_id = $nativeSessionId
       LIMIT 1`,
      { $profileId: profileId, $nativeSessionId: nativeSessionId },
    );
    return row ? mapConversation(row) : null;
  }

  async updateProviderSession(
    sessionId: string,
    updates: { nativeSessionId?: string | null; status?: ProviderSession["status"] },
  ): Promise<void> {
    const row = this.database.queryOne<ProviderSessionRow>(
      "SELECT * FROM provider_sessions WHERE id = $id",
      { $id: sessionId },
    );
    if (!row) throw new Error("Provider session not found.");
    await this.database.transaction(() => {
      this.database.run(
        `UPDATE provider_sessions
         SET native_session_id = $nativeSessionId, status = $status, updated_at = $updatedAt
         WHERE id = $id`,
        {
          $nativeSessionId: updates.nativeSessionId ?? row.native_session_id,
          $status: updates.status ?? row.status,
          $updatedAt: nowIso(),
          $id: sessionId,
        },
      );
    });
  }

  async startTurn(
    conversationId: string,
    providerSessionId: string | null,
    turnGroupId: string | null = null,
  ): Promise<string> {
    const turnId = createId();
    await this.database.transaction(() => {
      this.database.run(
        `INSERT INTO turns(
          id, conversation_id, provider_session_id, turn_group_id, status, started_at
        ) VALUES ($id, $conversationId, $providerSessionId, $turnGroupId, 'running', $startedAt)`,
        {
          $id: turnId,
          $conversationId: conversationId,
          $providerSessionId: providerSessionId,
          $turnGroupId: turnGroupId,
          $startedAt: nowIso(),
        },
      );
    });
    return turnId;
  }

  async completeTurn(turnId: string, status: "completed" | "failed" | "cancelled"): Promise<void> {
    await this.database.transaction(() => {
      this.database.run(
        "UPDATE turns SET status = $status, completed_at = $completedAt WHERE id = $id",
        { $status: status, $completedAt: nowIso(), $id: turnId },
      );
    });
  }

  listRunningConversationIds(): string[] {
    return this.database
      .queryAll<{ conversation_id: string }>(
        "SELECT DISTINCT conversation_id FROM turns WHERE status = 'running' ORDER BY started_at DESC",
      )
      .map((row) => row.conversation_id);
  }

  async recoverInterruptedRuns(): Promise<void> {
    const timestamp = nowIso();
    await this.database.transaction(() => {
      this.database.run(
        "UPDATE turns SET status = 'failed', completed_at = $timestamp WHERE status = 'running'",
        { $timestamp: timestamp },
      );
      this.database.run(
        "UPDATE provider_sessions SET status = 'failed', updated_at = $timestamp WHERE status = 'running'",
        { $timestamp: timestamp },
      );
      this.database.run(
        `UPDATE turn_groups SET status = 'failed', completed_at = $timestamp
         WHERE status IN ('queued', 'querying', 'reviewing', 'synthesizing')`,
        { $timestamp: timestamp },
      );
    });
  }

  async createTurnGroup(
    conversationId: string,
    type: "council",
    chairman: string,
  ): Promise<string> {
    const id = createId();
    await this.database.transaction(() => {
      this.database.run(
        `INSERT INTO turn_groups(id, conversation_id, type, status, chairman, created_at)
         VALUES ($id, $conversationId, $type, 'queued', $chairman, $createdAt)`,
        {
          $id: id,
          $conversationId: conversationId,
          $type: type,
          $chairman: chairman,
          $createdAt: nowIso(),
        },
      );
    });
    return id;
  }

  async updateTurnGroup(
    turnGroupId: string,
    status:
      | "queued"
      | "querying"
      | "reviewing"
      | "synthesizing"
      | "completed"
      | "degraded"
      | "cancelled"
      | "failed",
  ): Promise<void> {
    const completed = ["completed", "degraded", "cancelled", "failed"].includes(status);
    await this.database.transaction(() => {
      this.database.run(
        `UPDATE turn_groups
         SET status = $status, completed_at = $completedAt
         WHERE id = $id`,
        {
          $status: status,
          $completedAt: completed ? nowIso() : null,
          $id: turnGroupId,
        },
      );
    });
  }

  async createTurnGroupMember(
    turnGroupId: string,
    profileId: ProviderProfileId,
    anonymousLabel: string,
  ): Promise<string> {
    const id = createId();
    await this.database.transaction(() => {
      this.database.run(
        `INSERT INTO turn_group_members(
          id, turn_group_id, profile_id, anonymous_label, status
        ) VALUES ($id, $turnGroupId, $profileId, $label, 'queued')`,
        {
          $id: id,
          $turnGroupId: turnGroupId,
          $profileId: profileId,
          $label: anonymousLabel,
        },
      );
    });
    return id;
  }

  async updateTurnGroupMember(
    memberId: string,
    updates: {
      status: "queued" | "running" | "completed" | "failed" | "cancelled";
      answer?: string | null;
      score?: number | null;
      elapsedMs?: number | null;
    },
  ): Promise<void> {
    const row = this.database.queryOne<{
      answer: string | null;
      score: number | null;
      elapsed_ms: number | null;
    }>("SELECT answer, score, elapsed_ms FROM turn_group_members WHERE id = $id", {
      $id: memberId,
    });
    if (!row) throw new Error("Council member not found.");
    await this.database.transaction(() => {
      this.database.run(
        `UPDATE turn_group_members
         SET status = $status, answer = $answer, score = $score, elapsed_ms = $elapsedMs
         WHERE id = $id`,
        {
          $status: updates.status,
          $answer: updates.answer === undefined ? row.answer : updates.answer,
          $score: updates.score === undefined ? row.score : updates.score,
          $elapsedMs: updates.elapsedMs === undefined ? row.elapsed_ms : updates.elapsedMs,
          $id: memberId,
        },
      );
    });
  }

  async addPeerReview(
    turnGroupId: string,
    reviewerProfileId: ProviderProfileId,
    rankings: unknown,
  ): Promise<void> {
    await this.database.transaction(() => {
      this.database.run(
        `INSERT INTO peer_reviews(
          id, turn_group_id, reviewer_profile_id, rankings_json, created_at
        ) VALUES ($id, $turnGroupId, $reviewerProfileId, $rankings, $createdAt)`,
        {
          $id: createId(),
          $turnGroupId: turnGroupId,
          $reviewerProfileId: reviewerProfileId,
          $rankings: JSON.stringify(rankings),
          $createdAt: nowIso(),
        },
      );
    });
  }

  async addChairmanSynthesis(
    turnGroupId: string,
    chairmanProfileId: ProviderProfileId,
    content: string,
  ): Promise<void> {
    await this.database.transaction(() => {
      this.database.run(
        `INSERT INTO chairman_syntheses(
          id, turn_group_id, chairman_profile_id, content, created_at
        ) VALUES ($id, $turnGroupId, $chairmanProfileId, $content, $createdAt)`,
        {
          $id: createId(),
          $turnGroupId: turnGroupId,
          $chairmanProfileId: chairmanProfileId,
          $content: content,
          $createdAt: nowIso(),
        },
      );
    });
  }

  async appendEvent(
    event: Omit<NormalizedEvent, "id" | "createdAt" | "sequence">,
  ): Promise<NormalizedEvent> {
    let normalized: NormalizedEvent | null = null;
    await this.database.transaction(() => {
      const sequenceRow = this.database.queryOne<{ next_sequence: number }>(
        "SELECT COALESCE(MAX(sequence), -1) + 1 AS next_sequence FROM events WHERE conversation_id = $conversationId",
        { $conversationId: event.conversationId },
      );
      normalized = normalizedEventSchema.parse({
        ...event,
        id: createId(),
        createdAt: nowIso(),
        sequence: sequenceRow?.next_sequence ?? 0,
      });
      this.database.run(
        `INSERT INTO events(
          id, conversation_id, turn_id, provider_session_id, turn_group_id,
          type, created_at, sequence, summary, payload_json
        ) VALUES (
          $id, $conversationId, $turnId, $providerSessionId, $turnGroupId,
          $type, $createdAt, $sequence, $summary, $payload
        )`,
        {
          $id: normalized.id,
          $conversationId: normalized.conversationId,
          $turnId: normalized.turnId,
          $providerSessionId: normalized.providerSessionId,
          $turnGroupId: normalized.turnGroupId,
          $type: normalized.type,
          $createdAt: normalized.createdAt,
          $sequence: normalized.sequence,
          $summary: normalized.summary,
          $payload: JSON.stringify(normalized.payload),
        },
      );
      this.database.run(
        "UPDATE conversations SET updated_at = $updatedAt WHERE id = $id",
        { $updatedAt: normalized.createdAt, $id: normalized.conversationId },
      );
      this.database.run(
        `UPDATE projects SET updated_at = $updatedAt
         WHERE id = (SELECT project_id FROM conversations WHERE id = $conversationId)`,
        { $updatedAt: normalized.createdAt, $conversationId: normalized.conversationId },
      );
    });
    if (!normalized) throw new Error("Event transaction did not produce an event.");
    this.markSearchIndexDirty();
    return normalized;
  }

  listEvents(conversationId: string, limit = 2_000): NormalizedEvent[] {
    return this.database
      .queryAll<EventRow>(
        `SELECT * FROM events
         WHERE conversation_id = $conversationId
         ORDER BY sequence ASC
         LIMIT $limit`,
        { $conversationId: conversationId, $limit: limit },
      )
      .map(mapEvent);
  }

  listConversationSummaryEvents(conversationId: string): {
    events: ConversationSummaryEvent[];
    omitted: boolean;
  } {
    const params = {
      $conversationId: conversationId,
      $window: CONVERSATION_SUMMARY_EVENT_WINDOW,
      $textLimit: CONVERSATION_SUMMARY_TEXT_LIMIT,
    };
    const select = (order: "ASC" | "DESC") => this.database.queryAll<ConversationSummaryEvent>(
      `SELECT sequence, type,
              substr(json_extract(payload_json, '$.text'), 1, $textLimit) AS text,
              length(json_extract(payload_json, '$.text')) AS originalLength
       FROM events
       WHERE conversation_id = $conversationId
         AND type IN ('user.message', 'assistant.final')
         AND typeof(json_extract(payload_json, '$.text')) = 'text'
       ORDER BY sequence ${order}
       LIMIT $window`,
      params,
    );
    const total = this.database.queryOne<{ count: number }>(
      `SELECT COUNT(*) AS count FROM events
       WHERE conversation_id = $conversationId
         AND type IN ('user.message', 'assistant.final')
         AND typeof(json_extract(payload_json, '$.text')) = 'text'`,
      { $conversationId: conversationId },
    )?.count ?? 0;
    const events = [...new Map(
      [...select("ASC"), ...select("DESC")].map((event) => [event.sequence, event]),
    ).values()].sort((left, right) => left.sequence - right.sequence);
    return {
      events,
      omitted: total > events.length
        || events.some((event) => event.originalLength > CONVERSATION_SUMMARY_TEXT_LIMIT),
    };
  }

  listRecentErrors(limit = 20): string[] {
    return this.database
      .queryAll<{ summary: string; payload_json: string }>(
        `SELECT summary, payload_json
         FROM events
         WHERE type = 'error'
         ORDER BY created_at DESC
         LIMIT $limit`,
        { $limit: limit },
      )
      .map((row) => {
       const payload = parseJson<Record<string, unknown>>(row.payload_json, {});
        const message = typeof payload.message === "string" ? `: ${payload.message}` : "";
        return redactEgress(`${row.summary}${message}`).slice(0, 500);
     });
  }

  /**
   * Prune old rows from the whitelisted high-volume tables (events,
   * terminal_events). Rows older than `days` (by created_at) are deleted in a
   * single transaction; failure rolls back. Conversations, projects, sessions,
   * and all other tables are never touched. An audit log entry is written on
   * completion. Returns counts of deleted rows.
   */
  async pruneOldData(opts: { days: number }): Promise<{
    deletedEvents: number;
    deletedTerminalEvents: number;
  }> {
    const cutoff = new Date(Date.now() - opts.days * 86_400_000).toISOString();
    let deletedEvents = 0;
    let deletedTerminalEvents = 0;
    await this.database.transaction(() => {
      const beforeEvents = this.database.queryOne<{ count: number }>(
        "SELECT COUNT(*) AS count FROM events WHERE created_at < $cutoff",
        { $cutoff: cutoff },
      );
      const beforeTerminal = this.database.queryOne<{ count: number }>(
        "SELECT COUNT(*) AS count FROM terminal_events WHERE created_at < $cutoff",
        { $cutoff: cutoff },
      );
      deletedEvents = beforeEvents?.count ?? 0;
      deletedTerminalEvents = beforeTerminal?.count ?? 0;
      this.database.run("DELETE FROM events WHERE created_at < $cutoff", { $cutoff: cutoff });
      this.database.run("DELETE FROM terminal_events WHERE created_at < $cutoff", { $cutoff: cutoff });
    });
    if (deletedEvents > 0 || deletedTerminalEvents > 0) this.markSearchIndexDirty();
    logger.audit("storage", "prune.completed", "Pruned old events and terminal_events", {
      days: opts.days,
      deletedEvents,
      deletedTerminalEvents,
    });
    return { deletedEvents, deletedTerminalEvents };
  }

  /**
   * Enforce the hard rolling caps on terminal_events (TERMINAL_EVENTS_MAX_ROWS,
   * TERMINAL_EVENTS_MAX_PAYLOAD_BYTES), deleting oldest rows until both hold.
   * Unlike pruneOldData this is ALWAYS-on (not tied to retention.pruneOnStart):
   * the caps are the last line of defense against the ledger growing until the
   * whole-DB export stalls every write. The check itself reads the
   * trigger-maintained storage_counters rows (two PK lookups, exact for every
   * write path) — the whole-table COUNT/SUM scan is gone, and a pruning pass
   * only runs when a cap is actually exceeded. Intended triggers are startup
   * and every OVERFLOW_CHECK_EVERY_APPENDS terminal-event appends.
   */
  async pruneTerminalEventsOverflow(
    trigger: string,
    // Test hook: shrink the caps so tests don't have to seed 200k rows.
    caps?: { maxRows?: number; maxPayloadBytes?: number },
  ): Promise<{
    deleted: number;
    remainingRows: number;
    remainingPayloadBytes: number;
  }> {
    const maxRows = caps?.maxRows ?? TERMINAL_EVENTS_MAX_ROWS;
    const maxPayloadBytes = caps?.maxPayloadBytes ?? TERMINAL_EVENTS_MAX_PAYLOAD_BYTES;
    let deleted = 0;
    // Fast path: triggers keep the counters exact, so when both are under cap
    // there is nothing to scan or delete.
    let { rows: remainingRows, payloadBytes: remainingPayloadBytes } = this.terminalEventCounters();
    if (remainingRows > maxRows || remainingPayloadBytes > maxPayloadBytes) {
      await this.database.transaction(() => {
        // Re-read inside the write transaction for a decision consistent with
        // the rows the deletes will see.
        const before = this.terminalEventCounters();
        if (before.rows > maxRows) {
          // Delete exactly the (n - cap) oldest rows in one statement.
          this.database.run(
            `DELETE FROM terminal_events WHERE rowid IN (
               SELECT rowid FROM terminal_events
               ORDER BY created_at ASC, rowid ASC
               LIMIT $excess
             )`,
            { $excess: before.rows - maxRows },
          );
        }
        if (before.payloadBytes > maxPayloadBytes) {
          // Keep the newest rows whose cumulative payload (newest first) fits
          // in the cap; delete everything older. One pass with a window
          // function — only reachable when already known to be over the cap.
          this.database.run(
            `DELETE FROM terminal_events WHERE rowid IN (
               SELECT rowid FROM (
                 SELECT rowid, COALESCE(SUM(LENGTH(payload_json)) OVER (
                   ORDER BY created_at DESC, rowid DESC
                   ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                 ), 0) AS prior_bytes
                 FROM terminal_events
               ) WHERE prior_bytes >= $cap
             )`,
            { $cap: maxPayloadBytes },
          );
        }
        const after = this.terminalEventCounters();
        deleted = before.rows - after.rows;
        remainingRows = after.rows;
        remainingPayloadBytes = after.payloadBytes;
      });
    }
    if (deleted > 0) this.markSearchIndexDirty();
    if (deleted > 0) {
      logger.audit("storage", "prune.overflow", "Pruned terminal_events past rolling caps", {
        trigger,
        deleted,
        remainingRows,
        remainingPayloadBytes,
      });
    }
    return { deleted, remainingRows, remainingPayloadBytes };
  }

  /**
   * Trigger-maintained terminal_events counters (migration 18). Exact for
   * every write path — repository appends, bulk prunes, project cascades,
   * and direct SQL alike — so callers never need a whole-table COUNT/SUM.
   */
  private terminalEventCounters(): { rows: number; payloadBytes: number } {
    const rows = this.database.queryAll<{ key: string; value: number }>(
      "SELECT key, value FROM storage_counters WHERE key IN ('terminal_events.rows', 'terminal_events.payload_bytes')",
    );
    let rowCount = 0;
    let payloadBytes = 0;
    for (const row of rows) {
      if (row.key === "terminal_events.rows") rowCount = row.value;
      else payloadBytes = row.value;
    }
    return { rows: rowCount, payloadBytes };
  }

  /**
   * Rebuild the DB to reclaim pages freed by prune (SQLite DELETE leaves them
   * free-list pages inside the file). ponytail: sql.js VACUUM rewrites the
   * whole in-memory image, so this is startup-only and only after a prune that
   * deleted enough rows to matter — never on the write path.
   */
  async vacuumAfterPrune(deletedRows: number): Promise<void> {
    const startedAt = Date.now();
    this.database.run("VACUUM");
    // Under WAL the rebuilt image lands in -wal; without an explicit
    // checkpoint the main file keeps its old size, which defeats the entire
    // purpose of vacuuming. TRUNCATE also collapses the sidecar.
    this.database.queryAll("PRAGMA wal_checkpoint(TRUNCATE)");
    await this.database.persist();
    logger.audit("storage", "prune.vacuum", "Vacuumed database after prune", {
      deletedRows,
      elapsedMs: Date.now() - startedAt,
    });
  }

  getSettings(): AppSettings {
    const row = this.database.queryOne<{ value_json: string }>(
      "SELECT value_json FROM settings WHERE key = 'app'",
    );
    return row ? parseSettingsSafely(row.value_json) : defaultSettings;
  }

  async setSettings(settings: AppSettings): Promise<AppSettings> {
    const parsed = normalizeSettings(appSettingsSchema.parse(settings));
    await this.database.transaction(() => {
      this.database.run(
        `INSERT INTO settings(key, value_json, updated_at)
         VALUES ('app', $value, $updatedAt)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        { $value: JSON.stringify(parsed), $updatedAt: nowIso() },
      );
    });
    this.applySearchIndexEnabled(parsed.searchIndexEnabled);
    return parsed;
  }

  // #60 patch semantics: absent fields keep the stored value; explicit
  // ""/false/null/[] clear. Read, merge, full-validate and write happen in a
  // single transaction so consecutive patches cannot clobber each other.
  async updateSettings(patch: unknown): Promise<AppSettings> {
    const parsedPatch = appSettingsPatchSchema.parse(patch);
    let saved: AppSettings = defaultSettings;
    await this.database.transaction(() => {
      const row = this.database.queryOne<{ value_json: string }>(
        "SELECT value_json FROM settings WHERE key = 'app'",
      );
      const current = row ? parseSettingsSafely(row.value_json) : defaultSettings;
      const merged = mergeAppSettingsPatch(current, parsedPatch);
      saved = normalizeSettings(appSettingsSchema.parse(merged));
      this.database.run(
        `INSERT INTO settings(key, value_json, updated_at)
         VALUES ('app', $value, $updatedAt)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        { $value: JSON.stringify(saved), $updatedAt: nowIso() },
      );
    });
    this.applySearchIndexEnabled(saved.searchIndexEnabled);
    return saved;
  }

  async addAttachment(
    conversationId: string,
    name: string,
    mimeType: string,
    localPath: string,
    size: number,
  ): Promise<Attachment> {
    const attachment = attachmentSchema.parse({
      id: createId(),
      conversationId,
      name,
      mimeType,
      localPath,
      size,
      createdAt: nowIso(),
    });
    await this.database.transaction(() => {
      this.database.run(
        `INSERT INTO attachments(
          id, conversation_id, name, mime_type, local_path, size, created_at
        ) VALUES ($id, $conversationId, $name, $mimeType, $localPath, $size, $createdAt)`,
        {
          $id: attachment.id,
          $conversationId: attachment.conversationId,
          $name: attachment.name,
          $mimeType: attachment.mimeType,
          $localPath: attachment.localPath,
          $size: attachment.size,
          $createdAt: attachment.createdAt,
        },
      );
    });
    this.markSearchIndexDirty();
    return attachment;
  }

  listAttachments(conversationId: string): Attachment[] {
    return this.database
      .queryAll<{
        id: string;
        conversation_id: string;
        name: string;
        mime_type: string;
        local_path: string;
        size: number;
        created_at: string;
      }>(
        "SELECT * FROM attachments WHERE conversation_id = $conversationId ORDER BY created_at ASC",
        { $conversationId: conversationId },
      )
      .map((row) =>
        attachmentSchema.parse({
          id: row.id,
          conversationId: row.conversation_id,
          name: row.name,
          mimeType: row.mime_type,
          localPath: row.local_path,
          size: row.size,
          createdAt: row.created_at,
        }),
      );
  }

  async deleteAttachment(attachmentId: string): Promise<string | null> {
    const row = this.database.queryOne<{ local_path: string }>(
      "SELECT local_path FROM attachments WHERE id = $id",
      { $id: attachmentId },
    );
    if (!row) return null;
    await this.database.transaction(() => {
      this.database.run("DELETE FROM attachments WHERE id = $id", { $id: attachmentId });
    });
    this.markSearchIndexDirty();
    return row.local_path;
  }

  getAttachmentPaths(conversationId: string, attachmentIds: string[]): string[] {
    if (attachmentIds.length === 0) return [];
    if (new Set(attachmentIds).size !== attachmentIds.length) {
      throw new Error("Attachment selection is invalid.");
    }
    const placeholders = attachmentIds.map((_, index) => `$id${index}`).join(", ");
    const params = {
      $conversationId: conversationId,
      ...Object.fromEntries(attachmentIds.map((id, index) => [`$id${index}`, id])),
    };
    const rows = this.database.queryAll<{ id: string; local_path: string }>(
      `SELECT id, local_path FROM attachments
       WHERE conversation_id = $conversationId AND id IN (${placeholders})`,
      params,
    );
    const paths = new Map(rows.map((row) => [row.id, row.local_path]));
    return attachmentIds.map((id) => {
      const path = paths.get(id);
      if (path === undefined) throw new Error("Attachment selection is invalid.");
      return path;
    });
  }

  async addHandoff(
    conversationId: string,
    sourceProfile: ProviderProfileId,
    targetProfile: ProviderProfileId,
    packet: unknown,
  ): Promise<void> {
    await this.database.transaction(() => {
      this.database.run(
        `INSERT INTO handoffs(
          id, conversation_id, source_profile, target_profile, packet_json, created_at
        ) VALUES ($id, $conversationId, $source, $target, $packet, $createdAt)`,
        {
          $id: createId(),
          $conversationId: conversationId,
          $source: sourceProfile,
          $target: targetProfile,
          $packet: JSON.stringify(packet),
          $createdAt: nowIso(),
        },
      );
    });
    this.markSearchIndexDirty();
  }

  getTerminalHandoff(
    sourceSessionHash: string,
    idempotencyHash: string,
  ): {
    ledgerId: string;
    requestFingerprint: string;
    packet: TerminalHandoffPacket;
    provenance: {
      source: TerminalHandoffPacket["source"];
      summarizerProfile: "claude-local-main" | "claude-local-long" | "deterministic";
      inputBytes: number;
      packetBytes: number;
      tokenEstimate: number;
      createdAt: string;
    };
  } | null {
    const row = this.database.queryOne<TerminalHandoffRow>(
      `SELECT id, request_fingerprint, packet_json, source_kind, summarizer_profile, input_bytes,
              packet_bytes, token_estimate, created_at
       FROM terminal_handoffs
       WHERE source_session_hash = $sourceSessionHash
         AND idempotency_key = $idempotencyHash`,
      { $sourceSessionHash: sourceSessionHash, $idempotencyHash: idempotencyHash },
    );
    if (!row) return null;
    return {
      ledgerId: row.id,
      requestFingerprint: row.request_fingerprint,
      packet: terminalHandoffPacketSchema.parse(JSON.parse(row.packet_json)),
      provenance: {
        source: row.source_kind,
        summarizerProfile: row.summarizer_profile,
        inputBytes: row.input_bytes,
        packetBytes: row.packet_bytes,
        tokenEstimate: row.token_estimate,
        createdAt: row.created_at,
      },
    };
  }

  async addTerminalHandoff(input: {
    sourceSessionHash: string;
    idempotencyHash: string;
    requestFingerprint: string;
    packet: TerminalHandoffPacket;
    summarizerProfile: "claude-local-main" | "claude-local-long" | "deterministic";
    inputBytes: number;
    packetBytes: number;
    tokenEstimate: number;
  }): Promise<ReturnType<Repository["getTerminalHandoff"]>> {
    // Defence in depth at the persistence boundary: even a future caller that
    // forgets the service's post-redaction cannot put raw egress in this table.
    const packet = terminalHandoffPacketSchema.parse(redactEgressValue(input.packet));
    const packetJson = JSON.stringify(packet);
    await this.database.transaction(() => {
      this.database.run(
        `INSERT OR IGNORE INTO terminal_handoffs(
          id, source_session_hash, idempotency_key, request_fingerprint, packet_json, source_kind,
          summarizer_profile, input_bytes, packet_bytes, token_estimate, created_at
        ) VALUES (
          $id, $sourceSessionHash, $idempotencyHash, $requestFingerprint, $packet, $sourceKind,
          $summarizerProfile, $inputBytes, $packetBytes, $tokenEstimate, $createdAt
        )`,
        {
          $id: createId(),
          $sourceSessionHash: input.sourceSessionHash,
          $idempotencyHash: input.idempotencyHash,
          $requestFingerprint: input.requestFingerprint,
          $packet: packetJson,
          $sourceKind: packet.source,
          $summarizerProfile: input.summarizerProfile,
          $inputBytes: input.inputBytes,
          $packetBytes: Buffer.byteLength(packetJson, "utf8"),
          $tokenEstimate: input.tokenEstimate,
          $createdAt: nowIso(),
        },
      );
    });
    return this.getTerminalHandoff(input.sourceSessionHash, input.idempotencyHash);
  }

  // --- AgentApi fixed orchestrator ledger (issue #6) ------------------------

  async createAgentApiWorkflow(input: AgentApiWorkflowCreate): Promise<AgentApiWorkflow> {
    const id = createId();
    const createdAt = nowIso();
    await this.database.transaction(() => {
      this.database.run(
        `INSERT OR IGNORE INTO agentapi_workflows(
          id, project_id, task, idempotency_key, branch, base_ref,
          implementer, reviewer, state, resume_state, review_loop,
          worktree_id, worktree_path, terminal_id, session_id, handoff_id,
          last_outcome_json, revision, created_at, updated_at, started_at, completed_at
        ) VALUES (
          $id, $projectId, $task, $key, $branch, $baseRef,
          'claude-local-main', 'codex-local-main', 'queued', NULL, 0,
          NULL, NULL, NULL, NULL, NULL, NULL, 0, $createdAt, $createdAt, NULL, NULL
        )`,
        {
          $id: id,
          $projectId: input.projectId,
          $task: input.task,
          $key: input.idempotencyKey,
          $branch: input.branch ?? null,
          $baseRef: input.baseRef ?? null,
          $createdAt: createdAt,
        },
      );
    });
    const workflow = this.getAgentApiWorkflowByIdempotencyKey(input.idempotencyKey);
    if (!workflow) throw new Error("AgentApi workflow ledger insert failed.");
    if (
      workflow.projectId !== input.projectId
      || workflow.task !== input.task
      || workflow.branch !== (input.branch ?? null)
      || workflow.baseRef !== (input.baseRef ?? null)
      || workflow.implementer !== input.implementer
      || workflow.reviewer !== input.reviewer
    ) {
      throw new Error("AgentApi idempotency key was already used for a different request.");
    }
    return workflow;
  }

  getAgentApiWorkflow(id: string): AgentApiWorkflow | null {
    const row = this.database.queryOne<AgentApiWorkflowRow>(
      "SELECT * FROM agentapi_workflows WHERE id = $id",
      { $id: id },
    );
    return row ? mapAgentApiWorkflow(row) : null;
  }

  getAgentApiWorkflowByIdempotencyKey(key: string): AgentApiWorkflow | null {
    const row = this.database.queryOne<AgentApiWorkflowRow>(
      "SELECT * FROM agentapi_workflows WHERE idempotency_key = $key",
      { $key: key },
    );
    return row ? mapAgentApiWorkflow(row) : null;
  }

  listRecoverableAgentApiWorkflows(): AgentApiWorkflow[] {
    return this.database.queryAll<AgentApiWorkflowRow>(
      `SELECT * FROM agentapi_workflows
       WHERE state NOT IN ('ready_for_human_review','canceled')
       ORDER BY created_at`,
    ).map(mapAgentApiWorkflow);
  }

  async saveAgentApiWorkflow(next: AgentApiWorkflow, expectedRevision: number): Promise<AgentApiWorkflow> {
    const parsed = agentapiWorkflowSchema.parse(next);
    const updatedAt = nowIso();
    await this.database.transaction(() => {
      this.database.run(
        `UPDATE agentapi_workflows SET
          state=$state, resume_state=$resumeState, review_loop=$reviewLoop,
          worktree_id=$worktreeId, worktree_path=$worktreePath,
          terminal_id=$terminalId, session_id=$sessionId, handoff_id=$handoffId,
          last_outcome_json=$outcome, revision=revision+1, updated_at=$updatedAt,
          started_at=$startedAt, completed_at=$completedAt
         WHERE id=$id AND revision=$expectedRevision`,
        {
          $state: parsed.state,
          $resumeState: parsed.resumeState,
          $reviewLoop: parsed.reviewLoop,
          $worktreeId: parsed.worktreeId,
          $worktreePath: parsed.worktreePath,
          $terminalId: parsed.terminalId,
          $sessionId: parsed.sessionId,
          $handoffId: parsed.handoffId,
          $outcome: parsed.lastOutcome ? JSON.stringify(agentapiWorkflowOutcomeSchema.parse(parsed.lastOutcome)) : null,
          $updatedAt: updatedAt,
          $startedAt: parsed.startedAt,
          $completedAt: parsed.completedAt,
          $id: parsed.id,
          $expectedRevision: expectedRevision,
        },
      );
      const changes = this.database.queryOne<{ count: number }>("SELECT changes() AS count")?.count ?? 0;
      if (changes !== 1) throw new Error("AgentApi workflow revision conflict.");
    });
    const saved = this.getAgentApiWorkflow(parsed.id);
    if (!saved) throw new Error("AgentApi workflow disappeared after update.");
    return saved;
  }

  async createAgentApiStep(input: {
    workflowId: string;
    kind: AgentApiStepKind;
    attempt: number;
    idempotencyKey: string;
    status?: AgentApiStepStatus;
    terminalId?: string | null;
    sessionId?: string | null;
  }): Promise<AgentApiWorkflowStep> {
    const id = createId();
    const createdAt = nowIso();
    await this.database.transaction(() => {
      this.database.run(
        `INSERT OR IGNORE INTO agentapi_workflow_steps(
          id, workflow_id, kind, attempt, idempotency_key, status,
          terminal_id, session_id, handoff_id, outcome_json,
          revision, created_at, started_at, completed_at
        ) VALUES (
          $id, $workflowId, $kind, $attempt, $key, $status,
          $terminalId, $sessionId, NULL, NULL, 0, $createdAt, $createdAt, NULL
        )`,
        {
          $id: id,
          $workflowId: input.workflowId,
          $kind: input.kind,
          $attempt: input.attempt,
          $key: input.idempotencyKey,
          $status: input.status ?? "pending",
          $terminalId: input.terminalId ?? null,
          $sessionId: input.sessionId ?? null,
          $createdAt: createdAt,
        },
      );
    });
    const step = this.getAgentApiStepByKey(input.idempotencyKey);
    if (!step) throw new Error("AgentApi step ledger insert failed.");
    if (step.workflowId !== input.workflowId || step.kind !== input.kind || step.attempt !== input.attempt) {
      throw new Error("AgentApi step idempotency key collision.");
    }
    return step;
  }

  getAgentApiStepByKey(key: string): AgentApiWorkflowStep | null {
    const row = this.database.queryOne<AgentApiWorkflowStepRow>(
      "SELECT * FROM agentapi_workflow_steps WHERE idempotency_key = $key",
      { $key: key },
    );
    return row ? mapAgentApiStep(row) : null;
  }

  listAgentApiSteps(workflowId: string): AgentApiWorkflowStep[] {
    return this.database.queryAll<AgentApiWorkflowStepRow>(
      "SELECT * FROM agentapi_workflow_steps WHERE workflow_id=$workflowId ORDER BY created_at, id",
      { $workflowId: workflowId },
    ).map(mapAgentApiStep);
  }

  async saveAgentApiStep(next: AgentApiWorkflowStep, expectedRevision: number): Promise<AgentApiWorkflowStep> {
    const parsed = agentapiWorkflowStepSchema.parse(next);
    await this.database.transaction(() => {
      this.database.run(
        `UPDATE agentapi_workflow_steps SET
          status=$status, terminal_id=$terminalId, session_id=$sessionId,
          handoff_id=$handoffId, outcome_json=$outcome,
          revision=revision+1, started_at=$startedAt, completed_at=$completedAt
         WHERE id=$id AND revision=$expectedRevision`,
        {
          $status: parsed.status,
          $terminalId: parsed.terminalId,
          $sessionId: parsed.sessionId,
          $handoffId: parsed.handoffId,
          $outcome: parsed.outcome ? JSON.stringify(agentapiWorkflowOutcomeSchema.parse(parsed.outcome)) : null,
          $startedAt: parsed.startedAt,
          $completedAt: parsed.completedAt,
          $id: parsed.id,
          $expectedRevision: expectedRevision,
        },
      );
      const changes = this.database.queryOne<{ count: number }>("SELECT changes() AS count")?.count ?? 0;
      if (changes !== 1) throw new Error("AgentApi step revision conflict.");
    });
    const row = this.database.queryOne<AgentApiWorkflowStepRow>(
      "SELECT * FROM agentapi_workflow_steps WHERE id=$id",
      { $id: parsed.id },
    );
    if (!row) throw new Error("AgentApi step disappeared after update.");
    return mapAgentApiStep(row);
  }

  loadTerminalWorkspace(projectId: string): {
    split: "single" | "vertical" | "horizontal" | "grid";
    activeIndex: number | null;
    secondaryIndex: number | null;
    panes: Array<{
      profile: "powershell" | "cmd" | "wsl" | "pwsh" | "zsh" | "bash";
      title: string;
      cwd: string;
      cols: number;
      rows: number;
      scrollback: string;
      startedAt: string | null;
      closedAt: string | null;
      lastExitCode: number | null;
      isAgent: boolean;
      agentProfile: string | null;
    }>;
  } | null {
    const workspace = this.database.queryOne<{ layout_json: string }>(
      "SELECT layout_json FROM terminal_workspaces WHERE project_id = $projectId",
      { $projectId: projectId },
    );
    if (!workspace) return null;
    const layout = JSON.parse(workspace.layout_json) as {
      split?: "single" | "vertical" | "horizontal" | "grid";
      activeIndex?: number | null;
      secondaryIndex?: number | null;
    };
    const panes = this.database.queryAll<{
      profile: "powershell" | "cmd" | "wsl" | "pwsh" | "zsh" | "bash";
      title: string;
      cwd: string;
      cols: number;
      rows: number;
      scrollback: string;
      started_at: string | null;
      closed_at: string | null;
      last_exit_code: number | null;
      is_agent: number;
      agent_profile: string | null;
    }>(
      `SELECT profile, title, cwd, cols, rows, scrollback,
              started_at, closed_at, last_exit_code, is_agent, agent_profile
       FROM terminal_panes WHERE project_id = $projectId ORDER BY position ASC`,
      { $projectId: projectId },
    ).map((pane) => ({
      profile: pane.profile,
      title: pane.title,
      cwd: pane.cwd,
      cols: pane.cols,
      rows: pane.rows,
      scrollback: pane.scrollback,
      startedAt: pane.started_at,
      closedAt: pane.closed_at,
      lastExitCode: pane.last_exit_code,
      isAgent: Boolean(pane.is_agent),
      agentProfile: pane.agent_profile,
    }));
    return {
      split: layout.split ?? "single",
      activeIndex: layout.activeIndex ?? null,
      secondaryIndex: layout.secondaryIndex ?? null,
      panes,
    };
  }

  async saveTerminalWorkspace(
    projectId: string,
    layout: {
      split: "single" | "vertical" | "horizontal" | "grid";
      activeIndex: number | null;
      secondaryIndex: number | null;
    },
    panes: Array<{
      id: string;
      profile: "powershell" | "cmd" | "wsl" | "pwsh" | "zsh" | "bash";
      title: string;
      cwd: string;
      cols: number;
      rows: number;
      scrollback: string;
      startedAt?: string | null;
      closedAt?: string | null;
      lastExitCode?: number | null;
      isAgent?: boolean;
      agentProfile?: string | null;
    }>,
  ): Promise<void> {
    await this.database.transaction(() => {
      this.database.run(
        `INSERT INTO terminal_workspaces(project_id, layout_json, updated_at)
         VALUES ($projectId, $layout, $updatedAt)
         ON CONFLICT(project_id) DO UPDATE SET
           layout_json = excluded.layout_json,
           updated_at = excluded.updated_at`,
        {
          $projectId: projectId,
          $layout: JSON.stringify(layout),
          $updatedAt: nowIso(),
        },
      );
      this.database.run("DELETE FROM terminal_panes WHERE project_id = $projectId", {
        $projectId: projectId,
      });
      for (const [position, pane] of panes.entries()) {
        this.database.run(
          `INSERT INTO terminal_panes(
            id, project_id, profile, title, cwd, cols, rows, scrollback, updated_at, position,
            started_at, closed_at, last_exit_code, is_agent, agent_profile
          ) VALUES (
            $id, $projectId, $profile, $title, $cwd, $cols, $rows, $scrollback, $updatedAt, $position,
            $startedAt, $closedAt, $lastExitCode, $isAgent, $agentProfile
          )`,
          {
            $id: pane.id,
            $projectId: projectId,
            $profile: pane.profile,
           $title: pane.title,
            $cwd: redactEgress(pane.cwd),
           $cols: pane.cols,
           $rows: pane.rows,
            $scrollback: redactEgress(pane.scrollback).slice(-250_000),
           $updatedAt: nowIso(),
            $position: position,
            $startedAt: pane.startedAt ?? null,
            $closedAt: pane.closedAt ?? null,
            $lastExitCode: pane.lastExitCode ?? null,
            $isAgent: pane.isAgent ? 1 : 0,
            $agentProfile: pane.agentProfile ?? null,
          },
       );
     }
   });
    logger.info("audit", "terminal.workspace.saved", "Terminal workspace persisted", {
      projectId,
      terminalId: null,
      paneCount: panes.length,
    });
 }

  async appendTerminalEvent(input: {
    projectId: string;
    terminalId: string;
    type: "terminal.session.started" | "terminal.output" | "terminal.session.closed" | "terminal.command.finished";
    summary: string;
    payload?: Record<string, unknown>;
  }): Promise<TerminalLedgerEvent> {
    let saved: TerminalLedgerEvent | null = null;
    await this.database.transaction(() => {
      const sequenceRow = this.database.queryOne<{ next_sequence: number }>(
        "SELECT COALESCE(MAX(sequence), -1) + 1 AS next_sequence FROM terminal_events WHERE terminal_id = $terminalId",
        { $terminalId: input.terminalId },
      );
      const createdAt = nowIso();
      const payload = sanitizeTerminalPayload(input.payload ?? {});
      const payloadJson = JSON.stringify(payload);
      saved = {
        id: createId(),
        projectId: input.projectId,
        terminalId: input.terminalId,
        type: input.type,
        createdAt,
       sequence: sequenceRow?.next_sequence ?? 0,
        summary: redactEgress(input.summary).slice(0, 1_000),
       payload,
      };
      logger.info("audit", "terminal.event.appended", "Terminal event appended", {
        projectId: saved.projectId,
        terminalId: saved.terminalId,
        type: saved.type,
      });
      this.database.run(
        `INSERT INTO terminal_events(
          id, project_id, terminal_id, type, created_at, sequence, summary, payload_json
        ) VALUES (
          $id, $projectId, $terminalId, $type, $createdAt, $sequence, $summary, $payload
        )`,
        {
          $id: saved.id,
          $projectId: saved.projectId,
          $terminalId: saved.terminalId,
          $type: saved.type,
          $createdAt: saved.createdAt,
          $sequence: saved.sequence,
          $summary: saved.summary,
          $payload: payloadJson,
        },
      );
    });
   if (!saved) throw new Error("Terminal event transaction did not produce an event.");
   this.markSearchIndexDirty();
   this.appendsSinceOverflowCheck += 1;
   if (this.appendsSinceOverflowCheck >= OVERFLOW_CHECK_EVERY_APPENDS) {
     this.appendsSinceOverflowCheck = 0;
     await this.pruneTerminalEventsOverflow("append");
   }
   return saved;
  }

  listRecentTerminalEvents(projectId: string, limit = 80): TerminalLedgerEvent[] {
    return this.database
      .queryAll<TerminalEventRow>(
        `SELECT * FROM terminal_events
         WHERE project_id = $projectId
         ORDER BY created_at DESC
         LIMIT $limit`,
        { $projectId: projectId, $limit: limit },
      )
      .reverse()
      .map((row) => ({
        id: row.id,
        projectId: row.project_id,
        terminalId: row.terminal_id,
        type: row.type,
        createdAt: row.created_at,
        sequence: row.sequence,
        summary: row.summary,
        payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
      }));
  }

  search(input: GlobalSearchInput): GlobalSearchResult[] {
    const startedAt = Date.now();
    const terms = input.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    if (!this.searchIndexBuildAllowed()) return [];
    try {
      const index = this.getSearchIndex();
      this.searchIndexSyncEnabled = true;
      // Never refresh the ledger index on the query hot path. Searches read
      // the latest completed sidecar snapshot while a coalesced refresh runs
      // later on the event loop.
      this.scheduleSearchIndexSync(0);
      const results: GlobalSearchResult[] = [];
      for (const hit of index.search(terms, 200)) {
        if (results.length >= input.limit) break;
        // The sidecar index is a cache: ledger deletions (conversation cascade,
        // archive, retention prune) are not synced, so verify each hit still
        // exists (and is visible) before returning it.
        if (!this.searchEntityExists(hit.kind, hit.id)) continue;
        results.push({
          id: hit.id,
          kind: hit.kind,
          title: hit.title,
          snippet: snippet(hit.body, terms[0] ?? ""),
          projectId: hit.projectId,
          conversationId: hit.conversationId,
          terminalId: hit.terminalId,
          nativeSessionId: null,
          projectName: null,
          updatedAt: null,
        });
      }
      logger.debug("storage", "search.query.completed", "Global search query completed", {
        queryLength: input.query.length,
        termCount: terms.length,
        resultCount: results.length,
        elapsedMs: Date.now() - startedAt,
        indexSyncing: this.searchIndexSyncRunning || this.searchIndexSyncScheduled,
        indexDirty: this.searchIndexDirty,
      });
      return results;
    } catch (error) {
      logger.warn("storage", "search.failed", "Global search failed", {
        projectId: null,
        terminalId: null,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private getSearchIndex(): LedgerSearchIndex {
    if (!this.ledgerSearchIndex) {
      this.ledgerSearchIndex = new LedgerSearchIndex(`${this.database.path}.search-index.sqlite`);
    }
    return this.ledgerSearchIndex;
  }

  /** Release worker and FTS handles before the source database is closed. */
  async closeSearchIndex(): Promise<void> {
    this.searchIndexClosed = true;
    this.searchIndexSyncEnabled = false;
    this.searchIndexDirty = false;
    if (this.searchIndexSyncTimer) clearTimeout(this.searchIndexSyncTimer);
    this.searchIndexSyncTimer = null;
    this.searchIndexSyncScheduled = false;
    this.ledgerSearchIndex?.close();
    this.ledgerSearchIndex = null;
    await this.searchIndexWorker.close();
  }

  /** Prime/refresh the disposable search sidecar without blocking a query. */
  requestSearchIndexSync(): void {
    if (!this.searchIndexBuildAllowed()) return;
    this.searchIndexSyncEnabled = true;
    this.scheduleSearchIndexSync(0);
  }

  /** 落地設定開關：關閉時讓 sidecar 排程靜默退役；重開時標記 dirty 觸發一次重建。 */
  private applySearchIndexEnabled(enabled: boolean): void {
    this.searchIndexBuildEnabled = enabled;
    if (!enabled) {
      this.searchIndexSyncEnabled = false;
      this.searchIndexDirty = false;
      if (this.searchIndexSyncTimer) clearTimeout(this.searchIndexSyncTimer);
      this.searchIndexSyncTimer = null;
      this.searchIndexSyncScheduled = false;
    } else if (!this.searchIndexClosed) {
      // Marks were suppressed while disabled, so nothing would ever schedule a
      // rebuild after the switch turns back on without this.
      this.searchIndexDirty = true;
    }
  }

  private searchIndexBuildAllowed(): boolean {
    if (this.searchIndexBuildEnabled === null) {
      // The boot timer (main/index.ts, +3s) can fire before any setSettings call,
      // so the stored value is read here instead of at construction.
      const row = this.database.queryOne<{ value_json: string }>(
        "SELECT value_json FROM settings WHERE key = 'app'",
      );
      this.searchIndexBuildEnabled = row ? (parseSettingsSafely(row.value_json).searchIndexEnabled ?? true) : true;
    }
    return this.searchIndexBuildEnabled;
  }

  searchIndexStatus(): { syncing: boolean; dirty: boolean } {
    return {
      syncing: this.searchIndexSyncRunning || this.searchIndexSyncScheduled,
      dirty: this.searchIndexDirty,
    };
  }

  private markSearchIndexDirty(): void {
    if (this.searchIndexClosed || !this.searchIndexBuildAllowed()) return;
    this.searchIndexDirty = true;
    // Mutation bursts (PTY/event writes) keep pushing this idle refresh out;
    // once writes settle for 500ms, the sidecar catches up in the background.
    if (this.searchIndexSyncEnabled) this.scheduleSearchIndexSync(500);
  }

  private scheduleSearchIndexSync(delayMs: number): void {
    if (this.searchIndexClosed || !this.searchIndexDirty || this.searchIndexSyncRunning) return;
    // Trailing debounce for mutation bursts, but a real query/request with
    // delay=0 may promote an already-scheduled idle refresh to the next turn.
    if (this.searchIndexSyncScheduled && this.searchIndexSyncTimer) {
      clearTimeout(this.searchIndexSyncTimer);
      this.searchIndexSyncTimer = null;
      this.searchIndexSyncScheduled = false;
    }
    this.searchIndexSyncScheduled = true;
    this.searchIndexSyncTimer = setTimeout(() => {
      this.searchIndexSyncTimer = null;
      this.searchIndexSyncScheduled = false;
      if (this.searchIndexClosed || !this.searchIndexDirty || this.searchIndexSyncRunning) return;
      this.searchIndexSyncRunning = true;
      this.searchIndexDirty = false;
      const startedAt = Date.now();
      void this.searchIndexWorker.sync(this.database.path, `${this.database.path}.search-index.sqlite`).then(
        (workerElapsedMs) => {
        logger.debug("storage", "search.index.sync.completed", "Global search index refresh completed", {
          elapsedMs: Date.now() - startedAt,
          workerElapsedMs,
        });
        },
        (error: unknown) => {
        if (!this.searchIndexClosed) {
          this.searchIndexDirty = true;
          logger.warn("storage", "search.index.sync.failed", "Global search index refresh failed", {
            elapsedMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        },
      ).finally(() => {
        this.searchIndexSyncRunning = false;
        if (!this.searchIndexClosed && this.searchIndexDirty) this.scheduleSearchIndexSync(250);
      });
    }, Math.max(0, delayMs));
    this.searchIndexSyncTimer.unref?.();
  }

  private searchEntityExists(kind: LedgerSearchKind, id: string): boolean {
    switch (kind) {
      case "project":
        return this.database.queryOne("SELECT 1 AS ok FROM projects WHERE id = $id AND archived = 0", { $id: id }) !== null;
      case "conversation":
        return this.database.queryOne(
          `SELECT 1 AS ok FROM conversations c JOIN projects p ON p.id = c.project_id
           WHERE c.id = $id AND c.archived = 0 AND p.archived = 0`,
          { $id: id },
        ) !== null;
      case "event":
        return this.database.queryOne("SELECT 1 AS ok FROM events WHERE id = $id", { $id: id }) !== null;
      case "terminal":
        return this.database.queryOne("SELECT 1 AS ok FROM terminal_events WHERE id = $id", { $id: id }) !== null;
      case "handoff":
        return this.database.queryOne("SELECT 1 AS ok FROM handoffs WHERE id = $id", { $id: id }) !== null;
      case "artifact":
        return this.database.queryOne("SELECT 1 AS ok FROM attachments WHERE id = $id", { $id: id }) !== null;
    }
  }
}

function mapProject(row: ProjectRow): Project {
  return projectSchema.parse({
    id: row.id,
    name: row.name,
    workspacePath: row.workspace_path,
    pinned: Boolean(row.pinned),
    order: row.project_order,
    archived: Boolean(row.archived),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapAgentApiWorkflow(row: AgentApiWorkflowRow): AgentApiWorkflow {
  return agentapiWorkflowSchema.parse({
    id: row.id,
    projectId: row.project_id,
    task: row.task,
    idempotencyKey: row.idempotency_key,
    branch: row.branch,
    baseRef: row.base_ref,
    implementer: row.implementer,
    reviewer: row.reviewer,
    state: row.state,
    resumeState: row.resume_state,
    reviewLoop: row.review_loop,
    worktreeId: row.worktree_id,
    worktreePath: row.worktree_path,
    terminalId: row.terminal_id,
    sessionId: row.session_id,
    handoffId: row.handoff_id,
    lastOutcome: row.last_outcome_json
      ? agentapiWorkflowOutcomeSchema.parse(parseJson<unknown>(row.last_outcome_json, null))
      : null,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  });
}

function mapAgentApiStep(row: AgentApiWorkflowStepRow): AgentApiWorkflowStep {
  return agentapiWorkflowStepSchema.parse({
    id: row.id,
    workflowId: row.workflow_id,
    kind: row.kind,
    attempt: row.attempt,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    terminalId: row.terminal_id,
    sessionId: row.session_id,
    handoffId: row.handoff_id,
    outcome: row.outcome_json
      ? agentapiWorkflowOutcomeSchema.parse(parseJson<unknown>(row.outcome_json, null))
      : null,
    revision: row.revision,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  });
}

function mapWorktree(row: WorktreeRow): Worktree {
  return worktreeSchema.parse({
    id: row.id,
    projectId: row.project_id,
    branch: row.branch,
    worktreePath: row.worktree_path,
    baseRef: row.base_ref,
    status: row.status,
    nativeSessionId: row.native_session_id,
    resumeCommand: row.resume_command,
    prUrl: row.pr_url,
    permissionsPreset: row.permissions_preset,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  });
}

function mapCheckpoint(row: CheckpointRow): Checkpoint {
  return checkpointSchema.parse({
    id: row.id,
    turnId: row.turn_id,
    conversationId: row.conversation_id,
    projectId: row.project_id,
    worktreeId: row.worktree_id,
    phase: row.phase,
    kind: row.kind,
    status: row.status,
    ref: row.ref,
    snapshotPath: row.snapshot_path,
    workspaceFingerprint: row.workspace_fingerprint,
    fileCount: row.file_count,
    sizeBytes: row.size_bytes,
    partial: Boolean(row.partial),
    createdAt: row.created_at,
    finalizedAt: row.finalized_at,
  });
}

function mapCheckpointRestore(row: CheckpointRestoreRow): CheckpointRestoreRecord {
  return checkpointRestoreRecordSchema.parse({
    id: row.id,
    checkpointId: row.checkpoint_id,
    turnId: row.turn_id,
    conversationId: row.conversation_id,
    projectId: row.project_id,
    worktreeId: row.worktree_id,
    status: row.status,
    reason: row.reason,
    createdAt: row.created_at,
  });
}

function mapConversation(row: ConversationRow): Conversation {
  return conversationSchema.parse({
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    activeProvider: row.active_provider,
    primaryProvider: row.primary_provider ?? row.active_provider,
    claudeModel: row.claude_model,
    continuedFromConversationId: row.continued_from_conversation_id ?? null,
    handoffSourceConversationId: row.handoff_source_conversation_id ?? null,
    archived: Boolean(row.archived),
    summary: row.summary_json ? parseSummarySafely(row.summary_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapProviderSession(row: ProviderSessionRow): ProviderSession {
  return providerSessionSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    profileId: row.profile_id,
    nativeSessionId: row.native_session_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapProjectHistorySession(row: ProjectHistorySessionRow) {
  return projectHistorySessionSchema.parse({
    source: "coterm",
    providerSessionId: row.id,
    conversationId: row.conversation_id,
    projectId: row.project_id,
    conversationName: row.conversation_name,
    profileId: row.profile_id,
    nativeSessionId: row.native_session_id,
    historyKey: null,
    sizeBytes: null,
    status: row.status,
    summary: row.summary_json ? parseSummarySafely(row.summary_json) : null,
    conversationUpdatedAt: row.conversation_updated_at,
    sessionUpdatedAt: row.updated_at,
  });
}

function mapEvent(row: EventRow): NormalizedEvent {
  return normalizedEventSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    providerSessionId: row.provider_session_id,
    turnGroupId: row.turn_group_id,
    type: row.type,
    createdAt: row.created_at,
    sequence: row.sequence,
    summary: row.summary,
    payload: parseJson<Record<string, unknown>>(row.payload_json, { _corrupted: true }),
  });
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseSummarySafely(raw: string): ConversationSummary | null {
  try {
    return conversationSummarySchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function parseSettingsSafely(raw: string): AppSettings {
  try {
    return normalizeSettings(appSettingsSchema.parse(JSON.parse(raw)));
  } catch {
    return defaultSettings;
  }
}

function normalizeSettings(settings: AppSettings): AppSettings {
  return { ...settings, defaultShell: defaultShellForPlatform() };
}

/** Platform-aware default shell. Windows-first: win32 resolves to "pwsh"
 *  (pty-manager/shell-resolver verifies pwsh 7 on disk at spawn time; a missing
 *  pwsh is a clear pre-spawn error, not a silent fallback — public #10).
 *  macOS resolves to "zsh"; Linux resolves to $SHELL or "bash". */
export function defaultShellForPlatform(): AppSettings["defaultShell"] {
  if (process.platform === "win32") return "pwsh";
  if (process.platform === "darwin") return "zsh";
  if (process.platform === "linux") return (process.env.SHELL ?? "bash") as AppSettings["defaultShell"];
  return "pwsh";
}

function snippet(text: string, term: string): string {
  const compact = redactEgress(text).replace(/\s+/g, " ").trim();
  const index = term ? compact.toLowerCase().indexOf(term.toLowerCase()) : -1;
  const start = index < 0 ? 0 : Math.max(0, index - 80);
  return compact.slice(start, start + 220);
}

function sanitizeTerminalPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const redacted = JSON.stringify(redactEgressValue(payload));
  if (redacted.length <= 24_000) return parseJson<Record<string, unknown>>(redacted, {});
  return {
    text: redacted.slice(0, 24_000),
    truncated: true,
  };
}
