import { useEffect, useState } from "react";
import type { AgentFileActivity, SystemActivity, WorktreeRegistryActivity } from "@shared/types";
import { FolderOpen } from "lucide-react";
import type { MessageKey } from "../i18n";
import { useI18n } from "../i18n";
import { useAppStore } from "../store/app-store";
import { copyTextToClipboard } from "./terminal-reader/clipboard";
import {
  filterPulseEntries,
  formatBytes,
  formatGrowthDelta,
  nextPulseSortDirection,
  pulseSortArrow,
  readPulseSortPrefs,
  sortPulseEntries,
  writePulseSortPrefs,
} from "./pulse-format";
import type { PulseFilterKind, PulseSortKey, PulseSortPrefs } from "./pulse-format";

/** 日月版型的品牌標：太陽時有光芒，月亮時被咬成新月（CSS 依 data-theme 過場）。 */
export function SunMoonMark() {
  return (
    <svg className="sm-mark" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <mask id="sm-mark-mask">
          <rect width="32" height="32" fill="#fff" />
          <circle className="sm-bite" cx="21.2" cy="11.6" r="7.1" fill="#000" />
        </mask>
      </defs>
      <g className="sm-rays" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
        <path d="M16 2.6v3M16 26.4v3M2.6 16h3M26.4 16h3M6.5 6.5l2.1 2.1M23.4 23.4l2.1 2.1M6.5 25.5l2.1-2.1M23.4 8.6l2.1-2.1" />
      </g>
      <circle cx="16" cy="16" r="7.4" fill="currentColor" mask="url(#sm-mark-mask)" />
    </svg>
  );
}

const HISTORY = 60; // 60 × 2s = last two minutes
const POLL_MS = 2_000;
const FILES_POLL_MS = 5_000;
const WORKTREES_POLL_MS = 30_000;
const MAX_DIR_CHARS = 30;

// Segmented controls above the file list (2026-10-12 maintainer): 大小/成長/時間 +
// 全部/新增/修改. Template action ids stay unique per control at runtime and
// the static audit catalogs `` `skin.pulse.sort.${key}` `` as one pattern.
const SORT_ORDER: readonly PulseSortKey[] = ["size", "growth", "time"];
const FILTER_ORDER: readonly PulseFilterKind[] = ["all", "created", "modified"];
const SORT_LABELS: Record<PulseSortKey, MessageKey> = {
  size: "skin.pulse.sort.size",
  growth: "skin.pulse.sort.growth",
  time: "skin.pulse.sort.time",
};
const FILTER_LABELS: Record<PulseFilterKind, MessageKey> = {
  all: "skin.pulse.filter.all",
  created: "skin.pulse.filter.created",
  modified: "skin.pulse.filter.modified",
};

/** SVG path for a 0–100 series drawn into a w×h box (newest sample on the right). */
function seriesPath(values: readonly number[], w: number, h: number, close: boolean): string {
  if (values.length === 0) return "";
  const step = w / (HISTORY - 1);
  const x0 = w - (values.length - 1) * step;
  const pts = values.map((v, i) => `${(x0 + i * step).toFixed(1)} ${(h - (Math.max(0, Math.min(100, v)) / 100) * (h - 2) - 1).toFixed(1)}`);
  const line = `M${pts.join(" L")}`;
  return close ? `${line} L${w} ${h} L${x0.toFixed(1)} ${h} Z` : line;
}

/** Split a path into parent folder + file name (works for \ and / separators). */
function splitPath(raw: string): { dir: string; name: string } {
  const idx = Math.max(raw.lastIndexOf("\\"), raw.lastIndexOf("/"));
  if (idx < 0) return { dir: "", name: raw };
  return { dir: raw.slice(0, idx), name: raw.slice(idx + 1) };
}

/** HH:MM in local time. */
function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * 側欄底部的「機器脈搏」（2026-10-03 maintainer，取代日照弧）：本次開啟 Coterm 以來
 * agent 在各終端資料夾寫出多少檔案（大小＋檔數），下面一條兩分鐘的 CPU 波形
 * ＋RAM 虛線。主程序算，renderer 每 2 秒拉一次（視窗看不到時暫停）。
 * 點標頭／數字展開檔案清單（2026-10-06 maintainer）：每一列檔名＋資料夾＋大小＋
 * 新增／修改＋時間，點列複製路徑，檔案總管鈕只在桌機顯示（web 沒有 shell）。
 */
export function SunMoonPulse() {
  const { t } = useI18n();
  const [activity, setActivity] = useState<SystemActivity | null>(null);
  const [cpu, setCpu] = useState<number[]>([]);
  const [ram, setRam] = useState<number[]>([]);
  const [filesOpen, setFilesOpen] = useState(false);
  const [fileActivity, setFileActivity] = useState<AgentFileActivity | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [worktrees, setWorktrees] = useState<WorktreeRegistryActivity | null>(null);
  const [copiedWorktreeId, setCopiedWorktreeId] = useState<number | null>(null);
  // Sort/filter choice persists across panel opens (localStorage optional).
  const [sortState, setSortState] = useState<PulseSortPrefs>(() => readPulseSortPrefs());
  const handleSortKey = (key: PulseSortKey): void => {
    const next: PulseSortPrefs = {
      ...sortState,
      key,
      direction: nextPulseSortDirection(sortState.key, key, sortState.direction),
    };
    setSortState(next);
    writePulseSortPrefs(next);
  };
  const handleFilterKind = (filter: PulseFilterKind): void => {
    const next: PulseSortPrefs = { ...sortState, filter };
    setSortState(next);
    writePulseSortPrefs(next);
  };
  const isBrowser = window.aiTerminal.isBrowser === true;
  // Reveal needs a projectId (revealArtifact requires any existing project);
  // prefer the selected terminal's project, fall back to the first one.
  const revealProjectId = useAppStore((s) => {
    const layout = s.dockLayout;
    const selected = layout?.selectedTerminalId;
    const tile = selected ? layout?.tiles.find((candidate) => candidate.terminalId === selected) : undefined;
    return tile?.projectId ?? s.projects[0]?.id ?? null;
  });
  const canReveal = !isBrowser && revealProjectId !== null;

  // Poll pauses while the window is hidden (or the sidebar collapsed, which
  // unmounts this component) and resumes with an immediate tick on show, so a
  // hidden window burns zero IPC instead of a no-op interval every 2s.
  useEffect(() => {
    let alive = true;
    let intervalId: number | null = null;
    const tick = (): void => {
      void window.aiTerminal.getSystemActivity?.().then((next) => {
        if (!alive || !next) return;
        setActivity(next);
        if (next.cpuPercent !== null) setCpu((prev) => [...prev, next.cpuPercent as number].slice(-HISTORY));
        setRam((prev) => [...prev, next.memPercent].slice(-HISTORY));
      }).catch(() => undefined);
    };
    const start = (): void => {
      if (intervalId !== null) return;
      tick();
      intervalId = window.setInterval(tick, POLL_MS);
    };
    const stop = (): void => {
      if (intervalId === null) return;
      window.clearInterval(intervalId);
      intervalId = null;
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") stop();
      else start();
    };
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // Fetch on open, refresh every 5s while open (pauses when the tab is hidden).
  useEffect(() => {
    if (!filesOpen) return;
    let alive = true;
    const tick = (): void => {
      if (document.visibilityState === "hidden") return;
      void window.aiTerminal.getAgentFileActivity?.().then((next) => {
        if (alive && next) setFileActivity(next);
      }).catch(() => undefined);
    };
    tick();
    const id = window.setInterval(tick, FILES_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [filesOpen]);

  // Session worktree registry: 30s polls only (main already throttles the git
  // scans; worktrees change much slower than files do).
  useEffect(() => {
    if (!filesOpen) return;
    let alive = true;
    const tick = (): void => {
      if (document.visibilityState === "hidden") return;
      void window.aiTerminal.getWorktreeRegistry?.().then((next) => {
        if (alive && next) setWorktrees(next);
      }).catch(() => undefined);
    };
    tick();
    const id = window.setInterval(tick, WORKTREES_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [filesOpen]);

  // "已複製" feedback clears itself; the timeout restarts on every copy.
  useEffect(() => {
    if (copiedId === null) return;
    const id = window.setTimeout(() => setCopiedId(null), 1_600);
    return () => window.clearTimeout(id);
  }, [copiedId]);

  useEffect(() => {
    if (copiedWorktreeId === null) return;
    const id = window.setTimeout(() => setCopiedWorktreeId(null), 1_600);
    return () => window.clearTimeout(id);
  }, [copiedWorktreeId]);

  const W = 240;
  const H = 44;
  const cpuNow = activity?.cpuPercent ?? null;
  const memNow = activity?.memPercent ?? null;
  const since = activity?.since ? new Date(activity.since) : null;
  const sinceText = since ? `${String(since.getHours()).padStart(2, "0")}:${String(since.getMinutes()).padStart(2, "0")}` : "--:--";
  const rawEntries = fileActivity?.files ?? [];
  const remaining = fileActivity ? Math.max(0, fileActivity.total - rawEntries.length) : 0;
  const entries = sortPulseEntries(filterPulseEntries(rawEntries, sortState.filter), sortState.key, sortState.direction);
  const sessionWorktrees = worktrees?.entries ?? [];
  const removedCount = sessionWorktrees.reduce((n, entry) => n + (entry.removed ? 1 : 0), 0);
  const toggleTitle = `${t(filesOpen ? "skin.pulse.files.toggle.close" : "skin.pulse.files.toggle.open")}\n${t("skin.pulse.tooltip", { time: sinceText })}`;

  return (
    <div className="sm-daylight sm-pulse" aria-label={t("skin.pulse.title")}>
      <button
        type="button"
        className={`sm-pulse-toggle${filesOpen ? " open" : ""}`}
        data-action-id="sidebar.pulse.files.toggle"
        aria-expanded={filesOpen}
        title={toggleTitle}
        onClick={() => setFilesOpen((open) => !open)}
      >
        <span className="sm-daylight-head"><span>{t("skin.pulse.title")}</span><i /></span>
        <span className="sm-pulse-output">
          <b data-testid="sm-pulse-bytes">{formatBytes(activity?.agentBytes ?? 0)}</b>
          <span>{t("skin.pulse.files", { count: (activity?.agentFiles ?? 0).toLocaleString() })}</span>
        </span>
      </button>
      {filesOpen && (
        <div className="sm-pulse-files">
          <p className="sm-pulse-files-note">{t("skin.pulse.list.note")}</p>
          <div className="sm-pulse-controls">
            <div className="sm-pulse-segment" role="group" aria-label={t("skin.pulse.sort.label")}>
              {SORT_ORDER.map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`sm-pulse-seg-btn${sortState.key === key ? " active" : ""}`}
                  data-action-id={`skin.pulse.sort.${key}`}
                  aria-pressed={sortState.key === key}
                  onClick={() => handleSortKey(key)}
                >
                  {t(SORT_LABELS[key])}
                  {sortState.key === key && (
                    <span className="sm-pulse-sort-arrow">{pulseSortArrow(sortState.direction)}</span>
                  )}
                </button>
              ))}
            </div>
            <div className="sm-pulse-segment" role="group" aria-label={t("skin.pulse.filter.label")}>
              {FILTER_ORDER.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={`sm-pulse-seg-btn${sortState.filter === kind ? " active" : ""}`}
                  data-action-id={`skin.pulse.filter.${kind}`}
                  aria-pressed={sortState.filter === kind}
                  onClick={() => handleFilterKind(kind)}
                >
                  {t(FILTER_LABELS[kind])}
                </button>
              ))}
            </div>
          </div>
          {entries.length === 0 && fileActivity !== null ? (
            <p className="sm-pulse-files-empty">
              {rawEntries.length === 0
                ? t("skin.pulse.list.empty")
                : t("skin.pulse.list.filter.empty")}
            </p>
          ) : (
            <>
              <ul className="sm-pulse-files-list">
                {entries.map((entry, index) => {
                  const { dir, name } = splitPath(entry.path);
                  const dirText = dir.length > MAX_DIR_CHARS ? `…${dir.slice(-MAX_DIR_CHARS)}` : dir;
                  const copied = copiedId === index;
                  const growth = formatGrowthDelta(entry);
                  return (
                    <li key={`${name}:${index}`}>
                      <button
                        type="button"
                        className={`sm-pulse-file${copied ? " copied" : ""}`}
                        data-action-id={`sidebar.pulse.row:${index}`}
                        title={`${entry.path}\n${t("skin.pulse.row.copy")}`}
                        onClick={() => {
                          setCopiedId(index);
                          void copyTextToClipboard(entry.path);
                        }}
                      >
                        <span className="sm-pulse-file-name">{copied ? t("skin.pulse.row.copied") : name}</span>
                        {dirText !== "" && <span className="sm-pulse-file-dir">{dirText}</span>}
                        <span className="sm-pulse-file-meta">
                          <span className={`sm-pulse-file-tag${entry.kind === "created" ? " new" : ""}`}>
                            {entry.kind === "created" ? t("skin.pulse.file.new") : t("skin.pulse.file.modified")}
                          </span>
                          {growth !== "" && <span className="sm-pulse-file-growth">{growth}</span>}
                          <span>{formatBytes(entry.size)}</span>
                          <span>{formatTime(entry.mtimeMs)}</span>
                        </span>
                      </button>
                      {canReveal && (
                        <button
                          type="button"
                          className="icon-button sm-pulse-file-reveal"
                          data-action-id={`sidebar.pulse.row.reveal:${index}`}
                          title={t("artifact.reveal.title")}
                          onClick={() => {
                            if (revealProjectId) void window.aiTerminal.revealArtifact({ projectId: revealProjectId, path: entry.path });
                          }}
                        >
                          <FolderOpen size={15} />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {remaining > 0 && <p className="sm-pulse-files-more">{t("skin.pulse.list.more", { count: remaining.toLocaleString() })}</p>}
            </>
          )}
        </div>
      )}
      {filesOpen && sessionWorktrees.length > 0 && (
        <div className="sm-pulse-worktrees">
          <p className="sm-pulse-worktrees-title">
            {t("skin.pulse.worktrees.summary", {
              total: sessionWorktrees.length,
              removed: removedCount,
              active: sessionWorktrees.length - removedCount,
            })}
          </p>
          <ul className="sm-pulse-worktrees-list">
            {sessionWorktrees.map((entry, index) => {
              const { dir, name } = splitPath(entry.path);
              const dirText = dir.length > MAX_DIR_CHARS ? `…${dir.slice(-MAX_DIR_CHARS)}` : dir;
              const copied = copiedWorktreeId === index;
              return (
                <li key={`${name}:${index}`}>
                  <button
                    type="button"
                    className={`sm-pulse-file${copied ? " copied" : ""}`}
                    data-action-id={`sidebar.pulse.worktree.row:${index}`}
                    title={`${entry.path}\n${t("skin.pulse.worktrees.copy")}`}
                    onClick={() => {
                      setCopiedWorktreeId(index);
                      void copyTextToClipboard(entry.path);
                    }}
                  >
                    <span className="sm-pulse-file-name">{copied ? t("skin.pulse.row.copied") : name}</span>
                    {dirText !== "" && <span className="sm-pulse-file-dir">{dirText}</span>}
                    <span className="sm-pulse-file-meta">
                      {entry.branch === null && (
                        <span className="sm-pulse-file-tag">{t("skin.pulse.worktrees.detached")}</span>
                      )}
                      <span className={`sm-pulse-file-tag${entry.removed ? "" : " new"}`}>
                        {entry.removed ? t("skin.pulse.worktrees.removed") : t("skin.pulse.worktrees.active")}
                      </span>
                      {entry.dirty !== null && (
                        <span className={`sm-pulse-file-tag${entry.dirty ? " new" : ""}`}>
                          {entry.dirty ? t("skin.pulse.worktrees.dirty") : t("skin.pulse.worktrees.clean")}
                        </span>
                      )}
                      {entry.dirty === null && (
                        <span className="sm-pulse-file-tag">{t("skin.pulse.worktrees.dirty.unknown")}</span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <line className="sm-horizon" x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} />
        <path className="sm-pulse-cpu-fill" d={seriesPath(cpu, W, H, true)} />
        <path className="sm-pulse-cpu" d={seriesPath(cpu, W, H, false)} />
        <path className="sm-pulse-ram" d={seriesPath(ram, W, H, false)} />
      </svg>
      <div className="sm-daylight-row">
        <span className="sm-pulse-cpu-label">CPU <b>{cpuNow === null ? "--" : `${cpuNow}%`}</b></span>
        <span className="sm-pulse-ram-label">RAM <b>{memNow === null ? "--" : `${memNow}%`}</b>
          {activity && activity.memTotalBytes > 0 ? ` · ${formatBytes(activity.memUsedBytes)}` : ""}</span>
      </div>
    </div>
  );
}
