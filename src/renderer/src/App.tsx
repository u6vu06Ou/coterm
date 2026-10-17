import { AlertCircle, AlertTriangle, X } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { TerminalDock } from "./components/TerminalDock";
import { ExplorerPanel } from "./components/ExplorerPanel";
import { ArtifactRail } from "./components/ArtifactRail";
import { CheckpointRail } from "./components/CheckpointRail";
import { FirstRunWizard } from "./components/FirstRunWizard";
import { LLMPickerDialog } from "./components/LLMPickerDialog";
import { WorktreeManagerDialog } from "./components/WorktreeManagerDialog";
import { CommandPalette } from "./components/CommandPalette";
import { MobileCommandComposer } from "./components/mobile/MobileCommandComposer";
import { BrowserApprovalDialog } from "./components/BrowserApprovalDialog";
import { useAppStore } from "./store/app-store";
import { resolveTerminalTheme } from "./components/terminal-themes";
import {
  READING_DRAG_MIME,
  SESSION_DRAG_MIME,
  SESSION_GROUP_DRAG_MIME,
  openSessionGroup,
  openSessionResumed,
  parseSessionDragPayload,
  parseSessionGroupDragPayload,
} from "./components/sidebar-sessions";
import { MOBILE_LAYOUT_QUERY, NARROW_LAYOUT_QUERY } from "./components/terminal-responsive";
import { installMobileViewportSync } from "./components/mobile-viewport-sync";
import { shouldDeferGlobalShortcut } from "./components/global-shortcut-guard";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useI18n } from "./i18n";

const SettingsPanel = lazy(() => import("./components/SettingsPanel").then((m) => ({ default: m.SettingsPanel })));

// Keep panels mounted after first use: closing them still runs their cleanup,
// and reopening preserves their drafts.
function DeferredPanels(): React.JSX.Element {
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const [seenSettings, setSeenSettings] = useState(false);
  if (settingsOpen && !seenSettings) setSeenSettings(true);
  return <Suspense fallback={null}>
    {(seenSettings || settingsOpen) && <SettingsPanel />}
  </Suspense>;
}

// 修法方向 B (2026-10-09): one uncaught renderer exception must not blank the
// whole desktop. The outermost boundary swaps in AppErrorFallback; terminal
// content, layout, and selection stay in the main process (single source of
// truth), so a reload restores everything.
export default function App(): React.JSX.Element {
  return (
    <ErrorBoundary source="app" fallback={<AppErrorFallback />}>
      <AppShell />
    </ErrorBoundary>
  );
}

function AppShell(): React.JSX.Element {
  const [sidebarOpen, setSidebarOpen] = useState(
    () => !window.matchMedia(NARROW_LAYOUT_QUERY).matches,
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [explorerResetKey, setExplorerResetKey] = useState(0);
  // f2: sidebar session drop affordance. dragenter/leave fire per descendant,
  // so track a counter — one leave per enter, highlight only while >0.
  const [sessionDropActive, setSessionDropActive] = useState(false);
  const sessionDropDepth = useRef(0);
  // maintainer (2026-09-30): sidebar open-session row → single-window (solo) drop on
  // the same surface, so it gets its own depth counter. One drag never mixes
  // MIME kinds, so both counters stay balanced.
  const [soloDropActive, setSoloDropActive] = useState(false);
  const soloDropDepth = useRef(0);
  // Desktop only: web/mobile never get session drag-and-drop.
  const isDesktop = !window.aiTerminal.isBrowser;
  const {
    initialize,
    loading,
    error,
    clearError,
    settings,
    startupAlerts,
    runningConversationIds,
    readingModeActive,
    setExclusive,
    resourceNotice,
  } = useAppStore(useShallow((s) => ({
    initialize: s.initialize, loading: s.loading, error: s.error,
    clearError: s.clearError, settings: s.settings, startupAlerts: s.startupAlerts,
    runningConversationIds: s.runningConversationIds, readingModeActive: s.readingModeActive,
    setExclusive: s.setExclusive,
    resourceNotice: s.resourceNotice,
  })));
  const connected = useAppStore((s) => !s.readingModeActive &&
    (s.dockLayout.tiles.length === 1 || Boolean(s.dockLayout.exclusiveTerminalId)));
  const { t } = useI18n();

  useEffect(() => {
    const openPreferences = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key === ",") {
        event.preventDefault();
        useAppStore.getState().setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", openPreferences);
    return () => window.removeEventListener("keydown", openPreferences);
  }, []);
  const running = runningConversationIds.length > 0;
  // ponytail: dismissal keyed by the alert TEXT in localStorage — no new RPC, no
  // main-process write to ~/.claude/ALERTS.md (whoever wrote it owns that file).
  // A different alert has a different key, so the next one still shows up.
  const [dismissedAlert, setDismissedAlert] = useState(() => readDismissedAlert());
  const visibleAlerts = startupAlerts && startupAlerts !== dismissedAlert ? startupAlerts : "";

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    const narrow = window.matchMedia(NARROW_LAYOUT_QUERY);
    const closeOnNarrow = () => {
      if (narrow.matches) {
        setSidebarOpen(false);
        recoverSelectedTerminal("sidebar-toggle");
      }
    };
    closeOnNarrow();
    narrow.addEventListener("change", closeOnNarrow);
    return () => narrow.removeEventListener("change", closeOnNarrow);
  }, []);

  // #55 mobile signal for hand-mirrored CSS overlays (artifact preview): raw
  // media queries alone cannot be trusted on desktop — a snapped-narrow window
  // matches max-width: 600px, and content zoom / high effective DPI shrinks a
  // normal wide window's CSS viewport to <=600px with the mouse still attached.
  // The flag is therefore the app's own surface test: compact layout AND coarse
  // primary pointer AND browser surface (window.aiTerminal.isBrowser) = a phone
  // browser tab. Electron desktop never matches (preload leaves isBrowser
  // false), so the full-screen artifact overlay cannot fire there in any window
  // shape; mobile-web keeps it unchanged.
  useEffect(() => {
    const media = window.matchMedia(MOBILE_LAYOUT_QUERY);
    const coarse = window.matchMedia("(pointer: coarse)");
    const sync = () => {
      document.documentElement.dataset.mobileLayout =
        media.matches && coarse.matches && window.aiTerminal.isBrowser ? "1" : "0";
    };
    sync();
    media.addEventListener("change", sync);
    coarse.addEventListener("change", sync);
    return () => {
      media.removeEventListener("change", sync);
      coarse.removeEventListener("change", sync);
      delete document.documentElement.dataset.mobileLayout;
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = settings?.theme ?? "dark";
  }, [settings?.theme]);

  useEffect(() => {
    // 經典 skin 已移除 — 日月（sunmoon）是唯一 skin；attribute 留給 sunmoon-shader。
    document.documentElement.dataset.skin = "sunmoon";
  }, []);

  useEffect(() => {
    const codeTheme = settings?.codeTheme ?? "auto";
    const resolved = codeTheme === "auto"
      ? (settings?.theme === "light" ? "github-light" : "github-dark")
      : codeTheme;
    document.documentElement.dataset.codeTheme = resolved;
  }, [settings?.codeTheme, settings?.theme]);

  useEffect(() => {
    const resolved = resolveTerminalTheme(settings?.terminalTheme, settings?.theme ?? "dark");
    document.documentElement.dataset.terminalTheme = resolved.id;
  }, [settings?.terminalTheme, settings?.theme]);

  // iOS can keep the layout viewport at its pre-keyboard height even while the
  // visible viewport shrinks. Drive the app shell from VisualViewport so the
  // selected PTY cannot remain pinned to the upper half with a black lower half.
  // Implementation lives in installMobileViewportSync (#52): real viewport +
  // container ResizeObserver + safe-area heights only — never fixed ratios.
  useEffect(() => installMobileViewportSync({
    root: document.documentElement,
    media: window.matchMedia(MOBILE_LAYOUT_QUERY),
    win: window,
    viewport: window.visualViewport,
    container: document.getElementById("root"),
    onOrientationChange: () => recoverSelectedTerminal("orientationchange"),
  }), []);

  useEffect(() => {
    const onPaletteShortcut = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.shiftKey && (event.key === "P" || event.key === "p")) {
        // A1: never steal focus out of an xterm or another text field / IME
        // composition — the chord may still be meaningful there.
        if (shouldDeferGlobalShortcut(event)) return;
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    document.addEventListener("keydown", onPaletteShortcut);
    return () => document.removeEventListener("keydown", onPaletteShortcut);
  }, []);

  useEffect(() => {
    const recordAction = (
      event: Event,
      interaction: "click" | "change" | "submit" | "pointerdown" | "doubleclick" | "mousedown" | "keyboard",
    ) => {
      if (!window.aiTerminal.recordUiAction) return;
      const target = event.target instanceof Element ? event.target.closest("[data-action-id]") : null;
      if (!target) return;
      const stableId = target.getAttribute("data-action-id")?.trim();
      const tag = target.tagName.toLowerCase();
      const controlType = target.getAttribute("role") === "button"
        ? "role-button"
        : tag === "a"
          ? "link"
          : (["button", "input", "select", "textarea"].includes(tag) ? tag : "other");
      const surface = window.aiTerminal.isBrowser
        ? (window.matchMedia(NARROW_LAYOUT_QUERY).matches ? "mobile-web" : "web")
        : "desktop";
      void window.aiTerminal.recordUiAction({
        actionId: stableId || "ui.unidentified",
        surface,
        identified: Boolean(stableId),
        controlType: controlType as "button" | "link" | "input" | "select" | "textarea" | "role-button" | "other",
        interaction,
      }).catch(() => undefined);
    };
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || !(event.target instanceof Element)) return;
      const target = event.target.closest<HTMLElement>("[data-action-id]");
      if (!target || target.dataset.actionTrigger || ["input", "select", "textarea"].includes(target.tagName.toLowerCase())) return;
      recordAction(event, "click");
    };
    // Native `change` is commit/blur based for free-text controls (unlike
    // React's synthetic onChange), so typing does not emit one audit per key.
    const onChange = (event: Event) => recordAction(event, "change");
    const onSubmit = (event: SubmitEvent) => recordAction(event, "submit");
    const onDoubleClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const action = event.target.closest("[data-action-id]");
      const trigger = event.target.closest("[data-action-trigger='doubleclick']");
      if (action && action === trigger) recordAction(event, "doubleclick");
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      const action = event.target.closest("[data-action-id]");
      const trigger = event.target.closest("[data-action-trigger='pointerdown']");
      if (action && action === trigger && event.button === 0) recordAction(event, "pointerdown");
    };
    const onMouseDown = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const action = event.target.closest("[data-action-id]");
      const trigger = event.target.closest("[data-action-trigger='mousedown']");
      if (action && action === trigger && event.button === 0) recordAction(event, "mousedown");
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target.closest("[data-action-id]") : null;
      if (!target) return;
      const role = target.getAttribute("role");
      const activatesButton = role === "button" && (event.key === "Enter" || event.key === " ");
      const resizesSeparator = role === "separator" && (event.key === "ArrowLeft" || event.key === "ArrowRight");
      if (activatesButton || resizesSeparator) recordAction(event, "keyboard");
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("change", onChange, true);
    document.addEventListener("submit", onSubmit, true);
    document.addEventListener("dblclick", onDoubleClick, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("change", onChange, true);
      document.removeEventListener("submit", onSubmit, true);
      document.removeEventListener("dblclick", onDoubleClick, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  // 修法方向 B (2026-10-09): forward global renderer errors to coterm.log.
  // Message + truncated stack + origin tag only — never terminal output,
  // conversation text, or detection evidence (logging contract A.2).
  useEffect(() => {
    if (typeof window.aiTerminal?.reportRendererError !== "function") return;
    const send = (message: string, stack: string, source: string): void => {
      void window.aiTerminal
        .reportRendererError?.({
          message: message.slice(0, 2000),
          ...(stack ? { stack: stack.slice(0, 4000) } : {}),
          source,
        })
        .catch(() => undefined);
    };
    const onError = (event: ErrorEvent): void => {
      const error = event.error instanceof Error ? event.error : null;
      send(
        error?.message ?? event.message ?? "Unknown renderer error",
        error?.stack ?? "",
        "window.error",
      );
    };
    const onRejection = (event: PromiseRejectionEvent): void => {
      const reason: unknown = event.reason;
      send(
        reason instanceof Error ? reason.message : `Unhandled rejection: ${String(reason)}`,
        reason instanceof Error && reason.stack ? reason.stack : "",
        "unhandledrejection",
      );
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  if (loading) {
    return (
      <div className="boot-screen">
        <div className="boot-mark">CO</div>
        {/* No version here on purpose: the boot screen renders before
            bootstrap resolves, and a hardcoded one is how "v1.0" survived
            nineteen releases. The real version lands in the sidebar brand. */}
        <strong>Coterm</strong>
        <span>Loading terminal workspace...</span>
      </div>
    );
  }

  return (
    <div className={`app-shell terminal-first ${running ? "agent-running" : ""} ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
      <Sidebar
        collapsed={!sidebarOpen}
        onToggle={() => {
          setSidebarOpen((open) => !open);
          recoverSelectedTerminal("sidebar-toggle");
        }}
      />
      {sidebarOpen ? <PanelResizer /> : <span />}
      {/* 2026-10-10: an explorer render crash stays inside the explorer
          column instead of taking the whole window down to the app fallback. */}
      <ErrorBoundary key={`explorer:${explorerResetKey}`} source="explorer" fallback={<ExplorerErrorFallback onRetry={() => setExplorerResetKey((value) => value + 1)} />}>
        <ExplorerPanel
          selectedPath={null}
          onSelectFolder={() => undefined}
        />
      </ErrorBoundary>
      {/* f2: whole main area is the drop target for sidebar session drags
          (single session or whole-group). MIMEs are session-only, so native
          drops (file drags into xterm) and the reading-mode terminal drag are
          untouched. */}
      <section
        className={`workspace-shell ${connected ? "connected-terminal " : ""}${visibleAlerts ? "has-startup-alerts" : ""}${sessionDropActive ? " session-drop-target" : ""}${soloDropActive ? " solo-drop-target" : ""}`}
        onDragEnter={(event) => {
          if (!isDesktop) return;
          const types = event.dataTransfer.types;
          // maintainer (2026-09-30): a sidebar open-session row dropped on the
          // workspace solos that terminal (設為唯一顯示, 其餘不關). Reading
          // mode is excluded — the reading slots own the terminal drag there,
          // so the bubbling slot drop must not double-handle here.
          if (!readingModeActive && types.includes(READING_DRAG_MIME)) {
            soloDropDepth.current += 1;
            setSoloDropActive(true);
          }
          if (!types.includes(SESSION_DRAG_MIME) && !types.includes(SESSION_GROUP_DRAG_MIME)) return;
          sessionDropDepth.current += 1;
          setSessionDropActive(true);
        }}
        onDragOver={(event) => {
          if (!isDesktop) return;
          const types = event.dataTransfer.types;
          if (!readingModeActive && types.includes(READING_DRAG_MIME)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }
          if (!types.includes(SESSION_DRAG_MIME) && !types.includes(SESSION_GROUP_DRAG_MIME)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={() => {
          if (!isDesktop) return;
          soloDropDepth.current = Math.max(0, soloDropDepth.current - 1);
          if (soloDropDepth.current === 0) setSoloDropActive(false);
          sessionDropDepth.current = Math.max(0, sessionDropDepth.current - 1);
          if (sessionDropDepth.current === 0) setSessionDropActive(false);
        }}
        onDrop={(event) => {
          if (!isDesktop) return;
          soloDropDepth.current = 0;
          setSoloDropActive(false);
          // Solo drop first. Reading mode is excluded — the reading slots own
          // that drag, so a bubbling slot drop never re-handles here. A stale
          // id (terminal closed mid-drag) is a no-op, not a phantom solo.
          const soloId = event.dataTransfer.getData(READING_DRAG_MIME);
          if (soloId && !readingModeActive) {
            event.preventDefault();
            const live = useAppStore.getState().dockLayout.tiles.some((tile) => tile.terminalId === soloId);
            if (live) void setExclusive(soloId);
            return;
          }
          sessionDropDepth.current = 0;
          setSessionDropActive(false);
          const group = parseSessionGroupDragPayload(event.dataTransfer.getData(SESSION_GROUP_DRAG_MIME));
          if (group) {
            event.preventDefault();
            void openSessionGroup(group.projectId, group.sessions);
            return;
          }
          const single = parseSessionDragPayload(event.dataTransfer.getData(SESSION_DRAG_MIME));
          if (single) {
            event.preventDefault();
            void openSessionResumed(single);
          }
        }}
      >
        {visibleAlerts && (
          <div className="startup-alert-banner" role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>{visibleAlerts}</span>
            <button
              data-action-id="app.startup-alert.dismiss"
              type="button"
              className="startup-alert-dismiss"
              aria-label="關閉提示"
              onClick={() => {
                setDismissedAlert(visibleAlerts);
                writeDismissedAlert(visibleAlerts);
              }}
            >
              <X size={14} />
            </button>
          </div>
        )}
        <TopBar />
        <TerminalDock />
      </section>
      <ArtifactRail />
      <CheckpointRail />
      <DeferredPanels />
      <FirstRunWizard />
      <LLMPickerDialog />
      <WorktreeManagerDialog />
      <MobileCommandComposer />
      <BrowserApprovalDialog />
      {paletteOpen && <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />}
      {error && (
        <div className="error-toast" role="alert">
          <AlertCircle size={16} />
          <span>{error}</span>
          <button data-action-id="app.error.dismiss" onClick={clearError}><X size={14} /></button>
        </div>
      )}
      {/* Resource soft-limit toast (2026-10-14): opening one terminal too many
          warns but never blocks. No button — it auto-clears from the store
          after a few seconds, so no data-action-id is needed here. */}
      {resourceNotice && (
        <div className="error-toast resource-toast" role="status">
          <AlertTriangle size={16} />
          <span>{t("dock.resources.saturated", { cpu: resourceNotice.cpu ?? "–", mem: resourceNotice.mem })}</span>
        </div>
      )}
    </div>
  );
}

function PanelResizer(): React.JSX.Element {
  const config = { key: "coterm-sidebar-width", variable: "--sidebar-width", initial: 254, min: 190, max: 440 };
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(config.key));
    return Number.isFinite(saved) && saved > 0
      ? Math.min(config.max, Math.max(config.min, saved))
      : config.initial;
  });
  const drag = useRef<{ x: number; width: number } | null>(null);
  const widthRef = useRef(width);
  const apply = (next: number): void => {
    const value = Math.min(config.max, Math.max(config.min, next));
    widthRef.current = value;
    setWidth(value);
  };

  useEffect(() => {
    document.documentElement.style.setProperty(config.variable, `${width}px`);
  }, [config.variable, width]);

  return (
    <div
      className="sidebar-resizer panel-resizer"
      data-action-id="sidebar.resize"
      data-action-trigger="pointerdown"
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-valuemin={config.min}
      aria-valuemax={config.max}
      aria-valuenow={width}
      tabIndex={0}
      onDoubleClick={() => {
        apply(config.initial);
        localStorage.removeItem(config.key);
        recoverSelectedTerminal("sidebar-resize");
      }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        apply(width + (event.key === "ArrowRight" ? 12 : -12));
        localStorage.setItem(config.key, String(widthRef.current));
        recoverSelectedTerminal("sidebar-resize");
      }}
      onPointerDown={(event) => {
        drag.current = { x: event.clientX, width };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        apply(drag.current.width + event.clientX - drag.current.x);
      }}
      onPointerUp={(event) => {
        drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        localStorage.setItem(config.key, String(widthRef.current));
        recoverSelectedTerminal("sidebar-resize");
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    />
  );
}

function recoverSelectedTerminal(reason: string): void {
  const state = useAppStore.getState();
  const terminalId = state.dockLayout.selectedTerminalId;
  if (terminalId) state.requestTerminalRecovery(terminalId, reason);
}

const DISMISSED_ALERT_KEY = "coterm.startupAlert.dismissed";

// Safari private mode throws on localStorage access; a throw here must not take
// the banner (or the dismiss click) down with it.
function readDismissedAlert(): string {
  try {
    return localStorage.getItem(DISMISSED_ALERT_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeDismissedAlert(value: string): void {
  try {
    localStorage.setItem(DISMISSED_ALERT_KEY, value);
  } catch {
    // Dismissal stays session-only when storage is unavailable.
  }
}

// 修法方向 B (2026-10-09): app-root fallback. useI18n() runs off the zustand
// store (no provider), so this stays legal outside the shell render tree.
function ExplorerErrorFallback({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <aside className="explorer-panel explorer-error-fallback" role="alert">
      <AlertTriangle size={18} />
      <p>{t("explorer.crashed")}</p>
      <button data-action-id="explorer.error.retry" type="button" onClick={onRetry}>
        {t("explorer.crashed.retry")}
      </button>
    </aside>
  );
}

function AppErrorFallback(): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="app-error-screen" role="alert">
      <AlertTriangle size={22} />
      <strong>{t("app.error.screen.title")}</strong>
      <p>{t("app.error.screen.desc")}</p>
      <button data-action-id="app.error.reload" type="button" onClick={() => location.reload()}>
        {t("app.error.screen.reload")}
      </button>
    </div>
  );
}
