import { Check, ChevronRight, FolderOpen, Globe, Keyboard, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AppSettings } from "@shared/types";
import { useAppStore } from "../store/app-store";
import { onboardingCompletePatch } from "../store/settings-patches";
import { useI18n } from "../i18n";

const WIZARD_LANGUAGE_OPTIONS: Array<{ actionId: string; locale: AppSettings["locale"]; label: string }> = [
  { actionId: "wizard.language.zh-tw.select", locale: "zh-TW", label: "繁體中文" },
  { actionId: "wizard.language.en-us.select", locale: "en-US", label: "English (US)" },
];

// First run should already read in the operating-system language; the persisted
// schema default stays zh-TW so existing installs keep their behaviour.
function detectBrowserLocale(): AppSettings["locale"] {
  const tag = typeof navigator === "undefined" ? "" : navigator.language ?? "";
  return /^zh(\b|-)/i.test(tag) ? "zh-TW" : "en-US";
}

const WIZARD_STEP_COUNT = 6;

export function FirstRunWizard(): React.JSX.Element | null {
  const { settings, providers, projects, createProject, updateSettings } = useAppStore();
  const { t } = useI18n();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<AppSettings | null>(settings);
  const [imeText, setImeText] = useState("");
  const [composing, setComposing] = useState(false);
  const [localeChoice, setLocaleChoice] = useState<AppSettings["locale"]>(detectBrowserLocale);
  // A fresh install on an English-language OS must not have to read Chinese to
  // escape Chinese, so the detected locale lands in settings the moment the
  // wizard mounts. The persisted schema default stays zh-TW, which keeps every
  // existing install on the language it already chose.
  const appliedDetectedLocale = useRef(false);
  useEffect(() => {
    if (appliedDetectedLocale.current || !settings || settings.onboardingCompleted) return;
    appliedDetectedLocale.current = true;
    const detected = detectBrowserLocale();
    setLocaleChoice(detected);
    if (settings.locale !== detected) void updateSettings({ locale: detected });
  }, [settings, updateSettings]);
  if (!settings || settings.onboardingCompleted || !draft) return null;

  const complete = (): void => {
    void updateSettings(
      onboardingCompletePatch(projects[0]?.workspacePath ?? draft.defaultWorkspacePath),
    );
  };

  return (
    <div className="wizard-backdrop">
      <section className="first-run-wizard">
        <aside>
          <div className="wizard-brand"><span>CO</span><strong>Coterm</strong></div>
          {[t("wizard.step.welcome"), t("wizard.step.language"), t("wizard.step.workspace"), t("wizard.step.providers"), t("wizard.step.shell"), t("wizard.step.ime")].map((label, index) => (
            <button
              data-action-id="wizard.step.select"
              key={label}
              className={index === step ? "active" : index < step ? "done" : ""}
              onClick={() => setStep(index)}
            >
              <i>{index < step ? <Check size={12} /> : index + 1}</i>
              {label}
            </button>
          ))}
          <small>{t("wizard.privacy.note")}</small>
        </aside>
        <main>
          <div className="wizard-kicker" data-wizard-step={step + 1} data-wizard-total={WIZARD_STEP_COUNT}>{t("wizard.progress", { current: step + 1, total: WIZARD_STEP_COUNT })}</div>
          {step === 0 && (
            <WizardPage icon={<ShieldCheck />} title={t("wizard.welcome.title")}>
              <p>{t("wizard.welcome.body1")}</p>
              <p>{t("wizard.welcome.body2")}</p>
            </WizardPage>
          )}
          {step === 1 && (
            <WizardPage icon={<Globe />} title={t("wizard.language.title")}>
              <p>{t("wizard.language.body")}</p>
              <div className="wizard-language-options">
                {WIZARD_LANGUAGE_OPTIONS.map(({ actionId, label, locale }) => (
                  <button
                    data-action-id={actionId}
                    key={locale}
                    type="button"
                    className={localeChoice === locale ? "selected" : ""}
                    onClick={() => {
                      setLocaleChoice(locale);
                      void updateSettings({ locale });
                    }}
                  >
                    <strong>{label}</strong>
                  </button>
                ))}
              </div>
              <p>{t("wizard.language.help")}</p>
            </WizardPage>
          )}
          {step === 2 && (
            <WizardPage icon={<FolderOpen />} title={t("wizard.workspace.title")}>
              <p>{t("wizard.workspace.body")}</p>
              <button data-action-id="wizard.workspace.choose" className="wizard-action" onClick={() => void createProject()}>
                <FolderOpen size={16} />
                {projects[0] ? projects[0].workspacePath : t("wizard.workspace.choose")}
              </button>
            </WizardPage>
          )}
          {step === 3 && (
            <WizardPage icon={<ShieldCheck />} title={t("wizard.providers.title")}>
              <p>{t("wizard.providers.body")}</p>
              <div className="wizard-provider-list">
                {providers.map((provider) => (
                  <div key={provider.id}>
                    <i className={provider.installed && provider.online !== false ? "ok" : ""} />
                    <span><strong>{provider.label}</strong><small>{provider.detail}</small></span>
                    <b>{provider.installed ? provider.online === false ? "Offline" : "Ready" : "Missing"}</b>
                  </div>
                ))}
              </div>
            </WizardPage>
          )}
          {step === 4 && (
            <WizardPage icon={<ChevronRight />} title={t("wizard.shell.title")}>
              <p>{t("wizard.shell.body")}</p>
              <div className="shell-options">
                <button data-action-id="wizard.shell.select" className="selected" onClick={() => setDraft({ ...draft, defaultShell: "pwsh" })}>
                  <code>&gt;_</code>
                  <strong>PowerShell 7</strong>
                </button>
              </div>
            </WizardPage>
          )}
          {step === 5 && (
            <WizardPage icon={<Keyboard />} title={t("wizard.ime.title")}>
              <p>{t("wizard.ime.body")}</p>
              <textarea
                data-action-id="wizard.ime.change"
                value={imeText}
                placeholder={t("wizard.ime.placeholder")}
                onChange={(event) => setImeText(event.target.value)}
                onCompositionStart={() => setComposing(true)}
                onCompositionEnd={(event) => {
                  setComposing(false);
                  setImeText(event.currentTarget.value);
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || composing) event.preventDefault();
                }}
              />
              <div className={`ime-check ${composing ? "active" : ""}`}>
                {composing ? t("wizard.ime.composing") : imeText ? t("wizard.ime.ok") : t("wizard.ime.waiting")}
              </div>
            </WizardPage>
          )}
          <footer>
            <button data-action-id="wizard.back" disabled={step === 0} onClick={() => setStep(step - 1)}>{t("wizard.back")}</button>
            {step < WIZARD_STEP_COUNT - 1 ? (
              <button data-action-id="wizard.next" className="primary" onClick={() => setStep(step + 1)}>
                {t("wizard.next")} <ChevronRight size={15} />
              </button>
            ) : (
              <button data-action-id="wizard.complete" className="primary" disabled={composing} onClick={complete}>
                {imeText.trim() ? t("wizard.complete") : t("wizard.skip")} <Check size={15} />
              </button>
            )}
          </footer>
        </main>
      </section>
    </div>
  );
}

function WizardPage({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="wizard-page">
      <div className="wizard-page-icon">{icon}</div>
      <h1>{title}</h1>
      {children}
    </div>
  );
}
