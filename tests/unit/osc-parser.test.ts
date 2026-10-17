import { describe, expect, it } from "vitest";
import { decodeEscapedCommand, parseOscChunk } from "../../src/main/terminal/osc-parser";

const ESC = "\x1b";
const BEL = "\x07";
const ST = ESC + "\\";

/** Helper: build an OSC 633 marker body with the given code/arg. */
function osc633(code: string, arg?: string): string {
  const body = arg === undefined ? `633;${code}` : `633;${code};${arg}`;
  return `${ESC}]${body}${BEL}`;
}
function osc133(code: string, arg?: string): string {
  const body = arg === undefined ? `133;${code}` : `133;${code};${arg}`;
  return `${ESC}]${body}${BEL}`;
}

describe("parseOscChunk — 133/633 recognition", () => {
  it("parses a full 633 A/B/C/D/E lifecycle in one chunk", () => {
    const chunk = `prefix${osc633("A")}${osc633("B")}${osc633("E", "ls -la")}${osc633("C")}${osc633("D", "0")}suffix`;
    const { markers, carry } = parseOscChunk(chunk);
    expect(carry).toBe("");
    expect(markers.map((m) => m.kind)).toEqual([
      "promptStart", "promptEnd", "command", "preExec", "finished",
    ]);
    expect(markers[2]).toEqual({ kind: "command", value: "ls -la" });
    expect(markers[4]).toEqual({ kind: "finished", value: 0 });
  });

  it("parses OSC 133 A/B/C/D (no E in 133)", () => {
    const chunk = `${osc133("A")}${osc133("B")}${osc133("C")}${osc133("D", "1")}`;
    const { markers } = parseOscChunk(chunk);
    expect(markers.map((m) => m.kind)).toEqual([
      "promptStart", "promptEnd", "preExec", "finished",
    ]);
    expect(markers[3]).toEqual({ kind: "finished", value: 1 });
  });

  it("accepts ST (ESC \\) as a terminator as well as BEL", () => {
    const chunk = `${ESC}]633;C${ST}`;
    const { markers } = parseOscChunk(chunk);
    expect(markers).toEqual([{ kind: "preExec", value: null }]);
  });

  it("D with no exit code yields finished value null (not 0, not fabricated)", () => {
    const { markers } = parseOscChunk(osc633("D"));
    expect(markers).toEqual([{ kind: "finished", value: null }]);
  });

  it("133 E is rejected (only 633 emits command)", () => {
    const { markers } = parseOscChunk(osc133("E", "ls"));
    expect(markers).toEqual([]);
  });
});

describe("parseOscChunk — OSC 9/99/777 notifications", () => {
  function osc9(msg: string): string { return `${ESC}]9;${msg}${BEL}`; }
  function osc99(msg: string): string { return `${ESC}]99;${msg}${BEL}`; }
  function osc777(title: string, body: string): string {
    return `${ESC}]777;notify;${title};${body}${BEL}`;
  }

  it("parses OSC 9 with an approval message → approval kind", () => {
    const { markers } = parseOscChunk(osc9("Do you want to allow this?"));
    expect(markers).toHaveLength(1);
    expect(markers[0]!.kind).toBe("notification");
    expect(markers[0]!.notificationKind).toBe("approval");
  });

  it("parses OSC 99 with args + message (last segment is the message)", () => {
    const { markers } = parseOscChunk(osc99("i=42:d=0;Error: build failed"));
    expect(markers).toHaveLength(1);
    expect(markers[0]!.kind).toBe("notification");
    expect(markers[0]!.notificationKind).toBe("error");
  });

  it("parses OSC 777 notify with title + body", () => {
    const { markers } = parseOscChunk(osc777("Build", "Task complete"));
    expect(markers).toHaveLength(1);
    expect(markers[0]!.kind).toBe("notification");
    expect(markers[0]!.notificationKind).toBe("done");
  });

  it("OSC 9 with ordinary progress text → info (not an attention state)", () => {
    const { markers } = parseOscChunk(osc9("working on it..."));
    expect(markers).toHaveLength(1);
    expect(markers[0]!.notificationKind).toBe("info");
  });

  it("notification sequence split across chunks is reassembled (carryover)", () => {
    const full = osc9("Approve file write?");
    const mid = Math.floor(full.length / 2);
    const r1 = parseOscChunk(full.slice(0, mid));
    const r2 = parseOscChunk(full.slice(mid), r1.carry);
    const markers = [...r1.markers, ...r2.markers];
    expect(markers).toHaveLength(1);
    expect(markers[0]!.kind).toBe("notification");
    expect(markers[0]!.notificationKind).toBe("approval");
  });

  it("source-code strings do not classify as attention (false-positive guard)", () => {
    // A source file printed by the agent containing "error" / "allow" in code
    // context must NOT be parsed as a notification — it's plain PTY text, not
    // an OSC 9/99/777 sequence. The parser only acts on OSC-framed markers.
    const codeChunk = "function handleError() { const allow = true; }\n";
    const { markers } = parseOscChunk(codeChunk);
    expect(markers).toEqual([]);
  });

  it("ST terminator works for OSC 9 too", () => {
    const { markers } = parseOscChunk(`${ESC}]9;Blocked on lock${ST}`);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.notificationKind).toBe("blocked");
  });
});

describe("parseOscChunk — chunk splitting (carryover)", () => {
  it("reassembles a sequence split across chunks at every boundary", () => {
    const full = osc633("E", "git status");
    // Split at each index and ensure the reassembled marker is correct.
    for (let i = 1; i < full.length - 1; i += 1) {
      const a = full.slice(0, i);
      const b = full.slice(i);
      const first = parseOscChunk(a);
      expect(first.markers).toEqual([]);
      const second = parseOscChunk(b, first.carry);
      expect(second.markers, `split at ${i}`).toEqual([{ kind: "command", value: "git status" }]);
      expect(second.carry).toBe("");
    }
  });

  it("handles multiple sequences split across chunks", () => {
    const seq = `${osc633("E", "echo hi")}${osc633("C")}${osc633("D", "0")}`;
    const mid = Math.floor(seq.length / 2);
    const a = parseOscChunk(seq.slice(0, mid));
    const b = parseOscChunk(seq.slice(mid), a.carry);
    const all = [...a.markers, ...b.markers];
    expect(all.map((m) => m.kind)).toEqual(["command", "preExec", "finished"]);
    expect(b.carry).toBe("");
  });

  it("preserves a trailing ESC as carry (could start ST or a new OSC)", () => {
    const { carry } = parseOscChunk(`text${ESC}`);
    expect(carry).toBe(ESC);
  });
});

describe("parseOscChunk — false positives & robustness", () => {
  it("does not emit markers for plain text containing no OSC", () => {
    const { markers, carry } = parseOscChunk("just some normal terminal output\nPS C:\\> ");
    expect(markers).toEqual([]);
    expect(carry).toBe("");
  });

  it("ignores unrelated OSC sequences (e.g. OSC 0 title)", () => {
    const titleSeq = `${ESC}]0;My Title${BEL}`;
    const { markers } = parseOscChunk(titleSeq);
    expect(markers).toEqual([]);
  });

  it("ignores a bare ESC that is not followed by ]", () => {
    const { markers, carry } = parseOscChunk(`\x1b[31mred text\x1b[0m`);
    expect(markers).toEqual([]);
    // The trailing ESC of a CSI is part of a complete CSI, not a carry.
    expect(carry).toBe("");
  });

  it("bounds a runaway sequence with no terminator (drops it, no unbounded growth)", () => {
    // 10K chars with no BEL/ST — exceeds MAX_SEQ_LEN (8192), flushed as text.
    const runaway = `${ESC}]633;E;${"x".repeat(10_000)}`;
    const { markers, carry } = parseOscChunk(runaway);
    expect(markers).toEqual([]);
    expect(carry.length).toBeLessThanOrEqual(1);
  });

  it("handles a malformed D exit arg gracefully (null, not NaN)", () => {
    const { markers } = parseOscChunk(osc633("D", "not-a-number"));
    expect(markers).toEqual([{ kind: "finished", value: null }]);
  });

  it("rejects partially numeric exit args instead of parseInt-prefixing them", () => {
    const { markers } = parseOscChunk(osc633("D", "1junk"));
    expect(markers).toEqual([{ kind: "finished", value: null }]);
  });

  it("parses and decodes the current working directory property", () => {
    const { markers } = parseOscChunk(osc633("P", "Cwd=C:\\work\\x3bsemi"));
    expect(markers).toEqual([{ kind: "cwd", value: "C:\\work;semi" }]);
  });

  it("ignores the optional E nonce instead of appending it to the command", () => {
    const { markers } = parseOscChunk(osc633("E", "echo\\x3b ok;nonce-123"));
    expect(markers).toEqual([{ kind: "command", value: "echo; ok" }]);
  });
});

describe("decodeEscapedCommand", () => {
  it("decodes \\xAB hex escapes", () => {
    expect(decodeEscapedCommand("a\\x41b")).toBe("aAb");
  });

  it("decodes \\\\ as a literal backslash", () => {
    expect(decodeEscapedCommand("a\\\\b")).toBe("a\\b");
  });

  it("leaves unknown backslash escapes as-is (bounded)", () => {
    expect(decodeEscapedCommand("a\\nb")).toBe("a\\nb");
  });

  it("leaves malformed hex escape as-is (bounded)", () => {
    expect(decodeEscapedCommand("a\\xGb")).toBe("a\\xGb");
  });

  it("passes through plain text unchanged", () => {
    expect(decodeEscapedCommand("git status")).toBe("git status");
  });
});
