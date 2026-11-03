import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { resolve } from "node:path";

// Real xterm buffer, selection service and DOM copy event; no PTY or LLM.
test("native copy cleans painted padding, joins wrapped paths and keeps meaningful text", async ({ page }) => {
  const bundle = await build({
    stdin: {
      contents: 'export { Terminal } from "@xterm/xterm"; export { installTerminalCopy } from "./src/renderer/src/components/terminal-copy";',
      resolveDir: process.cwd(), loader: "ts",
    },
    bundle: true, write: false, format: "iife", globalName: "CopyHarness",
    alias: { "@shared": resolve("src/shared") }, platform: "browser",
  });
  await page.setContent('<div id="host" style="width:800px;height:400px"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  const result = await page.evaluate(async () => {
    const harness = (window as unknown as { CopyHarness: {
      Terminal: new (options: object) => import("@xterm/xterm").Terminal;
      installTerminalCopy: typeof import("../../src/renderer/src/components/terminal-copy").installTerminalCopy;
    } }).CopyHarness;
    const host = document.getElementById("host")!;
    const terminal = new harness.Terminal({ cols: 32, rows: 10, allowProposedApi: true });
    terminal.open(host);
    const uninstall = harness.installTerminalCopy(terminal, host);
    let overwritten = false;
    terminal.textarea!.addEventListener("copy", () => { overwritten = true; });
    const copy = () => {
      const clipboardData = new DataTransfer();
      const event = new ClipboardEvent("copy", { clipboardData, bubbles: true, cancelable: true });
      terminal.textarea!.dispatchEvent(event);
      return clipboardData.getData("text/plain");
    };
    await new Promise<void>((done) => terminal.write(
      "\x1b[32mC:\\My Files\\report.txt\x1b[0m" + " ".repeat(9) + "\r\n" +
      "    nested  code" + " ".repeat(16) + "\r\n" +
      "https://example.com/a/very/long/document.html", done,
    ));
    terminal.select(0, 0, 32);
    const path = copy();
    terminal.select(0, 1, 32);
    const code = copy();
    terminal.select(0, 2, "https://example.com/a/very/long/document.html".length);
    const wrapped = copy();
    const intercepted = overwritten;
    terminal.clearSelection();
    const empty = copy();
    const nativeWithoutSelection = overwritten;
    terminal.reset();
    await new Promise<void>((done) => terminal.write("a".repeat(31) + "中", done));
    terminal.select(0, 0, 34);
    const wideWrap = copy();
    overwritten = false;
    uninstall();
    terminal.select(0, 0, 32);
    copy();
    const restoredNative = overwritten;
    terminal.dispose();
    return { path, code, wrapped, wideWrap, empty, intercepted, nativeWithoutSelection, restoredNative };
  });
  expect(result.path).toBe("C:\\My Files\\report.txt");
  expect(result.code).toBe("    nested  code");
  expect(result.wrapped).toBe("https://example.com/a/very/long/document.html");
  expect(result.wideWrap).toBe("a".repeat(31) + "中");
  expect(result.empty).toBe("");
  expect(result.intercepted).toBe(false);
  expect(result.nativeWithoutSelection).toBe(true);
  expect(result.restoredNative).toBe(true);
});
