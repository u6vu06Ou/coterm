// Dev-only stdio MCP launcher. The primary MCP surface is the HTTP endpoint
// POST /api/v1/agent/mcp inside the running Coterm app (shared runtime, wired
// approval gate, token auth). This script spawns a SECOND, standalone
// BrowserRuntimeManager with no approval wiring — use it only for offline
// experimentation, never while Coterm itself is running the same userData.
import { join } from "node:path";
import { BrowserRuntimeManager } from "../src/main/browser/browser-runtime-manager";
import { runBrowserMcpServer } from "../src/main/mcp/mcp-server";

const appData = process.env.APPDATA ?? process.env.LOCALAPPDATA ?? process.cwd();
const userDataPath = join(appData, "Coterm");
const browser = new BrowserRuntimeManager({
  userDataPath,
  allowPrivateNetwork: process.env.COTERM_BROWSER_ALLOW_PRIVATE === "1",
});

runBrowserMcpServer(browser);

const shutdown = (): void => { void browser.dispose().finally(() => process.exit(0)); };
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
