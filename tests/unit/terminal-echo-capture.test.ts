import { describe, expect, it } from "vitest";
import { createEchoCapture, normalizeEchoKey } from "../../src/renderer/src/components/terminal-echo-capture";

// 真實錄到的 Claude Code 原始串流片段（%APPDATA%\Coterm 的 PTY 歷史，
// 2026-10-17；CI 連線的 Coterm 窗格）。Claude Code 把使用者送出的訊息用
// SGR 100（深灰底）整列刷過、97 畫字，列尾用空格補滿到欄寬才關底色。
const REAL_SINGLE_ECHO =
  "               \x1b[37m\x1b[100m❯ [Image #4] scale放左邊" + " ".repeat(150) + "\x1b[m";

// 真實的「折行訊息」寫法：整段訊息算一個上色區域，列與列之間沒有 CR/LF
// （靠 xterm 自動換行），列尾補白，中間只切前景色（39m/97m）。
const REAL_WRAPPED_ECHO =
  "\x1b[37m\x1b[100m❯ \x1b[97m實際在shadow morrie 實驗的時候，板子照射下去的確四個角都不會是固定為0，" +
  "但會經由一些數學校正為0後產出報告，所以為了方便模擬與報告可以對齊，我認為留下我們現在的邊界做法比較妥 \x1b[39m  " +
  "\x1b[97m當。公司內部也是這麼做的。" + " ".repeat(120) + "\x1b[39m  " +
  "\x1b[97m其他部分還有什麼要納入改版的?現在還差甚麼?看一下我github的issue?" + " ".repeat(40) + "\x1b[m";

describe("echo capture (raw-stream painted-text tap)", () => {
  it("captures a real Claude Code echo painted with SGR 100", () => {
    const capture = createEchoCapture();
    capture.write(REAL_SINGLE_ECHO);
    expect(capture.hasSignal()).toBe(true);
    expect(capture.test(normalizeEchoKey("❯ [Image #4] scale放左邊"))).toBe(true);
  });

  it("captures a wrapped message as one continuous span", () => {
    const capture = createEchoCapture();
    capture.write(REAL_WRAPPED_ECHO);
    const joined = normalizeEchoKey(
      "❯ 實際在shadow morrie 實驗的時候，板子照射下去的確四個角都不會是固定為0，" +
      "但會經由一些數學校正為0後產出報告，所以為了方便模擬與報告可以對齊，我認為留下我們現在的邊界做法比較妥" +
      "當。公司內部也是這麼做的。其他部分還有什麼要納入改版的?現在還差甚麼?看一下我github的issue?",
    );
    expect(capture.test(joined)).toBe(true);
    // 訊息下緣被視口裁掉：可見部分是整段的前綴，也要中。
    expect(capture.test(joined.slice(0, 30))).toBe(true);
    // 但完全無關的文字不能中。
    expect(capture.test("❯ 沒送過這句")).toBe(false);
  });

  it("ignores text painted without a background (signal absent → caller falls back)", () => {
    const capture = createEchoCapture();
    capture.write("\x1b[37m❯ 只是普通白字，沒有底\x1b[m\r\n");
    expect(capture.hasSignal()).toBe(false);
  });

  it("ignores padding-only paint (box fill bands are not a signal)", () => {
    const capture = createEchoCapture();
    capture.write("\x1b[100m" + " ".repeat(80) + "\x1b[m");
    expect(capture.hasSignal()).toBe(false);
    expect(capture.size).toBe(0);
  });

  it("handles an SGR sequence split across PTY chunks", () => {
    const capture = createEchoCapture();
    capture.write("\x1b[37m\x1b[10");
    capture.write("0m❯ 切半送達的底色\x1b[m");
    expect(capture.test(normalizeEchoKey("❯ 切半送達的底色"))).toBe(true);
  });

  it("keeps accumulating across fg-only changes inside one paint region", () => {
    const capture = createEchoCapture();
    // 39m（前景回預設）不關底色——真實串流在折行處就是這樣切的。
    capture.write("\x1b[100m❯ 前半 \x1b[39m  \x1b[97m後半\x1b[m");
    expect(capture.test(normalizeEchoKey("❯ 前半 後半"))).toBe(true);
  });

  it("splits spans on carriage-return repaints (each repainted row matches alone)", () => {
    const capture = createEchoCapture();
    capture.write("\x1b[100m❯ 同一列重繪第一次   \r\x1b[100m❯ 同一列重繪第二次   \x1b[m");
    expect(capture.test(normalizeEchoKey("❯ 同一列重繪第一次"))).toBe(true);
    expect(capture.test(normalizeEchoKey("❯ 同一列重繪第二次"))).toBe(true);
  });

  it("splits spans at cursor moves so two painted rows never concatenate", () => {
    const capture = createEchoCapture();
    capture.write("\x1b[100m❯ 第一列   \x1b[2;1H❯ 第二列\x1b[m");
    expect(capture.test(normalizeEchoKey("❯ 第一列"))).toBe(true);
    expect(capture.test(normalizeEchoKey("❯ 第二列"))).toBe(true);
    expect(capture.test(normalizeEchoKey("❯ 第一列❯ 第二列"))).toBe(false);
  });

  it("treats reverse video as painting, ended by SGR 27", () => {
    const capture = createEchoCapture();
    capture.write("\x1b[7m❯ 反白訊息\x1b[27m 沒刷了");
    expect(capture.test(normalizeEchoKey("❯ 反白訊息"))).toBe(true);
    expect(capture.test(normalizeEchoKey("❯ 反白訊息沒刷了"))).toBe(false);
  });

  it("tracks 256-color / true-color backgrounds and colon-form, ended by 49", () => {
    const capture = createEchoCapture();
    capture.write("\x1b[48;5;236m❯ 256色底\x1b[49m");
    capture.write("\x1b[48;2;30;30;30m❯ 真彩色底\x1b[0m");
    capture.write("\x1b[48:2::40;40;40m❯ 冒號底\x1b[49m");
    expect(capture.test(normalizeEchoKey("❯ 256色底"))).toBe(true);
    expect(capture.test(normalizeEchoKey("❯ 真彩色底"))).toBe(true);
    expect(capture.test(normalizeEchoKey("❯ 冒號底"))).toBe(true);
  });

  it("does not mistake the 2 in 38;2;r;g;b for a background or dim toggle", () => {
    const capture = createEchoCapture();
    capture.write("\x1b[38;2;10;20;30m❯ 彩色前景而已\x1b[m");
    expect(capture.hasSignal()).toBe(false);
  });

  it("never leaks OSC payloads (titles, hyperlinks) into captured text", () => {
    const capture = createEchoCapture();
    capture.write("\x1b[100m❯ 本文\x1b]0;window title\x07後面還是本文\x1b[m");
    expect(capture.test(normalizeEchoKey("❯ 本文"))).toBe(true);
    expect(capture.test(normalizeEchoKey("❯ 本文後面還是本文"))).toBe(false);
    expect(capture.test("windowtitle")).toBe(false);
  });

  it("evicts the oldest spans past the LRU cap", () => {
    const capture = createEchoCapture();
    for (let index = 0; index < 1100; index += 1) {
      capture.write(`\x1b[100m❯ 訊息${index}\x1b[m\r\n`);
    }
    expect(capture.size).toBe(1000);
    expect(capture.test(normalizeEchoKey("❯ 訊息0"))).toBe(false);
    expect(capture.test(normalizeEchoKey("❯ 訊息1099"))).toBe(true);
  });

  it("short keys match only exactly, never by prefix", () => {
    const capture = createEchoCapture();
    capture.write("\x1b[100m❯ ok 長一點的完整訊息內容\x1b[m");
    expect(capture.test(normalizeEchoKey("❯ ok"))).toBe(false);
    expect(capture.test(normalizeEchoKey("❯ ok 長一點的完整訊息內容"))).toBe(true);
  });
});
