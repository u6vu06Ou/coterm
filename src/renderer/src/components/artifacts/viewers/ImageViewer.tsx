import type { ArtifactViewerProps } from "../registry";

export function ImageViewer({ preview }: ArtifactViewerProps): React.JSX.Element | null {
  if (!(preview.kind === "image")) return null;
  return <img src={preview.dataUrl} alt="Artifact preview" />;
}
