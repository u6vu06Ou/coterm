import { describe, expect, it } from "vitest";
import { MODEL_FAMILIES, isRetiredModel, resolveModelFamily } from "../../src/shared/model-families";
import type { AgentOption } from "../../src/shared/types";
import { deriveAgentOptions, pickerBackendGroups } from "../../src/shared/agent-options";

// 9/16 lesson (test #107/#108): assertions import the same function the product
// uses. These tests check the table's INVARIANTS and the historical spellings
// that caused the bug, not a hand-copied row list.

describe("model family table", () => {
  it("never maps one spelling into two backends", () => {
    const seen = new Map<string, string>();
    for (const family of MODEL_FAMILIES) {
      for (const alias of new Set([...family.aliases, family.canonical])) {
        const key = alias.trim().toLowerCase();
        const owner = seen.get(key);
        expect(owner, `${key} claimed by ${owner} and ${family.canonical}`).toBeUndefined();
        seen.set(key, family.canonical);
      }
    }
  });

  it("folds every my-glm-flash spelling onto one backend", () => {
    for (const spelling of [
      "my-glm-flash",
      "my-glm-flash",
      "my-glm",
      "my-glm",
      "my-glm-flash",
      "claude-sonnet-4-6",
      "claude-opus-4-20250514",
    ]) {
      expect(resolveModelFamily(spelling).canonical, spelling).toBe("my-glm-flash");
    }
  });

  it("keeps the uncensored checkpoint apart from plain Qwen", () => {
    expect(resolveModelFamily("claude-haiku-4-5-20251001").canonical).toBe("my-qwen-freeform");
    expect(resolveModelFamily("my-qwen-freeform").canonical).toBe("my-qwen-freeform");
    expect(resolveModelFamily("claude-3-5-sonnet-latest").canonical).toBe("my-qwen");
  });

  it("reads my-ds-alt as the live DeepSeek, and the old id as retired", () => {
    expect(resolveModelFamily("my-ds-alt").canonical).toBe("my-ds-flash");
    expect(resolveModelFamily("my-ds").canonical).toBe("my-ds-flash");
    expect(isRetiredModel("my-ds-legacy")).toBe(true);
  });

  it("pins every permanently retired name", () => {
    for (const name of ["my-glm-max", "my-glm-max", "my-glm-legacy", "my-legacy-model", "my-legacy-model", "my-legacy-hy", "my-qwen-27b"]) {
      expect(isRetiredModel(name), name).toBe(true);
    }
    for (const name of ["my-glm-flash", "my-qwen", "my-kimi", "my-ds"]) {
      expect(isRetiredModel(name), name).toBe(false);
    }
  });

  it("gives an unlisted model its own backend instead of merging it", () => {
    const resolved = resolveModelFamily("brand-new-model");
    expect(resolved.canonical).toBe("brand-new-model");
    expect(resolved.family).toBeNull();
    expect(resolved.retired).toBe(false);
  });
});

describe("picker backend grouping", () => {
  it("renders one row per backend for the built-in free list", () => {
    const rows = pickerBackendGroups(deriveAgentOptions());
    const keys = rows.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
    // The flagship trio that used to be three rows is now one row, two chips.
    const glm = rows.find((row) => row.key === "my-glm-flash");
    expect(glm?.members.map((member) => member.harness)).toEqual(["claude", "codex"]);
    // 744B is a backend of its own, retired, and never merged into the live row.
    const retired = rows.filter((row) => row.retired);
    expect(retired.map((row) => row.key)).toEqual(["my-glm-max"]);
    expect(rows.indexOf(retired[0]!)).toBe(rows.length - 1);
  });

  it("folds built-ins and user-registered aliases into one kimi row", () => {
    const rows = pickerBackendGroups(
      deriveAgentOptions({
        "claude-k1": { local: true, env: {}, label: "E2E Kimi Claude", model: "my-kimi" },
        "codex-k1": { local: true, env: {}, label: "E2E Kimi Codex", model: "my-kimi" },
        "claude-k2": { local: true, env: {}, label: "E2E Kimi Alias", model: "upstream-my-kimi" },
      }),
    );
    const kimi = rows.filter((row) => row.key === "my-kimi");
    expect(kimi).toHaveLength(1);
    // Three profiles, two harnesses → one row whose chips cover both harnesses.
    expect(kimi[0]?.members.map((member) => member.harness)).toEqual(["claude", "codex"]);
    // The alias is not deleted, it becomes a note on the row it belongs to.
    expect(kimi[0]?.aliases).toContain("upstream-my-kimi");
  });

  it("sends retired profiles to the bottom and keeps unknown models alone", () => {
    const rows = pickerBackendGroups([
      ...deriveAgentOptions(),
      { id: "claude-old", label: "舊模型", local: true, harness: "claude", model: "my-glm-max" },
      { id: "claude-new", label: "新模型", local: true, harness: "claude", model: "brand-new-model" },
    ] as unknown as AgentOption[]);
    expect(rows.at(-1)?.key).toBe("my-glm-max");
    expect(rows.at(-1)?.retired).toBe(true);
    // Retired rows only ever sit at the end, so a live model is never below one.
    expect(rows.filter((row) => row.retired).every((row) => rows.indexOf(row) >= rows.length - 1)).toBe(true);
    expect(rows.map((row) => row.key)).toContain("brand-new-model");
    // The hidden duplicate profile stays hidden: no chip, and its private alias
    // never shows up as an alias note on the row it would have joined.
    const qwen = rows.find((row) => row.key === "my-qwen");
    expect(qwen?.members.map((member) => member.id)).not.toContain("claude-local-long");
    expect(qwen?.aliases).not.toContain("claude-3-5-sonnet-latest");
  });

  it("prefers the claude harness as the row's own click target", () => {
    const glm = pickerBackendGroups(deriveAgentOptions()).find((row) => row.key === "my-glm-flash");
    expect(glm?.primaryId).toBe("claude-local-main");
  });
});
