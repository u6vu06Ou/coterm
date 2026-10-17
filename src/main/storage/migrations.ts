import { redactEgress } from "../security/redaction";

type Migration = {
  version: number;
  statements: string[];
  run?: (db: {
    run: (sql: string, params?: Record<string, unknown>) => void;
    queryAll: <T>(sql: string, params?: Record<string, unknown>) => T[];
  }) => void;
};

export const migrations: Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        active_provider TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
      )`,
      `CREATE TABLE IF NOT EXISTS provider_sessions (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        native_session_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(conversation_id, profile_id),
        FOREIGN KEY(conversation_id) REFERENCES conversations(id)
      )`,
      `CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        provider_session_id TEXT,
        turn_group_id TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id)
      )`,
      `CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        provider_session_id TEXT,
        turn_group_id TEXT,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id),
        FOREIGN KEY(turn_id) REFERENCES turns(id)
      )`,
      `CREATE INDEX IF NOT EXISTS events_conversation_sequence
        ON events(conversation_id, sequence)`,
      `CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        local_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS handoffs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        source_profile TEXT NOT NULL,
        target_profile TEXT NOT NULL,
        packet_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS terminal_workspaces (
        project_id TEXT PRIMARY KEY,
        layout_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS terminal_panes (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        profile TEXT NOT NULL,
        title TEXT NOT NULL,
        cwd TEXT NOT NULL,
        cols INTEGER NOT NULL,
        rows INTEGER NOT NULL,
        scrollback TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS turn_groups (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        chairman TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS turn_group_members (
        id TEXT PRIMARY KEY,
        turn_group_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        anonymous_label TEXT NOT NULL,
        status TEXT NOT NULL,
        answer TEXT,
        score REAL,
        elapsed_ms INTEGER,
        FOREIGN KEY(turn_group_id) REFERENCES turn_groups(id)
      )`,
      `CREATE TABLE IF NOT EXISTS peer_reviews (
        id TEXT PRIMARY KEY,
        turn_group_id TEXT NOT NULL,
        reviewer_profile_id TEXT NOT NULL,
        rankings_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(turn_group_id) REFERENCES turn_groups(id)
      )`,
      `CREATE TABLE IF NOT EXISTS chairman_syntheses (
        id TEXT PRIMARY KEY,
        turn_group_id TEXT NOT NULL,
        chairman_profile_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(turn_group_id) REFERENCES turn_groups(id)
      )`,
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 2,
    statements: [
      `CREATE UNIQUE INDEX IF NOT EXISTS events_conversation_sequence_unique
        ON events(conversation_id, sequence)`,
    ],
  },
  {
    version: 3,
    statements: [
      "ALTER TABLE terminal_panes ADD COLUMN position INTEGER NOT NULL DEFAULT 0",
    ],
  },
  {
    version: 4,
    statements: ["ALTER TABLE conversations ADD COLUMN summary_json TEXT"],
  },
  {
    version: 5,
    statements: [
      "ALTER TABLE conversations ADD COLUMN claude_model TEXT NOT NULL DEFAULT 'default'",
    ],
  },
  {
    version: 6,
    statements: [
      "UPDATE conversations SET active_provider = 'claude-local-main' WHERE active_provider = 'claude-local-deep'",
      "UPDATE provider_sessions SET profile_id = 'claude-local-main' WHERE profile_id = 'claude-local-deep'",
      "UPDATE handoffs SET source_profile = 'claude-local-main' WHERE source_profile = 'claude-local-deep'",
      "UPDATE handoffs SET target_profile = 'claude-local-main' WHERE target_profile = 'claude-local-deep'",
      "UPDATE handoffs SET packet_json = replace(packet_json, 'claude-local-deep', 'claude-local-main')",
      "UPDATE turn_groups SET chairman = 'glm' WHERE chairman = 'deepseek'",
      "UPDATE turn_group_members SET profile_id = 'claude-local-main' WHERE profile_id = 'claude-local-deep'",
      "UPDATE peer_reviews SET reviewer_profile_id = 'claude-local-main' WHERE reviewer_profile_id = 'claude-local-deep'",
      "UPDATE chairman_syntheses SET chairman_profile_id = 'claude-local-main' WHERE chairman_profile_id = 'claude-local-deep'",
      "UPDATE events SET payload_json = replace(payload_json, 'claude-local-deep', 'claude-local-main')",
      "UPDATE settings SET value_json = replace(value_json, 'claude-local-deep', 'claude-local-main')",
    ],
  },
  {
    version: 7,
    statements: [
      "ALTER TABLE conversations ADD COLUMN primary_provider TEXT",
      "UPDATE conversations SET primary_provider = active_provider WHERE primary_provider IS NULL",
      "ALTER TABLE conversations ADD COLUMN continued_from_conversation_id TEXT",
      "ALTER TABLE conversations ADD COLUMN handoff_source_conversation_id TEXT",
    ],
  },
  {
    version: 8,
    statements: [
      "ALTER TABLE terminal_panes ADD COLUMN started_at TEXT",
      "ALTER TABLE terminal_panes ADD COLUMN closed_at TEXT",
      "ALTER TABLE terminal_panes ADD COLUMN last_exit_code INTEGER",
      "ALTER TABLE terminal_panes ADD COLUMN is_agent INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE terminal_panes ADD COLUMN agent_profile TEXT",
      `CREATE TABLE IF NOT EXISTS terminal_events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        terminal_id TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
      )`,
      `CREATE INDEX IF NOT EXISTS terminal_events_project_created
        ON terminal_events(project_id, created_at)`,
     `CREATE INDEX IF NOT EXISTS terminal_events_terminal_sequence
       ON terminal_events(terminal_id, sequence)`,
   ],
 },
  {
    version: 9,
    statements: [],
    run: (db) => {
      // Data-scrub pass: run existing terminal_events/events/terminal_panes rows
      // through redactEgress. JS migration because sql.js can't run TS regex in SQL.
      // NOTE: The migration runner in database.ts must invoke `run` if present;
      // `statements` alone cannot perform regex-based redaction.
      // Process in batches to avoid loading everything into memory.
      const batchSize = 500;

      const scrubTextColumns = (
        table: string,
        columns: string[],
      ): void => {
        const colList = columns.join(", ");
        let offset = 0;
        while (true) {
          const rows = db.queryAll<{ id: string } & Record<string, string>>(
            `SELECT id, ${colList} FROM ${table} ORDER BY rowid LIMIT $limit OFFSET $offset`,
            { $limit: batchSize, $offset: offset },
          );
          if (rows.length === 0) break;
          for (const row of rows) {
            const updates: string[] = [];
            const params: Record<string, unknown> = { $id: row.id };
            let changed = false;
            for (const col of columns) {
              const original = row[col];
              if (typeof original !== "string") continue;
              const redacted = redactEgress(original);
              if (redacted !== original) {
                updates.push(`${col} = $${col}`);
                params[`$${col}`] = redacted;
                changed = true;
              }
            }
            if (changed) {
              db.run(
                `UPDATE ${table} SET ${updates.join(", ")} WHERE id = $id`,
                params,
              );
            }
          }
          offset += batchSize;
          if (rows.length < batchSize) break;
        }
      };

      scrubTextColumns("terminal_events", ["summary", "payload_json"]);
      scrubTextColumns("events", ["summary", "payload_json"]);
      scrubTextColumns("terminal_panes", ["scrollback", "cwd"]);
    },
  },
  {
    // A — Worktree sandbox + trusted resume. One row per git worktree bound to
    // a project. native_session_id + resume_command are populated in two phases
    // (null at create, set after the agent emits its session id). resume_command
    // is metadata-only (profile + sessionId) — never a persisted arbitrary shell
    // command, never a secret/token. B will add v11 for checkpoints; do NOT
    // implement checkpoint columns here.
    version: 10,
    statements: [
      `CREATE TABLE IF NOT EXISTS worktrees (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        branch TEXT NOT NULL,
        worktree_path TEXT NOT NULL UNIQUE,
        base_ref TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','merged','aborted','conflict','closed')),
        native_session_id TEXT,
        resume_command TEXT,
        pr_url TEXT,
        permissions_preset TEXT NOT NULL DEFAULT 'ask' CHECK(permissions_preset IN ('ask','trusted')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        FOREIGN KEY(project_id) REFERENCES projects(id),
        UNIQUE(project_id, branch)
      )`,
      `CREATE INDEX IF NOT EXISTS worktrees_project_status
        ON worktrees(project_id, status)`,
    ],
  },
  {
    // B — Checkpoint / undo-redo rail. One row per pre/post snapshot of a
    // workspace. Git workspaces pin a ref (worktree branch commit or dangling
    // stash object) without mutating the working tree; non-Git workspaces use a
    // bounded file snapshot under userData/checkpoints. checkpoint_restores
    // records every restore attempt (applied/refused/failed) for audit.
    // unique(turn_id, phase) enforces one pre + one post per turn.
    version: 11,
    statements: [
      `CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        turn_id TEXT,
        conversation_id TEXT,
        project_id TEXT NOT NULL,
        worktree_id TEXT,
        phase TEXT NOT NULL CHECK(phase IN ('pre','post')),
        kind TEXT NOT NULL CHECK(kind IN ('worktree-commit','git-stash','file-snapshot')),
        status TEXT NOT NULL CHECK(status IN ('active','failed','restored','superseded')),
        ref TEXT,
        snapshot_path TEXT,
        workspace_fingerprint TEXT,
        file_count INTEGER NOT NULL DEFAULT 0 CHECK(file_count >= 0),
        size_bytes INTEGER NOT NULL DEFAULT 0 CHECK(size_bytes >= 0),
        partial INTEGER NOT NULL DEFAULT 0 CHECK(partial IN (0, 1)),
        created_at TEXT NOT NULL,
        finalized_at TEXT,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
        FOREIGN KEY(turn_id) REFERENCES turns(id) ON DELETE CASCADE,
        CHECK(
          status = 'failed'
          OR (kind = 'file-snapshot' AND ref IS NULL AND snapshot_path IS NOT NULL)
          OR (kind IN ('worktree-commit','git-stash') AND ref IS NOT NULL)
        ),
        UNIQUE(turn_id, phase)
      )`,
      `CREATE INDEX IF NOT EXISTS checkpoints_conversation
        ON checkpoints(conversation_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS checkpoints_project_worktree
        ON checkpoints(project_id, worktree_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS checkpoint_restores (
        id TEXT PRIMARY KEY,
        checkpoint_id TEXT NOT NULL,
        turn_id TEXT,
        conversation_id TEXT,
        project_id TEXT NOT NULL,
        worktree_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('applied','refused','failed')),
        reason TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(checkpoint_id) REFERENCES checkpoints(id) ON DELETE CASCADE,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
        FOREIGN KEY(turn_id) REFERENCES turns(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS checkpoint_restores_checkpoint
        ON checkpoint_restores(checkpoint_id, created_at)`,
    ],
  },
  {
    // Issue #5 — privacy-safe Terminal Handoff Packet ledger. source_session_hash
    // is one-way and packet_json has already passed post-generation redaction +
    // strict schema validation. Raw transcript, scrollback, terminal id, prompt,
    // and provider output are deliberately absent.
    version: 12,
    statements: [
      `CREATE TABLE IF NOT EXISTS terminal_handoffs (
        id TEXT PRIMARY KEY,
        source_session_hash TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        packet_json TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK(source_kind IN ('native-transcript','sanitized-scrollback','mixed')),
        summarizer_profile TEXT NOT NULL CHECK(summarizer_profile IN ('claude-local-main','claude-local-long','deterministic')),
        input_bytes INTEGER NOT NULL CHECK(input_bytes >= 0),
        packet_bytes INTEGER NOT NULL CHECK(packet_bytes >= 0),
        token_estimate INTEGER NOT NULL CHECK(token_estimate >= 0 AND token_estimate <= 2000),
        created_at TEXT NOT NULL,
        UNIQUE(source_session_hash, idempotency_key)
      )`,
      `CREATE INDEX IF NOT EXISTS terminal_handoffs_created
        ON terminal_handoffs(created_at)`,
    ],
  },
  {
    // Issue #6 — durable fixed AgentApi orchestration ledger. Raw PTY output,
    // provider output, and git diffs are deliberately absent from both tables.
    version: 13,
    statements: [
      `CREATE TABLE IF NOT EXISTS agentapi_workflows (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        task TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        branch TEXT,
        base_ref TEXT,
        implementer TEXT NOT NULL CHECK(implementer = 'claude-local-main'),
        reviewer TEXT NOT NULL CHECK(reviewer = 'codex-local-main'),
        state TEXT NOT NULL CHECK(state IN (
          'queued','dispatching_implementation','waiting_implementation',
          'building_review_packet','dispatching_review','waiting_review',
          'changes_requested','ready_for_human_review','needs_human','blocked',
          'failed','canceled'
        )),
        resume_state TEXT,
        review_loop INTEGER NOT NULL DEFAULT 0 CHECK(review_loop BETWEEN 0 AND 3),
        worktree_id TEXT,
        worktree_path TEXT,
        terminal_id TEXT,
        session_id TEXT,
        handoff_id TEXT,
        last_outcome_json TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE RESTRICT,
        FOREIGN KEY(worktree_id) REFERENCES worktrees(id) ON DELETE RESTRICT
      )`,
      `CREATE INDEX IF NOT EXISTS agentapi_workflows_state
        ON agentapi_workflows(state, updated_at)`,
      `CREATE TABLE IF NOT EXISTS agentapi_workflow_steps (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN (
          'implementation_dispatch','implementation_wait','handoff',
          'review_dispatch','review_wait','correction_dispatch',
          'correction_running_wait','correction_done_wait'
        )),
        attempt INTEGER NOT NULL CHECK(attempt > 0),
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN (
          'pending','dispatching','waiting','completed','needs_human','failed','canceled'
        )),
        terminal_id TEXT,
        session_id TEXT,
        handoff_id TEXT,
        outcome_json TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        FOREIGN KEY(workflow_id) REFERENCES agentapi_workflows(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS agentapi_steps_workflow
        ON agentapi_workflow_steps(workflow_id, created_at)`,
    ],
  },
  {
    // Issue #13 / AT-138 — rebuild terminal_handoffs so source_kind also accepts
    // 'screen-snapshot' (alternate-screen handoff source). SQLite cannot ALTER a
    // CHECK constraint; create/copy/drop/rename inside the migration transaction.
    version: 14,
    statements: [
      `CREATE TABLE terminal_handoffs_v14 (
        id TEXT PRIMARY KEY,
        source_session_hash TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        packet_json TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK(source_kind IN ('native-transcript','sanitized-scrollback','screen-snapshot','mixed')),
        summarizer_profile TEXT NOT NULL CHECK(summarizer_profile IN ('claude-local-main','claude-local-long','deterministic')),
        input_bytes INTEGER NOT NULL CHECK(input_bytes >= 0),
        packet_bytes INTEGER NOT NULL CHECK(packet_bytes >= 0),
        token_estimate INTEGER NOT NULL CHECK(token_estimate >= 0 AND token_estimate <= 2000),
        created_at TEXT NOT NULL,
        UNIQUE(source_session_hash, idempotency_key)
      )`,
      `INSERT INTO terminal_handoffs_v14
        SELECT id, source_session_hash, idempotency_key, request_fingerprint,
               packet_json, source_kind, summarizer_profile, input_bytes,
               packet_bytes, token_estimate, created_at
        FROM terminal_handoffs`,
      `DROP TABLE terminal_handoffs`,
      `ALTER TABLE terminal_handoffs_v14 RENAME TO terminal_handoffs`,
      `CREATE INDEX IF NOT EXISTS terminal_handoffs_created
        ON terminal_handoffs(created_at)`,
    ],
  },
  {
    // Ledger bloat fix (1.37 GB ai-terminal.sqlite, 2026-08-06): flip
    // retention.pruneOnStart to true for EXISTING installs — the schema default
    // only covers a missing key, and old rows carry an explicit false, so the
    // startup prune never ran and terminal_events grew without bound. json('true')
    // is required: a SQL 1 would store an integer, which fails the zod boolean
    // parse and resets the whole settings row to defaults. json_type guard keeps
    // rows whose retention object is absent untouched (schema default covers them).
    version: 15,
    statements: [
      `UPDATE settings
       SET value_json = json_set(value_json, '$.retention.pruneOnStart', json('true'))
       WHERE key = 'app' AND json_type(value_json, '$.retention') = 'object'`,
    ],
  },
  {
    // Persistent Eyes-Free Live Voice Supervisor. Logical voice sessions are
    // durable; realtime rooms are not. Raw audio/PCM/WebM is intentionally not
    // represented in this schema.
    version: 16,
    statements: [
      `CREATE TABLE IF NOT EXISTS voice_sessions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN (
          'starting','listening','user-speaking','thinking','speaking',
          'muted','reconnecting','ended','error'
        )),
        started_at TEXT NOT NULL,
        ended_at TEXT,
        last_active_at TEXT NOT NULL,
        rolling_summary TEXT NOT NULL DEFAULT '',
        current_topic TEXT,
        active_terminal_id TEXT,
        transport TEXT NOT NULL,
        stt_language_mode TEXT NOT NULL CHECK(stt_language_mode IN ('auto','zh-TW','zh-CN','en-US')),
        response_language TEXT NOT NULL CHECK(response_language IN ('zh-TW','zh-CN','en-US')),
        revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0)
      )`,
      `CREATE INDEX IF NOT EXISTS voice_sessions_status_active
        ON voice_sessions(status, last_active_at)`,
      `CREATE TABLE IF NOT EXISTS voice_turns (
        id TEXT PRIMARY KEY,
        voice_session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user','agentapi','system')),
        text TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('fast','relay','summary','supervisor','narration')),
        terminal_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(voice_session_id) REFERENCES voice_sessions(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS voice_turns_session_created
        ON voice_turns(voice_session_id, created_at)`,
    ],
  },
  {
    // Project manual ordering. Existing installs receive their current visual
    // order exactly once, then the explicit order becomes the sole non-pin sort
    // key. New projects are assigned below the current minimum so they appear
    // at the top without disturbing the user's later manual ordering.
    version: 17,
    statements: [],
    run: (db) => {
      const columns = db.queryAll<{ name?: unknown }>("PRAGMA table_info(projects)");
      if (!columns.some((column) => column.name === "project_order")) {
        db.run("ALTER TABLE projects ADD COLUMN project_order INTEGER NOT NULL DEFAULT 0");
      }
      const rows = db.queryAll<{ id: string }>(
        "SELECT id FROM projects WHERE archived = 0 ORDER BY pinned DESC, updated_at DESC, id ASC",
      );
      rows.forEach((row, index) => {
        db.run("UPDATE projects SET project_order = $order WHERE id = $id", {
          $id: row.id,
          $order: index,
        });
      });
      const archived = db.queryAll<{ id: string }>(
        "SELECT id FROM projects WHERE archived = 1 ORDER BY updated_at DESC, id ASC",
      );
      archived.forEach((row, index) => {
        db.run("UPDATE projects SET project_order = $order WHERE id = $id", {
          $id: row.id,
          $order: index,
        });
      });
    },
  },
  {
    version: 18,
    statements: [
      `CREATE TABLE IF NOT EXISTS storage_counters (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      )`,
      // Rolling-cap bookkeeping for terminal_events. The overflow check used
      // to run a COUNT/SUM scan over the whole table (~200 MB) once every 256
      // appends; these counters are two primary-key lookups instead. Seeded
      // once below; the triggers keep them exact on every later insert/delete
      // no matter which code path performs the write.
    `INSERT OR REPLACE INTO storage_counters(key, value)
        SELECT 'terminal_events.rows', COUNT(*) FROM terminal_events`,
      `INSERT OR REPLACE INTO storage_counters(key, value)
        SELECT 'terminal_events.payload_bytes', COALESCE(SUM(LENGTH(payload_json)), 0) FROM terminal_events`,
      `CREATE TRIGGER IF NOT EXISTS terminal_events_counter_after_insert
        AFTER INSERT ON terminal_events BEGIN
          UPDATE storage_counters SET value = value + 1 WHERE key = 'terminal_events.rows';
          UPDATE storage_counters SET value = value + LENGTH(NEW.payload_json) WHERE key = 'terminal_events.payload_bytes';
        END`,
      `CREATE TRIGGER IF NOT EXISTS terminal_events_counter_after_delete
        AFTER DELETE ON terminal_events BEGIN
          UPDATE storage_counters SET value = value - 1 WHERE key = 'terminal_events.rows';
          UPDATE storage_counters SET value = value - LENGTH(OLD.payload_json) WHERE key = 'terminal_events.payload_bytes';
        END`,
    ],
  },
];
