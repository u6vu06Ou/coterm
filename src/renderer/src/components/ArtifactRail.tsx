import {
  AlertCircle,
  ArrowLeft,
  ExternalLink,
  FileCode2,
  Globe2,
  Image,
  PanelRightClose,
  Sparkles,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { ArtifactPreview, NormalizedEvent } from "@shared/types";
import { textValue } from "@shared/value";
import { useAppStore } from "../store/app-store";
import { useI18n } from "../i18n";
import { ErrorBoundary } from "./ErrorBoundary";
import { ArtifactViewer } from "./artifacts/ArtifactViewer";
import { BrowserViewer } from "./artifacts/viewers/BrowserViewer";

const EMPTY_EVENTS: NormalizedEvent[] = [];
const ARTIFACT_WIDTH_KEY = "coterm-artifact-width";
const ARTIFACT_WIDTH_DEFAULT = 380;
const ARTIFACT_WIDTH_MIN = 280;
const ARTIFACT_WIDTH_MAX = 760;

// 修法方向 B (2026-10-09): one viewer exception must not unmount the rail —
// the boundary swaps in this fallback and the close button clears the panel.
function PreviewFailedFallback({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="rail-empty" role="alert">
      <AlertCircle size={19} />
      <p>{t("artifact.preview.failed")}</p>
      <button
        data-action-id="artifact.preview.close"
        className="clickable"
        type="button"
        onClick={onClose}
      >
        {t("artifact.close.title")}
      </button>
    </div>
  );
}

export function ArtifactRail(): React.JSX.Element | null {
  const {
    artifactOpen,
    setArtifactOpen,
    selectedArtifact,
    openArtifact,
    closeArtifact,
    dockLayout,
    panes,
    activePaneId,
    browserArtifacts,
  } = useAppStore();
  const { t } = useI18n();
  // Terminal-first: the selected dock tile owns the active project. Fall back
  // to the dormant pane model only if the dock has no selection (keeps the
  // artifact list path working for any legacy caller).
  const selectedTile = dockLayout.tiles.find(
    (tile) => tile.terminalId === dockLayout.selectedTerminalId,
  );
  const activePane = panes.find((pane) => pane.id === activePaneId);
  const events = activePane?.events ?? EMPTY_EVENTS;
  const activeProjectId = selectedTile?.projectId ?? activePane?.projectId ?? null;
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(ARTIFACT_WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0
      ? Math.min(ARTIFACT_WIDTH_MAX, Math.max(ARTIFACT_WIDTH_MIN, saved))
      : ARTIFACT_WIDTH_DEFAULT;
  });
  const [browserPreview, setBrowserPreview] = useState<Extract<ArtifactPreview, { kind: "browser" }> | null>(null);
  const [browserComposerOpen, setBrowserComposerOpen] = useState(false);
  const [browserAddress, setBrowserAddress] = useState("https://");
  const [browserError, setBrowserError] = useState("");
  const widthRef = useRef(width);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const apply = (next: number): void => {
    const value = Math.min(ARTIFACT_WIDTH_MAX, Math.max(ARTIFACT_WIDTH_MIN, next));
    widthRef.current = value;
    setWidth(value);
  };
  const artifacts = useMemo(
    () =>
      events.flatMap((event) =>
        artifactPaths(event).map((path) => ({
          event,
          path,
          title: path.split(/[\\/]/).at(-1) ?? event.summary,
        })),
      ),
    [events],
  );
  if (!artifactOpen) return null;

  return (
    <aside
      className={`artifact-rail ${selectedArtifact ? "previewing" : ""}`}
      style={{ "--artifact-width": `${width}px` } as React.CSSProperties}
    >
      <div
        className="artifact-resizer panel-resizer"
        data-action-id="artifact.resize"
        data-action-trigger="pointerdown"
        role="separator"
        aria-label={t("artifact.resize.aria")}
        aria-orientation="vertical"
        aria-valuemin={ARTIFACT_WIDTH_MIN}
        aria-valuemax={ARTIFACT_WIDTH_MAX}
        aria-valuenow={width}
        tabIndex={0}
        onDoubleClick={() => {
          apply(ARTIFACT_WIDTH_DEFAULT);
          localStorage.removeItem(ARTIFACT_WIDTH_KEY);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          apply(width + (event.key === "ArrowLeft" ? 16 : -16));
          localStorage.setItem(ARTIFACT_WIDTH_KEY, String(widthRef.current));
        }}
        onPointerDown={(event) => {
          drag.current = { x: event.clientX, width };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          apply(drag.current.width - (event.clientX - drag.current.x));
        }}
        onPointerUp={(event) => {
          drag.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
          localStorage.setItem(ARTIFACT_WIDTH_KEY, String(widthRef.current));
        }}
        onPointerCancel={() => { drag.current = null; }}
      />
      <div className="artifact-rail-body">
      <div className="rail-heading">
        <div>
          <span>{selectedArtifact ? t("artifact.heading.preview") : t("artifact.heading.output")}</span>
          <strong>{selectedArtifact?.title ?? t("artifact.heading.default")}</strong>
        </div>
        <div className="rail-actions">
          <button data-action-id="artifact.browser.create" className="icon-button" title="Open browser artifact" onClick={() => { setBrowserComposerOpen((open) => !open); setBrowserError(""); }}>
            <Globe2 size={17} />
          </button>
          {selectedArtifact && (
            <>
              <button data-action-id="artifact.back" className="icon-button" title={t("artifact.back.title")} onClick={() => { setBrowserPreview(null); closeArtifact(); }}>
                <ArrowLeft size={17} />
              </button>
              <button
                data-action-id="artifact.reveal"
                className="icon-button"
                title={t("artifact.reveal.title")}
                onClick={() => {
                  const pid = selectedArtifact.projectId ?? activeProjectId;
                  if (pid) {
                    void window.aiTerminal.revealArtifact({
                      projectId: pid,
                      path: selectedArtifact.path,
                    });
                  }
                }}
              >
                <ExternalLink size={17} />
              </button>
            </>
          )}
          <button
            data-action-id="artifact.close"
            className="icon-button"
            title={t("artifact.close.title")}
            onClick={() => { setArtifactOpen(false); setBrowserPreview(null); }}
          >
            <PanelRightClose size={17} />
          </button>
        </div>
      </div>
      {browserComposerOpen && (
        <form data-action-id="artifact.browser.launcher.submit" className="artifact-browser-launcher" onSubmit={(event) => {
          event.preventDefault();
          setBrowserError("");
          void window.aiTerminal.openBrowserArtifact({ url: browserAddress })
            .then((preview) => {
              if (preview.kind !== "browser") throw new Error("Invalid browser artifact response.");
              setBrowserPreview(preview);
              setBrowserComposerOpen(false);
            })
            .catch((reason: unknown) => setBrowserError(reason instanceof Error ? reason.message : String(reason)));
        }}>
          <input data-action-id="artifact.browser.url.change" aria-label="Browser URL" value={browserAddress} onChange={(event) => setBrowserAddress(event.target.value)} />
          <button data-action-id="artifact.browser.url.submit" type="submit">Open</button>
          {browserError && <small>{browserError}</small>}
        </form>
      )}
      {browserPreview ? (
        <ErrorBoundary
          key={`browser-preview:${browserPreview.url}`}
          source="browser-preview"
          fallback={<PreviewFailedFallback onClose={closeArtifact} />}
        >
          <div className="artifact-viewer browser-artifact-viewer"><BrowserViewer preview={browserPreview} projectId="" path={browserPreview.url} /><small>Browser · {browserPreview.url}</small></div>
        </ErrorBoundary>
      ) : selectedArtifact && (selectedArtifact.projectId ?? activeProjectId) ? (
        <ErrorBoundary
          key={`artifact-preview:${selectedArtifact.projectId ?? activeProjectId}:${selectedArtifact.path}`}
          source="artifact-preview"
          fallback={<PreviewFailedFallback onClose={closeArtifact} />}
        >
          <ArtifactViewer
            projectId={(selectedArtifact.projectId ?? activeProjectId) as string}
            path={selectedArtifact.path}
          />
        </ErrorBoundary>
      ) : artifacts.length === 0 && browserArtifacts.length === 0 ? (
        <div className="rail-empty">
          <Sparkles size={19} />
          <p>{t("artifact.empty")}</p>
        </div>
      ) : (
        <div className="artifact-list">
          {browserArtifacts.map((artifact) => (
            <button
              data-action-id="artifact.openBrowser"
              className="artifact-card clickable"
              key={`browser:${artifact.path}`}
              onClick={() => { setBrowserPreview(null); openArtifact(artifact.path, artifact.title || artifact.path.split(/[\\/]/).at(-1) || "Screenshot", activeProjectId ?? undefined); }}
            >
              <span className="artifact-preview">
                <Image size={22} />
              </span>
              <span>
                <strong>{artifact.title || artifact.path.split(/[\\/]/).at(-1)}</strong>
                <small>{artifact.pageUrl}</small>
              </span>
            </button>
          ))}
          {artifacts.map(({ event, path, title }) => (
            <button
              data-action-id="artifact.open"
              className="artifact-card clickable"
              key={`${event.id}:${path}`}
              onClick={() => { setBrowserPreview(null); openArtifact(path, title, activeProjectId ?? undefined); }}
            >
              <span className="artifact-preview">
                {event.type === "artifact.created" ? <Image size={22} /> : <FileCode2 size={22} />}
              </span>
              <span>
                <strong>{title}</strong>
                <small>{event.summary}</small>
              </span>
            </button>
          ))}
        </div>
      )}
      </div>
    </aside>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function artifactPaths(event: NormalizedEvent): string[] {
  if (event.type !== "artifact.created" && event.type !== "file.changed") return [];
  const direct = textValue(
    event.payload.path,
    textValue(event.payload.outputPath, textValue(event.payload.imagePath)),
  );
  const changes = Array.isArray(event.payload.changes) ? event.payload.changes : [];
  return [...new Set([
    direct,
    ...changes.map((change) => {
      if (!change || typeof change !== "object") return "";
      const value = change as Record<string, unknown>;
      return textValue(value.path, textValue(value.filePath, textValue(value.file_path)));
    }),
  ].filter(Boolean))];
}

