const FIXED_TERMS = [
  "Codex", "Kimi", "context", "compact", "worktree", "commit", "push",
  "CI", "TDD", "BDD", "PTY", "RBE2", "HyperMesh", "TCL",
] as const;

const MAX_TERMS = 64;
const MAX_TERM_CHARS = 80;

/** Bounded vocabulary seam for STT adapters; never feed a repo/transcript dump. */
export function buildVoiceVocabulary(...sources: ReadonlyArray<ReadonlyArray<string>>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const add = (value: string): void => {
    const normalized = value.trim().replace(/\s+/g, " ").slice(0, MAX_TERM_CHARS);
    if (!normalized || seen.has(normalized.toLowerCase())) return;
    seen.add(normalized.toLowerCase());
    result.push(normalized);
  };
  FIXED_TERMS.forEach(add);
  for (const source of sources) {
    for (const term of source) {
      if (result.length >= MAX_TERMS) return result;
      add(term);
    }
  }
  return result.slice(0, MAX_TERMS);
}
