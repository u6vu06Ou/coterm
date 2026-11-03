import { afterEach, describe, expect, it } from "vitest";
import { terminalReaderController } from "../../src/renderer/src/components/terminal-reader/terminal-reader-state";

describe("terminal reader font persistence", () => {
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("keeps a manual font choice across open, close, and restart", () => {
    const values = new Map<string, string>();
    (globalThis as { localStorage?: object }).localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };

    terminalReaderController.resetForTest();
    terminalReaderController.toggle("persistent");
    terminalReaderController.stepFont("persistent", 1);
    expect(values.get("coterm-reader-font-size")).toBe("22");

    terminalReaderController.close("persistent");
    terminalReaderController.toggle("persistent");
    expect(terminalReaderController.get("persistent").fontSize).toBe(22);

    terminalReaderController.resetForTest();
    terminalReaderController.toggle("persistent");
    expect(terminalReaderController.get("persistent").fontSize).toBe(22);
  });

  it("falls back to the 20px preset when storage is unavailable or corrupt", () => {
    (globalThis as { localStorage?: object }).localStorage = {};
    terminalReaderController.resetForTest();
    expect(terminalReaderController.get("fresh").fontSize).toBe(20);

    const values = new Map<string, string>([["coterm-reader-font-size", "not-a-number"]]);
    (globalThis as { localStorage?: object }).localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
    terminalReaderController.resetForTest();
    expect(terminalReaderController.get("corrupt").fontSize).toBe(20);
  });
});
