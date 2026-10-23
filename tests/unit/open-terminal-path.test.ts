import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/renderer/src/components/TerminalDock.tsx", "utf8");

describe("openTerminalPath routing (link-open)", () => {
  it("routes path clicks through defaultActionForTerminalPath", () => {
    expect(src).toContain("defaultActionForTerminalPath(path, canOpenSystemBrowser)");
  });
  it("no longer routes .html clicks into the agent browser popout", () => {
    // openTerminalPath must not call openInAgentBrowser any more; the agent
    // flow (other code paths) may still use it, so assert on the popout-click
    // call shape rather than on mere occurrence of the name.
    expect(src).not.toContain("api.openInAgentBrowser(path)");
    expect(src).not.toContain("agentBrowserWindow === \"popout\"");
  });
  it("keeps explorer reveal for every path click", () => {
    expect(src).toContain("store.requestExplorerReveal(path, projectId)");
  });
  it("keeps web URLs on window.open (system browser via main handler)", () => {
    expect(src).toContain(`window.open(path, "_blank", "noopener,noreferrer")`);
  });
});
