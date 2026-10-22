import { parseTerminalTitles } from "./terminal-title-parser";
import { useShallow } from "zustand/react/shallow";
import {
  Terminal as TerminalIcon,
  X,
  Eye,
  EyeOff,
  Palette,
  FileDown,
  Link2,
  Loader2,
  Check,
  Search,
  BookOpen,
  MoreHorizontal,
  Paperclip,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Terminal, type ILink } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { SerializeAddon } from "@xterm/addon-serialize";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { ProgressAddon } from "@xterm/addon-progress";
import { Group, Panel, Separator } from "react-resizable-panels";
import "@xterm/xterm/css/xterm.css";
import type { Attachment, DockLayout, DockTile, TerminalInfo, TerminalSessionInfo, PtyState } from "@shared/types";
import { isInterruptible, isAttentionState, toLegacyPtyState } from "@shared/pty-state";
import { quoteTerminalPath } from "@shared/terminal";
import { useAppStore } from "../store/app-store";
import { terminalFontSizePatch } from "../store/settings-patches";
import { translate, useI18n, type MessageKey, type TranslationVariables } from "../i18n";
import {
  interactiveAgent,
  type InteractiveAgentId,
} from "./interactive-agent";
import { setInteractiveLauncherDir } from "./interactive-agent";
import { READING_DRAG_MIME } from "./sidebar-sessions";
import { buildAgentLaunchWriteInput } from "./launch-write";
import { classifyTerminalPath, findTerminalLinks, multiRowLinkRangeForMatch, multiRowTextAndColumnMap, normalizeTerminalPath, rowHardWrapsInto, type TerminalCellLike, type TerminalLogicalRow } from "./terminal-links";
import { hardWrapAwareSelectionText } from "./terminal-copy";
import { installLinkUnderlineOverlay, type LinkMarkSegment } from "./terminal-link-marks";
import { calculateImeAnchor } from "./terminal-ime-position";
import {
  captureHorizontalScrollLock,
  imeAncestorScrollTargets,
  imeInnerScrollTargets,
  restoreHorizontalScrollLock,
  type ScrollLockEntry,
} from "./terminal-ime-scroll-lock";
import { moveToCellSequence } from "./terminal-click-caret";
import { fontSizeForViewport, isInMobileInputZone, nextPinchFontSize } from "./terminal-mobile-geometry";
import { classifyMobileTerminalGesture } from "./mobile/mobile-input-gesture";
import { mobileInputController } from "./mobile/mobile-input-controller";
import { readMobileInputMode, resolveMobileTapAction } from "./mobile/mobile-input-mode";
import { TERMINAL_TYPOGRAPHY, TERMINAL_FONT_SIZE_MIN, TERMINAL_FONT_SIZE_MAX, resolveTerminalFontStack, loadTerminalFont } from "./terminal-typography";
import { createLightTerminalAnsiNormalizer } from "./terminal-ansi-theme";
import { createEchoCapture } from "./terminal-echo-capture";
import { resolveTerminalTheme } from "./terminal-themes";
import { installTuiDragSelect } from "./terminal-tui-drag-select";
import { clearSharedTextureAtlas, findNewCanvas, releaseWebglCanvas, snapshotCanvases, trackTerminalForAtlas } from "./terminal-gpu";
import { findTuiInputCaret, installTypedLineMarker, type TypedLineMarker } from "./terminal-typed-line";
import { calculateRemoteRows } from "./terminal-remote-rows";
import { nextRemoteFitCorrectionFontSize, nextRemoteFitFontSize } from "./terminal-remote-fit";
import { fitTerminalToHost, readTerminalCellMetrics } from "./terminal-fit";
import { tileHydrationKey } from "./terminal-dock-hydration-key";
import { createComposingGate, createRecoveryScheduler, planRecovery } from "./terminal-recovery";
import { useVoiceDraftSnapshot } from "./voice/voice-draft-state";
import {
  executeRecoveryPlan,
  routeCtrlWheelZoom,
  routeCustomKey,
} from "./terminal-input-routing";
import {
  planSelectionEdit,
  type SelectionCellLike,
  type SelectionEditInput,
  type SelectionEditKey,
  type SelectionEditRow,
} from "./terminal-selection-edit";
import { createTerminalStreamBatcher } from "./terminal-stream-batcher";
import {
  resolveSearchInputAction,
  SEARCH_TYPEAHEAD_DELAY_MS,
  searchOverlayColors,
} from "./terminal-search-key";
import { applyRemoteHorizontalTouchPan, MOBILE_LAYOUT_QUERY, resetRemoteHorizontalPan } from "./terminal-responsive";
import { ptyStateIcon } from "./pty-state-icon";
import { labelColor, labelTitle, nextManualLabel } from "./terminal-label";
import { TerminalReaderOverlay } from "./terminal-reader/TerminalReaderOverlay";
import { terminalReaderController } from "./terminal-reader/terminal-reader-state";
import { TerminalHydrationCoordinator, type TerminalSnapshotInput } from "./terminal-hydration";
import { classifySwipeAxis, SWIPE_AXIS_DECIDE_PX, consumeScrollDelta, installXtermMouseNaNGuard, planTouchWheelEvents, shouldOpenReaderOnSwipe, terminalCellHeight, touchMouseCell, xtermMouseReportingActive, xtermTriggerMouseEvent } from "./terminal-touch-scroll";
import { resolvePaneDisplayTitle, resolveSemanticSessionSummary } from "./terminal-display-title";
import {
  DEFAULT_READING_PRESET_ID,
  READING_PRESETS,
  readingSlotName,
  type ReadingSlotKey,
} from "./reading-mode";

/**
 * Pane-header session summary: the short amber line between cwd and the model
 * badge. Static and ellipsised on every surface — the scrolling recap lives in
 * the mobile PTY-switcher button (TopBar), not here. `font` (sunmoon skin) lets
 * the summary follow the user's terminalFont pick via its resolver stack, which
 * keeps the CJK fallback tail so 中文 titles never render through a Latin face.
 */

// C2: click a file path in terminal output. Previewable types open the in-app
// artifact panel; anything else opens externally (main process guards execs).
//
// Issue #88: the target is often a git C-quoted path that was moved or deleted
// since it was printed, and the main process reports that as a bare
// "Path does not exist." — which reads like a Coterm bug rather than a stale
// link. Recognise the missing-target failures and say what actually happened,
// naming the path so the user can see what was clicked.
const MISSING_TARGET_RE = /does not exist|not found|ENOENT|no such file/i;

function missingTargetMessage(error: unknown, path: string, locale: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!MISSING_TARGET_RE.test(message)) return null;
  return translate(locale, "artifact.error.missing", { path });
}

function openTerminalPath(rawPath: string, projectId: string): void {
  const path = normalizeTerminalPath(rawPath);
  const store = useAppStore.getState();
  // Reveal-in-explorer: regardless of how the file opens, ask the sidebar tree
  // to expand to it (no-op when the path lies outside the project workspace).
  store.requestExplorerReveal(path, projectId);
  // Web pages render properly only in a real browser: with the popout setting
  // on, .html opens in the agent's popped-out window (desktop only — the web
  // client has no such IPC). Anything else, or a failure, keeps the panel.
  const api = window.aiTerminal;
  if (/\.html?$/i.test(path) && store.settings?.agentBrowserWindow === "popout" && !api.isBrowser && typeof api.openInAgentBrowser === "function") {
    // The IPC reports failure as { ok: false } rather than rejecting — both must fall back to the panel.
    const fallback = (): void => store.openArtifact(path, path.split(/[\\/]/).pop() ?? path, projectId);
    void api.openInAgentBrowser(path).then((result) => { if (!result?.ok) fallback(); }, fallback);
    return;
  }
  if (classifyTerminalPath(path) === "artifact") {
    const title = path.split(/[\\/]/).pop() ?? path;
    store.openArtifact(path, title, projectId);
  } else {
    void window.aiTerminal.openArtifactExternal({ projectId, path }).catch((reason: unknown) => {
      // Fall back to the raw message for anything that is not a missing target
      // (permission denied, no default app, …) — those are genuinely unusual
      // and worth showing verbatim.
      store.setError(
        missingTargetMessage(reason, path, store.settings?.locale)
          ?? (reason instanceof Error ? reason.message : String(reason)),
      );
    });
  }
}


const UPLOADABLE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result.replace(/^data:[^,]*,/, "") : "");
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

// Paperclip: type each picked file's path into the PTY (quoted for the
// profile's shell, space-separated, no Enter). Desktop Electron hands us the
// file's real path, so nothing is copied; a browser client has no path, so
// images go through saveUpload and anything else is reported, not dropped.
async function attachFilesToTerminal(files: File[], terminalId: string, profile: TerminalInfo["profile"]): Promise<void> {
  if (files.length === 0) return;
  const paths: string[] = [];
  for (const file of files) {
    try {
      const realPath = window.aiTerminal.getPathForFile?.(file);
      if (realPath) {
        paths.push(realPath);
      } else if (UPLOADABLE_IMAGE_TYPES.has(file.type)) {
        const saved = await window.aiTerminal.saveUpload({ name: file.name, mimeType: file.type as "image/png", dataBase64: await fileToBase64(file) });
        paths.push(saved.localPath);
      } else {
        useAppStore.getState().setError(`無法附加「${file.name}」：網頁版只能附加圖片。`);
      }
    } catch (reason) {
      useAppStore.getState().setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  if (paths.length === 0) return;
  await window.aiTerminal.writeTerminal({
    terminalId,
    data: paths.map((path) => quoteTerminalPath(path, profile)).join(" "),
  });
}

// Bytes written to the PTY for Shift+Enter / Ctrl+Enter. "\n" (LF) bypasses
// xterm's "\r" (which the inner TUI treats as submit). In raw mode Node's
// readline maps "\n" -> key.name='enter' (!= "\r" -> 'return'), so Ink-based
// TUIs (Claude Code) don't fire their key.return submit handler.
// ponytail: ceiling — if "\n" still submits, try "\x1b\r" (ESC+CR, the
// legacy Shift+Enter sequence). Verified against Claude Code (Ink) only.
// (SOFT_NEWLINE_SEQ itself moved to terminal-input-routing.ts — #14 retry.)

// Closing a tile races writes that were already in flight to its id — xterm's
// blur/focus-out bytes, a queued click-caret move, an image paste whose
// saveUpload finished after the close. The main process has already torn the
// PTY down and rejects with "Terminal not found.", which used to surface as an
// unhandledrejection per write (renderer.error, 2026-10-09 exclusive flow).
// Only that one expected rejection is quiet; anything else still logs.
function swallowIfTerminalGone(reason: unknown): void {
  if (reason instanceof Error && reason.message.includes("Terminal not found")) return;
  console.warn("[TerminalDock] terminal write failed:", reason instanceof Error ? reason.message : reason);
}

// Split the flat tile list into rows using the cols structure (each row's
// width-fraction array tells us how many tiles live in that row).
function tilesByRow(layout: DockLayout): DockTile[][] {
  if (layout.tiles.length === 0) return [];

  // A stale resize callback can race a newly-opened tile. Older builds accepted
  // the old cols shape in main, so the switcher showed N terminals while this
  // projection rendered only the first N-1. Never orphan a tile: reconstruct a
  // safe even grid when no column shape exists, and append any uncovered tail
  // to the final row while the authoritative main layout heals itself.
  if (layout.cols.length === 0) {
    const columnCount = Math.ceil(Math.sqrt(layout.tiles.length));
    const rows: DockTile[][] = [];
    for (let offset = 0; offset < layout.tiles.length; offset += columnCount) {
      rows.push(layout.tiles.slice(offset, offset + columnCount));
    }
    return rows;
  }

  const rows: DockTile[][] = [];
  let offset = 0;
  for (let r = 0; r < layout.cols.length; r++) {
    const count = layout.cols[r]?.length ?? 0;
    if (count === 0) continue;
    rows.push(layout.tiles.slice(offset, offset + count));
    offset += count;
  }
  if (offset < layout.tiles.length) {
    const uncovered = layout.tiles.slice(offset);
    if (rows.length === 0) rows.push(uncovered);
    else rows[rows.length - 1] = [...rows[rows.length - 1]!, ...uncovered];
  }
  return rows;
}

// Convert react-resizable-panels layout (Map of id->percentage 0..100) into
// the fraction arrays DockLayout expects (0..1, summing to 1 per row/col).
function layoutToFractions(
  panelLayout: Record<string, number>,
  ids: string[],
): number[] {
  if (ids.length === 0) return [];
  const values = ids.map((id) => panelLayout[id] ?? 100 / ids.length);
  const sum = values.reduce((a, b) => a + b, 0) || 1;
  return values.map((v) => v / sum);
}

// Inverse of layoutToFractions: turn the backend's 0..1 fraction array into the
// percentage Map react-resizable-panels expects as `defaultLayout` (0..100).
// When fractions are missing/empty, falls back to even split so a freshly-
// created Group still lays out evenly.
function fractionsToLayout(fractions: number[], ids: string[]): Record<string, number> {
  if (ids.length === 0) return {};
  const fr = fractions.length === ids.length
    ? fractions
    : Array.from({ length: ids.length }, () => 1 / ids.length);
  return Object.fromEntries(ids.map((id, i) => [id, (fr[i] ?? 1 / ids.length) * 100]));
}

export function TerminalDock({ paneId, cwd }: { paneId?: string; cwd?: string | null }): React.JSX.Element {
  // paneId/cwd props are optional and ignored — the dock is driven entirely
  // by store.dockLayout (synced from the main process). Kept for App.tsx
  // compatibility during the transition.
  void cwd;
  const effectivePaneId = paneId ?? "";

  const { saveAttachment, settings, dockLayout, ptyStates, readingModeActive, syncReadingSlots, reorderTile } = useAppStore(useShallow((s) => ({
    saveAttachment: s.saveAttachment,
    settings: s.settings,
    dockLayout: s.dockLayout,
    ptyStates: s.ptyStates,
    readingModeActive: s.readingModeActive,
    syncReadingSlots: s.syncReadingSlots,
    reorderTile: s.reorderTile,
  })));
  const isMobile = useIsMobile();

  // Per-tile terminal info + scrollback, keyed by terminalId. Hydrated from
  // getTerminalWorkspace(tile.projectId) — tiles can belong to different
  // projects, so we fetch per distinct projectId and merge.
  const [terminalInfo, setTerminalInfo] = useState<Record<string, {
    info: TerminalInfo;
    scrollback: string;
    snapshotRevision: number;
    snapshotReady: boolean;
  }>>({});
  // Canonical PtyState per terminal now lives in the app-store (Issue #2):
  // one dashboard hydrate + one onPtyStateChanged subscription feeds the whole
  // renderer. TerminalDock + TopBar both read state.ptyStates.
  const [busyTiles, setBusyTiles] = useState<Set<string>>(new Set());
  const busyTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // 拖曳排序 hover hint (desktop grid only): id of the tile the dragged pane
  // header is currently hovering. Renderer-local, never persisted — the real
  // move goes through store.reorderTile → main on drop.
  const [reorderHoverId, setReorderHoverId] = useState<string | null>(null);

  const clearBusy = useCallback((terminalId: string): void => {
    const timer = busyTimers.current.get(terminalId);
    if (timer) {
      clearTimeout(timer);
      busyTimers.current.delete(terminalId);
    }
    setBusyTiles((prev) => {
      if (!prev.has(terminalId)) return prev;
      const next = new Set(prev);
      next.delete(terminalId);
      return next;
    });
  }, []);

  const markBusy = useCallback((terminalId: string): void => {
    const existing = busyTimers.current.get(terminalId);
    if (existing) clearTimeout(existing);
    setBusyTiles((prev) => prev.has(terminalId) ? prev : new Set(prev).add(terminalId));
    busyTimers.current.set(terminalId, setTimeout(() => clearBusy(terminalId), 30_000));
  }, [clearBusy]);

  useEffect(() => () => {
    for (const timer of busyTimers.current.values()) clearTimeout(timer);
    busyTimers.current.clear();
  }, []);

  // PtyState is no longer hydrated here — see app-store.hydratePtyStates +
  // the single onPtyStateChanged subscription in initialize() (Issue #2).

  const selectTile = useCallback((terminalId: string): void => {
    // voicefix: onActivate only fires from local pointer gestures (tile
    // pointer-up, reader-eye click), so this pins the terminal as THIS window's
    // voice target. Synchronous, before the IPC round trip, so "click tile then
    // immediately tap talk" still locks this tile.
    useAppStore.getState().noteLocalTileSelection(terminalId);
    void window.aiTerminal.selectTile({ terminalId }).catch(() => undefined);
  }, []);

  const closeTile = useCallback(async (terminalId: string): Promise<void> => {
    await window.aiTerminal.closeTile({ terminalId }).catch(() => undefined);
    clearBusy(terminalId);
  }, [clearBusy]);

  // #51: learn the generated launcher-shim dir once so +agent pastes a short
  // shim call instead of the env wall. Failure → inline fallback everywhere.
  useEffect(() => {
    window.aiTerminal.getAgentLauncherDir?.()
      .then((dir) => setInteractiveLauncherDir(dir))
      .catch(() => undefined);
  }, []);

  // Hydrate terminal info for all tiles. Fetches workspace per distinct
  // projectId, then maps terminalId -> {info, scrollback}.
  //
  // ponytail: effect depends on hydrationKey (a stable content string), NOT on
  // dockLayout.tiles array identity. The web/mobile dockLayout arrives via
  // WebSocket JSON.parse — every broadcast is a fresh tiles array even when
  // content is unchanged, so depending on identity re-runs this effect, whose
  // cleanup cancels in-flight RPCs. On WiFi/Tailscale the next broadcast lands
  // before the RPC returns, so terminalInfo never populates -> permanent
  // "Loading terminal...". Content key means only real tile add/remove/swap
  // re-hydrates; a mere selection change (which re-broadcasts layout) does not.
  const hydrationKey = useMemo(() => tileHydrationKey(dockLayout.tiles), [dockLayout.tiles]);
  // Tab ↔ pane mapping: the top-bar tabs render in dockLayout.tiles order, so
  // each pane header shows the same 1-based number (desktop only).
  const paneNumbers = useMemo(() => {
    const map = new Map<string, number>();
    dockLayout.tiles.forEach((tile, index) => map.set(tile.terminalId, index + 1));
    return map;
  }, [dockLayout.tiles]);
  // Bumped by the WS reconnect signal (browser-api "coterm:rehydrate") and by
  // the placeholder's retry button, so a network recovery re-runs hydrate even
  // after its own retries have been exhausted (#24).
  const [rehydrateTick, setRehydrateTick] = useState(0);
  useEffect(() => {
    const bump = () => setRehydrateTick((n) => n + 1);
    window.addEventListener("coterm:rehydrate", bump);
    return () => window.removeEventListener("coterm:rehydrate", bump);
  }, []);
  useEffect(() => {
    const projectIds = [...new Set(dockLayout.tiles.map((t) => t.projectId))];
    let cancelled = false;
    const retryTimers: ReturnType<typeof setTimeout>[] = [];
    const fetchProject = (projectId: string, attempt: number): void => {
      void window.aiTerminal.getTerminalWorkspace(projectId).then((workspace) => {
        if (cancelled) return;
        setTerminalInfo((prev) => {
          const next = { ...prev };
          for (const info of workspace.terminals) {
            next[info.id] = {
              info,
              scrollback: workspace.scrollback[info.id] ?? "",
              snapshotRevision: workspace.scrollbackRevision?.[info.id] ?? 0,
              snapshotReady: true,
            };
          }
          return next;
        });
      }).catch(() => {
        // Growing backoff (1.5/3/6/12s, ~22s total) rides out a short outage;
        // beyond that the rehydrate tick above takes over.
        if (cancelled || attempt >= 3) return;
        retryTimers.push(setTimeout(() => fetchProject(projectId, attempt + 1), 1500 * (attempt + 1)));
      });
    };
    for (const projectId of projectIds) fetchProject(projectId, 0);
    return () => {
      cancelled = true;
      for (const timer of retryTimers) clearTimeout(timer);
    };
    // 刻意只依賴內容 key（外加 rehydrateTick 手動/重連訊號）：依賴 dockLayout.tiles
    // 陣列 identity 會被每次 dockLayout 廣播（selectTile 等）取消掉在飛的 hydrate
    // RPC，導致手機端永久 "Loading terminal..."（見 TICKET-E）。body 內讀
    // dockLayout.tiles 取 projectId 是安全的：key 變時 tiles 必已變。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrationKey, rehydrateTick]);

  // Listen for terminal exits and update the local info projection.
  useEffect(() => {
    const offExit = window.aiTerminal.onTerminalExit((payload) => {
      setTerminalInfo((prev) => {
        const existing = prev[payload.terminalId];
        if (!existing) return prev;
        return {
          ...prev,
          [payload.terminalId]: {
            ...existing,
            info: {
              ...existing.info,
              status: "exited",
              closedAt: new Date().toISOString(),
              lastExitCode: payload.exitCode,
            },
          },
        };
      });
      clearBusy(payload.terminalId);
    });
    return offExit;
  }, [clearBusy]);

  // Subscribe to terminalListChanged so markTerminalAgent updates propagate.
  // Without this, the dock never re-fetches after an agent launch (markTerminal
  // emits terminalListChanged but the dock only re-fetches on tiles change),
  // so terminalInfo stays stale (isAgent:false, agentProfile:null) and the
  // model badge falls back to detectedModel ("Codex") instead of the real
  // profile ("codex-local-main"). (4-2)
  useEffect(() => {
    const offListChanged = window.aiTerminal.onTerminalListChanged((payload) => {
      void window.aiTerminal.getTerminalWorkspace(payload.projectId).then((workspace) => {
        setTerminalInfo((prev) => {
          const next = { ...prev };
          for (const info of workspace.terminals) {
            next[info.id] = {
              info,
              scrollback: workspace.scrollback[info.id] ?? prev[info.id]?.scrollback ?? "",
              snapshotRevision: workspace.scrollbackRevision?.[info.id] ?? prev[info.id]?.snapshotRevision ?? 0,
              snapshotReady: true,
            };
          }
          return next;
        });
      }).catch(() => undefined);
    });
    return offListChanged;
  }, []);

  // Always-have-a-selection invariant: if tiles exist but selected is null,
  // select the first. Main process is the source of truth, but we patch
  // locally to avoid a flash of no-selection on mobile.
  useEffect(() => {
    if (dockLayout.tiles.length > 0 && !dockLayout.selectedTerminalId) {
      void window.aiTerminal.selectTile({ terminalId: dockLayout.tiles[0]!.terminalId }).catch(() => undefined);
    }
  }, [dockLayout.tiles, dockLayout.selectedTerminalId]);

  // Debounced layout persistence. react-resizable-panels fires onLayoutChanged
  // after the pointer is released; we debounce slightly to coalesce rapid
  // successive row+col resizes into a single setDockLayout RPC.
  const layoutFlush = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingLayout = useRef<DockLayout>(dockLayout);

  const persistLayout = useCallback((rows: number[], cols: number[][]): void => {
    pendingLayout.current = { ...pendingLayout.current, rows, cols };
    if (layoutFlush.current) clearTimeout(layoutFlush.current);
    layoutFlush.current = setTimeout(() => {
      void window.aiTerminal.setDockLayout({
        rows: pendingLayout.current.rows,
        cols: pendingLayout.current.cols,
      }).catch(() => undefined);
    }, 80);
  }, []);

  useEffect(() => () => {
    if (layoutFlush.current) clearTimeout(layoutFlush.current);
  }, []);

  // +agent launch. For local claude-* profiles (spec.agentProfile set), env is
  // injected at pty.spawn and also written into the command. The visible env is
  // intentional: it prevents fallback paths from silently using the user's paid
  // claude.ai session when proxy credentials are missing.
  const launchInteractive = useCallback(async (
    terminalId: string,
    provider: InteractiveAgentId,
    initialInput = "",
    resumeSessionId?: string,
  ): Promise<void> => {
    const spec = interactiveAgent(
      provider,
      settings?.proxyUrl ?? "http://127.0.0.1:8787",
      "default",
      resumeSessionId,
    );
    if (!spec) return;

    // Check PTY state. A failed lookup (web/mobile RPC gap) must not abort
    // the launch: warn and continue so the LLM command is still written.
    if (terminalId && resumeSessionId) {
      try {
        const state = await window.aiTerminal.getPtyState(terminalId);
        if (isInterruptible(state) || isAttentionState(state)) return; // already running / awaiting input
      } catch (error) {
        console.warn("launchInteractive: getPtyState failed, continuing anyway", error);
      }
    }
    if (terminalId && !resumeSessionId) {
      try {
        const state = await window.aiTerminal.getPtyState(terminalId);
        // Ctrl+C guard: only an actively-running LLM may be interrupted.
        // Attention states (waiting_input/approval_required/blocked) must NOT
        // be interrupted — the user's input/approval is the only exit.
        if (isInterruptible(state)) {
          await window.aiTerminal.writeTerminal({ terminalId, data: "\x03" }).catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
      } catch (error) {
        console.warn("launchInteractive: getPtyState failed, continuing anyway", error);
      }
    }

    // Agent-profile path: rebuild the tile as an agent PTY with spawn-injected
    // env, then write a self-contained command as a second layer of protection.
    if (spec.agentProfile) {
      const tile = dockLayout.tiles.find((t) => t.terminalId === terminalId);
      const projectId = tile?.projectId;
      let targetId = terminalId;
      if (projectId) {
        try {
          const state = await window.aiTerminal.getPtyState(terminalId);
          // Only rebuild idle/done shell tiles; an already-running or attention
          // agent tile keeps its env (re-spawn would lose the session / clobber
          // a pending approval) — just re-write command.
          const legacy = toLegacyPtyState(state);
          if (legacy === "idle" || legacy === "shell-ready") {
            await window.aiTerminal.closeTile({ terminalId }).catch(() => undefined);
            const layout = await useAppStore.getState().openTile(projectId, spec.agentProfile);
            targetId = layout?.selectedTerminalId ?? terminalId;
          }
        } catch (error) {
          console.warn("launchInteractive: agent rebuild failed, writing to existing tile", error);
        }
      }
      if (initialInput) queueInputWhenReady(targetId, initialInput);
      // Mark first so main owns the live VT buffer before the launch command
      // can produce its earliest startup/prompt bytes.
      await window.aiTerminal.markTerminalAgent({ terminalId: targetId, agentProfile: provider }).catch(() => undefined);
      // waitForShellReady: main buffers the command until the fresh shell emits
      // its first prompt — writing during boot can swallow the Enter (#50).
      await window.aiTerminal.writeTerminal(buildAgentLaunchWriteInput(targetId, spec)).catch(() => undefined);
      // f2: a resumed launch has no freshly-generated id — bind the RESUMED
      // session id instead so sidebar/clean-view resolve this exact .jsonl.
      const bindSessionId = spec.nativeSessionId ?? resumeSessionId;
      if (bindSessionId) {
        void window.aiTerminal.setTerminalNativeSessionId({ terminalId: targetId, nativeSessionId: bindSessionId }).catch(() => undefined);
      }
      return;
    }

    if (initialInput) queueInputWhenReady(terminalId, initialInput);
    await window.aiTerminal.markTerminalAgent({ terminalId, agentProfile: provider }).catch(() => undefined);
    // AUTO-ENTER: append \r so the command runs immediately. waitForShellReady
    // buffers the write in main until the first prompt appears (#50).
    await window.aiTerminal.writeTerminal(buildAgentLaunchWriteInput(terminalId, spec)).catch(() => undefined);
    // f2: same resume binding as the agentProfile branch above.
    const bindSessionId = spec.nativeSessionId ?? resumeSessionId;
    if (bindSessionId) {
      void window.aiTerminal.setTerminalNativeSessionId({ terminalId, nativeSessionId: bindSessionId }).catch(() => undefined);
    }
  }, [settings?.proxyUrl, dockLayout.tiles]);

  // Wire the coterm:interactive-agent CustomEvent. The detail carries a
  // terminalId (new contract) — if an older caller sends paneId, we map it
  // to the selected tile's terminalId as a fallback.
  useEffect(() => {
    const launch = (event: Event): void => {
      const detail = (event as CustomEvent<{
        terminalId?: string;
        paneId?: string;
        provider: InteractiveAgentId;
        initialInput?: string;
        resumeSessionId?: string;
      }>).detail;
      const targetId = detail.terminalId ?? dockLayout.selectedTerminalId;
      if (!targetId) return;
      void launchInteractive(targetId, detail.provider, detail.initialInput, detail.resumeSessionId);
    };
    window.addEventListener("coterm:interactive-agent", launch);
    return () => window.removeEventListener("coterm:interactive-agent", launch);
  }, [dockLayout.selectedTerminalId, launchInteractive]);

  // Ctrl+Shift+W closes the selected terminal.
  useEffect(() => {
    const closeSelected = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== "w") return;
      const id = dockLayout.selectedTerminalId;
      if (!id) return;
      event.preventDefault();
      void closeTile(id);
    };
    window.addEventListener("keydown", closeSelected);
    return () => window.removeEventListener("keydown", closeSelected);
  }, [dockLayout.selectedTerminalId, closeTile]);

  const rows = useMemo(() => tilesByRow(dockLayout), [dockLayout]);
  const selectedId = dockLayout.selectedTerminalId;

  // 閱讀模式 slot 不許殘影：被關掉/殭屍回收的窗即刻拔格。pruneReadingSlots
  // returns the identical object when nothing changed (no set → no loop), so
  // running this per broadcast is safe and cheap.
  useEffect(() => {
    syncReadingSlots(new Set(dockLayout.tiles.map((tile) => tile.terminalId)));
  }, [dockLayout.tiles, syncReadingSlots]);

  // Drop handlers for one grid tile (normal grid branch only — exclusive and
  // reading views render single/slot panes that intentionally skip reorder).
  // Gate strictly on the reorder MIME so the reading-slot and sidebar-session
  // drags keep flowing to their own surfaces untouched.
  const reorderDropHandlers = (targetId: string) => ({
    onDragOver: (event: React.DragEvent): void => {
      if (!event.dataTransfer.types.includes(REORDER_DRAG_MIME)) return;
      event.preventDefault();
      if (reorderHoverId !== targetId) setReorderHoverId(targetId);
    },
    onDragLeave: (): void => {
      if (reorderHoverId === targetId) setReorderHoverId(null);
    },
    // dragend bubbles from the dragged header when the gesture ends anywhere
    // (inside or outside the grid), so the hover ring can never get stranded.
    onDragEnd: (): void => setReorderHoverId(null),
    onDrop: (event: React.DragEvent): void => {
      if (!event.dataTransfer.types.includes(REORDER_DRAG_MIME)) return;
      event.preventDefault();
      setReorderHoverId(null);
      const draggedId = event.dataTransfer.getData(REORDER_DRAG_MIME);
      const toIndex = dockLayout.tiles.findIndex((t) => t.terminalId === targetId);
      // Same tile / stale target (closed mid-drag) → no-op instead of a churn.
      if (!draggedId || draggedId === targetId || toIndex === -1) return;
      void reorderTile(draggedId, toIndex);
    },
  });

  // Mobile: render ONLY the selected tile, full area (no PanelGroup).
  if (isMobile) {
    const selectedTile = dockLayout.tiles.find((t) => t.terminalId === selectedId) ?? dockLayout.tiles[0] ?? null;
    if (!selectedTile) {
      return <section className="terminal-dock terminal-first-dock"><EmptyDock /></section>;
    }
    const entry = terminalInfo[selectedTile.terminalId];
    return (
      <section className="terminal-dock terminal-first-dock">
        <div className="terminal-panes split-single">
          {entry ? (
            <XtermPane
              key={entry.info.id}
              info={entry.info}
              initialData={entry.scrollback}
              initialDataRevision={entry.snapshotRevision}
              initialDataReady={entry.snapshotReady}
              appTheme={settings?.theme ?? "dark"}
              activeConversationId={null}
              saveAttachment={(file) => saveAttachment(file, effectivePaneId)}
              isActive
              isBusy={busyTiles.has(entry.info.id)}
              ptyState={ptyStates[entry.info.id] ?? null}
              onActivate={() => selectTile(entry.info.id)}
              onActivity={markBusy}
              onClose={closeTile}
              paneNumber={paneNumbers.get(entry.info.id)}
              ptyCols={dockLayout.ptyCols}
              ptyRows={dockLayout.ptyRows}
            />
          ) : (
            <TerminalPlaceholder />
          )}
        </div>
      </section>
    );
  }

  // Desktop: nested PanelGroups — outer vertical (rows), inner horizontal (tiles).
  // Separators must be direct children of Group (not nested inside Panels), so
  // we interleave them with Panels via flatMap.

  // 閱讀模式 (1.5.44): renderer-local picking view, desktop only. The
  // main-owned layout is untouched, so exiting re-renders the grid/exclusive
  // branches below and the original layout comes back with zero ghosting.
  if (!isMobile && readingModeActive) {
    return (
      <ReadingDock
        dockLayout={dockLayout}
        terminalInfo={terminalInfo}
        busyTiles={busyTiles}
        ptyStates={ptyStates}
        appTheme={settings?.theme ?? "dark"}
        paneId={effectivePaneId}
        saveAttachment={saveAttachment}
        selectTile={selectTile}
        markBusy={markBusy}
        closeTile={closeTile}
      />
    );
  }

  // C3: exclusive (solo) view override — show only the selected terminal full-
  // pane, leaving the persistent layout untouched. Mirrors the mobile path.
  const exclusiveId = dockLayout.exclusiveTerminalId;
  if (exclusiveId) {
    const exclusiveTile = dockLayout.tiles.find((t) => t.terminalId === exclusiveId);
    if (exclusiveTile) {
      const entry = terminalInfo[exclusiveTile.terminalId];
      return (
        <section className="terminal-dock terminal-first-dock">
          <div className="terminal-panes split-single">
            {entry ? (
              <XtermPane
                key={entry.info.id}
                info={entry.info}
                initialData={entry.scrollback}
                initialDataRevision={entry.snapshotRevision}
                initialDataReady={entry.snapshotReady}
                appTheme={settings?.theme ?? "dark"}
                activeConversationId={null}
                saveAttachment={(file) => saveAttachment(file, effectivePaneId)}
                isActive
                isBusy={busyTiles.has(entry.info.id)}
                ptyState={ptyStates[entry.info.id] ?? null}
                onActivate={() => selectTile(entry.info.id)}
                onActivity={markBusy}
                onClose={closeTile}
                paneNumber={paneNumbers.get(entry.info.id)}
                ptyCols={dockLayout.ptyCols}
                ptyRows={dockLayout.ptyRows}
              />
            ) : (
              <TerminalPlaceholder />
            )}
          </div>
        </section>
      );
    }
  }

  return (
    <section className="terminal-dock terminal-first-dock">
      {dockLayout.tiles.length === 0 ? (
        <EmptyDock />
      ) : (
        <div className="terminal-dock-grid">
          <Group
            key={`rows-${dockLayout.tiles.length}-${rows.length}-${rows.map((row) => row.length).join("-")}`}
            orientation="vertical"
            className="dock-row-group"
            defaultLayout={fractionsToLayout(
              dockLayout.rows,
              rows.map((_, i) => `row-${i}`),
            )}
            onLayoutChanged={(panelLayout) => {
              const rowIds = rows.map((_, i) => `row-${i}`);
              persistLayout(layoutToFractions(panelLayout, rowIds), dockLayout.cols);
            }}
          >
            {rows.flatMap((rowTiles, rowIdx) => {
              const colIds = rowTiles.map((t) => `tile-${t.terminalId}`);
              const children: React.ReactNode[] = [
                <Panel key={`row-${rowIdx}`} id={`row-${rowIdx}`} className="dock-row-panel">
                  <Group
                    key={`cols-${rowIdx}-${rowTiles.length}`}
                    orientation="horizontal"
                    className="dock-col-group"
                    defaultLayout={fractionsToLayout(dockLayout.cols[rowIdx] ?? [], colIds)}
                    onLayoutChanged={(panelLayout) => {
                      const newCols = [...dockLayout.cols];
                      newCols[rowIdx] = layoutToFractions(panelLayout, colIds);
                      persistLayout(dockLayout.rows, newCols);
                    }}
                  >
                    {rowTiles.flatMap((tile, colIdx) => {
                      const tileChildren: React.ReactNode[] = [
                        <Panel
                          key={`tile-${tile.terminalId}`}
                          id={`tile-${tile.terminalId}`}
                          className={`dock-tile-panel${reorderHoverId === tile.terminalId ? " dock-tile-drop-target" : ""}`}
                          {...reorderDropHandlers(tile.terminalId)}
                        >
                          <DockTileView
                            entry={terminalInfo[tile.terminalId]}
                            appTheme={settings?.theme ?? "dark"}
                            isActive={tile.terminalId === selectedId}
                            isBusy={busyTiles.has(tile.terminalId)}
                            ptyState={ptyStates[tile.terminalId] ?? null}
                            paneId={effectivePaneId}
                            onActivate={selectTile}
                            onActivity={markBusy}
                            onClose={closeTile}
                            paneNumber={paneNumbers.get(tile.terminalId)}
                            ptyCols={dockLayout.ptyCols}
                            ptyRows={dockLayout.ptyRows}
                          />
                        </Panel>,
                      ];
                      if (colIdx < rowTiles.length - 1) {
                        tileChildren.push(
                          <Separator key={`sep-v-${colIdx}`} className="dock-resize-handle dock-resize-vertical" />,
                        );
                      }
                      return tileChildren;
                    })}
                  </Group>
                </Panel>,
              ];
              if (rowIdx < rows.length - 1) {
                children.push(
                  <Separator key={`sep-h-${rowIdx}`} className="dock-resize-handle dock-resize-horizontal" />,
                );
              }
              return children;
            })}
          </Group>
        </div>
      )}
    </section>
  );
}

function DockTileView({
  entry,
  appTheme,
  isActive,
  isBusy,
  ptyState,
  paneId,
  onActivate,
  onActivity,
  onClose,
  paneNumber,
  ptyCols,
  ptyRows,
}: {
  entry: {
    info: TerminalInfo;
    scrollback: string;
    snapshotRevision: number;
    snapshotReady: boolean;
  } | undefined;
  appTheme: "dark" | "light";
  isActive: boolean;
  isBusy: boolean;
  ptyState: PtyState | null;
  paneId: string;
  onActivate: (terminalId: string) => void;
  onActivity: (terminalId: string) => void;
  onClose: (terminalId: string) => Promise<void>;
  paneNumber?: number | undefined;
  ptyCols: number;
  ptyRows: number;
}): React.JSX.Element {
  const saveAttachment = useAppStore((s) => s.saveAttachment);
  if (!entry) {
    return <TerminalPlaceholder />;
  }
  return (
    <XtermPane
      key={entry.info.id}
      info={entry.info}
      initialData={entry.scrollback}
      initialDataRevision={entry.snapshotRevision}
      initialDataReady={entry.snapshotReady}
      appTheme={appTheme}
      activeConversationId={null}
      saveAttachment={(file) => saveAttachment(file, paneId)}
      isActive={isActive}
      isBusy={isBusy}
      ptyState={ptyState}
      onActivate={onActivate}
      onActivity={onActivity}
      onClose={onClose}
      paneNumber={paneNumber}
      ptyCols={ptyCols}
      ptyRows={ptyRows}
    />
  );
}

function EmptyDock(): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="terminal-panes split-single">
      <button className="terminal-empty" disabled>
        <TerminalIcon size={22} />
        {t("dock.empty")}
      </button>
    </div>
  );
}

function TerminalPlaceholder(): React.JSX.Element {
  const { t } = useI18n();
  // Click = manual re-hydrate. Hydrate retries are finite (#24), so the user
  // stuck on this screen after a network outage needs a visible way out —
  // same event the WS reconnect path dispatches.
  return (
    <div className="terminal-panes split-single">
      <button
        className="terminal-empty"
        data-action-id="terminal.rehydrate"
        onClick={() => window.dispatchEvent(new Event("coterm:rehydrate"))}
        title={t("dock.loading.retryTitle")}
      >
        <TerminalIcon size={22} />
        {t("dock.loading.retry")}
      </button>
    </div>
  );
}

/**
 * 閱讀模式 (reading mode, 1.5.44) — desktop-only picking view.
 *
 * Two side-by-side slots the user fills by dragging an open session row from
 * the left sidebar project area (HTML5 drag-and-drop). Everything lives in
 * renderer-local zustand state (store.reading*); the main-owned DockLayout is
 * never touched, so exiting just re-renders the normal grid — no persistence,
 * no ghosting. Slots holding a terminal whose tile left the dock are pruned by
 * TerminalDock's syncReadingSlots effect (殭屍格回收 hooks straight into it).
 */
// READING_DRAG_MIME lives in sidebar-sessions.ts — produced solely by the
// sidebar open-tile rows (1.5.48: drag straight from the sidebar).

// 桌機窗格拖曳排序 (desktop tile reorder, 1.5.47 board): dragging a pane HEADER
// with this MIME moves the tile inside the dock grid. Distinct from
// READING_DRAG_MIME (reading slots) and the sidebar session MIMEs, so all three
// drop surfaces keep ignoring each other via `types.includes(...)` checks.
const REORDER_DRAG_MIME = "application/x-coterm-tile-reorder";

function ReadingDock({
  dockLayout,
  terminalInfo,
  busyTiles,
  ptyStates,
  appTheme,
  paneId,
  saveAttachment,
  selectTile,
  markBusy,
  closeTile,
}: {
  dockLayout: DockLayout;
  terminalInfo: Record<string, {
    info: TerminalInfo;
    scrollback: string;
    snapshotRevision: number;
    snapshotReady: boolean;
  }>;
  busyTiles: Set<string>;
  ptyStates: Record<string, PtyState>;
  appTheme: "dark" | "light";
  paneId: string;
  saveAttachment: (file: File, paneId?: string) => Promise<Attachment>;
  selectTile: (terminalId: string) => void;
  markBusy: (terminalId: string) => void;
  closeTile: (terminalId: string) => Promise<void>;
}): React.JSX.Element {
  const readingSlots = useAppStore((state) => state.readingSlots);
  const placeReadingTerminal = useAppStore((state) => state.placeReadingTerminal);
  const requestTerminalRecovery = useAppStore((state) => state.requestTerminalRecovery);
  const settings = useAppStore((state) => state.settings);
  const { t } = useI18n();

  // 排版預設 (2026-10-02): one-click preset, settings-routed; falls back to
  // the legacy side-by-side pair when the stored id no longer resolves.
  const preset = useMemo(
    () =>
      READING_PRESETS.find((candidate) => candidate.id === settings?.readingPreset)
      ?? READING_PRESETS.find((candidate) => candidate.id === DEFAULT_READING_PRESET_ID)!,
    [settings?.readingPreset],
  );

  // 亂碼修復 (1.5.48): a slotted pane REMOUNTS at the slot's width and replays
  // the scrollback captured at the OLD width. An idle fullscreen TUI (Claude
  // Code, codex) never repaints on its own, so the mis-wrapped frame just sits
  // there as garbage. Run the same recovery the manual Refresh button runs
  // (remeasure + authoritative replace + canvas refresh) for every freshly
  // slotted terminal; the per-pane scheduler is registered by XtermPane's mount
  // effect, which runs before this parent effect.
  const readingSlotsKey = readingSlots.map((id) => id ?? "").join("\n");
  useEffect(() => {
    for (const terminalId of readingSlots) {
      if (terminalId) requestTerminalRecovery(terminalId, "reading-slot");
    }
    // Keyed on the slot CONTENTS (ids), not the array identity — a bare
    // selection broadcast must not re-trigger recovery.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readingSlotsKey]);

  // Content-keyed: a bare selection broadcast must not rebuild this set.
  const tileIdsKey = dockLayout.tiles.map((tile) => tile.terminalId).join("\n");
  const tileIds = useMemo(
    () => new Set(tileIdsKey ? tileIdsKey.split("\n") : []),
    [tileIdsKey],
  );
  // Tab ↔ pane mapping inside reading mode, same 1-based number as the tabs.
  const paneNumbers = useMemo(() => {
    const map = new Map<string, number>();
    dockLayout.tiles.forEach((tile, index) => map.set(tile.terminalId, index + 1));
    return map;
    // Content-keyed on tileIdsKey: a bare selection broadcast must not rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tileIdsKey]);

  // B5 (2026-09-26): which slot the pointer is dragging over — drives the
  // dashed accent outline so a legal drop target is visible. Cleared on
  // leave/drop AND on a global dragend (a cancelled drag can skip dragleave).
  const [dragOverSlot, setDragOverSlot] = useState<ReadingSlotKey | null>(null);
  useEffect(() => {
    const clear = (): void => setDragOverSlot(null);
    window.addEventListener("dragend", clear);
    return () => window.removeEventListener("dragend", clear);
  }, []);

  const dropHandlers = (slot: ReadingSlotKey) => ({
    onDragEnter: (event: React.DragEvent): void => {
      if (event.dataTransfer.types.includes(READING_DRAG_MIME)) setDragOverSlot(slot);
    },
    onDragOver: (event: React.DragEvent): void => {
      if (event.dataTransfer.types.includes(READING_DRAG_MIME)) {
        event.preventDefault();
        if (dragOverSlot !== slot) setDragOverSlot(slot);
      }
    },
    onDragLeave: (event: React.DragEvent): void => {
      // dragleave also fires when the pointer enters a CHILD of the slot —
      // only clear when it truly leaves this slot's box.
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      if (dragOverSlot === slot) setDragOverSlot(null);
    },
    onDrop: (event: React.DragEvent): void => {
      setDragOverSlot(null);
      const terminalId = event.dataTransfer.getData(READING_DRAG_MIME);
      if (!terminalId) return;
      event.preventDefault();
      // Only live main-owned tiles may be slotted — a stale card for a closed
      // terminal is ignored rather than becoming a phantom slot.
      if (tileIds.has(terminalId)) placeReadingTerminal(slot, terminalId);
    },
  });

  const renderSlot = (slot: ReadingSlotKey): React.ReactNode => {
    const terminalId = readingSlots[slot] ?? null;
    if (!terminalId) {
      // Ready-made empty slot: only a faint hint icon (title carries the old
      // explanatory hint), no descriptive text.
      return (
        <div className="reading-slot-empty" title={t("reading.slot.hint")}>
          <BookOpen size={18} aria-hidden="true" />
        </div>
      );
    }
    const entry = terminalInfo[terminalId];
    return (
      <div className="terminal-panes split-single">
        {entry ? (
          <XtermPane
            key={entry.info.id}
            info={entry.info}
            initialData={entry.scrollback}
            initialDataRevision={entry.snapshotRevision}
            initialDataReady={entry.snapshotReady}
            appTheme={appTheme}
            activeConversationId={null}
            saveAttachment={(file) => saveAttachment(file, paneId)}
            isActive
            isBusy={busyTiles.has(entry.info.id)}
            ptyState={ptyStates[entry.info.id] ?? null}
            onActivate={() => selectTile(entry.info.id)}
            onActivity={markBusy}
            onClose={closeTile}
            paneNumber={paneNumbers.get(entry.info.id)}
            ptyCols={dockLayout.ptyCols}
            ptyRows={dockLayout.ptyRows}
          />
        ) : (
          <TerminalPlaceholder />
        )}
      </div>
    );
  };

  return (
    <section className="terminal-dock terminal-first-dock reading-mode">
      <div
        className="reading-grid"
        style={{ gridTemplateColumns: preset.cols, gridTemplateRows: preset.rows }}
      >
        {preset.boxes.map((box, index) => {
          // `?? null`: runtime indexing past the current array width returns
          // undefined, which would wrongly flag empty slots of a BIGGER preset
          // as filled (TS types the entry string | null).
          const slotId = readingSlots[index] ?? null;
          return (
            <div
              key={index}
              className="reading-slot"
              style={{
                gridColumn: `${box.col} / span ${box.colSpan}`,
                gridRow: `${box.row} / span ${box.rowSpan}`,
              }}
              data-reading-slot={readingSlotName(index)}
              data-reading-filled={slotId !== null ? "true" : undefined}
              // 浮突 (2026-09-26): slotted panes stay isActive (focus/fit
              // contract), so the SLOT carries the "which one is selected" lift.
              data-reading-selected={slotId !== null && slotId === dockLayout.selectedTerminalId ? "true" : undefined}
              // B5: dashed accent outline while a reading drag hovers this slot.
              data-drag-over={dragOverSlot === index ? "true" : undefined}
              {...dropHandlers(index)}
            >
              {renderSlot(index)}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function VoiceCompositionOverlay({ terminalId }: { terminalId: string }): React.JSX.Element | null {
  const draft = useVoiceDraftSnapshot().byTerminal[terminalId];
  const { t } = useI18n();
  if (!draft) return null;
  const label = draft.phase === "partial"
    ? t("topbar.voice.partial")
    : draft.phase === "finalizing"
      ? t("topbar.voice.finalizing")
      : draft.phase === "preview-paused"
        ? t("topbar.voice.rate-limited")
        : t("topbar.voice.recording");
  return (
    <div
      className={`voice-composition-overlay voice-composition-${draft.phase}`}
      data-voice-terminal-id={terminalId}
      data-voice-phase={draft.phase}
      role="status"
      aria-live="polite"
    >
      <span className="voice-composition-state">{label}</span>
      {draft.text && <span className="voice-composition-text">{draft.text}</span>}
    </div>
  );
}


function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => typeof window !== "undefined" && window.matchMedia(MOBILE_LAYOUT_QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(MOBILE_LAYOUT_QUERY);
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return mobile;
}

// --- remote web-desktop font-fit (pure math in terminal-remote-fit.ts) ---
// A remote browser mirrors the shared PTY grid 1:1 and must NEVER resize it
// (rollback 2026-08-12), so a pane smaller than the host grid shrinks its own
// font until the whole grid fits. Mobile layout keeps its existing behavior.

interface RemoteFitContext {
  paneWidthPx: number;
  paneHeightPx: number;
  cols: number;
  rows: number;
  cellWidthPx: number;
  cellHeightPx: number;
}

function isPositiveFinite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

/** Measure the remote pane budget and the current cell size. Null when either
    is unmeasurable (pane hidden/mid-fit, private render metrics absent and
    the .xterm-screen element gone) — callers keep the previous font rather
    than guess, the same fail-closed shape as touchMouseCell. */
function measureRemoteFitContext(
  terminal: Terminal,
  host: HTMLElement,
  cols: number,
  rows: number,
): RemoteFitContext | null {
  if (!isPositiveFinite(cols) || !isPositiveFinite(rows)) return null;
  const style = window.getComputedStyle(host);
  const paneWidthPx = host.clientWidth
    - (Number.parseFloat(style.paddingLeft) || 0)
    - (Number.parseFloat(style.paddingRight) || 0);
  const paneHeightPx = host.clientHeight
    - (Number.parseFloat(style.paddingTop) || 0)
    - (Number.parseFloat(style.paddingBottom) || 0);
  let cellWidthPx: number | undefined;
  let cellHeightPx: number | undefined;
  // Same private-API probe as the compositionstart cell measurement below,
  // but through the throwing-getter guard in terminal-fit.
  const cell = readTerminalCellMetrics(terminal);
  cellWidthPx = cell?.width;
  cellHeightPx = cell?.height;
  if (!isPositiveFinite(cellWidthPx) || !isPositiveFinite(cellHeightPx)) {
    // WebGL keeps no .xterm-rows DOM; on the content-sized remote tree xterm
    // styles .xterm-screen explicitly (inline px = cols*cell / rows*cell).
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    cellWidthPx = screen && cols > 0 ? screen.clientWidth / cols : undefined;
    cellHeightPx = screen && rows > 0 ? screen.clientHeight / rows : undefined;
  }
  if (!isPositiveFinite(paneWidthPx) || !isPositiveFinite(paneHeightPx)) return null;
  if (!isPositiveFinite(cellWidthPx) || !isPositiveFinite(cellHeightPx)) return null;
  return { paneWidthPx, paneHeightPx, cols, rows, cellWidthPx, cellHeightPx };
}

/** Font size the remote pane should apply so the whole host grid fits, or
    null when nothing changes / nothing is measurable. Never exceeds `desired`
    (the configured size), never enlarges, never persists anywhere. */
function remoteFitTargetFor(
  terminal: Terminal,
  host: HTMLElement,
  cols: number,
  rows: number,
  desired: number,
): number | null {
  if (!isPositiveFinite(desired)) return null;
  const measuredAtFontSize = terminal.options.fontSize;
  if (!isPositiveFinite(measuredAtFontSize)) return null;
  const context = measureRemoteFitContext(terminal, host, cols, rows);
  if (!context) return null;
  return nextRemoteFitFontSize({ ...context, measuredAtFontSize, maxFontSize: desired });
}

function queueInputWhenReady(terminalId: string, input: string): void {
  let output = "";
  let stopped = false;
  let unsubscribe = (): void => undefined;
  let fallback: ReturnType<typeof setTimeout> | null = null;
  const send = (): void => {
    if (stopped) return;
    stopped = true;
    if (fallback) clearTimeout(fallback);
    unsubscribe();
    void window.aiTerminal.writeTerminal({ terminalId, data: input, source: "automation" }).catch(() => undefined);
  };
  unsubscribe = window.aiTerminal.onTerminalData((payload) => {
    if (payload.terminalId !== terminalId) return;
    output = (payload.replace ? payload.data : `${output}${payload.data}`).slice(-8_000);
    if (/Claude Code/i.test(output)) send();
  });
  fallback = setTimeout(send, 10_000);
}

// Color the model badge by base series in the PTY header: claude → red,
// codex → bright gold. Everything else (gemini, council, bare shells) keeps
// the default muted label. Driven off the display string so it also catches
// the PTY-parsed detectedModel ("Claude"/"Codex") when `agentProfile` is null.
function agentModelLabelClass(modelLabel: string | null): string {
  if (!modelLabel) return "";
  const label = modelLabel.toLowerCase();
  if (label.startsWith("claude")) return " model-label-claude";
  if (label.startsWith("codex")) return " model-label-codex";
  return "";
}

/**
 * 10-segment used-context battery for trustworthy per-session usage.
 * Each lit segment = 10% of the window used. Grey "?" when the window is
 * unknown (model not in the preset table). Tooltip shows used / window / %
 * and the model. Rendering is data-driven: the main-process
 * ContextBatteryMonitor only ever pushes contextUsage for metered profiles
 * (isContextMeterProfile — official claude/codex, window-pinned profiles, and
 * registered custom codex entries), so a present value IS the profile gate and
 * GLM/Qwen proxy panes never render this.
 */
export function ContextBattery({
  contextUsage,
  t,
}: {
  contextUsage: NonNullable<TerminalInfo["contextUsage"]>;
  t: (key: MessageKey, vars?: TranslationVariables) => string;
}): React.JSX.Element {
  const { usedTokens, windowTokens, percent, model } = contextUsage;
  const known = windowTokens !== null && percent !== null;
  // Lit segments = ceil(percent/10) so even 1% used lights one segment.
  const lit = known ? Math.min(10, Math.max(0, Math.ceil(percent / 10))) : 0;
  const tooltip = known
    ? t("dock.contextBattery.tooltip", {
        used: usedTokens.toLocaleString(),
        window: windowTokens.toLocaleString(),
        percent: Math.round(percent),
        model: model ?? "?",
      })
    : t("dock.contextBattery.unknown", { used: usedTokens.toLocaleString(), model: model ?? "?" });
  return (
    <span
      className={`xterm-context-battery${known ? "" : " unknown"}`}
      title={tooltip}
      aria-label={tooltip}
    >
      {Array.from({ length: 10 }, (_, i) => (
        <span key={i} className={`battery-cell${i < lit ? " lit" : ""}`} />
      ))}
      <span className="xterm-context-pct" aria-hidden="true">
        {known ? `${Math.round(percent)}%` : "?"}
      </span>
    </span>
  );
}

function XtermPane({
  info,
  initialData,
  initialDataRevision,
  initialDataReady,
  appTheme,
  activeConversationId,
  saveAttachment,
  isActive,
  isBusy,
  ptyState,
  onActivate,
  onActivity,
  onClose,
  paneNumber,
  ptyCols,
  ptyRows,
}: {
  info: TerminalInfo;
  initialData: string;
  initialDataRevision: number;
  initialDataReady: boolean;
  appTheme: "dark" | "light";
  activeConversationId: string | null;
  saveAttachment: (file: File) => Promise<{ localPath: string }>;
  isActive: boolean;
  isBusy: boolean;
  ptyState: PtyState | null;
  onActivate: (terminalId: string) => void;
  onActivity: (terminalId: string) => void;
  onClose: (terminalId: string) => Promise<void>;
  /** 1-based tile index matching the top-bar tab; desktop-only render. */
  paneNumber?: number | undefined;
  ptyCols: number;
  ptyRows: number;
}): React.JSX.Element {
  const lastTitleRef = useRef<string | null>(null);
  const titleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleParserBufferRef = useRef("");
  // Session title parsed from ANSI title escapes (\x1b]0;TITLE\x07). LLM CLIs
  // (Claude Code, Codex) set the terminal title to a work summary. Held as
  // state (not just a ref) so the header re-renders when it changes. (4-11)
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);
  const [semanticSessionSummary, setSemanticSessionSummary] = useState<string | null>(null);
  // Only agent tiles show a summary. Prefer the local ANSI title because it
  // keeps changing while Claude works; info.title is the persisted fallback
  // after a tile remount. Provider placeholder titles are not summaries.
  // The shell default (e.g. "PowerShell") and the cwd basename (Codex writes
  // only its workspace folder into OSC 0) are filtered out so tiles show
  // nothing instead of a masquerading folder/shell name.
  const displayTitle = resolvePaneDisplayTitle(info, sessionTitle, semanticSessionSummary, isActive);
  const hostRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  // Drives which header controls render (see the header JSX below).
  const isMobileLayout = useIsMobile();
  const terminalFontSize = useAppStore((s) => s.settings?.terminalFontSize ?? 16);
  const terminalFont = useAppStore((s) => s.settings?.terminalFont ?? "default");
  const terminalThemePreference = useAppStore((s) => s.settings?.terminalTheme ?? "auto");
  // Header double-click solo (maximize) toggle: primitive selectors so the pane
  // only re-renders when the two layout values it reads actually change. Same
  // store action the topbar tab's exclusive-toggle uses.
  const layoutTileCount = useAppStore((s) => s.dockLayout.tiles.length);
  const exclusiveTerminalId = useAppStore((s) => s.dockLayout.exclusiveTerminalId);
  const setExclusive = useAppStore((s) => s.setExclusive);
  const readingModeActive = useAppStore((s) => s.readingModeActive);
  const terminalFontSizeRef = useRef(terminalFontSize);
  const terminalFontRef = useRef(terminalFont);
  // Font size already applied locally (canvas + PTY resize) but not yet flushed
  // to settings by the debounced persist. While this equals the live
  // terminal.options.fontSize, the [terminalFontSize, info.cols, info.id,
  // info.rows] effect below must NOT write settings.terminalFontSize back over
  // it — that was the "ctrl+wheel snaps back to default" loop.
  const pendingFontSizeRef = useRef<number | null>(null);
  // Manual Refresh increments this generation after fetching an authoritative
  // snapshot. The mount effect then disposes WebGL/xterm/addons and rebuilds the
  // engine from byte zero, which repairs renderer-cache corruption that a plain
  // terminal.refresh() cannot fix.
  const [engineGeneration, setEngineGeneration] = useState(0);
  // applyFontSize is defined inside the xterm mount effect (where fit/
  // remoteResize/scrollRemoteToBottom live) and published here so the header
  // A−/A+ buttons can call it. Null before mount / after dispose.
  const applyFontSizeRef = useRef<((next: number) => void) | null>(null);
  // Remote (web) desktop font-fit recompute trigger, published from the mount
  // effect so the ResizeObserver and the host-geometry effect can re-run the
  // fit when the pane resizes or the host grid changes. Null before mount /
  // after dispose; internally a no-op on local Electron and on mobile layout.
  const remoteFitRef = useRef<(() => void) | null>(null);
  // F: xterm engine pack addons. searchRef drives the Ctrl+F overlay;
  // serializeRef is held for future snapshot/restore (A/J) but does NOT replace
  // the existing initialData/scrollback hydration path. webglRef is only set
  // when WebGL loaded successfully so cleanup can dispose it.
  const searchRef = useRef<SearchAddon | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  const typedLineRef = useRef<TypedLineMarker | null>(null);
  const fontLoadCleanupRef = useRef<(() => void) | null>(null);
  // #96: which engine instance lost its WebGL context. The pixels fall back to
  // the DOM renderer (correct), but the window surface can stay half-transparent
  // until it is rebuilt, so the header shows a reopen hint.
  //
  // Recorded as the (terminal, generation) pair that degraded rather than as a
  // boolean, so "the notice clears once the engine is rebuilt" falls out of the
  // comparison below instead of needing an effect that setStates on every
  // generation change (which React flags: setState in an effect body cascades
  // renders). Retry / Refresh / the badge itself all bump engineGeneration, so
  // the rebuilt engine simply never matches the stored pair.
  const [degradedEngineKey, setDegradedEngineKey] = useState<string | null>(null);
  const engineKey = `${info.id}:${engineGeneration}`;
  const rendererDegraded = degradedEngineKey === engineKey;
  // Restored: wr/ime-freeze replaced this declaration with the rendererDegraded
  // one above instead of adding beside it, orphaning its 6 use sites.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchNoResult, setSearchNoResult] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // F: search-as-you-type — the pending debounce timer plus the overlay
  // input's own IME composition guard (separate from composingRef, which
  // protects the terminal's helper textarea, not this DOM input).
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchComposingRef = useRef(false);
  const composingRef = useRef(false);
  // Briefly true after compositionend to suppress xterm's late async
  // onData fragment (fired from _finalizeComposition's setTimeout).
  const justComposedRef = useRef(false);
  // Snapshot of the cursor's viewport coords + cell size captured at
  // compositionstart. repositionComposition reads from here (not the live
  // buffer) so PTY output streaming in mid-composition (agent thinking →
  // viewport scroll / cursor moves) can't yank the composition-view box
  // around — it stays pinned to where typing began until compositionend.
  const composeAnchorRef = useRef<{ x: number; y: number; cellW: number; cellH: number } | null>(null);
  // Mobile touch-gesture state: swipe = scroll scrollback, tap = focus to type.
  // Set true on touchmove while scrolling; checked by pointerdown + isActive
  // effect to suppress the focus-on-tap that would pop the keyboard mid-swipe.
  const touchScrollingRef = useRef(false);
  const touchScrollResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingInputLengthRef = useRef(0);
  const clearNextDeleteRef = useRef(false);

  useEffect(() => {
    if (!isActive || !info.isAgent) return;
    let disposed = false;
    const refresh = (): void => {
      void window.aiTerminal.getAgentApiSemanticState(info.id)
        .then((state) => {
          if (disposed) return;
          const summary = resolveSemanticSessionSummary(state);
          setSemanticSessionSummary(summary);
        })
        .catch(() => {
          if (disposed) return;
          setSemanticSessionSummary(null);
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 3_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [info.id, info.isAgent, isActive]);
  useEffect(() => {
    // `recap` drives the mobile PTY-switcher marquee; `summary` is the header
    // line and stays the fallback when no provider recap exists yet; `cwd`
    // feeds the desktop top-bar tabs (pane-header parity).
    window.dispatchEvent(new CustomEvent("coterm:session-summary", {
      detail: { terminalId: info.id, summary: displayTitle, recap: info.agentRecap ?? null, cwd: info.cwd },
    }));
  }, [displayTitle, info.agentRecap, info.id, info.cwd]);
  const [detectedModel, setDetectedModel] = useState<string | null>(null);
  // Hold initialData in a ref so the xterm mount effect depends only on the
  // terminal identity (info.id), not on the scrollback string. Depending on
  // initialData rebuilt the whole Terminal on every scrollback refresh, which
  // caused the pane to lag or appear blank until a project switch forced a
  // remount.
  const initialDataRef = useRef<TerminalSnapshotInput>({
    ready: initialDataReady,
    revision: initialDataRevision,
    data: initialData,
  });
  const applyAuthoritativeSnapshotRef = useRef<((snapshot: TerminalSnapshotInput) => void) | null>(null);
  useEffect(() => {
    const snapshot = {
      ready: initialDataReady,
      revision: initialDataRevision,
      data: initialData,
    };
    initialDataRef.current = snapshot;
    applyAuthoritativeSnapshotRef.current?.(snapshot);
  }, [initialData, initialDataReady, initialDataRevision]);
  // Hold saveAttachment in a ref so the xterm mount effect does not depend on
  // the prop reference. DockTileView passes an inline closure that changes on
  // every dockLayout-driven re-render; listing it in the dep array would
  // dispose+recreate the Terminal (visible flash) and steal focus to the first
  // tile's remount body.
  const saveAttachmentRef = useRef(saveAttachment);
  useEffect(() => { saveAttachmentRef.current = saveAttachment; }, [saveAttachment]);

  useEffect(() => {
    terminalFontSizeRef.current = terminalFontSize;
    const terminal = terminalRef.current;
    if (!terminal) return;
    // A pending (locally-applied, not-yet-persisted) font size wins. The
    // settings store is stale during the 250ms persist debounce; letting this
    // effect overwrite terminal.options.fontSize with the stale settings value
    // was the "ctrl+wheel snaps back to default" loop. Only re-apply if the
    // pending value has been cleared (persist caught up) or disagrees with the
    // live canvas (a real external settings change).
    const pending = pendingFontSizeRef.current;
    if (pending !== null && terminal.options.fontSize === pending) return;
    const host = hostRef.current;
    const mobile = window.matchMedia(MOBILE_LAYOUT_QUERY).matches;
    let next: number;
    if (mobile && host) {
      next = Math.max(terminalFontSize, fontSizeForViewport({
        viewportHeight: host.clientHeight > 0 ? host.clientHeight : window.innerHeight,
        rows: Math.max(1, info.rows),
        lineHeight: 1.15,
      }));
    } else if (!mobile && window.aiTerminal.isBrowser && host) {
      // Remote web-desktop: shrink the local font so the whole host grid fits
      // the pane (no clipping, no horizontal scroll). Re-derives the same
      // target the ResizeObserver already applied, so the early-return below
      // holds and this effect cannot snap the fit back to the configured size.
      next = remoteFitTargetFor(terminal, host, info.cols, info.rows, terminalFontSize) ?? terminalFontSize;
    } else {
      next = terminalFontSize;
    }
    if (terminal.options.fontSize === next) return;
    terminal.options.fontSize = next;
    clearSharedTextureAtlas();
    requestAnimationFrame(() => {
      if (!window.aiTerminal.isBrowser) {
        if (host) fitTerminalToHost(terminal, host);
        void window.aiTerminal.resizeTerminal({
          terminalId: info.id,
          cols: terminal.cols,
          rows: terminal.rows,
        });
      } else {
        terminal.resize(info.cols, calculateRemoteRows({ fallbackRows: info.rows }));
      }
      terminal.refresh(0, Math.max(0, terminal.rows - 1));
      if (window.aiTerminal.isBrowser && host) {
        host.scrollTop = host.scrollHeight;
        resetRemoteHorizontalPan(host);
        requestAnimationFrame(() => resetRemoteHorizontalPan(host));
      }
    });
  }, [terminalFontSize, info.cols, info.id, info.rows]);

  // PTY 字體偏好（Settings → appearance）套用到這個 xterm。字體改變 cell metrics，
  // 所以照 fontSize effect 的同一套序列：換 options → 清 texture atlas → rAF 內
  // 重算 cols/rows + 全量 refresh。字體不影響內容位置，不需 scroll 重置。
  useEffect(() => {
    terminalFontRef.current = terminalFont;
    const terminal = terminalRef.current;
    if (!terminal) return;
    // A heavier-than-regular weight (sun palette) also swaps the CJK face to
    // the variable Noto Sans TC — the theme effect owns the weight.
    const next = resolveTerminalFontStack(terminalFont, Number(terminal.options.fontWeight) >= 500);
    let cancelled = false;
    // Wait for the bundled webfont before swapping: xterm measures the cell and
    // rasterizes glyphs immediately, so a not-yet-loaded face renders as the
    // fallback and the pick looks like it did nothing.
    void loadTerminalFont(terminalFont, terminal.options.fontSize ?? 16).then(() => {
    if (cancelled || terminalRef.current !== terminal) return;
    if (terminal.options.fontFamily === next) return;
    terminal.options.fontFamily = next;
    clearSharedTextureAtlas();
    requestAnimationFrame(() => {
      if (!window.aiTerminal.isBrowser) {
        const host = hostRef.current;
        if (host) fitTerminalToHost(terminal, host);
        void window.aiTerminal.resizeTerminal({ terminalId: info.id, cols: terminal.cols, rows: terminal.rows });
      } else {
        terminal.resize(info.cols, calculateRemoteRows({ fallbackRows: info.rows }));
      }
      terminal.refresh(0, Math.max(0, terminal.rows - 1));
    });
    });
    return () => { cancelled = true; };
  }, [terminalFont, info.cols, info.id, info.rows]);

  const { t } = useI18n();

  const snapshotBuffer = useCallback((): string => {
    const terminal = terminalRef.current;
    if (!terminal) return "";
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    const length = buffer.length;
    for (let i = 0; i < length; i++) {
      const line = buffer.getLine(i);
      if (!line) continue;
      // trimRight=true drops trailing whitespace so wrapped lines stay readable
      // and selection copies do not carry a wall of trailing spaces.
      lines.push(line.translateToString(true));
    }
    // Drop trailing empty lines (the blank area below the cursor).
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n");
  }, []);
  const captureRawText = useCallback((): string => snapshotBuffer(), [snapshotBuffer]);
  // Re-render on reader open/close so the header can react (eye icon, and the
  // close X hides while reading — the reader's own 關閉 sits right next to it
  // and a mis-tap killed the session, 2026-10-06).
  useSyncExternalStore(terminalReaderController.subscribe, terminalReaderController.getSnapshot, terminalReaderController.getSnapshot);
  const readerOpen = terminalReaderController.isOpenFor(info.id);
  useEffect(() => {
    const onToggle = (event: Event): void => {
      const detail = (event as CustomEvent<{ terminalId: string }>).detail;
      if (detail?.terminalId === info.id) terminalReaderController.toggle(info.id);
    };
    window.addEventListener("coterm:reader-toggle", onToggle);
    return () => window.removeEventListener("coterm:reader-toggle", onToggle);
  }, [info.id]);

  // direct typing mode: an external toggle (TopBar) asks this terminal to
  // claim focus so the mobile software keyboard pops without the composer.
  useEffect(() => {
    const onFocusPty = (event: Event): void => {
      const detail = (event as CustomEvent<{ terminalId: string }>).detail;
      if (detail?.terminalId === info.id) terminalRef.current?.focus();
    };
    window.addEventListener("coterm:focus-pty", onFocusPty);
    return () => window.removeEventListener("coterm:focus-pty", onFocusPty);
  }, [info.id]);

  // The composer publishes its height as CSS padding on this host (styles.css).
  // Padding alone would leave the newest row parked behind the composer, so
  // scroll the host down by that much whenever the composer resizes.
  useEffect(() => {
    const onComposerLayout = (): void => {
      const host = hostRef.current;
      if (host) host.scrollTop = host.scrollHeight;
    };
    window.addEventListener("coterm:composer-layout", onComposerLayout);
    return () => window.removeEventListener("coterm:composer-layout", onComposerLayout);
  }, []);

  // F: focus the search input when the overlay opens, and clear state on close.
  useEffect(() => {
    if (!searchOpen) return;
    requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => {
      setSearchQuery("");
      setSearchNoResult(false);
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
        searchTimerRef.current = null;
      }
      searchComposingRef.current = false;
      searchRef.current?.clearDecorations();
    };
  }, [searchOpen]);

  // F: run a forward/backward search via the SearchAddon. Returns whether a
  // match was found so the overlay can show a "no result" hint. Extracted as a
  // plain callback (no terminal-closure capture) so it stays stable across
  // re-renders.
  const runSearch = useCallback((direction: "next" | "previous"): void => {
    const addon = searchRef.current;
    const term = searchQuery;
    if (!addon || !term) {
      setSearchNoResult(false);
      return;
    }
    const found = direction === "next"
      ? addon.findNext(term)
      : addon.findPrevious(term);
    setSearchNoResult(!found);
  }, [searchQuery]);

  const resolvedTheme = useMemo(
    () => resolveTerminalTheme(terminalThemePreference, appTheme),
    [appTheme, terminalThemePreference],
  );
  const lightBackgroundRef = useRef(resolvedTheme.isLight);
  // Read by the mount effect (which deliberately does not depend on the theme)
  // so a WebGL/engine remount starts with the current transparency + cursor line.
  const resolvedThemeRef = useRef(resolvedTheme);
  const previousThemeIdRef = useRef(resolvedTheme.id);

  // F: search-as-you-type — incremental forward search with match decorations
  // on the current term. Separate from runSearch so Enter/Shift+Enter keep the
  // plain behavior (no decorations churn from a stale closure).
  const runTypeaheadSearch = useCallback((term: string): void => {
    const addon = searchRef.current;
    if (!addon || !term) {
      addon?.clearDecorations();
      setSearchNoResult(false);
      return;
    }
    const found = addon.findNext(term, {
      incremental: true,
      decorations: searchOverlayColors(lightBackgroundRef.current),
    });
    setSearchNoResult(!found);
  }, []);

  // F: debounce (~SEARCH_TYPEAHEAD_DELAY_MS) for the typeahead trigger.
  // Suppressed while an IME composition is active; onCompositionEnd fires the
  // search directly so 注音 composition is never matched mid-stream.
  const scheduleTypeaheadSearch = useCallback((term: string): void => {
    if (searchComposingRef.current) return;
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      searchTimerRef.current = null;
      runTypeaheadSearch(term);
    }, SEARCH_TYPEAHEAD_DELAY_MS);
  }, [runTypeaheadSearch]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    // Desktop (Electron preload) owns PTY dimensions and drives the shared SoT.
    // Browser/mobile clients mirror the PTY's own cols/rows 1:1 (raw bytes →
    // xterm, no rewriting), panning via the .xterm-host-remote scroll container
    // when wider than the viewport. They never call resizeTerminal (don't touch SoT).
    const isDesktop = !window.aiTerminal.isBrowser;
    const isMobileViewport = window.matchMedia(MOBILE_LAYOUT_QUERY).matches;
    const terminalLineHeight = isMobileViewport
      ? TERMINAL_TYPOGRAPHY.mobileLineHeight
      : TERMINAL_TYPOGRAPHY.desktopLineHeight;
    const pinchOverrideRef = { current: false };
    // Design §3: on mobile, derive the initial font size from the available
    // viewport height and PTY row count so the terminal canvas fills the usable
    // height (no persistent bottom dead zone). The accessibility preference is
    // a floor, so mobile never silently shrinks below the user's configured size.
    const configuredFontSize = terminalFontSizeRef.current;
    const initialFontSize = isMobileViewport
      ? Math.max(configuredFontSize, fontSizeForViewport({
          viewportHeight: host.clientHeight > 0 ? host.clientHeight : window.innerHeight,
          rows: Math.max(1, info.rows),
          lineHeight: terminalLineHeight,
        }))
      : configuredFontSize;
    const terminal = new Terminal({
      // F: the UnicodeGraphemesAddon + terminal.unicode.activeVersion API is
      // xterm "proposed" — allowProposedApi must be true or loadAddon throws
      // (_checkProposedApi), crashing the xterm mount effect and the tile.
      allowProposedApi: true,
      convertEol: true,
      // cursorBlink: false — streaming output (codex/claude) resets the blink
      // phase on every terminal.write(), causing rapid flicker synced to LLM
      // token chunks. A steady cursor is calmer and avoids the strobe. (4-3)
      cursorBlink: false,
      fontFamily: resolveTerminalFontStack(terminalFontRef.current, resolvedThemeRef.current.heavyCjk === true),
      fontSize: initialFontSize,
      lineHeight: terminalLineHeight,
      // Cascadia is designed for its native grid. Keep tracking neutral while
      // using a medium regular weight and a clearly separated bold weight.
      letterSpacing: TERMINAL_TYPOGRAPHY.letterSpacing,
      // The sun palette asks for 500/700: thin strokes wash out on the paper.
      fontWeight: resolvedThemeRef.current.fontWeight ?? TERMINAL_TYPOGRAPHY.fontWeight,
      fontWeightBold: resolvedThemeRef.current.fontWeightBold ?? TERMINAL_TYPOGRAPHY.fontWeightBold,
      minimumContrastRatio: 4.5,
      // Prevent unusually wide fallback glyphs from being clipped at cell
      // edges. Emoji, Nerd Font, and Powerline glyphs are excluded by xterm.
      rescaleOverlappingGlyphs: TERMINAL_TYPOGRAPHY.rescaleOverlappingGlyphs,
      // Must hold a full 2M-char replay from pty-manager's truncateScrollback
      // (~10-20k heavy lines) — a smaller xterm cap would silently re-truncate
      // what the bigger main-process buffer just preserved.
      scrollback: 20_000,
      // 日月色票的背景是 CSS 漸層，xterm 畫透明（其他色票維持不透明，字最銳利）。
      allowTransparency: resolvedThemeRef.current.transparentBackground === true,
      theme: resolvedThemeRef.current.palette,
    });
    const lightAnsiNormalizer = createLightTerminalAnsiNormalizer();
    // 太陽（淺色）版型會在 xterm 解析前抹掉所有 ANSI 底色，連同 Claude Code
    // 替使用者訊息刷的深灰底也一併消失。趁串流還是原始狀態時先把「刷過底色
    // 的文字」攔下來，之後 typed-line 標記用它比對列——訊號與月亮版型一致。
    const echoCapture = createEchoCapture();
    const renderData = (data: string): string => {
      if (lightBackgroundRef.current) {
        echoCapture.write(data);
        return lightAnsiNormalizer.write(data);
      }
      lightAnsiNormalizer.reset();
      return data;
    };
    terminalRef.current = terminal;
    // Links (paths AND web URLs) are served by ONE provider below, not
    // WebLinksAddon + a path provider: the addon only joins soft-wrapped
    // (isWrapped) rows, so Ink-TUI hard wraps underlined truncated fragments,
    // and the two providers fought over shared file:/// spans (first click hit
    // one, next click the other — the old C2 file:// reroute bug).
    const fit = new FitAddon();
    fitRef.current = fit;
    terminal.loadAddon(fit);
    // F: pre-open addons. UnicodeGraphemesAddon MUST load before open() and
    // have activeVersion set before any write() — otherwise already-rendered
    // lines keep the old width and zh-TW/emoji double-width chars overlap.
    // search/serialize/progress are also pre-open (they hook the parser/registry
    // at construction). WebGL is loaded AFTER open() below (it needs the renderer).
    const unicodeGraphemes = new UnicodeGraphemesAddon();
    terminal.loadAddon(unicodeGraphemes);
    try {
      terminal.unicode.activeVersion = "15-graphemes";
    } catch {
      // addon registers the version on activate; if setting fails, the default
      // v6 width table still applies (no crash, just no grapheme clustering).
    }
    const search = new SearchAddon();
    terminal.loadAddon(search);
    searchRef.current = search;
    const serialize = new SerializeAddon();
    terminal.loadAddon(serialize);
    serializeRef.current = serialize;
    terminal.loadAddon(new ProgressAddon());
    // C2: make absolute file paths and web URLs in scrollback clickable.
    // A long path/URL wider than the pane crosses 2+ buffer rows; soft wraps
    // carry isWrapped, but agent TUIs (Ink) wrap lines THEMSELVES and print
    // each fragment as its own row — those continuation rows are NOT isWrapped.
    // The logical-line walk therefore joins on either signal (rowHardWrapsInto:
    // content reaches the pane edge, box-drawing edges excluded). Links get
    // multi-row ILink ranges — xterm renders and click-tests those natively.
    // Bounded walk: TUI borders/full-width bars could otherwise chain a scan
    // across the whole visible screen.
    const LINK_WRAP_WALK_LIMIT = 32;
    const collectLogicalRows = (anchorRow: number): TerminalLogicalRow[] | null => {
      const buffer = terminal.buffer.active;
      if (!buffer.getLine(anchorRow)) return null;
      const scratch = buffer.getNullCell();
      const cache = new Map<number, TerminalCellLike[]>();
      const readCells = (row: number): TerminalCellLike[] | null => {
        const hit = cache.get(row);
        if (hit) return hit;
        const line = buffer.getLine(row);
        if (!line) return null;
        const cells: TerminalCellLike[] = [];
        for (let x = 0; x < line.length; x += 1) {
          const cell = line.getCell(x, scratch);
          if (!cell) break;
          cells.push({ chars: cell.getChars(), width: cell.getWidth() });
        }
        cache.set(row, cells);
        return cells;
      };
      let first = anchorRow;
      let firstCells = readCells(first);
      if (!firstCells) return null;
      for (let steps = 0; first > 0 && steps < LINK_WRAP_WALK_LIMIT; steps += 1) {
        const current = buffer.getLine(first);
        const aboveCells = readCells(first - 1);
        if (!current || !aboveCells) break;
        if (!(current.isWrapped || rowHardWrapsInto(aboveCells, firstCells, terminal.cols))) break;
        first -= 1;
        firstCells = aboveCells;
      }
      const rows: TerminalLogicalRow[] = [];
      for (let row = first; row < buffer.length && rows.length <= LINK_WRAP_WALK_LIMIT * 2; row += 1) {
        const cells = readCells(row);
        if (!cells) break;
        const next = buffer.getLine(row + 1);
        const nextCells = next ? readCells(row + 1) : null;
        const continues =
          Boolean(next) &&
          (next!.isWrapped || rowHardWrapsInto(cells, nextCells ?? undefined, terminal.cols));
        rows.push({ cells, row, continues });
        if (!continues) break;
      }
      return rows;
    };
    const linkProvider = terminal.registerLinkProvider({
      provideLinks(y, callback) {
        const rows = collectLogicalRows(y - 1);
        if (!rows || rows.length === 0) return callback(undefined);
        const map = multiRowTextAndColumnMap(rows);
        const matches = findTerminalLinks(map.text, info.cwd);
        const links: ILink[] = matches.map(({ kind, path, index, length }) => ({
          text: map.text.slice(index, index + length),
          range: multiRowLinkRangeForMatch(map, index, length),
          activate: () => {
            if (kind === "url") {
              window.open(path, "_blank", "noopener,noreferrer");
              return;
            }
            openTerminalPath(path, info.projectId);
          },
        }));
        // provideLinks is per-row: only the links that cover THIS row.
        const onRow = links.filter((link) => link.range.start.y <= y && y <= link.range.end.y);
        callback(onRow.length ? onRow : undefined);
      },
    });
    const rememberInput = (data: string) => {
      for (const char of Array.from(data)) {
        if (char === "\r" || char === "\n" || char === "\x15") {
          pendingInputLengthRef.current = 0;
        } else if (char === "\x7f" || char === "\b") {
          pendingInputLengthRef.current = Math.max(0, pendingInputLengthRef.current - 1);
        } else if (char >= " " || char === "\t") {
          pendingInputLengthRef.current += 1;
        }
      }
    };
    const writeInput = (data: string) => {
      // MobileCommandComposer owns all general text while open. xterm remains
      // available for control keys, but its hidden textarea must not become a
      // second writer for dictation/IME/paste.
      if (mobileInputController.isOpenFor(info.id)) return;
      rememberInput(data);
      // 送出（Enter）：把游標當下所在的那行在回捲歷史裡標起來（sun 版型）。
      if (data.includes("\r") || data.includes("\n")) typedLineRef.current?.markSubmitted();
      void window.aiTerminal.writeTerminal({ terminalId: info.id, data }).catch(swallowIfTerminalGone);
    };
    // Selection-aware delete/replace (terminal-selection-edit.ts): translate
    // Backspace/Delete/printable over an input-line selection into arrow-key
    // moves + exact backspaces, so the CLI edits the HIGHLIGHTED range instead
    // of whatever sits at its own cursor. The cell walk mirrors the link
    // provider's (isWrapped groups, width-0 wide-char tails skipped); window is
    // a few rows around selection+cursor — the planner bails safely whenever
    // the group boundaries run out of window.
    const readSelectionEditInput = (): SelectionEditInput | null => {
      const pos = terminal.getSelectionPosition();
      if (!pos || !terminal.hasSelection()) return null;
      const buf = terminal.buffer.active;
      const cursor = { x: buf.cursorX, y: buf.cursorY };
      const top = Math.max(0, Math.min(pos.start.y, cursor.y) - 8);
      const bottom = Math.min(buf.length - 1, Math.max(pos.end.y, cursor.y) + 2);
      const rows: SelectionEditRow[] = [];
      const scratch = buf.getNullCell();
      for (let y = top; y <= bottom; y += 1) {
        const line = buf.getLine(y);
        if (!line) return null;
        const cells: SelectionCellLike[] = [];
        for (let x = 0; x < line.length; x += 1) {
          const cell = line.getCell(x, scratch);
          if (!cell) break;
          cells.push({ chars: cell.getChars(), width: cell.getWidth() });
        }
        rows.push({ cells, isWrapped: line.isWrapped });
      }
      return {
        rows,
        baseY: top,
        cursor,
        selection: { start: pos.start, end: pos.end },
        altScreen: buf.type === "alternate",
      };
    };
    const applySelectionEdit = (key: SelectionEditKey): boolean => {
      if (clearNextDeleteRef.current) return false; // Ctrl+A bulk path owns the next delete.
      const editInput = readSelectionEditInput();
      if (!editInput) return false;
      const plan = planSelectionEdit(editInput, key);
      if (!plan) return false;
      terminal.clearSelection();
      // Bypass rememberInput: the sequence's arrow escape bytes would
      // overcount pending input; bookkeep the visible effect directly.
      pendingInputLengthRef.current = Math.max(
        0,
        pendingInputLengthRef.current - plan.deletedChars + (typeof key === "object" ? 1 : 0),
      );
      void window.aiTerminal.writeTerminal({ terminalId: info.id, data: plan.sequence }).catch(swallowIfTerminalGone);
      return true;
    };
    const clearSelectedInput = () => {
      // Ctrl+A bulk erase: selectAll spans the whole buffer, far outside the
      // input region — the precise translation refuses it by design. Keep the
      // proven blind blast for this explicit clear-everything gesture.
      if (clearNextDeleteRef.current) {
        clearNextDeleteRef.current = false;
        terminal.clearSelection();
        const blastLength = Math.max(pendingInputLengthRef.current, 512);
        pendingInputLengthRef.current = 0;
        void window.aiTerminal.writeTerminal({ terminalId: info.id, data: "\b".repeat(Math.min(blastLength, 4096)) }).catch(swallowIfTerminalGone);
        return true;
      }
      if (applySelectionEdit("backspace")) return true;
      // Outside the live input line (scrollback) the selection is highlight
      // only: clear it and send NOTHING — the old N-backspaces-at-cursor path
      // is exactly the selected-elsewhere bug this replaces.
      if (terminal.hasSelection()) {
        terminal.clearSelection();
        return true;
      }
      return false;
    };
    // #14 retry: the decision tree lives in terminal-input-routing.ts so the
    // production handler is the tested handler. This closure only adapts the
    // live xterm instance + refs to the dependency interface.
    terminal.attachCustomKeyEventHandler((event) =>
      routeCustomKey(event, {
        isComposing: () => composingRef.current,
        writeInput,
        clearSelectedInput,
        replaceSelection: (char) => applySelectionEdit({ char }),
        markClearNextDelete: () => {
          clearNextDeleteRef.current = true;
        },
        // ponytail: ceiling — selectAll covers the whole visible buffer, not
        // just the current input line. A true "select just my typed input"
        // needs a local input composer (textarea/contenteditable buffering
        // before PTY send), which the work order explicitly defers.
        selectAll: () => terminal.selectAll(),
        openSearch: () => setSearchOpen(true),
        getSelection: () => hardWrapAwareSelectionText(terminal),
        copyText: (text) => {
          void navigator.clipboard.writeText(text);
        },
      }),
    );
    terminal.open(host);
    // Persistent link underlines: xterm only underlines links on hover and its
    // decorations API cannot paint an underline (6.1-beta), so detected links
    // get a DOM ruler per segment. Scans reuse the provider's logical-line walk;
    // only visible rows, rAF-throttled on write/scroll/resize.
    const scanLinkSegments = (): LinkMarkSegment[] => {
      const buffer = terminal.buffer.active;
      const topRow = buffer.viewportY;
      const bottomRow = Math.min(buffer.length, topRow + terminal.rows);
      const segments: LinkMarkSegment[] = [];
      for (let row = topRow; row < bottomRow; ) {
        const rows = collectLogicalRows(row);
        if (!rows || rows.length === 0) {
          row += 1;
          continue;
        }
        const map = multiRowTextAndColumnMap(rows);
        for (const match of findTerminalLinks(map.text, info.cwd)) {
          const range = multiRowLinkRangeForMatch(map, match.index, match.length);
          for (let segRow = range.start.y - 1; segRow <= range.end.y - 1; segRow += 1) {
            if (segRow < topRow || segRow >= bottomRow) continue;
            const startCol = segRow === range.start.y - 1 ? range.start.x - 1 : 0;
            const endCol = segRow === range.end.y - 1 ? range.end.x : terminal.cols;
            if (endCol > startCol) {
              segments.push({ row: segRow - topRow, startCol, endCol });
            }
          }
        }
        row = rows[rows.length - 1]!.row + 1;
      }
      return segments;
    };
    const uninstallLinkUnderlines = installLinkUnderlineOverlay(terminal, host, scanLinkSegments);
    typedLineRef.current = installTypedLineMarker(terminal, resolvedThemeRef.current.typedLine ?? null, echoCapture);
    {
      const typedLine = typedLineRef.current;
      terminal.onWriteParsed(() => typedLine.scheduleScan());
      terminal.onScroll(() => typedLine.scheduleScan());
      terminal.onResize(() => typedLine.scheduleScan());
    }
    // AT-156: firewall NaN mouse coordinates from xterm's own wheel/touch path
    // too — without this they reach the PTY as literal "NaN" SGR bytes.
    installXtermMouseNaNGuard(terminal);
    // CJK webfonts (Noto Sans TC Variable for the heavy sun weight, LXGW
    // WenKai) are split into unicode-range chunks that only download when a
    // glyph first needs them; the glyph atlas meanwhile caches the fallback
    // face. Repaint once a batch of font files lands so the real face shows.
    {
      let fontRepaint: ReturnType<typeof setTimeout> | null = null;
      const onFontsLoaded = (): void => {
        if (fontRepaint) clearTimeout(fontRepaint);
        fontRepaint = setTimeout(() => {
          fontRepaint = null;
          if (terminalRef.current !== terminal) return;
          clearSharedTextureAtlas();
          terminal.refresh(0, Math.max(0, terminal.rows - 1));
        }, 120);
      };
      document.fonts?.addEventListener?.("loadingdone", onFontsLoaded);
      fontLoadCleanupRef.current = () => {
        if (fontRepaint) clearTimeout(fontRepaint);
        document.fonts?.removeEventListener?.("loadingdone", onFontsLoaded);
      };
    }
    // Bundled webfonts load lazily: if the picked face arrives after open(), the
    // atlas holds fallback glyphs and cell metrics. Re-measure once it lands.
    void loadTerminalFont(terminalFontRef.current, configuredFontSize).then(() => {
      if (terminalRef.current !== terminal) return;
      clearSharedTextureAtlas();
      if (!window.aiTerminal.isBrowser) {
        fitTerminalToHost(terminal, host);
        void window.aiTerminal.resizeTerminal({ terminalId: info.id, cols: terminal.cols, rows: terminal.rows });
      }
      terminal.refresh(0, Math.max(0, terminal.rows - 1));
    });
    // F: WebGL renderer loads AFTER open() (it initializes against the live
    // renderer). On context loss / no-GPU / headless CI it throws — catch and
    // silently fall back to the default DomRenderer. onContextLoss disposes the
    // addon so xterm reverts to canvas/dom automatically.
    // ponytail: ceiling — DomRenderer fallback hits the known CSP inline-style
    // bug (.review/A-web-ui-colors.md §3) on the web build, but that is a
    // pre-existing bug, not introduced by F. Desktop Electron is unaffected.
    const untrackAtlas = trackTerminalForAtlas(terminal);
    let webglCanvas: HTMLCanvasElement | null = null;
    // GPU reset → context restored: xterm re-inits its own renderer, but every
    // tile sharing the glyph atlas must drop its cell cache or it repaints
    // stale glyph fragments (and a selection made meanwhile only shows after
    // the next full redraw).
    const onWebglRestored = (): void => clearSharedTextureAtlas();
    try {
      const canvasesBefore = snapshotCanvases(terminal.element);
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        // #96: a lost GPU context is the half-transparent-window face of the
        // compositor falling over — the swap chain stops blending and the
        // desktop shows through. xterm silently reverts to the DOM renderer
        // (correct pixels, no GPU) but the window can stay see-through until
        // the surface is rebuilt, so surface it instead of swallowing it.
        console.warn("[coterm] WebGL context lost; falling back to DOM renderer", { terminalId: info.id });
        try {
          // Call the optional method through its receiver rather than hoisting it
          // into a local: the typed shape declares `voiceDiag?`, and a detached
          // reference is exactly the unbound-method hazard the lint rule names.
          void window.aiTerminal.voiceDiag?.({ stage: "webgl-context-loss", detail: `terminalId=${info.id}` });
        } catch { /* diagnostics are best-effort; never break the fallback */ }
        webgl.dispose();
        webglRef.current = null;
        setDegradedEngineKey(`${info.id}:${engineGeneration}`);
      });
      terminal.loadAddon(webgl);
      webglRef.current = webgl;
      webglCanvas = findNewCanvas(terminal.element, canvasesBefore);
      webglCanvas?.addEventListener("webglcontextrestored", onWebglRestored);
    } catch {
      webglRef.current = null;
    }
    // Browser/mobile must mirror the PTY geometry 1:1. Full-screen TUIs use
    // absolute cursor coordinates for both columns and rows; fitting only rows
    // to a phone would corrupt their alternate-screen redraw after a run ends.
    const remoteResize = (): void => {
      const rows = calculateRemoteRows({ fallbackRows: info.rows });
      terminal.resize(info.cols, rows);
    };
    // Chromium can pan an overflow ancestor horizontally when xterm focuses its
    // hidden textarea. During structural recovery, reset immediately and once
    // more on the next frame so the remote pane always returns to column zero.
    // This is deliberately NOT used for streamed output: users retain manual
    // horizontal pan until a real layout/replay/selection transition occurs.
    let remotePanResetFrame: number | null = null;
    const settleRemoteHorizontalPan = (): void => {
      if (isDesktop) return;
      resetRemoteHorizontalPan(host);
      if (remotePanResetFrame !== null) cancelAnimationFrame(remotePanResetFrame);
      remotePanResetFrame = requestAnimationFrame(() => {
        remotePanResetFrame = null;
        resetRemoteHorizontalPan(host);
      });
    };
    // terminal.scrollToBottom() only moves xterm's OWN internal scrollback
    // (.xterm-viewport). Remote clients mirror the PTY's full row count 1:1
    // (see remoteResize above), so the tree is routinely taller than the
    // visible host and .xterm-host-remote (not xterm) is the element that
    // actually clips/pans it (styles.css ~3144). Without also scrolling the
    // host, the cursor/prompt row stays below the fold — this was the "can't
    // see the typing input area" web/mobile regression.
    const scrollRemoteToBottom = (): void => {
      requestAnimationFrame(() => {
        terminal.scrollToBottom();
        host.scrollTop = host.scrollHeight;
      });
    };
    // Remote (web) desktop font-fit (pure math in terminal-remote-fit.ts):
    // shrink this pane's font until the whole host grid fits, no clipping and
    // no horizontal scroll. The shared PTY is NEVER resized from a remote
    // (rollback 2026-08-12); only the pane's own font size changes. Local
    // Electron and the mobile layout are skipped — phones keep pinch-zoom.
    let remoteFitFrame: number | null = null;
    let remoteFitCorrectionFrame: number | null = null;
    const applyRemoteFont = (size: number): void => {
      terminal.options.fontSize = size;
      clearSharedTextureAtlas();
      remoteResize();
      terminal.refresh(0, Math.max(0, terminal.rows - 1));
    };
    // One correction pass after applying a fitted font: re-measure the real
    // (rounded) cell size and step strictly smaller when the grid still
    // overflows. Never re-arms itself — the fit runs at most one correction.
    const scheduleRemoteFitCorrection = (): void => {
      if (remoteFitCorrectionFrame !== null) cancelAnimationFrame(remoteFitCorrectionFrame);
      remoteFitCorrectionFrame = requestAnimationFrame(() => {
        remoteFitCorrectionFrame = null;
        if (terminalRef.current !== terminal) return;
        if (window.matchMedia(MOBILE_LAYOUT_QUERY).matches) return;
        const fitHost = hostRef.current;
        if (!fitHost) return;
        const context = measureRemoteFitContext(terminal, fitHost, info.cols, info.rows);
        if (!context) return;
        const currentSize = terminal.options.fontSize;
        if (!isPositiveFinite(currentSize)) return;
        const corrected = nextRemoteFitCorrectionFontSize({ ...context, currentFontSize: currentSize });
        if (corrected !== null && corrected !== currentSize) {
          applyRemoteFont(corrected);
        }
      });
    };
    const scheduleRemoteFit = (): void => {
      if (isDesktop) return;
      if (window.matchMedia(MOBILE_LAYOUT_QUERY).matches) return;
      if (remoteFitFrame !== null) cancelAnimationFrame(remoteFitFrame);
      remoteFitFrame = requestAnimationFrame(() => {
        remoteFitFrame = null;
        if (terminalRef.current !== terminal) return;
        if (window.matchMedia(MOBILE_LAYOUT_QUERY).matches) return;
        const fitHost = hostRef.current;
        if (!fitHost) return;
        const context = measureRemoteFitContext(terminal, fitHost, info.cols, info.rows);
        if (!context) return;
        const currentSize = terminal.options.fontSize;
        if (!isPositiveFinite(currentSize)) return;
        const target = nextRemoteFitFontSize({
          ...context,
          measuredAtFontSize: currentSize,
          maxFontSize: terminalFontSizeRef.current,
        });
        if (target !== null && target !== currentSize) {
          applyRemoteFont(target);
        }
        scheduleRemoteFitCorrection();
      });
    };
    remoteFitRef.current = scheduleRemoteFit;
    // Design §5: hard refresh is a recovery pipeline, not a scrollback fetch.
    // planRecovery yields the ordered steps; this runner executes them against
    // the live terminal/host. The canvas refresh runs unconditionally so a
    // refresh takes effect even with no new PTY bytes. Coalesced via the
    // scheduler so rapid reflow triggers (sidebar/explorer/orientation/refresh)
    // collapse into one settled run (design §6). The runner receives the latest
    // reason for telemetry/debugging; the step list is reason-independent.
    const runRecovery = (reason: string): void => {
      // #14 retry: step dispatch extracted to executeRecoveryPlan so the
      // production recovery path is the tested one; the actions below still
      // own the live terminal/host side effects.
      executeRecoveryPlan(planRecovery(info.id), reason, {
        remeasure: () => {
          if (isDesktop) {
            fitTerminalToHost(terminal, host);
          } else {
            if (isMobileViewport && !pinchOverrideRef.current) {
              terminal.options.fontSize = Math.max(terminalFontSizeRef.current, fontSizeForViewport({
                viewportHeight: host.clientHeight > 0 ? host.clientHeight : window.innerHeight,
                rows: Math.max(1, info.rows),
                lineHeight: terminalLineHeight,
              }));
            }
            remoteResize();
          }
        },
        requestAuthoritativeReplay: (_replace, why) => {
          if (why === "manual-refresh" || why === "mobile-refresh") {
            // A user-requested refresh is deliberately stronger than an
            // automatic resize recovery: fetch the current byte snapshot,
            // then remount the entire renderer/addon stack from scratch.
            void window.aiTerminal.getTerminalWorkspace(info.projectId).then((workspace) => {
              if (disposed) return;
              const authoritative = workspace.scrollback[info.id];
              // An empty snapshot can occur during the tiny interval before
              // the first PTY chunk reaches main. Never turn a visible pane
              // blank during recovery; retain the latest known replay bytes.
              if (authoritative !== undefined) {
                initialDataRef.current = {
                  ready: true,
                  revision: workspace.scrollbackRevision[info.id] ?? 0,
                  data: authoritative,
                  force: true,
                };
              }
              setEngineGeneration((generation) => generation + 1);
            }).catch(() => {
              if (!disposed) void window.aiTerminal.refreshTerminal(info.id);
            });
          } else {
            // replace:true — the main process emits a replace event that
            // resets the xterm buffer and rewrites scrollback at matched width.
            void window.aiTerminal.refreshTerminal(info.id);
          }
        },
        refreshCanvas: () => {
          // Force xterm to re-render even if no new bytes arrived.
          terminal.refresh(0, terminal.rows - 1);
        },
        restoreFocusScroll: () => {
          scrollRemoteToBottom();
          // While MobileCommandComposer is open it owns ALL input focus for
          // this terminal (mirrors the writeInput guard above in this file).
          // Recovery fires on every mobile visualViewport resize — which is
          // exactly what a soft-keyboard hide/reshow during an IME language
          // switch produces — and terminal.focus() would yank focus into the
          // xterm helper textarea, killing composer typing mid-switch.
          if (isActive && !touchScrollingRef.current && !mobileInputController.isOpenFor(info.id)) terminal.focus();
          settleRemoteHorizontalPan();
        },
      });
    };
    // #94: recovery may only execute when no composition is live. Running
    // planRecovery mid-composition (replace:true replay) resets the buffer, so
    // the next keydown re-primes the IME helper textarea and re-snapshots the
    // anchor at (0,0) — the whole candidate box then sticks to the top-left
    // corner until compositionend. The gate stashes the latest reason and
    // onCompositionEnd replays it once the IME has relinquished the textarea.
    const composingGate = createComposingGate(
      () => composingRef.current,
      runRecovery,
    );
    const recoveryScheduler = createRecoveryScheduler((reason) => {
      composingGate.attempt(reason);
    });
    // Replay a stashed mid-composition recovery request now that the IME is
    // done with the textarea. Deferred so it runs after this handler (and the
    // committed writeInput above) has fully returned.
    const replayDeferredRecovery = (): void => {
      const reason = composingGate.takeDeferred();
      if (reason !== null) setTimeout(() => recoveryScheduler.schedule(reason), 0);
    };
    // Register this tile's scheduler so TopBar (desktop + mobile Refresh) and
    // layout-change triggers can route recovery through the same coalesced path
    // (design §6). Returns an unregister fn called on cleanup.
    const unregisterRecovery = useAppStore.getState().registerRecoveryScheduler(info.id, recoveryScheduler);
    // ResizeObserver is unreliable during iOS keyboard transitions because the
    // layout viewport may not change. VisualViewport does; feed it into the
    // same settled recovery pipeline after App updates the shell height.
    const visualViewport = isMobileViewport ? window.visualViewport : null;
    // While the extra input box (MobileCommandComposer) is open, keyboard
    // show/hide and IME candidate-bar changes fire visualViewport events per
    // keystroke. Each recovery does an authoritative replay that resets the
    // buffer — fatal for alt-screen TUIs (Codex): main-buffer bytes get stamped
    // over the live screen as garbage. Skip while open; run ONE settled
    // recovery when the composer closes.
    const onVisualViewportChange = (): void => {
      if (mobileInputController.isOpenFor(info.id)) return;
      recoveryScheduler.schedule("visual-viewport-change");
    };
    visualViewport?.addEventListener("resize", onVisualViewportChange);
    visualViewport?.addEventListener("scroll", onVisualViewportChange);
    let composerWasOpen = mobileInputController.isOpenFor(info.id);
    const unsubscribeComposer = visualViewport ? mobileInputController.subscribe(() => {
      const open = mobileInputController.isOpenFor(info.id);
      if (composerWasOpen && !open) recoveryScheduler.schedule("visual-viewport-change");
      composerWasOpen = open;
    }) : null;
    // Fit BEFORE writing scrollback: xterm wraps incoming ANSI against the
    // current cols/rows. Writing the snapshot at the default 80x24 then
    // fitting afterwards left historical lines wrapped to the wrong width,
    // which showed as duplicated/garbled rows on desktop (web was correct
    // because its WS replay hits an already-fitted Terminal).
    if (isDesktop) {
      fitTerminalToHost(terminal, host);
    } else {
      remoteResize();
    }
    // Each tile owns its OWN geometry: fit() to its container + resize its own
    // PTY (ResizeObserver below). We no longer snap to a shared global SoT —
    // that forced every tile to one cols/rows, so a differently-sized (or a
    // restart-stale) global garbled the render: overflow while typing (B7),
    // cursor drift (B8), and re-wrap duplication on scroll (B9). Web/mobile
    // already fit their own container.
    //
    // Desktop: defer the scrollback write until the first ResizeObserver fit,
    // so history wraps at the tile's TRUE width (the mount fit() above can
    // measure a not-yet-laid-out host). Live PTY data arriving before then is
    // buffered so ordering (history, then live) is preserved. Web/mobile write
    // immediately — their reconnect replay (replace:true) resets+rewrites, so
    // deferring would race that reset.
    let initialWritten = false;
    const hydration = new TerminalHydrationCoordinator();
    let applySnapshot = (_snapshot: TerminalSnapshotInput): void => undefined;
    const writeInitialOnce = (): void => {
      applySnapshot(initialDataRef.current);
    };
    const activeEl = document.activeElement;
    if (!isMobileViewport && !(activeEl instanceof HTMLTextAreaElement) && !(activeEl instanceof HTMLInputElement)) {
      terminal.focus();
      settleRemoteHorizontalPan();
    }
    // Suppress xterm's onData during AND briefly after composition.
    // xterm's internal _finalizeComposition fires the composed string
    // asynchronously via setTimeout(0) after compositionend, by which
    // point composingRef is already false. We use a flag to skip the
    // late onData fragment since we already wrote the full committed
    // string directly in onCompositionEnd.
    // #94: the suppress tail remembers WHICH string was committed, so the echo
    // is recognised by content instead of by timing alone. Anything that is not
    // an echo of the committed string is real input and is delivered even if it
    // lands inside the window (a fast latin keystroke right after a zhuyin
    // commit used to be swallowed by the blunt "drop everything" flag).
    let suppressedEcho = "";
    let justComposedClearTimer: ReturnType<typeof setTimeout> | null = null;
    const dataDisposable = terminal.onData((data) => {
      if (composingRef.current) return;
      if (justComposedRef.current && (data.length === 0 || suppressedEcho.includes(data))) {
        return;
      }
      if (window.matchMedia(MOBILE_LAYOUT_QUERY).matches && (data === "\r" || data === "\n")) return;
      writeInput(data);
    });
    // Throttle scrollToBottom to prevent frame thrashing on mobile when
    // streaming fast output. Batches rapid scroll calls via requestAnimationFrame.
    let scrollFrameId: number | null = null;
    const scheduleScroll = (): void => {
      if (scrollFrameId !== null) return; // already scheduled
      scrollFrameId = requestAnimationFrame(() => {
        terminal.scrollToBottom();
        if (!isDesktop) host.scrollTop = host.scrollHeight;
        scrollFrameId = null;
      });
    };
    // Coalesce rapid PTY chunks (e.g. a "thinking..." spinner redrawing many
    // times a second) into one terminal.write() per animation frame. Each
    // write forces a full re-parse/repaint (expensive on mobile WebViews);
    // scheduleScroll above only throttled the scroll half of this pipeline.
    let pendingWriteChunks: string[] = [];
    let writeFrameId: number | null = null;
    const flushPendingWrites = (): void => {
      writeFrameId = null;
      if (pendingWriteChunks.length === 0) return;
      const buf = terminal.buffer.active;
      const wasAtBottom = buf.viewportY >= buf.baseY - 1;
      const chunk = pendingWriteChunks.join("");
      pendingWriteChunks = [];
      terminal.write(renderData(chunk), () => {
        if (wasAtBottom) scheduleScroll();
      });
    };
    const scheduleWrite = (data: string): void => {
      pendingWriteChunks.push(data);
      if (writeFrameId !== null) return;
      writeFrameId = requestAnimationFrame(flushPendingWrites);
    };
    // Remote (browser/mobile): coalesce chunks via a 48ms quiet-window batcher
    // instead of rAF. Mobile WebViews throttle rAF when backgrounded and paint
    // per-write is expensive; the quiet window yields one write per spinner tick.
    // Desktop keeps scheduleWrite (rAF, tied to display refresh).
    const createRemoteBatcher = () => createTerminalStreamBatcher((chunk) => {
      const buf = terminal.buffer.active;
      const wasAtBottom = buf.viewportY >= buf.baseY - 1;
      terminal.write(renderData(chunk), () => {
        if (wasAtBottom) scheduleScroll();
      });
    });
    let remoteBatcher = isDesktop ? null : createRemoteBatcher();
    applySnapshot = (snapshot): void => {
      const action = hydration.acceptSnapshot(snapshot);
      if (action.kind !== "replace") return;

      const renderedSnapshot = action.snapshot + action.trailing;
      if (!initialWritten) {
        initialWritten = true;
        if (renderedSnapshot) {
          terminal.write(renderData(renderedSnapshot), () => {
            if (!isDesktop) {
              scrollRemoteToBottom();
              settleRemoteHorizontalPan();
            }
          });
        } else if (!isDesktop) {
          scrollRemoteToBottom();
          settleRemoteHorizontalPan();
        }
        return;
      }

      // Preserve the user's distance from the bottom across authoritative
      // replacement. This path is shared by late hydration, reconnect replay,
      // and manual recovery.
      const buf = terminal.buffer.active;
      const distanceFromBottom = Math.max(0, buf.baseY - buf.viewportY);
      const wasAtBottom = distanceFromBottom <= 1;
      if (isDesktop) fitTerminalToHost(terminal, host);
      else remoteResize();

      if (writeFrameId !== null) {
        cancelAnimationFrame(writeFrameId);
        writeFrameId = null;
      }
      pendingWriteChunks = [];
      remoteBatcher?.dispose();
      remoteBatcher = isDesktop ? null : createRemoteBatcher();
      terminal.reset();
      lightAnsiNormalizer.reset();
      terminal.write("\x1b[0m" + renderData(renderedSnapshot), () => {
        if (wasAtBottom) {
          scrollRemoteToBottom();
        } else if (distanceFromBottom > 0) {
          terminal.scrollLines(-distanceFromBottom);
        }
        terminal.refresh(0, Math.max(0, terminal.rows - 1));
        settleRemoteHorizontalPan();
      });
    };
    applyAuthoritativeSnapshotRef.current = applySnapshot;

    const offData = window.aiTerminal.onTerminalData((payload) => {
      if (payload.terminalId !== info.id) return;
      if (info.isAgent) onActivity(info.id);
      // Detect LLM name from terminal output for non-agent shells too.
      if (!detectedModel) {
        const m = payload.data.match(/(?:Claude Code|Codex|Claude|Gemini|GPT|Copilot|Cursor|Windsurf|Cline|Aider|Codeium|Replit|Cursor AI|Claude Desktop)/i);
        if (m) setDetectedModel(m[0]);
      }
      // Parse ANSI title escapes: \x1b]0;TITLE\x07. PTY chunks may split an
      // escape sequence, so keep only the unfinished tail for the next chunk.
      // Parsing all tiles is intentional: +agent can mark an already-mounted
      // shell after launch, and the next render should still have its summary.
      const parsedTitles = parseTerminalTitles(payload.data, titleParserBufferRef.current);
      titleParserBufferRef.current = parsedTitles.pending;
      for (const title of parsedTitles.titles) {
        if (title && title !== lastTitleRef.current) {
          lastTitleRef.current = title;
          setSessionTitle(title);
          if (info.isAgent && activeConversationId) {
            if (titleTimerRef.current) clearTimeout(titleTimerRef.current);
            titleTimerRef.current = setTimeout(() => {
              void window.aiTerminal.renameConversation({ conversationId: activeConversationId, name: title });
            }, 2000);
          }
        }
      }
      if (payload.replace) {
        const snapshot: TerminalSnapshotInput = {
          ready: true,
          revision: payload.revision,
          data: payload.data,
          ...(payload.force === undefined ? {} : { force: payload.force }),
        };
        initialDataRef.current = snapshot;
        applySnapshot(snapshot);
      } else {
        const live = hydration.acceptLive({
          revision: payload.revision,
          data: payload.data,
        });
        if (live.kind !== "append") return;
        // Pin-to-bottom: if the user's viewport is at (or near) the bottom,
        // scroll to bottom after writing so new output is visible. If the
        // user has scrolled up, preserve their position (don't yank them down).
        // Batched via scheduleWrite so a fast-redrawing spinner coalesces
        // into one write+scroll per frame instead of one per IPC chunk.
        if (isDesktop) scheduleWrite(live.data);
        else remoteBatcher?.push(live.data);
      }
    });
    if (!isDesktop) {
      writeInitialOnce();
      requestAnimationFrame(() => {
        remoteResize();
        scheduleRemoteFit();
        settleRemoteHorizontalPan();
      });
    }
    let fontResizeTimer: ReturnType<typeof setTimeout> | null = null;
    // Single source of truth for font-size changes (ctrl+wheel + A−/A+ buttons).
    // Clamps to [TERMINAL_FONT_SIZE_MIN, MAX], applies to the canvas immediately
    // (zero-latency feedback), runs the canonical redraw sequence (atlas clear →
    // fit/remoteResize → refresh → remote scroll), then debounces the settings
    // persist so a fast wheel spin doesn't hammer IPC. pendingFontSizeRef keeps
    // the [terminalFontSize,…] effect from snapping the canvas back to the stale
    // settings value during the debounce window.
    const applyFontSize = (rawNext: number): void => {
      const terminal = terminalRef.current;
      if (!terminal) return;
      const next = Math.min(
        TERMINAL_FONT_SIZE_MAX,
        Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(rawNext)),
      );
      // Remote web-desktop: the canvas gets the fit-clamped value, never past
      // what the pane holds. pendingFontSizeRef / the settings persist keep
      // writing the user's `next`; only the applied font is clamped.
      const fitted = isDesktop || window.matchMedia(MOBILE_LAYOUT_QUERY).matches
        ? null
        : remoteFitTargetFor(terminal, host, info.cols, info.rows, next);
      pendingFontSizeRef.current = next;
      terminal.options.fontSize = fitted !== null && fitted < next ? fitted : next;
      clearSharedTextureAtlas();
      if (isDesktop) fitTerminalToHost(terminal, host);
      else remoteResize();
      terminal.refresh(0, Math.max(0, terminal.rows - 1));
      if (!isDesktop) scrollRemoteToBottom();
      if (fontResizeTimer) clearTimeout(fontResizeTimer);
      fontResizeTimer = setTimeout(() => {
        if (disposed) return;
        // The ConPTY still holds the PRE-font-change cols/rows. fit() above only
        // moved xterm's own grid, so without this the shell keeps wrapping to a
        // stale width (the classic garbled-rows bug). Debounced separately from
        // the canvas work because the IPC is the expensive part.
        if (isDesktop) {
          void window.aiTerminal.resizeTerminal({
            terminalId: info.id,
            cols: terminal.cols,
            rows: terminal.rows,
          });
        }
        const store = useAppStore.getState();
        const settings = store.settings;
        if (!settings) {
          // Settings not loaded yet — keep the local application only.
          pendingFontSizeRef.current = null;
          return;
        }
        void store.updateSettings(terminalFontSizePatch(next)).then(() => {
          // Persist caught up; clear pending only if it still matches our write
          // (a newer wheel event may have set a different pending value).
          if (pendingFontSizeRef.current === next) pendingFontSizeRef.current = null;
        });
      }, 250);
    };
    applyFontSizeRef.current = applyFontSize;
    let imeWindowScrollX = 0;
    let imeScrollLock: ScrollLockEntry[] = [];
    const lockImeHorizontalLayout = () => {
      // Restores the offsets captured at compositionstart (see
      // terminal-ime-scroll-lock.ts). Desktop locks the xterm boxes to 0 — the
      // host never legitimately scrolls sideways there, that lock exists to
      // counter ConPTY's resize re-wrap shoving fitted content sideways mid
      // composition. Remote/mobile hosts (.xterm-host-remote) rely on
      // host.scrollLeft as their only way to pan to a cursor beyond the
      // initial viewport (PTY geometry is mirrored 1:1, wider than the
      // screen), so there the pan is FROZEN at its live value instead of
      // zeroed: forcing 0 would pin the view to column 0 while the
      // composition-view — positioned relative to the unscrolled .xterm tree —
      // keeps rendering at the true cursor x, reading as "runs past the right
      // edge".
      restoreHorizontalScrollLock(imeScrollLock);
      if (window.scrollX !== imeWindowScrollX) window.scrollTo(imeWindowScrollX, window.scrollY);
    };
    // Chromium's reveal-caret scroll fires once PER KEYSTROKE, long after
    // compositionstart: the composed text streams into the 1-cell-wide helper
    // textarea, its caret leaves the box, and Chromium shifts the nearest
    // scrollable ancestor to reveal it (the "畫面每打一個字往左推一格" bug).
    // Scroll events don't bubble, so this listens in the CAPTURE phase on
    // window — it sees the scroll of whichever box Chromium picked, xterm
    // internals or any ancestor, and puts it back in the same frame (scroll
    // steps run before paint), so nothing visibly moves.
    const imeScrollCaptureOptions: AddEventListenerOptions = { capture: true, passive: true };
    const onImeScrollCapture = () => {
      if (!composingRef.current) return;
      lockImeHorizontalLayout();
    };
    // xterm's CompositionHelper.updateCompositionElements() is NOT called on
    // compositionstart — only on compositionupdate + onRender (rAF-debounced).
    // So after the cursor moves (Enter newline / arrow keys), buffer.x/y are
    // already updated but the composition-view/textarea inline left/top still
    // hold the previous frame's coords. The IME reads textarea.getBoundingClientRect()
    // at compositionstart to place its candidate window → it renders at the stale
    // position. We force a reposition using the same formula xterm uses internally
    // (cursorX*cellWidth, cursorY*cellHeight) so the values match and don't flicker.
    const repositionComposition = () => {
      if (!composingRef.current) return;
      // Use the compositionstart snapshot, NOT the live buffer: while the IME
      // is composing, the agent may still be streaming output (spinner/tokens)
      // which scrolls the viewport and shifts buf.cursorY — re-reading it here
      // would drag the composition-view box up/down with every scroll tick.
      // The box must stay pinned to the cell where typing began.
      const snap = composeAnchorRef.current;
      if (!snap) return;
      const cellWidth = snap.cellW;
      const cellHeight = snap.cellH;
      const cursorLeft = snap.x * cellWidth;
      const cursorTop = snap.y * cellHeight;
      // Design §7: clamp the IME candidate to the visible host so it never
      // overflows the right/bottom edge, and flip above the cursor when there's
      // no room below. cursorRect is in host-local coords (xterm renders the
      // cursor inside .xterm-rows which is offset 0,0 within host), and the
      // composition-view/textarea are also host-local, so hostRect is the host
      // itself. scroll documents the remote pan state (does not shift the
      // anchor — cursorRect is already viewport-local).
      // candidateSize: width is the horizontal clamp budget (8 cells); height
      // is now ONE cell, not two — the composition-view is a single-line inline
      // preview, and a 2-cell height was what made calculateImeAnchor flip the
      // box below<->above the cursor across keystrokes (the vertical jitter).
      const anchor = calculateImeAnchor({
        cursorRect: { left: cursorLeft, top: cursorTop, width: cellWidth, height: cellHeight },
        hostRect: { left: 0, top: 0, width: host.clientWidth, height: host.clientHeight },
        scroll: { x: host.scrollLeft, y: host.scrollTop },
        candidateSize: { width: cellWidth * 8, height: cellHeight },
      });
      // Write the pinned position as CSS variables on the host. The actual
      // placement is done by the `.ime-composing .composition-view / textarea`
      // rule via `transform: translate(var(--ime-x), var(--ime-y))`, and
      // left/top are locked to 0 with !important so xterm's own
      // updateCompositionElements() inline writes (live buf.cursorY) become
      // harmless no-ops — eliminating the rAF-vs-setTimeout(0) flicker.
      // Variables are set on the host (common ancestor) and inherited by both
      // the composition-view and the helper-textarea.
      host.style.setProperty("--ime-x", `${anchor.left}px`);
      host.style.setProperty("--ime-y", `${anchor.top}px`);
      const cv = host.querySelector<HTMLElement>(".composition-view");
      if (cv) {
        // Sync font metrics to the live terminal options so the preview glyph
        // metrics match the xterm cell exactly (xterm's updateCompositionElements
        // does the same, but it runs on a setTimeout(0) recurse that can lag a
        // frame; asserting here keeps the first keystroke aligned).
        cv.style.height = `${cellHeight}px`;
        cv.style.lineHeight = `${cellHeight}px`;
        cv.style.fontFamily = terminal.options.fontFamily ?? "";
        cv.style.fontSize = `${terminal.options.fontSize ?? 13}px`;
      }
    };
    // The OS IME reads textarea.getBoundingClientRect() AT compositionstart to
    // place its candidate window — before our compositionstart handler writes
    // --ime-x/--ime-y. Between segments the textarea keeps the position from the
    // previous composition (#33: "candidate box collapses to a stale spot, most
    // visible near line start"). Prime the textarea's inline left/top at the
    // live cursor on every keydown, so the rect the IME reads is already fresh.
    const primeTextareaAtLiveCursor = () => {
      if (!textarea || composingRef.current) return;
      const buf = terminal.buffer.active;
      const cell = readTerminalCellMetrics(terminal);
      const rowsEl = host.querySelector<HTMLElement>(".xterm-rows");
      const cellHeight = cell?.height || (rowsEl?.firstElementChild as HTMLElement | null)?.clientHeight || 16;
      const cellWidth = cell?.width || (terminal.cols > 0 ? host.clientWidth / terminal.cols : cellHeight * 0.6);
      // Textarea left/top live in .xterm space (the cell grid), not host space:
      // the sunmoon skin pads .xterm-host, and host.clientWidth includes that
      // padding, so the width budget must come from the .xterm grid itself.
      const xtermEl = host.querySelector<HTMLElement>(".xterm");
      const gridWidth = xtermEl?.clientWidth || host.clientWidth;
      const cursorLeft = Math.min(buf.cursorX, Math.max(0, terminal.cols - 1)) * cellWidth;
      textarea.style.left = `${cursorLeft}px`;
      textarea.style.top = `${buf.cursorY * cellHeight}px`;
      // #80: give the textarea a non-zero rect here in the normal frame —
      // Windows TSF reads the caret bounds at compositionstart (before our
      // compositionstart handler can react); a 0x0/clipped rect made the IME
      // candidate window fall back to the window's bottom-right corner.
      // The box must be wide enough for the whole preedit, not 1 cell: as the
      // zhuyin string grows, an overflowing caret rect gets clipped; under
      // fractional display scaling (125%/150% company monitors) the clipped
      // rect reads invalid and the candidate window again falls back to
      // bottom-right (2026-10-02). 8 cells holds a full zhuyin preedit; once
      // composing, xterm's updateCompositionElements re-syncs the width to the
      // actual composition-view. The textarea stays invisible (opacity 0,
      // z-index -5) outside composition, so the wider box changes nothing
      // visually.
      const boxWidth = Math.max(cellWidth, Math.min(cellWidth * 8, gridWidth - cursorLeft));
      textarea.style.width = `${boxWidth}px`;
      textarea.style.height = `${cellHeight}px`;
    };
    const beginImeLayoutLock = () => {
      imeWindowScrollX = window.scrollX;
      imeScrollLock = [
        ...captureHorizontalScrollLock(imeInnerScrollTargets(host), { zero: isDesktop }),
        ...captureHorizontalScrollLock(imeAncestorScrollTargets(host)),
        ...captureHorizontalScrollLock([document.scrollingElement]),
      ];
      host.classList.add("ime-composing");
      lockImeHorizontalLayout();
      window.addEventListener("scroll", onImeScrollCapture, imeScrollCaptureOptions);
    };
    const endImeLayoutLock = () => {
      window.removeEventListener("scroll", onImeScrollCapture, imeScrollCaptureOptions);
      // The lock entries are deliberately NOT cleared here: compositionend
      // schedules one more lockImeHorizontalLayout() on a setTimeout(0), after
      // xterm's own async _finalizeComposition has run, and that late pass is
      // what catches a reveal-scroll triggered by the commit itself.
      lockImeHorizontalLayout();
      host.classList.remove("ime-composing");
    };
    // #14 retry: ctrl+wheel zoom decision extracted to terminal-input-routing.
    // xterm v6 owns plain-wheel scrolling natively (a second local scrollLines
    // fought it into jitter); only ctrl+wheel font-zoom is ours.
    const onWheel = (event: WheelEvent) => {
      routeCtrlWheelZoom(event, {
        getFontSize: () => terminal.options.fontSize ?? terminalFontSizeRef.current,
        applyFontSize,
      });
    };
    // passive:false is mandatory because Ctrl+wheel calls preventDefault().
    // passive:true let Chromium page-zoom AND xterm font-zoom run together,
    // producing mismatched canvas metrics and visibly duplicated rows.
    const wheelOptions: AddEventListenerOptions = { capture: true, passive: false };
    host.addEventListener("wheel", onWheel, wheelOptions);
    // Click-to-move-caret: Alt+click moves the PTY cursor to the clicked cell
    // by emitting arrow-key escape sequences (xterm's own altClickMovesCursor
    // behavior). A plain click does NOT move the caret — on an interactive
    // prompt (readline / claude code) arrow keys are interpreted as history
    // recall or line editing, so sending them on every plain click made the
    // shell surface a previous message the moment the user clicked the input
    // area. Alt+click is opt-in and matches the platform convention.
    const onClickMoveCaret = (event: MouseEvent) => {
      // Only alt+primary-button; plain click and other modifiers are left alone.
      if (event.button !== 0 || !event.altKey || event.shiftKey || event.ctrlKey || event.metaKey) return;
      // Don't interfere with text selection.
      if (terminal.hasSelection()) return;
      const buf = terminal.buffer.active;
      // Only the normal buffer (full-screen TUIs in the alt buffer position
      // the cursor themselves; sending arrows would corrupt them).
      if (buf.type !== "normal") return;
      // Viewport must be at the bottom — clicking scrollback history can't
      // move the live cursor, and a scrolled-up view means the clicked row
      // isn't the live input row.
      if (buf.viewportY < buf.baseY - 1) return;
      // If the app enabled mouse tracking, xterm forwards mouse events to it;
      // we must not inject arrow keys on top of that. Private API — probe via
      // the 6.0/6.1 compat helper and bail (no send) when reporting is active.
      try {
        if (xtermMouseReportingActive(terminal)) return;
      } catch { return; }
      // Map the click to a cell. Reuse xterm's own cell metrics when available
      // (same source repositionComposition uses) so the column matches what the
      // user sees; fall back to host width / cols.
      const cell = readTerminalCellMetrics(terminal);
      const cellHeight = cell?.height || (host.querySelector<HTMLElement>(".xterm-rows")?.firstElementChild as HTMLElement | null)?.clientHeight || 16;
      const cellWidth = cell?.width || (terminal.cols > 0 ? host.clientWidth / terminal.cols : cellHeight * 0.6);
      const rect = host.getBoundingClientRect();
      const relX = event.clientX - rect.left;
      const relY = event.clientY - rect.top;
      // xterm cells are 0-based; clamp into [0, cols-1] / [0, rows-1].
      const targetX = Math.min(Math.max(0, Math.floor(relX / cellWidth)), terminal.cols - 1);
      const targetY = Math.min(Math.max(0, Math.floor(relY / cellHeight)), terminal.rows - 1);
      const seq = moveToCellSequence(
        { x: Math.min(buf.cursorX, terminal.cols - 1), y: buf.cursorY },
        { x: targetX, y: targetY },
      );
      if (!seq) return;
      event.preventDefault();
      void window.aiTerminal.writeTerminal({ terminalId: info.id, data: seq }).catch(swallowIfTerminalGone);
    };
    host.addEventListener("click", onClickMoveCaret);
    // Plain drag selects text even inside mouse-tracking TUIs (Claude Code /
    // Codex); xterm alone only selects there with Shift held.
    const uninstallTuiDragSelect = installTuiDragSelect(terminal, host, (chars) => {
      const frame = host.closest<HTMLElement>(".xterm-pane-frame");
      if (!frame) return;
      frame.querySelector(".xterm-copied-toast")?.remove();
      const toast = document.createElement("div");
      toast.className = "xterm-copied-toast";
      toast.setAttribute("role", "status");
      toast.textContent = translate(useAppStore.getState().settings?.locale, "dock.ref.copied.selection", { count: chars });
      frame.appendChild(toast);
      setTimeout(() => toast.remove(), 1600);
    });
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const resize = new ResizeObserver((entries) => {
      // Fit IMMEDIATELY (no debounce): xterm's canvas must snap to the measured
      // host width on every resize event, otherwise the cols/rows diverge from
      // the visible area and input appears to stretch horizontally past the edge
      // (4-1). The PTY-side resize is debounced separately below to avoid
      // thrashing the backend; the double-debounce was the root cause of the
      // race — both xterm and PTY were on independent 80ms timers.
      // Browser/mobile never fit to the container — they render at the PTY's
      // geometry (1:1) and pan via .xterm-host-remote; fit() here would undo the
      // mount-time resize(info.cols/rows) and re-wrap wide rows to screen width.
      if (isDesktop) fitTerminalToHost(terminal, host);
      // Browser/mobile: keep the PTY geometry 1:1, then pin to bottom after a
      // viewport change. The host may scroll; xterm itself must not be resized.
      // Schedule a coalesced recovery so rapid viewport/orientation/terminal-
      // switch changes settle into one reflow + canvas refresh (design §5/§6).
      else {
        remoteResize();
        scheduleRemoteFit();
        scrollRemoteToBottom();
        settleRemoteHorizontalPan();
        recoveryScheduler.schedule("viewport-resize");
      }
      // Desktop deferred-write: once the host has a real width, flush the
      // scrollback (and any buffered live data) at the true column count. A
      // 0-width first fire would garble the wrap, so gate on a measured width.
      if (!initialWritten && (entries[0]?.contentRect.width ?? host.clientWidth) > 0) {
        writeInitialOnce();
      }
      if (resizeTimer) clearTimeout(resizeTimer);
      // ponytail: only the backend PTY resize is IME-guarded here — ConPTY's
      // re-wrap is what visually shoves committed text sideways mid-composition.
      // fit() above still runs unconditionally so xterm's own render dimensions
      // (used to position the composition-view box) stay correct while typing.
      if (isDesktop && !composingRef.current) {
        resizeTimer = setTimeout(() => {
          void window.aiTerminal.resizeTerminal({
            terminalId: info.id,
            cols: terminal.cols,
            rows: terminal.rows,
          });
          // ponytail: after the PTY adopts the new geometry, re-sync the canvas
          // via the coalesced recovery pipeline (design §5/§6). planRecovery's
          // request-authoritative-replay step calls refreshTerminal (replace:true)
          // to reset the xterm buffer and rewrite scrollback at the matched
          // width; refresh-canvas forces a re-render even with no new bytes.
          // 120ms lets ConPTY finish its async re-flow before we snapshot it.
          setTimeout(() => {
            recoveryScheduler.schedule("desktop-resize");
          }, 120);
        }, 200);
      }
    });
    resize.observe(host);
    let textarea: HTMLTextAreaElement | null = null;
    const onCompositionStart = () => {
      composingRef.current = true;
      beginImeLayoutLock();
      // Snapshot the cursor's viewport coords + cell size NOW, at the moment
      // composition begins. The IME candidate box must anchor to the cell the
      // user sees as the typing origin — that is the live cursor position at
      // compositionstart, before any async PTY echo (CRLF on a just-pressed
      // Enter, ANSI cursor moves) lands and shifts buffer.x/y. Deferring the
      // snapshot a frame let that echo move the anchor away from the visual
      // start, which was the "candidate box drifts off the cursor" symptom.
      const buf = terminal.buffer.active;
      const cell = readTerminalCellMetrics(terminal);
      const rowsEl = host.querySelector<HTMLElement>(".xterm-rows");
      const cellHeight = cell?.height || (rowsEl?.firstElementChild as HTMLElement | null)?.clientHeight || 16;
      const cellWidth = cell?.width || (terminal.cols > 0 ? host.clientWidth / terminal.cols : cellHeight * 0.6);
      // Fullscreen agent TUIs (Claude Code alt-screen) park the real cursor in
      // the bottom-right corner and draw their own caret, so the IME box landed
      // in the corner. Anchor to the end of the live input row instead.
      const tuiCaret = buf.type === "alternate" ? findTuiInputCaret(terminal) : null;
      composeAnchorRef.current = {
        x: Math.min(tuiCaret?.x ?? buf.cursorX, Math.max(0, terminal.cols - 1)),
        y: tuiCaret?.y ?? buf.cursorY,
        cellW: cellWidth,
        cellH: cellHeight,
      };
      repositionComposition();
    };
    const onCompositionUpdate = () => {
      if (!composingRef.current) return;
      // xterm's updateCompositionElements() will still fire on a setTimeout(0)
      // and write its own inline left/top using the LIVE buf.cursorY, but those
      // writes are now harmless: the .ime-composing CSS rule locks left/top to
      // 0 with !important and drives placement via transform + the --ime-x/--ime-y
      // variables we set at compositionstart. No reposition race needed.
      lockImeHorizontalLayout();
    };
    const onCompositionEnd = (event: CompositionEvent) => {
      // event.data holds the final committed string from the IME.
      // Write it directly to the PTY exactly once, bypassing xterm's
      // onData (which is gated by composingRef and would otherwise
      // receive a potentially-truncated fragment from xterm's async
      // _finalizeComposition setTimeout path).
      composingRef.current = false;
      justComposedRef.current = true;
      composeAnchorRef.current = null;
      endImeLayoutLock();
      // Heal a dropped geometry sync: the ResizeObserver skips the backend PTY
      // resize while composing (ConPTY's re-wrap would shove committed text
      // mid-composition), and nothing re-sent it afterwards — so if the tile
      // resized mid-composition, xterm and ConPTY held different rows/cols
      // until the next window resize (mismatched repaint / dead bottom row).
      // Re-fit + re-send once composition ends; idempotent when nothing moved.
      if (isDesktop) {
        fitTerminalToHost(terminal, host);
        void window.aiTerminal.resizeTerminal({
          terminalId: info.id,
          cols: terminal.cols,
          rows: terminal.rows,
        });
      }
      const committed = event.data ?? "";
      // #94: arm the content-matched echo suppression for the whole tail.
      suppressedEcho = committed;
      if (committed.length > 0) {
        writeInput(committed);
      }
      // Single-flight timer: a fast compositionend -> compositionstart chain
      // must restart the window, not stack a clearing timer that expires in the
      // middle of the NEXT composition's tail.
      if (justComposedClearTimer !== null) clearTimeout(justComposedClearTimer);
      // #94: the window used to be one setTimeout(0). During a freeze (DB lock,
      // ConPTY reflow) xterm's _finalizeComposition setTimeout(0) slips well
      // past that single tick, so the late fragment was no longer suppressed and
      // the composed string reached the PTY twice — the "double character"
      // symptom. Hold the flag for a settled ~120ms window instead, and clear it
      // only when nothing is composing, so a middle-of-phrase compositionend
      // never wipes the IME's live buffer.
      const clearSuppression = (): void => {
        justComposedClearTimer = null;
        justComposedRef.current = false;
        suppressedEcho = "";
        // Typing a long phrase (20+ zhuyin syllables) without pausing chains
        // compositionend -> compositionstart segments faster than this window:
        // a new composition can already be live by the time this fires.
        // Clearing textarea.value then would wipe the IME's own in-progress
        // buffer out from under it mid-composition, which the IME reads to
        // build its next candidate — the observed symptom was later segments
        // of a long phrase silently vanishing. Only clear once nothing is
        // actively composing.
        if (textarea && !composingRef.current) textarea.value = "";
        lockImeHorizontalLayout();
      };
      const suppressionWindowMs = 120;
      justComposedClearTimer = setTimeout(() => {
        if (composingRef.current) {
          // A new composition owns the textarea now; re-check shortly instead
          // of dropping the cleanup entirely.
          justComposedClearTimer = setTimeout(clearSuppression, suppressionWindowMs);
          return;
        }
        clearSuppression();
      }, suppressionWindowMs);
      // #94: any recovery that was stashed while composing (desktop resize
      // debounce, viewport change, manual refresh) runs now — after the commit
      // is safely in the PTY, so the authoritative replay includes it.
      replayDeferredRecovery();
    };
    const onBlur = () => {
      composingRef.current = false;
      justComposedRef.current = false;
      suppressedEcho = "";
      if (justComposedClearTimer !== null) {
        clearTimeout(justComposedClearTimer);
        justComposedClearTimer = null;
      }
      composeAnchorRef.current = null;
      endImeLayoutLock();
    };
    // Mobile soft keyboards often swallow Space/Enter before xterm's onData
    // fires, so the keystroke never reaches the PTY. Intercept at the textarea
    // (capture phase) and write directly when not mid-composition. Desktop
    // keyboards go through xterm's normal path, so this is mobile-only.
    const mobileMatch = window.matchMedia(MOBILE_LAYOUT_QUERY);
    const onSoftKey = (event: KeyboardEvent) => {
      if (!mobileMatch.matches || composingRef.current) return;
      if (event.key === " " || event.key === "Spacebar") {
        event.preventDefault();
        writeInput(" ");
      } else if (event.key === "Enter") {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const onTerminalKeyDown = (event: KeyboardEvent) => {
      if (composingRef.current) return;
      if (
        event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        event.key.toLowerCase() === "a"
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        clearNextDeleteRef.current = true;
        terminal.selectAll();
        return;
      }
      if (
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        (event.key === "Backspace" || event.key === "Delete") &&
        clearSelectedInput()
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const onPaste = (event: ClipboardEvent) => {
      const item = [...(event.clipboardData?.items ?? [])].find((entry) =>
        entry.type.startsWith("image/"),
      );
      const file = item?.getAsFile();
      if (!file || !activeConversationId) {
        // Non-image paste: let xterm's own built-in textarea "paste" listener
        // (registered during terminal.open(), fires before this one — DOM
        // dispatch runs same-target listeners in registration order even
        // across capture/bubble) handle it. It already applies CRLF
        // normalization and bracketed-paste wrapping via coreService.
        // triggerDataEvent. Previously this branch ALSO called writeInput(text)
        // with the raw, unbracketed string, so every text paste was sent to
        // the PTY twice — once correctly bracketed (from xterm) and once as
        // bare keystrokes. Readline-based agent CLIs (Codex/Claude) that
        // enable bracketed-paste mode read that second unbracketed copy as
        // literal Enter-terminated input rather than a paste, which is what
        // broke pasting text into codex-local-main/claude tiles. Returning here
        // (no preventDefault/stop) lets xterm's own handler be the only one
        // that acts, exactly once.
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      void saveAttachmentRef.current(new File([file], `terminal-paste-${Date.now()}.png`, { type: file.type }))
        .then((attachment) =>
          window.aiTerminal.writeTerminal({
            terminalId: info.id,
            data: quoteTerminalPath(attachment.localPath, info.profile),
          }),
        )
        .catch(swallowIfTerminalGone);
    };
    // --- Mobile live-gesture split: swipe = scroll, tap = type ---------------
    // xterm v6 registers NO touchstart/touchmove/touchend on the terminal
    // (only mousedown/wheel), so we own touch entirely on mobile. The hidden
    // textarea lives at left:-9999em so touches land on .xterm-host/.xterm-screen.
    //
    // CRITICAL: focus() must NOT happen on touchstart/pointerdown — it fires
    // before touchmove's swipe verdict, so any swipe popped the keyboard within
    // ~0.x s. We defer focus to touchend, and only for a clean tap (no move,
    // <300ms). Until the tap is confirmed, a focus guard on the textarea blurs
    // immediately so xterm's internal auto-focus can't sneak in either.
    const mobileMedia = window.matchMedia(MOBILE_LAYOUT_QUERY);
    const SCROLL_THRESHOLD_PX = 6; // |dy| beyond this = swipe, not tap
    const LONG_PRESS_MS = 450;
    const touchStartXRef = { current: 0 };
    const touchLastXRef = { current: 0 };
    const touchStartYRef = { current: 0 };
    const touchLastYRef = { current: 0 };
    const scrollResidualRef = { current: 0 };
    const touchStartTRef = { current: 0 };
    const touchStartedInInputZoneRef = { current: false };
    // touchPendingTapRef: a touch started and hasn't been classified as a swipe.
    // While true, the textarea focus guard force-blurs to keep the keyboard down.
    const touchPendingTapRef = { current: false };
    // Axis lock (#57): horizontal-vs-vertical chosen ONCE per gesture at the
    // first threshold crossing; re-deciding every move event with a raw 45°
    // split let tiny vertical drift flip a sideways swipe into scrolling.
    const touchAxisLockRef = { current: null as "horizontal" | "vertical" | null };
    // Two-pointer pinch zoom state. Design §2: pinch changes ONLY the local
    // xterm font scale — it never calls resizeTerminal (backend ConPTY geometry
    // is the main process's source of truth). startDistance is captured when the
     // second pointer lands; currentDistance drives nextPinchFontSize.
     const pinchStartDistanceRef = { current: 0 };
     const pinchStartFontSizeRef = { current: 13 };
     const pinchActiveRef = { current: false };
    const twoFingerDistance = (t1: Touch, t2: Touch): number => {
      const dx = t1.clientX - t2.clientX;
      const dy = t1.clientY - t2.clientY;
      return Math.hypot(dx, dy);
    };
    const isAtScrollbackBottom = () => {
      const buffer = terminal.buffer.active;
      return buffer.viewportY >= buffer.baseY - 1;
    };
    const onTouchStart = (e: TouchEvent) => {
      if (!mobileMedia.matches) return;
      // Two-finger pinch begins: capture the start distance and mark pinch
      // active so single-pointer swipe/tap logic stays dormant. preventDefault
      // stops the browser's own pinch-to-zoom (we own the gesture).
      if (e.touches.length === 2) {
         pinchActiveRef.current = true;
         pinchOverrideRef.current = true;
         scrollResidualRef.current = 0;
         touchPendingTapRef.current = false;
         touchScrollingRef.current = false;
         touchAxisLockRef.current = null;
         pinchStartDistanceRef.current = twoFingerDistance(e.touches[0]!, e.touches[1]!);
         pinchStartFontSizeRef.current = terminal.options.fontSize ?? 13;
        e.preventDefault();
        return;
      }
      if (e.touches.length !== 1) return;
      touchScrollingRef.current = false;
      touchPendingTapRef.current = true;
      // Fresh gesture: clear the axis lock so the first threshold crossing
      // classifies THIS touch (horizontal pan vs vertical scroll).
      touchAxisLockRef.current = null;
      touchStartXRef.current = e.touches[0]!.clientX;
      touchLastXRef.current = e.touches[0]!.clientX;
      touchStartYRef.current = e.touches[0]!.clientY;
      touchLastYRef.current = e.touches[0]!.clientY;
      scrollResidualRef.current = 0;
      touchStartTRef.current = e.timeStamp;
      touchStartedInInputZoneRef.current =
        isAtScrollbackBottom() && isInMobileInputZone(e.touches[0]!.clientY, host.getBoundingClientRect());
      if (touchScrollResetTimer.current) {
        clearTimeout(touchScrollResetTimer.current);
        touchScrollResetTimer.current = null;
      }
      // Pre-emptively drop the keyboard in case it was up from a prior tap.
      // The focus guard below keeps it down until a clean tap is confirmed.
      if (textarea && document.activeElement === textarea) textarea.blur();
    };
    // #47: does the PTY app want mouse events? When it does, xterm binds its
    // own wheel listener and encodes wheel input as SGR mouse events back to
    // the PTY (the CLI scrolls its own transcript); scrollLines() is then a
    // no-op on the alt buffer. Touch swipes must take that same path.
    const isMouseReportingActive = (): boolean => xtermMouseReportingActive(terminal);
    // Synthesize wheel events onto xterm's own encoding path. Returns false
    // when mouse reporting is off / the private API is absent → caller falls
    // back to local scrollLines(). Sent one event per consumed touch line.
    const reportTouchWheel = (lines: number, clientX: number, clientY: number): boolean => {
      const plan = planTouchWheelEvents(lines);
      if (!plan) return false;
      const rect = host.getBoundingClientRect();
      // AT-156: an unmeasured (0-wide / hidden) host or any non-finite input
      // yields null — do not send; a NaN col/row would reach the PTY as the
      // literal bytes "NaN" and shell readline echoes the tail as `;NaN;NaNM`.
      const cell = touchMouseCell({
        clientX,
        clientY,
        rectLeft: rect.left,
        rectTop: rect.top,
        hostWidth: host.clientWidth,
        cols: terminal.cols,
        rows: terminal.rows,
        cellHeight: terminalCellHeight(host, { rows: terminal.rows }),
      });
      if (!cell) return false;
      for (let i = 0; i < plan.count; i++) {
        if (!xtermTriggerMouseEvent(terminal, { col: cell.col, row: cell.row, x: clientX, y: clientY, button: plan.button, action: plan.action, ctrl: false, alt: false, shift: false })) {
          return false;
        }
      }
      return true;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!mobileMedia.matches) return;
      // Pinch in progress: scale the LOCAL font only. No fit(), no
      // resizeTerminal — the shared PTY geometry is untouched (design §2).
      if (pinchActiveRef.current && e.touches.length === 2) {
        e.preventDefault();
         const currentDistance = twoFingerDistance(e.touches[0]!, e.touches[1]!);
         const current = terminal.options.fontSize ?? 13;
         const next = nextPinchFontSize({
           currentSize: pinchStartFontSizeRef.current,
          startDistance: pinchStartDistanceRef.current,
          currentDistance,
        });
        if (next !== current) terminal.options.fontSize = next;
        return;
      }
      if (e.touches.length !== 1) return;
      const currentX = e.touches[0]!.clientX;
      const currentY = e.touches[0]!.clientY;
      const totalDx = currentX - touchStartXRef.current;
      const totalDy = currentY - touchStartYRef.current;
      if (!touchScrollingRef.current
          && Math.abs(totalDy) < SCROLL_THRESHOLD_PX
          && Math.abs(totalDx) < SCROLL_THRESHOLD_PX) return;
      // It's a swipe — mark scrolling so pointerdown/isActive skip focus().
      touchScrollingRef.current = true;
      touchPendingTapRef.current = false;
      // preventDefault stops the synthesized mousedown that would focus+pop keyboard.
      e.preventDefault();
      // Axis lock (#57): classify the swipe axis ONCE at the first threshold
      // crossing and keep it for the whole gesture. Re-deciding every event
      // with a raw 45° split let tiny vertical drift flip a sideways swipe
      // into vertical scrolling mid-pan.
      if (!touchAxisLockRef.current) {
        // Hold the verdict until the finger has travelled far enough; the
        // movement isn't lost — the first locked move consumes it all.
        if (Math.hypot(totalDx, totalDy) < SWIPE_AXIS_DECIDE_PX) return;
        touchAxisLockRef.current = classifySwipeAxis(totalDx, totalDy);
      }
      // Horizontal lock (mobile only, same gate as before) → dx-only pan.
      if (!isDesktop && touchAxisLockRef.current === "horizontal") {
        applyRemoteHorizontalTouchPan(host, currentX - touchLastXRef.current);
        touchLastXRef.current = currentX;
        touchLastYRef.current = currentY;
        if (textarea && document.activeElement === textarea) textarea.blur();
        return;
      }
      const delta = consumeScrollDelta({
        residualPx: scrollResidualRef.current,
        deltaPx: currentY - touchLastYRef.current,
        cellHeightPx: terminalCellHeight(host, { rows: terminal.rows }),
      });
      scrollResidualRef.current = delta.residualPx;
      // scrollLines takes LINES (positive = down). Swipe up (dy<0) = scroll up
      // (toward newer = negative lines). Swipe down (dy>0) = scroll down (older).
      // #47: mouse-reporting apps (fullscreen TUIs) get the same SGR wheel
      // events the desktop wheel path sends; everything else scrolls locally.
      const wheelLines = -delta.lines;
      if (wheelLines !== 0 && !reportTouchWheel(wheelLines, touchStartXRef.current, currentY)) {
        terminal.scrollLines(wheelLines);
      }
      touchLastYRef.current = currentY;
      touchLastXRef.current = currentX;
      // Make sure the keyboard is down while scrolling.
      if (textarea && document.activeElement === textarea) textarea.blur();
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (!mobileMedia.matches) return;
      // Pinch ends when fewer than 2 pointers remain. Reset pinch state and
      // keep the keyboard down (a pinch is never a tap-to-type).
      if (pinchActiveRef.current && e.touches.length < 2) {
         pinchActiveRef.current = false;
         scrollResidualRef.current = 0;
         pinchStartDistanceRef.current = 0;
         pinchStartFontSizeRef.current = terminal.options.fontSize ?? 13;
        touchScrollingRef.current = true;
        if (touchScrollResetTimer.current) clearTimeout(touchScrollResetTimer.current);
        touchScrollResetTimer.current = setTimeout(() => {
          touchScrollingRef.current = false;
        }, 600);
        if (textarea && document.activeElement === textarea) textarea.blur();
        return;
      }
      const wasSwipe = touchScrollingRef.current;
      scrollResidualRef.current = 0;
      const elapsed = e.timeStamp - touchStartTRef.current;
      const startedInInputZone = touchStartedInInputZoneRef.current;
      touchStartedInInputZoneRef.current = false;
      touchPendingTapRef.current = false;
      const gesture = classifyMobileTerminalGesture({
        start: { x: touchStartXRef.current, y: touchStartYRef.current },
        end: { x: e.changedTouches[0]?.clientX ?? 0, y: e.changedTouches[0]?.clientY ?? touchStartYRef.current },
        durationMs: elapsed,
        pointerCount: e.touches.length + 1,
        startedInInputZone,
        selectionActive: Boolean(terminal.getSelection()),
        scrollThresholdPx: SCROLL_THRESHOLD_PX,
        longPressMs: LONG_PRESS_MS,
      });
      // Swipe in a scrollback-less terminal (fullscreen alt-screen TUIs repaint
      // in place, baseY stays 0): scrollLines was a silent no-op, so turn that
      // deliberate upward swipe into "open the reader", which has its own
      // scrollable view of the same content.
      // Bug #1: a left pan must NOT fling open the reader just because it drifts up.
      // The reader gate is direction-blind (deltaY only); re-gate on the gesture the
      // classifier already computed — only a vertical-dominant "scroll" swipe may open
      // it, a horizontal-dominant "pan" must never (even with ≥6px upward drift).
      if (wasSwipe && gesture === "scroll" && touchAxisLockRef.current === "vertical" && shouldOpenReaderOnSwipe({
        readerOpen: terminalReaderController.isOpenFor(info.id),
        bufferType: terminal.buffer.active.type,
        baseY: terminal.buffer.active.baseY,
        deltaY: (e.changedTouches[0]?.clientY ?? touchStartYRef.current) - touchStartYRef.current,
        thresholdPx: SCROLL_THRESHOLD_PX,
        // #47: with mouse reporting on, the swipe already scrolled the CLI's
        // own transcript via wheel events — reader stays a fallback only for
        // apps that never enabled mouse reporting.
        mouseReportingActive: isMouseReportingActive(),
      })) {
        touchScrollingRef.current = false;
        terminalReaderController.toggle(info.id);
        return;
      }
      // Clean tap inside the bottom input affordance only. Tapping the reading
      // area never opens the software keyboard or claims xterm ownership.
      const action = wasSwipe || terminalReaderController.isOpenFor(info.id)
        ? "none"
        : resolveMobileTapAction(gesture, readMobileInputMode());
      if (action === "open-composer") {
        touchScrollingRef.current = false;
        mobileInputController.open({ terminalId: info.id, reason: "bottom-tap" });
        return;
      }
      if (action === "focus-pty") {
        // direct mode: let xterm keep focus so the software keyboard pops. The
        // focus guard below only blurs while a tap is pending/swiping; clearing
        // both refs here lets the guard stand down for this tap.
        touchScrollingRef.current = false;
        touchPendingTapRef.current = false;
        terminal.focus();
        return;
      }
      // Swipe (or long-press): keep touchScrollingRef true briefly so the
      // synthesized pointerdown/mousedown (fired right after touchend) is
      // suppressed, and ensure the keyboard stays down.
      if (touchScrollResetTimer.current) clearTimeout(touchScrollResetTimer.current);
      touchScrollResetTimer.current = setTimeout(() => {
        touchScrollingRef.current = false;
      }, 600);
      if (textarea && document.activeElement === textarea) textarea.blur();
    };
    const onTouchCancel = () => {
      pinchActiveRef.current = false;
      touchPendingTapRef.current = false;
      touchScrollingRef.current = false;
      scrollResidualRef.current = 0;
      if (textarea && document.activeElement === textarea) textarea.blur();
    };
    // Focus guard: during an unconfirmed touch (pending tap), any focus on the
    // xterm textarea is immediately reverted. This kills xterm's built-in touch
    // auto-focus (it focuses the textarea on touchstart internally) so a swipe
    // can never pop the keyboard before touchmove classifies it.
    const onTouchFocusGuard = () => {
      if (touchPendingTapRef.current || touchScrollingRef.current) {
        textarea?.blur();
      }
    };
    const detachTextareaListeners = () => {
      textarea?.removeEventListener("compositionstart", onCompositionStart);
      textarea?.removeEventListener("compositionupdate", onCompositionUpdate);
      textarea?.removeEventListener("compositionend", onCompositionEnd as EventListener);
      textarea?.removeEventListener("blur", onBlur);
      textarea?.removeEventListener("paste", onPaste, true);
      textarea?.removeEventListener("keydown", onTerminalKeyDown, true);
      textarea?.removeEventListener("keydown", onSoftKey, true);
      textarea?.removeEventListener("keydown", primeTextareaAtLiveCursor, true);
      // Focus priming covers click-/Alt+Tab-focus with no preceding keydown —
      // the first zhuyin keystroke can otherwise start composition against a
      // caret rect that was primed for a stale cursor cell.
      textarea?.removeEventListener("focus", primeTextareaAtLiveCursor);
      textarea?.removeEventListener("focus", onTouchFocusGuard);
    };
    const attachTextareaListeners = () => {
      const next = host.querySelector<HTMLTextAreaElement>("textarea");
      if (!next || next === textarea) return;
      detachTextareaListeners();
      textarea = next;
      textarea.addEventListener("compositionstart", onCompositionStart);
      textarea.addEventListener("compositionupdate", onCompositionUpdate);
      textarea.addEventListener("compositionend", onCompositionEnd as EventListener);
      textarea.addEventListener("blur", onBlur);
      textarea.addEventListener("paste", onPaste, true);
      textarea.addEventListener("keydown", onTerminalKeyDown, true);
      textarea.addEventListener("keydown", onSoftKey, true);
      textarea.addEventListener("keydown", primeTextareaAtLiveCursor, true);
      textarea.addEventListener("focus", primeTextareaAtLiveCursor);
      textarea.addEventListener("focus", onTouchFocusGuard);
    };
    const textareaObserver = new MutationObserver(attachTextareaListeners);
    attachTextareaListeners();
    textareaObserver.observe(host, { childList: true, subtree: true });
    const touchOptions: AddEventListenerOptions = { passive: false };
    host.addEventListener("touchstart", onTouchStart, touchOptions);
    host.addEventListener("touchmove", onTouchMove, touchOptions);
    host.addEventListener("touchend", onTouchEnd, touchOptions);
    host.addEventListener("touchcancel", onTouchCancel, touchOptions);
    host.addEventListener("keydown", onTerminalKeyDown, true);
    return () => {
      disposed = true;
      textareaObserver.disconnect();
      detachTextareaListeners();
      host.removeEventListener("touchstart", onTouchStart, touchOptions);
      host.removeEventListener("touchmove", onTouchMove, touchOptions);
      host.removeEventListener("touchend", onTouchEnd, touchOptions);
      host.removeEventListener("touchcancel", onTouchCancel, touchOptions);
      host.removeEventListener("keydown", onTerminalKeyDown, true);
      if (touchScrollResetTimer.current) clearTimeout(touchScrollResetTimer.current);
      host.removeEventListener("wheel", onWheel, wheelOptions);
      host.removeEventListener("click", onClickMoveCaret);
      uninstallTuiDragSelect();
      if (fontResizeTimer) clearTimeout(fontResizeTimer);
      if (justComposedClearTimer !== null) clearTimeout(justComposedClearTimer);
      if (resizeTimer) clearTimeout(resizeTimer);
      if (scrollFrameId !== null) cancelAnimationFrame(scrollFrameId);
      if (writeFrameId !== null) cancelAnimationFrame(writeFrameId);
      if (remotePanResetFrame !== null) cancelAnimationFrame(remotePanResetFrame);
      remoteBatcher?.dispose();
      applyAuthoritativeSnapshotRef.current = null;
      endImeLayoutLock();
      visualViewport?.removeEventListener("resize", onVisualViewportChange);
      visualViewport?.removeEventListener("scroll", onVisualViewportChange);
      unsubscribeComposer?.();
      recoveryScheduler.cancel();
      unregisterRecovery();
      resize.disconnect();
      offData();
      dataDisposable.dispose();
      linkProvider.dispose();
      uninstallLinkUnderlines();
      // F: dispose engine-pack addons. terminal.dispose() also disposes loaded
      // addons, but we null the refs so a post-cleanup search() call is a no-op.
      // webglRef may be null if it threw on load or was disposed on context loss.
      webglRef.current?.dispose();
      webglRef.current = null;
      // Hand the GL context back now instead of at GC: Chromium keeps at most
      // 16 alive per page and evicts the OLDEST (the sun/moon backdrop, the
      // first tiles) once layout remounts pile up dead-but-uncollected ones.
      webglCanvas?.removeEventListener("webglcontextrestored", onWebglRestored);
      releaseWebglCanvas(webglCanvas);
      webglCanvas = null;
      untrackAtlas();
      searchRef.current?.dispose();
      searchRef.current = null;
      serializeRef.current?.dispose();
      serializeRef.current = null;
      typedLineRef.current?.dispose();
      typedLineRef.current = null;
      fontLoadCleanupRef.current?.();
      fontLoadCleanupRef.current = null;
      // Remote fit schedulers: cancel in-flight frames and drop the published
      // trigger, so a post-cleanup RO fire schedules nothing on a dead pane.
      if (remoteFitFrame !== null) cancelAnimationFrame(remoteFitFrame);
      if (remoteFitCorrectionFrame !== null) cancelAnimationFrame(remoteFitCorrectionFrame);
      remoteFitFrame = null;
      remoteFitCorrectionFrame = null;
      remoteFitRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
    };
  // theme is applied via the live-update effect below; omitting it here
  // avoids a full Terminal remount (which would drop scrollback & cursor).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversationId, engineGeneration, info.id, info.isAgent, info.profile, onActivity]);

  // Browser/mobile refit on any broadcast geometry change — they keep their own
  // fit() width (a wide desktop size would overflow a phone), so this just
  // re-measures their container. Desktop no longer follows the shared global at
  // all: each tile owns its width via its own ResizeObserver + fit + per-PTY
  // resize, so forcing the global here was what garbled differently-sized (or
  // restart-stale) tiles.
  useEffect(() => {
    if (!window.aiTerminal.isBrowser) return;
    const terminal = terminalRef.current;
    const fit = fitRef.current;
    if (terminal) terminal.resize(info.cols, fit?.proposeDimensions()?.rows ?? info.rows);
    // The host grid changed (cols/rows broadcast) — re-run the remote fit so a
    // smaller pane still holds the whole grid without clipping or h-scroll.
    remoteFitRef.current?.();
    const host = hostRef.current;
    if (host) {
      resetRemoteHorizontalPan(host);
      requestAnimationFrame(() => resetRemoteHorizontalPan(host));
    }
  }, [ptyCols, ptyRows, info.cols, info.rows]);

  // AT-158: a phone mirroring a small desktop tile's PTY ends with a canvas
  // that stops short of the screen bottom (the desktop wrote ptyRows for its
  // tile, not for a tall phone). Web clients may NOT call resizeTerminal
  // (browser-api no-ops it), so the phone instead sends a rows-only geometry
  // INTENT — main performs the real ConPTY resize and broadcasts the truth.
  // Columns stay at the PTY's width (wide-grid horizontal pan guarantee), and
  // desktop tiles reclaim the rows on their next fit, same as any re-layout.
  useEffect(() => {
    if (!isActive) return;
    if (!window.aiTerminal.isBrowser) return;
    if (!window.matchMedia(MOBILE_LAYOUT_QUERY).matches) return;
    if (typeof window.aiTerminal.requestTerminalGeometry !== "function") return; // older server during rollout
    let timer: ReturnType<typeof setTimeout> | null = null;
    const claim = (): void => {
      // Composer open = soft keyboard up: don't shrink the shared ConPTY rows
      // mid-typing (Codex re-lays-out under the replay). Re-claim once on close.
      if (mobileInputController.isOpenFor(info.id)) return;
      const terminal = terminalRef.current;
      const host = hostRef.current;
      if (!terminal || !host || host.clientHeight <= 0) return;
      const cellHeight = readTerminalCellMetrics(terminal)?.height
        || ((terminal.options.fontSize ?? 14) * TERMINAL_TYPOGRAPHY.mobileLineHeight);
      if (!(cellHeight > 0)) return;
      const desired = Math.max(8, Math.min(160, Math.floor(host.clientHeight / cellHeight)));
      if (Math.abs(desired - info.rows) < 2) return;
      timer = setTimeout(() => {
        timer = null;
        void window.aiTerminal.requestTerminalGeometry({ terminalId: info.id, cols: info.cols, rows: desired }).catch(() => undefined);
      }, 250);
    };
    claim();
    window.addEventListener("resize", claim);
    window.addEventListener("orientationchange", claim);
    let composerWasOpen = mobileInputController.isOpenFor(info.id);
    const unsubscribeComposer = mobileInputController.subscribe(() => {
      const open = mobileInputController.isOpenFor(info.id);
      if (composerWasOpen && !open) claim();
      composerWasOpen = open;
    });
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("resize", claim);
      window.removeEventListener("orientationchange", claim);
      unsubscribeComposer();
    };
  }, [isActive, info.id, info.cols, info.rows]);

  useEffect(() => {
    lightBackgroundRef.current = resolvedTheme.isLight;
    resolvedThemeRef.current = resolvedTheme;
    const terminal = terminalRef.current;
    if (terminal) {
      terminal.options.allowTransparency = resolvedTheme.transparentBackground === true;
      terminal.options.theme = resolvedTheme.palette;
      terminal.options.fontWeight = resolvedTheme.fontWeight ?? TERMINAL_TYPOGRAPHY.fontWeight;
      terminal.options.fontWeightBold = resolvedTheme.fontWeightBold ?? TERMINAL_TYPOGRAPHY.fontWeightBold;
      const family = resolveTerminalFontStack(terminalFontRef.current, resolvedTheme.heavyCjk === true);
      if (terminal.options.fontFamily !== family) terminal.options.fontFamily = family;
      clearSharedTextureAtlas();
    }
    typedLineRef.current?.setColors(resolvedTheme.typedLine ?? null);
    if (previousThemeIdRef.current !== resolvedTheme.id) {
      previousThemeIdRef.current = resolvedTheme.id;
      useAppStore.getState().requestTerminalRecovery(info.id, "terminal-theme-change");
    }
  }, [info.id, resolvedTheme]);

  // Focus the xterm instance when this tile becomes the selected one.
  // The setTimeout(0) lets the click/pointer event fully settle (pointer
  // capture release + activeElement update) before we steal focus to the
  // xterm textarea. Without it, focus() silently fails when a pointer is
  // still captured by the originating tile.
  useEffect(() => {
    if (!isActive) return;
    if (window.matchMedia(MOBILE_LAYOUT_QUERY).matches) return;
    const terminal = terminalRef.current;
    if (!terminal) return;
    // Don't re-steal focus right after a touch-scroll (mobile).
    if (touchScrollingRef.current) return;
    const timer = setTimeout(() => {
      if (!touchScrollingRef.current) {
        terminal.focus();
        if (window.aiTerminal.isBrowser) {
          const host = hostRef.current;
          if (host) {
            resetRemoteHorizontalPan(host);
            requestAnimationFrame(() => resetRemoteHorizontalPan(host));
          }
        }
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [isActive]);

  const frameClass = [
    "xterm-pane-frame",
    isActive ? "active" : "",
    isBusy ? "agent-busy" : "",
    // Attention ring: same 3px geometry as active, orange takes precedence.
    // Only attention states light this up; running/done stay low-key.
    isAttentionState(ptyState) ? "attention-ring" : "",
    ptyState === "running" ? "pty-running" : "",
    ptyState === "done" ? "pty-done" : "",
  ].filter(Boolean).join(" ");

  const attentionLabel = isAttentionState(ptyState)
    ? t(`dock.attention.${ptyState}` as MessageKey)
    : null;

  // Issue #3: Lucide status icon in the pane header. Only agent tiles with a
  // non-null canonical state render an icon — non-agent shells and tiles with
  // no state yet show nothing (ptyStateIcon returns Icon: null for null state).
  // Accessibly labelled via aria-label + title (exact canonical state). Reduced-
  // motion safe: the icon itself never animates; CSS tones the working/attention
  // variants and the prefers-reduced-motion query disables the breathe
  // animation. Sized to the existing 13px header icon scale so header height is
  // unchanged.
  const stateIcon = ptyStateIcon(info.isAgent ? ptyState : null);
  const stateIconLabel = t(stateIcon.labelKey);
  const StateIconComp = stateIcon.Icon;

  // Model label: for agent tiles with a known profile, the profile is the
  // authoritative source (e.g. "claude-local-main"). detectedModel (parsed from PTY
  // banner output like "Claude") is only a fallback for non-agent shells or
  // when agentProfile is null — it must not override the real profile.
  const modelLabel =
    info.isAgent && info.agentProfile
      ? info.agentProfile === "claude-official"
        ? "claude"
        : info.agentProfile === "codex-official"
          ? "codex"
          : info.agentProfile
      : detectedModel ?? (info.isAgent ? "agent" : info.profile);

  // Paid accounts (claude/codex officials) keep their rainbow gradient label —
  // regression fix: the v1.5.28 series-color rule was painting over them with
  // the flat free-model red/gold. Free profiles keep the series colors.
  // codex-team (#100): paid official lead, wears the paid treatment too.
  const officialRainbow =
    info.isAgent &&
    (info.agentProfile === "claude-official" || info.agentProfile === "codex-official"
      || info.agentProfile === "codex-team");
  // claude-team (maintainer 2026-09-26): the lead is the real paid Claude, so it
  // wears the paid rainbow too — as a filled badge (rainbow background, white
  // text) so it never reads like the grey Agent API auto-window pill.
  // claude-team-sonnet (Sonnet 5.5 lead) wears the same badge.
  // codex-team (#100 lead) wears the same filled badge.
  const teamRainbow =
    info.isAgent &&
    (info.agentProfile === "claude-team" || info.agentProfile === "claude-team-sonnet"
      || info.agentProfile === "codex-team");

  // Per-window prompt-cache keepalive (pane header +/-). Same eligibility
  // as officialRainbow: paid official profiles only — their cache is the one
  // worth pinging (claude TTL 1h, codex TTL 30m). Free proxy windows never
  // burn a paid cache and never render the control.
  const keepaliveState = useAppStore((s) => s.terminalKeepalives[info.id] ?? null);
  const keepaliveGlobalHours = useAppStore((s) => s.settings?.claudeKeepaliveHours ?? 2);
  const keepaliveHours = keepaliveState?.effectiveHours ?? keepaliveGlobalHours;
  const bumpKeepalive = (delta: number): void => {
    const next = Math.max(0, Math.min(8, keepaliveHours + delta));
    void useAppStore.getState().setTerminalKeepaliveHours(info.id, next);
  };

  // 2026-09-26 maintainer: handoff export + session-pointer copy. Export asks main
  // to compress this session via the local free-model proxy into a markdown
  // doc (saved under <userData>/handoffs/ AND copied to the clipboard); copy-
  // ref writes a short pointer (cwd / tool / transcript path) so an agent in
  // another window can find THIS session's native transcript and resume it.
  // 2026-10-23: the pointer copy + its "Session 資訊" block now serve EVERY
  // agent pane with a session id (free proxy profiles too), not just paid
  // officials; only the handoff export remains paid-only.
  // "Session 資訊" block data (2026-10-23): profile / live session id / ABSOLUTE
  // transcript path / pid / resume command, answered by main through the same
  // session-file resolver the reader uses (follows /clear + in-session /resume
  // hops). Fetched only while the header menu is open.
  const [sessionInfo, setSessionInfo] = useState<TerminalSessionInfo | null>(null);
  const [handoffState, setHandoffState] = useState<"idle" | "busy" | "done" | "error">("idle");
  // true = the exporter guessed "newest transcript in the project dir", which
  // may be ANOTHER window's session — disclose that in the done tooltip.
  const [handoffApproximate, setHandoffApproximate] = useState(false);
  const [refCopied, setRefCopied] = useState(false);
  const exportHandoff = useCallback(async (): Promise<void> => {
    if (handoffState === "busy") return;
    setHandoffState("busy");
    setHandoffApproximate(false);
    try {
      const result = await window.aiTerminal.exportTerminalHandoff(info.id);
      setHandoffState(result.ok ? "done" : "error");
      if (result.ok) setHandoffApproximate(Boolean(result.approximate));
    } catch {
      setHandoffState("error");
    }
    window.setTimeout(() => setHandoffState("idle"), 4_000);
  }, [handoffState, info.id]);
  const copySessionRef = useCallback((): void => {
    // Same per-char slug rule as the main-process exporter (POSIX paths keep
    // their leading dash — e.g. /home/x → -home-x). Only a fallback while the
    // resolver's absolute path is still in flight.
    const slug = info.cwd.replace(/[^a-zA-Z0-9_-]/g, "-");
    const agentKind =
      info.agentProfile && info.agentProfile.startsWith("codex")
        ? "codex"
        : info.agentProfile
          ? "claude"
          : info.isAgent
            ? "agent"
            : info.profile;
    const sessionId = sessionInfo?.nativeSessionId ?? info.nativeSessionId;
    const transcript = sessionInfo?.transcriptPath
      ?? (agentKind === "claude" && sessionId
        ? `~/.claude/projects/${slug}/${sessionId}.jsonl`
        : agentKind === "codex"
          ? "~/.codex/sessions/ (latest rollout for this cwd)"
          : `~/.claude/projects/${slug}/ (newest .jsonl)`);
    const resume = sessionInfo?.resumeCommand
      ?? (sessionId
        ? agentKind === "codex"
          ? `codex resume ${sessionId}`
          : `claude --resume ${sessionId}`
        : null);
    const lines = [
      "Coterm session pointer",
      `agent: ${agentKind}`,
      `session id: ${sessionId ?? "(not bound yet)"}`,
      `cwd: ${info.cwd}`,
      `transcript: ${transcript}`,
    ];
    if (resume) lines.push(`resume: ${resume}   (run in cwd)`);
    lines.push(`terminal id: ${info.id}, pid: ${info.pid > 0 ? info.pid : "?"}`);
    lines.push(
      "To summarize: read the transcript JSONL (one JSON event per line; user/assistant messages) and compress it.",
    );
    void navigator.clipboard.writeText(lines.join("\n")).catch(() => undefined);
    setRefCopied(true);
    window.setTimeout(() => setRefCopied(false), 2_500);
  }, [info.cwd, info.agentProfile, info.profile, info.isAgent, info.id, info.pid, info.nativeSessionId, sessionInfo]);

  // 1.5.45 warroom band: the tile's top-edge colour strip. Colour comes from
  // the LABEL (stable by group name), not from the agent profile — two panes of
  // the same warroom group must match. Mobile hides it entirely (CSS below), so
  // this is desktop-only chrome.
  const labelColorValue = labelColor(info.label);
  const labelTitleText = labelTitle(info.label);

  // 2026-10-03 maintainer「表頭太擠、摘要被吃掉」: the rarely-used header tools
  // (font size, keepalive, handoff, session pointer, colour band, id) moved
  // into one ⋯ popover so the session summary gets the width back.
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const headerMenuRef = useRef<HTMLDivElement | null>(null);
  const headerMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!headerMenuOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (headerMenuRef.current?.contains(target) || headerMenuButtonRef.current?.contains(target)) return;
      setHeaderMenuOpen(false);
    };
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setHeaderMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeydown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeydown);
    };
  }, [headerMenuOpen]);
  const stopPointer = {
    onPointerDown: (event: React.PointerEvent) => event.stopPropagation(),
    onPointerUp: (event: React.PointerEvent) => event.stopPropagation(),
  };
  useEffect(() => {
    if (!headerMenuOpen || !info.isAgent) return;
    let cancelled = false;
    void window.aiTerminal.getTerminalSessionInfo(info.id)
      .then((value) => {
        if (!cancelled && value) setSessionInfo(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [headerMenuOpen, info.id, info.isAgent]);

  return (
    <section
      data-action-id="terminal.activate"
      data-action-trigger="pointerdown"
      className={frameClass}
      data-terminal-id={info.id}
      data-label-group={info.label?.group ?? undefined}
      onPointerUp={() => onActivate(info.id)}
      onPointerDown={(event) => {
        // Release any stale pointer capture so the subsequent focus() in the
        // isActive effect can land on the xterm textarea. Without this, the
        // first-clicked tile keeps capture and steals focus back.
        const target = event.currentTarget;
        if (target.hasPointerCapture?.(event.pointerId)) {
          target.releasePointerCapture(event.pointerId);
        }
        // Mobile: a touch is in flight (pending tap or mid-swipe). Do NOT focus
        // here — touchend owns the tap-vs-swipe verdict and focuses only on a
        // clean tap. Focusing now (before touchmove runs) pops the keyboard on
        // every swipe. pointerType touch also covers the synthesized mouse event.
        if (event.pointerType === "touch" || touchScrollingRef.current) return;
        // Focus the xterm immediately — don't wait for the isActive effect.
        // The effect still fires as a fallback for keyboard navigation.
        const terminal = terminalRef.current;
        if (terminal) terminal.focus();
      }}
    >
      {/* 拖曳排序抓手 (desktop only): dragging the header with REORDER_DRAG_MIME
          moves this tile — the grid's Panel runs the drop. Mobile keeps the
          header plain (single-pane layout has nothing to reorder). */}
      <header
        className={info.ownedByAgentApi ? "xterm-header-agent-driven" : undefined}
        draggable={!isMobileLayout}
        data-action-id="terminal.header.exclusive-toggle"
        data-action-trigger="dblclick"
        onDragStart={(event) => {
          event.dataTransfer.setData(REORDER_DRAG_MIME, info.id);
          event.dataTransfer.effectAllowed = "move";
          event.currentTarget.dataset.dragging = "true";
        }}
        onDragEnd={(event) => {
          delete event.currentTarget.dataset.dragging;
        }}
        onDoubleClick={(event) => {
          // Solo (maximize) toggle = the same setExclusive the topbar tab's
          // exclusive-toggle fires. Only a blank double-click on the header
          // chrome counts: buttons, the hidden file input and future links own
          // their gesture and must never remount the grid under the pointer.
          if (event.target instanceof Element && event.target.closest("button, a, input, select, textarea, [role=button]")) return;
          // Desktop only. The pane reader overlay and the dock-level reading
          // mode are layouts solo would sit under invisibly — reading mode
          // suspends solo the same way (app-store toggleReadingMode).
          if (isMobileLayout || readingModeActive || readerOpen) return;
          // Maximize needs more than one tile; maximize-with-one is a no-op.
          // A second double-click on the already-exclusive pane restores the grid.
          if (layoutTileCount <= 1 && exclusiveTerminalId !== info.id) return;
          void setExclusive(exclusiveTerminalId === info.id ? null : info.id);
        }}
      >
        {/* Tab ↔ pane mapping: the 1-based tile number at the very start of the
            header (desktop only — the mobile dock has no top-bar tabs).
            Prominent: it is the leftmost element and matches the top tab.
            The mail handle sits right next to it, smaller and muted. */}
        {!isMobileLayout && paneNumber != null && (
          <span className="xterm-pane-num" aria-hidden="true">{paneNumber}</span>
        )}
        {/* @-mention handle (agent mail, e.g. "@claude-1"): the address another
            pane's agent can send one-line updates to via the `cot` CLI.
            Small and muted next to the number; its number is stable for the
            app lifetime (monotonic mailbox allocation), so it never points at
            a closed conversation. */}
        {info.agentHandle && (
          <span className="xterm-agent-handle" data-testid="xterm-agent-handle" title={t("dock.agentHandle.title")}>@{info.agentHandle}</span>
        )}
        {/* 1.5.45 warroom identity band. A real element (not ::before) so the
            group is greppable in the DOM and assertable in e2e without
            computed-style probing. Absolutely positioned, so it never takes
            grid space or disturbs the 24px header / 3px border geometry. */}
        {labelColorValue && (
          <span
            className="xterm-label-band"
            data-testid="xterm-label-band"
            style={{ background: labelColorValue }}
            title={labelTitleText ?? undefined}
            aria-label={labelTitleText ?? undefined}
          />
        )}
        {StateIconComp && (
          <span
            className={stateIcon.className}
            role="img"
            aria-label={stateIconLabel}
            title={stateIconLabel}
          >
            <StateIconComp size={13} aria-hidden="true" />
          </span>
        )}
        {info.ownedByAgentApi && (
          <span className="xterm-agent-driven-pill" title={t("dock.agentDriven.title")}>{t("dock.agentDriven.label")}</span>
        )}
        {attentionLabel && (
          <span className="xterm-attention-badge" title={attentionLabel}>{attentionLabel}</span>
        )}
        {/* #96: GPU context lost — the pane still works (DOM renderer) but the
            window may look half-transparent until it is rebuilt. Tapping the
            badge rebuilds this pane's engine, which restores rendering without
            touching the other tiles. */}
        {rendererDegraded && (
          <button
            type="button"
            className="xterm-render-degraded-badge"
            data-action-id="terminal.renderer.degraded"
            title={t("dock.rendererDegraded.title")}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setEngineGeneration((generation) => generation + 1);
            }}
          >
            {t("dock.rendererDegraded.label")}
          </button>
        )}
        <span className="xterm-header-identity">
          <span className="xterm-agent-label" title={[displayTitle, info.cwd, modelLabel, info.agentHandle ? `@${info.agentHandle}` : ""].filter(Boolean).join(" — ")}>
            {displayTitle || info.cwd?.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || "shell"}
          </span>
          {info.cwd && <span className="xterm-cwd-label" data-testid="xterm-cwd-label" title={info.cwd}>{info.cwd}</span>}
        </span>
        <span
          className={`xterm-model-label${teamRainbow ? " team-rainbow-badge" : officialRainbow ? " official-rainbow-text" : agentModelLabelClass(modelLabel)}`}
          title={modelLabel}
        >
          {modelLabel}
        </span>
        {/* maintainer 2026-09-30：不再顯示 PTY 頂端的 context 電池；元件與資料通道保留，需要時把這行加回 */}
        {/* Desktop keeps the id inside the ⋯ menu (2026-10-03 header re-layout);
            a phone has no menu, so the id stays inline there. */}
        {isMobileLayout && (
          <span className="xterm-id-label" title={t("dock.session.title", { id: info.id })}>
            #{info.id.slice(-6)}
          </span>
        )}
        {!isMobileLayout && (
        <button
          data-action-id="terminal.clean-view.toggle"
          type="button"
          className="xterm-clean-toggle"
          aria-label={t("dock.reader.toggle")}
          title={t("dock.reader.toggle")}
          aria-pressed={terminalReaderController.isOpenFor(info.id)}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            // The section's onPointerUp normally sets this tile active, but the
            // stopPropagation calls above (needed to protect xterm focus) swallow
            // the pointer sequence, so onActivate never fires for an eye click.
            // Activate explicitly first, otherwise the overlay's `active` guard
            // returns null and the reader never mounts on a non-active tile.
            onActivate(info.id);
            terminalReaderController.toggle(info.id);
          }}
        >
          {terminalReaderController.isOpenFor(info.id) ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
        )}
        {!isMobileLayout && (
          <input
            data-action-id="terminal.attach.change"
            ref={attachInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = "";
              void attachFilesToTerminal(files, info.id, info.profile);
            }}
          />
        )}
        {!isMobileLayout && (
          <button
            ref={headerMenuButtonRef}
            data-action-id="terminal.header.more"
            type="button"
            className={`xterm-header-more${headerMenuOpen ? " is-open" : ""}`}
            aria-label={t("dock.menu.more")}
            title={t("dock.menu.more")}
            aria-expanded={headerMenuOpen}
            aria-haspopup="true"
            {...stopPointer}
            onClick={(event) => {
              event.stopPropagation();
              setHeaderMenuOpen((open) => !open);
            }}
          >
            <MoreHorizontal size={16} />
          </button>
        )}
        {!readerOpen && (
        <button
          data-action-id="terminal.close"
          type="button"
          aria-label={t("dock.close.aria")}
          title={t("dock.close.title")}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            void onClose(info.id);
          }}
        >
          <X size={16} />
        </button>
        )}
      </header>
      {!isMobileLayout && headerMenuOpen && (
        <div
          ref={headerMenuRef}
          className="xterm-header-menu"
          data-action-id="terminal.header.menu.consume"
          role="menu"
          aria-label={t("dock.menu.more")}
          {...stopPointer}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="xterm-header-menu-meta" title={info.cwd}>
            <strong>{displayTitle || "Terminal"}</strong>
            <span>{info.cwd}</span>
            <span>{modelLabel}{info.agentHandle ? ` · @${info.agentHandle}` : ""}</span>
          </div>
          {/* Icon-only tools sit on ONE horizontal row — their own class,
              because `.xterm-header-menu-actions` is the labelled-button column. */}
          <div className="xterm-header-menu-icons">
        {/* F: magnifier trigger for the Ctrl+F search overlay. Same pattern as
            the eye toggle: stopPropagation protects xterm focus, so it activates
            the tile explicitly before opening the overlay. */}
        {!isMobileLayout && (
          <button
            data-action-id="terminal.search.open"
            type="button"
            className="xterm-search-open"
            aria-label={t("dock.search.aria")}
            title={t("dock.search.aria")}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onActivate(info.id);
              setSearchOpen(true);
            }}
          >
            <Search size={16} />
          </button>
        )}
        {/* Desktop paperclip: the phone has one in its tools tray, the desktop
            had none (2026-10-06). Picked files go in as their real paths. */}
        {!isMobileLayout && (
          <button
            data-action-id="terminal.attach.open"
            type="button"
            className="xterm-search-open"
            aria-label={t("topbar.keys.attach")}
            title={t("topbar.keys.attach")}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onActivate(info.id);
              attachInputRef.current?.click();
            }}
          >
            <Paperclip size={16} />
          </button>
        )}
          </div>
          <div className="xterm-header-menu-row">
            <span className="xterm-header-menu-label">{t("dock.menu.fontSize")}</span>
            <button
              data-action-id="terminal.font.decrease"
              type="button"
              className="xterm-font-step"
              aria-label={t("dock.font.decrease")}
              title={t("dock.font.decrease")}
              onClick={() => {
                const current = terminalRef.current?.options.fontSize ?? terminalFontSizeRef.current;
                applyFontSizeRef.current?.(current - 1);
              }}
            >
              A−
            </button>
            <output className="xterm-header-menu-value">{terminalFontSize}px</output>
            <button
              data-action-id="terminal.font.increase"
              type="button"
              className="xterm-font-step"
              aria-label={t("dock.font.increase")}
              title={t("dock.font.increase")}
              onClick={() => {
                const current = terminalRef.current?.options.fontSize ?? terminalFontSizeRef.current;
                applyFontSizeRef.current?.(current + 1);
              }}
            >
              A+
            </button>
          </div>
          {/* Prompt-cache keepalive for paid windows only (claude / codex
              officials): their cache is the one worth pinging. */}
          {officialRainbow && (
            <div className="xterm-header-menu-row" title={keepaliveState?.cooled ? t("dock.keepalive.cooled.title") : t("dock.keepalive.title")}>
              <span className="xterm-header-menu-label">{t("dock.menu.keepalive")}</span>
              <button
                data-action-id="terminal.keepalive.decrease"
                type="button"
                className="xterm-font-step"
                aria-label={t("dock.keepalive.decrease")}
                title={t("dock.keepalive.decrease")}
                onClick={() => bumpKeepalive(-1)}
              >
                −
              </button>
              <output className={`xterm-header-menu-value xterm-keepalive-label${keepaliveHours > 0 ? "" : " is-off"}${keepaliveState?.cooled ? " is-cooled" : ""}`}>
                {keepaliveState?.cooled
                  ? t("dock.keepalive.cooled")
                  : keepaliveHours > 0
                    ? `${keepaliveHours}h`
                    : t("dock.keepalive.off")}
              </output>
              <button
                data-action-id="terminal.keepalive.increase"
                type="button"
                className="xterm-font-step"
                aria-label={t("dock.keepalive.increase")}
                title={t("dock.keepalive.increase")}
                onClick={() => bumpKeepalive(1)}
              >
                +
              </button>
            </div>
          )}
          <div className="xterm-header-menu-actions">
            {/* 1.5.45 hand-colouring: cycles none → each palette swatch → none,
                writing a group token so the band colour is predictable. */}
            <button
              data-action-id="terminal.label.cycle"
              type="button"
              className="xterm-label-step"
              aria-label={t("dock.label.aria")}
              title={info.label ? t("dock.label.clear", { group: info.label.group }) : t("dock.label.apply")}
              onClick={() => {
                const next = nextManualLabel(info.label);
                void window.aiTerminal.setTerminalLabel({ terminalId: info.id, label: next });
              }}
            >
              <Palette size={15} />
              <span>{t("dock.menu.label")}</span>
              {labelColorValue && <i className="xterm-header-menu-swatch" style={{ background: labelColorValue }} />}
            </button>
            {/* Handoff export: paid official windows only. (The session-pointer
                copy moved into the "Session 資訊" block below — 2026-10-23 — so
                free proxy profiles get it too.) */}
            {officialRainbow && (
              <button
                data-action-id="terminal.handoff.export"
                type="button"
                className="xterm-handoff"
                aria-label={t("dock.handoff.export")}
                title={
                  handoffState === "busy"
                    ? t("dock.handoff.busy")
                    : handoffState === "done"
                      ? handoffApproximate
                        ? t("dock.handoff.doneApproximate")
                        : t("dock.handoff.done")
                      : handoffState === "error"
                        ? t("dock.handoff.failed")
                        : t("dock.handoff.export")
                }
                disabled={handoffState === "busy"}
                onClick={() => void exportHandoff()}
              >
                {handoffState === "busy" ? (
                  <Loader2 size={15} className="is-spinning" />
                ) : handoffState === "done" ? (
                  <Check size={15} />
                ) : (
                  <FileDown size={15} />
                )}
                <span>{t("dock.menu.handoff")}</span>
              </button>
            )}
          </div>
          {/* "Session 資訊" (2026-10-23): selectable pointer values + one
              "複製給 agent" button that pastes elsewhere as a plain-text block
              an unrelated agent can act on. Agents only; plain shells have no
              session, so the block stays hidden there. */}
          {info.isAgent && info.nativeSessionId && (
            <div className="xterm-header-menu-session">
              <div className="xterm-header-menu-session-title">{t("dock.menu.sessionInfo")}</div>
              <div className="xterm-header-menu-session-row">
                <span className="xterm-header-menu-session-key">{t("dock.session.agent")}</span>
                <span className="xterm-header-menu-session-value">{info.agentProfile ?? "agent"}</span>
              </div>
              <div className="xterm-header-menu-session-row">
                <span className="xterm-header-menu-session-key">{t("dock.session.id")}</span>
                <span className="xterm-header-menu-session-value">{sessionInfo?.nativeSessionId ?? info.nativeSessionId}</span>
              </div>
              <div className="xterm-header-menu-session-row">
                <span className="xterm-header-menu-session-key">{t("dock.session.cwd")}</span>
                <span className="xterm-header-menu-session-value">{info.cwd}</span>
              </div>
              <div className="xterm-header-menu-session-row">
                <span className="xterm-header-menu-session-key">{t("dock.session.transcript")}</span>
                <span className="xterm-header-menu-session-value">{sessionInfo?.transcriptPath ?? t("dock.session.transcript.pending")}</span>
              </div>
              <div className="xterm-header-menu-session-row">
                <span className="xterm-header-menu-session-key">{t("dock.session.model")}</span>
                <span className="xterm-header-menu-session-value">{sessionInfo?.model ?? modelLabel}</span>
              </div>
              <div className="xterm-header-menu-session-row">
                <span className="xterm-header-menu-session-key">{t("dock.session.pid")}</span>
                <span className="xterm-header-menu-session-value">{info.pid > 0 ? String(info.pid) : "—"}</span>
              </div>
              <button
                data-action-id="terminal.session-info.copy"
                type="button"
                aria-label={t("dock.ref.copy")}
                title={refCopied ? t("dock.ref.copied") : t("dock.ref.copy")}
                onClick={() => copySessionRef()}
              >
                {refCopied ? <Check size={15} /> : <Link2 size={15} />}
                <span>{refCopied ? t("dock.menu.refCopied") : t("dock.menu.ref")}</span>
              </button>
            </div>
          )}
          <div className="xterm-header-menu-foot">
            <span className="xterm-id-label" title={t("dock.session.title", { id: info.id })}>#{info.id.slice(-6)}</span>
            <span className="xterm-header-menu-model">{modelLabel}</span>
          </div>
        </div>
      )}
      <div
        className={window.aiTerminal.isBrowser ? "xterm-host xterm-host-remote" : "xterm-host"}
        ref={hostRef}
      />
      <VoiceCompositionOverlay terminalId={info.id} />
      <TerminalReaderOverlay terminalId={info.id} active={isActive} getRawText={captureRawText} ptyState={ptyState} />
      {searchOpen && isActive && (
        <div
          data-action-id="terminal.search.consume"
          data-action-trigger="pointerdown"
          className="xterm-search-overlay"
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
        >
          <input
            data-action-id="terminal.search.input"
            ref={searchInputRef}
            type="text"
            className="xterm-search-input"
            placeholder={t("dock.search.placeholder")}
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setSearchNoResult(false);
              scheduleTypeaheadSearch(event.target.value);
            }}
            onCompositionStart={() => {
              searchComposingRef.current = true;
              if (searchTimerRef.current) {
                clearTimeout(searchTimerRef.current);
                searchTimerRef.current = null;
              }
            }}
            onCompositionEnd={(event) => {
              searchComposingRef.current = false;
              if (searchTimerRef.current) {
                clearTimeout(searchTimerRef.current);
                searchTimerRef.current = null;
              }
              runTypeaheadSearch((event.target as HTMLInputElement).value);
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              // IME composition: Enter commits the composition, not a search.
              if (event.nativeEvent.isComposing || searchComposingRef.current) return;
              const action = resolveSearchInputAction(event);
              if (!action) return;
              event.preventDefault();
              if (action.kind === "close") {
                setSearchOpen(false);
              } else {
                runSearch(action.direction);
              }
            }}
          />
          {searchNoResult && (
            <span className="xterm-search-noresult">{t("dock.search.noResult")}</span>
          )}
          <button
            data-action-id="terminal.search.previous"
            type="button"
            className="xterm-search-btn"
            aria-label={t("dock.search.previous")}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              runSearch("previous");
            }}
          >
            {t("dock.search.previous")}
          </button>
          <button
            data-action-id="terminal.search.next"
            type="button"
            className="xterm-search-btn"
            aria-label={t("dock.search.next")}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              runSearch("next");
            }}
          >
            {t("dock.search.next")}
          </button>
          <button
            data-action-id="terminal.search.close"
            type="button"
            className="xterm-search-close"
            aria-label={t("dock.search.close")}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setSearchOpen(false);
            }}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </section>
  );
}
