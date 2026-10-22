import { useCallback, useEffect, useRef, useState } from "react";
import { Scan, Shield, ShieldOff, ZoomIn } from "lucide-react";
import type { ArtifactViewerProps } from "../registry";
import { OpenExternalButton } from "./OpenExternalButton";

export function HtmlViewer({ preview, projectId, path }: ArtifactViewerProps): React.JSX.Element | null {
  // Live mode is the default whenever the main process handed us a preview URL: serving the file
  // over loopback http is the only way its scripts and relative assets actually work. Safe mode is
  // the old sandbox srcDoc viewer, kept for HTML whose source you do not trust.
  const [safeMode, setSafeMode] = useState(false);
  // Fit mode (default): the page is scaled down so the whole document is visible at once.
  // Off = actual size (100%) with normal in-frame scrolling.
  const [fitMode, setFitMode] = useState(true);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // Mirror fitMode into a ref: the ResizeObserver closure must see the current mode
  // without being torn down and recreated on every toggle.
  const fitModeRef = useRef(fitMode);
  useEffect(() => { fitModeRef.current = fitMode; }, [fitMode]);

  // The fill layout comes from CSS (.html-viewer-frame-box > iframe is 100% x 100%).
  // Fit mode only adds an inline size + scale transform, so "off" just clears it.
  const applyFit = useCallback(() => {
    const box = boxRef.current;
    const frame = frameRef.current;
    if (!box || !frame) return;
    const clear = (): void => {
      frame.style.width = "";
      frame.style.height = "";
      frame.style.transform = "";
    };
    if (!fitModeRef.current) { clear(); return; }
    const boxW = box.clientWidth;
    const boxH = box.clientHeight;
    if (boxW <= 0 || boxH <= 0) return;
    // Same-origin / allow-same-origin srcdoc pages are measurable. The live
    // http://127.0.0.1 preview is cross-origin from the renderer (file:// in prod),
    // so contentDocument is unreachable — then filling the panel IS the fit.
    let doc: Document | null;
    try { doc = frame.contentDocument; } catch { doc = null; }
    const root = doc?.documentElement ?? null;
    if (!doc || !root) { clear(); return; }
    const pageW = Math.max(1, root.scrollWidth, doc.body?.scrollWidth ?? 0);
    const pageH = Math.max(1, root.scrollHeight, doc.body?.scrollHeight ?? 0);
    const scale = Math.min(1, boxW / pageW, boxH / pageH);
    if (scale >= 0.999) { clear(); return; }
    frame.style.width = `${Math.ceil(boxW / scale)}px`;
    frame.style.height = `${Math.ceil(boxH / scale)}px`;
    frame.style.transform = `scale(${scale})`;
  }, []);

  // Re-fit whenever the artifact panel is resized (the resizer drags the wrap width).
  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => applyFit());
    observer.observe(box);
    return () => observer.disconnect();
  }, [applyFit]);

  // Mode flips and document swaps re-fit immediately; iframe onLoad covers content
  // after navigation, and the delayed second pass catches late-loading images.
  useEffect(() => { applyFit(); }, [applyFit, fitMode, safeMode, preview]);

  if (preview.kind !== "html") return null;
  const previewUrl = preview.previewUrl;
  const live = previewUrl !== undefined && !safeMode;
  const refit = (): void => {
    applyFit();
    window.setTimeout(applyFit, 300);
  };
  return (
    <div className="html-viewer-wrap">
      <div className="html-viewer-toolbar">
        {previewUrl !== undefined && (
          <button
            data-action-id="artifact.html.safeMode"
            className="icon-button"
            title={safeMode ? "Safe preview (scripts blocked)" : "Live preview (scripts run)"}
            aria-pressed={safeMode}
            onClick={() => setSafeMode((value) => !value)}
          >
            {safeMode ? <Shield size={16} /> : <ShieldOff size={16} />}
          </button>
        )}
        <button
          data-action-id="artifact.html.fitMode"
          className="icon-button"
          title={fitMode ? "Fit page to panel (whole page visible)" : "Actual size (100%), scroll inside the page"}
          aria-pressed={fitMode}
          onClick={() => setFitMode((value) => !value)}
        >
          {fitMode ? <Scan size={16} /> : <ZoomIn size={16} />}
        </button>
        <OpenExternalButton projectId={projectId} path={path} />
      </div>
      <div ref={boxRef} className="html-viewer-frame-box">
        {live
          ? <iframe ref={frameRef} title="HTML artifact" sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-scripts" src={previewUrl} onLoad={refit} />
          // The old sandbox="" also forced an opaque origin, which would block fit
          // measurement; allow-same-origin keeps scripts blocked (no allow-scripts,
          // plus the injected CSP) while letting the parent measure scrollWidth/Height.
          : <iframe ref={frameRef} title="HTML artifact" sandbox="allow-same-origin" srcDoc={sandboxedHtml(preview.text)} onLoad={refit} />}
      </div>
    </div>
  );
}

function sandboxedHtml(html: string): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:">`;
  if (/<head[\s>]/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${csp}`);
  return `<!doctype html><html><head>${csp}</head><body>${html}</body></html>`;
}
