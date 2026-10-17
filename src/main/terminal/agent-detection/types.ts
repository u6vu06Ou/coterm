// Agent detection core — types, Zod schema, and public contracts.
//
// Clean-room implementation: region-based rule engine over a main-owned
// @xterm/headless VT snapshot. No code, manifest, or fixture is derived from
// any third-party detector. Concepts (bottom-buffer
// region, priority, AND/OR/NOT gates, explain) are generic to the problem
// domain and re-implemented from scratch in TypeScript + Zod.
//
// Layering: this module never logs raw PTY, prompt text, or evidence. The
// AgentStateExplanation carries only metadata (matched rule id, gate summary,
// manifest version) — never the region content that was evaluated.

import { z } from "zod";
import { ptyStateSchema } from "@shared/schema";
import type {
  AgentStateExplanation as SharedAgentStateExplanation,
  PtyStateSource,
} from "@shared/types";

// --- Canonical state --------------------------------------------------------
// Re-export the shared schema so detector manifests cannot drift from the
// canonical PtyManager/API state machine.
export { ptyStateSchema };
export type PtyState = z.infer<typeof ptyStateSchema>;

// --- Regions ----------------------------------------------------------------
// A region is a named slice of the VT-emulated bottom buffer. The engine
// extracts a region string per rule, then evaluates gates against it.
export const regionNameSchema = z.enum([
  "bottom_non_empty",
  "after_last_horizontal_rule",
  "osc_title",
  "prompt_box_body",
  "whole_recent",
]);
export type RegionName = z.infer<typeof regionNameSchema>;

// --- Patterns ---------------------------------------------------------------
// A pattern matches either via literal substring (contains) or a bounded
// regular expression. Regex is validated separately in manifest-loader
// (flags allowlist, no backreferences, no catastrophic quantifiers).
const containsPatternSchema = z.object({
  contains: z.array(z.string().min(1).max(256)).min(1).max(16),
}).strict();

const regexPatternSchema = z.object({
  regex: z.string().min(1).max(256),
  flags: z.string().max(8).optional(),
}).strict();

// An "any" group is a list of pattern alternatives; any one matching satisfies
// the group. Each alternative is itself a contains/regex pattern.
const anyAlternativeSchema = z.union([containsPatternSchema, regexPatternSchema]);
const anyGroupSchema = z.object({
  any: z.array(anyAlternativeSchema).min(1).max(16),
}).strict();

export const patternSchema = z.union([containsPatternSchema, regexPatternSchema, anyGroupSchema]);
export type Pattern = z.infer<typeof patternSchema>;

// --- Rule -------------------------------------------------------------------
export const ruleSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  state: ptyStateSchema,
  priority: z.number().int().min(0).max(100000),
  region: regionNameSchema,
  all: z.array(patternSchema).max(16).optional(),
  any: z.array(patternSchema).max(16).optional(),
  none: z.array(patternSchema).max(16).optional(),
  profile: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
}).strict();
export type Rule = z.infer<typeof ruleSchema>;

// --- Manifest ---------------------------------------------------------------
export const manifestSchema = z.object({
  profile: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/),
  rules: z.array(ruleSchema).min(0).max(64),
}).strict();
export type Manifest = z.infer<typeof manifestSchema>;

// --- Match result -----------------------------------------------------------
export interface MatchResult {
  ruleId: string;
  state: PtyState;
  priority: number;
  region: RegionName;
  gateSummary: GateSummary;
  manifestVersion: string;
}

export interface GateSummary {
  allPassed: boolean;
  allCount: number;
  anyPassed: boolean;
  anyCount: number;
  nonePassed: boolean;
  noneCount: number;
}

// --- Explanation (metadata-only, never raw PTY) -----------------------------
export type AgentStateExplanation = SharedAgentStateExplanation;
export type AgentStateSource = PtyStateSource;

// --- Candidate (emitted via onCandidate) ------------------------------------
export interface AgentCandidate {
  terminalId: string;
  state: PtyState;
  matchedRuleId: string;
  manifestVersion: string;
  evaluatedAt: string;
}

// --- Engine config ----------------------------------------------------------
export interface AgentDetectionEngineOptions {
  userDataPath?: string;
  evaluationDelayMs?: number;
  onCandidate?: (terminalId: string, candidate: AgentCandidate) => void;
}

export interface TrackTerminalInput {
  terminalId: string;
  agentProfile: string;
  cols: number;
  rows: number;
}
