import { useEffect, useState } from "react";
import type { UsageSnapshot, UsageSlot } from "@shared/types";
import { useI18n, type MessageKey, type TranslationVariables } from "../i18n";
import { remainingQuota, staleAgeDays, usedQuota, usageLevel } from "./usage-hud-logic";

/**
 * Global paid-account usage HUD for the TopBar. Three compact used-bars
 * (Claude 5h, Claude 7d, Codex 7d) driven by the main-process UsageMonitor
 * snapshot. desktop/web/mobile all read the same snapshot via
 * getUsageSnapshot + onUsageChanged. No data → "--".
 *
 * The monitor reports used%; the HUD shows it directly (like the Claude Code
 * app): the bar fills up as quota is spent and the number is usage.
 * Colour contract by used%:
 *   used <= 60      → cool (blue/cyan)
 *   60 < used <= 85 → warn (amber)
 *   used > 85       → crit (red)
 *
 * This is account-level quota, independent of the selected terminal. Missing
 * official cache/session data renders as "--"; free PTYs get no per-pane
 * context battery.
 */
export function UsageHud(): React.JSX.Element {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.aiTerminal.getUsageSnapshot().then((s) => {
      if (!cancelled) setSnapshot(s);
    }).catch(() => undefined);
    const unsubscribe = window.aiTerminal.onUsageChanged((s) => setSnapshot(s));
    return () => { cancelled = true; unsubscribe(); };
  }, []);

  const bars: Array<{ key: MessageKey; slot: UsageSlot | null | undefined }> = [
    { key: "usage.hud.claude5h", slot: snapshot?.claude5h },
    { key: "usage.hud.claude7d", slot: snapshot?.claude7d },
    { key: "usage.hud.codex7d", slot: snapshot?.codex7d },
  ];

  return (
    <div className="usage-hud" role="group" aria-label="Usage">
      {bars.map((bar) => (
        <UsageBar key={bar.key} labelKey={bar.key} slot={bar.slot ?? null} t={t} />
      ))}
    </div>
  );
}

function UsageBar({
  labelKey,
  slot,
  t,
}: {
  labelKey: MessageKey;
  slot: UsageSlot | null;
  t: (key: MessageKey, vars?: TranslationVariables) => string;
}): React.JSX.Element {
  const label = t(labelKey);
  const rawUsed = slot?.percent ?? null;
  // The provider reports used%; show it directly — the bar fills as quota is
  // spent, and remaining (100 - used) only lives in the tooltip.
  const used = usedQuota(rawUsed);
  const remaining = remainingQuota(rawUsed);
  // A stale source file means the reading is meaningless, not small: render as
  // "no data" (empty bar, "--"); only the hover tooltip below names the age.
  const staleDays = staleAgeDays(slot?.updatedAt);
  const level = staleDays === null ? usageLevel(used) : "none";
  const tooltip = staleDays === null
    ? buildTooltip(label, slot, t, used, remaining)
    : t("usage.hud.stale", { label, n: staleDays });
  return (
    <span
      className={`usage-bar usage-${level}`}
      title={tooltip}
      aria-label={tooltip}
    >
      <span className="usage-bar-label">{label}</span>
      <span className="usage-bar-track">
        {staleDays === null && used !== null && (
          <span className="usage-bar-fill" style={{ width: `${Math.max(2, Math.min(100, used))}%` }} />
        )}
      </span>
      <span className="usage-bar-pct">
        {used === null ? "--" : `${Math.round(used)}%`}
      </span>
    </span>
  );
}

function buildTooltip(
  label: string,
  slot: UsageSlot | null,
  t: (key: MessageKey, vars?: TranslationVariables) => string,
  used: number | null,
  remaining: number | null,
): string {
  if (!slot || slot.percent === null || used === null || remaining === null) return t("usage.hud.nodata", { label });
  const reset = slot.resetAt ? describeReset(slot.resetAt, t) : t("usage.hud.reset.soon");
  const age = slot.updatedAt ? describeAge(slot.updatedAt, t) : t("usage.hud.age.now");
  return t("usage.hud.tooltip", { label, used: Math.round(used), remaining: Math.round(remaining), reset, age });
}

/** Human countdown to a reset epoch (seconds). */
function describeReset(resetAtSec: number, t: (key: MessageKey, vars?: TranslationVariables) => string): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const diff = resetAtSec - nowSec;
  if (diff <= 0) return t("usage.hud.reset.soon");
  const hours = Math.floor(diff / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  if (hours >= 1) return t("usage.hud.age.hours", { n: hours });
  if (minutes >= 1) return t("usage.hud.age.minutes", { n: minutes });
  return t("usage.hud.reset.soon");
}

/** Human "data age" from a source file mtime (ms). */
function describeAge(updatedAtMs: number, t: (key: MessageKey, vars?: TranslationVariables) => string): string {
  const diff = Date.now() - updatedAtMs;
  if (diff < 60_000) return t("usage.hud.age.now");
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return t("usage.hud.age.minutes", { n: minutes });
  const hours = Math.floor(minutes / 60);
  return t("usage.hud.age.hours", { n: hours });
}
