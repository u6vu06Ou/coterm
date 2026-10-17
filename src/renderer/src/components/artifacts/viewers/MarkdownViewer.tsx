import { Check, Pencil, RotateCcw } from "lucide-react";
import type { ArtifactViewerProps } from "../registry";
import { useI18n } from "../../../i18n";
import { MarkdownContent } from "../../MarkdownContent";

export function MarkdownViewer({ preview, editing, draft, saving, onDraftChange, onSave, onRevert, onEdit }: ArtifactViewerProps): React.JSX.Element | null {
  const { t } = useI18n();
  if (preview.kind !== "markdown") return null;
  return (
    <>
      <div className="artifact-editor-actions">
        {editing ? (
          <>
            <button data-action-id="artifact.save" disabled={saving || draft === preview.text} onClick={onSave}>
              <Check size={13} />{saving ? t("artifact.save.saving") : t("artifact.save.save")}
            </button>
            <button data-action-id="artifact.revert" disabled={saving} onClick={onRevert}>
              <RotateCcw size={13} />{t("artifact.save.revert")}
            </button>
          </>
        ) : (
          <button data-action-id="artifact.edit" onClick={onEdit}><Pencil size={13} />{t("artifact.edit")}</button>
        )}
      </div>
      {editing ? (
        <textarea data-action-id="artifact.editor.change" className="artifact-editor" aria-label={t("artifact.editor.aria")} value={draft} onChange={(event) => onDraftChange?.(event.target.value)} />
      ) : (
        <MarkdownContent className="artifact-markdown final-answer" markdown={preview.text} />
      )}
    </>
  );
}
