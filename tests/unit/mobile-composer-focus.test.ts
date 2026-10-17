import { describe, expect, it } from "vitest";
import {
  FOCUS_RECLAIM_RETRY_DELAYS_MS,
  OUTSIDE_TAP_SUSPEND_MS,
  shouldReclaimComposerFocus,
  type ComposerFocusProbe,
} from "../../src/renderer/src/components/mobile/mobile-composer-focus";

function fakeElement(tagName: string): Element {
  return { tagName } as unknown as Element;
}

function fakePanel(contained: ReadonlySet<Element>): Element {
  return { contains: (other: Element) => contained.has(other) } as unknown as Element;
}

function probe(overrides: Partial<ComposerFocusProbe>): ComposerFocusProbe {
  return {
    activeElement: null,
    panel: null,
    textarea: null,
    recentOutsidePointerDown: false,
    ...overrides,
  };
}

describe("shouldReclaimComposerFocus", () => {
  it("reclaims when focus fell to null (IME input-connection teardown)", () => {
    expect(shouldReclaimComposerFocus(probe({ textarea: fakeElement("TEXTAREA"), activeElement: null }))).toBe(true);
  });

  it("reclaims when focus fell to body or the document root", () => {
    const textarea = fakeElement("TEXTAREA");
    expect(shouldReclaimComposerFocus(probe({ textarea, activeElement: fakeElement("BODY") }))).toBe(true);
    expect(shouldReclaimComposerFocus(probe({ textarea, activeElement: fakeElement("HTML") }))).toBe(true);
  });

  it("does nothing when the textarea is already focused", () => {
    const textarea = fakeElement("TEXTAREA");
    expect(shouldReclaimComposerFocus(probe({ textarea, activeElement: textarea }))).toBe(false);
  });

  it("does nothing when there is no textarea to focus", () => {
    expect(shouldReclaimComposerFocus(probe({ textarea: null, activeElement: null }))).toBe(false);
  });

  it("leaves controls inside the composer panel alone (send/cancel/toggle taps)", () => {
    const button = fakeElement("BUTTON");
    const panel = fakePanel(new Set([button]));
    expect(shouldReclaimComposerFocus(probe({ textarea: fakeElement("TEXTAREA"), panel, activeElement: button }))).toBe(false);
  });

  it("reclaims programmatic steals into a real outside element (xterm helper textarea)", () => {
    // The regression: terminal recovery refocused xterm's helper textarea on
    // every visualViewport resize during an IME language switch, and the old
    // reclaim deliberately ignored "a real element elsewhere".
    const xtermHelper = fakeElement("TEXTAREA");
    const panel = fakePanel(new Set());
    expect(
      shouldReclaimComposerFocus(probe({ textarea: fakeElement("TEXTAREA"), panel, activeElement: xtermHelper })),
    ).toBe(true);
  });

  it("respects a deliberate outside tap inside the suspend window", () => {
    const outside = fakeElement("DIV");
    expect(
      shouldReclaimComposerFocus(
        probe({ textarea: fakeElement("TEXTAREA"), activeElement: outside, recentOutsidePointerDown: true }),
      ),
    ).toBe(false);
  });

  it("still reclaims body/html/null even inside the outside-tap suspend window", () => {
    expect(
      shouldReclaimComposerFocus(
        probe({ textarea: fakeElement("TEXTAREA"), activeElement: fakeElement("BODY"), recentOutsidePointerDown: true }),
      ),
    ).toBe(true);
  });

  it("retry ladder reaches ~600ms (keyboard reconnect outlasts 3 frames) and suspend covers a tap settle", () => {
    const lastDelay = Math.max(...FOCUS_RECLAIM_RETRY_DELAYS_MS);
    expect(lastDelay).toBeGreaterThanOrEqual(600);
    expect(OUTSIDE_TAP_SUSPEND_MS).toBeGreaterThanOrEqual(lastDelay);
  });
});

import {
  KEYBOARD_DROP_MIN_GROWTH_PX,
  KEYBOARD_REBIND_COOLDOWN_MS,
  shouldRebindAfterKeyboardDrop,
  type KeyboardDropProbe,
} from "../../src/renderer/src/components/mobile/mobile-composer-focus";

function dropProbe(overrides: Partial<KeyboardDropProbe>): KeyboardDropProbe {
  return {
    textareaFocused: true,
    previousViewportHeight: 400,
    viewportHeight: 400 + KEYBOARD_DROP_MIN_GROWTH_PX,
    recentOutsidePointerDown: false,
    msSinceLastRebind: Number.POSITIVE_INFINITY,
    ...overrides,
  };
}

describe("shouldRebindAfterKeyboardDrop", () => {
  it("rebinds when the keyboard hides but the textarea kept DOM focus (yellow ring, dead keys)", () => {
    expect(shouldRebindAfterKeyboardDrop(dropProbe({}))).toBe(true);
  });
  it("ignores small IME candidate-bar resizes", () => {
    expect(shouldRebindAfterKeyboardDrop(dropProbe({ viewportHeight: 440 }))).toBe(false);
  });
  it("ignores the keyboard showing (viewport shrinking)", () => {
    expect(shouldRebindAfterKeyboardDrop(dropProbe({ previousViewportHeight: 800, viewportHeight: 400 }))).toBe(false);
  });
  it("leaves it to the blur path when the textarea is not focused", () => {
    expect(shouldRebindAfterKeyboardDrop(dropProbe({ textareaFocused: false }))).toBe(false);
  });
  it("respects a deliberate outside tap", () => {
    expect(shouldRebindAfterKeyboardDrop(dropProbe({ recentOutsidePointerDown: true }))).toBe(false);
  });
  it("rebinds at most once per cooldown so show/hide cannot ping-pong", () => {
    expect(shouldRebindAfterKeyboardDrop(dropProbe({ msSinceLastRebind: KEYBOARD_REBIND_COOLDOWN_MS - 1 }))).toBe(false);
  });
});
