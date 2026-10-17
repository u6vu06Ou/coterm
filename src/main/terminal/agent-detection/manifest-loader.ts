// Manifest loader — bundled manifests + local override + hot reload + guards.
//
// Clean-room: the bundled manifests are original TypeScript/JSON authored from
// Coterm's own ConPTY observations and the existing AGENT_FALLBACK_PATTERNS in
// pty-manager.ts. No third-party manifest content is copied.
//
// Guards (issue §4):
//   - raw JSON <= 128KB
//   - rules <= 64
//   - pattern source <= 256 chars
//   - regex flags allowlist (i, m, s, u only)
//   - reject backreferences (\1, \k<name>) and nested/catastrophic quantifiers
//   - regex evaluated against region <= 4K chars (enforced in regions.ts)
// Fail-closed: an invalid/oversized override is rejected and the last valid
// manifest set is retained. Only a metadata-only warning is logged — never the
// path, raw JSON, or rule text.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { logger } from "../../core/logger";
import { manifestSchema, type Manifest, type Pattern, type Rule } from "./types";
import { bundledClaudeCodeManifest } from "./manifests/claude-code";
import { bundledCodexManifest } from "./manifests/codex";

const MAX_RAW_JSON_BYTES = 128 * 1024;
const MAX_RULES = 64;
const MAX_PATTERN_CHARS = 256;
const ALLOWED_FLAGS = new Set(["i", "m", "s", "u"]);
const OVERRIDE_DIR_NAME = "agent-detection";
const WATCH_DEBOUNCE_MS = 200;

export interface LoadResult {
  // The full manifest set keyed by profile family ("claude-code" | "codex").
  // On any override failure, this is the last valid set (bundled or prior).
  manifests: Map<string, Manifest>;
  // Metadata-only warning code; never contains path/raw JSON/rule text.
  warning: string | null;
}

export class ManifestLoader {
  private manifests = new Map<string, Manifest>();
  private userDataPath: string | undefined;
  private watcher: ReturnType<typeof watch> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(userDataPath?: string) {
    this.userDataPath = userDataPath;
  }

  // Load bundled first, then layer overrides on top. Bundled are the baseline
  // "last valid" set; an invalid override leaves bundled in place.
  load(): LoadResult {
    const bundled = this.loadBundled();
    if (!this.userDataPath) {
      this.manifests = bundled;
      return { manifests: new Map(bundled), warning: null };
    }

    const overrideDir = join(this.userDataPath, OVERRIDE_DIR_NAME);
    const result = this.applyOverrides(bundled, overrideDir);
    if (result.warning) {
      // Initial invalid data falls back to bundled. A later invalid hot reload
      // retains the last fully-valid set (including a prior override).
      const retained = this.manifests.size > 0 ? this.manifests : bundled;
      logger.warn(
        "pty",
        "agent.detection.manifest.rejected",
        "Agent detection manifest override rejected",
        { code: result.warning },
      );
      return { manifests: new Map(retained), warning: result.warning };
    }
    this.manifests = result.manifests;
    return { manifests: new Map(this.manifests), warning: null };
  }

  private loadBundled(): Map<string, Manifest> {
    const map = new Map<string, Manifest>();
    map.set("claude-code", bundledClaudeCodeManifest);
    map.set("codex", bundledCodexManifest);
    return map;
  }

  // Apply all *.json overrides in the directory. If ANY override is invalid,
  // the entire override batch is rejected (fail-closed) and the prior set is
  // kept. This prevents a half-loaded manifest set from mixing valid/invalid.
  private applyOverrides(
    current: Map<string, Manifest>,
    overrideDir: string,
  ): LoadResult {
    if (!existsSync(overrideDir)) {
      return { manifests: new Map(current), warning: null };
    }
    let dir: string[];
    try {
      dir = readdirSync(overrideDir).sort((a, b) => a.localeCompare(b));
    } catch {
      return { manifests: new Map(current), warning: "override_dir_unreadable" };
    }

    const candidate = new Map(current);
    for (const file of dir) {
      if (!file.endsWith(".json")) continue;
      const fullPath = join(overrideDir, file);
      const validation = this.validateOverrideFile(fullPath);
      if (!validation.ok) {
        // Fail-closed: discard the whole batch, keep the prior valid set.
        return {
          manifests: new Map(current),
          warning: validation.code,
        };
      }
      if (!current.has(validation.manifest.profile)) {
        return { manifests: new Map(current), warning: "override_profile_unsupported" };
      }
      if (validation.manifest.rules.some((rule) => rule.profile !== validation.manifest.profile)) {
        return { manifests: new Map(current), warning: "override_rule_profile_mismatch" };
      }
      // A valid override replaces the manifest for its profile family.
      candidate.set(validation.manifest.profile, validation.manifest);
    }
    return { manifests: candidate, warning: null };
  }

  private validateOverrideFile(
    fullPath: string,
  ): { ok: true; manifest: Manifest } | { ok: false; code: string } {
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(fullPath);
    } catch {
      return { ok: false, code: "override_stat_failed" };
    }
    if (!stat.isFile()) return { ok: false, code: "override_not_file" };
    if (stat.size > MAX_RAW_JSON_BYTES) {
      return { ok: false, code: "override_oversized" };
    }
    let raw: string;
    try {
      raw = readFileSync(fullPath, "utf8");
    } catch {
      return { ok: false, code: "override_read_failed" };
    }
    if (Buffer.byteLength(raw, "utf8") > MAX_RAW_JSON_BYTES) {
      return { ok: false, code: "override_oversized" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, code: "override_invalid_json" };
    }
    const zodResult = manifestSchema.safeParse(parsed);
    if (!zodResult.success) {
      return { ok: false, code: "override_schema_rejected" };
    }
    const manifest = zodResult.data;
    if (manifest.rules.length > MAX_RULES) {
      return { ok: false, code: "override_too_many_rules" };
    }
    // Deep-validate every rule's patterns (size + regex safety).
    for (const rule of manifest.rules) {
      const guard = validateRulePatterns(rule);
      if (!guard.ok) return { ok: false, code: guard.code };
    }
    return { ok: true, manifest };
  }

  // Start watching the override directory for hot reload. Debounced so a burst
  // of writes (editor save) triggers one reload. Watch failure is non-fatal:
  // we keep the loaded manifests and log a metadata-only warning.
  startWatch(onReload: (result: LoadResult) => void): void {
    if (!this.userDataPath || this.watcher || this.disposed) return;
    const overrideDir = join(this.userDataPath, OVERRIDE_DIR_NAME);
    try {
      // Watch the intended local directory from startup, even when the user
      // has not created an override yet.
      mkdirSync(overrideDir, { recursive: true });
      this.watcher = watch(overrideDir, () => {
        if (this.disposed) return;
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          if (this.disposed) return;
          const result = this.load();
          onReload(result);
        }, WATCH_DEBOUNCE_MS);
      });
    } catch {
      // Watch unavailable — keep loaded manifests, no reload.
    }
  }

  getManifests(): Map<string, Manifest> {
    return new Map(this.manifests);
  }

  dispose(): void {
    this.disposed = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        // ignore
      }
      this.watcher = null;
    }
  }
}

// --- Pattern guard (issue §4) ----------------------------------------------
// Validates size + regex safety for a single rule. Exported for unit tests.
export function validateRulePatterns(
  rule: Rule,
): { ok: true } | { ok: false; code: string } {
  const groups: Pattern[][] = [rule.all ?? [], rule.any ?? [], rule.none ?? []];
  for (const group of groups) {
    for (const p of group) {
      const guard = validatePattern(p);
      if (!guard.ok) return guard;
    }
  }
  return { ok: true };
}

function validatePattern(p: Pattern): { ok: true } | { ok: false; code: string } {
  if ("contains" in p) {
    for (const needle of p.contains) {
      if (needle.length === 0 || needle.length > MAX_PATTERN_CHARS) {
        return { ok: false, code: "contains_bad_length" };
      }
    }
    return { ok: true };
  }
  if ("regex" in p) {
    const src = p.regex;
    if (src.length === 0 || src.length > MAX_PATTERN_CHARS) {
      return { ok: false, code: "regex_bad_length" };
    }
    const flags = p.flags;
    if (flags !== undefined) {
      if (new Set(flags).size !== flags.length) {
        return { ok: false, code: "flags_duplicate" };
      }
      for (const f of flags) {
        if (!ALLOWED_FLAGS.has(f)) return { ok: false, code: "flags_disallowed" };
      }
    }
    try {
      void new RegExp(src, flags);
    } catch {
      return { ok: false, code: "regex_invalid" };
    }
    return validateRegexSafety(src);
  }
  if ("any" in p) {
    for (const alt of p.any) {
      const guard = validatePattern(alt);
      if (!guard.ok) return guard;
    }
    return { ok: true };
  }
  return { ok: false, code: "pattern_unknown_shape" };
}

// Reject backreferences and catastrophic/nested quantifiers.
//   - backreference: \1..\9 or \k<name>
//   - nested quantifier: a quantifier immediately following another quantifier
//     (e.g. (a+)+ , (a*)*, a{2,3}+ ) — the classic ReDoS shape.
function validateRegexSafety(src: string): { ok: true } | { ok: false; code: string } {
  // Backreference: \1-\9 or \k<...>
  if (/\\[1-9]/.test(src) || /\\k<[^>]*>/.test(src)) {
    return { ok: false, code: "regex_backreference" };
  }
  // Nested quantifier: two quantifier tokens adjacent (allowing the second to
  // be a possessive/atomic marker). Catches (a+)+, a**, a{2,3}+, etc.
  const quantifier = String.raw`(?:[+*?]|\{\d+(?:,\d*)?\})`;
  if (new RegExp(`${quantifier}\\s*${quantifier}`).test(src)) {
    return { ok: false, code: "regex_nested_quantifier" };
  }
  // Conservatively reject every quantified group. This blocks ambiguous
  // alternation such as (a|aa)+ as well as nested forms such as (a{1,3})+;
  // bundled rules do not require quantified groups.
  if (new RegExp(`\\)${quantifier}`).test(src)) {
    return { ok: false, code: "regex_quantified_group" };
  }
  return { ok: true };
}
