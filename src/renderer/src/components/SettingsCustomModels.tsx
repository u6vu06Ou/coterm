import { useState } from "react";
import type { CustomProfileEntry } from "@shared/schema";
import { useI18n } from "../i18n";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../store/app-store";
import {
  EMPTY_CUSTOM_MODEL_DRAFT,
  applyHarnessPrefix,
  draftFromEntry,
  removeCustomProfile,
  upsertCustomProfile,
  validateCustomModelDraft,
  type CustomModelDraft,
  type CustomModelDraftErrors,
  type CustomModelEnvPair,
  type CustomModelHarness,
} from "./settings-custom-model-draft";

// Hot model registry (stage 3): the "custom models" block of the settings
// panel. All logic lives in settings-custom-model-draft.ts; this file only
// renders. Every interactive element carries a literal data-action-id on a
// lowercase JSX tag (ui-action-inventory gate — see the STT precedent).
//
// Secret rule: the stored authToken is never rendered. Editing an entry that
// has one shows "已設定" plus a Replace button; the password box stays empty
// and an untouched box preserves the persisted token on save.

export function SettingsCustomModels(): React.JSX.Element | null {
  const { settings, updateSettings } = useAppStore(useShallow((s) => ({
    settings: s.settings,
    updateSettings: s.updateSettings,
  })));
  const { t } = useI18n();
  const [draft, setDraft] = useState<CustomModelDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<CustomModelDraftErrors>({});
  const [tokenReplace, setTokenReplace] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [formError, setFormError] = useState("");
  if (!settings) return null;
  const profiles: Readonly<Record<string, CustomProfileEntry>> = settings.customProfiles ?? {};

  const resetForm = (): void => {
    setDraft(null);
    setEditingId(null);
    setErrors({});
    setTokenReplace(false);
    setEnvOpen(false);
  };
  const startAdd = (): void => {
    setDraft({ ...EMPTY_CUSTOM_MODEL_DRAFT, env: [] });
    setEditingId(null);
    setErrors({});
    setTokenReplace(false);
    setEnvOpen(false);
    setMessage("");
    setFormError("");
  };
  const startEdit = (id: string): void => {
    const entry = profiles[id];
    if (!entry) return;
    setDraft(draftFromEntry(id, entry));
    setEditingId(id);
    setErrors({});
    setTokenReplace(false);
    setEnvOpen(false);
    setMessage("");
    setFormError("");
  };
  const setField = <F extends keyof CustomModelDraft>(field: F, value: CustomModelDraft[F]): void => {
    setDraft((current) => (current ? { ...current, [field]: value } : current));
  };
  const setEnvPair = (index: number, pair: CustomModelEnvPair): void => {
    setDraft((current) => {
      if (!current) return current;
      const env = current.env.map((existing, i) => (i === index ? pair : existing));
      return { ...current, env };
    });
  };
  const save = (): void => {
    if (!draft) return;
    const result = validateCustomModelDraft(draft, { profiles, editingId });
    if (!result.ok) {
      setErrors(result.errors);
      if (result.errors.env !== undefined) setEnvOpen(true);
      return;
    }
    setErrors({});
    const savedId = result.id;
    void updateSettings({ customProfiles: upsertCustomProfile(profiles, savedId, result.entry, editingId) })
      .then(() => {
        setMessage(t("settings.customModel.saved", { id: savedId }));
        resetForm();
      })
      .catch(() => setFormError(t("settings.customModel.draft.error.persist")));
  };
  const remove = (id: string): void => {
    if (!window.confirm(t("settings.customModel.remove.confirm", { id }))) return;
    void updateSettings({ customProfiles: removeCustomProfile(profiles, id) })
      .then(() => {
        setMessage(t("settings.customModel.removed", { id }));
        if (editingId === id) resetForm();
      })
      .catch(() => setFormError(t("settings.customModel.draft.error.persist")));
  };

  const tokenPreset = editingId !== null && profiles[editingId]?.authToken !== undefined;
  const entries = Object.entries(profiles);

  return (
    <fieldset className="settings-custom-models">
      <legend>{t("settings.customModel.title")}</legend>
      <small>{t("settings.customModel.help")}</small>
      <ul className="settings-custom-model-list">
        {entries.length === 0 && <li className="dashboard-empty">{t("settings.customModel.empty")}</li>}
        {entries.map(([id, entry]) => (
          <li key={id} className="settings-custom-model-row">
            <span className="settings-custom-model-label">{entry.label ?? id}</span>
            <code>{id}</code>
            <button data-action-id="settings.custom-model.edit" type="button" onClick={() => startEdit(id)}>
              {t("settings.customModel.edit")}
            </button>
            <button data-action-id="settings.custom-model.remove" type="button" onClick={() => remove(id)}>
              {t("settings.customModel.remove")}
            </button>
          </li>
        ))}
      </ul>
      {draft === null ? (
        <button data-action-id="settings.custom-model.add" type="button" onClick={startAdd}>
          {t("settings.customModel.add")}
        </button>
      ) : (
        <div className="settings-custom-model-form">
          <label>
            {t("settings.customModel.harness")}
            <select
              data-action-id="settings.custom-model.harness.change"
              value={draft.harness}
              onChange={(event) => {
                const harness = event.target.value as CustomModelHarness;
                setDraft((current) =>
                  current ? { ...current, harness, id: applyHarnessPrefix(harness, current.id) } : current,
                );
              }}
            >
              <option value="claude">{t("settings.customModel.harness.claude")}</option>
              <option value="codex">{t("settings.customModel.harness.codex")}</option>
            </select>
          </label>
          <label>
            {t("settings.customModel.id")}
            <input
              data-action-id="settings.custom-model.id.change"
              value={draft.id}
              onChange={(event) => setField("id", event.target.value)}
              aria-invalid={errors.id !== undefined || undefined}
            />
            <small>{t("settings.customModel.id.help")}</small>
            {errors.id !== undefined && <small className="settings-warning">{t(errors.id)}</small>}
          </label>
          <label>
            {t("settings.customModel.label")}
            <input
              data-action-id="settings.custom-model.label.change"
              value={draft.label}
              onChange={(event) => setField("label", event.target.value)}
              aria-invalid={errors.label !== undefined || undefined}
            />
            {errors.label !== undefined && <small className="settings-warning">{t(errors.label)}</small>}
          </label>
          <label>
            {t("settings.customModel.model")}
            <input
              data-action-id="settings.custom-model.model.change"
              value={draft.model}
              onChange={(event) => setField("model", event.target.value)}
              aria-invalid={errors.model !== undefined || undefined}
            />
            <small>{t("settings.customModel.model.help")}</small>
            {errors.model !== undefined && <small className="settings-warning">{t(errors.model)}</small>}
          </label>
          <label>
            {t("settings.customModel.baseUrl")}
            <input
              data-action-id="settings.custom-model.base-url.change"
              value={draft.baseUrl}
              placeholder="https://…"
              onChange={(event) => setField("baseUrl", event.target.value)}
              aria-invalid={errors.baseUrl !== undefined || undefined}
            />
            <small>{t("settings.customModel.baseUrl.help")}</small>
            {errors.baseUrl !== undefined && <small className="settings-warning">{t(errors.baseUrl)}</small>}
          </label>
          <label>
            {t("settings.customModel.authToken")}
            {tokenPreset && !tokenReplace ? (
              <div className="token-row">
                <code>••••••••</code>
                <button data-action-id="settings.custom-model.auth-token.replace" type="button" onClick={() => setTokenReplace(true)}>
                  {t("settings.customModel.authToken.replace")}
                </button>
              </div>
            ) : (
              <input
                data-action-id="settings.custom-model.auth-token.change"
                type="password"
                autoComplete="off"
                value={draft.authToken}
                onChange={(event) => setField("authToken", event.target.value)}
              />
            )}
            <small>{t("settings.customModel.authToken.help")}</small>
            {errors.authToken !== undefined && <small className="settings-warning">{t(errors.authToken)}</small>}
          </label>
          <label>
            {t("settings.customModel.local")}
            <select
              data-action-id="settings.custom-model.local.change"
              value={draft.local ? "proxy" : "direct"}
              onChange={(event) => setField("local", event.target.value === "proxy")}
            >
              <option value="proxy">{t("settings.customModel.local.proxy")}</option>
              <option value="direct">{t("settings.customModel.local.direct")}</option>
            </select>
            <small>{t("settings.customModel.local.help")}</small>
          </label>
          <label>
            {t("settings.customModel.contextWindow")}
            <input
              data-action-id="settings.custom-model.context-window.change"
              type="number"
              min={1}
              value={draft.contextWindow}
              onChange={(event) => setField("contextWindow", event.target.value)}
              aria-invalid={errors.contextWindow !== undefined || undefined}
            />
            <small>{t("settings.customModel.contextWindow.help")}</small>
            {errors.contextWindow !== undefined && <small className="settings-warning">{t(errors.contextWindow)}</small>}
          </label>
          <label>
            {t("settings.customModel.reasoningEffort")}
            <select
              data-action-id="settings.custom-model.reasoning-effort.change"
              value={draft.reasoningEffort}
              onChange={(event) => setField("reasoningEffort", event.target.value as CustomModelDraft["reasoningEffort"])}
            >
              <option value="">{t("settings.customModel.reasoningEffort.unset")}</option>
              <option value="low">low</option>
              <option value="high">high</option>
              <option value="max">max</option>
            </select>
          </label>
          <button data-action-id="settings.custom-model.env.toggle" type="button" onClick={() => setEnvOpen((open) => !open)}>
            {t("settings.customModel.env.toggle")}
          </button>
          {envOpen && (
            <div className="settings-custom-model-env">
              <small>{t("settings.customModel.env.help")}</small>
              {draft.env.map((pair, index) => (
                <div key={`env-${index}`} className="settings-custom-model-env-row">
                  <input
                    data-action-id="settings.custom-model.env-key.change"
                    value={pair.key}
                    placeholder={t("settings.customModel.env.key")}
                    onChange={(event) => setEnvPair(index, { ...pair, key: event.target.value })}
                  />
                  <input
                    data-action-id="settings.custom-model.env-value.change"
                    value={pair.value}
                    placeholder={t("settings.customModel.env.value")}
                    onChange={(event) => setEnvPair(index, { ...pair, value: event.target.value })}
                  />
                  <button
                    data-action-id="settings.custom-model.env.remove"
                    type="button"
                    onClick={() => setDraft((current) => (current ? { ...current, env: current.env.filter((_, i) => i !== index) } : current))}
                  >
                    {t("settings.customModel.env.remove")}
                  </button>
                </div>
              ))}
              <button
                data-action-id="settings.custom-model.env.add"
                type="button"
                onClick={() => setDraft((current) => (current ? { ...current, env: [...current.env, { key: "", value: "" }] } : current))}
              >
                {t("settings.customModel.env.add")}
              </button>
              {errors.env !== undefined && <small className="settings-warning">{t(errors.env)}</small>}
            </div>
          )}
          <div className="settings-custom-model-actions">
            <button data-action-id="settings.custom-model.save" type="button" onClick={save}>
              {t("settings.customModel.save")}
            </button>
            <button data-action-id="settings.custom-model.cancel" type="button" onClick={resetForm}>
              {t("settings.customModel.cancel")}
            </button>
          </div>
        </div>
      )}
      {message !== "" && <div className="settings-message">{message}</div>}
      {formError !== "" && <div className="settings-warning">{formError}</div>}
    </fieldset>
  );
}
