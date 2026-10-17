// Region extraction — pure functions over a VT-emulated bottom buffer.
//
// A "buffer snapshot" is an ordered array of visible lines (top→bottom) plus
// the current OSC title. The engine never reads the raw PTY stream here; it
// reads the post-VT-emulation visible lines produced by vt-snapshot.ts. This
// keeps region logic pure and unit-testable without a live Terminal.
//
// All extractors are bounded: they never return more than MAX_REGION_CHARS
// characters, so a runaway region cannot blow the regex evaluator budget.

import type { RegionName } from "./types";

export const MAX_REGION_CHARS = 4096;
export const MAX_SNAPSHOT_LINES = 80;
export const MAX_SNAPSHOT_CHARS = 16_384;

export interface BufferSnapshot {
  // Visible lines, top→bottom, already trimmed of trailing whitespace per line.
  lines: string[];
  // Last OSC 0 title observed (may be empty string).
  title: string;
}

// --- bottom_non_empty -------------------------------------------------------
// The last N non-empty lines from the bottom of the visible buffer. Empty
// trailing lines (common right after a scroll) are skipped so the region
// captures the actual prompt/output tail.
export function extractBottomNonEmpty(snapshot: BufferSnapshot, maxLines = 5): string {
  const out: string[] = [];
  for (let i = snapshot.lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const line = snapshot.lines[i];
    if (line === undefined) continue;
    if (line.trim().length > 0) out.unshift(line);
  }
  return capRegion(out.join("\n"));
}

// --- after_last_horizontal_rule ---------------------------------------------
// Everything after the last horizontal rule. Claude Code draws permission
// panels below a row of box-drawing characters (─ ═ ━ etc.). The region is the
// text from the line after the last such rule to the bottom.
export function extractAfterLastHorizontalRule(snapshot: BufferSnapshot): string {
  let ruleIndex = -1;
  for (let i = snapshot.lines.length - 1; i >= 0; i--) {
    const line = snapshot.lines[i];
    if (line === undefined) continue;
    if (isHorizontalRule(line)) {
      ruleIndex = i;
      break;
    }
  }
  const start = ruleIndex >= 0 ? ruleIndex + 1 : 0;
  const slice = snapshot.lines.slice(start);
  return capRegion(slice.join("\n"));
}

// A horizontal rule is a line composed (after trim) of 3+ repeating rule
// characters, optionally with leading/trailing box-drawing corners.
const RULE_CHARS = new Set(["─", "━", "═", "▬", "━", "-", "=", "*"]);
function isHorizontalRule(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 3) return false;
  const first = trimmed[0];
  if (first === undefined || !RULE_CHARS.has(first)) return false;
  for (let i = 1; i < trimmed.length; i++) {
    if (trimmed[i] !== first) return false;
  }
  return true;
}

// --- osc_title --------------------------------------------------------------
// The most recent OSC 0 title. Bounded to a small length since titles are
// short status strings (spinner glyph + agent name).
export function extractOscTitle(snapshot: BufferSnapshot): string {
  return capRegion(snapshot.title);
}

// --- prompt_box_body --------------------------------------------------------
// The body of a bordered prompt box. Claude Code/Codex render permission and
// selection prompts inside a box drawn with │ ┌ ┐ └ ┘ corners. The body is
// the text between the top border and the bottom border, excluding the border
// lines themselves. Falls back to bottom_non_empty(8) when no box is found.
export function extractPromptBoxBody(snapshot: BufferSnapshot): string {
  const boxTop = findBoxTop(snapshot.lines);
  if (boxTop < 0) return extractBottomNonEmpty(snapshot, 8);
  const boxBottom = findBoxBottom(snapshot.lines, boxTop);
  const body = snapshot.lines.slice(boxTop + 1, boxBottom);
  return capRegion(body.join("\n"));
}

function findBoxTop(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    if (line.includes("┌") || line.includes("╔") || line.includes("┏")) return i;
  }
  return -1;
}

function findBoxBottom(lines: string[], top: number): number {
  for (let i = top + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (line.includes("└") || line.includes("╚") || line.includes("┗")) return i;
  }
  return lines.length;
}

// --- whole_recent -----------------------------------------------------------
// The entire recent snapshot (all visible lines). Used sparingly because it is
// the largest region and the most prone to false positives on source code the
// agent prints. Bounded by MAX_SNAPSHOT_LINES at the snapshot layer.
export function extractWholeRecent(snapshot: BufferSnapshot): string {
  return capRegion(snapshot.lines.join("\n"));
}

// --- Dispatcher -------------------------------------------------------------
export function extractRegion(snapshot: BufferSnapshot, region: RegionName): string {
  switch (region) {
    case "bottom_non_empty":
      return extractBottomNonEmpty(snapshot);
    case "after_last_horizontal_rule":
      return extractAfterLastHorizontalRule(snapshot);
    case "osc_title":
      return extractOscTitle(snapshot);
    case "prompt_box_body":
      return extractPromptBoxBody(snapshot);
    case "whole_recent":
      return extractWholeRecent(snapshot);
    default: {
      // Exhaustiveness guard: a new region must be handled explicitly.
      const _exhaustive: never = region;
      void _exhaustive;
      return "";
    }
  }
}

// --- Bounding ---------------------------------------------------------------
// Truncate a region to MAX_REGION_CHARS so the regex evaluator never sees an
// unbounded input (ReDoS mitigation, issue §4).
export function capRegion(text: string): string {
  if (text.length <= MAX_REGION_CHARS) return text;
  // Keep the tail: attention prompts live at the bottom of the region.
  return text.slice(text.length - MAX_REGION_CHARS);
}