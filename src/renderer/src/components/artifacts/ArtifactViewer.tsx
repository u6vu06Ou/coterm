import { useEffect, useState } from "react";
import type { ArtifactPreview } from "@shared/types";
import { useI18n } from "../../i18n";
import { artifactViewerRegistry } from "./registry";
import { OpenExternalButton } from "./viewers/OpenExternalButton";

const OUTSIDE_WORKSPACE_RE = /outside the allowed workspace/i;

export function ArtifactViewer({ projectId, path }: { projectId: string; path: string }): React.JSX.Element {
  const { t } = useI18n();
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void window.aiTerminal
      .readArtifact({ projectId, path })
      .then((value) => {
        if (!active) return;
        setPreview(value);
        setDraft("text" in value ? value.text : "");
      })
      .catch((reason: unknown) => active && setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      active = false;
    };
  }, [path, projectId]);

  if (error) {
    const outside = OUTSIDE_WORKSPACE_RE.test(error);
    const message = outside ? t("artifact.error.outsideWorkspace") : error;
    return (
      <div className="artifact-viewer-state artifact-error-state">
        <span>{message}</span>
        <OpenExternalButton projectId={projectId} path={path} />
      </div>
    );
  }
  if (!preview) return <div className="artifact-viewer-state">{t("artifact.loading")}</div>;
  // A genuinely 0-byte file renders an empty body (blank panel) under most
  // viewers — intercept it so empty content is always a visible note, and
  // never silence.
  if (preview.size === 0) {
    return (
      <div className="artifact-viewer-state artifact-error-state">
        <span>{t("artifact.emptyFile")}</span>
        <OpenExternalButton projectId={projectId} path={path} />
      </div>
    );
  }

  const Viewer = artifactViewerRegistry[preview.kind] ?? artifactViewerRegistry.unsupported;
  return (
    <div className={`artifact-viewer ${preview.kind === "markdown" ? "markdown-viewer" : ""}`}>
      <Viewer
        preview={preview}
        projectId={projectId}
        path={path}
        editing={editing}
        draft={draft}
        saving={saving}
        onDraftChange={setDraft}
        onEdit={() => setEditing(true)}
        onRevert={() => setDraft("text" in preview ? preview.text : "")}
        onSave={() => {
          if (preview.kind !== "markdown") return;
          setSaving(true);
          void window.aiTerminal.writeArtifact({ projectId, path, text: draft })
            .then(() => {
              setPreview({ ...preview, text: draft, size: new TextEncoder().encode(draft).length });
              setEditing(false);
            })
            .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
            .finally(() => setSaving(false));
        }}
      />
      <small>{Math.ceil(preview.size / 1024)} KB · {preview.mimeType}</small>
    </div>
  );
}
