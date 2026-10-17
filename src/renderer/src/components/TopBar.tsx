import { useShallow } from "zustand/react/shallow";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BookOpen,
  Clipboard,
  CornerDownLeft,
  ChevronDown,
  Expand,
  Moon,
  Paperclip,
  Power,
  RefreshCw,
  Sun,
  Mic,
  Settings,
  History,
  Eye,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAppStore } from "../store/app-store";
import { themeTogglePatch } from "../store/settings-patches";
import { useI18n } from "../i18n";
import type { PtyState } from "@shared/types";
import { buildStopPayload } from "./terminal-recovery";
import { resolveVoiceTargetTerminalId, shouldSendMobileTileSelection } from "./topbar-logic";
import { buildMobilePasteData, mobileInputController } from "./mobile/mobile-input-controller";
import { readMobileInputMode, writeMobileInputMode, type MobileInputMode } from "./mobile/mobile-input-mode";
import { normalizeVoiceFinal, shouldCommitVoiceFinal, useVoiceInput, type VoiceCommitRecord, type VoiceError } from "./voice-input";
import {
  useVoiceDraftSnapshot,
  voiceDraftStore,
  type VoiceDraftToken,
} from "./voice/voice-draft-state";
import { UsageHud } from "./usage-hud";
import { ReadingPresetPicker } from "./reading-preset-picker";
import { ptySignalTone } from "./pty-state-label";
import { MOBILE_LAYOUT_QUERY } from "./terminal-responsive";

/** Long-press on the voice button cancels an in-flight recording. Matches the
 * 450ms threshold used by TerminalDock's touch long-press so the feel is one
 * system. */
const VOICE_LONG_PRESS_MS = 450;
import { marqueeDurationSeconds, shortCwd, shouldMarqueeSessionSummary } from "./terminal-display-title";

/**
 * The recap ticker that lives in the blank space of the mobile PTY switcher
 * button (`PTY n … ⌄`). One direction only: it creeps right-to-left until the
 * tail is visible, holds, then snaps back and replays — no ping-pong. Speed is
 * fixed px/s (see marqueeDurationSeconds), and it never animates off-screen,
 * with the document hidden, or under prefers-reduced-motion.
 */
function MobileRecapMarquee({ text }: { text: string }): React.JSX.Element {
  const hostRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflowPx, setOverflowPx] = useState(0);
  const [fontPx, setFontPx] = useState(13);
  const [inViewport, setInViewport] = useState(true);
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState !== "hidden");
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );

  useEffect(() => {
    const measure = (): void => {
      const host = hostRef.current;
      const node = textRef.current;
      if (!host || !node) return;
      setOverflowPx(Math.max(0, Math.ceil(node.scrollWidth - host.clientWidth)));
      setFontPx(Number.parseFloat(getComputedStyle(node).fontSize) || 13);
    };
    const frame = requestAnimationFrame(measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (hostRef.current) observer?.observe(hostRef.current);
    if (textRef.current) observer?.observe(textRef.current);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [text]);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const node = hostRef.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      setInViewport(entries[0]?.isIntersecting ?? true);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onVisibility = (): void => setDocumentVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const update = (): void => setReducedMotion(media.matches);
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  const marquee = shouldMarqueeSessionSummary({
    mobile: true,
    active: true,
    overflowPx,
    inViewport,
    documentVisible,
    reducedMotion,
  });
  return (
    <span ref={hostRef} className="mobile-session-summary" title={text}>
      <span
        ref={textRef}
        className={`mobile-session-summary-text${marquee ? " is-marquee" : ""}`}
        style={{
          "--summary-overflow-px": `${overflowPx}px`,
          "--summary-marquee-duration": `${marqueeDurationSeconds(overflowPx, fontPx)}s`,
        } as React.CSSProperties}
      >
        {text}
      </span>
    </span>
  );
}

/** Resize an image file down to a max dimension and re-encode as JPEG so the
 *  base64 payload stays under the web-server's 1MB MAX_BODY_BYTES limit. */
async function resizeImage(
  file: File,
  maxDim = 1568,
  quality = 0.85,
): Promise<{ dataBase64: string; mimeType: "image/jpeg" }> {
  const bitmap = await createImageBitmap(file);
  let { width, height } = bitmap;
  if (width > maxDim || height > maxDim) {
    const scale = maxDim / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable.");
  ctx.drawImage(bitmap, 0, 0, width, height);
  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  const comma = dataUrl.indexOf(",");
  const dataBase64 = dataUrl.slice(comma + 1);
  bitmap.close?.();
  return { dataBase64, mimeType: "image/jpeg" };
}

/**
 * 日月版型切換：新主題從按鈕位置畫圓擴散出來（View Transition）。
 * 直接先改 <html data-theme> 讓快照立刻是新樣子，設定稍後由 App 寫回同一個值。
 */
function sunMoonReveal(next: "dark" | "light", x: number, y: number): void {
  const root = document.documentElement;
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
  if (!doc.startViewTransition || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  const vt = doc.startViewTransition(() => { root.dataset.theme = next; });
  void vt.ready.then(() => {
    root.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
      { duration: 900, easing: "cubic-bezier(.7,0,.18,1)", pseudoElement: "::view-transition-new(root)" },
    );
  }).catch(() => undefined);
}

export function TopBar(): React.JSX.Element {
  const mobileComposer = useSyncExternalStore(mobileInputController.subscribe, mobileInputController.getSnapshot, mobileInputController.getSnapshot);
  const enterInFlight = useRef(false);
  const pasteInFlight = useRef(false);
  const tabTrayRef = useRef<HTMLDivElement>(null);
  const {
    dockLayout,
    settings,
    updateSettings,
    setSettingsOpen,
    setCheckpointOpen,
    checkpointOpen,
    selectTile,
    setExclusive,
    requestTerminalRecovery,
    ptyStates,
    setError,
    readingModeActive,
    toggleReadingMode,
  } = useAppStore(useShallow((s) => ({
    dockLayout: s.dockLayout,
    settings: s.settings,
    updateSettings: s.updateSettings,
    setSettingsOpen: s.setSettingsOpen,
    setCheckpointOpen: s.setCheckpointOpen,
    checkpointOpen: s.checkpointOpen,
    selectTile: s.selectTile,
    setExclusive: s.setExclusive,
    requestTerminalRecovery: s.requestTerminalRecovery,
    ptyStates: s.ptyStates,
    setError: s.setError,
    readingModeActive: s.readingModeActive,
    toggleReadingMode: s.toggleReadingMode,
  })));
  const isMobile = useIsMobile();
  const { t } = useI18n();
  // TODO(overhaul): dockLayout is added to the store by T3 (app-store owner).
  // Until then this references a field that does not yet exist on AppState.
  const activeTerminalId = dockLayout.selectedTerminalId;
  useEffect(() => {
    const tray = tabTrayRef.current;
    const workspace = tray?.closest<HTMLElement>(".workspace-shell");
    if (!tray || !workspace) return;
    const update = (): void => {
      if (!workspace.classList.contains("connected-terminal")) return;
      const pane = workspace.querySelector<HTMLElement>(".xterm-pane-frame");
      const tab = tray.querySelector<HTMLElement>(".topbar-tab.active");
      if (!pane || !tab) return;
      const p = pane.getBoundingClientRect();
      const t = tab.getBoundingClientRect();
      const left = Math.max(t.left, tray.getBoundingClientRect().left, p.left);
      const right = Math.min(t.right, tray.getBoundingClientRect().right, p.right);
      pane.style.setProperty("--connected-tab-left", `${left - p.left}px`);
      pane.style.setProperty("--connected-tab-width", `${Math.max(0, right - left)}px`);
      // A tab flush with the pane's left/right edge continues straight down,
      // so that pane corner must be square (CSS keys off these flags).
      pane.toggleAttribute("data-tab-flush-left", left - p.left < 1);
      pane.toggleAttribute("data-tab-flush-right", p.right - right < 1);
    };
    const observer = new ResizeObserver(update);
    observer.observe(workspace);
    observer.observe(tray);
    tray.addEventListener("scroll", update);
    const frame = requestAnimationFrame(update);
    return () => { observer.disconnect(); tray.removeEventListener("scroll", update); cancelAnimationFrame(frame); };
  }, [activeTerminalId, dockLayout.exclusiveTerminalId, dockLayout.tiles.length]);
  const [sessionSummaries, setSessionSummaries] = useState<Record<string, { summary: string | null; recap: string | null; cwd: string | null }>>({});
  const [pendingMobileSelectionId, setPendingMobileSelectionId] = useState<string | null>(null);
  // Canonical PtyState now comes from the app-store projection (Issue #2):
  // one dashboard hydrate + one onPtyStateChanged subscription feeds the whole
  // renderer. TopBar no longer subscribes independently.

  const selectMobileTile = useCallback((terminalId: string): void => {
    // voicefix: a mobile tap/swipe-to-select is a local user gesture — pin it
    // as the voice target for this window (even a redundant re-tap counts,
    // which is why the pin lands before the shouldSend dedup guard).
    useAppStore.getState().noteLocalTileSelection(terminalId);
    if (!shouldSendMobileTileSelection(terminalId, activeTerminalId, pendingMobileSelectionId)) return;
    setPendingMobileSelectionId(terminalId);
    void selectTile(terminalId).finally(() => {
      setPendingMobileSelectionId((current) => current === terminalId ? null : current);
    });
  }, [activeTerminalId, pendingMobileSelectionId, selectTile]);

  // Pane-header parity for the top bar: each XtermPane broadcasts its display
  // title + recap + cwd. The record is keyed by terminalId so the desktop tabs
  // render every tile's entry and the mobile marquee keeps reading the active
  // tile's entry from the same event stream.
  useEffect(() => {
    const onSummary = (event: Event): void => {
      const raw = (event as CustomEvent<Record<string, unknown>>).detail;
      if (!raw || typeof raw.terminalId !== "string") return;
      const detail = raw as { terminalId: string; summary?: unknown; recap?: unknown; cwd?: unknown };
      const text = (value: unknown): string | null =>
        typeof value === "string" && value.trim() ? value : null;
      setSessionSummaries((prev) => ({
        ...prev,
        [detail.terminalId]: {
          summary: text(detail.summary),
          recap: text(detail.recap),
          cwd: text(detail.cwd),
        },
      }));
    };
    window.addEventListener("coterm:session-summary", onSummary);
    return () => window.removeEventListener("coterm:session-summary", onSummary);
  }, []);
  // Recap first (that is what the ticker is for); the header summary is the
  // fallback until the provider has written one.
  const activeSessionSummary = activeTerminalId ? sessionSummaries[activeTerminalId] : undefined;
  useEffect(() => {
    tabTrayRef.current?.querySelector(".topbar-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTerminalId, dockLayout.tiles.length]);
  const visibleMobileSessionSummary = activeSessionSummary
    ? activeSessionSummary.recap ?? activeSessionSummary.summary
    : null;

  const sendKey = (data: string): void => {
    if (!activeTerminalId) return;
    if (data === "\r" && (enterInFlight.current || pasteInFlight.current || mobileInputController.getSnapshot().state.status === "submitting")) return;
    const terminalId = activeTerminalId;
    if (data === "\r") enterInFlight.current = true;
    void window.aiTerminal.writeTerminal({ terminalId, data }).then(() => {
      if (data === "\r") mobileInputController.markEntered(terminalId);
    }).finally(() => { if (data === "\r") enterInFlight.current = false; });
  };
  // STOP: exactly one \x03 to the active PTY. Does not close the tile or kill
  // Coterm (design §4). buildStopPayload makes the \x03-only contract explicit.
  const sendStop = (): void => {
    if (!activeTerminalId) return;
    const payload = buildStopPayload(activeTerminalId);
    void window.aiTerminal.writeTerminal(payload);
  };

  const [keysOpen, setKeysOpen] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!keysOpen) return;
    const closeOnOutside = (event: PointerEvent): void => {
      if (!mobileMenuRef.current?.contains(event.target as Node)) setKeysOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setKeysOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [keysOpen]);
  // Mirror of the desktop Ctrl+V handler (TerminalDock.tsx ~line 620).
  // navigator.clipboard.readText() needs a secure context + user gesture;
  // the tap is the gesture. On HTTPS (Tailscale Serve) it succeeds and pastes
  // directly. On plain HTTP (LAN IP) it rejects or returns empty; instead of
  // swallowing silently we surface a fallback panel with a focused textarea so
  // the user can long-press -> system paste -> confirm. Same writeTerminal path
  // either way (Phase 2 plan C).
  const openMobileComposer = useCallback((terminalId: string, reason: "toolbar" | "paste-fallback"): void => {
    mobileInputController.open({ terminalId, reason });
  }, []);
  const pasteFromClipboard = (): void => {
    if (!activeTerminalId) return;
    const terminalId = activeTerminalId;
    const clipboard = navigator.clipboard;
    if (!clipboard?.readText) {
      setKeysOpen(false);
      openMobileComposer(terminalId, "paste-fallback");
      return;
    }
    void clipboard
      .readText()
      .then(async (text): Promise<void> => {
        if (text) {
          setKeysOpen(false);
          // direct mode + readable clipboard: paste straight into the PTY,
          // skipping the composer. composer mode (or any fallback below)
          // still routes through the composer as the paste保底.
          if (readMobileInputMode() === "direct") {
            if (pasteInFlight.current) return;
            pasteInFlight.current = true;
            await window.aiTerminal.writeTerminal({ terminalId, data: buildMobilePasteData(text), source: "mobile-composer" })
              .then(() => mobileInputController.recordPasted(terminalId, text))
              .finally(() => { pasteInFlight.current = false; });
          } else {
            openMobileComposer(terminalId, "paste-fallback");
            mobileInputController.insertText(terminalId, text);
          }
        } else {
          setKeysOpen(false);
          openMobileComposer(terminalId, "paste-fallback");
        }
      })
      .catch(() => {
        setKeysOpen(false);
        openMobileComposer(terminalId, "paste-fallback");
      });
  };
  const toggleReader = (): void => {
    if (!activeTerminalId) return;
    setKeysOpen(false);
    window.dispatchEvent(new CustomEvent("coterm:reader-toggle", { detail: { terminalId: activeTerminalId } }));
  };

  const fileInputRef = useRef<HTMLInputElement>(null);

  const onAttachFile = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    // Reset the input value so the same file can be re-selected.
    event.target.value = "";
    if (!file || !activeTerminalId) return;
    try {
      const { dataBase64, mimeType } = await resizeImage(file);
      const result = await window.aiTerminal.saveUpload({
        name: file.name || `upload-${Date.now()}.jpg`,
        mimeType,
        dataBase64,
      });
      // Inject the path wrapped in double quotes (no auto-Enter). Double quotes
      // survive spaces (the userData/install path contains "Coterm") across
      // cmd, pwsh, and the inner LLMs — so mobile users don't have to type quotes.
      // ponytail: ceiling — double quotes, not profile-aware escaping. If a shell
      // needs different quoting, look up the terminal profile and use
      // quoteTerminalPath from @shared/terminal (as TerminalDock does for drops).
      await window.aiTerminal.writeTerminal({
        terminalId: activeTerminalId,
        data: `"${result.localPath}"`,
      });
    } catch (error) {
      // ponytail: ceiling — error not surfaced in UI; no setError action in store.
      console.error("attach failed", error);
    }
  };

  const voiceEnabled = settings?.voice?.enabled === true;
  const voiceLang = settings?.voice?.lang ?? "zh-TW";
  const streamingDictation = settings?.voice?.streamingDictation === true;
  const lastVoiceCommitRef = useRef<VoiceCommitRecord | null>(null);
  const voiceTargetTerminalRef = useRef<VoiceDraftToken | null>(null);
  const [voiceError, setVoiceError] = useState<VoiceError | null>(null);
  // Toggle-mode voice: pointerDown starts a long-press timer; if it fires we
  // cancel instead of toggling. pointerUp within the window = a tap.
  const voiceLongPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceLongPressFiredRef = useRef(false);
  const voiceDraftSnapshot = useVoiceDraftSnapshot();
  const onVoiceFinal = useCallback((text: string, sessionId?: number) => {
    const normalized = normalizeVoiceFinal(text);
    const target = voiceTargetTerminalRef.current;
    voiceTargetTerminalRef.current = null;
    if (!target || !normalized || !shouldCommitVoiceFinal(lastVoiceCommitRef.current, normalized, sessionId)) return;
    lastVoiceCommitRef.current = { text: normalized, sessionId, at: Date.now() };
    setVoiceError(null);
    const targetStillExists = useAppStore.getState().dockLayout.tiles
      .some((tile) => tile.terminalId === target.terminalId);
    if (!targetStillExists) {
      voiceDraftStore.recover(target, normalized);
      return;
    }
    // No trailing "\r", ever. Speech recognition mishears and whisper outright
    // hallucinates; in a chat box that is embarrassing, in a terminal it runs.
    // The user reads the line and presses Enter themselves.
    void window.aiTerminal.writeTerminal({ terminalId: target.terminalId, data: normalized, source: "voice" })
      .then(() => voiceDraftStore.clear(target))
      .catch(() => voiceDraftStore.recover(target, normalized));
  }, []);
  const onVoiceError = useCallback((err: VoiceError) => {
    const target = voiceTargetTerminalRef.current;
    // A failed clip is not a cancelled one: keep whatever partial transcript we
    // have as the recoverable draft so the words can be re-inserted, then say
    // out loud what failed — a title tooltip nobody hovers is not a failure UI.
    if (target) {
      const draft = voiceDraftStore.getSnapshot().byTerminal[target.terminalId];
      if (draft && draft.epoch === target.epoch && draft.text.trim()) voiceDraftStore.recover(target, draft.text);
      else if (draft) voiceDraftStore.clear(target);
    }
    voiceTargetTerminalRef.current = null;
    setVoiceError(err);
    // Silent failures (esp. `network`, i.e. an unreachable/timing-out STT
    // server) have no other surface — the mic icon only greys out.
    if (err === "network" || err === "stt-auth" || err === "no-stt-server") {
      setError(t(`topbar.voice.error.${err}`));
    }
  }, [setError, t]);
  const voice = useVoiceInput({
    lang: voiceLang,
    streamingPreview: streamingDictation,
    onFinal: onVoiceFinal,
    onError: onVoiceError,
  });
  useEffect(() => {
    const target = voiceTargetTerminalRef.current;
    if (!target || !streamingDictation) return;
    if (voice.streamingState === "partial" && voice.interim) {
      voiceDraftStore.update(target, "partial", voice.interim);
      return;
    }
    if (voice.streamingState === "finalizing") {
      voiceDraftStore.update(target, "finalizing");
      return;
    }
    if (voice.streamingState === "preview-paused" || voice.streamingState === "rate-limited") {
      voiceDraftStore.update(target, "preview-paused");
      return;
    }
    if (voice.isRecording) voiceDraftStore.update(target, "listening");
  }, [streamingDictation, voice.interim, voice.isRecording, voice.streamingState]);
  useEffect(() => {
    if (!voice.isRecording) return;
    const cancelOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      const target = voiceTargetTerminalRef.current;
      if (target) voiceDraftStore.clear(target);
      voiceTargetTerminalRef.current = null;
      voice.cancel();
    };
    window.addEventListener("keydown", cancelOnEscape);
    return () => window.removeEventListener("keydown", cancelOnEscape);
  }, [voice]);
  const voiceTitle = voice.isRecording
    ? voice.streamingState === "finalizing"
      ? t("topbar.voice.finalizing")
      : voice.streamingState === "rate-limited" || voice.streamingState === "preview-paused"
        ? t("topbar.voice.rate-limited")
        : voice.streamingState === "partial"
          ? (voice.interim || t("topbar.voice.partial"))
          : (voice.interim || t("topbar.voice.recording"))
    : voiceError
      ? t(`topbar.voice.error.${voiceError}`)
      : t("topbar.voice.holdToSpeak");

  const insertRecoverableVoiceDraft = useCallback(async (): Promise<void> => {
    const recoverable = voiceDraftStore.getSnapshot().recoverable;
    // voicefix: use the voice pin (last local user pick), not the raw global
    // selection — another client can steal selectedTerminalId over WS.
    const storeNow = useAppStore.getState();
    const targetTerminalId = resolveVoiceTargetTerminalId(
      storeNow.lastLocalSelectedTerminalId,
      storeNow.dockLayout.tiles.map((tile) => tile.terminalId),
      storeNow.dockLayout.selectedTerminalId,
    );
    if (!recoverable || !targetTerminalId) return;
    await window.aiTerminal.writeTerminal({ terminalId: targetTerminalId, data: recoverable.text, source: "voice" });
    voiceDraftStore.clearRecoverable(recoverable.epoch);
  }, []);

  // --- Mobile: one-row control bar + overlay menu -----------------------------
  // Visible controls: [settings] [workspace (fixed Sidebar button)] [PTY/tools dropdown]
  // [Enter]. The dropdown overlays the terminal instead
  // of consuming a second grid row, preserving one more line of PTY height.
  if (isMobile) {
    const tiles = dockLayout.tiles;
    // Read at render, not in state: the composer's "use native keyboard" button
    // writes the mode straight to localStorage, and opening the keys menu
    // re-renders — so a render-time read is always fresh without an effect.
    const inputMode = readMobileInputMode();
    const activeIndex = Math.max(0, tiles.findIndex((tile) => tile.terminalId === activeTerminalId));
    return (
      <header className="topbar mobile-dock-bar">
        {/* Left-most control: the settings entry (matches the desktop brand gear). */}
        <button
          data-action-id="topbar.mobile.settings.open"
          type="button"
          className="mobile-dock-btn mobile-settings-btn"
          title={t("topbar.settings")}
          aria-label={t("topbar.settings")}
          onClick={() => setSettingsOpen(true)}
        >
          <Settings size={16} />
        </button>
        <UsageHud />
        <div className="mobile-menu-wrap" ref={mobileMenuRef}>
          <button
            data-action-id="topbar.mobile.keys.toggle"
            type="button"
            className={`mobile-dock-btn mobile-menu-toggle ${keysOpen ? "active" : ""}`}
            title={t("topbar.keys.toggle")}
            aria-haspopup="menu"
            aria-expanded={keysOpen}
            disabled={tiles.length === 0}
            onClick={() => setKeysOpen((v) => !v)}
          >
            <span className="mobile-menu-pty-label">PTY {tiles.length > 0 ? activeIndex + 1 : "—"}</span>
            {visibleMobileSessionSummary && (
              <MobileRecapMarquee text={visibleMobileSessionSummary} />
            )}
            <ChevronDown size={15} className={keysOpen ? "open" : ""} />
          </button>
          {keysOpen && (
            <div className="mobile-menu-panel" role="menu">
              <div className="mobile-menu-section-label">PTY</div>
              <div className="mobile-pty-scroll">
                {tiles.map((tile, i) => renderPtySlot(
                  tile,
                  i,
                  activeTerminalId,
                  ptyStates[tile.terminalId] ?? null,
                  (terminalId) => {
                    mobileInputController.close("terminal-switch");
                    selectMobileTile(terminalId);
                    setKeysOpen(false);
                  },
                  t("topbar.switcher.title", { n: i + 1, solo: "" }),
                ))}
              </div>
              <div className="mobile-menu-section-label">TOOLS</div>
              <div className="mobile-keys-tray">
                <button data-action-id="topbar.mobile.stop" type="button" className="mobile-dock-btn mobile-key-stop" title={t("topbar.keys.stop")} disabled={!activeTerminalId} onClick={sendStop}>
                  <span className="mobile-key-label">STOP</span>
                </button>
                <button data-action-id="topbar.mobile.key.up" type="button" className="mobile-dock-btn" title={t("topbar.keys.up")} disabled={!activeTerminalId} onClick={() => sendKey("\x1b[A")}><ArrowUp size={16} /></button>
                <button data-action-id="topbar.mobile.key.down" type="button" className="mobile-dock-btn" title={t("topbar.keys.down")} disabled={!activeTerminalId} onClick={() => sendKey("\x1b[B")}><ArrowDown size={16} /></button>
                <button data-action-id="topbar.mobile.key.left" type="button" className="mobile-dock-btn" title={t("topbar.keys.left")} disabled={!activeTerminalId} onClick={() => sendKey("\x1b[D")}><ArrowLeft size={16} /></button>
                <button data-action-id="topbar.mobile.key.right" type="button" className="mobile-dock-btn" title={t("topbar.keys.right")} disabled={!activeTerminalId} onClick={() => sendKey("\x1b[C")}><ArrowRight size={16} /></button>
                <button data-action-id="topbar.mobile.key.escape" type="button" className="mobile-dock-btn" title={t("topbar.keys.esc")} disabled={!activeTerminalId} onClick={() => sendKey("\x1b")}><span className="mobile-key-label">Esc</span></button>
                <button data-action-id="topbar.mobile.key.tab" type="button" className="mobile-dock-btn" title={t("topbar.keys.tab")} disabled={!activeTerminalId} onClick={() => sendKey("\t")}><span className="mobile-key-label">Tab</span></button>
                <button data-action-id="topbar.mobile.refresh" type="button" className="mobile-dock-btn mobile-key-refresh" title={t("topbar.refresh.title")} disabled={!activeTerminalId} onClick={() => { if (activeTerminalId) requestTerminalRecovery(activeTerminalId, "mobile-refresh"); }}><RefreshCw size={16} /></button>
                <button data-action-id="topbar.mobile.input.open" type="button" className="mobile-dock-btn mobile-key-input" title={t("topbar.input.mode.toggle")} aria-label={t("topbar.input.mode.toggle")} disabled={!activeTerminalId} onClick={() => {
                  if (!activeTerminalId) return;
                  const next: MobileInputMode = inputMode === "composer" ? "direct" : "composer";
                  writeMobileInputMode(next);
                  setKeysOpen(false);
                  if (next === "composer") openMobileComposer(activeTerminalId, "toolbar");
                  else window.dispatchEvent(new CustomEvent("coterm:focus-pty", { detail: { terminalId: activeTerminalId } }));
                }}>{inputMode === "composer" ? t("topbar.input.mode.composer") : t("topbar.input.mode.direct")}</button>
                <button data-action-id="topbar.mobile.paste" type="button" className="mobile-dock-btn mobile-key-paste" title={t("topbar.keys.paste")} disabled={!activeTerminalId} onClick={pasteFromClipboard}><Clipboard size={16} /></button>
                <button data-action-id="topbar.mobile.reader.toggle" type="button" className="mobile-dock-btn mobile-key-copy" title={t("dock.reader.toggle")} aria-label={t("dock.reader.toggle")} disabled={!activeTerminalId} onClick={toggleReader}><Eye size={16} /></button>
                <button data-action-id="topbar.mobile.attach.open" type="button" className="mobile-dock-btn" title={t("topbar.keys.attach")} disabled={!activeTerminalId} onClick={() => fileInputRef.current?.click()}><Paperclip size={16} /></button>
              </div>
            </div>
          )}
        </div>
        <button
          data-action-id="topbar.mobile.enter"
          type="button"
          className="mobile-dock-btn mobile-key-enter"
          title={t("topbar.enter.title")}
          disabled={!activeTerminalId || mobileComposer.state.status === "submitting"}
          onClick={() => sendKey("\r")}
        >
          <CornerDownLeft size={17} />
        </button>
        {/* Hidden file input for attach (image/camera/file) */}
        <input
          data-action-id="topbar.mobile.attach.change"
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => void onAttachFile(e)}
        />
      </header>
    );
  }

  // --- Desktop: terminal tabs full-width, utilities right --------------------
  // Global usage moved to the sidebar foot (sidebar-usage). +agent removed: the
  // sidebar per-project "+" already opens the LLM picker (openTile +
  // setPickerState), so a top-bar duplicate was redundant.
  return (
    <header className="topbar topbar-desktop">
      <div className="topbar-left">
        {/* Connected single-row tabs keep their width and scroll horizontally.
            Full titles and paths remain in the tooltip. Tap to solo a pane;
            tap its tab again or expand to return to the grid. */}
        {dockLayout.tiles.length > 0 && (
          <div ref={tabTrayRef} className="topbar-switcher" role="group" aria-label={t("topbar.switcher.aria")}>
            {dockLayout.tiles.map((tile, i) => {
              const isSelected = tile.terminalId === activeTerminalId;
              const isExclusive = tile.terminalId === dockLayout.exclusiveTerminalId;
              const state = ptyStates[tile.terminalId] ?? null;
              const meta = sessionSummaries[tile.terminalId];
              const shortCwdText = shortCwd(meta?.cwd ?? null);
              const title = [
                t("topbar.switcher.title", { n: i + 1, solo: isExclusive ? t("topbar.switcher.solo") : "" }),
                meta?.summary ?? "",
                meta?.cwd?.replace(/\\/g, "/") ?? "",
              ].filter(Boolean).join(" — ");
              return (
                <button
                  data-action-id="topbar.terminal.exclusive-toggle"
                  key={tile.terminalId}
                  className={`topbar-switcher-btn topbar-tab ${isSelected ? "active" : ""} ${isExclusive ? "exclusive" : ""}`}
                  title={title}
                  aria-label={title}
                  onClick={() => {
                    if (isExclusive) {
                      void setExclusive(null);
                    } else {
                      void setExclusive(tile.terminalId);
                    }
                  }}
                >
                  {/* Lamp, number and short title share one line. */}
                  <span className="topbar-tab-row1">
                    <span
                      className={`pty-signal pty-signal-${ptySignalTone(state)}${state === "error" ? " is-error" : ""}`}
                      aria-hidden="true"
                    />
                    <span className="topbar-switcher-num">{i + 1}</span>
                    <span className="topbar-tab-cwd">{meta?.summary || shortCwdText || "Terminal"}</span>
                  </span>
                </button>
              );
            })}
            {dockLayout.exclusiveTerminalId && (
              <button
                data-action-id="topbar.terminal.show-all"
                className="topbar-switcher-btn"
                title={t("topbar.switcher.showAll")}
                onClick={() => void setExclusive(null)}
              >
                <Expand size={14} />
              </button>
            )}
          </div>
        )}
      </div>
      <div className="topbar-right">
        {/* ponytail: mobile refresh — add a slot to the mobile-dock-bar grid
            (TopBar mobile path returns early at line 41 and has no .topbar-actions).
            Desktop-only for now, by design. */}
        {voiceDraftSnapshot.recoverable && (
          <div className="voice-recovery-draft" role="status">
            <span className="voice-recovery-text" title={voiceDraftSnapshot.recoverable.text}>
              {voiceDraftSnapshot.recoverable.text}
            </span>
            <button
              data-action-id="topbar.voice.recover-insert"
              type="button"
              disabled={!activeTerminalId}
              onClick={() => void insertRecoverableVoiceDraft()}
            >
              {t("topbar.voice.recover")}
            </button>
          </div>
        )}
        {voiceEnabled && voice.isSupported && (
          <button
            data-action-id="topbar.voice.toggle"
            data-action-trigger="click"
            className={`icon-button voice-mic ${voice.isRecording ? "recording" : ""} ${!voice.isRecording && voiceError ? "voice-error" : ""} ${voice.streamingState === "rate-limited" || voice.streamingState === "preview-paused" ? "voice-rate-limited" : ""}`}
            title={voiceTitle}
            disabled={!activeTerminalId}
            onPointerDown={(e) => {
              e.preventDefault();
              if (!activeTerminalId) return;
              // Start the long-press timer. If it fires before pointerUp, we
              // treat this press as "cancel" instead of a tap-toggle.
              voiceLongPressFiredRef.current = false;
              voiceLongPressRef.current = setTimeout(() => {
                voiceLongPressFiredRef.current = true;
                const target = voiceTargetTerminalRef.current;
                if (target) voiceDraftStore.clear(target);
                voiceTargetTerminalRef.current = null;
                voice.cancel();
              }, VOICE_LONG_PRESS_MS);
            }}
            onPointerUp={() => {
              if (voiceLongPressRef.current) { clearTimeout(voiceLongPressRef.current); voiceLongPressRef.current = null; }
              if (voiceLongPressFiredRef.current) return; // long-press already cancelled
              // Tap-toggle: first tap starts, second tap submits.
              if (!voice.isRecording) {
                // voicefix: lock the voice pin (last local user pick), resolved
                // synchronously from the store — never the raw global selection,
                // which can be stolen mid-race by another client's broadcast.
                const storeNow = useAppStore.getState();
                const voiceTargetId = resolveVoiceTargetTerminalId(
                  storeNow.lastLocalSelectedTerminalId,
                  storeNow.dockLayout.tiles.map((tile) => tile.terminalId),
                  storeNow.dockLayout.selectedTerminalId,
                );
                if (!voiceTargetId) return;
                voiceTargetTerminalRef.current = streamingDictation
                  ? voiceDraftStore.lock(voiceTargetId)
                  : { terminalId: voiceTargetId, epoch: 0 };
                setVoiceError(null);
                voice.start();
              } else {
                voice.stop();
              }
            }}
            onPointerCancel={() => {
              if (voiceLongPressRef.current) { clearTimeout(voiceLongPressRef.current); voiceLongPressRef.current = null; }
            }}
            onPointerLeave={() => {
              // Toggle mode: pointer leaving the button no longer interrupts a
              // recording (the user may tap-toggle then move away). Only clear
              // the pending long-press timer so a drag-off doesn't fire cancel.
              if (voiceLongPressRef.current) { clearTimeout(voiceLongPressRef.current); voiceLongPressRef.current = null; }
            }}
          >
            <Mic size={16} />
          </button>
        )}
        {window.aiTerminal.isBrowser !== true && (settings?.readingMode?.topbarButton === true || readingModeActive) && (
          <button
            data-action-id="topbar.reading-mode.toggle"
            type="button"
            className={`icon-button${readingModeActive ? " active" : ""}`}
            title={t("topbar.reading.toggle")}
            aria-label={t("topbar.reading.toggle")}
            aria-pressed={readingModeActive}
            // f1b bug 2: single-click semantics. A double-click fires two click
            // events (detail 1 then 2) plus a dblclick; swallowing detail>1 makes
            // dblclick = exactly one toggle, with no timing window that could eat
            // a legitimate fast second press. No handler up the tree consumes a
            // dblclick here; the stopPropagation keeps it that way.
            onClick={(event) => {
              if (event.detail > 1) return;
              toggleReadingMode();
            }}
            onDoubleClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            <BookOpen size={16} />
          </button>
        )}
        {/* 2026-10-03: the layout presets live right beside the reading toggle
            (reading mode only) instead of floating at the dock's top-left. */}
        {window.aiTerminal.isBrowser !== true && <ReadingPresetPicker />}
        <button
          data-action-id="topbar.terminal.refresh"
          className="icon-button"
          title={t("topbar.refresh.title")}
          disabled={!activeTerminalId}
          onClick={() => {
            if (activeTerminalId) {
              requestTerminalRecovery(activeTerminalId, "manual-refresh");
            }
          }}
        >
          <RefreshCw size={16} />
        </button>
        <button
          data-action-id="topbar.theme.toggle"
          className="icon-button theme-toggle"
          title={settings?.theme === "light" ? t("topbar.theme.toggleDark") : t("topbar.theme.toggleLight")}
          onClick={(event) => {
            if (!settings) return;
            const patch = themeTogglePatch(settings.theme);
            const rect = event.currentTarget.getBoundingClientRect();
            sunMoonReveal(settings.theme === "light" ? "dark" : "light", rect.left + rect.width / 2, rect.top + rect.height / 2);
            void updateSettings(patch);
          }}
        >
          {settings?.theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
        </button>
        {/* maintainer 2026-09-24: checkpoint / 任務中心按鈕改成設定開關控制——他
            目前不用這兩個功能,本機設定已關;功能保留 (2026-09-27 起預設關)。 */}
        {settings?.checkpoint?.topbarButton === true && (
          <button
            data-action-id="topbar.checkpoint.toggle"
            className={`icon-button ${checkpointOpen ? "active" : ""}`}
            onClick={() => setCheckpointOpen(!checkpointOpen)}
            title={t("checkpoint.heading")}
          >
            <History size={16} />
          </button>
        )}
        {/* 2026-10-02 maintainer: 設定齒輪搬到右上角按鈕群（電源鍵左邊），左欄不再放。 */}
        <button
          data-action-id="topbar.settings.open"
          type="button"
          className="icon-button"
          onClick={() => setSettingsOpen(true)}
          title={t("topbar.settings")}
          aria-label={t("topbar.settings")}
        >
          <Settings size={16} />
        </button>
        {window.aiTerminal.isBrowser !== true && (
          <button
            data-action-id="topbar.app.quit"
            className="icon-button"
            onClick={() => void window.aiTerminal.quitApp()}
            title={t("topbar.quit")}
            aria-label={t("topbar.quit")}
          >
            <Power size={16} />
          </button>
        )}
      </div>
    </header>
  );
}

function renderPtySlot(
  tile: { terminalId: string; agentProfile?: string | null },
  index: number,
  activeTerminalId: string | null,
  state: PtyState | null,
  selectTile: (id: string) => void,
  title: string,
): React.JSX.Element {
  const isActive = tile.terminalId === activeTerminalId;
  return (
    <button
      data-action-id="topbar.mobile.terminal.select"
      key={`pty-${tile.terminalId}`}
      type="button"
      className={`mobile-dock-btn mobile-pty-slot ${isActive ? "active" : ""}`}
      title={title}
      aria-label={title}
      onClick={() => void selectTile(tile.terminalId)}
    >
      <span className="mobile-pty-num">{index + 1}</span>
      <span
        className={`pty-signal pty-signal-${ptySignalTone(state)}${state === "error" ? " is-error" : ""}`}
        aria-hidden="true"
      />
    </button>
  );
}

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() =>
    typeof window !== "undefined" && window.matchMedia(MOBILE_LAYOUT_QUERY).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(MOBILE_LAYOUT_QUERY);
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return mobile;
}
