import { useState } from "react";
import { Shield, ShieldOff } from "lucide-react";
import type { ArtifactViewerProps } from "../registry";
import { OpenExternalButton } from "./OpenExternalButton";

export function HtmlViewer({ preview, projectId, path }: ArtifactViewerProps): React.JSX.Element | null {
  // Live mode is the default whenever the main process handed us a preview URL: serving the file
  // over loopback http is the only way its scripts and relative assets actually work. Safe mode is
  // the old sandbox="" srcDoc viewer, kept for HTML whose source you do not trust.
  const [safeMode, setSafeMode] = useState(false);
  if (preview.kind !== "html") return null;
  const previewUrl = preview.previewUrl;
  const live = previewUrl !== undefined && !safeMode;
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
        <OpenExternalButton projectId={projectId} path={path} />
      </div>
      {live
        ? <iframe title="HTML artifact" sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-scripts" src={previewUrl} />
        : <iframe title="HTML artifact" sandbox="" srcDoc={sandboxedHtml(preview.text)} />}
    </div>
  );
}

function sandboxedHtml(html: string): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:">`;
  if (/<head[\s>]/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${csp}`);
  return `<!doctype html><html><head>${csp}</head><body>${html}</body></html>`;
}
