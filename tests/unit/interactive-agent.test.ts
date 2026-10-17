import { describe, expect, it } from "vitest";
import { deriveAgentOptions } from "../../src/shared/agent-options";
import type { CustomProfileEntry } from "../../src/shared/schema";
import {
  canResumeProfile,
  dispatchNativeWorkflow,
  interactiveAgent,
  setAgentOptions,
} from "../../src/renderer/src/components/interactive-agent";

describe("interactive agent commands", () => {
  it("launches official Claude with native workflows and in-process agent teams", () => {
    const claude = interactiveAgent("claude-official", "http://127.0.0.1:8787", "opus");

    expect(claude?.title).toBe("Claude Code");
    expect(claude?.agentProfile).toBeUndefined();
    expect(claude?.command).toContain("Get-Command 'claude'");
    expect(claude?.command).toContain("$env:ANTHROPIC_BASE_URL=$null");
    expect(claude?.command).toContain("$env:ANTHROPIC_AUTH_TOKEN=$null");
    expect(claude?.command).toContain("$env:CLAUDE_CODE_DISABLE_AGENT_VIEW='1'");
    // Fresh launch gets a generated --session-id between --model and --dangerously-skip-permissions.
    expect(claude?.command).toContain("claude --model 'opus'");
    expect(claude?.command).toContain("--dangerously-skip-permissions --teammate-mode in-process");
    expect(claude?.command).toMatch(/--session-id '[0-9a-f-]+'/);
    expect(claude?.nativeSessionId).toMatch(/^[0-9a-f-]+$/);
    expect(claude?.command).toContain("找不到 Claude Code CLI");
  });

  it("preserves Codex and proxied Claude launch commands", () => {
    const codex = interactiveAgent("codex-official", "http://127.0.0.1:8787");
    expect(codex?.title).toBe("Codex");
    expect(codex?.command).toContain("Get-Command 'codex'");
    expect(codex?.command).toContain("codex --dangerously-bypass-approvals-and-sandbox");
    // codex's resume is a subcommand, not a --resume flag; absent when no id.
    expect(codex?.command).not.toContain("--resume");

    const codexGlm = interactiveAgent("codex-local-main", "http://127.0.0.1:8787");
    expect(codexGlm?.title).toBe("codex-local-main");
    expect(codexGlm?.agentProfile).toBeUndefined();
    expect(codexGlm?.command).toContain("glm-codex.cmd");

    const codexQwen = interactiveAgent("codex-local-long", "http://127.0.0.1:8787");
    expect(codexQwen?.title).toBe("codex-local-long");
    expect(codexQwen?.command).toContain("qwen-codex.cmd");

    const qwen = interactiveAgent("claude-local-long", "http://127.0.0.1:8787");
    // Local claude-* profiles keep the launch command self-contained so every
    // path sets proxy auth before Claude Code can fall back to the paid login.
    expect(qwen?.agentProfile).toBe("claude-local-long");
    expect(qwen?.command).toContain("claude --model 'claude-3-5-sonnet-latest'");
    expect(qwen?.command).toContain("--dangerously-skip-permissions --teammate-mode in-process");
    expect(qwen?.command).toMatch(/--session-id '[0-9a-f-]+'/);
    expect(qwen?.command).toContain("$env:ANTHROPIC_BASE_URL='http://127.0.0.1:8787'");
    expect(qwen?.command).toContain("$env:ANTHROPIC_AUTH_TOKEN='coterm-local-dev'");
    expect(qwen?.command).toContain("$env:ANTHROPIC_MODEL='claude-3-5-sonnet-latest'");
    expect(qwen?.command).toContain("$env:CLAUDE_CODE_DISABLE_AGENT_VIEW='1'");
    expect(qwen?.fullCommand).toContain("$env:ANTHROPIC_MODEL='claude-3-5-sonnet-latest'");

    const uncensored = interactiveAgent("claude-local-freeform", "http://127.0.0.1:8787");
    expect(uncensored?.title).toBe("Qwen uncensored");
    expect(uncensored?.command).toContain("claude --model 'claude-haiku-4-5-20251001'");
    expect(uncensored?.command).toContain("--dangerously-skip-permissions --teammate-mode in-process");

    const glm = interactiveAgent("claude-local-main", "http://127.0.0.1:8787");
    expect(glm?.title).toContain("GLM");
    expect(glm?.agentProfile).toBe("claude-local-main");
    expect(glm?.command).toContain("claude --model 'my-glm-flash'");
    expect(glm?.command).toContain("--dangerously-skip-permissions --teammate-mode in-process");
    expect(glm?.command).toContain("$env:ANTHROPIC_AUTH_TOKEN='coterm-local-dev'");
    expect(glm?.command).toContain("$env:ANTHROPIC_MODEL='my-glm-flash'");
    expect(glm?.command).toContain("$env:CLAUDE_CODE_DISABLE_AGENT_VIEW='1'");
    expect(glm?.fullCommand).toContain("$env:ANTHROPIC_MODEL='my-glm-flash'");

    const council = interactiveAgent("council", "http://127.0.0.1:8787");
    expect(council?.title).toBe("Council");
    expect(council?.command).toContain("--chairman codex54");
  });

  it("emits codex resume as a subcommand (not a --resume flag) for codex-official", () => {
    const codex = interactiveAgent("codex-official", "http://127.0.0.1:8787", "default", "sess-123");
    // codex resume is a subcommand: `codex --dangerously-bypass-approvals-and-sandbox resume 'sess-123'`
    expect(codex?.command).toContain("resume 'sess-123'");
    expect(codex?.command).not.toContain("--resume");
  });

  it("does not inject --session-id when resuming a claude session", () => {
    // Resuming reuses the existing native session id; a fresh --session-id would
    // fork a new session and lose context. Only fresh launches get one.
    const resumed = interactiveAgent("claude-official", "http://127.0.0.1:8787", "default", "existing-sess");
    expect(resumed?.command).toContain("--resume 'existing-sess'");
    expect(resumed?.command).not.toContain("--session-id");
    expect(resumed?.nativeSessionId).toBeUndefined();
  });

  it("passes resumeSessionId through the local codex wrappers", () => {
    const codexGlm = interactiveAgent("codex-local-main", "http://127.0.0.1:8787", "default", "sess-456");
    // glm-codex.cmd forwards %* to `codex --dangerously-bypass-approvals-and-sandbox %*`,
    // so `resume 'sess-456'` lands as the codex resume subcommand.
    expect(codexGlm?.command).toContain("& $wrapper resume 'sess-456'");
    expect(codexGlm?.command).not.toContain("--resume");
    // Without a resume id the wrapper is invoked bare (fresh session).
    const fresh = interactiveAgent("codex-local-main", "http://127.0.0.1:8787");
    expect(fresh?.command).toContain("glm-codex.cmd");
    expect(fresh?.command).not.toContain("resume");

    const codexQwen = interactiveAgent("codex-local-long", "http://127.0.0.1:8787", "default", "sess-789");
    expect(codexQwen?.command).toContain("& $wrapper resume 'sess-789'");
    expect(codexQwen?.command).not.toContain("--resume");
  });

  it("escapes single quotes in codex resume session ids", () => {
    const codex = interactiveAgent("codex-official", "http://127.0.0.1:8787", "default", "a'b");
    // ps() doubles single quotes → 'a''b' inside the single-quoted arg.
    expect(codex?.command).toContain("resume 'a''b'");
  });

  it("canResumeProfile mirrors the profiles interactiveAgent can actually resume", () => {
    // Every listed agent profile except council has a resume path.
    for (const id of ["claude-local-long", "claude-local-freeform", "claude-local-main", "codex-local-main", "codex-local-long", "claude-official", "codex-official"]) {
      expect(canResumeProfile(id)).toBe(true);
    }
    expect(canResumeProfile("council")).toBe(false);
  });

  // Hot model registry (stage 1): the launch spec must follow the LIVE option
  // table pushed after a hot customProfiles save (setAgentOptions), and fall
  // back to the built-ins when the module is reset (no push yet / bad payload).
  it("launches a hot-registered custom profile from the live option table", () => {
    const hotProfile: CustomProfileEntry = {
      local: true,
      label: "Hot Probe 744",
      model: "hot-probe-model-x",
      env: { ANTHROPIC_MODEL: "hot-probe-model-x" },
    };
    setAgentOptions(deriveAgentOptions({ "claude-hotprobe": hotProfile }));
    try {
      const spec = interactiveAgent("claude-hotprobe", "http://127.0.0.1:8787", "default");
      expect(spec?.title).toBe("Hot Probe 744");
      expect(spec?.agentProfile).toBe("claude-hotprobe");
      expect(spec?.command).toContain("claude --model 'hot-probe-model-x'");
      expect(spec?.command).toContain("$env:ANTHROPIC_MODEL='hot-probe-model-x'");
      expect(spec?.command).toContain("$env:ANTHROPIC_BASE_URL='http://127.0.0.1:8787'");
      // The fallback model for an id missing from the table stays the old default.
      expect(interactiveAgent("claude-unknown-x", "http://127.0.0.1:8787", "default")?.command)
        .toContain("claude --model 'claude-3-5-sonnet-latest'");
    } finally {
      setAgentOptions(null);
    }
    // Reset: the custom id falls back to the default model (built-in table).
    expect(interactiveAgent("claude-hotprobe", "http://127.0.0.1:8787", "default")?.command)
      .toContain("claude --model 'claude-3-5-sonnet-latest'");
  });
});

describe("native interactive actions", () => {
  it("dispatches the selected editable input without submitting it", () => {
    const target = new EventTarget();
    let detail: unknown;
    target.addEventListener("coterm:interactive-agent", (event) => {
      detail = (event as CustomEvent).detail;
    });

    dispatchNativeWorkflow(target, "pane-1", "claude-local-main", "ultracode goal ");

    expect(detail).toEqual({
      terminalId: "pane-1",
      provider: "claude-local-main",
      initialInput: "ultracode goal ",
    });
    expect((detail as { initialInput: string }).initialInput).not.toMatch(/[\r\n]/);
  });
});
