import type { ComponentType } from "react";
import type { ArtifactPreview } from "@shared/types";
import { BrowserViewer } from "./viewers/BrowserViewer";
import { CodeViewer } from "./viewers/CodeViewer";
import { HtmlViewer } from "./viewers/HtmlViewer";
import { ImageViewer } from "./viewers/ImageViewer";
import { MarkdownViewer } from "./viewers/MarkdownViewer";
import { PdfViewer } from "./viewers/PdfViewer";
import { PresentationViewer } from "./viewers/PresentationViewer";
import { SpreadsheetViewer } from "./viewers/SpreadsheetViewer";
import { UnsupportedViewer } from "./viewers/UnsupportedViewer";
import { VideoViewer } from "./viewers/VideoViewer";

export type ArtifactKind = ArtifactPreview["kind"];

export type ArtifactViewerProps = {
  preview: ArtifactPreview;
  projectId: string;
  path: string;
  editing?: boolean;
  draft?: string;
  saving?: boolean;
  onDraftChange?: (value: string) => void;
  onSave?: () => void;
  onRevert?: () => void;
  onEdit?: () => void;
};

export const artifactViewerRegistry: Record<ArtifactKind, ComponentType<ArtifactViewerProps>> = {
  image: ImageViewer,
  video: VideoViewer,
  pdf: PdfViewer,
  markdown: MarkdownViewer,
  html: HtmlViewer,
  code: CodeViewer,
  text: CodeViewer,
  spreadsheet: SpreadsheetViewer,
  presentation: PresentationViewer,
  browser: BrowserViewer,
  unsupported: UnsupportedViewer,
};
