import { randomUUID } from "node:crypto";
import type {
  VoiceResponseLanguage,
  VoiceSessionRecord,
  VoiceSessionStatus,
  VoiceSttLanguageMode,
  VoiceTurnRecord,
  VoiceTurnRole,
  VoiceTurnSource,
} from "@shared/types";
import type { AppDatabase } from "../../storage/database";

interface VoiceSessionRow {
  id: string;
  status: VoiceSessionStatus;
  started_at: string;
  ended_at: string | null;
  last_active_at: string;
  rolling_summary: string;
  current_topic: string | null;
  active_terminal_id: string | null;
  transport: string;
  stt_language_mode: VoiceSttLanguageMode;
  response_language: VoiceResponseLanguage;
  revision: number;
}

interface VoiceTurnRow {
  id: string;
  voice_session_id: string;
  role: VoiceTurnRole;
  text: string;
  source: VoiceTurnSource;
  terminal_id: string | null;
  created_at: string;
}

export interface CreateVoiceSessionInput {
  id?: string;
  transport: string;
  sttLanguageMode: VoiceSttLanguageMode;
  responseLanguage: VoiceResponseLanguage;
  now?: string;
}

export interface AppendVoiceTurnInput {
  id?: string;
  voiceSessionId: string;
  role: VoiceTurnRole;
  text: string;
  source: VoiceTurnSource;
  terminalId?: string | null;
  createdAt?: string;
}

/** Durable logical voice-session storage. Raw audio is never accepted here. */
export class VoiceSessionRepository {
  constructor(private readonly database: AppDatabase) {}

  create(input: CreateVoiceSessionInput): VoiceSessionRecord {
    const id = input.id ?? randomUUID();
    const now = input.now ?? new Date().toISOString();
    this.database.run(
      `INSERT INTO voice_sessions(
        id, status, started_at, ended_at, last_active_at, rolling_summary,
        current_topic, active_terminal_id, transport, stt_language_mode,
        response_language, revision
      ) VALUES (
        $id, 'starting', $startedAt, NULL, $lastActiveAt, '',
        NULL, NULL, $transport, $sttLanguageMode, $responseLanguage, 0
      )`,
      {
        $id: id,
        $startedAt: now,
        $lastActiveAt: now,
        $transport: input.transport,
        $sttLanguageMode: input.sttLanguageMode,
        $responseLanguage: input.responseLanguage,
      },
    );
    return this.require(id);
  }

  get(id: string): VoiceSessionRecord | null {
    const row = this.database.queryOne<VoiceSessionRow>(
      "SELECT * FROM voice_sessions WHERE id = $id",
      { $id: id },
    );
    return row ? mapSession(row) : null;
  }

  require(id: string): VoiceSessionRecord {
    const session = this.get(id);
    if (!session) throw new Error(`Voice session not found: ${id}`);
    return session;
  }

  setStatus(id: string, status: VoiceSessionStatus, now = new Date().toISOString()): VoiceSessionRecord {
    const endedAt = status === "ended" ? now : null;
    this.database.run(
      `UPDATE voice_sessions
       SET status = $status,
           last_active_at = $lastActiveAt,
           ended_at = CASE WHEN $status = 'ended' THEN $endedAt ELSE ended_at END,
           revision = revision + 1
       WHERE id = $id`,
      { $id: id, $status: status, $lastActiveAt: now, $endedAt: endedAt },
    );
    return this.require(id);
  }

  updateContext(input: {
    id: string;
    rollingSummary?: string;
    currentTopic?: string | null;
    activeTerminalId?: string | null;
    transport?: string;
    now?: string;
  }): VoiceSessionRecord {
    const current = this.require(input.id);
    const now = input.now ?? new Date().toISOString();
    this.database.run(
      `UPDATE voice_sessions
       SET rolling_summary = $rollingSummary,
           current_topic = $currentTopic,
           active_terminal_id = $activeTerminalId,
           transport = $transport,
           last_active_at = $lastActiveAt,
           revision = revision + 1
       WHERE id = $id`,
      {
        $id: input.id,
        $rollingSummary: input.rollingSummary ?? current.rollingSummary,
        $currentTopic: input.currentTopic === undefined ? current.currentTopic : input.currentTopic,
        $activeTerminalId: input.activeTerminalId === undefined ? current.activeTerminalId : input.activeTerminalId,
        $transport: input.transport ?? current.transport,
        $lastActiveAt: now,
      },
    );
    return this.require(input.id);
  }

  appendTurn(input: AppendVoiceTurnInput): VoiceTurnRecord {
    const id = input.id ?? randomUUID();
    const createdAt = input.createdAt ?? new Date().toISOString();
    const text = input.text.trim();
    if (!text) throw new Error("Voice turn text must not be empty.");
    this.require(input.voiceSessionId);
    this.database.run(
      `INSERT INTO voice_turns(
        id, voice_session_id, role, text, source, terminal_id, created_at
      ) VALUES ($id, $voiceSessionId, $role, $text, $source, $terminalId, $createdAt)`,
      {
        $id: id,
        $voiceSessionId: input.voiceSessionId,
        $role: input.role,
        $text: text,
        $source: input.source,
        $terminalId: input.terminalId ?? null,
        $createdAt: createdAt,
      },
    );
    this.database.run(
      `UPDATE voice_sessions
       SET last_active_at = $createdAt, revision = revision + 1
       WHERE id = $voiceSessionId`,
      { $createdAt: createdAt, $voiceSessionId: input.voiceSessionId },
    );
    return this.requireTurn(id);
  }

  listRecentTurns(voiceSessionId: string, limit = 20): VoiceTurnRecord[] {
    const boundedLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
    const rows = this.database.queryAll<VoiceTurnRow>(
      `SELECT * FROM voice_turns
       WHERE voice_session_id = $voiceSessionId
       ORDER BY created_at DESC, id DESC
       LIMIT $limit`,
      { $voiceSessionId: voiceSessionId, $limit: boundedLimit },
    );
    return rows.reverse().map(mapTurn);
  }

  countTurns(voiceSessionId: string): number {
    return this.database.queryOne<{ count: number }>(
      "SELECT COUNT(*) AS count FROM voice_turns WHERE voice_session_id = $voiceSessionId",
      { $voiceSessionId: voiceSessionId },
    )?.count ?? 0;
  }

  private requireTurn(id: string): VoiceTurnRecord {
    const row = this.database.queryOne<VoiceTurnRow>(
      "SELECT * FROM voice_turns WHERE id = $id",
      { $id: id },
    );
    if (!row) throw new Error(`Voice turn not found: ${id}`);
    return mapTurn(row);
  }
}

function mapSession(row: VoiceSessionRow): VoiceSessionRecord {
  return {
    id: row.id,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    lastActiveAt: row.last_active_at,
    rollingSummary: row.rolling_summary,
    currentTopic: row.current_topic,
    activeTerminalId: row.active_terminal_id,
    transport: row.transport,
    sttLanguageMode: row.stt_language_mode,
    responseLanguage: row.response_language,
    revision: row.revision,
  };
}

function mapTurn(row: VoiceTurnRow): VoiceTurnRecord {
  return {
    id: row.id,
    voiceSessionId: row.voice_session_id,
    role: row.role,
    text: row.text,
    source: row.source,
    terminalId: row.terminal_id,
    createdAt: row.created_at,
  };
}
