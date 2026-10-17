import { useEffect, useRef } from "react";
import type { ArtifactViewerProps } from "../registry";

export function VideoViewer({ preview }: ArtifactViewerProps): React.JSX.Element | null {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Native <video controls> exposes the browser's fullscreen button. If this
  // viewer unmounts while fullscreen (conversation switch, artifact refresh),
  // the window can stay stuck in HTML fullscreen and cover the taskbar — exit
  // the fullscreen session ourselves when it belongs to OUR video element.
  // Capture the element now: React nulls refs before passive cleanups run.
  useEffect(() => {
    const video = videoRef.current;
    return () => {
      if (video && document.fullscreenElement === video) {
        void document.exitFullscreen().catch(() => undefined);
      }
    };
  }, [preview]);
  if (!(preview.kind === "video")) return null;
  return <video ref={videoRef} src={preview.dataUrl} controls />;
}
