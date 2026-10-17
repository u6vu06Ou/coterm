import type { ProjectHistorySession } from "@shared/types";
import { useAppStore } from "../store/app-store";
import { canResumeProfile } from "./interactive-agent";

/**
 * f2 側欄 session 分支（1.5.46, next-rev board）:
 * sessions live inline under their folder in the sidebar. A session row (or the
 * whole group) drags into the main dock with these MIME types; the dock shell
 * (App.tsx workspace-shell) opens each as a tile RESUMED to its original
 * session (沿用 coterm:interactive-agent 的 resumeSessionId 機制), not as a
 * desktop window. A session already live in the dock is never re-opened — the
 * drop/click focuses that tile instead.
 */

export const SESSION_DRAG_MIME = "application/x-coterm-session";
export const SESSION_GROUP_DRAG_MIME = "application/x-coterm-session-group";

/**
 * 閱讀模式 (reading mode): a LIVE tile drags with this MIME into a reading
 * slot. Sources: the reading tray cards and the sidebar open-tile rows
 * (1.5.48 — drag straight from the project folder instead of the bottom tray).
 * Kept here beside the session MIMEs so every drag surface imports one list.
 */
export const READING_DRAG_MIME = "application/x-coterm-terminal";

export interface SessionDragItem {
  profileId: string;
  nativeSessionId: string;
}

export interface SessionDragPayload extends SessionDragItem {
  projectId: string;
}

export interface SessionGroupDragPayload {
  projectId: string;
  sessions: SessionDragItem[];
}

/** Sessions that can be re-opened at all (resume-capable profile + a real id). */
export function resumableSessions(sessions: ProjectHistorySession[]): SessionDragItem[] {
  return sessions
    .filter((session) => Boolean(session.nativeSessionId) && canResumeProfile(session.profileId))
    .map((session) => ({ profileId: session.profileId, nativeSessionId: session.nativeSessionId as string }));
}

export function parseSessionDragPayload(raw: string): SessionDragPayload | null {
  try {
    const data = JSON.parse(raw) as Partial<SessionDragPayload>;
    if (typeof data.projectId !== "string" || typeof data.profileId !== "string") return null;
    if (typeof data.nativeSessionId !== "string" || data.nativeSessionId.length === 0) return null;
    return { projectId: data.projectId, profileId: data.profileId, nativeSessionId: data.nativeSessionId };
  } catch {
    return null;
  }
}

export function parseSessionGroupDragPayload(raw: string): SessionGroupDragPayload | null {
  try {
    const data = JSON.parse(raw) as Partial<SessionGroupDragPayload>;
    if (typeof data.projectId !== "string" || !Array.isArray(data.sessions)) return null;
    const sessions: SessionDragItem[] = [];
    for (const item of data.sessions as Array<Partial<SessionDragItem>>) {
      // One bad entry must not kill the whole group — skip it, keep the rest.
      if (typeof item.profileId !== "string" || typeof item.nativeSessionId !== "string") continue;
      sessions.push({ profileId: item.profileId, nativeSessionId: item.nativeSessionId });
    }
    if (sessions.length === 0) return null;
    return { projectId: data.projectId, sessions };
  } catch {
    return null;
  }
}

/**
 * Decide which sessions of a group open fresh tiles vs. which should just be
 * focused: already-live sessions are never re-opened (rule #3), and the dock
 * caps at 8 tiles — overflow sessions are skipped (not failed), while a later
 * already-open session still earns the focus when nothing opened.
 */
export function planGroupOpen<T extends SessionDragItem>(
  sessions: readonly T[],
  openNativeIds: ReadonlySet<string>,
  freeSlots: number,
): { toOpen: T[]; focusNativeId: string | null } {
  const toOpen: T[] = [];
  let focusNativeId: string | null = null;
  let remaining = Math.max(0, freeSlots);
  for (const session of sessions) {
    if (openNativeIds.has(session.nativeSessionId)) {
      if (!focusNativeId) focusNativeId = session.nativeSessionId;
      continue;
    }
    if (remaining <= 0) continue;
    toOpen.push(session);
    remaining -= 1;
  }
  return { toOpen, focusNativeId };
}

// 12 to match main — 與 src/main/core/dock-layout.ts MAX_TILES / agent-api.ts
// MAX_TERMINALS 連動；drift makes the sidebar over-open past the real dock cap.
export const DOCK_MAX_TILES = 12;

/** nativeSessionId → terminalId for the sessions LIVE in the dock right now. */
async function liveSessionTerminals(projectId: string): Promise<Record<string, string>> {
  const tileIds = new Set(useAppStore.getState().dockLayout.tiles.map((tile) => tile.terminalId));
  const infos = await window.aiTerminal.listTerminals(projectId).catch(() => []);
  const map: Record<string, string> = {};
  for (const info of infos) {
    if (info.nativeSessionId && tileIds.has(info.id)) map[info.nativeSessionId] = info.id;
  }
  return map;
}

async function focusTerminal(terminalId: string): Promise<void> {
  await window.aiTerminal.selectTile({ terminalId }).catch(() => undefined);
}

/** Open one resumed session as a dock tile (or focus the tile it already runs in). */
export async function openSessionResumed(session: SessionDragPayload): Promise<boolean> {
  const live = await liveSessionTerminals(session.projectId);
  const existing = live[session.nativeSessionId];
  if (existing) {
    await focusTerminal(existing);
    return true;
  }
  const layout = await useAppStore.getState().openTile(session.projectId);
  const terminalId = layout?.selectedTerminalId;
  if (!terminalId) return false;
  window.dispatchEvent(new CustomEvent("coterm:interactive-agent", {
    detail: {
      terminalId,
      provider: session.profileId,
      resumeSessionId: session.nativeSessionId,
    },
  }));
  return true;
}

/** Open a whole folder's sessions into the dock, even-split by openTile. */
export async function openSessionGroup(projectId: string, sessions: readonly SessionDragItem[]): Promise<void> {
  const live = await liveSessionTerminals(projectId);
  const freeSlots = DOCK_MAX_TILES - useAppStore.getState().dockLayout.tiles.length;
  const plan = planGroupOpen(sessions, new Set(Object.keys(live)), freeSlots);
  for (const session of plan.toOpen) {
    const layout = await useAppStore.getState().openTile(projectId);
    const terminalId = layout?.selectedTerminalId;
    // A failed/cancelled spawn must stop the batch, not spin the rest.
    if (!terminalId) return;
    window.dispatchEvent(new CustomEvent("coterm:interactive-agent", {
      detail: {
        terminalId,
        provider: session.profileId,
        resumeSessionId: session.nativeSessionId,
      },
    }));
  }
  // The group was already fully open → focus the first live member instead.
  if (plan.toOpen.length === 0 && plan.focusNativeId) {
    const terminalId = live[plan.focusNativeId];
    if (terminalId) await focusTerminal(terminalId);
  }
}
