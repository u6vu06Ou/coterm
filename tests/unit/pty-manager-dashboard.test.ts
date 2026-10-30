import { describe, expect, it } from "vitest";
import { applyTitleToInfo } from "../../src/main/terminal/pty-manager";
import { shellTitle } from "../../src/shared/terminal";
import type { TerminalInfo } from "@shared/types";

const baseInfo: TerminalInfo = {
  id: "t1",
  projectId: "p1",
  profile: "pwsh",
  title: "PowerShell",
  cwd: "D:\\proj",
  cols: 100,
  rows: 28,
  status: "running",
  startedAt: "2026-07-08T00:00:00.000Z",
  closedAt: null,
  lastExitCode: null,
  isAgent: true,
  agentProfile: "claude-local-main",
  ownedByAgentApi: false,
  pid: 12345,
  nativeSessionId: null,
  worktreeId: null,
  contextUsage: null,
};

describe("applyTitleToInfo", () => {
  it("returns info unchanged when title is empty", () => {
    const result = applyTitleToInfo(baseInfo, "");
    expect(result.title).toBe("PowerShell");
  });

  it("returns info unchanged when title equals the shell default", () => {
    // shellTitle("pwsh") returns "PowerShell" — the guard in applyTitleToInfo
    // must prevent the shell default from overwriting a real LLM summary.
    const result = applyTitleToInfo(baseInfo, shellTitle("pwsh"));
    expect(result.title).toBe("PowerShell");
    expect(result).toBe(baseInfo);
  });

  it("updates title when a real LLM title arrives", () => {
    const result = applyTitleToInfo(baseInfo, "Fixing auth bug in login.ts");
    expect(result.title).toBe("Fixing auth bug in login.ts");
  });

  it("strips the Codex spinner braille prefix and stores the stable title", () => {
    const result = applyTitleToInfo(baseInfo, "⠧ sync_party");
    expect(result.title).toBe("sync_party");
  });

  it("spinner frames of the same title collapse to one change (no refresh loop)", () => {
    // OSC sequence ⠧ -> ⠴ -> bare title: only the first frame may produce a
    // new info object; identity holds afterwards, so pty-manager emits no
    // further terminalListChanged for the remaining ~10Hz frames.
    const first = applyTitleToInfo(baseInfo, "⠧ sync_party");
    const second = applyTitleToInfo(first, "⠴ sync_party");
    const third = applyTitleToInfo(second, "sync_party");
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("strips multiple braille spinner prefixes from any profile's title", () => {
    expect(applyTitleToInfo(baseInfo, "⣾⣽ Summarize repo").title).toBe("Summarize repo");
  });

  it("ignores a spinner-only title (prefix strips to empty)", () => {
    expect(applyTitleToInfo(baseInfo, "⠧")).toBe(baseInfo);
  });

  it("ignores the Claude Code provider placeholder until a task summary arrives", () => {
    expect(applyTitleToInfo(baseInfo, "✳ Claude Code")).toBe(baseInfo);
  });

  it("ignores the bare lowercase claude title stamped by the npm shim", () => {
    // claude-team panes emit "◐ Claude Code" plus one transient "claude" from
    // the launcher shim and nothing else — the header used to latch onto that
    // word. Refusing it here keeps info.title on the shell default so the
    // renderer falls through to its summary sources.
    expect(applyTitleToInfo(baseInfo, "claude")).toBe(baseInfo);
    expect(applyTitleToInfo(baseInfo, "✳ claude")).toBe(baseInfo);
    expect(applyTitleToInfo(baseInfo, "claude.cmd")).toBe(baseInfo);
  });

  it("keeps a real summary that arrived before a late placeholder frame", () => {
    // Order matters: once a real summary is stored, a later placeholder frame
    // (Claude re-emits "◐ Claude Code" between turns) must not replace it.
    const withSummary = applyTitleToInfo(baseInfo, "Fixing the pane header summary");
    expect(applyTitleToInfo(withSummary, "◐ Claude Code").title).toBe("Fixing the pane header summary");
    expect(applyTitleToInfo(withSummary, "claude").title).toBe("Fixing the pane header summary");
  });

  it("updates title when title changes across turns", () => {
    const first = applyTitleToInfo(baseInfo, "Task A");
    const second = applyTitleToInfo(first, "Task B");
    expect(second.title).toBe("Task B");
  });
});
