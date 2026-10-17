import { ArrowLeft, ArrowRight, ExternalLink, LoaderCircle, RotateCcw, Square } from "lucide-react";
import { useRef, useState } from "react";
import type { ArtifactViewerProps } from "../registry";

export function BrowserViewer({ preview }: ArtifactViewerProps): React.JSX.Element | null {
  const browser = preview.kind === "browser" ? preview : null;
  const [url, setUrl] = useState(browser?.url ?? "");
  const [address, setAddress] = useState(browser?.url ?? "");
  const [history, setHistory] = useState<string[]>(browser ? [browser.url] : []);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  if (!browser) return null;
  const navigate = async (value: string, replace = false): Promise<void> => {
    setLoading(true);
    setError("");
    try {
      const previewResult = await window.aiTerminal.openBrowserArtifact({ url: value.trim() });
      if (previewResult.kind !== "browser") throw new Error("Invalid browser artifact response.");
      const nextHistory = replace ? history.slice(0, historyIndex + 1) : [...history.slice(0, historyIndex + 1), previewResult.url];
      setHistory(nextHistory);
      setHistoryIndex(nextHistory.length - 1);
      setUrl(previewResult.url);
      setAddress(previewResult.url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };
  const goHistory = (delta: number): void => {
    const next = historyIndex + delta;
    if (next < 0 || next >= history.length) return;
    setHistoryIndex(next);
    setUrl(history[next] ?? url);
    setAddress(history[next] ?? address);
  };
  return (
    <div className="browser-viewer">
      <div className="browser-toolbar">
        <button data-action-id="artifact.browser.back" title="Back" disabled={historyIndex === 0} onClick={() => goHistory(-1)}><ArrowLeft size={14} /></button>
        <button data-action-id="artifact.browser.forward" title="Forward" disabled={historyIndex >= history.length - 1} onClick={() => goHistory(1)}><ArrowRight size={14} /></button>
        <button data-action-id="artifact.browser.reload" title="Reload" onClick={() => { frameRef.current?.contentWindow?.location.reload(); }}><RotateCcw size={14} /></button>
        <button data-action-id="artifact.browser.stop" title="Stop loading" disabled={!loading} onClick={() => { setLoading(false); frameRef.current?.contentWindow?.stop(); }}><Square size={12} /></button>
        <form data-action-id="artifact.browser.navigate.submit" onSubmit={(event) => { event.preventDefault(); void navigate(address); }}>
          <input data-action-id="artifact.browser.address.change" aria-label="Browser address" value={address} onChange={(event) => setAddress(event.target.value)} />
        </form>
        <button data-action-id="artifact.browser.open-external" title="Open externally" onClick={() => window.open(url, "_blank", "noopener,noreferrer")}><ExternalLink size={14} /></button>
      </div>
      {error && <p className="browser-error">{error}</p>}
      <iframe ref={frameRef} className="browser-frame" title="Remote browser artifact" sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-scripts" src={url} onLoad={() => setLoading(false)} onError={() => { setLoading(false); setError("This website cannot be embedded. Use Open externally."); }} />
      {loading && <div className="browser-loading"><LoaderCircle size={15} /> Loading…</div>}
    </div>
  );
}
