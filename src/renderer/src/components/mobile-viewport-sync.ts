// Phase 8 (#52): mobile viewport height sync, extracted from App.tsx so the
// production effect is unit-testable with injected seams.
//
// The app shell reads --app-visual-viewport-height for its mobile height. This
// module is the ONLY writer, and it never guesses: it publishes the real
// VisualViewport height (window.innerHeight fallback when visualViewport is
// absent), re-syncing on keyboard open/close, rotation, PWA/browser chrome
// changes (window resize + container ResizeObserver — some UAs fire neither
// visualViewport nor resize when e.g. the URL bar collapses) and visualViewport
// resize/scroll. Fixed keyboard ratios are never used.
//
// Zoom guard: an Android "force allow zoom" setting can ignore
// user-scalable=no. A zoomed (scale !== 1) visual viewport reports a height
// that is NOT the usable layout height — writing it would shrink the whole
// shell (#31/#52). We hold the last good value and retry briefly, because
// keyboard-close events can arrive while the scale is still > 1.

export interface MobileViewportLike {
  readonly height: number;
  readonly scale: number;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface MobileMediaQueryLike {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

export interface MobileWindowLike {
  innerHeight: number;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  requestAnimationFrame(callback: () => void): number;
  cancelAnimationFrame(handle: number): void;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

export interface MobileViewportSyncDeps {
  /** Shell root style target; defaults to document.documentElement. */
  root: { style: Pick<CSSStyleDeclaration, "setProperty" | "removeProperty"> };
  media: MobileMediaQueryLike;
  win: MobileWindowLike;
  /** null when the UA lacks VisualViewport (older desktop webviews). */
  viewport: MobileViewportLike | null;
  /** Observed via ResizeObserver (chrome/PWA chrome changes that fire neither
     visualViewport nor window resize). Optional — skipped when the observer
     API or the element is unavailable. */
  container?: Element | null;
  resizeObserverCtor?: typeof ResizeObserver | null;
  onOrientationChange?: () => void;
}

export const APP_VISUAL_VIEWPORT_HEIGHT_VAR = "--app-visual-viewport-height";
// Scale tolerance: float rounding around 1 must not freeze the shell.
const SCALE_EPSILON = 0.01;
const SCALE_RETRY_WINDOW_MS = 2000;
const SCALE_RETRY_STEP_MS = 100;

export function installMobileViewportSync(deps: MobileViewportSyncDeps): () => void {
  const { root, media, win, viewport } = deps;
  let frame: number | null = null;
  let retry: number | null = null;
  let retryUntil = 0;
  const stopRetry = (): void => {
    if (retry !== null) {
      win.clearTimeout(retry);
      retry = null;
    }
  };
  const syncHeight = (): void => {
    if (frame !== null) win.cancelAnimationFrame(frame);
    frame = win.requestAnimationFrame(() => {
      frame = null;
      if (!media.matches) {
        stopRetry();
        retryUntil = 0;
        root.style.removeProperty(APP_VISUAL_VIEWPORT_HEIGHT_VAR);
        return;
      }
      const scale = viewport?.scale ?? 1;
      if (Math.abs(scale - 1) > SCALE_EPSILON) {
        if (retryUntil === 0) retryUntil = Date.now() + SCALE_RETRY_WINDOW_MS;
        if (Date.now() < retryUntil && retry === null) {
          retry = win.setTimeout(() => {
            retry = null;
            syncHeight();
          }, SCALE_RETRY_STEP_MS);
        }
        return;
      }
      retryUntil = 0;
      stopRetry();
      const height = Math.max(1, Math.round(viewport?.height ?? win.innerHeight));
      root.style.setProperty(APP_VISUAL_VIEWPORT_HEIGHT_VAR, `${height}px`);
    });
  };
  syncHeight();
  media.addEventListener("change", syncHeight);
  win.addEventListener("resize", syncHeight);
  const onOrientationChange = (): void => {
    syncHeight();
    deps.onOrientationChange?.();
  };
  win.addEventListener("orientationchange", onOrientationChange);
  viewport?.addEventListener("resize", syncHeight);
  viewport?.addEventListener("scroll", syncHeight);
  let observer: ResizeObserver | null = null;
  const ResizeObserverCtor = deps.resizeObserverCtor
    ?? (typeof ResizeObserver === "undefined" ? null : ResizeObserver);
  if (ResizeObserverCtor && deps.container) {
    observer = new ResizeObserverCtor(() => syncHeight());
    observer.observe(deps.container);
  }
  return () => {
    if (frame !== null) win.cancelAnimationFrame(frame);
    stopRetry();
    observer?.disconnect();
    media.removeEventListener("change", syncHeight);
    win.removeEventListener("resize", syncHeight);
    win.removeEventListener("orientationchange", onOrientationChange);
    viewport?.removeEventListener("resize", syncHeight);
    viewport?.removeEventListener("scroll", syncHeight);
    root.style.removeProperty(APP_VISUAL_VIEWPORT_HEIGHT_VAR);
  };
}
