// Backend-family table for the model list. One backend model is reachable under
// many spellings (friendly alias, upstream id, `claude-*` CLI-compatibility
// alias that Claude Code insists on). Without this table the picker shows the
// same backend three times and the user reasonably concludes two of them are
// broken. Routing is untouched: every alias below still resolves exactly as the
// proxy/CLI resolves it — this file only answers "which backend is this row".
//
// Source of truth: the proxy's MODEL_MAPPING/RETIRED_MODELS tables
// (llm-proxy.py) cross-checked against local model notes 2026-09-14 probes.
// An alias we do not know resolves to a family of its own, so an unlisted model
// is never silently merged into a neighbour.

export interface ModelFamily {
  /** Stable key the picker groups and the status cache keys on. */
  canonical: string;
  /** Display name for the whole family (the real backend's name). */
  label: string;
  /** Permanently retired backend: must never render as online. */
  retired?: boolean | undefined;
  /** Why it is gone; shown as the row detail for retired families. */
  note?: string | undefined;
  /** Every spelling that reaches this backend, already normalized. */
  aliases: readonly string[];
}

export function normalizeModelName(name: string | null | undefined): string {
  return (name ?? "").trim().toLowerCase();
}

export const MODEL_FAMILIES: readonly ModelFamily[] = [
  {
    canonical: "my-glm-flash",
    label: "my-glm-flash",
    aliases: [
      "my-glm",
      "my-glm-flash",
      "my-glm",
      "my-glm-flash",
      "my-glm",
      "my-glm-flash",
      "my-glm-flash",
      // claude-* CLI-compat routing keys: Claude Code only honours the context
      // window env for `glm-*` names, so the free GLM route ships under these.
      "claude-sonnet-4-6",
      "claude-opus-4-20250514",
      "claude-opus-4-8",
    ],
  },
  {
    canonical: "my-qwen",
    label: "my-qwen",
    aliases: [
      "my-qwen",
      "my-qwen-flash",
      "upstream-my-qwen",
      "upstream-my-qwen-flash",
      "claude-3-5-sonnet-20241022",
      "claude-3-5-sonnet-latest",
      "claude-3-opus-20240229",
      "claude-3-5-haiku-20241022",
      "claude-3-5-haiku-latest",
      "claude-3-haiku-20240307",
      "claude-3-haiku-latest",
    ],
  },
  {
    // Same weights as my-qwen but a de-aligned checkpoint: different behaviour,
    // so it stays its own row instead of folding into the Qwen row.
    canonical: "my-qwen-freeform",
    label: "my-qwen-freeform",
    aliases: [
      "my-qwen-freeform",
      "upstream-my-qwen-freeform",
      "upstream-my-qwen-old-freeform",
      "my-qwen-old-freeform",
      // The uncensored route key: Claude Code needs a claude-* name to apply
      // its context-window env, so the de-aligned variant ships under the
      // Haiku 4.5 id (proxy maps it to my-qwen-freeform, not to my-qwen).
      "claude-haiku-4-5-20251001",
    ],
  },
  {
    canonical: "my-ds-flash",
    label: "my-ds-flash",
    aliases: [
      "my-ds",
      "my-ds-alt",
      "my-ds",
      "my-ds-flash",
      "upstream-my-ds-legacy",
    ],
  },
  {
    canonical: "my-kimi",
    label: "my-kimi",
    aliases: [
      "my-kimi",
      "kimi",
      "upstream-my-kimi",
      "claude-opus-4-1-20250805",
      "claude-opus-5",
    ],
  },
  // ── retired: kept so a still-registered profile reads as 已下架 instead of
  // "online" (the proxy still lists my-glm-max in /v1/models but answers 502).
  {
    canonical: "my-glm-max",
    label: "my-glm-max",
    retired: true,
    note: "744B 主機已停機：proxy 的別名表還列得到它，但打了不會有回應。請改用 my-glm-flash。",
    aliases: ["my-glm-max", "my-glm-max", "my-glm-max", "my-glm-max", "my-glm-max"],
  },
  {
    canonical: "my-glm-legacy",
    label: "my-glm-legacy",
    retired: true,
    note: "my-glm-legacy 已自上游下架，三種寫法都不認。請改用 my-glm-flash。",
    aliases: ["my-glm-legacy", "my-glm-legacy", "my-glm-legacy", "my-glm-legacy"],
  },
  {
    canonical: "my-legacy-model",
    label: "my-legacy-model",
    retired: true,
    note: "my-legacy-model 兩台已退役，不會再回來。請改用 my-glm-flash。",
    aliases: [
      "my-legacy-model",
      "my-legacy-model",
      "my-legacy-model",
      "my-legacy-model",
      "my-legacy-model",
      "my-legacy-model",
      "claude-local-legacy",
      "codex-local-legacy",
    ],
  },
  {
    canonical: "my-legacy-hy",
    label: "my-legacy-hy",
    retired: true,
    note: "混元-4 主機已關閉，不會再回來。",
    aliases: ["my-legacy-hy", "my-legacy-hy", "my-legacy-hy"],
  },
  {
    canonical: "my-qwen-27b",
    label: "my-qwen-27b",
    retired: true,
    note: "my-qwen-27b 已下架，換成 my-qwen-flash（別名 my-qwen）。",
    aliases: ["my-qwen-27b"],
  },
  {
    canonical: "my-ds-legacy",
    label: "my-ds-legacy",
    retired: true,
    note: "舊名字已換代成 my-ds-flash，請改用 my-ds。",
    aliases: ["my-ds-legacy"],
  },
];

const ALIAS_INDEX = new Map<string, ModelFamily>();
for (const family of MODEL_FAMILIES) {
  ALIAS_INDEX.set(normalizeModelName(family.canonical), family);
  for (const alias of family.aliases) ALIAS_INDEX.set(normalizeModelName(alias), family);
}

export interface ResolvedModelFamily {
  /** Family key; an unknown model is its own family. */
  canonical: string;
  label: string;
  retired: boolean;
  note?: string | undefined;
  family: ModelFamily | null;
  /** The alias as given, normalized (undefined when the input was empty). */
  alias?: string | undefined;
}

/** Which backend a model name actually reaches. Unknown names stay on their own. */
export function resolveModelFamily(model: string | null | undefined): ResolvedModelFamily {
  const alias = normalizeModelName(model);
  const family = alias ? ALIAS_INDEX.get(alias) ?? null : null;
  if (!family) {
    return {
      canonical: alias || "unknown",
      label: (model ?? "").trim() || "unknown",
      retired: false,
      family: null,
      alias: alias || undefined,
    };
  }
  return {
    canonical: family.canonical,
    label: family.label,
    retired: family.retired === true,
    note: family.note,
    family,
    alias,
  };
}

export function isRetiredModel(model: string | null | undefined): boolean {
  return resolveModelFamily(model).retired;
}
