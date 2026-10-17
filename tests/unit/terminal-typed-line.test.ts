import { describe, expect, it } from "vitest";
import { createEchoCapture, normalizeEchoKey } from "../../src/renderer/src/components/terminal-echo-capture";
import { findEchoedUserRows } from "../../src/renderer/src/components/terminal-typed-line";

/**
 * 太陽（淺色）版型「打字行橘條」的心跳測試。
 *
 * 根因：太陽版型在 xterm 解析前抹掉所有 ANSI 底色（terminal-ansi-theme.ts），
 * Claude Code 替使用者訊息刷的深灰底（SGR 100）一併消失；月亮相位不動串流，
 * 直接顯示那層底——所以月亮永遠正確。舊作法在太陽底下用文字外觀啟發式
 * （❯ 開頭＋縮排續行）補標，於是折行漏標、agent 自己印的 ❯ 列誤標。
 *
 * 修法：攔截原始串流裡「刷過底色的文字」（terminal-echo-capture），
 * 掃描時跟月亮用同一個訊號驗證。有訊號＝嚴格模式；沒訊號＝退回舊啟發式。
 */

// 真實錄到的 Claude Code 折行訊息寫法（PTY 歷史，2026-10-17）。
const REAL_WRAPPED_ECHO =
  "\x1b[37m\x1b[100m❯ \x1b[97m實際在shadow morrie 實驗的時候，板子照射下去的確四個角都不會是固定為0，" +
  "但會經由一些數學校正為0後產出報告，所以為了方便模擬與報告可以對齊，我認為留下我們現在的邊界做法比較妥 \x1b[39m  " +
  "\x1b[97m當。公司內部也是這麼做的。" + " ".repeat(120) + "\x1b[39m  " +
  "\x1b[97m其他部分還有什麼要納入改版的?現在還差甚麼?看一下我github的issue?" + " ".repeat(40) + "\x1b[m";

// 上面那段串流進 xterm 自動換行後，buffer 長這樣（列尾補白被 trim 掉）。
const WRAPPED_ROWS = [
  "❯ 實際在shadow morrie 實驗的時候，板子照射下去的確四個角都不會是固定為0，但會經由一些數學校正為0後產出報告，所以為了方便模擬與報告可以對齊，我認為留下我們現在的邊界做法比較妥",
  "當。公司內部也是這麼做的。",
  "其他部分還有什麼要納入改版的?現在還差甚麼?看一下我github的issue?",
];
const WRAPPED_FLAGS = [false, true, true];

function captureWith(...chunks: string[]) {
  const capture = createEchoCapture();
  for (const chunk of chunks) capture.write(chunk);
  return capture;
}

describe("findEchoedUserRows — paint-verified strict mode (sun skin)", () => {
  it("marks every soft-wrapped row of a submitted message (reproduces the wrapped-line miss)", () => {
    const echo = captureWith(REAL_WRAPPED_ECHO);
    expect(findEchoedUserRows(WRAPPED_ROWS, -1, WRAPPED_FLAGS, echo)).toEqual([0, 1, 2]);
    // 舊啟發式在這裡的實際行為：續行從第 0 欄起、沒有縮排 → 只標到第一列。
    // 這正是「多行訊息只有第一行有橘條」的出錯現場。
    expect(findEchoedUserRows(WRAPPED_ROWS, -1, WRAPPED_FLAGS)).toEqual([0]);
  });

  it("keeps the marks when the message sits above the live viewport bottom (scrolled)", () => {
    const echo = captureWith(REAL_WRAPPED_ECHO);
    const rows = [
      ...WRAPPED_ROWS,
      "",
      "● agent 回覆的第一行",
      "● 回覆的第二行",
      "❯ 正在打字的新訊息", // 游標在這列（視口最底）
    ];
    const wrapped = [...WRAPPED_FLAGS, false, false, false, false];
    // cursorRow=6：輸入中的新訊息不標；上面已送出的三列照樣全標。
    expect(findEchoedUserRows(rows, 6, wrapped, echo)).toEqual([0, 1, 2]);
  });

  it("drops agent-printed ❯ rows that were never painted (the wrong-lines case)", () => {
    const echo = captureWith("\x1b[37m\x1b[100m❯ [Image #4] scale放左邊" + " ".repeat(50) + "\x1b[m");
    // agent 的輸出裡自己出現一行長得像訊息的文字——沒被刷底色。
    const rows = ["❯ [Image #4] scale放左邊", "", "❯ 這行是 agent 輸出，不是使用者打的"];
    expect(findEchoedUserRows(rows, -1, [false, false, false], echo)).toEqual([0]);
    // 舊啟發式會連那行假訊息一起標（誤標現場）。
    expect(findEchoedUserRows(rows, -1, [false, false, false])).toEqual([0, 2]);
  });

  it("does not swallow tool-result rows under the echo", () => {
    const echo = captureWith("\x1b[100m❯ 幫我看這個檔案\x1b[m\r\n");
    const rows = ["❯ 幫我看這個檔案", "  ⎿ Read 3 files (ctrl+o to expand)"];
    expect(findEchoedUserRows(rows, -1, [false, false], echo)).toEqual([0]);
  });

  it("still accepts a same-text echo repainted row-by-row (fullscreen redraw style)", () => {
    // 全螢幕重繪常見寫法：游標定位＋逐列刷，每列自成一個 span。
    const echo = captureWith(
      "\x1b[100m❯ 折行訊息第一列   \x1b[2;1H第二列文字   \x1b[3;1H第三列收尾\x1b[m",
    );
    const rows = ["❯ 折行訊息第一列", "第二列文字", "第三列收尾"];
    expect(findEchoedUserRows(rows, -1, [false, true, true], echo)).toEqual([0, 1, 2]);
  });

  it("marks the visible head when the message bottom is clipped off-viewport", () => {
    const echo = captureWith(REAL_WRAPPED_ECHO);
    // 視口只看到前兩列：整條 key 變成 span 的前綴。
    expect(findEchoedUserRows(WRAPPED_ROWS.slice(0, 2), -1, WRAPPED_FLAGS.slice(0, 2), echo)).toEqual([0, 1]);
  });

  it("never marks the live composer even when it was painted (cursor exclusion wins)", () => {
    const echo = captureWith("\x1b[100m› Ask Codex to do anything\x1b[m");
    const rows = ["› Ask Codex to do anything"];
    expect(findEchoedUserRows(rows, 0, [false], echo)).toEqual([]);
  });

  it("falls back to the legacy heuristic when the capture has no signal yet", () => {
    // 該 TUI 從不刷底色（純 shell、沒刷底的 agent）：行為與舊版完全一致。
    const echo = captureWith("plain output, no background paint\r\n");
    // 續行要「有縮排且是軟換行」才算（v1.5.67 起的需求），沒訊號時照舊。
    expect(findEchoedUserRows(["❯ 第一行", "  縮排續行"], -1, [false, true], echo)).toEqual([0, 1]);
    expect(findEchoedUserRows(["❯ 第一行", "  縮排非續行"], -1, [false, false], echo)).toEqual([0]);
    expect(findEchoedUserRows(WRAPPED_ROWS, -1, WRAPPED_FLAGS, echo)).toEqual([0]);
  });

  it("matches a captured message even after unrelated UI got painted later", () => {
    const echo = captureWith(
      "\x1b[100m❯ 第一次問的問題\x1b[m\r\n",
      // 之後 TUI 又刷了一堆別的（狀態列、選單）。
      "\x1b[100m ⏵⏵ accept edits \x1b[m",
      "\x1b[48;5;236m─ status bar ─\x1b[49m",
    );
    expect(findEchoedUserRows(["❯ 第一次問的問題"], -1, [false], echo)).toEqual([0]);
    // 而那些被刷過的 UI 列不會被標——它們不是 ❯ 列。
    expect(
      findEchoedUserRows([" ⏵⏵ accept edits", "─ status bar ─"], -1, [false, false], echo),
    ).toEqual([]);
  });
});

describe("normalizeEchoKey", () => {
  it("strips all whitespace including full-width spaces", () => {
    expect(normalizeEchoKey("❯ a b　c\td")).toBe("❯abcd");
  });
});
