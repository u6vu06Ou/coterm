/**
 * 淺色版型專用的「上色訊號攔截器」（raw-stream tap）。
 *
 * 背景：Claude Code 把使用者送出的訊息用硬編碼底色（SGR 100 深灰）整列刷過，
 * 月亮（深色）版型不動串流，這層底色原樣顯示——哪幾列是使用者打的永遠正確。
 * 太陽（淺色）版型為了白紙質感，在 xterm 解析前把所有 ANSI 底色抹掉
 * （terminal-ansi-theme.ts 的 createLightTerminalAnsiNormalizer），訊號消失，
 * 事後只能用「❯ 開頭＋縮排」的文字外觀猜，於是折行漏標、agent 自己印的假 ❯
 * 行誤標——修幾次敗幾次。
 *
 * 這個模組在抹除「之前」讀原始串流：凡是底色（40-47／48;…／48:…／100-107）
 * 或反白（SGR 7）作用期間寫出的文字，整段記成 span。之後掃描視口時拿列文字
 * 比對 span 集合，等於把月亮看到的訊號救回來用。
 *
 * 比對把所有空白（含全形 U+3000）抽掉：TUI 每次重繪的整列補白寬度不同、
 * 折行端點的 padding 也不固定，去空白後的「可見內容」才是穩定特徵。
 * 純補白（空白填色，如外框底色帶）正規化後是空字串，直接丟棄不當訊號。
 */

/** session 內記住的上色片段上限（LRU；夠長 session 用，又不無限長）。 */
const MAX_SPANS = 1000;
/** 單一片段去空白後的最大長度（防一次巨大量 paint 吃掉記憶體）。 */
const MAX_SPAN_CHARS = 4096;
/** 前綴比對（訊息下緣被視口裁掉時）要求 key 至少這麼長，避免殘列誤中。 */
const MIN_PREFIX_KEY = 4;

export interface EchoMatcher {
  /** 擷到過任何上色文字才為 true；false 時呼叫端退回舊的文字外觀判斷。 */
  hasSignal(): boolean;
  /** key（已去空白）等於某段實際刷過底色的文字，或是它的前綴。 */
  test(key: string): boolean;
}

export interface EchoCapture extends EchoMatcher {
  /** 餵入 PTY 原始 chunk（必須是 ANSI 底色「尚未被正規化抹除」的串流）。 */
  write(chunk: string): void;
  clear(): void;
  /** 目前記住的片段數（testing 用）。 */
  readonly size: number;
}

/** 比對用 key：抽掉所有空白與全形空白，只留可見內容。 */
export function normalizeEchoKey(text: string): string {
  return text.replace(/[\s\u3000]/gu, "");
}

export function createEchoCapture(): EchoCapture {
  // Map 的插入序當 LRU 序；新增時重插刷新，命中不重排（便宜且足夠）。
  const spans = new Map<string, true>();
  // 跨 chunk 的逸出序列殘段（SGR 可能被 PTY 切半送達）。
  let pending = "";
  // 底色作用中累積到的文字。
  let current = "";
  // 現在是否有「會被淺色版型抹掉」的上色在作用。
  let painted = false;

  const storeSpan = (): void => {
    const key = normalizeEchoKey(current);
    current = "";
    if (key.length === 0) return; // 純補白（外框填色帶）不算訊號
    const clipped = key.length > MAX_SPAN_CHARS ? key.slice(0, MAX_SPAN_CHARS) : key;
    spans.delete(clipped);
    spans.set(clipped, true);
    while (spans.size > MAX_SPANS) {
      const oldest = spans.keys().next().value;
      if (oldest === undefined) break;
      spans.delete(oldest);
    }
  };

  const applySgr = (raw: string): void => {
    const tokens = raw === "" ? ["0"] : raw.split(";");
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index] ?? "";
      const value = Number(token);

      // 冒號子參數型：38:／58: 是前景與底線色（不動底色）；48: 是底色。
      if (token.startsWith("38:") || token.startsWith("58:")) continue;
      if (token.startsWith("48:")) {
        painted = true;
        continue;
      }

      // 分號擴展色群組：把參數整組跳過，免得把 38;2;r;g;b 的 2 誤判成其他碼。
      if (value === 38 || value === 58) {
        const mode = Number(tokens[index + 1]);
        index += (mode === 5 ? 3 : mode === 2 ? 5 : 1) - 1;
        continue;
      }
      if (value === 48) {
        const mode = Number(tokens[index + 1]);
        if (mode === 5) index += 2;
        else if (mode === 2) index += 4;
        painted = true;
        continue;
      }

      if (value === 0) {
        if (painted) storeSpan();
        painted = false;
        continue;
      }
      // 反白視同刷底（TUI 用反白畫強調列時同樣是「這列有刷色」的訊號）。
      if (value === 7) {
        painted = true;
        continue;
      }
      if (value === 27 || value === 49) {
        if (painted) storeSpan();
        painted = false;
        continue;
      }
      // 換另一個底色不中斷片段：echo 跨列常重述底色，連續算同一段。
      if ((value >= 40 && value <= 47) || (value >= 100 && value <= 107)) painted = true;
    }
  };

  return {
    get size() {
      return spans.size;
    },
    clear() {
      spans.clear();
      pending = "";
      current = "";
      painted = false;
    },
    hasSignal: () => spans.size > 0,
    test(key) {
      if (key.length === 0) return false;
      if (spans.has(key)) return true;
      if (key.length < MIN_PREFIX_KEY) return false;
      // 訊息下緣被視口裁掉時，可見部分是整段訊息的前綴。
      for (const span of spans.keys()) {
        if (span.startsWith(key)) return true;
      }
      return false;
    },
    write(chunk: string): void {
      const input = pending + chunk;
      pending = "";
      let cursor = 0;
      while (cursor < input.length) {
        const escape = input.indexOf("\x1b", cursor);
        const end = escape < 0 ? input.length : escape;
        if (painted) {
          for (let index = cursor; index < end; index += 1) {
            const char = input[index] ?? "";
            // CR／LF＝換列：Claude Code 的整列重繪靠 CR 開頭，片段在此切開。
            if (char === "\r" || char === "\n") storeSpan();
            else if (char >= " " && char !== "\x7f") current += char;
          }
        }
        if (escape < 0) break;
        if (escape + 1 >= input.length) {
          pending = input.slice(escape);
          break;
        }
        const kind = input[escape + 1];
        if (kind === "[") {
          let finalIndex = escape + 2;
          while (finalIndex < input.length) {
            const code = input.charCodeAt(finalIndex);
            if (code >= 0x40 && code <= 0x7e) break;
            finalIndex += 1;
          }
          if (finalIndex >= input.length) {
            pending = input.slice(escape);
            break;
          }
          if (input[finalIndex] === "m") {
            applySgr(input.slice(escape + 2, finalIndex));
          } else if (painted) {
            // 游標跳動/清除等 CSI：上色區域到此為止，後面寫的是另一列。
            storeSpan();
          }
          cursor = finalIndex + 1;
          continue;
        }
        if (kind === "]") {
          // OSC（視窗標題、超連結…）：吃到 BEL 或 ST，內容不當本文。
          const bel = input.indexOf("\x07", escape + 2);
          const st = input.indexOf("\x1b\\", escape + 2);
          const stop = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st);
          if (stop < 0) {
            pending = input.slice(escape);
            break;
          }
          if (painted) storeSpan();
          cursor = stop + (input[stop] === "\x07" ? 1 : 2);
          continue;
        }
        // 其他 ESC 短序列：跳過兩個字元，同樣視作上色區域結束。
        if (painted) storeSpan();
        cursor = escape + 2;
      }
    },
  };
}
