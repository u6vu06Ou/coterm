import { GitBranch, X } from "lucide-react";
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../store/app-store";
import { useI18n } from "../i18n";
import type { MessageKey } from "../i18n";
import type { Worktree, WorktreeStatus } from "@shared/types";

// Button-state rules mirror the backend's hard checks (worktree-manager.ts):
// - hasRunningTerminal → merge/abort/cleanup DISABLED (backend refuses; UI同步)
// - status !== 'active' → merge DISABLED; cleanup follows backend cleanliness checks
// - conflict → merge DISABLED + warning; abort enabled (aborts the conflict)
// - resume → only when nativeSessionId exists AND a live terminal is bound
//   (hasRunningTerminal). Resume injects into a live bound terminal; without
//   one the backend has nowhere to write the rebuilt command.
function canMerge(wt: Worktree): boolean {
  return wt.status === "active" && !wt.hasRunningTerminal;
}
function canAbort(wt: Worktree): boolean {
  return (wt.status === "active" || wt.status === "conflict") && !wt.hasRunningTerminal;
}
function canCleanup(wt: Worktree): boolean {
  // Backend cleanup accepts any lifecycle state when the sandbox is clean and
  // no PTY is running. Dirty/path safety remains authoritative in main.
  return !wt.hasRunningTerminal;
}
function canResume(wt: Worktree): boolean {
  return wt.status === "active" && Boolean(wt.nativeSessionId) && wt.hasRunningTerminal;
}

function statusKey(status: WorktreeStatus): MessageKey {
  return `worktree.item.status.${status}`;
}

export function WorktreeManagerDialog(): React.JSX.Element | null {
  const {
    worktrees,
    worktreeDialogOpen,
    worktreeDialogProjectId,
    worktreeBusyId,
    worktreeDiffById,
    worktreeError,
    projects,
    closeWorktreeDialog,
    refreshWorktreeDiff,
    mergeWorktreeAction,
    abortWorktreeAction,
    cleanupWorktreeAction,
    resumeWorktreeAction,
  } = useAppStore(useShallow((s) => ({
    worktrees: s.worktrees,
    worktreeDialogOpen: s.worktreeDialogOpen,
    worktreeDialogProjectId: s.worktreeDialogProjectId,
    worktreeBusyId: s.worktreeBusyId,
    worktreeDiffById: s.worktreeDiffById,
    worktreeError: s.worktreeError,
    projects: s.projects,
    closeWorktreeDialog: s.closeWorktreeDialog,
    refreshWorktreeDiff: s.refreshWorktreeDiff,
    mergeWorktreeAction: s.mergeWorktreeAction,
    abortWorktreeAction: s.abortWorktreeAction,
    cleanupWorktreeAction: s.cleanupWorktreeAction,
    resumeWorktreeAction: s.resumeWorktreeAction,
  })));
  const { t } = useI18n();

  useEffect(() => {
    if (!worktreeDialogOpen) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeWorktreeDialog();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [worktreeDialogOpen, closeWorktreeDialog]);

  if (!worktreeDialogOpen || !worktreeDialogProjectId) return null;
  const project = projects.find((p) => p.id === worktreeDialogProjectId);
  const projectName = project?.name ?? worktreeDialogProjectId;

  const confirmMerge = async (wt: Worktree): Promise<void> => {
    let diff = worktreeDiffById[wt.id];
    if (!diff) {
      await refreshWorktreeDiff(wt.id);
      diff = useAppStore.getState().worktreeDiffById[wt.id];
    }
    const stat = diff
      ? diff.diffStat.trim() || t("worktree.diff.empty")
      : t("worktree.action.merge.noDiff");
    const message = t("worktree.action.merge.confirm", { branch: wt.branch, stat });
    if (window.confirm(message)) void mergeWorktreeAction(wt.id);
  };
  const confirmAbort = (wt: Worktree): void => {
    if (window.confirm(t("worktree.action.abort.confirm", { branch: wt.branch }))) {
      void abortWorktreeAction(wt.id);
    }
  };
  const confirmCleanup = (wt: Worktree): void => {
    if (window.confirm(t("worktree.action.cleanup.confirm", { branch: wt.branch }))) {
      void cleanupWorktreeAction(wt.id);
    }
  };

  return (
    <div
      data-action-id="worktree.dialog.backdrop.dismiss"
      className="wizard-backdrop"
      onClick={closeWorktreeDialog}
    >
      <section
        data-action-id="worktree.dialog.consume"
        className="worktree-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("worktree.dialog.title", { name: projectName })}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <strong>{t("worktree.dialog.title", { name: projectName })}</strong>
          <button
            data-action-id="worktree.dialog.close"
            className="icon-button"
            aria-label={t("worktree.dialog.close.aria")}
            onClick={closeWorktreeDialog}
          >
            <X size={18} />
          </button>
        </header>
        {worktreeError && <p className="worktree-error">{worktreeError}</p>}
        {worktrees.length === 0 ? (
          <p className="worktree-empty">{t("worktree.dialog.empty")}</p>
        ) : (
          <div className="worktree-list">
            {worktrees.map((wt) => {
              const diff = worktreeDiffById[wt.id] ?? null;
              const busy = worktreeBusyId === wt.id;
              return (
                <article className="worktree-item" key={wt.id}>
                  <div className="worktree-item-header">
                    <span className="worktree-branch">
                      <GitBranch size={13} />
                      <strong>{wt.branch}</strong>
                    </span>
                    <span className={`worktree-status-badge ${wt.status}`}>
                      {t(statusKey(wt.status))}
                    </span>
                    <small className="worktree-base">{t("worktree.item.base", { base: wt.baseRef })}</small>
                    <time dateTime={wt.createdAt}>{new Date(wt.createdAt).toLocaleString()}</time>
                  </div>
                  {wt.status === "conflict" && (
                    <p className="worktree-warning">{t("worktree.item.conflictWarning")}</p>
                  )}
                  {wt.hasRunningTerminal && wt.status === "active" && (
                    <p className="worktree-info">{t("worktree.item.runningTerminal")}</p>
                  )}
                  <div className="worktree-actions">
                    <button
                      data-action-id="worktree.dialog.diff.toggle"
                      type="button"
                      className="worktree-action-button"
                      disabled={busy}
                      onClick={() => void refreshWorktreeDiff(wt.id)}
                    >
                      {t("worktree.action.diff")}
                    </button>
                    <button
                      data-action-id="worktree.dialog.merge"
                      type="button"
                      className="worktree-action-button primary"
                      disabled={busy || !canMerge(wt)}
                      title={!canMerge(wt) ? t("worktree.action.merge.disabled") : undefined}
                      onClick={() => void confirmMerge(wt)}
                    >
                      {t("worktree.action.merge")}
                    </button>
                    <button
                      data-action-id="worktree.dialog.abort"
                      type="button"
                      className="worktree-action-button"
                      disabled={busy || !canAbort(wt)}
                      title={!canAbort(wt) ? t("worktree.action.abort.disabled") : undefined}
                      onClick={() => confirmAbort(wt)}
                    >
                      {t("worktree.action.abort")}
                    </button>
                    <button
                      data-action-id="worktree.dialog.cleanup"
                      type="button"
                      className="worktree-action-button"
                      disabled={busy || !canCleanup(wt)}
                      title={!canCleanup(wt) ? t("worktree.action.cleanup.disabled") : undefined}
                      onClick={() => confirmCleanup(wt)}
                    >
                      {t("worktree.action.cleanup")}
                    </button>
                    <button
                      data-action-id="worktree.dialog.resume"
                      type="button"
                      className="worktree-action-button"
                      disabled={busy || !canResume(wt)}
                      title={!canResume(wt) ? t("worktree.action.resume.disabled") : undefined}
                      onClick={() => void resumeWorktreeAction(wt.id)}
                    >
                      {t("worktree.action.resume")}
                    </button>
                  </div>
                  {diff && (
                    <div className="worktree-diff">
                      {diff.dirty && <p className="worktree-warning">{t("worktree.diff.dirty")}</p>}
                      <pre className="worktree-diff-stat">{diff.diffStat || t("worktree.diff.empty")}</pre>
                      {diff.commits && (
                        <pre className="worktree-diff-commits">{diff.commits}</pre>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
        <footer>
          <small>{t("worktree.dialog.footer")}</small>
        </footer>
      </section>
    </div>
  );
}
