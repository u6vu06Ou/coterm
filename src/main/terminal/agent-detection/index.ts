// Agent detection core — public barrel.
//
// Independent module (issue scope): no imports into PtyManager / agent-api /
// renderer. Consumers import from this barrel only.

export { AgentDetectionEngine, profileFamily } from "./engine";
export {
  hasBackgroundWorkSignal,
  BACKGROUND_WAITING_PATTERN,
  TEAM_STATUS_ROW_PATTERN,
  TOKEN_STATS_PATTERN,
  BACKGROUND_SHELLS_PATTERN,
  SPINNER_ACTIVITY_PATTERN,
} from "./background-work";
export { ManifestLoader, validateRulePatterns } from "./manifest-loader";
export { evaluate, evaluateGates, matchPattern, sortRules, clearRegexCacheForTests } from "./rule-engine";
export {
  extractRegion,
  extractBottomNonEmpty,
  extractAfterLastHorizontalRule,
  extractOscTitle,
  extractPromptBoxBody,
  extractWholeRecent,
  capRegion,
  MAX_REGION_CHARS,
  MAX_SNAPSHOT_LINES,
  MAX_SNAPSHOT_CHARS,
  type BufferSnapshot,
} from "./regions";
export { VtSnapshot, VT_SCROLLBACK } from "./vt-snapshot";
export {
  ptyStateSchema,
  regionNameSchema,
  patternSchema,
  ruleSchema,
  manifestSchema,
  type PtyState,
  type RegionName,
  type Pattern,
  type Rule,
  type Manifest,
  type MatchResult,
  type GateSummary,
  type AgentStateExplanation,
  type AgentStateSource,
  type AgentCandidate,
  type AgentDetectionEngineOptions,
  type TrackTerminalInput,
} from "./types";
