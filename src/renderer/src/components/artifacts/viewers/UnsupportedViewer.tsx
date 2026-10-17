import type { ArtifactViewerProps } from "../registry";

export function UnsupportedViewer({ preview }: ArtifactViewerProps): React.JSX.Element {
  return <div className="artifact-viewer-state">{"reason" in preview ? preview.reason : "This artifact cannot be previewed safely."}</div>;
}
