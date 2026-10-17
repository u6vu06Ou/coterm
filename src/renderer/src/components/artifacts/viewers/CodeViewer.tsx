import type { ArtifactViewerProps } from "../registry";

export function CodeViewer({ preview }: ArtifactViewerProps): React.JSX.Element | null {
  if (!(preview.kind === "code" || preview.kind === "text")) return null;
  return <pre><code>{preview.text}</code></pre>;
}
