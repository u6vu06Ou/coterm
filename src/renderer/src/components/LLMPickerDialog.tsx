import { Check, Copy, Crown, RefreshCw, Terminal as TerminalIcon, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { pickerBackendGroups, type PickerBackendRow } from "@shared/agent-options";
import type { AgentOption, ProviderProbeState } from "@shared/types";
import { useAppStore } from "../store/app-store";
import { useI18n } from "../i18n";
import { interactiveAgent, type InteractiveAgentId } from "./interactive-agent";

// Worst-case-first ordering: a family counts as online if any member answers,
// and a retired member never lifts the row up.
const STATE_ORDER: Record<ProviderProbeState, number> = {
  online: 0,
  rate_limited: 1,
  retired: 2,
  offline: 3,
  unknown: 4,
};

const HARNESS_LABEL: Record<AgentOption["harness"], string> = {
  claude: "Claude",
  codex: "Codex",
  other: "CLI",
};

export function LLMPickerDialog(): React.JSX.Element | null {
  const { providers, pickerState, setPickerState, settings, agentOptions, openTile } = useAppStore();
  const probing = useAppStore((s) => s.providersProbing);
  const refreshProviders = useAppStore((s) => s.refreshProviders);
  const { t } = useI18n();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pickerState) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        setPickerState(null);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [pickerState, setPickerState]);

  // Opening the dialog must never turn into a full-list scan: main spends this
  // round's ping budget on the rows the user is looking at, and the header
  // button is the only thing that forces a re-probe past the TTLs.
  useEffect(() => {
    if (!pickerState) return;
    const state = useAppStore.getState();
    const focus = pickerBackendGroups(state.agentOptions)
      .flatMap((row) => row.members.map((member) => member.id))
      .slice(0, 24);
    void state.refreshProviders({ focus });
  }, [pickerState]);

  if (!pickerState) return null;

  // Hot model registry (stage 1): the list is data-driven from the store
  // (built-ins ⊕ settings.customProfiles), never a hand-written array — a
  // profile saved in Settings appears here without a restart.
  // One row per BACKEND: my-glm-flash under six aliases and two harnesses used
  // to occupy three rows, which read as three models of which two looked dead.
  const backendRows = pickerBackendGroups(agentOptions);
  // Paid seats are one CLI each (own login, own bill), so each keeps its own
  // row; they share the free renderer, including the shared status labels.
  const paidRows: PickerBackendRow[] = agentOptions
    .filter((option) => !option.local && !option.hidden)
    .map((option) => ({
      key: option.id,
      label: option.label,
      resolved: false,
      retired: false,
      aliases: [],
      members: [option],
      primaryId: option.id,
    }));

  const providerStatus = (id: string) => providers.find((p) => p.id === id);

  const stateLabel = (state: ProviderProbeState, installed: boolean): string => {
    if (state === "retired") return t("picker.status.retired");
    if (state === "rate_limited") return t("picker.status.quota");
    if (state === "unknown") return t("picker.status.checking");
    if (!installed) return t("picker.status.missing");
    return state === "online" ? t("picker.status.online") : t("picker.status.offline");
  };

  const handleSelect = (id: InteractiveAgentId): void => {
    // Terminal-first: dispatch the launch command into the selected terminal
    // (auto-Enter handled by TerminalDock's coterm:interactive-agent listener).
    // pickerState.paneId now carries the selected terminalId (set by TopBar).
    window.dispatchEvent(new CustomEvent("coterm:interactive-agent", {
      detail: { terminalId: pickerState.paneId, provider: id },
    }));
    setPickerState(null);
  };

  // "Plain terminal" option: when the picker was opened from the sidebar "+"
  // (which already called openTile), this just closes the picker — the plain
  // PTY is already created. When opened from TopBar (no projectId), this is
  // not shown.
  const handlePlainTerminal = (): void => {
    if (pickerState.projectId && !pickerState.paneId) {
      void openTile(pickerState.projectId);
    }
    setPickerState(null);
  };

  const handleCopy = (event: React.MouseEvent, id: InteractiveAgentId): void => {
    event.stopPropagation();
    const spec = interactiveAgent(id, settings?.proxyUrl ?? "http://127.0.0.1:8787", "default");
    if (!spec) return;
    void navigator.clipboard.writeText(spec.fullCommand).then(() => {
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 1500);
    });
  };

  const renderHarnessChip = (member: AgentOption, state: ProviderProbeState): React.JSX.Element => {
    const status = providerStatus(member.id);
    return (
      <button
        data-action-id="picker.agent.selectHarness"
        data-agent-id={member.id}
        key={member.id}
        type="button"
        className={`llm-picker-chip ${state}`}
        title={`${member.label ?? member.id} · ${status?.detail ?? ""}`}
        onClick={(event) => {
          event.stopPropagation();
          handleSelect(member.id);
        }}
      >
        <span className={`llm-picker-dot ${state}`} />
        {HARNESS_LABEL[member.harness]}
      </button>
    );
  };

  const renderBackendRow = (row: PickerBackendRow): React.JSX.Element => {
    const states = row.members.map(
      (member) =>
        providerStatus(member.id)?.state ??
        (providerStatus(member.id)?.online ? "online" : "offline"),
    );
    const state = states.reduce<ProviderProbeState>(
      (best, candidate) => (STATE_ORDER[candidate] < STATE_ORDER[best] ? candidate : best),
      "unknown",
    );
    const installed = row.members.some((member) => providerStatus(member.id)?.installed !== false);
    const preselected = row.members.some((member) => pickerState.preselect === member.id);
    const primary = row.members.find((member) => member.id === pickerState.preselect) ??
      row.members.find((member) => providerStatus(member.id)?.state === "online") ??
      row.members[0]!;
    const copyable = interactiveAgent(primary.id, settings?.proxyUrl ?? "http://127.0.0.1:8787", "default") !== null;
    const copied = copiedId === primary.id;
    const detailParts = [
      row.note ?? row.members.map((m) => providerStatus(m.id)?.detail).filter(Boolean).join(" · "),
      // When this was measured, straight off the existing probe stamp instead
      // of a new persistence layer: an「離線」without a time reads like a guess.
      ...row.members
        .map((member) => providerStatus(member.id)?.checkedAt)
        .filter((at): at is number => typeof at === "number" && at > 0)
        .sort((a, b) => b - a)
        .slice(0, 1)
        .map((at) => `${t("picker.lastSeen")} ${new Date(at).toLocaleTimeString()}`),
    ].filter(Boolean);
    const detail = detailParts.join(" · ");
    return (
      <div
        data-action-id="picker.agent.select"
        data-agent-id={primary.id}
        data-backend={row.key}
        key={row.key}
        className={`llm-picker-item llm-picker-backend ${preselected ? "preselected" : ""} ${installed ? "" : "unavailable"}`}
        role="button"
        tabIndex={0}
        title={detail}
        onClick={() => handleSelect(primary.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            handleSelect(primary.id);
          }
        }}
        ref={(el) => {
          if (preselected && el) el.focus();
        }}
      >
        <span className="llm-picker-label">
          {!row.members[0]?.local && <Crown size={12} />}
          <span className={`llm-picker-dot ${state}`} />
          {row.label}
          {row.aliases.length > 0 && row.resolved ? (
            <small className="llm-picker-aliases">
              {t("picker.aliases")} {row.aliases.slice(0, 3).join("、")}
              {row.aliases.length > 3 ? ` +${row.aliases.length - 3}` : ""}
            </small>
          ) : null}
        </span>
        <span className="llm-picker-trailing">
          {row.members.length > 1 ? (
            <span className="llm-picker-chips">
              {row.members.map((member) => renderHarnessChip(member, providerStatus(member.id)?.state ?? (providerStatus(member.id)?.online ? "online" : "offline")))}
            </span>
          ) : null}
          <small className={`llm-picker-status ${state}`} data-testid="picker-status">
            {stateLabel(state, installed)}
          </small>
          <button
            data-action-id="picker.command.copy"
            type="button"
            className="llm-picker-copy"
            aria-label={copied ? t("picker.copy.copied") : t("picker.copy.aria")}
            disabled={!copyable}
            onClick={(event) => handleCopy(event, primary.id)}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </span>
      </div>
    );
  };

  return (
    <div data-action-id="picker.backdrop.dismiss" className="wizard-backdrop" onClick={() => setPickerState(null)}>
      <section
        data-action-id="picker.dialog.consume"
        className="llm-picker"
        role="dialog"
        aria-modal="true"
        aria-label={t("picker.dialog.aria")}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <strong>{t("picker.header")}</strong>
          <button
            data-action-id="picker.status.refresh"
            className={`icon-button llm-picker-refresh ${probing ? "probing" : ""}`}
            aria-label={t("picker.status.refresh.aria")}
            aria-busy={probing}
            disabled={probing}
            onClick={() => void refreshProviders({ force: true })}
          >
            <RefreshCw size={15} />
          </button>
          <button
            data-action-id="picker.close"
            className="icon-button"
            aria-label={t("picker.close.aria")}
            onClick={() => setPickerState(null)}
          >
            <X size={18} />
          </button>
        </header>
        <div className="llm-picker-list" ref={listRef}>
          {/* Plain terminal option — only when opened from sidebar "+" (has projectId).
              The sidebar already called openTile, so this just dismisses the picker. */}
          {pickerState.projectId && (
            <div
              data-action-id="picker.plain.select"
              className="llm-picker-item llm-picker-plain"
              role="button"
              tabIndex={0}
              onClick={handlePlainTerminal}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  handlePlainTerminal();
                }
              }}
            >
              <span className="llm-picker-label">
                <TerminalIcon size={12} />
                {t("picker.plain")}
              </span>
              <span className="llm-picker-trailing">
                <small className="llm-picker-status">shell</small>
              </span>
            </div>
          )}
          <div className="llm-picker-columns">
            <div className="llm-picker-column">
              <span className="llm-picker-column-title">FREE</span>
              {backendRows.map((row) => renderBackendRow(row))}
            </div>
            <div className="llm-picker-column">
              <span className="llm-picker-column-title">PAID</span>
              {paidRows.map((row) => renderBackendRow(row))}
            </div>
          </div>
        </div>
        <footer>
          <small>{t("picker.footer")}</small>
        </footer>
      </section>
    </div>
  );
}
