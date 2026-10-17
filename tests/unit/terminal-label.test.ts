import { describe, expect, it } from "vitest";
import {
  MANUAL_LABEL_GROUPS,
  labelColor,
  labelHue,
  labelSlot,
  labelTitle,
  nextManualLabel,
} from "../../src/renderer/src/components/terminal-label";

describe("warroom terminal label colour (1.5.45)", () => {
  it("gives the same colour to the same group name, every time", () => {
    // The requirement is "same group, same colour" — a pure function of the
    // group string, so two panes of one team can never disagree, and the web /
    // mobile clients reach the same answer with no shared registry.
    expect(labelColor({ room: "/a", group: "rust" })).toBe(labelColor({ room: "/b", group: "rust" }));
    expect(labelHue("label")).toBe(labelHue("label"));
    // The colour keys off group alone: the room must not shift it.
    expect(labelColor({ room: "", group: "f1" })).toBe(labelColor({ room: "/somewhere/else", group: "f1" }));
  });

  it("keeps the four fixed manual groups on four distinct colours", () => {
    // These four are the palette the boss fixed, so they are the one set we can
    // guarantee stays distinguishable — an unbounded group set cannot be.
    const slots = MANUAL_LABEL_GROUPS.map((group) => labelSlot(group));
    expect(new Set(slots).size).toBe(MANUAL_LABEL_GROUPS.length);
  });

  it("spreads the board's real group names across more than one colour", () => {
    // Regression guard: with the raw FNV value (no avalanche) label / f1 / f2 /
    // usage-head collapsed onto a single slot.
    const groups = ["label", "f1", "f2", "usage-head", "dm", "1甲", "2甲"];
    const slots = new Set(groups.map((group) => labelSlot(group)));
    expect(slots.size).toBeGreaterThanOrEqual(5);
  });

  it("paints no band at all for a plain shell", () => {
    expect(labelColor(null)).toBeNull();
    expect(labelColor(undefined)).toBeNull();
    expect(labelTitle(null)).toBeNull();
  });

  it("names the warroom folder in the tooltip when one is known", () => {
    expect(labelTitle({ room: "D:/wr/next-rev", group: "label" })).toBe("label · D:/wr/next-rev");
    expect(labelTitle({ room: "", group: "label" })).toBe("label");
  });

  it("cycles the four fixed groups and then clears", () => {
    expect(MANUAL_LABEL_GROUPS).toEqual(["1甲", "2甲", "3甲", "4甲"]);
    let current = nextManualLabel(null);
    expect(current).toEqual({ room: "", group: "1甲" });
    current = nextManualLabel(current);
    expect(current).toEqual({ room: "", group: "2甲" });
    current = nextManualLabel(nextManualLabel(current));
    expect(current).toEqual({ room: "", group: "4甲" });
    // Last swatch → off. A plain terminal is never forced to stay coloured.
    expect(nextManualLabel(current)).toBeNull();
  });

  it("restarts the cycle on a warroom-assigned group instead of clearing it", () => {
    // A group the warroom set (not one of the four manual swatches) must not be
    // deleted by the first click — the button colours, it does not erase.
    expect(nextManualLabel({ room: "/wr/x", group: "label" })).toEqual({ room: "/wr/x", group: "1甲" });
  });

  it("keeps the room tooltip when re-colouring a warroom pane", () => {
    expect(nextManualLabel({ room: "/wr/x", group: "1甲" })).toEqual({ room: "/wr/x", group: "2甲" });
  });
});
