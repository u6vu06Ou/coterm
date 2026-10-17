import { ExternalLink } from "lucide-react";
import { useI18n } from "../../../i18n";
import { useAppStore } from "../../../store/app-store";

export function OpenExternalButton({ projectId, path }: { projectId: string; path: string }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <button
      data-action-id="artifact.openExternal"
      className="icon-button"
      title={t("artifact.openExternal")}
      onClick={() => {
        void window.aiTerminal.openArtifactExternal({ projectId, path }).catch((reason: unknown) => {
          useAppStore.getState().setError(reason instanceof Error ? reason.message : String(reason));
        });
      }}
    >
      <ExternalLink size={16} />
    </button>
  );
}
