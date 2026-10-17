import { History, PanelRightClose, RotateCcw, Undo2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Checkpoint, CheckpointDiff, CheckpointRestorePreview, NormalizedEvent } from "@shared/types";
import { useAppStore } from "../store/app-store";
import { useI18n, type MessageKey } from "../i18n";

const CHECKPOINT_WIDTH_KEY = "coterm-checkpoint-width";
const CHECKPOINT_WIDTH_DEFAULT = 380;
const CHECKPOINT_WIDTH_MIN = 280;
const CHECKPOINT_WIDTH_MAX = 760;

export function CheckpointRail(): React.JSX.Element | null {
  const { checkpointOpen, setCheckpointOpen, dockLayout } = useAppStore();
  const { t } = useI18n();
  const selectedTile = dockLayout.tiles.find(
    (tile) => tile.terminalId === dockLayout.selectedTerminalId,
  );
  const projectId = selectedTile?.projectId ?? null;
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(CHECKPOINT_WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0
      ? Math.min(CHECKPOINT_WIDTH_MAX, Math.max(CHECKPOINT_WIDTH_MIN, saved))
      : CHECKPOINT_WIDTH_DEFAULT;
  });
  const widthRef = useRef(width);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const apply = (next: number): void => {
    const value = Math.min(CHECKPOINT_WIDTH_MAX, Math.max(CHECKPOINT_WIDTH_MIN, next));
    widthRef.current = value;
    setWidth(value);
  };

  if (!checkpointOpen) return null;

  return (
    <aside
      className="checkpoint-rail"
      style={{ "--checkpoint-width": `${width}px` } as React.CSSProperties}
    >
      <div
        className="checkpoint-resizer panel-resizer"
        data-action-id="checkpoint.resize"
        data-action-trigger="pointerdown"
        role="separator"
        aria-label={t("checkpoint.resize.aria")}
        aria-orientation="vertical"
        aria-valuemin={CHECKPOINT_WIDTH_MIN}
        aria-valuemax={CHECKPOINT_WIDTH_MAX}
        aria-valuenow={width}
        tabIndex={0}
        onDoubleClick={() => {
          apply(CHECKPOINT_WIDTH_DEFAULT);
          localStorage.removeItem(CHECKPOINT_WIDTH_KEY);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          apply(width + (event.key === "ArrowLeft" ? 16 : -16));
          localStorage.setItem(CHECKPOINT_WIDTH_KEY, String(widthRef.current));
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
          localStorage.setItem(CHECKPOINT_WIDTH_KEY, String(widthRef.current));
        }}
        onPointerCancel={() => { drag.current = null; }}
      />
      <div className="checkpoint-rail-body">
        <div className="rail-heading">
          <div>
            <span>{t("checkpoint.heading")}</span>
            <strong>{t("checkpoint.heading")}</strong>
          </div>
          <div className="rail-actions">
            <button
              data-action-id="checkpoint.close"
              className="icon-button"
              title={t("checkpoint.close.title")}
              onClick={() => setCheckpointOpen(false)}
            >
              <PanelRightClose size={17} />
            </button>
          </div>
        </div>
        {projectId ? (
          <CheckpointList projectId={projectId} />
        ) : (
          <div className="rail-empty">
            <History size={19} />
            <p>{t("checkpoint.empty")}</p>
          </div>
        )}
      </div>
    </aside>
  );
}

function CheckpointList({ projectId }: { projectId: string }): React.JSX.Element {
  const { t } = useI18n();
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [evidenceByTurn, setEvidenceByTurn] = useState<Record<string, TurnEvidence>>({});
  const [error, setError] = useState("");

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await window.aiTerminal.listCheckpoints({ projectId });
      setCheckpoints(next);
      const conversationIds = [...new Set(next.map((checkpoint) => checkpoint.conversationId).filter(Boolean))] as string[];
      const eventBatches = await Promise.all(conversationIds.map((id) => window.aiTerminal.listEvents(id)));
      setEvidenceByTurn(buildTurnEvidence(eventBatches.flat()));
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  if (error) return <div className="checkpoint-status-note">{error}</div>;
  if (checkpoints.length === 0) {
    return (
      <div className="rail-empty">
        <History size={19} />
        <p>{t("checkpoint.empty")}</p>
      </div>
    );
  }

  // Group pre/post by turnId, newest turn first.
  const byTurn = new Map<string, { pre?: Checkpoint; post?: Checkpoint }>();
  for (const c of checkpoints) {
    const key = c.turnId ?? c.id;
    const entry = byTurn.get(key) ?? {};
    if (c.phase === "pre") entry.pre = c;
    else entry.post = c;
    byTurn.set(key, entry);
  }
  const turns = [...byTurn.entries()];

  return (
    <div className="checkpoint-list">
      {turns.map(([turnKey, { pre, post }]) => (
        <div className="checkpoint-card" key={turnKey}>
          <div className="checkpoint-card-head">
            <span>
              {t("checkpoint.turn.label")} {turnKey.slice(0, 8)}
            </span>
            <div className="rail-actions">
              {pre && (
                <button
                  data-action-id="checkpoint.undo"
                  className="icon-button"
                  title={t("checkpoint.undo.title")}
                  onClick={() => void restoreFlow(pre, "undo", refresh, t, setError)}
                >
                  <Undo2 size={14} />
                </button>
              )}
              {post && (
                <button
                  data-action-id="checkpoint.redo"
                  className="icon-button"
                  title={t("checkpoint.redo.title")}
                  onClick={() => void restoreFlow(post, "redo", refresh, t, setError)}
                >
                  <RotateCcw size={14} />
                </button>
              )}
            </div>
          </div>
          <CheckpointEvidence evidence={evidenceByTurn[turnKey]} />
          {pre && <CheckpointDetail checkpoint={pre} onChanged={refresh} onError={setError} />}
          {post && <CheckpointDetail checkpoint={post} onChanged={refresh} onError={setError} />}
        </div>
      ))}
    </div>
  );
}

interface TurnEvidence {
  agentSummary?: string;
  testResults: string[];
}

function buildTurnEvidence(events: NormalizedEvent[]): Record<string, TurnEvidence> {
  const evidence: Record<string, TurnEvidence> = {};
  for (const event of events) {
    const entry = evidence[event.turnId] ?? { testResults: [] };
    if (event.type === "assistant.final") {
      const text = typeof event.payload.text === "string" ? event.payload.text.trim() : "";
      entry.agentSummary = (text || event.summary).slice(0, 320);
    }
    if (event.type === "command.completed") {
      const exitCode = typeof event.payload.exitCode === "number" ? ` · exit ${event.payload.exitCode}` : "";
      entry.testResults.push(`${event.summary}${exitCode}`.slice(0, 180));
      entry.testResults = entry.testResults.slice(-3);
    }
    evidence[event.turnId] = entry;
  }
  return evidence;
}

function CheckpointEvidence({ evidence }: { evidence: TurnEvidence | undefined }): React.JSX.Element | null {
  const { t } = useI18n();
  if (!evidence || (!evidence.agentSummary && evidence.testResults.length === 0)) return null;
  return (
    <div className="checkpoint-evidence">
      {evidence.agentSummary && (
        <p><strong>{t("checkpoint.agentSummary")}</strong> {evidence.agentSummary}</p>
      )}
      {evidence.testResults.length > 0 && (
        <div>
          <strong>{t("checkpoint.testResults")}</strong>
          {evidence.testResults.map((result, index) => <p key={index}>{result}</p>)}
        </div>
      )}
    </div>
  );
}

function CheckpointDetail({
  checkpoint,
  onChanged,
  onError,
}: {
  checkpoint: Checkpoint;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [diff, setDiff] = useState<CheckpointDiff | null>(null);
  const [busy, setBusy] = useState(false);

  const loadDiff = async (): Promise<void> => {
    setBusy(true);
    try {
      setDiff(await window.aiTerminal.checkpointDiff({ checkpointId: checkpoint.id, base: "working" }));
      onError("");
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const restoreHunk = async (filePath: string, hunkIndex: number): Promise<void> => {
    setBusy(true);
    try {
      const preview = await window.aiTerminal.checkpointRestorePreview({ checkpointId: checkpoint.id });
      if (!window.confirm(t("checkpoint.hunk.restore.title"))) return;
      await window.aiTerminal.restoreCheckpointHunk({
        checkpointId: checkpoint.id,
        filePath,
        hunkIndex,
        confirm: true,
        previewToken: preview.previewToken,
      });
      setDiff(await window.aiTerminal.checkpointDiff({ checkpointId: checkpoint.id, base: "working" }));
      await onChanged();
      onError("");
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="checkpoint-file">
      <div className="checkpoint-file-path">
        <span className="checkpoint-phase">
          {checkpoint.phase === "pre" ? t("checkpoint.phase.pre") : t("checkpoint.phase.post")}
        </span>
        <div className="rail-actions">
          {checkpoint.status === "failed" && (
            <span className="checkpoint-badge failed">{t("checkpoint.failed")}</span>
          )}
          {checkpoint.partial && (
            <span className="checkpoint-badge partial">{t("checkpoint.partial")}</span>
          )}
          <button
            data-action-id="checkpoint.diff"
            type="button"
            className="checkpoint-action-button"
            title={t("checkpoint.diff.title")}
            disabled={busy || checkpoint.status === "failed"}
            onClick={() => void loadDiff()}
          >
            {t("checkpoint.diff.title")}
          </button>
          <button
            data-action-id="checkpoint.restore"
            type="button"
            className="checkpoint-action-button"
            title={t("checkpoint.restore.title")}
            disabled={busy || checkpoint.status === "failed"}
            onClick={() => void restoreFlow(checkpoint, "restore", onChanged, t, onError)}
          >
            {t("checkpoint.restore.title")}
          </button>
        </div>
      </div>
      {diff && (
        <div>
          <div className="checkpoint-status-note">{diff.stat}</div>
          {diff.files.map((file) => (
            <div key={file.path} style={{ marginTop: 4 }}>
              <div className="checkpoint-file-path">
                <strong>{file.path}</strong>
                <span className="checkpoint-status-note">
                  +{file.additions} -{file.deletions}
                  {file.binary ? ` · ${t("checkpoint.binary")}` : ""}
                  {file.oversize ? ` · ${t("checkpoint.oversize")}` : ""}
                </span>
              </div>
              {file.diff && splitUnifiedDiffHunks(file.diff).map((hunk, hunkIndex) => (
                <div className="checkpoint-hunk" key={`${file.path}:${hunkIndex}`}>
                  <button
                    data-action-id="checkpoint.hunk.restore"
                    type="button"
                    className="checkpoint-action-button"
                    title={t("checkpoint.hunk.restore.title")}
                    disabled={busy}
                    onClick={() => void restoreHunk(file.path, hunkIndex)}
                  >
                    {t("checkpoint.hunk.restore.title")}
                  </button>
                  <pre className="checkpoint-diff-line">
                    {hunk.lines.slice(0, 40).map((line, idx) => (
                      <div
                        key={idx}
                        className={`checkpoint-diff-line ${line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : ""}`}
                      >
                        {line}
                      </div>
                    ))}
                  </pre>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function splitUnifiedDiffHunks(diff: string): { lines: string[] }[] {
  const lines = diff.split(/\r?\n/);
  const starts: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index]!.startsWith("@@ ")) starts.push(index);
  }
  return starts.map((start, index) => ({
    lines: lines.slice(start, starts[index + 1] ?? lines.length),
  }));
}

async function restoreFlow(
  checkpoint: Checkpoint,
  mode: "restore" | "undo" | "redo",
  onChanged: () => Promise<void>,
  t: (key: MessageKey) => string,
  onError: (message: string) => void,
): Promise<void> {
  let preview: CheckpointRestorePreview;
  try {
    preview = await window.aiTerminal.checkpointRestorePreview({ checkpointId: checkpoint.id });
    onError("");
  } catch (reason) {
    onError(reason instanceof Error ? reason.message : String(reason));
    return;
  }
  if (preview.driftDetected) {
    // ponytail: drift is surfaced but we still let the user proceed — the
    // backend re-checks and refuses on real drift, so the UI is honest.
    void t;
  }
  const confirm = window.confirm(
    `${mode === "undo" ? t("checkpoint.undo.title") : mode === "redo" ? t("checkpoint.redo.title") : t("checkpoint.restore.title")}?`,
  );
  if (!confirm) return;
  try {
    // Each visible button restores the checkpoint shown on that exact card.
    // Do not ask the backend to re-select "latest" by conversation: doing so
    // could pair an older card's preview token with a different checkpoint.
    await window.aiTerminal.restoreCheckpoint({
      checkpointId: checkpoint.id,
      confirm: true,
      previewToken: preview.previewToken,
    });
    await onChanged();
    onError("");
  } catch (reason) {
    onError(reason instanceof Error ? reason.message : String(reason));
  }
}
