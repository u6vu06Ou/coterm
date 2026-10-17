import { Maximize2, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PresentationModel } from "@shared/types";
import type { ArtifactViewerProps } from "../registry";

export function PresentationViewer({ preview }: ArtifactViewerProps): React.JSX.Element | null {
  const [model, setModel] = useState<PresentationModel | null>(null);
  const [slideIndex, setSlideIndex] = useState(0);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const presentation = preview.kind === "presentation" ? preview : null;
  const presentationToken = presentation?.presentationToken;

  useEffect(() => {
    let active = true;
    if (!presentationToken) return () => { active = false; };
    void window.aiTerminal.readArtifactPresentation({ token: presentationToken })
      .then((value) => active && setModel(value))
      .catch(() => active && setModel(null));
    return () => { active = false; };
  }, [presentationToken]);

  // If this viewer unmounts while the stage is HTML-fullscreen (conversation
  // switch, artifact refresh), exit the fullscreen session — otherwise the
  // window can stay stuck fullscreen and cover the Windows taskbar. Capture
  // the element NOW: React nulls refs before passive cleanups run, so reading
  // stageRef.current inside the cleanup would always see null.
  useEffect(() => {
    const stage = stageRef.current;
    return () => {
      if (stage && document.fullscreenElement === stage) {
        void document.exitFullscreen().catch(() => undefined);
      }
    };
  }, [model]);

  if (!presentation) return null;
  if (!model) return <div className="artifact-viewer-state">Loading presentation…</div>;
  const slide = model.slides[slideIndex];
  if (!slide) return <div className="artifact-viewer-state">Presentation slide unavailable.</div>;
  const fullscreen = (): void => { void stageRef.current?.requestFullscreen?.(); };
  return (
    <div className="presentation-viewer">
      <div className="presentation-toolbar">
        <button data-action-id="artifact.presentation.previous" title="Previous slide" disabled={slideIndex === 0} onClick={() => setSlideIndex((value) => Math.max(0, value - 1))}><ChevronLeft size={14} /></button>
        <span>{slideIndex + 1} / {model.slides.length}</span>
        <button data-action-id="artifact.presentation.next" title="Next slide" disabled={slideIndex >= model.slides.length - 1} onClick={() => setSlideIndex((value) => Math.min(model.slides.length - 1, value + 1))}><ChevronRight size={14} /></button>
        <button data-action-id="artifact.presentation.fullscreen" title="Fullscreen slide" onClick={fullscreen}><Maximize2 size={14} /></button>
      </div>
      <div className="presentation-layout">
        <div className="presentation-thumbnails" aria-label="Slide thumbnails">
          {model.slides.map((item) => <button data-action-id="artifact.presentation.thumbnail.select" key={item.index} className={item.index === slide.index ? "active" : ""} onClick={() => setSlideIndex(item.index)}><SlideCanvas model={model} slide={item} thumbnail /></button>)}
        </div>
        <div ref={stageRef} className="presentation-stage" style={{ aspectRatio: `${model.width} / ${model.height}` }}>
          <SlideCanvas model={model} slide={slide} />
        </div>
      </div>
    </div>
  );
}

function SlideCanvas({ model, slide, thumbnail = false }: { model: PresentationModel; slide: PresentationModel["slides"][number]; thumbnail?: boolean }): React.JSX.Element {
  return (
    <div className={`presentation-slide ${thumbnail ? "thumbnail" : ""}`} style={{ aspectRatio: `${model.width} / ${model.height}` }}>
      {slide.elements.map((element, index) => {
        const style = { left: `${(element.x / model.width) * 100}%`, top: `${(element.y / model.height) * 100}%`, width: `${(element.width / model.width) * 100}%`, height: `${(element.height / model.height) * 100}%`, backgroundColor: element.fillColor };
        if (element.kind === "image" && element.imageDataUrl) return <img key={index} className="presentation-element" style={style} src={element.imageDataUrl} alt="" />;
        if (element.kind === "text") return <div key={index} className="presentation-element presentation-text" style={style}>{element.text}</div>;
        if (element.kind === "shape") return <div key={index} className="presentation-element presentation-shape" style={style} />;
        return <div key={index} className="presentation-element presentation-unsupported" style={style}>{element.label ?? "Unsupported element"}</div>;
      })}
    </div>
  );
}
