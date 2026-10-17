import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";
import { normalizeEchoKey, type EchoMatcher } from "./terminal-echo-capture";

export interface TypedLineMarker {
  markSubmitted(): void;
  /** Re-scan the viewport for agent-TUI echoes of the user's messages. */
  scheduleScan(): void;
  setColors(color: string | null): void;
  dispose(): void;
}

// 每次送出一行就掛一組 marker + decoration；marker 在該行被擠出回捲時自動
// dispose，所以長 session 不會累積。超量守門只是防禦：正常情況永遠到不了。
const MAX_MARKS = 512;
// Agent TUIs (Claude Code ❯ / Codex ›) never leave the user's line under the
// cursor at Enter — they erase the input box and re-print the message as
// history. So beside the Enter marker we scan the viewport text: a row that
// starts with a prompt glyph is a sent message unless it sits right under a
// ──── rule (that is the live input box). Indented rows below continue it.
const PROMPT_ROW = /^\s?[❯›>] \S/u;
const RULE_ROW = /^[─━-]{8,}/u;

function rowText(terminal: Terminal, row: number): string {
  return terminal.buffer.active.getLine(row)?.translateToString(true) ?? "";
}

/**
 * Viewport rows that echo a submitted user message. `cursorRow` (viewport
 * coords) marks the live input: Codex's composer ("› Ask Codex to do
 * anything") has no ──── rule above it, so the block holding the cursor is
 * the box being typed in, never history.
 *
 * `echo`（淺色版型的上色訊號攔截器）一旦擷到過任何上色文字就進入嚴格模式：
 * ❯ 列必須比對中「App 實際刷過底色的文字」才算送出的訊息——這正是月亮版型
 * 原樣顯示的那個訊號。嚴格模式下軟換行列接續成立文、沒被刷色的假 ❯ 輸出列
 * 不再誤標；`echo` 沒訊號（例如該 TUI 從不刷底色）時退回舊的外觀啟發式。
 */
export function findEchoedUserRows(
  rows: readonly string[],
  cursorRow = -1,
  wrapped?: readonly boolean[],
  echo?: EchoMatcher,
): number[] {
  const hits: number[] = [];
  const strict = echo !== undefined && echo.hasSignal();
  for (let index = 0; index < rows.length; index += 1) {
    const text = rows[index] ?? "";
    if (!PROMPT_ROW.test(text)) continue;
    const above = (rows[index - 1] ?? "").trim();
    if (RULE_ROW.test(above)) continue;
    if (strict) {
      // 軟換行的續段要「逐列」有上色證據才併進來：Claude Code 新版整屏重繪
      // 會用補白撐滿列寬、靠自動換行接著畫 agent 回話，整段回話在 xterm 裡
      // 全是 ❯ 列的軟換行續段——不逐列驗證就會把整段回話一起刷橘。
      const run = [index];
      let joined = normalizeEchoKey(text);
      while (index + 1 < rows.length && wrapped?.[index + 1] === true) {
        const nextKey = normalizeEchoKey(rows[index + 1] ?? "");
        // 自動換行寫法：整條仍是某段 span 的前綴；逐列重繪寫法：該列自成 span。
        if (nextKey.length === 0 || !(echo.test(joined + nextKey) || echo.test(nextKey))) break;
        index += 1;
        run.push(index);
        joined += nextKey;
      }
      const confirmed = echo.test(joined) || echo.test(normalizeEchoKey(text));
      // 硬換行但縮排的續段（Codex 寫法）：每一列各自要有上色證據才收，
      // 「  ⎿ 工具結果」這類沒被刷色的列不會被吞進來。
      while (index + 1 < rows.length) {
        const next = rows[index + 1] ?? "";
        if (!/^ {2,}\S/.test(next) || RULE_ROW.test(next.trim()) ||
            /^[\s]*[│┃┌┐└┘├┤┬┴┼╭╮╰╯]/u.test(next) ||
            (wrapped && !wrapped[index + 1]) ||
            !echo.test(normalizeEchoKey(next))) break;
        index += 1;
        run.push(index);
      }
      if (confirmed && !run.includes(cursorRow)) hits.push(...run);
      continue;
    }
    const block = [index];
    while (index + 1 < rows.length) {
      const next = rows[index + 1] ?? "";
      if (!/^ {2,}\S/.test(next) || RULE_ROW.test(next.trim()) ||
          /^[\s]*[│┃┌┐└┘├┤┬┴┼╭╮╰╯]/u.test(next) ||
          (wrapped && !wrapped[index + 1])) break;
      index += 1;
      block.push(index);
    }
    if (!block.includes(cursorRow)) hits.push(...block);
  }
  return hits;
}
const TRIM_TO = 256;

/**
 * 使用者按 Enter 送出的那一行，在回捲歷史裡用淡橘底色標記（sun 版型專用，
 * 色票沒給 typedLine 就不畫）。decoration 走 bottom 層鋪整行背景、字色不動，
 * 文字維持原本的 ANSI 色。alt buffer（Claude Code / Codex 全螢幕）沒有回捲
 * 歷史，不標。
 *
 * `echo`：攔截自「底色被抹除前」原始串流的上色文字（terminal-echo-capture）。
 * 有訊號時 echo 掃描用它驗證 ❯ 列，等同月亮版型「App 自己刷的底」原樣可見
 * 的效果；沒給或沒訊號時，行為與舊版文字啟發式完全相同。
 */
export function installTypedLineMarker(terminal: Terminal, color: string | null, echo?: EchoMatcher): TypedLineMarker {
  let currentColor = color;
  let marks: Array<{ marker: IMarker; decoration: IDecoration }> = [];
  let disposed = false;

  const clear = (): void => {
    for (const { marker, decoration } of marks) {
      decoration?.dispose();
      try {
        marker?.dispose();
      } catch {
        // marker 所在行已被擠出回捲：自動 dispose 過，剩下的只是殼。
      }
    }
    marks = [];
  };

  const trimOldest = (): void => {
    while (marks.length > MAX_MARKS - TRIM_TO) marks.shift()?.decoration?.dispose();
  };

  const trimDangling = (): void => {
    marks = marks.filter(({ marker, decoration }) => !marker?.isDisposed && !decoration?.isDisposed);
  };

  const markSubmitted = (): void => {
    if (disposed || !currentColor) return;
    const buffer = terminal.buffer.active;
    if (buffer.type !== "normal") return;
    // Agent TUIs repaint the input row with their answer. The echo scan below
    // owns their highlights; a persistent Enter decoration would color output.
    for (let row = 0; row < terminal.rows; row += 1) {
      if (/^\s?[❯›](?: |$)/u.test(rowText(terminal, buffer.viewportY + row))) return;
    }
    const cursorRow = buffer.baseY + buffer.cursorY;
    // 軟換行的前段走回到第一行，讓整個邏輯行一起上色。
    let firstRow = cursorRow;
    while (firstRow > 0) {
      const prev = buffer.getLine(firstRow - 1);
      if (!prev || !prev.isWrapped) break;
      firstRow -= 1;
    }
    trimDangling();
    trimOldest();
    for (let row = firstRow; row <= cursorRow; row += 1) {
      const marker = terminal.registerMarker(row - cursorRow);
      if (!marker) continue;
      const decoration = terminal.registerDecoration({
        marker,
        x: 0,
        width: terminal.cols,
        backgroundColor: currentColor,
        layer: "bottom",
      });
      if (!decoration) {
        try {
          marker.dispose();
        } catch {
          // 該行已被擠出：略過。
        }
        continue;
      }
      marks.push({ marker, decoration });
    }
  };

  let scanMarks: IDecoration[] = [];
  let scanTimer: ReturnType<typeof setTimeout> | null = null;
  const clearScan = (): void => {
    if (scanMarks.length === 0) return;
    // Decoration BEFORE its marker: a disposed marker has line -1, so the
    // decoration's removal would repaint nothing and the WebGL row cache keeps
    // the old orange band on rows the TUI never rewrites (blank lines, table
    // borders) — stray highlights on text the user never typed. Repaint the
    // viewport too, since the band may sit on a row that moved since.
    for (const decoration of scanMarks) {
      const marker = decoration.marker;
      decoration.dispose();
      marker.dispose();
    }
    scanMarks = [];
    terminal.refresh(0, terminal.rows - 1);
  };
  const scan = (): void => {
    scanTimer = null;
    clearScan();
    if (disposed || !currentColor) return;
    const buffer = terminal.buffer.active;
    const top = buffer.viewportY;
    const rows: string[] = [];
    const wrapped: boolean[] = [];
    for (let row = 0; row < terminal.rows; row += 1) {
      rows.push(rowText(terminal, top + row));
      wrapped.push(buffer.getLine(top + row)?.isWrapped === true);
    }
    const cursorAbs = buffer.baseY + buffer.cursorY;
    for (const offset of findEchoedUserRows(rows, cursorAbs - top, wrapped, echo)) {
      const marker = terminal.registerMarker(top + offset - cursorAbs);
      if (!marker) continue;
      const decoration = terminal.registerDecoration({
        marker, x: 0, width: terminal.cols,
        backgroundColor: currentColor, layer: "bottom",
      });
      if (decoration) scanMarks.push(decoration);
      else marker.dispose();
    }
  };

  // 一般 buffer 掛的標記，切到全螢幕程式（alt buffer）時 xterm 照樣按行號畫，
  // 會變成 Claude Code 畫面上一條條沒字的杏色橫條——進全螢幕就收掉。
  const bufferChange = terminal.buffer.onBufferChange((buffer) => {
    if (buffer.type === "alternate") {
      clearScan();
      clear();
    }
  });

  return {
    markSubmitted,
    scheduleScan() {
      if (disposed || !currentColor || scanTimer) return;
      scanTimer = setTimeout(scan, 150);
    },
    setColors(color) {
      if (currentColor === color) return;
      currentColor = color;
      clearScan();
      // 換色（例如 auto 跟著日夜切換）就整批重置；舊標記隨主題一起消失。
      clear();
    },
    dispose() {
      disposed = true;
      bufferChange.dispose();
      if (scanTimer) clearTimeout(scanTimer);
      clearScan();
      clear();
    },
  };
}

/**
 * Where a fullscreen agent TUI's own caret sits: the end of the live input box
 * (prompt glyph row right under a ──── rule, plus indented continuation rows).
 * Returns viewport coords, or null when there is no such box or the real
 * cursor is already inside it.
 */
export function findTuiInputCaret(terminal: Terminal): { x: number; y: number } | null {
  const buffer = terminal.buffer.active;
  const top = buffer.viewportY;
  for (let row = terminal.rows - 1; row > 0; row -= 1) {
    const text = rowText(terminal, top + row);
    if (!/^\s?[❯›>](?: |$)/u.test(text)) continue;
    if (!RULE_ROW.test(rowText(terminal, top + row - 1).trim())) continue;
    let last = row;
    while (last + 1 < terminal.rows) {
      const next = rowText(terminal, top + last + 1);
      if (!/^ {2,}\S/.test(next) || RULE_ROW.test(next.trim())) break;
      last += 1;
    }
    if (buffer.cursorY >= row && buffer.cursorY <= last) return null;
    const line = buffer.getLine(top + last);
    let end = 0;
    if (line) {
      for (let col = 0; col < terminal.cols; col += 1) {
        const cell = line.getCell(col);
        const chars = cell?.getChars() ?? "";
        if (chars !== "" && chars !== " ") end = col + Math.max(1, cell?.getWidth() ?? 1);
      }
    }
    // Empty prompt "❯ " → caret after the glyph's trailing space.
    const glyphOnly = text.trim().length <= 1;
    return { x: glyphOnly ? end + 1 : end, y: last };
  }
  return null;
}
