import type { Terminal } from "@xterm/xterm";

/**
 * GPU 相關的跨視窗協調（xterm WebGL）。
 *
 * 1. 字形圖集（texture atlas）是「同字型同色票的視窗共用一張」。任何一個視窗
 *    呼叫 clearTextureAtlas() 會把共用那張清空重排，但其他視窗手上的格子快取
 *    還指著舊位置——沒有整屏重畫的視窗（Claude Code 的 logo、狀態列）就會變成
 *    別的字的碎片（2026-10-03 maintainer截圖的亂碼）。所以清圖集一律全部視窗一起清。
 * 2. WebglAddon.dispose() 不會歸還 WebGL context，要等 GC。Chromium 一頁最多同時
 *    16 個，PTY 重掛幾次就爆，爆了先殺最舊的（日月背景、最早開的 PTY）。
 *    所以拆掉時主動 loseContext 讓出名額。
 */

const liveTerminals = new Set<Terminal>();
let clearQueued = false;

export function trackTerminalForAtlas(terminal: Terminal): () => void {
  liveTerminals.add(terminal);
  return () => {
    liveTerminals.delete(terminal);
  };
}

/** 清共用字形圖集：同一個 microtask 內把所有活著的視窗一起清，下一幀全部整屏重畫。 */
export function clearSharedTextureAtlas(): void {
  if (clearQueued) return;
  clearQueued = true;
  queueMicrotask(() => {
    clearQueued = false;
    for (const terminal of liveTerminals) {
      try {
        terminal.clearTextureAtlas();
      } catch {
        // 正在拆的視窗：略過。
      }
    }
  });
}

/** 在 loadAddon(webgl) 前後各呼叫一次，找出 WebGL addon 新建的那張畫布。 */
export function snapshotCanvases(root: HTMLElement | undefined): Set<HTMLCanvasElement> {
  return new Set(root ? Array.from(root.querySelectorAll("canvas")) : []);
}

export function findNewCanvas(root: HTMLElement | undefined, before: Set<HTMLCanvasElement>): HTMLCanvasElement | null {
  if (!root) return null;
  for (const canvas of Array.from(root.querySelectorAll("canvas"))) {
    if (!before.has(canvas) && !canvas.classList.contains("xterm-link-layer")) return canvas;
  }
  return null;
}

/** 主動歸還 WebGL context（不等 GC）。對已經 lost 的 context 呼叫也無害。 */
export function releaseWebglCanvas(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return;
  try {
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (gl && !gl.isContextLost()) gl.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    // best effort
  }
}
