import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalTranscriptService, providerFor } from "../../src/main/terminal/transcript-service";
import { TerminalSessionFileResolver, mungeClaudeCwd, sameCwd } from "../../src/main/terminal/session-file-resolver";
import { IncrementalTranscriptCache, TranscriptParserRegistry } from "../../src/main/terminal/transcript-parser-registry";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function roots(): Promise<{ root: string; claude: string; codex: string }> {
  const root = await mkdtemp(join(tmpdir(), "coterm-transcript-"));
  dirs.push(root);
  return { root, claude: join(root, "claude"), codex: join(root, "codex") };
}

describe("provider-neutral transcript service", () => {
  it("binds Claude by native id and preserves typed status", async () => {
    const paths = await roots();
    const cwd = "D:\\repo";
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const folder = join(paths.claude, mungeClaudeCwd(cwd));
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, `${sessionId}.jsonl`), `${JSON.stringify({ timestamp: "2026-07-25T00:00:00.000Z", message: { role: "user", content: "hello" } })}\n${JSON.stringify({ timestamp: "2026-07-25T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "world" }, { type: "tool_use", input: "hidden" }] } })}\n`);
    const service = new TerminalTranscriptService({ claudeProjectsRoot: paths.claude, codexSessionsRoot: paths.codex });
    await expect(service.get({ terminalId: "t1", cwd, startedAt: "2026-07-25T00:00:00.000Z", nativeSessionId: sessionId, agentProfile: "claude-official" })).resolves.toMatchObject({ status: "ready", provider: "claude", sessionBinding: "native-id", messages: [{ role: "user", text: "hello" }, { role: "assistant", text: "world" }] });
  });

  it("returns ambiguous instead of guessing a Claude cwd newest file", async () => {
    const paths = await roots();
    const cwd = "D:\\repo";
    const folder = join(paths.claude, mungeClaudeCwd(cwd));
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "one.jsonl"), "{}\n");
    await writeFile(join(folder, "two.jsonl"), "{}\n");
    const resolver = new TerminalSessionFileResolver({ claudeProjectsRoot: paths.claude, codexSessionsRoot: paths.codex });
    await expect(resolver.resolve({ terminalId: "t1", cwd, startedAt: new Date(Date.now() - 1000).toISOString(), nativeSessionId: null, provider: "claude" })).resolves.toMatchObject({ status: "ambiguous", file: null, binding: "none" });
  });

  it("never binds a Claude subagent transcript file (subagents/ dir is not a session)", async () => {
    const paths = await roots();
    const cwd = "D:\\repo";
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const folder = join(paths.claude, mungeClaudeCwd(cwd));
    // Real layout: <sessionId>.jsonl beside a <sessionId>/subagents/agent-*.jsonl
    // tree. The resolver must only ever look at the folder-level session file.
    await mkdir(join(folder, sessionId, "subagents"), { recursive: true });
    await writeFile(join(folder, sessionId, "subagents", "agent-a0cf8ebac01f97249.jsonl"),
      JSON.stringify({ isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "subagent chatter" }] } }) + "\n");
    await writeFile(join(folder, `${sessionId}.jsonl`),
      JSON.stringify({ message: { role: "user", content: "hello" } }) + "\n" +
      JSON.stringify({ message: { role: "assistant", content: "world" } }) + "\n");
    const service = new TerminalTranscriptService({ claudeProjectsRoot: paths.claude, codexSessionsRoot: paths.codex });
    await expect(service.get({ terminalId: "t1", cwd, startedAt: new Date(Date.now() - 1000).toISOString(), nativeSessionId: null, agentProfile: "claude-official" })).resolves.toMatchObject({
      status: "ready", messages: [{ role: "user", text: "hello" }, { role: "assistant", text: "world" }],
    });
    // Binding only the native id also never reaches the subagents tree.
    await expect(service.get({ terminalId: "t2", cwd, startedAt: new Date(Date.now() - 1000).toISOString(), nativeSessionId: "agent-a0cf8ebac01f97249", agentProfile: "claude-official" })).resolves.toMatchObject({ status: "pending", messages: [] });
  });

  it("marks non-agent profiles unsupported and does not read another provider", async () => {
    const paths = await roots();
    const service = new TerminalTranscriptService({ claudeProjectsRoot: paths.claude, codexSessionsRoot: paths.codex });
    await expect(service.get({ terminalId: "t1", cwd: "D:\\repo", startedAt: new Date().toISOString(), nativeSessionId: null, agentProfile: "powershell" })).resolves.toMatchObject({ status: "unsupported", provider: "unsupported", messages: [] });
  });

  it("reads Codex message records and ignores tool/reasoning records", async () => {
    const paths = await roots();
    const startedAt = new Date().toISOString();
    const date = new Date(startedAt);
    const folder = join(paths.codex, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0"));
    await mkdir(folder, { recursive: true });
    const file = join(folder, "rollout-test.jsonl");
    // Minimal synthetic rollout in the REAL Codex shape (top-level type,
    // role/content on payload, every message duplicated as event_msg +
    // response_item) — mirrors ~/.codex/sessions without real content.
    await writeFile(file, [
      JSON.stringify({ timestamp: startedAt, type: "session_meta", payload: { cwd: "D:\\repo", timestamp: startedAt } }),
      JSON.stringify({ timestamp: startedAt, type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>" }] } }),
      JSON.stringify({ timestamp: startedAt, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n<INSTRUCTIONS>" }] } }),
      JSON.stringify({ timestamp: startedAt, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "question" }] } }),
      JSON.stringify({ timestamp: startedAt, type: "event_msg", payload: { type: "user_message", message: "question" } }),
      JSON.stringify({ timestamp: startedAt, type: "response_item", payload: { type: "reasoning", summary: [{ text: "secret reasoning" }] } }),
      JSON.stringify({ timestamp: startedAt, type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{}" } }),
      JSON.stringify({ timestamp: startedAt, type: "event_msg", payload: { type: "agent_message", message: "looking into it", phase: null } }),
      JSON.stringify({ timestamp: startedAt, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "looking into it" }] } }),
      JSON.stringify({ timestamp: startedAt, type: "event_msg", payload: { type: "agent_message", message: "answer", phase: "final_answer" } }),
      JSON.stringify({ timestamp: startedAt, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] } }),
    ].join("\n") + "\n");
    const service = new TerminalTranscriptService({ claudeProjectsRoot: paths.claude, codexSessionsRoot: paths.codex });
    // developer injections and AGENTS.md blobs filtered; event/response_item
    // duplicates collapsed; final_answer marked turn_summary.
    await expect(service.get({ terminalId: "t1", cwd: "D:\\repo", startedAt, nativeSessionId: null, agentProfile: "codex-official" })).resolves.toMatchObject({
      status: "ready",
      provider: "codex",
      messages: [
        { role: "user", kind: "message", text: "question" },
        { role: "assistant", kind: "message", text: "looking into it" },
        { role: "assistant", kind: "turn_summary", text: "answer" },
      ],
    });
  });

  it("incrementally appends complete JSONL lines and rebuilds on truncation", async () => {
    const paths = await roots();
    const file = join(paths.root, "session.jsonl");
    await writeFile(file, `${JSON.stringify({ message: { role: "user", content: "a" } })}\n`);
    const cache = new IncrementalTranscriptCache();
    const parser = new TranscriptParserRegistry().get("claude");
    await expect(cache.read(file, parser)).resolves.toHaveLength(1);
    await writeFile(file, `${JSON.stringify({ message: { role: "assistant", content: "b" } })}\n`);
    await expect(cache.read(file, parser)).resolves.toHaveLength(1);
  });

  it("drops CLI-injected pseudo-user records from the Claude transcript", async () => {
    // The Claude CLI seeds the jsonl with pseudo-user records that are NOT
    // the user's instructions (tool stdout, command metadata, caveat banners).
    // The conversation reader must not show them on the user side.
    const paths = await roots();
    const file = join(paths.root, "cli-noise.jsonl");
    await writeFile(file, [
      JSON.stringify({ message: { role: "user", content: "<local-command-stdout>ls output</local-command-stdout>" } }),
      JSON.stringify({ message: { role: "user", content: "<command-name>bash</command-name>" } }),
      JSON.stringify({ message: { role: "user", content: "<command-message>Running…</command-message>" } }),
      JSON.stringify({ message: { role: "user", content: "Caveat: The messages below were generated by the user" } }),
      JSON.stringify({ message: { role: "user", content: "<system-reminder>internal</system-reminder>" } }),
      JSON.stringify({ message: { role: "user", content: "real question" } }),
      JSON.stringify({ message: { role: "assistant", content: "real answer" } }),
    ].join("\n") + "\n");
    const cache = new IncrementalTranscriptCache();
    const parser = new TranscriptParserRegistry().get("claude");
    const messages = await cache.read(file, parser);
    expect(messages.map((m) => m.text)).toEqual(["real question", "real answer"]);
  });

  it("drops subagent/team noise from the Claude transcript, keeps the human + main-agent pair", async () => {
    // Verified shapes from real ~/.claude/projects transcripts: subagent work
    // surfaces inline as unflagged pseudo-user text (<task-notification>,
    // <teammate-message>, <cross-session-message>, <command-args>, compact
    // continuations) or as structurally marked records (isSidechain:true,
    // isMeta:true, toolUseResult, agentId) — none of it is the human typing
    // or the main agent answering.
    const paths = await roots();
    const file = join(paths.root, "subagent-noise.jsonl");
    await writeFile(file, [
      JSON.stringify({ message: { role: "user", content: "fix the flaky test" } }),
      JSON.stringify({ isSidechain: true, message: { role: "user", content: "You are Explore, a read-only search agent…" } }),
      JSON.stringify({ isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "Exploring…" }] } }),
      JSON.stringify({ isMeta: true, message: { role: "user", content: "Base directory for this session: D:\\repo" } }),
      JSON.stringify({ toolUseResult: { type: "text", content: "x" }, message: { role: "user", content: [{ type: "tool_result", content: "tool output" }] } }),
      JSON.stringify({ agentId: "a01e0414b198bb6a1", toolUseResult: {}, message: { role: "user", content: [] } }),
      JSON.stringify({ message: { role: "user", content: "<task-notification><task-id>w1</task-id><status>completed</status></task-notification>" } }),
      JSON.stringify({ message: { role: "user", content: "<teammate-message from=\"worker\">done with task #1</teammate-message>" } }),
      JSON.stringify({ message: { role: "user", content: "<cross-session-message from=\"peer\">ping</cross-session-message>" } }),
      JSON.stringify({ message: { role: "user", content: "<command-args>--verbose</command-args>" } }),
      JSON.stringify({ message: { role: "user", content: "<bash-input>npm test</bash-input>" } }),
      JSON.stringify({ message: { role: "user", content: "<bash-stdout>ok</bash-stdout>" } }),
      JSON.stringify({ message: { role: "user", content: "This session is being continued from a previous conversation that ran out of context. …" } }),
      JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "Fixed — the gate was missing a null check." }] } }),
    ].join("\n") + "\n");
    const cache = new IncrementalTranscriptCache();
    const parser = new TranscriptParserRegistry().get("claude");
    const messages = await cache.read(file, parser);
    expect(messages.map((m) => `${m.role}: ${m.text}`)).toEqual([
      "user: fix the flaky test",
      "assistant: Fixed — the gate was missing a null check.",
    ]);
  });
});

describe("providerFor prefix routing", () => {
  it("routes free claude/codex profiles by prefix, rejects shells/null", () => {
    expect(providerFor("claude-local-main")).toBe("claude");
    expect(providerFor("claude-local-long")).toBe("claude");
    expect(providerFor("claude-local-freeform")).toBe("claude");
    expect(providerFor("claude-official")).toBe("claude");
    expect(providerFor("codex-local-main")).toBe("codex");
    expect(providerFor("codex-official")).toBe("codex");
    expect(providerFor("powershell")).toBe("unsupported");
    expect(providerFor("cmd")).toBe("unsupported");
    expect(providerFor("wsl")).toBe("unsupported");
    expect(providerFor("claudette")).toBe("unsupported");
    expect(providerFor("codexical")).toBe("unsupported");
    expect(providerFor("claude")).toBe("claude");
    expect(providerFor("codex")).toBe("codex");
    expect(providerFor(null)).toBe("unsupported");
  });

  it("follows Claude to the new session file after /clear and reports the new id", async () => {
    const paths = await roots();
    const cwd = "D:\\repo";
    const oldId = "33333333-3333-4333-8333-333333333333";
    const newId = "44444444-4444-4444-8444-444444444444";
    const otherId = "55555555-5555-4555-8555-555555555555";
    const folder = join(paths.claude, mungeClaudeCwd(cwd));
    await mkdir(folder, { recursive: true });
    const line = (text: string): string => `${JSON.stringify({ message: { role: "user", content: text } })}\n`;
    await writeFile(join(folder, `${oldId}.jsonl`), line("before clear"));
    // The old file went quiet a minute ago; the terminal started before that.
    const quiet = new Date(Date.now() - 60_000);
    await utimes(join(folder, `${oldId}.jsonl`), quiet, quiet);
    await writeFile(join(folder, `${newId}.jsonl`), line("after clear"));
    // Another terminal's live session in the same cwd must never be picked up.
    await writeFile(join(folder, `${otherId}.jsonl`), line("someone else"));
    const service = new TerminalTranscriptService({ claudeProjectsRoot: paths.claude, codexSessionsRoot: paths.codex });
    const rebinds: string[] = [];
    const query = {
      terminalId: "t1", cwd, startedAt: new Date(Date.now() - 120_000).toISOString(),
      nativeSessionId: oldId, agentProfile: "claude-official",
      reservedSessionIds: [otherId], onRebind: (id: string) => rebinds.push(id),
    };
    await expect(service.get(query)).resolves.toMatchObject({ status: "ready", messages: [{ role: "user", text: "after clear" }] });
    expect(rebinds).toEqual([newId]);
  });

  it("stays on the Claude file while it is still being written (no hop onto a parallel session)", async () => {
    const paths = await roots();
    const cwd = "D:\\repo";
    const ownId = "66666666-6666-4666-8666-666666666666";
    const folder = join(paths.claude, mungeClaudeCwd(cwd));
    await mkdir(folder, { recursive: true });
    const line = (text: string): string => `${JSON.stringify({ message: { role: "user", content: text } })}\n`;
    await writeFile(join(folder, "77777777-7777-4777-8777-777777777777.jsonl"), line("unclaimed parallel"));
    const past = new Date(Date.now() - 60_000);
    await utimes(join(folder, "77777777-7777-4777-8777-777777777777.jsonl"), past, past);
    await writeFile(join(folder, `${ownId}.jsonl`), line("mine"));
    const service = new TerminalTranscriptService({ claudeProjectsRoot: paths.claude, codexSessionsRoot: paths.codex });
    await expect(service.get({ terminalId: "t1", cwd, startedAt: new Date(Date.now() - 120_000).toISOString(), nativeSessionId: ownId, agentProfile: "claude-official" }))
      .resolves.toMatchObject({ status: "ready", messages: [{ role: "user", text: "mine" }] });
  });
});

describe("sameCwd Windows alias tolerance", () => {
  it("treats case/slash/trailing-slash variants as the same cwd", () => {
    expect(sameCwd("d:/Coterm", "D:\\Coterm\\")).toBe(true);
    expect(sameCwd("D:\\Coterm", "d:/Coterm")).toBe(true);
    expect(sameCwd("C:/Users/X", "c:\\users\\x\\")).toBe(true);
  });
  it("rejects genuinely different cwds", () => {
    expect(sameCwd("D:/Coterm", "D:/other")).toBe(false);
    expect(sameCwd("", "")).toBe(true);
  });
  it("treats GDrive junction aliases as the same cwd", () => {
    expect(sameCwd("G:\\雲端硬碟\\proj", "C:\\CloudDrive\\proj")).toBe(true);
    expect(sameCwd("C:\\CloudDrive\\proj", "g:\\雲端硬碟\\proj")).toBe(true);
  });
  it("lets a codex rollout match a junction-aliased cwd", async () => {
    const paths = await roots();
    const startedAt = new Date().toISOString();
    const date = new Date(startedAt);
    const folder = join(paths.codex, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0"));
    await mkdir(folder, { recursive: true });
    const file = join(folder, "rollout-alias.jsonl");
    // session_meta records cwd as a lower-case forward-slash alias of the
    // descriptor's Windows backslash cwd — must still match after normalization.
    await writeFile(file, [
      JSON.stringify({ timestamp: startedAt, type: "session_meta", payload: { cwd: "d:/Coterm", timestamp: startedAt } }),
      JSON.stringify({ timestamp: startedAt, type: "event_msg", payload: { type: "user_message", message: "hi" } }),
    ].join("\n") + "\n");
    const service = new TerminalTranscriptService({ claudeProjectsRoot: paths.claude, codexSessionsRoot: paths.codex });
    await expect(service.get({ terminalId: "t1", cwd: "D:\\Coterm\\", startedAt, nativeSessionId: null, agentProfile: "codex-local-main" })).resolves.toMatchObject({ status: "ready", provider: "codex", messages: [{ role: "user", text: "hi" }] });
  });
});
