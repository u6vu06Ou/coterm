// Rule engine — evaluates a manifest's rules against a buffer snapshot.
//
// Determinism contract (issue §3): rules are sorted by priority DESC, then by
// rule id lexicographic ASC for ties. The first rule whose gates all pass wins.
// Evaluation is pure: same (snapshot, manifest) → same MatchResult | null.
//
// Gate semantics:
//   all  — every pattern must match (AND). Absent → vacuously true.
//   any  — at least one pattern must match (OR). Absent → vacuously true.
//   none — no pattern may match (NOT). Absent → vacuously true.
// A rule passes when all three conditions hold simultaneously.

import type {
  GateSummary,
  Manifest,
  MatchResult,
  Pattern,
  Rule,
} from "./types";
import { extractRegion, type BufferSnapshot } from "./regions";

// --- Pattern evaluation -----------------------------------------------------
// A pattern is one of: { contains: [...] } (all substrings must be present),
// { regex, flags? } (regex must match), or { any: [...] } (any alternative
// matches). Returns true if the pattern matches the region text.
export function matchPattern(pattern: Pattern, text: string): boolean {
  if ("contains" in pattern) {
    return pattern.contains.every((needle) => text.includes(needle));
  }
  if ("regex" in pattern) {
    return matchRegex(pattern.regex, pattern.flags, text);
  }
  if ("any" in pattern) {
    return pattern.any.some((alt) => matchPattern(alt, text));
  }
  return false;
}

// Compile + cache regexes. The manifest-loader validates flags and rejects
// catastrophic patterns at load time; here we only run the (already-vetted)
// regex against a bounded region (<= MAX_REGION_CHARS).
const regexCache = new Map<string, RegExp>();

function matchRegex(source: string, flags: string | undefined, text: string): boolean {
  const key = `${flags ?? ""}\u0000${source}`;
  let re = regexCache.get(key);
  if (!re) {
    try {
      re = new RegExp(source, flags);
    } catch {
      // Invalid regex should have been rejected at load; treat as no-match.
      return false;
    }
    regexCache.set(key, re);
  }
  return re.test(text);
}

// --- Gate evaluation --------------------------------------------------------
export function evaluateGates(rule: Rule, regionText: string): GateSummary {
  const all = rule.all ?? [];
  const any = rule.any ?? [];
  const none = rule.none ?? [];

  const allPassed = all.every((p) => matchPattern(p, regionText));
  const anyPassed = any.length === 0 || any.some((p) => matchPattern(p, regionText));
  const nonePassed = none.every((p) => !matchPattern(p, regionText));

  return {
    allPassed,
    allCount: all.length,
    anyPassed,
    anyCount: any.length,
    nonePassed,
    noneCount: none.length,
  };
}

// --- Rule sorting (deterministic) ------------------------------------------
// priority DESC, then id ASC (lexicographic). Stable regardless of input order.
export function sortRules(rules: Rule[]): Rule[] {
  return [...rules].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// --- Top-level evaluate -----------------------------------------------------
// Returns the highest-priority passing rule's MatchResult, or null if no rule
// passes. The region text is extracted once per rule (regions are cheap and
// bounded) and never returned to the caller.
export function evaluate(
  snapshot: BufferSnapshot,
  manifest: Manifest,
): MatchResult | null {
  const sorted = sortRules(manifest.rules);
  for (const rule of sorted) {
    const regionText = extractRegion(snapshot, rule.region);
    const gates = evaluateGates(rule, regionText);
    if (gates.allPassed && gates.anyPassed && gates.nonePassed) {
      return {
        ruleId: rule.id,
        state: rule.state,
        priority: rule.priority,
        region: rule.region,
        gateSummary: gates,
        manifestVersion: manifest.version,
      };
    }
  }
  return null;
}

// --- Test-only helpers (exported for unit tests) ---------------------------
export function clearRegexCacheForTests(): void {
  regexCache.clear();
}