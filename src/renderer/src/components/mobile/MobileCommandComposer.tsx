import { createPortal } from "react-dom";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAppStore } from "../../store/app-store";
import { useI18n } from "../../i18n";
import { calculateComposerGeometry, readComposerViewport, type ComposerGeometry } from "./mobile-composer-geometry";
import { useComposerFocusOwnership } from "./use-composer-focus";
import { forceResolveCompositionForSend } from "./mobile-composer-submit";
import { mobileInputController } from "./mobile-input-controller";
import { writeMobileInputMode } from "./mobile-input-mode";

export function MobileCommandComposer(): React.JSX.Element | null {
  const { t } = useI18n();
  const snapshot = useSyncExternalStore(mobileInputController.subscribe, mobileInputController.getSnapshot, mobileInputController.getSnapshot);
  const selectedTerminalId = useAppStore((state) => state.dockLayout.selectedTerminalId);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // ponytail: 同步初始化 geometry——原本 null 時整個元件 return null，textarea 根本還沒
  // mount，focus 重試 rAF 就把機會用完了；而且 iOS Safari 只在 user gesture 的同一個
  // task 內接受程式化 focus 彈鍵盤，geometry 進 state 已離開手勢視窗。同步算出來才能在
  // open 的同一個 render 就 mount textarea 並 autoFocus。
  const [geometry, setGeometry] = useState<ComposerGeometry>(() => calculateComposerGeometry(readComposerViewport(), window.innerHeight));
  const state = snapshot.state;
  // The phone reader drives this same controller with reason "reader" and
  // renders its OWN inline input; this floating composer stands down entirely
  // (no portal, no geometry, no focus ownership) while that reason is active.
  const open = state.status !== "closed" && state.reason !== "reader";
  const terminalId = open ? state.terminalId : null;
  const draft = terminalId ? snapshot.draftsByTerminal[terminalId] ?? "" : "";
  const lineCount = draft.length === 0 ? 0 : draft.split(/\r\n|\r|\n/).length;
  const openingGeneration = state.status === "opening" ? state.generation : null;

  useEffect(() => {
    if (open && selectedTerminalId && selectedTerminalId !== terminalId) mobileInputController.close("terminal-switch");
  }, [open, selectedTerminalId, terminalId]);

  useEffect(() => {
    if (!open || !terminalId) {
      if (document.body.dataset.cotermInputOwner === "mobile-composer") delete document.body.dataset.cotermInputOwner;
      return;
    }
    document.body.dataset.cotermInputOwner = "mobile-composer";
    const update = (): void => {
      // IME candidate-bar height changes fire visualViewport resize during
      // composition. Re-rendering the controlled textarea mid-composition
      // interrupts the IME and drops focus, so skip geometry updates while
      // composing — the layout catches up on the next resize after compositionend.
      if (mobileInputController.isComposing()) return;
      setGeometry(calculateComposerGeometry(readComposerViewport(), window.innerHeight));
    };
    update();
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      if (document.body.dataset.cotermInputOwner === "mobile-composer") delete document.body.dataset.cotermInputOwner;
    };
  }, [open, terminalId]);

  // The composer overlays the PTY. Publish its measured height as a CSS var so
  // the remote terminal host can pad its scroll area by exactly that much — the
  // newest agent output then sits ABOVE the composer instead of behind it, and
  // the exposed area stays a normal scrollable div (free swiping while typing).
  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) {
      document.body.style.removeProperty("--coterm-composer-height");
      return;
    }
    const publish = (): void => {
      document.body.style.setProperty("--coterm-composer-height", `${Math.ceil(panel.getBoundingClientRect().height)}px`);
      window.dispatchEvent(new CustomEvent("coterm:composer-layout"));
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(panel);
    return () => {
      observer.disconnect();
      document.body.style.removeProperty("--coterm-composer-height");
    };
  }, [open, terminalId, geometry.maxHeight]);

  // Focus ownership (initial autofocus + blur-reclaim ladder + keyboard-drop
  // rebind) is shared with the reader's inline input — use-composer-focus.ts.
  const { notifyComposerBlur } = useComposerFocusOwnership({
    open,
    terminalId,
    panelRef,
    textareaRef,
    openingGeneration,
    focusOnOpen: true,
  });

  if (!open || !terminalId) return null;
  const style = {
    left: `${geometry.left}px`,
    top: `${geometry.top}px`,
    width: `${geometry.width}px`,
    maxHeight: `${geometry.maxHeight}px`,
  };
  const submit = (fromSendButton = false): void => {
    // iPhone dictation (and some IMEs) leave the text "marked" — still an open
    // composition — long after you stop talking, and submit() refuses while
    // composing, so a send tap silently did nothing (2026-10-06: long dictated
    // sentences "never printed"). A send tap is explicit: take the textarea's
    // current text as final and send it.
    const textarea = textareaRef.current;
    // Keyboard Ctrl+Enter keeps the composition guard (Enter may be picking an
    // IME candidate); only the send button forces.
    if (fromSendButton && textarea) {
      forceResolveCompositionForSend(terminalId, textarea.value);
    }
    void mobileInputController.submit((input) => window.aiTerminal.writeTerminal(input));
  };
  const content = (
    <div
      ref={panelRef}
      data-action-id="topbar.mobile.paste-fallback.consume"
      data-action-trigger="pointerdown"
      className="mobile-command-composer"
      role="dialog"
      aria-label={t("topbar.input.aria")}
      style={style}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {/* ponytail: the hint paragraph is gone — it cost 2-3 lines of screen that
          the user needs for reading the PTY while typing. */}
      {/* Shared composer contract (also wired by the reader's inline input):
          controlled value = controller draft; composition state feeds the
          controller, never React state; input events are the ONLY text writer
          (iPhone dictation revises via insertReplacementText), keydown never
          supplies text; keystrokes stopPropagation before terminal shortcuts. */}
      <textarea
        data-action-id="topbar.mobile.paste-fallback.textarea"
        ref={textareaRef}
        className="mobile-command-composer-input"
        placeholder={t("topbar.input.placeholder")}
        aria-label={t("topbar.input.placeholder")}
        rows={2}
        inputMode="text"
        enterKeyHint="enter"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        autoFocus
        value={draft}
        onChange={(event) => mobileInputController.setDraft(terminalId, event.target.value)}
        onCompositionStart={() => mobileInputController.setComposition(true)}
        onCompositionEnd={() => mobileInputController.setComposition(false)}
        onBlur={notifyComposerBlur}
        onKeyDown={(event) => {
          event.stopPropagation();
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            submit();
          }
        }}
      />
      {lineCount > 1 && <p className="mobile-paste-fallback-warn" aria-live="polite">{lineCount}</p>}
      {snapshot.error && <p className="mobile-command-composer-error" role="alert">{snapshot.error}</p>}
      <div className="mobile-command-composer-actions">
        <span className="mobile-command-composer-toggle">貼入後，按右上角 ENTER 送出</span>
        <button data-action-id="topbar.mobile.composer.use-native" type="button" className="mobile-dock-btn mobile-command-composer-btn" onClick={() => { writeMobileInputMode("direct"); mobileInputController.close("cancel"); window.dispatchEvent(new CustomEvent("coterm:focus-pty", { detail: { terminalId } })); }}>{t("topbar.input.useNative")}</button>
        <button data-action-id="topbar.mobile.paste-fallback.cancel" type="button" className="mobile-dock-btn mobile-command-composer-btn" onClick={() => mobileInputController.close("cancel")}>{t("topbar.input.cancel")}</button>
        <button data-action-id="topbar.mobile.paste-fallback.confirm" type="button" className="mobile-dock-btn mobile-command-composer-btn mobile-command-composer-confirm" onClick={() => submit(true)} disabled={!draft || state.status === "submitting"}>貼入</button>
      </div>
    </div>
  );
  return createPortal(content, document.body);
}
