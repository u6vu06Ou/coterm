import type { CustomProfileEntry } from "./schema";
import { BUILTIN_AGENT_OPTIONS, type AgentOption } from "./types";
import { resolveCodexProfileSpec } from "./codex-profiles";
import { resolveModelFamily } from "./model-families";

// Hot model registry (stage 1) — pure option-list derivation shared by main
// (profilesChanged push payload), the renderer store (bootstrap fallback from
// settings.customProfiles) and the e2e picker specs (expected DOM order).
// No zod/Electron deps on purpose: every consumer runs in plain node too.

/**
 * Compose the full agent option list: built-ins overlaid with the user's
 * `settings.customProfiles` (custom entry with a built-in id overrides its
 * model/local/label by id; new ids append at the end of the free claude pool).
 * Empty/absent input returns the built-in list unchanged.
 */
export function deriveAgentOptions(
  customProfiles?: Record<string, CustomProfileEntry> | null,
  base: readonly AgentOption[] = BUILTIN_AGENT_OPTIONS,
): AgentOption[] {
  // Built-in codex options keep their model in the static spec table only, so
  // attach the resolved spec here: grouping, probing and the launchers must not
  // each re-derive it (an unattached spec reads as "no model" downstream).
  const builtins = base.map((option) => {
    if (!option.id.startsWith("codex-") || option.codex) return option;
    const spec = resolveCodexProfileSpec(option.id, customProfiles);
    return spec ? { ...option, codex: spec } : option;
  });
  const entries = customProfiles ? Object.entries(customProfiles) : [];
  if (entries.length === 0) return builtins;
  const byId = new Map<string, AgentOption>(builtins.map((option) => [option.id, { ...option }]));
  for (const [id, entry] of entries) {
    const existing = byId.get(id);
    // Stage 2 (codex half): codex- ids resolve their harness from the id and
    // carry the resolved codex spec so renderer/launcher consumers never
    // re-derive it. Builtin codex ids keep their static spec table lookup.
    const codexSpec = id.startsWith("codex-") ? resolveCodexProfileSpec(id, customProfiles) : null;
    if (existing) {
      // Overlay semantics mirror buildActiveProfiles: custom wins per field.
      byId.set(id, {
        ...existing,
        label: entry.label ?? existing.label,
        title: entry.label ?? existing.title,
        model: entry.model ?? existing.model,
        local: entry.local,
        ...(codexSpec ? { codex: codexSpec } : {}),
      });
    } else {
      byId.set(id, {
        id,
        label: entry.label ?? id,
        title: entry.label ?? id,
        model: entry.model,
        local: entry.local,
        harness: id.startsWith("codex-") ? "codex" : "claude",
        ...(codexSpec ? { codex: codexSpec } : {}),
      });
    }
  }
  return [...byId.values()];
}

export const FREE_GROUP_ORDER = ["claude", "codex", "other"] as const;
export type FreeAgentGroup = (typeof FREE_GROUP_ORDER)[number];

/** the default local agent rides first inside its FREE column; everyone else keeps list order. */
const COMMON_MODEL_PRIORITY = ["local-main"] as const;

function agentSuffix(id: string): string {
  return id.includes("-") ? id.slice(id.indexOf("-") + 1) : id;
}

function sortFreeAgents(agents: AgentOption[]): AgentOption[] {
  return agents
    .map((option, index) => ({ option, index }))
    .sort((left, right) => {
      const leftPriority = COMMON_MODEL_PRIORITY.indexOf(agentSuffix(left.option.id) as (typeof COMMON_MODEL_PRIORITY)[number]);
      const rightPriority = COMMON_MODEL_PRIORITY.indexOf(agentSuffix(right.option.id) as (typeof COMMON_MODEL_PRIORITY)[number]);
      const normalizedLeft = leftPriority === -1 ? COMMON_MODEL_PRIORITY.length : leftPriority;
      const normalizedRight = rightPriority === -1 ? COMMON_MODEL_PRIORITY.length : rightPriority;
      return normalizedLeft - normalizedRight || left.index - right.index;
    })
    .map(({ option }) => option);
}

/**
 * Group the FREE (local) options into the picker's claude/codex/other columns.
 * Pure function so the e2e picker spec can compute the same expected order
 * the dialog renders — adding an agent updates both sides together.
 */
export function freeAgentGroups(options: AgentOption[]): Array<{ group: FreeAgentGroup; agents: AgentOption[] }> {
  const free = options.filter((option) => option.local && !option.hidden);
  return FREE_GROUP_ORDER
    .map((group) => ({
      group,
      agents: sortFreeAgents(free.filter((option) => option.harness === group)),
    }))
    .filter((entry) => entry.agents.length > 0);
}

/** Full picker DOM order: free columns first, then the PAID column. */
export function pickerOptionOrder(options: AgentOption[]): AgentOption[] {
  return [
    ...freeAgentGroups(options).flatMap((entry) => entry.agents),
    ...options.filter((option) => !option.local && !option.hidden),
  ];
}

/**
 * One row per BACKEND instead of one row per profile. my-glm-flash is
 * reachable under six spellings and Coterm registers it under two harnesses, so
 * the per-profile list showed the same live backend three times and read as
 * "two of mine are dead". Routing is untouched: every chip still launches its
 * own profile id, hidden profiles stay hidden, nothing is removed.
 */
export interface PickerBackendRow {
  /** Family key (shared/model-families.ts); an unknown model is its own row. */
  key: string;
  label: string;
  retired: boolean;
  note?: string | undefined;
  /** True when the backend resolved against the family table. */
  resolved: boolean;
  /** One entry per harness that can launch this backend; launch order first. */
  members: AgentOption[];
  /** What a click on the row itself launches. */
  primaryId: string;
  /** Alias spellings in use that differ from the family key (display note). */
  aliases: string[];
}

const HARNESS_LAUNCH_ORDER: AgentOption["harness"][] = ["claude", "codex", "other"];

function byLaunchOrder(left: AgentOption, right: AgentOption): number {
  return (
    HARNESS_LAUNCH_ORDER.indexOf(left.harness) - HARNESS_LAUNCH_ORDER.indexOf(right.harness)
  );
}

export function pickerBackendGroups(options: AgentOption[]): PickerBackendRow[] {
  const rows = new Map<
    string,
    { order: number; harnesses: Set<string>; row: Omit<PickerBackendRow, "members" | "primaryId" | "aliases"> & { members: AgentOption[]; aliases: string[] } }
  >();
  const visible = sortFreeAgents(options.filter((option) => option.local && !option.hidden));
  visible.forEach((option, position) => {
    const family = resolveModelFamily(option.model ?? option.codex?.model ?? option.id);
    const existing = rows.get(family.canonical);
    if (existing) {
      // Every alias still becomes a note on the row, even when the profile
      // itself is a same-harness duplicate and gets folded away.
      if (option.model) existing.row.aliases.push(option.model);
      // Same backend under the same harness is a real duplicate profile; the
      // first one wins (sortFreeAgents orders the flagship spelling first).
      if (existing.harnesses.has(option.harness)) return;
      existing.harnesses.add(option.harness);
      existing.row.members.push(option);
      return;
    }
    rows.set(family.canonical, {
      order: position,
      harnesses: new Set([option.harness]),
      row: {
        key: family.canonical,
        label: family.family ? family.label : (option.label ?? family.label),
        retired: family.retired,
        note: family.note,
        resolved: family.family !== null,
        members: [option],
        aliases: option.model ? [option.model] : [],
      },
    });
  });
  return [...rows.values()]
    .sort((left, right) =>
      left.row.retired !== right.row.retired
        ? left.row.retired
          ? 1
          : -1
        : left.order - right.order,
    )
    .map(({ row }) => {
      const members = [...row.members].sort(byLaunchOrder);
      return {
        ...row,
        members,
        primaryId: members[0]?.id ?? row.members[0]!.id,
        aliases: [...new Set(row.aliases.map((alias) => alias.trim().toLowerCase()))].filter(
          (alias) => alias !== row.key,
        ),
      };
    });
}
