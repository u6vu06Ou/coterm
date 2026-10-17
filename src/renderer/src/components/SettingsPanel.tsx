import { Bot, Database, Globe, Mic, Palette, Settings, Shield, SlidersHorizontal, X } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import type { AppSettings, AppSettingsPatch, TerminalDashboardEntry } from "@shared/types";
import { toLegacyPtyState } from "@shared/pty-state";
import { AGENT_RATE_LIMIT_DEFAULTS } from "@shared/schema";
import { useI18n } from "../i18n";
import type { MessageKey } from "../i18n";
import { useAppStore } from "../store/app-store";
import { MarkdownContent } from "./MarkdownContent";
import { SettingsCustomModels } from "./SettingsCustomModels";
import {
  SttDraftController,
  type SttDraftField,
  type SttDraftSnapshot,
} from "./settings-stt-draft";
import { isTerminalFontInstalled, TERMINAL_FONT_OPTIONS } from "./terminal-typography";

const CODE_THEME_PREVIEW = `\`\`\`ts
const palette: Theme = "paper-light";
console.log(palette);
\`\`\``;

// Option-id → i18n label. Keys mirror the z.enum ids in src/shared/schema.ts;
// typecheck fails here if a key is missing from the locale files.
const TERMINAL_FONT_LABELS: Record<string, MessageKey> = {
  "default": "settings.terminalFont.default",
  "cascadia-mono": "settings.terminalFont.cascadiaMono",
  "cascadia-code": "settings.terminalFont.cascadiaCode",
  "consolas": "settings.terminalFont.consolas",
  "jetbrains-mono": "settings.terminalFont.jetbrainsMono",
  "fira-code": "settings.terminalFont.firaCode",
  "source-code-pro": "settings.terminalFont.sourceCodePro",
  "geist-mono": "settings.terminalFont.geistMono",
  "ibm-plex-mono": "settings.terminalFont.ibmPlexMono",
  "roboto-mono": "settings.terminalFont.robotoMono",
  "lxgw-wenkai-mono": "settings.terminalFont.lxgwWenkaiMono",
  "sarasa-mono-tc": "settings.terminalFont.sarasaMonoTc",
  "mingliu": "settings.terminalFont.mingliu",
};

const STT_FIELDS: Array<{
  field: SttDraftField;
  actionId: string;
  labelKey: MessageKey;
  helpKey: MessageKey;
  placeholder: string;
  secret?: boolean;
}> = [
  { field: "sttUrl", actionId: "settings.voice-stt-url.change", labelKey: "settings.voice.sttUrl", helpKey: "settings.voice.sttUrl.help", placeholder: "http://127.0.0.1:8189/v1/audio/transcriptions" },
  { field: "sttModel", actionId: "settings.voice-stt-model.change", labelKey: "settings.voice.sttModel", helpKey: "settings.voice.sttModel.help", placeholder: "whisper-1" },
  { field: "sttApiKey", actionId: "settings.voice-stt-api-key.change", labelKey: "settings.voice.sttApiKey", helpKey: "settings.voice.sttApiKey.help", placeholder: "gsk_...", secret: true },
];

// The toggle <button> is written out at each call site (with a literal
// data-action-id) because scripts/lib/ui-action-inventory.ts only discovers
// action IDs on literal lowercase JSX tags — hiding the button inside a
// component makes the gate blind. Only the label pair is shared.
function ToggleLabels({ on }: { on: boolean }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <>
      <span className={on ? "active" : ""}>{t("common.on")}</span>
      <span className={on ? "" : "active"}>{t("common.off")}</span>
    </>
  );
}

const SETTINGS_TAB_STORAGE_KEY = "coterm.settings.tab";

type SettingsTabId =
  | "general"
  | "appearance"
  | "agent"
  | "voice"
  | "browser"
  | "security"
  | "data";

interface SettingsTabDefinition {
  id: SettingsTabId;
  actionId: string;
  labelKey: MessageKey;
  hintKey: MessageKey;
  groupLabelKey: MessageKey | null;
}

// One flat literal array drives the settings rail. scripts/lib/ui-action-inventory.ts
// only resolves data-action-id on literal lowercase tags, so the tab buttons stay in a
// single ARRAY.map(({ actionId }) => ...) shape: that keeps a stable action ID per tab
// for the total-test gate instead of one synthesized template string.
const SETTINGS_TABS: SettingsTabDefinition[] = [
  { id: "general", actionId: "settings.tab.general", labelKey: "settings.tab.general", hintKey: "settings.tab.general.hint", groupLabelKey: "settings.group.app" },
  { id: "appearance", actionId: "settings.tab.appearance", labelKey: "settings.tab.appearance", hintKey: "settings.tab.appearance.hint", groupLabelKey: null },
  { id: "agent", actionId: "settings.tab.agent", labelKey: "settings.tab.agent", hintKey: "settings.tab.agent.hint", groupLabelKey: "settings.group.capability" },
  { id: "voice", actionId: "settings.tab.voice", labelKey: "settings.tab.voice", hintKey: "settings.tab.voice.hint", groupLabelKey: null },
  { id: "browser", actionId: "settings.tab.browser", labelKey: "settings.tab.browser", hintKey: "settings.tab.browser.hint", groupLabelKey: null },
  { id: "security", actionId: "settings.tab.security", labelKey: "settings.tab.security", hintKey: "settings.tab.security.hint", groupLabelKey: "settings.group.system" },
  { id: "data", actionId: "settings.tab.data", labelKey: "settings.tab.data", hintKey: "settings.tab.data.hint", groupLabelKey: null },
];

const SETTINGS_TAB_BY_ID = Object.fromEntries(
  SETTINGS_TABS.map((tab) => [tab.id, tab]),
) as Record<SettingsTabId, SettingsTabDefinition>;

function SettingsTabIcon({ id }: { id: SettingsTabId }): React.JSX.Element {
  if (id === "appearance") return <Palette size={15} />;
  if (id === "agent") return <Bot size={15} />;
  if (id === "voice") return <Mic size={15} />;
  if (id === "browser") return <Globe size={15} />;
  if (id === "security") return <Shield size={15} />;
  if (id === "data") return <Database size={15} />;
  return <SlidersHorizontal size={15} />;
}

function readStoredSettingsTab(): SettingsTabId {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(SETTINGS_TAB_STORAGE_KEY);
  } catch {
    stored = null;
  }
  return SETTINGS_TABS.some((tab) => tab.id === stored) ? (stored as SettingsTabId) : "general";
}

export function SettingsPanel(): React.JSX.Element | null {
  const { settingsOpen, setSettingsOpen, settings, updateSettings, providers } = useAppStore();
  const { t } = useI18n();
  const [backupMessage, setBackupMessage] = useState("");
  const [diagnosticsMessage, setDiagnosticsMessage] = useState("");
  const [showToken, setShowToken] = useState(false);
  // B4 (§12.2): local secret → one-time agent handle. The value lives only in
  // this component state, goes straight to the main-process vault over
  // renderer IPC, and is cleared the moment a handle is issued. The issued
  // handle text is opaque, so showing/copying it never reveals the secret.
  const [browserSecretValue, setBrowserSecretValue] = useState("");
  const [browserSecretHandle, setBrowserSecretHandle] = useState<{ handle: string; expiresInMs: number } | null>(null);
  const [browserSecretError, setBrowserSecretError] = useState("");
  const [dashboard, setDashboard] = useState<TerminalDashboardEntry[]>([]);
  const dashboardTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const sttCtlRef = useRef<SttDraftController | null>(null);
  const [sttSnapshot, setSttSnapshot] = useState<SttDraftSnapshot | null>(null);

  // #60 Bug A: STT fields keep a local draft. Typing never hits IPC; values
  // persist on blur/Enter, Escape restores the persisted value, and invalid
  // drafts stay visible with an inline error instead of snapping back.
  useEffect(() => {
    if (!settingsOpen || !settings) {
      sttCtlRef.current = null;
      return;
    }
    if (!sttCtlRef.current) {
      sttCtlRef.current = new SttDraftController(
        settings.voice,
        async (voicePatch) => {
          const next = await window.aiTerminal.setSettings({ voice: voicePatch });
          useAppStore.setState({ settings: next });
        },
        setSttSnapshot,
      );
      setSttSnapshot(sttCtlRef.current.snapshot());
      return;
    }
    sttCtlRef.current.syncFromPersisted(settings.voice);
  }, [settingsOpen, settings]);

  useEffect(() => {
    if (!settingsOpen) return;
    const fetchDashboard = (): void => {
      void window.aiTerminal.getTerminalDashboard().then(setDashboard).catch(() => undefined);
    };
    fetchDashboard();
    dashboardTimer.current = setInterval(fetchDashboard, 1500);
    const offListChanged = window.aiTerminal.onTerminalListChanged(() => fetchDashboard());
    return () => {
      if (dashboardTimer.current) clearInterval(dashboardTimer.current);
      dashboardTimer.current = null;
      offListChanged();
    };
  }, [settingsOpen]);
  const [activeTab, setActiveTab] = useState<SettingsTabId>(readStoredSettingsTab);
  const panelRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef<Element | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(SETTINGS_TAB_STORAGE_KEY, activeTab);
    } catch {
      // Storage disabled (private mode): the tab choice simply is not remembered.
    }
  }, [activeTab]);

  // SettingsPanel stays mounted for the whole session (App renders it even while
  // closed), so the global Preferences chord lives here: Ctrl/Cmd+, opens, Esc closes.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
        return;
      }
      if (event.key === "Escape" && !event.defaultPrevented && useAppStore.getState().settingsOpen) {
        setSettingsOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setSettingsOpen]);

  // Closing settings hands focus back to whatever opened it (brand gear, palette,
  // shortcut with the caret in a PTY) instead of dropping it to <body>.
  useEffect(() => {
    if (!settingsOpen) {
      const target = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (target instanceof HTMLElement) target.focus();
      return;
    }
    restoreFocusRef.current = document.activeElement;
    panelRef.current?.focus();
  }, [settingsOpen]);

  const onRailKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    const order = SETTINGS_TABS.map((tab) => tab.id);
    const current = Math.max(0, order.indexOf(activeTab));
    let next: number;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (current + 1) % order.length;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = (current - 1 + order.length) % order.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = order.length - 1;
    else return;
    event.preventDefault();
    const tabId = order[next] ?? activeTab;
    setActiveTab(tabId);
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-action-id="settings.tab.${tabId}"]`)?.focus();
    });
  };
  const activeTabMeta = SETTINGS_TAB_BY_ID[activeTab];

  if (!settingsOpen || !settings) return null;
  // #60 P2: send the narrowest patch only — never echo the whole settings
  // snapshot, so non-STT edits can't carry or clobber voice/sttApiKey.
  const patch = <K extends keyof AppSettingsPatch>(key: K, value: NonNullable<AppSettingsPatch[K]>): void => {
    void updateSettings({ [key]: value });
  };
  // Issue #93 rate limits: an empty or unparsable box falls back to the value
  // already in force rather than writing NaN (which the schema would reject).
  const clampRateLimit = (raw: string, fallback: number): number => {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(10_000, Math.max(1, parsed));
  };
  // Pre-1.5.41 settings files (and the dev mock) can carry agentApi without the
  // bucket config; fall back to the shipped defaults so the boxes render numbers.
  const rateLimits = settings.agentApi.rateLimit ?? AGENT_RATE_LIMIT_DEFAULTS;
  const terminalRateLimit = rateLimits.terminalPerMinute;
  const browserRateLimit = rateLimits.browserPerMinute;
  return (
    <div
      data-action-id="settings.backdrop.dismiss"
      data-action-trigger="mousedown"
      className="drawer-backdrop settings-overlay"
      onMouseDown={() => setSettingsOpen(false)}
    >
      <aside
        ref={panelRef}
        data-action-id="settings.drawer.consume"
        data-action-trigger="mousedown"
        className="drawer settings-drawer settings-shell"
        data-tab={activeTab}
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.title")}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span>{t(activeTabMeta.hintKey)}</span>
            <h2>
              <Settings size={20} /> {t("settings.title")} <em>{t(activeTabMeta.labelKey)}</em>
            </h2>
          </div>
          <button data-action-id="settings.close" className="icon-button" aria-label={t("common.close")} onClick={() => setSettingsOpen(false)}>
            <X size={16} />
          </button>
        </header>
        <div className="settings-body">
          <nav className="settings-rail" aria-label={t("settings.title")} onKeyDown={onRailKeyDown}>
            {SETTINGS_TABS.map(({ actionId, groupLabelKey, hintKey, id, labelKey }) => (
              <Fragment key={id}>
                {groupLabelKey ? <span className="settings-rail-label">{t(groupLabelKey)}</span> : null}
                <button
                  data-action-id={actionId}
                  type="button"
                  className={`settings-rail-item ${activeTab === id ? "is-active" : ""}`}
                  aria-current={activeTab === id ? "page" : undefined}
                  title={t(hintKey)}
                  onClick={() => setActiveTab(id)}
                >
                  <SettingsTabIcon id={id} />
                  <span>{t(labelKey)}</span>
                </button>
              </Fragment>
            ))}
          </nav>
          <div className="settings-form">

          <section className="settings-block" data-pane="general">
            <h3 className="settings-pane-heading">{t("settings.tab.general")}</h3>
            <label>
              {t("settings.language")}
              <select data-action-id="settings.language.change" value={settings.locale} onChange={(event) => patch("locale", event.target.value as AppSettings["locale"])}>
                <option value="zh-TW">{t("settings.language.zhTW")}</option>
                <option value="en-US">{t("settings.language.enUS")}</option>
              </select>
              <small>{t("settings.language.help")}</small>
            </label>
          <label>
              {t("settings.theme")}
              <select
                data-action-id="settings.theme.change"
                value={settings.theme}
                onChange={(event) => patch("theme", event.target.value as AppSettings["theme"])}
              >
                <option value="dark">{t("settings.theme.dark")}</option>
                <option value="light">{t("settings.theme.light")}</option>
              </select>
              <small>{t("settings.theme.help")}</small>
            </label>
          </section>
          <section className="settings-block" data-pane="agent">
            <h3 className="settings-pane-heading">{t("settings.tab.agent")}</h3>
            <label>
              {t("settings.provider")}
              <select data-action-id="settings.provider.change" value={settings.defaultProvider} onChange={(event) => patch("defaultProvider", event.target.value)}>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>{provider.label}</option>
                ))}
              </select>
              <small>{t("settings.provider.help")}</small>
            </label>
            <label>
              {t("settings.claudeKeepalive")}
              <select
                data-action-id="settings.claude-keepalive.change"
                value={settings.claudeKeepaliveHours}
                onChange={(event) => patch(
                  "claudeKeepaliveHours",
                  Number(event.target.value) as AppSettings["claudeKeepaliveHours"],
                )}
              >
                <option value={0}>{t("settings.claudeKeepalive.off")}</option>
                <option value={2}>{t("settings.claudeKeepalive.2h")}</option>
                <option value={4}>{t("settings.claudeKeepalive.4h")}</option>
                <option value={6}>{t("settings.claudeKeepalive.6h")}</option>
                <option value={8}>{t("settings.claudeKeepalive.8h")}</option>
              </select>
              <small>{t("settings.claudeKeepalive.help")}</small>
            </label>
            {/* council 2026-09-26 R3 #4: `jev` arrived later than the settings
                schema — older persisted settings have no `jev` key, so read it
                null-safe or this pane crashes on `undefined.enabled`. */}
            <label>
              {t("settings.jev.enabled")}
              <input
                data-action-id="settings.jev.enabled.change"
                type="checkbox"
                checked={settings.jev?.enabled ?? false}
                onChange={(event) =>
                  patch("jev", { enabled: event.target.checked, apiKey: settings.jev?.apiKey ?? "" })
                }
              />
              <small>{t("settings.jev.enabled.help")}</small>
            </label>
            <label>
              {t("settings.jev.apiKey")}
              {/* council R3 #10: commit on blur/Enter only — per-keystroke
                  patch would persist half-typed keys and spam disk + IPC.
                  R4 #5: `key` on the stored value — settings load async, and a
                  plain `defaultValue` input keeps its initial "" and would
                  WIPE the stored key on the first blur. Remounting when the
                  store value lands keeps the draft honest. */}
              <input
                key={`jev-key-${settings.jev?.apiKey ?? ""}`}
                data-action-id="settings.jev.api-key.change"
                type="password"
                defaultValue={settings.jev?.apiKey ?? ""}
                placeholder="vck_..."
                autoComplete="new-password"
                spellCheck={false}
                maxLength={256}
                onBlur={(event) =>
                  patch("jev", { enabled: settings.jev?.enabled ?? false, apiKey: event.target.value })
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                }}
              />
              <small>{t("settings.jev.apiKey.help")}</small>
            </label>
          </section>
          <section className="settings-block" data-pane="general">
            <label>
              {t("settings.shell")}
              <strong className="settings-static-value">PowerShell 7 / pwsh</strong>
              <small>{t("settings.shell.help")}</small>
            </label>
          </section>
          <section className="settings-block" data-pane="appearance">
            <h3 className="settings-pane-heading">{t("settings.tab.appearance")}</h3>
            <label>
              {t("settings.terminalFontSize")}
              <div className="settings-range-control">
                <input
                  data-action-id="settings.terminal-font-size.change"
                  type="range"
                  min={8}
                  max={48}
                  step={1}
                  value={settings.terminalFontSize}
                  aria-label={t("settings.terminalFontSize")}
                  onChange={(event) => patch("terminalFontSize", Number(event.target.value))}
                />
                <output>{settings.terminalFontSize}px</output>
              </div>
              <small>{t("settings.terminalFontSize.help")}</small>
            </label>
            <label className="settings-code-theme-row">
              {t("settings.terminalFont")}
              <select data-action-id="settings.terminal-font.change" value={settings.terminalFont} onChange={(event) => patch("terminalFont", event.target.value as AppSettings["terminalFont"])}>
                {TERMINAL_FONT_OPTIONS.map((option) => {
                  const unavailable = option.cssName !== null && !isTerminalFontInstalled(option.cssName);
                  const labelKey = TERMINAL_FONT_LABELS[option.id] ?? "settings.terminalFont.default";
                  return (
                    <option
                      key={option.id}
                      value={option.id}
                      disabled={unavailable}
                    >
                      {unavailable
                        ? `${t(labelKey)} (${t("settings.terminalFont.unavailable")})`
                        : t(labelKey)}
                    </option>
                  );
                })}
              </select>
              <small>{t("settings.terminalFont.help")}</small>
            </label>
            <label className="settings-code-theme-row">
              {t("settings.codeTheme")}
              <select data-action-id="settings.code-theme.change" value={settings.codeTheme} onChange={(event) => patch("codeTheme", event.target.value as AppSettings["codeTheme"])}>
                <option value="auto">{t("settings.codeTheme.auto")}</option>
                <option value="github-light">{t("settings.codeTheme.githubLight")}</option>
                <option value="github-dark">{t("settings.codeTheme.githubDark")}</option>
                <option value="solarized-light">{t("settings.codeTheme.solarizedLight")}</option>
                <option value="solarized-dark">{t("settings.codeTheme.solarizedDark")}</option>
                <option value="dracula">{t("settings.codeTheme.dracula")}</option>
                <option value="monokai">{t("settings.codeTheme.monokai")}</option>
                <option value="nord">{t("settings.codeTheme.nord")}</option>
                <option value="aurora-x">{t("settings.codeTheme.auroraX")}</option>
              </select>
              <MarkdownContent
                className="settings-code-theme-preview final-answer"
                markdown={CODE_THEME_PREVIEW}
              />
              <small>{t("settings.codeTheme.help")}</small>
            </label>
            <label>
              {t("settings.terminalTheme")}
              <select data-action-id="settings.terminal-theme.change" value={settings.terminalTheme} onChange={(event) => patch("terminalTheme", event.target.value as AppSettings["terminalTheme"])}>
                <option value="auto">{t("settings.terminalTheme.auto")}</option>
                <option value="github-light">{t("settings.codeTheme.githubLight")}</option>
                <option value="github-dark">{t("settings.codeTheme.githubDark")}</option>
                <option value="one-half-light">{t("settings.terminalTheme.oneHalfLight")}</option>
                <option value="one-half-dark">{t("settings.terminalTheme.oneHalfDark")}</option>
                <option value="solarized-light">{t("settings.codeTheme.solarizedLight")}</option>
                <option value="solarized-dark">{t("settings.codeTheme.solarizedDark")}</option>
                <option value="dracula">{t("settings.codeTheme.dracula")}</option>
                <option value="monokai">{t("settings.codeTheme.monokai")}</option>
                <option value="nord">{t("settings.codeTheme.nord")}</option>
              </select>
              <small>{t("settings.terminalTheme.help")}</small>
            </label>
          </section>
          <section className="settings-block" data-pane="general">
            <label>
              {t("settings.permission")}
              <select data-action-id="settings.permission.change" value={settings.permissionPreset} onChange={(event) => patch("permissionPreset", event.target.value as AppSettings["permissionPreset"])}>
                <option value="ask">{t("settings.permission.ask")}</option>
                <option value="trusted">{t("settings.permission.trusted")}</option>
              </select>
            </label>
          </section>
          <section className="settings-block" data-pane="agent">
            <label>
              {t("settings.proxy")}
              <input data-action-id="settings.proxy.change" value={settings.proxyUrl} onChange={(event) => patch("proxyUrl", event.target.value)} />
            </label>
            <label className="settings-toggle-row">
              {t("settings.agentDoneToast")}
              <button
                data-action-id="settings.agent-done-toast.toggle"
                type="button"
                className={`settings-toggle ${settings.agentDoneToast ? "on" : ""}`}
                aria-pressed={settings.agentDoneToast}
                onClick={() => patch("agentDoneToast", !settings.agentDoneToast)}
              >
                <ToggleLabels on={settings.agentDoneToast} />
              </button>
              <small>{t("settings.agentDoneToast.help")}</small>
            </label>
            <SettingsCustomModels />
          </section>
          <section className="settings-block" data-pane="security">
            <h3 className="settings-pane-heading">{t("settings.tab.security")}</h3>
            <label className="settings-toggle-row">
              {t("settings.searchIndex")}
              <button
                data-action-id="settings.search-index.toggle"
                type="button"
                className={`settings-toggle ${settings.searchIndexEnabled ? "on" : ""}`}
                aria-pressed={settings.searchIndexEnabled}
                onClick={() => patch("searchIndexEnabled", !settings.searchIndexEnabled)}
              >
                <ToggleLabels on={settings.searchIndexEnabled} />
              </button>
              <small>{t("settings.searchIndex.help")}</small>
            </label>
            <label className="settings-toggle-row">
              {t("settings.agentApi")}
              <button
                data-action-id="settings.agent-api.toggle"
                type="button"
                className={`settings-toggle ${settings.agentApi.enabled ? "on" : ""}`}
                aria-pressed={settings.agentApi.enabled}
                onClick={() => patch("agentApi", { enabled: !settings.agentApi.enabled })}
              >
                <ToggleLabels on={settings.agentApi.enabled} />
              </button>
              <small>{t("settings.agentApi.help")}</small>
            </label>
            {settings.agentApi.enabled && (
              <label>
                {t("settings.agentToken")}
                <div className="token-row">
                  <code>{showToken ? settings.agentApi.token : "•".repeat(16)}</code>
                  <button data-action-id="settings.agent-token.toggle" onClick={() => setShowToken((s) => !s)}>{showToken ? t("settings.agentToken.hide") : t("settings.agentToken.show")}</button>
                </div>
                <small>{t("settings.agentToken.help")}</small>
              </label>
            )}
            {settings.agentApi.enabled && (
              <div className="settings-rate-limits">
                <label>
                  {t("settings.agentRateLimit.terminal")}
                  <input
                    data-action-id="settings.agent-rate-limit.terminal.change"
                    type="number"
                    min={1}
                    max={10000}
                    value={terminalRateLimit}
                    onChange={(event) => patch("agentApi", { rateLimit: { ...rateLimits, terminalPerMinute: clampRateLimit(event.target.value, terminalRateLimit) } })}
                  />
                </label>
                <label>
                  {t("settings.agentRateLimit.browser")}
                  <input
                    data-action-id="settings.agent-rate-limit.browser.change"
                    type="number"
                    min={1}
                    max={10000}
                    value={browserRateLimit}
                    onChange={(event) => patch("agentApi", { rateLimit: { ...rateLimits, browserPerMinute: clampRateLimit(event.target.value, browserRateLimit) } })}
                  />
                </label>
                <small>{t("settings.agentRateLimit.help")}</small>
              </div>
            )}
          </section>
          <section className="settings-block" data-pane="browser">
            <h3 className="settings-pane-heading">{t("settings.tab.browser")}</h3>
            <label className="settings-toggle-row">
              {t("settings.browserNetwork")}
              <select
                data-action-id="settings.browser-network.mode.change"
                value={settings.browserNetwork.mode}
                onChange={(event) => patch("browserNetwork", { mode: event.target.value as AppSettings["browserNetwork"]["mode"] })}
              >
                <option value="block">{t("settings.browserNetwork.block")}</option>
                <option value="allow-private">{t("settings.browserNetwork.allowPrivate")}</option>
                <option value="allow-hosts">{t("settings.browserNetwork.allowHosts")}</option>
              </select>
              <small>{t("settings.browserNetwork.help")}</small>
            </label>
            {settings.browserNetwork.mode === "allow-hosts" && (
              <label>
                {t("settings.browserNetwork.allowHosts")}
                <textarea
                  data-action-id="settings.browser-network.hosts.change"
                  rows={3}
                  value={settings.browserNetwork.allowHosts.join("\n")}
                  onChange={(event) => patch("browserNetwork", { allowHosts: event.target.value.split("\n").map((h) => h.trim().toLowerCase()).filter(Boolean) })}
                />
                <small>{t("settings.browserNetwork.allowHosts.help")}</small>
              </label>
            )}
            {settings.browserNetwork.mode !== "block" && (
              <small className="settings-warning">{t("settings.browserNetwork.risk")}</small>
            )}
            <label className="settings-toggle-row">
              {t("settings.browser.superpowersP0")}
              <button
                data-action-id="settings.browser.superpowers-p0.toggle"
                type="button"
                className={`settings-toggle ${settings.browser.superpowersP0 ? "on" : ""}`}
                aria-pressed={settings.browser.superpowersP0 === true}
                onClick={() => patch("browser", { superpowersP0: !settings.browser.superpowersP0 })}
              >
                <ToggleLabels on={settings.browser.superpowersP0 === true} />
              </button>
              <small>{t("settings.browser.superpowersP0.help")}</small>
            </label>
            <label className="settings-toggle-row">
              {t("settings.browser.superpowersP1")}
              <button
                data-action-id="settings.browser.superpowers-p1.toggle"
                type="button"
                className={`settings-toggle ${settings.browser.superpowersP1 ? "on" : ""}`}
                aria-pressed={settings.browser.superpowersP1 === true}
                onClick={() => patch("browser", { superpowersP1: !settings.browser.superpowersP1 })}
              >
                <ToggleLabels on={settings.browser.superpowersP1 === true} />
              </button>
              <small>{t("settings.browser.superpowersP1.help")}</small>
            </label>
            <label className="settings-toggle-row">
              {t("settings.agentBrowserWindow")}
              <select
                data-action-id="settings.agentBrowserWindow.change"
                value={settings.agentBrowserWindow}
                onChange={(event) => patch("agentBrowserWindow", event.target.value as AppSettings["agentBrowserWindow"])}
              >
                <option value="popout">{t("settings.agentBrowserWindow.popout")}</option>
                <option value="embedded">{t("settings.agentBrowserWindow.embedded")}</option>
              </select>
              <small>{t("settings.agentBrowserWindow.help")}</small>
            </label>
            <label className="settings-toggle-row">
              {t("settings.agentBrowserFullAccess")}
              <button
                data-action-id="settings.agentBrowserFullAccess.toggle"
                type="button"
                className={`settings-toggle ${settings.agentBrowserFullAccess ? "on" : ""}`}
                aria-pressed={settings.agentBrowserFullAccess === true}
                onClick={() => patch("agentBrowserFullAccess", !settings.agentBrowserFullAccess)}
              >
                <ToggleLabels on={settings.agentBrowserFullAccess === true} />
              </button>
              <small>{t("settings.agentBrowserFullAccess.help")}</small>
            </label>
            {settings.agentBrowserFullAccess === true && (
              <small className="settings-warning">{t("settings.agentBrowserFullAccess.warning")}</small>
            )}
            {window.aiTerminal.isBrowser !== true && (
              <fieldset className="settings-browser-secret">
                <legend>{t("settings.browser.issueSecret")}</legend>
                <input
                  data-action-id="settings.browser-secret.issue.value.change"
                  type="password"
                  autoComplete="off"
                  aria-label={t("settings.browser.issueSecret")}
                  placeholder={t("settings.browser.issueSecret.placeholder")}
                  value={browserSecretValue}
                  onChange={(event) => setBrowserSecretValue(event.target.value)}
                />
                <div className="settings-browser-secret-actions">
                  <button
                    data-action-id="settings.browser-secret.issue.submit"
                    type="button"
                    disabled={browserSecretValue === ""}
                    onClick={() => {
                      setBrowserSecretError("");
                      void window.aiTerminal
                        .issueBrowserSecret({ value: browserSecretValue })
                        .then((issued) => { setBrowserSecretHandle(issued); setBrowserSecretValue(""); })
                        .catch(() => setBrowserSecretError(t("settings.browser.issueSecret.failed")));
                    }}
                  >
                    {t("settings.browser.issueSecret.submit")}
                  </button>
                  {browserSecretHandle !== null && (
                    <code data-action-id="settings.browser-secret.issue.handle" className="settings-browser-secret-handle">{browserSecretHandle.handle}</code>
                  )}
                </div>
                {browserSecretHandle !== null && (
                  <small>{t("settings.browser.issueSecret.issued", { seconds: String(Math.round(browserSecretHandle.expiresInMs / 1000)) })}</small>
                )}
                {browserSecretError !== "" && <small className="settings-warning">{browserSecretError}</small>}
                <small>{t("settings.browser.issueSecret.help")}</small>
              </fieldset>
            )}
          </section>
          <section className="settings-block" data-pane="voice">
            <h3 className="settings-pane-heading">{t("settings.tab.voice")}</h3>
            <label className="settings-toggle-row">
              {t("settings.voice")}
              <button
                data-action-id="settings.voice.toggle"
                type="button"
                className={`settings-toggle ${settings.voice?.enabled ? "on" : ""}`}
                aria-pressed={settings.voice?.enabled === true}
                onClick={() => patch("voice", { enabled: !settings.voice?.enabled })}
              >
                <ToggleLabels on={settings.voice?.enabled === true} />
              </button>
              <small>{t("settings.voice.help")}</small>
            </label>
            {settings.voice?.enabled && (
              <label>
                {t("settings.voiceLanguage")}
                <select
                  data-action-id="settings.voice-language.change"
                  value={settings.voice.lang}
                  onChange={(event) => patch("voice", { lang: event.target.value as "zh-TW" | "zh-CN" | "en-US" })}
                >
                  <option value="zh-TW">{t("settings.voiceLanguage.zhTW")}</option>
                  <option value="zh-CN">{t("settings.voiceLanguage.zhCN")}</option>
                  <option value="en-US">{t("settings.voiceLanguage.enUS")}</option>
                </select>
                <small>⚠ {t("settings.voice.warning")}</small>
              </label>
            )}
            {settings.voice?.enabled && (
              <label>
                {t("settings.voice.sttLanguageMode")}
                <select
                  data-action-id="settings.voice-stt-language-mode.change"
                  value={settings.voice.sttLanguageMode}
                  onChange={(event) => patch("voice", {
                    sttLanguageMode: event.target.value as AppSettings["voice"]["sttLanguageMode"],
                  })}
                >
                  <option value="auto">{t("settings.voice.sttLanguageMode.auto")}</option>
                  <option value="zh-TW">{t("settings.voiceLanguage.zhTW")}</option>
                  <option value="zh-CN">{t("settings.voiceLanguage.zhCN")}</option>
                  <option value="en-US">{t("settings.voiceLanguage.enUS")}</option>
                </select>
                <small>{t("settings.voice.sttLanguageMode.help")}</small>
              </label>
            )}
            {settings.voice?.enabled && (
              <label>
                {t("settings.voice.responseLanguage")}
                <select
                  data-action-id="settings.voice-response-language.change"
                  value={settings.voice.responseLanguage}
                  onChange={(event) => patch("voice", {
                    responseLanguage: event.target.value as AppSettings["voice"]["responseLanguage"],
                  })}
                >
                  <option value="zh-TW">{t("settings.voiceLanguage.zhTW")}</option>
                  <option value="zh-CN">{t("settings.voiceLanguage.zhCN")}</option>
                  <option value="en-US">{t("settings.voiceLanguage.enUS")}</option>
                </select>
                <small>{t("settings.voice.responseLanguage.help")}</small>
              </label>
            )}
            {settings.voice?.enabled && STT_FIELDS.map(({ field, actionId, labelKey, helpKey, placeholder, secret }) => {
              const errorKey = sttSnapshot?.errors[field];
              const draftValue = sttSnapshot?.values[field] ?? (settings.voice[field] ?? "");
              const ctl = (): SttDraftController | null => sttCtlRef.current;
              return (
                <label key={field}>
                  {t(labelKey)}
                  <input
                    data-action-id={actionId}
                    type={secret ? "password" : "text"}
                    value={draftValue}
                    placeholder={placeholder}
                    aria-invalid={errorKey ? true : undefined}
                    onChange={(event) => ctl()?.change(field, event.target.value)}
                    onBlur={() => void ctl()?.commit(field)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void ctl()?.commit(field);
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        ctl()?.cancel(field);
                      }
                    }}
                  />
                  {secret && draftValue !== "" && (
                    <button
                      data-action-id="settings.voice-stt-api-key.clear"
                      type="button"
                      className="settings-inline-action"
                      onClick={() => {
                        ctl()?.change("sttApiKey", "");
                        void ctl()?.commit("sttApiKey");
                      }}
                    >
                      {t("settings.voice.sttApiKey.clear")}
                    </button>
                  )}
                  {errorKey && <small className="settings-inline-error" role="alert">{t(errorKey)}</small>}
                  {!errorKey && sttSnapshot?.saved[field] === true && (
                    <small className="settings-inline-saved">{t("settings.voice.draft.saved")}</small>
                  )}
                  <small>{t(helpKey)}</small>
                </label>
              );
            })}
            {settings.voice?.enabled && (
              <label className="settings-toggle-row">
                {t("settings.voice.streamingDictation")}
                <button
                  data-action-id="settings.voice-streaming.toggle"
                  type="button"
                  className={`settings-toggle ${settings.voice?.streamingDictation ? "on" : ""}`}
                  aria-pressed={settings.voice?.streamingDictation === true}
                  onClick={() => patch("voice", { streamingDictation: !settings.voice?.streamingDictation })}
                >
                  <ToggleLabels on={settings.voice?.streamingDictation === true} />
                </button>
                <small>{t("settings.voice.streamingDictation.help")}</small>
              </label>
            )}
            {settings.voice?.enabled && (
              <label className="settings-toggle-row">
                {t("settings.voice.live")}
                <button
                  data-action-id="settings.voice-live.toggle"
                  type="button"
                  className={`settings-toggle ${settings.voice.live.enabled ? "on" : ""}`}
                  aria-pressed={settings.voice.live.enabled === true}
                  onClick={() => patch("voice", { live: { enabled: !settings.voice.live.enabled } })}
                >
                  <ToggleLabels on={settings.voice.live.enabled === true} />
                </button>
                <small>{t("settings.voice.live.help")}</small>
              </label>
            )}
            {settings.voice?.enabled && settings.voice.live.enabled && (
              <label>
                {t("settings.voice.live.provider")}
                <select
                  data-action-id="settings.voice-live-provider.change"
                  value={settings.voice.live.provider}
                  onChange={(event) => patch("voice", { live: { provider: event.target.value as "cascade" | "gemini" } })}
                >
                  <option value="cascade">{t("settings.voice.live.provider.cascade")}</option>
                  <option value="gemini">{t("settings.voice.live.provider.gemini")}</option>
                </select>
                <small>{t("settings.voice.live.provider.help")}</small>
              </label>
            )}
            {settings.voice?.enabled && settings.voice.live.enabled && settings.voice.live.provider === "gemini" && (
              <label>
                {t("settings.voice.live.geminiApiKey")}
                <input
                  data-action-id="settings.voice-live-gemini-key.change"
                  type="password"
                  value={settings.voice.live.geminiApiKey}
                  placeholder="AIza..."
                  onChange={(event) => patch("voice", { live: { geminiApiKey: event.target.value } })}
                />
                <small>{t("settings.voice.live.geminiApiKey.help")}</small>
              </label>
            )}
            {settings.voice?.enabled && settings.voice.live.enabled && settings.voice.live.provider === "gemini" && (
              <label>
                {t("settings.voice.live.geminiModel")}
                <input
                  data-action-id="settings.voice-live-gemini-model.change"
                  type="text"
                  value={settings.voice.live.geminiModel}
                  placeholder="gemini-3.1-flash-live-preview"
                  onChange={(event) => patch("voice", { live: { geminiModel: event.target.value } })}
                />
                <small>{t("settings.voice.live.geminiModel.help")}</small>
              </label>
            )}
            {settings.voice?.enabled && settings.voice.live.enabled && (
              <label>
                {t("settings.voice.live.serverUrl")}
                <input
                  data-action-id="settings.voice-live-server-url.change"
                  type="text"
                  value={settings.voice.live.serverUrl}
                  placeholder="ws://127.0.0.1:7880"
                  onChange={(event) => patch("voice", { live: { serverUrl: event.target.value } })}
                />
                <small>{t("settings.voice.live.serverUrl.help")}</small>
              </label>
            )}
            {settings.voice?.enabled && settings.voice.live.enabled && (
              <label>
                {t("settings.voice.live.ttsVoice")}
                <input
                  data-action-id="settings.voice-live-tts-voice.change"
                  type="text"
                  value={settings.voice.live.ttsVoice}
                  placeholder="zh-TW-HsiaoChenNeural"
                  onChange={(event) => patch("voice", { live: { ttsVoice: event.target.value } })}
                />
                <small>{t("settings.voice.live.ttsVoice.help")}</small>
              </label>
            )}
            {settings.voice?.enabled && settings.voice.live.enabled && (
              <small data-action-id="settings.voice-live.credentials">
                {settings.voice.live.apiKey !== "" && settings.voice.live.apiSecret !== ""
                  ? t("settings.voice.live.credentials.stored")
                  : t("settings.voice.live.credentials.pending")}
              </small>
            )}
          </section>
          <section className="settings-block" data-pane="data">
            <h3 className="settings-pane-heading">{t("settings.tab.data")}</h3>
            <div className="terminal-dashboard">
              <strong>{t("settings.dashboard.title")}</strong>
              <small>{t("settings.dashboard.help")}</small>
              <div className="dashboard-stats">
                <span>{t("settings.dashboard.sessions", { count: dashboard.length })}</span>
                <span>{t("settings.dashboard.running", { count: dashboard.filter((d) => toLegacyPtyState(d.ptyState) === "llm-running").length })}</span>
                <span>{t("settings.dashboard.ready", { count: dashboard.filter((d) => toLegacyPtyState(d.ptyState) === "shell-ready").length })}</span>
                <span>{t("settings.dashboard.idle", { count: dashboard.filter((d) => toLegacyPtyState(d.ptyState) === "idle").length })}</span>
              </div>
              <ul className="dashboard-list">
                {dashboard.length === 0 && (
                  <li className="dashboard-empty">{t("settings.dashboard.empty")}</li>
                )}
                {dashboard.map((entry) => (
                  <li
                    data-action-id="settings.dashboard.select"
                    key={entry.id}
                    className={`dashboard-row ${entry.selected ? "selected" : ""}`}
                    onClick={() => void window.aiTerminal.selectTile({ terminalId: entry.id }).catch(() => undefined)}
                  >
                    <span className={`dashboard-dot dot-${entry.ptyState}`} />
                    <span className="dashboard-cwd" title={entry.cwd}>
                      {entry.cwd.replace(/\\/g, "/").split("/").pop() ?? entry.cwd}
                    </span>
                    <span className="dashboard-title" title={entry.title}>{entry.title}</span>
                    <span className="dashboard-id">#{entry.id.slice(-6)} · pid {entry.pid || "—"}</span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
          <section className="settings-block" data-pane="security">
            <div className="privacy-note">
              {t("settings.privacy")}
            </div>
          </section>
          <section className="settings-block" data-pane="data">
            <div className="backup-actions">
              <div>
                <strong>{t("settings.backup.title")}</strong>
                <small>{t("settings.backup.help")}</small>
              </div>
              <button
                data-action-id="settings.backup.create"
                onClick={() =>
                  void window.aiTerminal.createBackup().then((path) => {
                    if (path) setBackupMessage(t("settings.backup.created", { path }));
                  })
                }
              >
                {t("settings.backup.create")}
              </button>
              <button
                data-action-id="settings.backup.restore"
                onClick={() => {
                  if (!window.confirm(t("settings.backup.confirm"))) return;
                  void window.aiTerminal.restoreBackup();
                }}
              >
                {t("settings.backup.restore")}
              </button>
            </div>
            {backupMessage && <div className="settings-message">{backupMessage}</div>}
            <div className="backup-actions">
              <div>
                <strong>{t("settings.diagnostics.title")}</strong>
                <small>{t("settings.diagnostics.help")}</small>
              </div>
              <button
                data-action-id="settings.diagnostics.export"
                onClick={() =>
                  void window.aiTerminal.exportDiagnostics().then((path) => {
                    if (path) setDiagnosticsMessage(t("settings.diagnostics.exported", { path }));
                  })
                }
              >
                {t("settings.diagnostics.export")}
              </button>
            </div>
            {diagnosticsMessage && <div className="settings-message">{diagnosticsMessage}</div>}
          </section>
          </div>
        </div>
      </aside>
    </div>
  );
}
