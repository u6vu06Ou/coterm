import { AlertTriangle } from "lucide-react";
import { useAppStore } from "../store/app-store";
import { useI18n } from "../i18n";

/**
 * AT-133: approval gate for the built-in browser. Level 2/3 actions (upload,
 * password fill, evaluate) arrive as metadata-only approval.requested events;
 * the answer travels back through the existing IPC approvalResolve path, so the
 * renderer never converses with Playwright directly. Buttons reuse the
 * (previously orphaned) .approval-actions styling from the old chat approvals.
 */
export function BrowserApprovalDialog(): React.JSX.Element | null {
  // Selector subscriptions: a whole-store subscribe would re-render this dialog
  // on every store mutation; the dialog only cares about the approval slice.
  const browserApprovals = useAppStore((state) => state.browserApprovals);
  const resolveApproval = useAppStore((state) => state.resolveApproval);
  const { t } = useI18n();
  const prompt = browserApprovals[0] ?? null;
  if (!prompt) return null;

  const decide = (decision: "accept" | "acceptForSession" | "decline"): void => {
    void resolveApproval(prompt.requestId, decision);
  };
  const riskKey = prompt.level === 2
    ? "browserApproval.level2"
    : prompt.level === 3
      ? "browserApproval.level3"
      : "browserApproval.levelUnknown";

  return (
    <div data-action-id="browserApproval.backdrop" className="wizard-backdrop">
      <section
        className="browser-approval"
        role="dialog"
        aria-modal="true"
        aria-label={t("browserApproval.dialog.aria")}
      >
        <header>
          <AlertTriangle size={15} aria-hidden="true" />
          <strong>{t("browserApproval.title")}</strong>
        </header>
        <p className="browser-approval-body">
          {t("browserApproval.body", { action: prompt.action, origin: prompt.origin })}
        </p>
        <dl className="browser-approval-facts">
          <div>
            <dt>{t("browserApproval.action")}</dt>
            <dd>{prompt.action}</dd>
          </div>
          <div>
            <dt>{t("browserApproval.origin")}</dt>
            <dd>{prompt.origin}</dd>
          </div>
          <div>
            <dt>{t("browserApproval.risk")}</dt>
            <dd>{t(riskKey)}</dd>
          </div>
          {prompt.locatorStrategy !== null && (
            <div>
              <dt>{t("browserApproval.locator")}</dt>
              <dd>{prompt.locatorStrategy}</dd>
            </div>
          )}
        </dl>
        {prompt.previewScript !== undefined && (
          // evaluate: approving without seeing the script would be blind — the
          // preview is bounded (first ~500 chars) and flagged when truncated.
          <figure className="browser-approval-script">
            <figcaption>{t("browserApproval.scriptPreview")}</figcaption>
            <pre>{prompt.previewScript}</pre>
            {prompt.previewTruncated === true && (
              <small>{t("browserApproval.scriptTruncated")}</small>
            )}
          </figure>
        )}
        {browserApprovals.length > 1 && (
          <small className="browser-approval-more">
            {t("browserApproval.more", { count: browserApprovals.length - 1 })}
          </small>
        )}
        {/* Issue #93: spell out what the session-wide answer means BEFORE the
            buttons, so the button label is a confirmation of something already
            read, not the only place the consequence appears. */}
        <p className="browser-approval-session-note">
          {t("browserApproval.sessionNote")}
        </p>
        <div className="approval-actions">
          <button
            data-action-id="browserApproval.decline"
            type="button"
            onClick={() => decide("decline")}
          >
            {t("browserApproval.decline")}
          </button>
          <button
            data-action-id="browserApproval.accept"
            type="button"
            className="primary"
            onClick={() => decide("accept")}
          >
            {t("browserApproval.accept")}
          </button>
          <button
            data-action-id="browserApproval.acceptForSession"
            type="button"
            className="primary"
            onClick={() => decide("acceptForSession")}
          >
            {t("browserApproval.acceptForSession")}
          </button>
        </div>
      </section>
    </div>
  );
}
