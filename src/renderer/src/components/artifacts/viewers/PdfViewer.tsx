import type { ArtifactViewerProps } from "../registry";

export function PdfViewer({ preview }: ArtifactViewerProps): React.JSX.Element | null {
  if (!(preview.kind === "pdf")) return null;
  return <iframe className="artifact-pdf" title="PDF artifact" src={preview.dataUrl} />;
}
