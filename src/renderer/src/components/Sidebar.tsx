import {
  Archive,
  ArchiveX,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  History,
  Layers,
  List,
  LoaderCircle,
  LocateFixed,
  MoreHorizontal,
  Pencil,
  Play,
  Pin,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isPendingProject, useAppStore } from "../store/app-store";
import { useI18n } from "../i18n";
import type { MessageKey, TranslationVariables } from "../i18n";
import { canResumeProfile } from "./interactive-agent";
import { ptySignalTone, ptyStateLabelKey } from "./pty-state-label";
import {
  READING_DRAG_MIME,
  SESSION_DRAG_MIME,
  SESSION_GROUP_DRAG_MIME,
  openSessionGroup,
  openSessionResumed,
  resumableSessions,
} from "./sidebar-sessions";
import type { GlobalSearchResult, ProjectHistorySession, AttentionNotification } from "@shared/types";
import { MOBILE_LAYOUT_QUERY } from "./terminal-responsive";
import { SunMoonMark, SunMoonPulse } from "./SunMoonChrome";
import { UsageHud } from "./usage-hud";
import { shellExecutableName } from "./terminal-display-title";
import { canApplySearchGeneration } from "./search-generation";
import { formatAppVersionLabel } from "./app-version-label";
import { shouldDeferGlobalShortcut } from "./global-shortcut-guard";
import { readSidebarViewMode, writeSidebarViewMode, type SidebarViewMode } from "./sidebar-view-mode";

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }): React.JSX.Element {
  const {
    projects,
    archivedProjects,
    createProject,
    renameProject,
    pinProject,
    reorderProjects,
    archiveProject,
    restoreProject,
    deleteProject,
    openTile,
    openSandboxAgent,
    openWorktreeDialog,
    setPickerState,
    settings,
    appVersion,
    dockLayout,
    ptyStates,
  } = useAppStore();
  const { t } = useI18n();
  // f2: sidebar session branches are a DESKTOP feature (HTML5 drag into the
  // dock). Web/mobile keep the fullscreen history panel untouched.
  const isDesktop = !window.aiTerminal.isBrowser;
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<GlobalSearchResult[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [indexSyncing, setIndexSyncing] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [projectNameDraft, setProjectNameDraft] = useState("");
  const [historyProjectId, setHistoryProjectId] = useState<string | null>(null);
  const [historySessions, setHistorySessions] = useState<ProjectHistorySession[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyHighlightId, setHistoryHighlightId] = useState<string | null>(null);
  const [actionsProjectId, setActionsProjectId] = useState<string | null>(null);
  // The project "…" menu closes on any press outside it (or Esc), like a
  // normal popup menu. Presses on the menu itself or its "…" toggle are left
  // to their own handlers so the toggle still works as open/close.
  useEffect(() => {
    if (!actionsProjectId) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".project-more-menu, [data-action-id=\"sidebar.project.actions.open\"]")) return;
      setActionsProjectId(null);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setActionsProjectId(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [actionsProjectId]);
  const [viewMode, setViewMode] = useState<SidebarViewMode>(readSidebarViewMode);
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [dragOverProjectId, setDragOverProjectId] = useState<string | null>(null);
  const [attention, setAttention] = useState<AttentionNotification[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchGenerationRef = useRef(0);

  // Attention inbox: hydrate on mount, keep live via push. Only unresolved
  // notifications (need-a-human) are shown; resolved ones drop on next push.
  useEffect(() => {
    let cancelled = false;
    void window.aiTerminal.listAttention().then((list) => {
      if (!cancelled) setAttention(list);
    }).catch(() => undefined);
    const unsubscribe = window.aiTerminal.onAttentionChanged((notification) => {
      setAttention((prev) => {
        const without = prev.filter((n) => n.id !== notification.id);
        return notification.resolvedAt ? without : [notification, ...without];
      });
    });
    return () => { cancelled = true; unsubscribe(); };
  }, []);

  const attentionByProject = useMemo(() => {
    const map = new Map<string, number>();
    for (const n of attention) map.set(n.projectId, (map.get(n.projectId) ?? 0) + 1);
    return map;
  }, [attention]);

  const selectAttention = async (notification: AttentionNotification): Promise<void> => {
    // One-click: jump to the terminal that needs attention, then resolve the
    // notification (the user has seen it). selectTile makes it the active pane.
    await window.aiTerminal.selectTile({ terminalId: notification.terminalId }).catch(() => undefined);
    await window.aiTerminal.resolveAttention({ notificationId: notification.id }).catch(() => undefined);
    closeSidebarOnMobile();
  };

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        // A1: never steal focus out of an xterm (Ctrl+K is \x0B to the shell)
        // or any other text field / IME composition.
        if (shouldDeferGlobalShortcut(event)) return;
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  useEffect(() => {
    const text = query.trim();
    const generation = ++searchGenerationRef.current;
    if (text.length < 2) {
      const resetTimer = setTimeout(() => {
        if (!canApplySearchGeneration(generation, searchGenerationRef.current, false)) return;
        setSearchBusy(false);
        setIndexSyncing(false);
        setSearchResults([]);
      }, 0);
      return () => clearTimeout(resetTimer);
    }
    let cancelled = false;
    let syncPollTimer: ReturnType<typeof setTimeout> | null = null;
    let sawIndexSync = false;
    let searchStarted = false;

    const runSearch = (): void => {
      if (!canApplySearchGeneration(generation, searchGenerationRef.current, cancelled)) return;
      searchStarted = true;
      setSearchBusy(true);
      void window.aiTerminal.search({ query: text, limit: 20 })
        .then((results) => {
          if (canApplySearchGeneration(generation, searchGenerationRef.current, cancelled)) setSearchResults(results);
        })
        .catch(() => {
          if (canApplySearchGeneration(generation, searchGenerationRef.current, cancelled)) setSearchResults([]);
        })
        .finally(() => {
          if (canApplySearchGeneration(generation, searchGenerationRef.current, cancelled)) setSearchBusy(false);
        });
    };

    const watchIndex = (): void => {
      void window.aiTerminal.sessionIndexStatus()
        .then((status) => {
          if (!canApplySearchGeneration(generation, searchGenerationRef.current, cancelled)) return;
          setIndexSyncing(status.syncing);
          if (status.syncing) {
            sawIndexSync = true;
            syncPollTimer = setTimeout(watchIndex, 150);
            return;
          }
          // If the first query read a stale completed snapshot while the
          // sidecar was catching up, refresh exactly once after completion.
          if (sawIndexSync && searchStarted) {
            sawIndexSync = false;
            runSearch();
          }
        })
        .catch(() => {
          if (canApplySearchGeneration(generation, searchGenerationRef.current, cancelled)) setIndexSyncing(false);
        });
    };

    watchIndex();
    const timer = setTimeout(runSearch, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (syncPollTimer) clearTimeout(syncPollTimer);
    };
  }, [query]);

  const filtered = useMemo(
    () =>
      projects.filter((project) =>
        `${project.name} ${project.workspacePath}`.toLowerCase().includes(query.toLowerCase()),
      ),
    [projects, query],
  );
  // 「僅顯示已開啟 session」compact view: every open tile across projects in
  // dock order, search-filtered by the same query as the folder rows.
  const openTileRows = useMemo(() => {
    if (viewMode !== "open") return [];
    return dockLayout.tiles
      .filter((tile) => {
        const project = projects.find((item) => item.id === tile.projectId);
        if (!project) return false;
        return `${project.name} ${project.workspacePath}`.toLowerCase().includes(query.toLowerCase());
      })
      .map((tile) => {
        const project = projects.find((item) => item.id === tile.projectId)!;
        return { tile, projectName: project.name };
      });
  }, [viewMode, dockLayout.tiles, projects, query]);
  const historyProject = projects.find((project) => project.id === historyProjectId) ?? null;
  // f2: sessions of the expanded project that can be (re)opened as tiles.
  const expandedGroup = historyProjectId ? resumableSessions(historySessions) : [];

  const moveProject = (sourceId: string, targetId: string): void => {
    if (sourceId === targetId || query.trim().length > 0) return;
    const source = projects.find((project) => project.id === sourceId);
    const target = projects.find((project) => project.id === targetId);
    if (!source || !target || source.pinned !== target.pinned) return;
    const next = [...projects];
    const from = next.findIndex((project) => project.id === sourceId);
    const to = next.findIndex((project) => project.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    void reorderProjects(next.map((project) => project.id));
  };

  // f2: nativeSessionId → terminalId for sessions LIVE in the dock, for the
  // expanded project. Refreshed on expand, on every real tile add/remove, and
  // on terminalListChanged (markAgent / native-session binding) so open rows
  // highlight (and turn into "focus instead of re-open") instantly.
  const [openSessionTerminals, setOpenSessionTerminals] = useState<Record<string, string>>({});
  const loadOpenSessionTerminals = useCallback((projectId: string): void => {
    void window.aiTerminal.listTerminals(projectId).then((infos) => {
      const tileIds = new Set(useAppStore.getState().dockLayout.tiles.map((tile) => tile.terminalId));
      const map: Record<string, string> = {};
      for (const info of infos) {
        if (info.nativeSessionId && tileIds.has(info.id)) map[info.nativeSessionId] = info.id;
      }
      setOpenSessionTerminals(map);
    }).catch(() => setOpenSessionTerminals({}));
  }, []);
  const dockTileKey = dockLayout.tiles.map((tile) => tile.terminalId).join("|");
  useEffect(() => {
    if (!isDesktop || !historyProjectId) return;
    loadOpenSessionTerminals(historyProjectId);
    // dockTileKey is content-keyed (selection broadcasts must not re-fetch).
  }, [isDesktop, historyProjectId, dockTileKey, loadOpenSessionTerminals]);
  useEffect(() => {
    if (!isDesktop || !historyProjectId) return;
    return window.aiTerminal.onTerminalListChanged((payload) => {
      if (payload?.projectId === historyProjectId) loadOpenSessionTerminals(historyProjectId);
    });
  }, [isDesktop, historyProjectId, loadOpenSessionTerminals]);

  // open-tiles: every project folder lists its LIVE windows directly underneath
  // (desktop only, never collapsed). Tiles come from the mirrored dockLayout;
  // display titles need TerminalInfo, refreshed with ONE cheap dashboard hydrate
  // whenever the tile set changes or main reports a terminal-list change
  // (markAgent / rename). Busy/idle lights read the store's ptyStates — the
  // single onPtyStateChanged subscription — so they stay live for free.
  const [openTileMeta, setOpenTileMeta] = useState<Record<string, { title: string; cwd: string }>>({});
  const refreshOpenTileMeta = useCallback((): void => {
    void window.aiTerminal.getTerminalDashboard().then((entries) => {
      const next: Record<string, { title: string; cwd: string }> = {};
      for (const entry of entries) next[entry.id] = { title: entry.title, cwd: entry.cwd };
      setOpenTileMeta(next);
    }).catch(() => setOpenTileMeta({}));
  }, []);
  useEffect(() => {
    if (!isDesktop) return;
    refreshOpenTileMeta();
    // dockTileKey is content-keyed (selection broadcasts must not re-fetch).
  }, [isDesktop, dockTileKey, refreshOpenTileMeta]);
  useEffect(() => {
    if (!isDesktop) return;
    return window.aiTerminal.onTerminalListChanged(() => refreshOpenTileMeta());
  }, [isDesktop, refreshOpenTileMeta]);

  // An open-tile row focuses its window — same contract as the history branch's
  // focusHistorySession: pin the selection locally, then select through main.
  const focusOpenTile = async (terminalId: string): Promise<void> => {
    useAppStore.getState().noteLocalTileSelection(terminalId);
    await useAppStore.getState().selectTile(terminalId).catch(() => undefined);
    closeSidebarOnMobile();
  };

  const openHistory = (projectId: string): void => {
    setHistoryProjectId(projectId);
    setHistoryBusy(true);
    setHistoryError(null);
    void window.aiTerminal.listProjectSessions(projectId)
      .then(setHistorySessions)
      .catch((error) => {
        setHistorySessions([]);
        setHistoryError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setHistoryBusy(false));
  };

  const closeHistory = (): void => {
    setHistoryProjectId(null);
    setHistoryHighlightId(null);
    setOpenSessionTerminals({});
  };

  const resumeHistorySession = async (session: ProjectHistorySession): Promise<void> => {
    if (!session.nativeSessionId || !canResumeProfile(session.profileId)) return;
    const opened = await openSessionResumed({
      projectId: session.projectId,
      profileId: session.profileId,
      nativeSessionId: session.nativeSessionId,
    });
    if (!opened) {
      setHistoryError(t("sidebar.history.resumeError"));
      return;
    }
    setHistoryError(null);
    // Desktop keeps the inline list open (multi-launch); web keeps the old
    // behavior of closing the fullscreen panel after a resume.
    if (!isDesktop) closeHistory();
    closeSidebarOnMobile();
  };

  // Rule #3: an already-live session never re-opens — clicking focuses its tile.
  const focusHistorySession = async (session: ProjectHistorySession): Promise<void> => {
    const terminalId = session.nativeSessionId ? openSessionTerminals[session.nativeSessionId] : undefined;
    if (!terminalId) return;
    useAppStore.getState().noteLocalTileSelection(terminalId);
    await window.aiTerminal.selectTile({ terminalId }).catch(() => undefined);
    closeSidebarOnMobile();
  };

  if (collapsed) {
    return (
      <aside className="sidebar collapsed">
        <button data-action-id="sidebar.expand" className="sidebar-toggle" title={t("sidebar.expand")} aria-label={t("sidebar.expand")} onClick={onToggle}>
          <ChevronRight size={16} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="brand-mark"><SunMoonMark /></span>
        <div>
          <strong>Coterm</strong>
          <span title={appVersion || undefined}>{formatAppVersionLabel(appVersion)}</span>
        </div>
        <button data-action-id="sidebar.collapse" className="sidebar-toggle" title={t("sidebar.collapse")} aria-label={t("sidebar.collapse")} onClick={onToggle}>
          <ChevronLeft size={15} />
        </button>
      </div>
      <div className="search-field">
        <Search size={14} />
        <input
          data-action-id="sidebar.search.change"
          ref={searchRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("sidebar.search.placeholder")}
          aria-label={t("sidebar.search.aria")}
        />
        <kbd>Ctrl K</kbd>
      </div>
      {query.trim().length >= 2 && (
        <div className="search-results" role="listbox" aria-label={t("sidebar.search.results.aria")}>
          {indexSyncing && <p className="search-indexing">{t("sidebar.search.indexing")}</p>}
          {searchBusy && <p>{t("sidebar.search.busy")}</p>}
          {!searchBusy && searchResults.length === 0 && <p>{t("sidebar.search.empty")}</p>}
          {searchResults.map((result) => (
            <button
              data-action-id="sidebar.search-result.open"
              key={`${result.kind}-${result.id}`}
              type="button"
              onClick={() => {
                if (result.kind === "session" && result.projectId && result.nativeSessionId) {
                  setHistoryHighlightId(result.nativeSessionId);
                  openHistory(result.projectId);
                  return;
                }
                if (result.projectId) {
                  void openTile(result.projectId);
                  closeSidebarOnMobile();
                }
              }}
            >
              <small>{searchKindLabel(result.kind, t)}{searchMeta(result, t)}</small>
              <strong>{result.title}</strong>
              <span>{result.snippet}</span>
            </button>
          ))}
        </div>
      )}
      {attention.length > 0 && (
        <div className="attention-inbox">
          <div className="section-label">
            <span>{t("sidebar.attention.title")}</span>
            <span className="attention-count">{attention.length}</span>
          </div>
          <ul className="attention-list">
            {attention.map((notification) => (
              <li key={notification.id}>
                <button
                  data-action-id="sidebar.attention.item.select"
                  className="attention-item"
                  title={t(`sidebar.attention.${notification.state}` as MessageKey)}
                  onClick={() => void selectAttention(notification)}
                >
                  <span className="attention-state">{t(`sidebar.attention.${notification.state}` as MessageKey)}</span>
                  <small>{projects.find((p) => p.id === notification.projectId)?.name ?? notification.projectId}</small>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="section-label">
        <span>{t("sidebar.projects")}</span>
        <div className="section-actions">
          <button
            data-action-id="sidebar.view.toggle"
            className={`icon-button${viewMode === "open" ? " active" : ""}`}
            aria-pressed={viewMode === "open"}
            title={viewMode === "open" ? t("sidebar.view.toAll") : t("sidebar.view.toOpen")}
            aria-label={viewMode === "open" ? t("sidebar.view.toAll") : t("sidebar.view.toOpen")}
            onClick={() => {
              const next: SidebarViewMode = viewMode === "open" ? "all" : "open";
              setViewMode(next);
              writeSidebarViewMode(next);
            }}
          >
            <List size={14} />
          </button>
          <button data-action-id="sidebar.project.create" className="icon-button" onClick={() => void createProject()} title={t("sidebar.projects.add")}>
            <Plus size={15} />
          </button>
        </div>
      </div>
      <div className="project-list">
        {/* 「僅顯示已開啟 session」compact mode hides the folder rows (the
            flat tile list below replaces them); default "all" keeps the
            original full view. */}
        {viewMode !== "open" && filtered.map((project) => (
          <section className={`project-group${isPendingProject(project) ? " pending" : ""}`} key={project.id}>
            {/* #17: pending placeholder — show instantly after the folder
                picker resolves; swap for the real row when the create IPC
                returns. No actions: the project does not exist in main yet. */}
            {isPendingProject(project) ? (
              <div className="project-row pending">
                <div className="project-main">
                  <span className="project-copy">
                    <strong>{project.name}</strong>
                    <small>{t("sidebar.project.creating")}</small>
                  </span>
                </div>
                <LoaderCircle size={13} className="spin project-pending-icon" aria-hidden="true" />
              </div>
            ) : (
            <>
            <div
              className={`project-row${dragOverProjectId === project.id ? " drag-over" : ""}`}
              draggable={query.trim().length === 0}
              onDragStart={(event) => {
                if (query.trim().length > 0) return;
                setDraggedProjectId(project.id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", project.id);
              }}
              onDragOver={(event) => {
                if (!draggedProjectId || draggedProjectId === project.id) return;
                const dragged = projects.find((item) => item.id === draggedProjectId);
                if (!dragged || dragged.pinned !== project.pinned) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDragOverProjectId(project.id);
              }}
              onDragLeave={() => setDragOverProjectId((current) => current === project.id ? null : current)}
              onDrop={(event) => {
                event.preventDefault();
                const sourceId = draggedProjectId || event.dataTransfer.getData("text/plain");
                moveProject(sourceId, project.id);
                setDraggedProjectId(null);
                setDragOverProjectId(null);
              }}
              onDragEnd={() => {
                setDraggedProjectId(null);
                setDragOverProjectId(null);
              }}
            >
              {editingProjectId === project.id ? (
                <form
                  data-action-id="sidebar.project.rename.submit"
                  className="project-rename-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const name = projectNameDraft.trim();
                    if (name) void renameProject(project.id, name);
                    setEditingProjectId(null);
                  }}
                >
                  <input
                    data-action-id="sidebar.project.rename.change"
                    autoFocus
                    aria-label={t("sidebar.project.name.aria")}
                    value={projectNameDraft}
                    onChange={(event) => setProjectNameDraft(event.target.value)}
                    onBlur={() => setEditingProjectId(null)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setEditingProjectId(null);
                    }}
                  />
                </form>
              ) : (
                <div
                  data-action-id="sidebar.project.rename.start"
                  data-action-trigger="doubleclick"
                  className="project-main"
                  onDoubleClick={() => {
                    setProjectNameDraft(project.name);
                    setEditingProjectId(project.id);
                  }}
                >
                  <span className="project-copy">
                    <strong>{project.name}</strong>
                    <small>{project.workspacePath}</small>
                  </span>
                  {(attentionByProject.get(project.id) ?? 0) > 0 && (
                    <span className="project-attention-badge" title={t("sidebar.attention.title")}>
                      {attentionByProject.get(project.id)}
                    </span>
                  )}
                </div>
              )}
              <div className="project-actions">
                <button
                  data-action-id="sidebar.project.open-agent"
                  title={t("sidebar.project.openTerminal")}
                  aria-label={t("sidebar.project.openTerminal.aria", { name: project.name })}
                  onClick={() => {
                    // Open a plain PTY first, then show the LLM picker so the
                    // user can choose to launch an agent into it or keep it plain.
                    void openTile(project.id).then((layout) => {
                      if (!layout?.selectedTerminalId) return;
                      setPickerState({
                        paneId: layout.selectedTerminalId,
                        projectId: project.id,
                        ...(settings ? { preselect: settings.defaultProvider } : {}),
                      });
                    });
                    closeSidebarOnMobile();
                  }}
                >
                  <Plus size={13} />
                </button>
                <button
                  data-action-id="sidebar.project.history.open"
                  title={t("sidebar.project.history")}
                  aria-label={t("sidebar.project.history.aria", { name: project.name })}
                  onClick={() => openHistory(project.id)}
                >
                  <History size={14} />
                </button>
                <button
                  data-action-id="sidebar.project.actions.open"
                  className={actionsProjectId === project.id ? "selected" : ""}
                  title={t("sidebar.project.more")}
                  aria-label={t("sidebar.project.more.aria", { name: project.name })}
                  aria-expanded={actionsProjectId === project.id}
                  onClick={() => setActionsProjectId(actionsProjectId === project.id ? null : project.id)}
                >
                  <MoreHorizontal size={14} />
                </button>
              </div>
              {actionsProjectId === project.id && (
                <div className="project-more-menu">
                  <button
                    data-action-id="sidebar.project.open-sandbox"
                    type="button"
                    title={t("sidebar.project.openSandbox")}
                    onClick={() => {
                      setActionsProjectId(null);
                      const profile = settings?.defaultProvider ?? "claude-local-main";
                      void openSandboxAgent(project.id, profile).then((layout) => {
                        if (!layout?.selectedTerminalId) return;
                        setPickerState({
                          paneId: layout.selectedTerminalId,
                          projectId: project.id,
                          ...(settings ? { preselect: settings.defaultProvider } : {}),
                        });
                      });
                      closeSidebarOnMobile();
                    }}
                  >
                    <Plus size={14} />{t("sidebar.project.openSandbox")}
                  </button>
                  <button
                    data-action-id="sidebar.project.manage-sandboxes"
                    type="button"
                    title={t("sidebar.project.manageSandboxes")}
                    onClick={() => {
                      setActionsProjectId(null);
                      void openWorktreeDialog(project.id);
                      closeSidebarOnMobile();
                    }}
                  >
                    <GitBranch size={14} />{t("sidebar.project.manageSandboxes")}
                  </button>
                  <button
                    data-action-id="sidebar.project.rename"
                    type="button"
                    onClick={() => {
                      setProjectNameDraft(project.name);
                      setEditingProjectId(project.id);
                      setActionsProjectId(null);
                    }}
                  >
                    <Pencil size={14} />{t("sidebar.project.rename")}
                  </button>
                  <button
                    data-action-id="sidebar.project.pin-toggle"
                    type="button"
                    onClick={() => {
                      void pinProject(project.id, !project.pinned);
                      setActionsProjectId(null);
                    }}
                  >
                    <Pin size={14} fill={project.pinned ? "currentColor" : "none"} />
                    {project.pinned ? t("sidebar.project.unpin") : t("sidebar.project.pin")}
                  </button>
                  <button
                    data-action-id="sidebar.project.archive"
                    type="button"
                    onClick={() => {
                      setActionsProjectId(null);
                      if (window.confirm(t("sidebar.project.archive.confirm", { name: project.name }))) {
                        void archiveProject(project.id);
                      }
                    }}
                  >
                    <ArchiveX size={14} />{t("sidebar.project.archive")}
                  </button>
                  <button
                    data-action-id="sidebar.project.delete"
                    type="button"
                    onClick={() => {
                      setActionsProjectId(null);
                      if (window.confirm(t("sidebar.project.delete.confirm", { name: project.name }))) {
                        void deleteProject(project.id);
                      }
                    }}
                  >
                    <Trash2 size={14} />{t("sidebar.project.delete")}
                  </button>
                </div>
              )}
            </div>
            {/* open-tiles: this project's LIVE windows, always listed under the
                folder (no collapse, no empty state). Lights reuse the TopBar
                pty-signal classes verbatim; click focuses the tile. Projects
                with no open window render nothing — the sidebar stays lean.
                1.5.48: a row also DRAGS — dropping it onto a reading-mode slot
                puts that live window straight into the slot (maintainer: 從左邊拖
                比下方閱讀匣直覺). The MIME is disjoint from project-row reorder
                (text/plain) and session MIMEs, so those surfaces ignore it. */}
            {isDesktop && dockLayout.tiles.some((tile) => tile.projectId === project.id) && (
              <ul className="project-open-tiles">
                {dockLayout.tiles
                  .filter((tile) => tile.projectId === project.id)
                  .map((tile) => {
                    const state = ptyStates[tile.terminalId] ?? null;
                    const labelKey = ptyStateLabelKey(state);
                    const name = openTileDisplayName(openTileMeta[tile.terminalId], tile.terminalId);
                    const isActive = dockLayout.selectedTerminalId === tile.terminalId;
                    return (
                      <li key={tile.terminalId}>
                        <button
                          data-action-id="sidebar.open-tile.focus"
                          type="button"
                          className={`project-open-tile-row${isActive ? " active" : ""}`}
                          title={labelKey ? `${name} · ${t(labelKey)}` : name}
                          draggable
                          onDragStart={(event) => {
                            event.dataTransfer.setData(READING_DRAG_MIME, tile.terminalId);
                            event.dataTransfer.effectAllowed = "move";
                          }}
                          onClick={() => void focusOpenTile(tile.terminalId)}
                        >
                          <span
                            className={`pty-signal pty-signal-${ptySignalTone(state)}${state === "error" ? " is-error" : ""}`}
                            aria-hidden="true"
                          />
                          <span className="project-open-tile-copy">
                            <strong>{name}</strong>
                            {tile.agentProfile ? <small>{tile.agentProfile}</small> : null}
                          </span>
                        </button>
                      </li>
                    );
                  })}
              </ul>
            )}
            {/* f2: inline session branch (desktop). Rows = one session each;
                open rows highlight and focus their tile; closed rows resume as a
                new tile on click, or drag into the dock. The group handle opens
                (click) / drags the WHOLE folder's resumable sessions at once.
                Drag payloads use session MIMEs, disjoint from the project-row
                reorder's text/plain, so folder drag-to-sort is untouched. */}
            {isDesktop && historyProjectId === project.id && (
              <div className="project-sessions">
                <div className="project-sessions-header">
                  <span className="project-sessions-title">
                    {t("sidebar.history.title")}
                    {!historyBusy && !historyError && (
                      <span className="project-sessions-count">{historySessions.length}</span>
                    )}
                  </span>
                  <button
                    data-action-id="sidebar.sessions.group.open"
                    type="button"
                    className="project-sessions-group"
                    title={t("sidebar.sessions.group.hint")}
                    aria-label={t("sidebar.sessions.group.hint")}
                    disabled={expandedGroup.length === 0}
                    draggable={expandedGroup.length > 0}
                    onDragStart={(event) => {
                      event.dataTransfer.setData(
                        SESSION_GROUP_DRAG_MIME,
                        JSON.stringify({ projectId: project.id, sessions: expandedGroup }),
                      );
                      event.dataTransfer.effectAllowed = "copy";
                    }}
                    onClick={() => {
                      void openSessionGroup(project.id, expandedGroup);
                      closeSidebarOnMobile();
                    }}
                  >
                    <Layers size={13} />
                  </button>
                  <HistoryCloseButton label={t("sidebar.history.close.aria")} onClose={closeHistory} />
                </div>
                {historyBusy && <p className="project-sessions-empty">{t("sidebar.history.loading")}</p>}
                {historyError && <p className="project-sessions-empty">{historyError}</p>}
                {!historyBusy && !historyError && historySessions.length === 0 && (
                  <p className="project-sessions-empty">{t("sidebar.history.empty")}</p>
                )}
                {!historyBusy && !historyError && historySessions.length > 0 && (
                  <ul className="project-sessions-list">
                    {historySessions.map((session) => {
                      const openTerminalId = session.nativeSessionId
                        ? openSessionTerminals[session.nativeSessionId]
                        : undefined;
                      const isOpen = Boolean(openTerminalId);
                      const canResume = Boolean(session.nativeSessionId) && canResumeProfile(session.profileId);
                      const highlighted = Boolean(session.nativeSessionId) && session.nativeSessionId === historyHighlightId;
                      return (
                        <li key={session.providerSessionId ?? session.historyKey ?? session.nativeSessionId}>
                          <button
                            data-action-id="sidebar.session.open"
                            type="button"
                            className={`project-session-row${isOpen ? " open" : ""}${highlighted ? " highlighted" : ""}`}
                            disabled={!isOpen && !canResume}
                            draggable={!isOpen && canResume}
                            onDragStart={(event) => {
                              if (!session.nativeSessionId) return;
                              event.dataTransfer.setData(
                                SESSION_DRAG_MIME,
                                JSON.stringify({
                                  projectId: project.id,
                                  profileId: session.profileId,
                                  nativeSessionId: session.nativeSessionId,
                                }),
                              );
                              event.dataTransfer.effectAllowed = "copy";
                            }}
                            onClick={() => void (isOpen ? focusHistorySession(session) : resumeHistorySession(session))}
                            title={isOpen
                              ? t("sidebar.sessions.open.hint")
                              : canResume ? t("sidebar.history.resume") : t("sidebar.history.resume.disabled")}
                            ref={highlighted ? (el) => { el?.scrollIntoView({ block: "center" }); } : undefined}
                          >
                            <span className="project-session-copy">
                              <strong>{session.conversationName}</strong>
                              <small>{`${session.profileId} · ${historyMeta(session)}`}</small>
                            </span>
                            {isOpen ? <LocateFixed size={13} /> : canResume ? <Play size={13} /> : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
            </>
            )}
          </section>
        ))}
        {viewMode === "open" && (openTileRows.length > 0 ? (
          <ul className="project-open-tiles compact-open-tiles">
            {openTileRows.map(({ tile, projectName }) => {
              const state = ptyStates[tile.terminalId] ?? null;
              const labelKey = ptyStateLabelKey(state);
              const name = openTileDisplayName(openTileMeta[tile.terminalId], tile.terminalId);
              const isActive = dockLayout.selectedTerminalId === tile.terminalId;
              return (
                <li key={tile.terminalId}>
                  <button
                    data-action-id="sidebar.open-tile.flat-focus"
                    type="button"
                    className={`project-open-tile-row${isActive ? " active" : ""}`}
                    title={labelKey ? `${name} · ${t(labelKey)}` : name}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData(READING_DRAG_MIME, tile.terminalId);
                      event.dataTransfer.effectAllowed = "move";
                    }}
                    onClick={() => void focusOpenTile(tile.terminalId)}
                  >
                    <span
                      className={`pty-signal pty-signal-${ptySignalTone(state)}${state === "error" ? " is-error" : ""}`}
                      aria-hidden="true"
                    />
                    <span className="project-open-tile-copy">
                      <strong>{name}</strong>
                      <small>{projectName}{tile.agentProfile ? ` · ${tile.agentProfile}` : ""}</small>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="compact-open-empty">{t("sidebar.view.openEmpty")}</p>
        ))}
        {projects.length === 0 && (
          <button data-action-id="sidebar.project.create-empty" className="empty-project" onClick={() => void createProject()}>
            <Plus size={18} />
            {t("sidebar.project.empty")}
          </button>
        )}
      </div>
      {/* Usage meters moved out of the top bar: a compact stack at the sidebar
          foot, next to the 本次產出/CPU area. The collapsed rail hides them by
          design (this whole block is the expanded branch). */}
      <div className="sidebar-usage" data-testid="sidebar-usage">
        <UsageHud />
      </div>
      <SunMoonPulse />
      <button
        data-action-id="sidebar.archive.toggle"
        className="sidebar-footer-button"
        aria-expanded={archiveOpen}
        onClick={() => setArchiveOpen(!archiveOpen)}
      >
        <Archive size={14} />{t("sidebar.archive.section")}
        {archiveOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {archiveOpen && (
        <div className="archive-list">
          {archivedProjects.map((project) => (
            <div className="archive-row" key={project.id}>
              <span>{project.name}</span>
              <button data-action-id="sidebar.archive.restore" title={t("sidebar.archive.restore")} onClick={() => void restoreProject(project.id)}>
                <RotateCcw size={12} />
              </button>
            </div>
          ))}
          {archivedProjects.length === 0 && (
            <p>{t("sidebar.archive.empty")}</p>
          )}
          <small>{t("sidebar.archive.hint")}</small>
        </div>
      )}
      {/* Fullscreen history panel: web/mobile only — desktop shows the inline
          session branch instead (f2). */}
      {historyProject && !isDesktop && createPortal(
        <div className="project-history-overlay" role="dialog" aria-modal="true" aria-label={t("sidebar.history.dialog.aria")}>
          <section className="project-history-panel">
            <header>
              <div>
                <strong>{historyProject.name}</strong>
                <span>{t("sidebar.history.title")}</span>
              </div>
              <HistoryCloseButton label={t("sidebar.history.close.aria")} onClose={closeHistory} />
            </header>
            {historyBusy && <p className="project-history-empty">{t("sidebar.history.loading")}</p>}
            {historyError && <p className="project-history-empty">{historyError}</p>}
            {!historyBusy && !historyError && historySessions.length === 0 && (
              <p className="project-history-empty">{t("sidebar.history.empty")}</p>
            )}
            {!historyBusy && !historyError && historySessions.length > 0 && (
              <div className="project-history-columns">
                {groupHistorySessions(historySessions).map(([profileId, sessions]) => (
                  <section className="project-history-column" key={profileId}>
                    <h3>{profileId}</h3>
                    {sessions.map((session) => {
                      const canResume = Boolean(session.nativeSessionId) && canResumeProfile(session.profileId);
                      return (
                        <article
                          className={`project-history-card${session.nativeSessionId && session.nativeSessionId === historyHighlightId ? " highlighted" : ""}`}
                          key={session.providerSessionId ?? session.historyKey ?? session.nativeSessionId}
                          ref={session.nativeSessionId && session.nativeSessionId === historyHighlightId
                            ? (el) => { el?.scrollIntoView({ block: "center" }); }
                            : undefined}
                        >
                          <button
                            data-action-id="sidebar.history.resume"
                            type="button"
                            disabled={!canResume}
                            onClick={() => void resumeHistorySession(session)}
                            title={canResume ? t("sidebar.history.resume") : t("sidebar.history.resume.disabled")}
                          >
                            <span>
                              <strong>{session.conversationName}</strong>
                              <small>{session.summary?.recentSummary ?? session.summary?.brief ?? t("sidebar.history.noSummary")}</small>
                              <small>{historyMeta(session)}</small>
                            </span>
                            {canResume && <Play size={13} />}
                          </button>
                          <time dateTime={session.conversationUpdatedAt}>
                            {new Date(session.conversationUpdatedAt).toLocaleString()}
                          </time>
                        </article>
                      );
                    })}
                  </section>
                ))}
              </div>
            )}
          </section>
        </div>,
        document.body,
      )}
    </aside>
  );
}

// One source-side occurrence of this action id: the ui-action catalog requires
// every data-action-id to be unique, and the inline session branch (desktop) and
// the fullscreen history panel (web/mobile) BOTH close history with it.
function HistoryCloseButton({ label, onClose }: { label: string; onClose: () => void }): React.JSX.Element {
  return (
    <button data-action-id="sidebar.history.close" type="button" className="icon-button" aria-label={label} onClick={onClose}>
      <X size={14} />
    </button>
  );
}

function historyMeta(session: ProjectHistorySession): string {
  const size = session.sizeBytes === null ? "DB" : formatBytes(session.sizeBytes);
  const source = session.source === "claude-history" ? "Claude history" : "Coterm DB";
  const t = session.tokenTotals;
  const tokens = t && t.tokensIn + t.tokensOut > 0
    ? ` · ↑${formatTokens(t.tokensIn + t.cacheCreation + t.cacheRead)} ↓${formatTokens(t.tokensOut)}`
    : "";
  return `${source} · ${size}${tokens}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function groupHistorySessions(sessions: ProjectHistorySession[]): Array<[string, ProjectHistorySession[]]> {
  const groups = new Map<string, ProjectHistorySession[]>();
  for (const session of sessions) {
    const key = session.profileId;
    const items = groups.get(key) ?? [];
    items.push(session);
    groups.set(key, items);
  }
  return [...groups.entries()];
}

// Title-first display name for an open tile: agent-authored titles beat the
// cwd basename; both missing (still hydrating) falls back to the raw id tail.
function openTileDisplayName(meta: { title: string; cwd: string } | undefined, terminalId: string): string {
  const title = meta?.title?.trim();
  if (title) return shellExecutableName(title) ?? title;
  const base = (meta?.cwd ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  return base || `pty ${terminalId.slice(-4)}`;
}

function closeSidebarOnMobile(): void {
  if (window.matchMedia(MOBILE_LAYOUT_QUERY).matches) {
    document.querySelector<HTMLElement>(".sidebar-brand .sidebar-toggle")?.click();
  }
}

function searchKindLabel(kind: GlobalSearchResult["kind"], t: (key: MessageKey, vars?: TranslationVariables) => string): string {
  if (kind === "project") return t("sidebar.search.kind.project");
  if (kind === "conversation") return t("sidebar.search.kind.conversation");
  if (kind === "session") return t("sidebar.search.kind.session");
  if (kind === "terminal") return t("sidebar.search.kind.terminal");
  if (kind === "handoff") return t("sidebar.search.kind.handoff");
  if (kind === "artifact") return t("sidebar.search.kind.artifact");
  return t("sidebar.search.kind.event");
}

// Append " · {projectName} · {relative time}" to the kind label when present.
// Only session hits carry these fields today; other kinds get the bare label.
function searchMeta(
  result: GlobalSearchResult,
  t: (key: MessageKey, vars?: TranslationVariables) => string,
): string {
  const parts: string[] = [];
  if (result.projectName) parts.push(result.projectName);
  if (result.updatedAt) {
    const relative = formatRelativeTime(result.updatedAt, t);
    if (relative) parts.push(relative);
  }
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

function formatRelativeTime(
  iso: string,
  t: (key: MessageKey, vars?: TranslationVariables) => string,
): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = Math.floor((Date.now() - then) / 60_000);
  if (minutes < 1) return t("sidebar.search.time.minutesAgo", { n: 0 });
  if (minutes < 60) return t("sidebar.search.time.minutesAgo", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("sidebar.search.time.hoursAgo", { n: hours });
  const days = Math.floor(hours / 24);
  if (days <= 30) return t("sidebar.search.time.daysAgo", { n: days });
  return new Date(then).toLocaleDateString();
}
