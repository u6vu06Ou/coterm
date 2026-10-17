import { describe, expect, it } from "vitest";
import { inferProfileId } from "../../src/main/core/claude-history";

describe("inferProfileId", () => {
  it("maps Kimi model names to claude-local-big", () => {
    expect(inferProfileId("my-kimi")).toBe("claude-local-big");
  });

  it("maps my-legacy-model model names to the historical claude-local-legacy label", () => {
    expect(inferProfileId("my-legacy-model")).toBe("claude-local-legacy");
    expect(inferProfileId("my-legacy-model")).toBe("claude-local-legacy");
  });

  it("maps GLM model names to claude-local-main", () => {
    expect(inferProfileId("my-glm-legacy")).toBe("claude-local-main");
    expect(inferProfileId("glm-4")).toBe("claude-local-main");
  });

  it("maps Qwen model names to claude-local-long", () => {
    expect(inferProfileId("qwen-2.5-coder")).toBe("claude-local-long");
    expect(inferProfileId("Qwen-Max")).toBe("claude-local-long");
  });

  it("maps official Claude model names to claude-official", () => {
    expect(inferProfileId("claude-sonnet-4-6")).toBe("claude-official");
    expect(inferProfileId("claude-opus-4-8")).toBe("claude-official");
    expect(inferProfileId("claude-haiku-4-5")).toBe("claude-official");
  });

  it("maps gpt/codex model names to codex-local-main", () => {
    expect(inferProfileId("gpt-5")).toBe("codex-local-main");
    expect(inferProfileId("codex-1")).toBe("codex-local-main");
  });

  it("defaults to claude-official when model is empty or unknown", () => {
    expect(inferProfileId("")).toBe("claude-official");
    expect(inferProfileId("some-unknown-model")).toBe("claude-official");
  });
});
