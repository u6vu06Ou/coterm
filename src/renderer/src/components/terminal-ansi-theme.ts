/**
 * Renderer-only SGR normalization for light terminal palettes.
 *
 * Agent TUIs often paint prompts and diffs with hard-coded dark backgrounds or
 * reverse-video. Those cell colors override xterm's light palette. We remove
 * background/reverse SGR attributes before xterm parses the stream; raw PTY
 * bytes in main-process history remain untouched. Foreground and semantic
 * colors are retained, and xterm's minimumContrastRatio handles true-color
 * text that would otherwise be too pale on the selected light background.
 *
 * Dim (standalone SGR 2) is translated, not stripped: stripping rendered dim
 * text at full foreground color — Claude Code's ghost prompt hint then looked
 * exactly like typed text — while real SGR-2 fading is applied after xterm's
 * contrast pass (WebGL TextureAtlas._getForegroundColor) or with a halved
 * ratio (DomRenderer 4.5 -> 2.25), so genuine dim is near-invisible on the
 * light paper. SGR 2 becomes an explicit readable mid-gray truecolor fg
 * (DIM_FG_TRUECOLOR below), and standalone SGR 22 (normal intensity) becomes
 * "22;39" so the converted dim span ends with the default foreground.
 * Translation happens pre-parse, so it works identically for the WebGL
 * renderer and the DOM fallback.
 */
export interface TerminalAnsiNormalizer {
  write(chunk: string): string;
  reset(): void;
}

/**
 * Standalone SGR 2 (dim) becomes this mid-gray truecolor foreground instead of
 * being stripped. #676056 sits at 5.24:1 contrast against the paper theme's
 * #f3ebdc background mid-tone — above xterm's 4.5 minimumContrastRatio (so it
 * is not auto-darkened back into normal text) and clearly lighter than the
 * near-black default fg (#2b2420, 12.88:1).
 */
const DIM_FG_TRUECOLOR = "38;2;103;96;86";

function normalizeSgrParameters(raw: string): string | null {
  const tokens = raw === "" ? ["0"] : raw.split(";");
  const kept: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const value = Number(token);

    // Colon sub-parameter forms: \x1b[38:2::r:g:b e.g. one token each. Foreground
    // (38:) and underline color (58:) stay verbatim; background (48:) is stripped.
    if (token.startsWith("38:") || token.startsWith("58:")) {
      kept.push(token);
      continue;
    }
    if (token.startsWith("48:")) continue;

    // Semicolon parameter groups: <code>;<mode>;... consume the group so the
    // color mode ("2"/"5") is never mistaken for a standalone SGR code —
    // without this, the dim strip below would corrupt "38;2;r;g;b" into "38;r;g;b".
    if (value === 38 || value === 58) {
      const mode = Number(tokens[index + 1]);
      const span = mode === 5 ? 3 : mode === 2 ? 5 : 1;
      kept.push(tokens.slice(index, index + span).join(";"));
      if (span === 3) index += 2;
      else if (span === 5) index += 4;
      continue;
    }
    if (value === 48) {
      const mode = Number(tokens[index + 1]);
      if (mode === 5) index += 2;
      else if (mode === 2) index += 4;
      continue;
    }

    // Standalone SGR 2 = dim/faint: translate to a readable mid-gray truecolor
    // foreground. (Real dim is faded after xterm's contrast pass — WebGL — or
    // uses half the ratio — DOM — so it is near-invisible on the light paper;
    // stripping instead made the ghost prompt hint look like typed text.)
    if (value === 2) {
      kept.push(DIM_FG_TRUECOLOR);
      continue;
    }

    // Standalone SGR 22 (normal intensity) also restores the default
    // foreground, so a converted dim span ends cleanly ("\x1b[2m…\x1b[22m").
    if (value === 22) {
      kept.push("22;39");
      continue;
    }

    if (value === 7 || value === 27 || (value >= 40 && value <= 49) || (value >= 100 && value <= 107)) {
      continue;
    }
    kept.push(token);
  }

  return kept.length > 0 ? kept.join(";") : null;
}

export function createLightTerminalAnsiNormalizer(): TerminalAnsiNormalizer {
  let pending = "";
  return {
    write(chunk: string): string {
      const input = pending + chunk;
      pending = "";
      let output = "";
      let cursor = 0;

      while (cursor < input.length) {
        const escape = input.indexOf("\x1b", cursor);
        if (escape < 0) {
          output += input.slice(cursor);
          break;
        }
        output += input.slice(cursor, escape);
        if (escape + 1 >= input.length) {
          pending = input.slice(escape);
          break;
        }
        if (input[escape + 1] !== "[") {
          output += input.slice(escape, escape + 2);
          cursor = escape + 2;
          continue;
        }

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

        const sequence = input.slice(escape, finalIndex + 1);
        if (input[finalIndex] !== "m") {
          output += sequence;
        } else {
          const normalized = normalizeSgrParameters(input.slice(escape + 2, finalIndex));
          if (normalized !== null) output += `\x1b[${normalized}m`;
        }
        cursor = finalIndex + 1;
      }
      return output;
    },
    reset(): void {
      pending = "";
    },
  };
}
