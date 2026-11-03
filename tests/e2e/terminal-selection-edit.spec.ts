// Electron + REAL keyboard + REAL mouse-drag selection integration for
// selection-aware delete over a native PTY (2026-11-03). No test-only hooks on
// the production surface: oracles are (a) the xterm DOM text layer and (b) the
// shell's own side effects (files it writes). Selection is a real pointer drag
// across measured character rectangles (Range.getClientRects of the DOM text
// layer) — the same xterm SelectionService path a user's mouse drive.
// If the tile renders via WebGL (canvas, no DOM text layer) there is no
// cell-accurate drag target in headless offscreen mode and the test is NOT
// COVERED — it skips explicitly instead of guessing pixels.

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchCoterm } from "./helpers/coterm-launch";

interface RowsSnapshot {
  texts: string[];
}

const readDomRows = (page: Page): Promise<RowsSnapshot> =>
  page.evaluate(() => {
    const rows = document.querySelectorAll(".xterm .xterm-rows > div");
    return { texts: Array.from(rows, (row) => row.textContent ?? "") };
  });

/** Last viewport row whose text starts a pwsh prompt, or -1. */
const findPromptRow = (snap: RowsSnapshot): number => {
  for (let i = snap.texts.length - 1; i >= 0; i -= 1) {
    if ((snap.texts[i] ?? "").startsWith("PS ")) return i;
  }
  return -1;
};

const waitFor = async (fn: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> => {
  await expect.poll(fn, { timeout: timeoutMs }).toBe(true);
};

interface CharRect { x: number; y: number; width: number; height: number }

/**
 * Viewport coordinates of the UTF-16-1-unit (or surrogate-pair) character at
 * charOffset within .xterm-rows row rowIdx, measured with a DOM Range so the
 * drag targets real glyph centers regardless of font metrics.
 */
const measureCharRect = (page: Page, rowIdx: number, charOffset: number, charLen: number): Promise<CharRect | null> =>
  page.evaluate(
    ({ row, offset, len }: { row: number; offset: number; len: number }) => {
      const rows = document.querySelectorAll(".xterm .xterm-rows > div");
      const rowEl = rows[row];
      if (!rowEl) return null;
      const walker = document.createTreeWalker(rowEl, NodeFilter.SHOW_TEXT);
      let count = 0;
      let node = walker.nextNode();
      while (node) {
        const text = node.textContent ?? "";
        if (offset < count + text.length) {
          const range = document.createRange();
          range.setStart(node, offset - count);
          range.setEnd(node, Math.min(text.length, offset - count + len));
          const rects = range.getClientRects();
          const rect = rects[0];
          if (!rect) return null;
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }
        count += text.length;
        node = walker.nextNode();
      }
      return null;
    },
    { row: rowIdx, offset: charOffset, len: charLen },
  );

/** Real pointer drag from the center of one char to the center of another (may cross rows). */
const dragSelect = async (
  page: Page,
  from: { row: number; char: number; charLen: number },
  to: { row: number; char: number; charLen: number },
): Promise<void> => {
  const a = await measureCharRect(page, from.row, from.char, from.charLen);
  const b = await measureCharRect(page, to.row, to.char, to.charLen);
  if (!a || !b) throw new Error("char rect measurement failed (DOM text layer missing?)");
  const start = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const end = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i += 1) {
    await page.mouse.move(start.x + ((end.x - start.x) * i) / 5, start.y + ((end.y - start.y) * i) / 5);
  }
  await page.mouse.up();
};

/** Median latin character width of a row that surely holds ascii text. */
const measureAsciiCellWidth = async (page: Page, rowIdx: number): Promise<number> => {
  const r0 = await measureCharRect(page, rowIdx, 0, 1);
  const r9 = await measureCharRect(page, rowIdx, 9, 1);
  if (!r0 || !r9 || r9.x <= r0.x) throw new Error("cell width measurement failed");
  return (r9.x - r0.x) / 9;
};

const focusXtermTextarea = async (page: Page): Promise<void> => {
  const textarea = page.locator(".xterm-host textarea.xterm-helper-textarea").first();
  await textarea.waitFor({ state: "attached", timeout: 15_000 });
  await textarea.focus();
  await expect
    .poll(async () => page.evaluate(() => document.activeElement?.className ?? ""), { timeout: 5_000 })
    .toContain("xterm-helper-textarea");
};

test("selection delete edits the CLI input line via real drag+keyboard, never touches program output", async () => {
  test.setTimeout(240_000);
  const workDir = await mkdtemp(join(tmpdir(), "coterm-seledit-"));
  const coterm = await launchCoterm({ defaultWorkspacePath: workDir });
  try {
    const { page } = coterm;
    await page.locator(".boot-screen").waitFor({ state: "detached", timeout: 20_000 });
    await page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      await window.aiTerminal.openTile({ projectId: projects[0]!.id });
    });
    await page.locator(".xterm").first().waitFor({ state: "visible", timeout: 20_000 });
    await focusXtermTextarea(page);

    // NOT_COVERED guard: WebGL canvas rendering has no DOM text layer to aim a
    // drag at in offscreen headless mode. Skip loudly instead of pretending.
    const hasDomTextLayer = await page.evaluate(() => document.querySelectorAll(".xterm .xterm-rows > div").length > 0);
    test.skip(!hasDomTextLayer, "NOT_COVERED: WebGL canvas renderer — no DOM text layer for cell-accurate drags in headless offscreen mode");

    // Wait for the first pwsh prompt.
    await waitFor(async () => findPromptRow(await readDomRows(page)) >= 0, 20_000);

    // --- Scenario 1: short ascii input, drag-select a tail segment, Backspace ---
    const file1 = join(workDir, "sel-short.txt").replace(/\\/g, "/");
    await page.keyboard.type("Set-Content -NoNewline -Path '" + file1 + "' -Value 'abcXYZ'", { delay: 0 });
    let promptRow = -1;
    await waitFor(async () => {
      const snap = await readDomRows(page);
      promptRow = findPromptRow(snap);
      return promptRow >= 0 && (snap.texts[promptRow] ?? "").endsWith("abcXYZ'");
    });
    let snap = await readDomRows(page);
    const line = snap.texts[promptRow]!;
    const quoteIdx = line.indexOf("'abcXYZ'");
    expect(quoteIdx).toBeGreaterThanOrEqual(0);
    // Select "XYZ": value starts one char past the quote; XYZ is value[3..5].
    await dragSelect(
      page,
      { row: promptRow, char: quoteIdx + 1 + 3, charLen: 1 },
      { row: promptRow, char: quoteIdx + 1 + 5, charLen: 1 },
    );
    await page.keyboard.press("Backspace");
    // The live prompt line visibly lost exactly XYZ.
    await waitFor(async () => {
      const s = await readDomRows(page);
      const text = s.texts[promptRow] ?? "";
      return text.includes("'abc'") && !text.includes("XYZ");
    });
    // The command was NOT submitted during the delete.
    expect(await readFile(file1, "utf8").catch(() => null)).toBeNull();
    // Now submit: the EDITED command runs and the file proves the CLI got "abc".
    await page.keyboard.press("Enter");
    await waitFor(async () => (await readFile(file1, "utf8").catch(() => null)) === "abc", 15_000);

    // --- Scenario 2: drag-select on scrollback OUTPUT, Backspace sends nothing ---
    await page.keyboard.type("echo GREENMARK42", { delay: 0 });
    await page.keyboard.press("Enter");
    let markerRow = -1;
    await waitFor(async () => {
      const s = await readDomRows(page);
      markerRow = s.texts.findIndex((text) => text === "GREENMARK42");
      return markerRow >= 0;
    });
    const before = await readDomRows(page);
    const promptBefore = before.texts[findPromptRow(before)]!;
    snap = await readDomRows(page);
    const outLine = snap.texts[markerRow]!;
    const gx = outLine.indexOf("GREENMARK42");
    await dragSelect(
      page,
      { row: markerRow, char: gx, charLen: 1 },
      { row: markerRow, char: gx + 10, charLen: 1 },
    );
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(300);
    // Output row untouched and the live prompt line unchanged — nothing was sent.
    const after = await readDomRows(page);
    expect(after.texts[markerRow]).toBe("GREENMARK42");
    expect(after.texts[findPromptRow(after)]!).toBe(promptBefore);
    // Keyboard input still flows to the CLI after the refused delete.
    await page.keyboard.type("echo S2OK", { delay: 0 });
    await page.keyboard.press("Enter");
    await waitFor(async () => (await readDomRows(page)).texts.some((text) => text === "S2OK"));

    // --- Scenario 3: >8-row CJK/emoji input, drag-select whole value, Backspace ---
    promptRow = findPromptRow(await readDomRows(page));
    expect(promptRow).toBeGreaterThanOrEqual(0);
    const cellWidth = await measureAsciiCellWidth(page, promptRow);
    const rowsWidth = await page.evaluate(() => {
      const el = document.querySelector(".xterm .xterm-rows");
      return el ? el.clientWidth : 0;
    });
    const cols = Math.max(20, Math.round(rowsWidth / cellWidth));
    const unit = "\u4f60\u597dab\ud83d\ude42\u4f60"; // 你好ab🙂你 = 10 cells, 7 UTF-16 units
    const unitCells = 10;
    const reps = Math.ceil((cols * 10) / unitCells); // ~10 wrapped rows
    const value = unit.repeat(reps);
    const file2 = join(workDir, "sel-long.txt").replace(/\\/g, "/");
    await page.keyboard.type("Set-Content -NoNewline -Path '" + file2 + "' -Value '" + value + "'", { delay: 0 });
    // Find the first group row (holds the opening quote) and the last (closing).
    let firstRow = -1;
    let lastRow = -1;
    await waitFor(async () => {
      const s = await readDomRows(page);
      firstRow = s.texts.findIndex((text) => text.includes("-Value '" + unit.slice(0, 4)));
      lastRow = s.texts.findIndex((text) => text.endsWith(value.slice(-4) + "'"));
      return firstRow >= 0 && lastRow >= 0 && lastRow - firstRow > 8;
    }, 30_000);
    snap = await readDomRows(page);
    const firstText = snap.texts[firstRow]!;
    const lastText = snap.texts[lastRow]!;
    const valueStart = firstText.indexOf("-Value '") + "-Value '".length; // first value char (single UTF-16 unit 你)
    const valueLast = lastText.lastIndexOf("'") - 1; // 你 — single UTF-16 unit
    expect(valueLast).toBeGreaterThanOrEqual(0);
    await dragSelect(
      page,
      { row: firstRow, char: valueStart, charLen: 1 },
      { row: lastRow, char: valueLast, charLen: 1 },
    );
    await page.keyboard.press("Backspace");
    // The live line lost the whole CJK value and collapsed to -Value ''".
    await waitFor(async () => {
      const s = await readDomRows(page);
      const text = s.texts[firstRow] ?? "";
      return text.includes("-Value ''") && !text.includes(unit.slice(0, 2));
    }, 15_000);
    // Still unsubmitted until we say so; then submit and the file is EMPTY —
    // proof the CLI received the translated delete, not garbage around it.
    expect(await readFile(file2, "utf8").catch(() => null)).toBeNull();
    await page.keyboard.press("Enter");
    await waitFor(async () => (await readFile(file2, "utf8").catch(() => null)) === "", 15_000);
  } finally {
    await coterm.close();
  }
});
