import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Check as CheckIcon, Copy as CopyIcon, Search as SearchIcon, X as XIcon } from "lucide-react";
import type { PtyState, TerminalTranscript, TerminalTranscriptMessage } from "@shared/types";
import { useI18n } from "../../i18n";
import { isSearchOpenShortcut, resolveSearchInputAction } from "../terminal-search-key";
import { ptySignalTone } from "../pty-state-label";
import { MOBILE_LAYOUT_QUERY } from "../terminal-responsive";
import { buildSearchCorpus, clampActiveHit, collectMatchOffsets, messageIndexForOffset, nextActiveHit, READER_SEARCH_MAX_HITS } from "./terminal-reader-search";
import { activeTurnTick, layoutTurnTicks, ticksEqual, TURN_RAIL_MIN_GAP, TURN_RAIL_MIN_HIT_PX } from "./terminal-reader-turns";
import type { TurnTick, TurnTickInput } from "./terminal-reader-turns";
import { ConversationReader } from "./ConversationReader";
import { buildCopyAllText, keepFinalTurnOutputs, pinchReaderFontSize, terminalReaderController } from "./terminal-reader-state";
import { mergeTranscriptMessages } from "./terminal-reader-merge";
import { copyTextToClipboard } from "./clipboard";
import { mobileInputController } from "../mobile/mobile-input-controller";
import { useComposerFocusOwnership } from "../mobile/use-composer-focus";
import { forceResolveCompositionForSend } from "../mobile/mobile-composer-submit";

const STATUS_LABELS: Record<string, string> = {
  loading: "讀取對話中…",
  pending: "Agent 尚未建立對話檔，請稍後重試。",
  not_found: "找不到此 terminal 的對話來源。",
  ambiguous: "此 terminal 對應到多個對話，為避免讀錯已暫停。",
  unsupported: "此 Agent provider 尚未提供整理後對話。",
  error: "對話讀取失敗，請重新整理。",
  empty: "尚無可顯示的對話內容。",
};

// Phone detection reuses the app's own mobile layout query — same detector as
// the dock and top bar, not a new one.
function useIsPhone(): boolean {
  const [isPhone, setIsPhone] = useState(() => window.matchMedia(MOBILE_LAYOUT_QUERY).matches);
  useEffect(() => {
    const mql = window.matchMedia(MOBILE_LAYOUT_QUERY);
    const onChange = (event: MediaQueryListEvent): void => setIsPhone(event.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return isPhone;
}

export function TerminalReaderOverlay({
  terminalId,
  active,
  getRawText,
  ptyState,
}: {
  terminalId: string;
  active: boolean;
  getRawText: () => string;
  ptyState?: PtyState | null;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const revision = useSyncExternalStore(terminalReaderController.subscribe, terminalReaderController.getSnapshot, terminalReaderController.getSnapshot);
  void revision;
  const reader = terminalReaderController.get(terminalId);
  const tone = ptySignalTone(ptyState);
  const isPhone = useIsPhone();
  const [rawText, setRawText] = useState("");
  const [status, setStatus] = useState<"loading" | "ready" | "pending" | "not_found" | "ambiguous" | "unsupported" | "error" | "empty">("loading");
  const [messages, setMessages] = useState<TerminalTranscriptMessage[]>([]);
  const [refreshGeneration, setRefreshGeneration] = useState(0);

  // Live-view state: near-bottom tracking, busy→done flash, elapsed seconds,
  // and the per-turn quick-jump rail.
  const [nearBottom, setNearBottom] = useState(true);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const previousContentRef = useRef("");
  const [doneFlash, setDoneFlash] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [turnTicks, setTurnTicks] = useState<TurnTick[]>([]);
  const [activeTick, setActiveTick] = useState(-1);
  const stickToBottomRef = useRef(true);
  const turnTicksRef = useRef<TurnTick[]>([]);
  const toneRef = useRef(tone);
  const runStartRef = useRef<number | null>(null);

  // Copy-all feedback ("已複製" / "複製失敗") — one short flash per copy.
  const [copyAllState, setCopyAllState] = useState<"idle" | "ok" | "error">("idle");
  const copyAllTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (copyAllTimerRef.current !== null) window.clearTimeout(copyAllTimerRef.current);
  }, []);

  // Phone composer: the reader's inline input IS the shared mobile composer —
  // same per-terminal drafts, same submit path/writer, same error handling as
  // MobileCommandComposer, via the single mobileInputController state machine
  // opened with reason "reader" (the floating composer stands down for that
  // reason, so the two surfaces never fight over one open/submit machine).
  // Draft/error re-renders come from useSyncExternalStore; the IME composing
  // flag lives in the controller OUTSIDE snapshot state (re-rendering the
  // controlled textarea mid-composition drops the IME caret), and iPhone
  // dictation text always lands through input events (controlled value) —
  // keydown is never a source of text or an implicit submit.
  const composerSnapshot = useSyncExternalStore(mobileInputController.subscribe, mobileInputController.getSnapshot, mobileInputController.getSnapshot);
  const composerPanelRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [composerSent, setComposerSent] = useState(false);
  const composerTimerRef = useRef<number | null>(null);
  const readerComposerOpen = isPhone && reader.open && active;
  const composerDraft = composerSnapshot.draftsByTerminal[terminalId] ?? "";
  const pasted = composerSnapshot.pastedByTerminal[terminalId];
  const composerError = composerSnapshot.error;

  // Reader focus ownership: identical reclaim/rebind machinery as the floating
  // composer, except focusOnOpen=false — opening reading mode must NOT pop the
  // keyboard over the content; focus starts with the user's tap. The reclaim
  // ladder is what keeps focus in the input across a 中/英 keyboard switch,
  // and without it the reader's live updates could strand the keyboard.
  const { notifyComposerBlur } = useComposerFocusOwnership({
    open: readerComposerOpen,
    terminalId,
    panelRef: composerPanelRef,
    textareaRef: composerTextareaRef,
    focusOnOpen: false,
  });

  // Open the shared controller as "reader" for this terminal while the phone
  // reader is up; hand any floating-composer session over (keeping its draft),
  // and close with "unmount" on teardown (also keeping the draft).
  useEffect(() => {
    if (!readerComposerOpen) return;
    const current = mobileInputController.getSnapshot().state;
    if (current.status !== "closed" && current.reason !== "reader") mobileInputController.close("terminal-switch");
    mobileInputController.open({ terminalId, reason: "reader" });
    return () => {
      const state = mobileInputController.getSnapshot().state;
      if (state.status === "closed" || state.reason !== "reader" || state.terminalId !== terminalId) return;
      mobileInputController.close("unmount");
    };
  }, [readerComposerOpen, terminalId]);

  // Phone layout: publish this composer's measured height as
  // --terminal-reader-composer-h on the overlay so the jump-to-bottom button
  // and the turn rail offset ABOVE the composer instead of landing on its
  // send button (the floating composer's --coterm-composer-height stands down
  // while reading mode is open, so the old offsets collapsed onto the
  // composer). Re-published by a ResizeObserver — the textarea auto-grows as
  // the draft grows, so the height is not fixed.
  useEffect(() => {
    if (!readerComposerOpen) return;
    const root = searchOverlayRef.current;
    const panel = composerPanelRef.current;
    if (!root || !panel) return;
    const publish = (): void => {
      root.style.setProperty("--terminal-reader-composer-h", `${Math.ceil(panel.getBoundingClientRect().height)}px`);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(panel);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--terminal-reader-composer-h");
    };
  }, [readerComposerOpen]);

  // Auto-grow: the textarea's height follows the draft up to the CSS cap
  // (max-height: 40vh on phones; min-height 64px ≈ 2-3 lines at 16px). Only
  // the textarea's own height style changes — no state write mid-composition,
  // so the IME caret stays stable while typing.
  const resizeComposerTextarea = useCallback((): void => {
    const el = composerTextareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  useEffect(() => {
    if (!readerComposerOpen) return;
    resizeComposerTextarea();
  }, [readerComposerOpen, resizeComposerTextarea, composerDraft]);

  // Clear the "✓ 已送出" flash when the reader closes or the terminal changes
  // (queued — a synchronous setState in an effect body trips the
  // cascading-render lint; this file resets via queueMicrotask elsewhere too).
  useEffect(() => {
    queueMicrotask(() => setComposerSent(false));
  }, [readerComposerOpen, terminalId]);
  useEffect(() => () => {
    if (composerTimerRef.current !== null) window.clearTimeout(composerTimerRef.current);
  }, []);

  const submitComposer = useCallback((fromSendButton: boolean): void => {
    // Enter while the agent works stays silent (the draft just waits); the
    // Send button always sends — same policy as before the composer unification.
    if (!fromSendButton && tone === "working") return;
    if (typeof window.aiTerminal?.writeTerminal !== "function") return;
    // Send tap = explicit final intent: resolves a still-marked dictation
    // composition and takes the textarea's live text (mobile-composer-submit).
    if (fromSendButton) forceResolveCompositionForSend(terminalId, composerTextareaRef.current?.value ?? null);
    void mobileInputController.submit((input) => window.aiTerminal.writeTerminal(input)).then((ok) => {
      if (!ok) return;
      // submit() closes the controller on success (the floating composer wants
      // that); the reader's input stays on screen, so own the terminal again.
      mobileInputController.open({ terminalId, reason: "reader" });
      setComposerSent(true);
      if (composerTimerRef.current !== null) window.clearTimeout(composerTimerRef.current);
      composerTimerRef.current = window.setTimeout(() => setComposerSent(false), 4000);
    });
  }, [terminalId, tone]);
  // Exactly the messages the conversation pane currently shows; null when the
  // pane is not in a ready conversation state (then copy-all copies raw text).
  // keepFinalTurnOutputs is always applied — 僅結論 is not a toggle anymore.
  const shownMessages = useMemo(
    () => (status === "ready" ? keepFinalTurnOutputs(messages) : null),
    [messages, status],
  );
  useEffect(() => {
    const content = JSON.stringify(shownMessages ?? []);
    if (previousContentRef.current && previousContentRef.current !== content && !stickToBottomRef.current) {
      queueMicrotask(() => setHasNewMessages(true));
    }
    previousContentRef.current = content;
  }, [shownMessages]);
  const handleCopyAll = useCallback((): void => {
    const text = shownMessages ? buildCopyAllText(shownMessages) : rawText;
    if (!text) return;
    void copyTextToClipboard(text).then((ok) => {
      setCopyAllState(ok ? "ok" : "error");
      if (copyAllTimerRef.current !== null) window.clearTimeout(copyAllTimerRef.current);
      copyAllTimerRef.current = window.setTimeout(() => setCopyAllState("idle"), 1500);
    });
  }, [rawText, shownMessages]);

  const refresh = useCallback((): void => {
    const snapshot = getRawText();
    setRawText(snapshot);
  }, [getRawText]);

  // Reader search (Ctrl+F) over the conversation the reader shows. Searching
  // re-scans the corpus per keystroke — no debounce, no output-path work —
  // and each hit scrolls its message into view. State lives here so the
  // shortcut can open and focus the box in one shot.
  const searchOverlayRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeHit, setActiveHit] = useState(0);
  const corpus = useMemo(() => buildSearchCorpus(shownMessages ?? []), [shownMessages]);
  const hitOffsets = useMemo(() => collectMatchOffsets(corpus.text, searchQuery), [corpus, searchQuery]);

  const scrollHitIntoView = useCallback((index: number): void => {
    const offset = hitOffsets[index];
    if (offset === undefined) return;
    const messageIndex = messageIndexForOffset(corpus.starts, offset);
    window.setTimeout(() => {
      searchOverlayRef.current?.querySelector(`[data-message-index="${messageIndex}"]`)?.scrollIntoView({ block: "center" });
    }, 0);
  }, [corpus.starts, hitOffsets]);

  const openSearch = useCallback((): void => {
    setSearchOpen(true);
    window.setTimeout(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }, 0);
  }, []);

  const closeSearch = useCallback((): void => {
    setSearchOpen(false);
    setSearchQuery("");
  }, []);

  const handleSearchQueryChange = useCallback((value: string): void => {
    setSearchQuery(value);
    setActiveHit(0);
  }, []);

  const navigateHits = useCallback((direction: "next" | "previous"): void => {
    if (hitOffsets.length === 0) return;
    const next = nextActiveHit(clampActiveHit(activeHit, hitOffsets.length), hitOffsets.length, direction);
    setActiveHit(next);
    scrollHitIntoView(next);
  }, [activeHit, hitOffsets.length, scrollHitIntoView]);

  // Ctrl+F while the reader is open routes here — capture phase on window so
  // neither the PTY nor the xterm hamburger search ever sees the event.
  useEffect(() => {
    if (!reader.open || !active) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isSearchOpenShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      openSearch();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [active, openSearch, reader.open]);

  // Follow the active hit whenever it moves (typing resets to the first hit).
  useEffect(() => {
    if (!searchOpen || !searchQuery || hitOffsets.length === 0) return;
    scrollHitIntoView(clampActiveHit(activeHit, hitOffsets.length));
  }, [activeHit, hitOffsets, scrollHitIntoView, searchOpen, searchQuery]);

  // Reset the stick-to-bottom state on open / terminal change: a fresh
  // scroller mounts at the top and fires no scroll event, and "first open"
  // should land at the very bottom (declared BEFORE the follow effect so the
  // reset wins on the same commit).
  useEffect(() => {
    // Ref-only reset (setState in an effect body trips cascading-render lint);
    // the follow effect below lands at the bottom and the scroll listener then
    // records near-bottom on its behalf.
    stickToBottomRef.current = true;
    previousContentRef.current = "";
    queueMicrotask(() => setHasNewMessages(false));
  }, [reader.open, terminalId]);

  // Auto-stick: whenever content (re)loads while the user is near the
  // bottom (or on first open), keep the view pinned to the very bottom.
  // Never yanks the user back if they scrolled up.
  useEffect(() => {
    if (!reader.open || !active) return;
    if (!stickToBottomRef.current) return;
    const rootEl = searchOverlayRef.current;
    if (!rootEl) return;
    const scroller = rootEl.querySelector<HTMLElement>(".terminal-reader-scroll");
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [active, messages, rawText, reader.fontSize, reader.open, status, pasted]);

  // Near-bottom tracking + turn-rail active tick. Scroll doesn't bubble, so
  // listen at window capture and filter by the reader's scroll container.
  useEffect(() => {
    if (!reader.open || !active) return;
    const onScroll = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const cls = target.className;
      if (typeof cls !== "string") return;
      if (!cls.includes("terminal-reader-scroll")) return;
      const distance = target.scrollHeight - target.scrollTop - target.clientHeight;
      const close = distance <= 80;
      stickToBottomRef.current = close;
      setNearBottom(close);
      if (close) setHasNewMessages(false);
      if (turnTicksRef.current.length > 0) {
        setActiveTick(activeTurnTick(turnTicksRef.current, target.scrollTop, target.scrollHeight, target.clientHeight));
      }
    };
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [active, reader.open]);

  // Live-view polling: while the reader is open, refresh the transcript —
  // every ~2s while the agent works, every ~5s otherwise (state detection can
  // miss a busy agent, and that must not freeze the view). No loading state
  // here — old content stays until the new arrives. mergeTranscriptMessages
  // makes an unchanged poll a no-op state write: identical content returns the
  // previous array reference, React bails out, and nothing re-renders, so the
  // view stays still and unread rows are never re-highlighted.
  useEffect(() => {
    if (!reader.open || !active) return;
    let alive = true;
    const timer = window.setInterval(() => {
      refresh();
      void window.aiTerminal.getTerminalTranscript(terminalId).then((result: TerminalTranscript) => {
        if (!alive) return;
        setMessages((previous) => mergeTranscriptMessages(previous, result.messages));
        setStatus(result.status === "ready" || result.status === "empty" ? result.status : (result.status ?? "empty"));
      }).catch(() => {
        // Background refresh failure: keep the old content on screen.
      });
    }, tone === "working" ? 2000 : 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [active, reader.open, refresh, terminalId, tone]);

  // Busy→ready flip: one final refresh, then flash "✓ 完成" and (via
  // highlightLastAssistant) mark the newest assistant message. Attention
  // (waiting for input) does not flash; polling starts/stops via the
  // polling effect's `tone` dependency.
  useEffect(() => {
    const prev = toneRef.current;
    toneRef.current = tone;
    if (!reader.open || !active) return;
    if (prev === "working" && tone === "ready") {
      refresh();
      void window.aiTerminal.getTerminalTranscript(terminalId).then((result: TerminalTranscript) => {
        setMessages((previous) => mergeTranscriptMessages(previous, result.messages));
        setStatus(result.status === "ready" || result.status === "empty" ? result.status : (result.status ?? "empty"));
      }).catch(() => {
        // Keep the last polled content on a failed final refresh.
      });
      setDoneFlash(true);
    }
  }, [active, refresh, reader.open, terminalId, tone]);
  const doneFlashTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!doneFlash) return;
    if (doneFlashTimerRef.current !== null) window.clearTimeout(doneFlashTimerRef.current);
    doneFlashTimerRef.current = window.setTimeout(() => setDoneFlash(false), 4000);
    return () => {
      if (doneFlashTimerRef.current !== null) {
        window.clearTimeout(doneFlashTimerRef.current);
        doneFlashTimerRef.current = null;
      }
    };
  }, [doneFlash]);

  // Elapsed seconds for the 運作中 strip — one tick per second while the
  // agent works and the reader is open. The reset branch only clears the ref:
  // the strip shows elapsed only under the working tone, and every new run
  // re-zeros it via update() right after start (no setState in an effect body).
  useEffect(() => {
    if (!reader.open || !active || tone !== "working") {
      runStartRef.current = null;
      return;
    }
    if (runStartRef.current === null) runStartRef.current = Date.now();
    const update = (): void => {
      if (runStartRef.current !== null) setElapsedSeconds(Math.floor((Date.now() - runStartRef.current) / 1000));
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [active, reader.open, tone]);

  const measureTurnTicks = useCallback((): void => {
    const rootEl = searchOverlayRef.current;
    if (!rootEl) return;
    const scroller = rootEl.querySelector<HTMLElement>(".terminal-reader-scroll");
    if (!scroller) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const nodes = scroller.querySelectorAll<HTMLElement>("[data-turn-anchor]");
    const entries: TurnTickInput[] = [];
    nodes.forEach((node) => {
      const index = Number(node.dataset.turnAnchor);
      if (!Number.isInteger(index) || index < 0) return;
      entries.push({ index, offset: node.getBoundingClientRect().top - scrollerRect.top + scroller.scrollTop });
    });
    // Merge ticks closer than one thumb-sized hit area (28px in rail space).
    const next = layoutTurnTicks(
      entries,
      scroller.scrollHeight,
      scroller.clientHeight,
      Math.max(TURN_RAIL_MIN_GAP, TURN_RAIL_MIN_HIT_PX / Math.max(1, scroller.clientHeight)),
    );
    if (!ticksEqual(turnTicksRef.current, next)) {
      turnTicksRef.current = next;
      setTurnTicks(next);
    }
  }, []);

  // Re-measure after content/font changes land in the DOM.
  useEffect(() => {
    if (!reader.open || !active || status !== "ready") return;
    queueMicrotask(measureTurnTicks);
  }, [active, measureTurnTicks, messages, reader.fontSize, reader.open, status]);

  // The scroller's own border-box is flex-fixed, so content growth only
  // resizes the inner container — observe BOTH.
  useEffect(() => {
    if (!reader.open || !active) return;
    const rootEl = searchOverlayRef.current;
    if (!rootEl) return;
    const scroller = rootEl.querySelector<HTMLElement>(".terminal-reader-scroll");
    if (!scroller) return;
    const content = scroller.querySelector<HTMLElement>(".terminal-reader-conversation");
    const observer = new ResizeObserver(() => {
      queueMicrotask(measureTurnTicks);
    });
    observer.observe(scroller);
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [active, measureTurnTicks, reader.open]);

  const jumpToBottom = useCallback((): void => {
    const rootEl = searchOverlayRef.current;
    if (!rootEl) return;
    const scroller = rootEl.querySelector<HTMLElement>(".terminal-reader-scroll");
    if (!scroller) return;
    stickToBottomRef.current = true;
    setHasNewMessages(false);
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  }, []);

  const jumpToTick = useCallback((tick: TurnTick): void => {
    const rootEl = searchOverlayRef.current;
    if (!rootEl) return;
    const scroller = rootEl.querySelector<HTMLElement>(".terminal-reader-scroll");
    if (!scroller) return;
    // Re-measure at tap time — content may have moved since the last layout.
    const node = scroller.querySelector<HTMLElement>(`[data-turn-anchor="${tick.firstIndex}"]`);
    let top: number;
    if (node) {
      top = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    } else {
      top = tick.pos * Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    }
    const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    stickToBottomRef.current = false;
    setNearBottom(true);
    scroller.scrollTo({ top: Math.min(top, maxScroll), behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (!reader.open || !active) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setStatus("loading");
      // Capture this PTY's own renderer snapshot as the copy-all fallback
      // payload; the view itself always renders the transcript conversation.
      refresh();
    });
    void window.aiTerminal.getTerminalTranscript(terminalId).then((result: TerminalTranscript) => {
      if (cancelled) return;
      setMessages((previous) => mergeTranscriptMessages(previous, result.messages));
      setStatus(result.status === "ready" || result.status === "empty" ? result.status : (result.status ?? "empty"));
    }).catch(() => {
      if (!cancelled) setStatus("error");
    });
    return () => { cancelled = true; };
  }, [active, refresh, refreshGeneration, reader.open, terminalId]);

  // Phone: two-finger pinch sets the reader font size; text reflows to fit.
  // Non-passive touchmove so the browser never page-zooms underneath.
  useEffect(() => {
    const root = searchOverlayRef.current;
    if (!isPhone || !reader.open || !active || !root) return;
    let start: { distance: number; font: number } | null = null;
    const spread = (touches: TouchList): number => {
      const a = touches[0];
      const b = touches[1];
      return a && b ? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) : 0;
    };
    const onStart = (event: TouchEvent): void => {
      if (event.touches.length === 2) start = { distance: spread(event.touches), font: terminalReaderController.get(terminalId).fontSize };
    };
    const onMove = (event: TouchEvent): void => {
      if (!start || event.touches.length !== 2) return;
      event.preventDefault();
      terminalReaderController.setFont(terminalId, pinchReaderFontSize(start.font, start.distance, spread(event.touches)));
    };
    const onEnd = (event: TouchEvent): void => {
      if (event.touches.length < 2) start = null;
    };
    root.addEventListener("touchstart", onStart, { passive: true });
    root.addEventListener("touchmove", onMove, { passive: false });
    root.addEventListener("touchend", onEnd, { passive: true });
    root.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      root.removeEventListener("touchstart", onStart);
      root.removeEventListener("touchmove", onMove);
      root.removeEventListener("touchend", onEnd);
      root.removeEventListener("touchcancel", onEnd);
    };
  }, [active, isPhone, reader.open, terminalId]);

  if (!reader.open || !active) return null;
  const statusText = STATUS_LABELS[status];
  const composerHasDraft = composerDraft.trim().length > 0;
  const liveStatusText = composerSent && !pasted?.entered ? "✓ 已貼入，尚未送出" : doneFlash ? "✓ 完成" : tone === "working" ? `● 運作中…${elapsedSeconds > 0 ? ` ${elapsedSeconds}s` : ""}` : tone === "attention" ? "⚠ 等你回覆" : null;
  return (
    <div data-action-id="terminal.clean-view.consume" data-action-trigger="pointerdown" className="terminal-reader-overlay" role="dialog" aria-label="Terminal reader" style={{ fontSize: `${reader.fontSize}px` }} onPointerDown={(event) => event.stopPropagation()} ref={searchOverlayRef}>
      {liveStatusText && (
        <div className="terminal-reader-livestatus" data-tone={doneFlash ? "ready" : tone} role="status">{liveStatusText}</div>
      )}
      <div className="terminal-reader-toolbar" role="toolbar">
        {/* 關閉 sits at the far LEFT: at the far right it landed under the
            pane's close X on phones and one mis-tap killed the session. */}
        <button data-action-id="terminal.reader.close" type="button" className="terminal-reader-close" aria-label="關閉閱讀器" onClick={() => terminalReaderController.close(terminalId)}>← 返回</button>
        <button
          data-action-id="terminal.reader.copy-all"
          type="button"
          aria-label={copyAllState === "error" ? "複製失敗" : "複製全部"}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={handleCopyAll}
        >
          <span className="terminal-reader-copy-label">
            {copyAllState === "ok" ? <CheckIcon size={14} aria-hidden /> : <CopyIcon size={14} aria-hidden />}
            {copyAllState === "ok" ? "已複製" : copyAllState === "error" ? "複製失敗" : "複製全部"}
          </span>
        </button>
        {/* Phone resizes text with a two-finger pinch instead (see the pinch effect). */}
        {!isPhone && (
          <>
            <button data-action-id="terminal.reader.font.decrease" type="button" aria-label="縮小字體" onClick={() => terminalReaderController.stepFont(terminalId, -1)}>A−</button>
            <button data-action-id="terminal.reader.font.increase" type="button" aria-label="放大字體" onClick={() => terminalReaderController.stepFont(terminalId, 1)}>A+</button>
          </>
        )}
        {!isPhone && (
          <button data-action-id="terminal.reader.font.reset" type="button" aria-label="重設字體" onClick={() => terminalReaderController.resetFont(terminalId)}>重設</button>
        )}
        <button data-action-id="terminal.reader.search.open" type="button" aria-label={t("reader.search.placeholder")} onClick={openSearch}><SearchIcon size={16} /></button>
        {!isPhone && (
          <button data-action-id="terminal.reader.refresh" type="button" aria-label="重新整理" onClick={() => { refresh(); if (status !== "ready") setStatus("loading"); setRefreshGeneration((value) => value + 1); }}>重新整理</button>
        )}

      </div>
      {searchOpen && (
        <div className="terminal-reader-search" role="search" aria-label={t("reader.search.results.aria")}>
          <input
            data-action-id="terminal.reader.search.input"
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            placeholder={t("reader.search.placeholder")}
            aria-label={t("reader.search.placeholder")}
            onChange={(event) => handleSearchQueryChange(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.nativeEvent.isComposing) return;
              const action = resolveSearchInputAction(event);
              if (action?.kind === "close") {
                event.preventDefault();
                closeSearch();
              } else if (action?.kind === "search") {
                event.preventDefault();
                navigateHits(action.direction);
              }
            }}
          />
          {searchQuery ? (hitOffsets.length === 0 ? <span className="terminal-reader-search-nomatch">{t("dock.search.noResult")}</span> : <span className="terminal-reader-search-count">{clampActiveHit(activeHit, hitOffsets.length) + 1}/{hitOffsets.length}{hitOffsets.length >= READER_SEARCH_MAX_HITS ? "+" : ""}</span>) : null}
          <button data-action-id="terminal.reader.search.previous" type="button" aria-label={t("dock.search.previous")} disabled={hitOffsets.length === 0} onClick={() => navigateHits("previous")}>▲</button>
          <button data-action-id="terminal.reader.search.next" type="button" aria-label={t("dock.search.next")} disabled={hitOffsets.length === 0} onClick={() => navigateHits("next")}>▼</button>
          <button data-action-id="terminal.reader.search.close" type="button" aria-label={t("dock.search.close")} onClick={closeSearch}><XIcon size={16} /></button>
        </div>
      )}
      <div className="terminal-reader-scroll">
        {status === "ready" ? (
          <ConversationReader messages={shownMessages ?? []} emptyLabel={t("dock.cleanView.empty")} highlightLastAssistant={doneFlash} />
        ) : (
          <div className="terminal-reader-status-block">
            <p className="terminal-reader-status" role="status">{statusText ?? "Reader 狀態未知。"}</p>
          </div>
        )}
        {isPhone && pasted && !(pasted.entered && (shownMessages ?? []).some((message) => message.role === "user" && message.text.trim() === pasted.text.trim())) && (
          <article className="terminal-reader-message terminal-reader-user terminal-reader-local-input">
            <div className="terminal-reader-message-label" role="status">{pasted.entered ? "你 · 已按 ENTER，等待紀錄" : "你 · 已貼入，尚未送出"}</div>
            <p className="terminal-reader-message-text">{pasted.text}</p>
          </article>
        )}
      </div>
      {isPhone && (
        <div
          data-action-id="terminal.reader.mobile.composer.consume"
          data-action-trigger="pointerdown"
          className="terminal-reader-composer"
          data-agent-running={tone === "working" ? "true" : undefined}
          ref={composerPanelRef}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {/* Shared composer contract (also wired by MobileCommandComposer):
              controlled value = controller draft; composition state feeds the
              controller, never React state; input events are the ONLY text
              writer (iPhone dictation revises via insertReplacementText),
              keydown never supplies text; keystrokes stopPropagation before
              reader/terminal shortcuts. */}
          <textarea
            data-action-id="terminal.reader.mobile.input"
            ref={composerTextareaRef}
            rows={1}
            value={composerDraft}
            placeholder={composerError ?? t("reader.composer.placeholder")}
            aria-label={t("reader.composer.placeholder")}
            inputMode="text"
            enterKeyHint="enter"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => mobileInputController.setDraft(terminalId, event.target.value)}
            onCompositionStart={() => mobileInputController.setComposition(true)}
            onCompositionEnd={() => mobileInputController.setComposition(false)}
            onBlur={notifyComposerBlur}
            onKeyDown={(event) => {
              event.stopPropagation();
            }}
          />
          <button
            data-action-id="terminal.reader.mobile.send"
            type="button"
            disabled={!composerHasDraft}
            aria-label="貼入文字，按右上角 ENTER 才送出"
            onClick={() => submitComposer(true)}
          >
            貼入
          </button>
        </div>
      )}
      {!nearBottom && (
        <button type="button" data-action-id="terminal.reader.jump-bottom" className="terminal-reader-jump" aria-label="跳到最新訊息" onPointerDown={(event) => event.stopPropagation()} onClick={jumpToBottom}>{hasNewMessages ? "新訊息 ↓" : "回到最新 ↓"}</button>
      )}
      {status === "ready" && turnTicks.length > 0 && (
        <div className="terminal-reader-turnrail" role="navigation" aria-label="訊息快速跳轉">
          {turnTicks.map((tick, tickIndex) => (
            <button
              key={tick.firstIndex}
              type="button"
              data-action-id="terminal.reader.turn-tick"
              className={activeTick === tickIndex ? "terminal-reader-turnrail-tick active" : "terminal-reader-turnrail-tick"}
              style={{ top: `${tick.pos * 100}%` }}
              aria-label={`跳到第 ${tick.firstIndex + 1} 則訊息`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => jumpToTick(tick)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
