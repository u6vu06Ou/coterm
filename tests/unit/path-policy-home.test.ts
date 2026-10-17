import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expandHomeAlias } from "../../src/main/security/path-policy";

// Terminal path links underline `~/...` (terminal-links HOME_PATH_RE); a click
// hands the raw alias to the main process, so the policy boundary expands it.
describe("expandHomeAlias (terminal ~/ links)", () => {
  it("expands ~/ and ~\\ to the user home", () => {
    expect(expandHomeAlias("~/notes/a.md")).toBe(join(homedir(), "notes/a.md"));
    expect(expandHomeAlias("~\\notes\\a.md")).toBe(join(homedir(), "notes\\a.md"));
  });

  it("expands a bare ~", () => {
    expect(expandHomeAlias("~")).toBe(homedir());
  });

  it("leaves absolute paths and other aliases alone", () => {
    expect(expandHomeAlias("D:\\a\\b.ts")).toBe("D:\\a\\b.ts");
    expect(expandHomeAlias("\\\\nas\\share\\x")).toBe("\\\\nas\\share\\x");
    expect(expandHomeAlias("~other/x")).toBe("~other/x");
    expect(expandHomeAlias("rel/x.md")).toBe("rel/x.md");
  });
});
