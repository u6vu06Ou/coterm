import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APP_VISUAL_VIEWPORT_HEIGHT_VAR,
  installMobileViewportSync,
  type MobileMediaQueryLike,
  type MobileViewportLike,
  type MobileWindowLike,
} from "../../src/renderer/src/components/mobile-viewport-sync";

type Listener = () => void;

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    const current = this.listeners.get(type) ?? new Set<Listener>();
    current.add(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class FakeWindow extends FakeEventTarget implements MobileWindowLike {
  innerHeight = 844;
  private nextFrame = 1;
  private readonly frames = new Map<number, () => void>();

  requestAnimationFrame(callback: () => void): number {
    const handle = this.nextFrame++;
    this.frames.set(handle, callback);
    return handle;
  }

  cancelAnimationFrame(handle: number): void {
    this.frames.delete(handle);
  }

  setTimeout(callback: () => void, ms: number): number {
    return globalThis.setTimeout(callback, ms) as unknown as number;
  }

  clearTimeout(handle: number): void {
    globalThis.clearTimeout(handle);
  }

  flushAnimationFrames(): void {
    const pending = [...this.frames.values()];
    this.frames.clear();
    for (const callback of pending) callback();
  }
}

class FakeViewport extends FakeEventTarget implements MobileViewportLike {
  constructor(public height: number, public scale = 1) {
    super();
  }
}

class FakeMedia extends FakeEventTarget implements MobileMediaQueryLike {
  constructor(public matches: boolean) {
    super();
  }

  override addEventListener(type: "change", listener: Listener): void {
    super.addEventListener(type, listener);
  }

  override removeEventListener(type: "change", listener: Listener): void {
    super.removeEventListener(type, listener);
  }
}

class FakeResizeObserver {
  static latest: FakeResizeObserver | null = null;
  readonly observe = vi.fn();
  readonly disconnect = vi.fn();

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.latest = this;
  }

  emit(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function createRoot(): {
  values: Map<string, string>;
  root: { style: Pick<CSSStyleDeclaration, "setProperty" | "removeProperty"> };
} {
  const values = new Map<string, string>();
  return {
    values,
    root: {
      style: {
        setProperty: (name, value) => { values.set(name, value ?? ""); },
        removeProperty: (name) => {
          const previous = values.get(name) ?? "";
          values.delete(name);
          return previous;
        },
      },
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  FakeResizeObserver.latest = null;
});

describe("installMobileViewportSync (#52)", () => {
  it("tracks initial, keyboard-open, keyboard-close, scroll, and orientation heights", () => {
    const win = new FakeWindow();
    const viewport = new FakeViewport(844);
    const media = new FakeMedia(true);
    const { root, values } = createRoot();
    const onOrientationChange = vi.fn();
    const cleanup = installMobileViewportSync({ root, win, viewport, media, onOrientationChange });

    win.flushAnimationFrames();
    expect(values.get(APP_VISUAL_VIEWPORT_HEIGHT_VAR)).toBe("844px");

    viewport.height = 492;
    viewport.emit("resize");
    win.flushAnimationFrames();
    expect(values.get(APP_VISUAL_VIEWPORT_HEIGHT_VAR)).toBe("492px");

    viewport.height = 844;
    viewport.emit("scroll");
    win.flushAnimationFrames();
    expect(values.get(APP_VISUAL_VIEWPORT_HEIGHT_VAR)).toBe("844px");

    viewport.height = 390;
    win.emit("orientationchange");
    win.flushAnimationFrames();
    expect(values.get(APP_VISUAL_VIEWPORT_HEIGHT_VAR)).toBe("390px");
    expect(onOrientationChange).toHaveBeenCalledOnce();
    cleanup();
  });

  it("uses innerHeight without VisualViewport and re-syncs from container ResizeObserver", () => {
    const win = new FakeWindow();
    const media = new FakeMedia(true);
    const { root, values } = createRoot();
    const container = {} as Element;
    const cleanup = installMobileViewportSync({
      root,
      win,
      viewport: null,
      media,
      container,
      resizeObserverCtor: FakeResizeObserver as unknown as typeof ResizeObserver,
    });

    win.flushAnimationFrames();
    expect(values.get(APP_VISUAL_VIEWPORT_HEIGHT_VAR)).toBe("844px");
    expect(FakeResizeObserver.latest?.observe).toHaveBeenCalledWith(container);

    win.innerHeight = 700;
    FakeResizeObserver.latest?.emit();
    win.flushAnimationFrames();
    expect(values.get(APP_VISUAL_VIEWPORT_HEIGHT_VAR)).toBe("700px");

    cleanup();
    expect(FakeResizeObserver.latest?.disconnect).toHaveBeenCalledOnce();
  });

  it("holds the last usable height while pinch zoom is active, then retries", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T00:00:00Z"));
    const win = new FakeWindow();
    const viewport = new FakeViewport(844);
    const media = new FakeMedia(true);
    const { root, values } = createRoot();
    const cleanup = installMobileViewportSync({ root, win, viewport, media });
    win.flushAnimationFrames();

    viewport.height = 422;
    viewport.scale = 2;
    viewport.emit("resize");
    win.flushAnimationFrames();
    expect(values.get(APP_VISUAL_VIEWPORT_HEIGHT_VAR)).toBe("844px");

    viewport.height = 600;
    viewport.scale = 1;
    vi.advanceTimersByTime(100);
    win.flushAnimationFrames();
    expect(values.get(APP_VISUAL_VIEWPORT_HEIGHT_VAR)).toBe("600px");
    cleanup();
  });

  it("removes the mobile height and every listener on desktop or cleanup", () => {
    const win = new FakeWindow();
    const viewport = new FakeViewport(844);
    const media = new FakeMedia(true);
    const { root, values } = createRoot();
    const cleanup = installMobileViewportSync({ root, win, viewport, media });
    win.flushAnimationFrames();

    media.matches = false;
    media.emit("change");
    win.flushAnimationFrames();
    expect(values.has(APP_VISUAL_VIEWPORT_HEIGHT_VAR)).toBe(false);

    cleanup();
    expect(win.listenerCount("resize")).toBe(0);
    expect(win.listenerCount("orientationchange")).toBe(0);
    expect(viewport.listenerCount("resize")).toBe(0);
    expect(viewport.listenerCount("scroll")).toBe(0);
    expect(media.listenerCount("change")).toBe(0);
  });
});
