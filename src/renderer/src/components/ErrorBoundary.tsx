import { Component, type ErrorInfo, type ReactNode } from "react";
import type { RendererErrorReportInput } from "@shared/ipc";

// Safety net (2026-10-09 png-click-blank-screen handoff, 修法方向 B): a
// renderer exception no longer unmounts the whole React tree. Each boundary
// shows its own fallback and reports the caught error to the main logger via
// IPC (message + stack only; logging contract A.2 — never PTY or conversation
// text).
interface ErrorBoundaryProps {
  children?: ReactNode;
  /** Rendered in place of children after a catch. A real element so hooks/i18n inside it stay legal. */
  fallback?: ReactNode;
  /** Short non-content origin tag, e.g. "artifact-preview". */
  source?: string;
  /** Test seam; production falls through to window.aiTerminal.reportRendererError. */
  reporter?: (message: string, stack: string, source: string) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

const MAX_MESSAGE_CHARS = 2000;
const MAX_STACK_CHARS = 4000;

type RendererErrorSeam = {
  aiTerminal?: {
    reportRendererError?: (input: RendererErrorReportInput) => Promise<void>;
  };
};

function reportToMain(message: string, stack: string, source: string): void {
  if (typeof window === "undefined") return;
  const seam = (window as unknown as RendererErrorSeam).aiTerminal;
  if (!seam || typeof seam.reportRendererError !== "function") return;
  void seam
    .reportRendererError({
      message: message.slice(0, MAX_MESSAGE_CHARS),
      ...(stack ? { stack: stack.slice(0, MAX_STACK_CHARS) } : {}),
      source,
    })
    .catch(() => undefined);
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const message = error?.message ?? "Unknown renderer error";
    const stack = error?.stack ?? info?.componentStack ?? "";
    const source = this.props.source ?? "app";
    if (this.props.reporter) {
      this.props.reporter(message, stack, source);
      return;
    }
    reportToMain(message, stack, source);
  }

  render(): ReactNode {
    if (this.state.error) return this.props.fallback ?? null;
    return this.props.children ?? null;
  }
}
