import { describe, expect, it } from "vitest";
import {
  captureHorizontalScrollLock,
  imeAncestorScrollTargets,
  imeInnerScrollTargets,
  restoreHorizontalScrollLock,
} from "../../src/renderer/src/components/terminal-ime-scroll-lock";

// Minimal scrollable-box stand-in: only scrollLeft matters to the lock.
function box(scrollLeft = 0): Element {
  return { scrollLeft } as unknown as Element;
}

describe("captureHorizontalScrollLock", () => {
  it("freezes each box at its live offset (remote pan must survive composing)", () => {
    const host = box(640);
    const entries = captureHorizontalScrollLock([host]);
    expect(entries).toEqual([{ el: host, left: 640 }]);
  });

  it("locks to 0 when asked (desktop xterm boxes never pan legitimately)", () => {
    const host = box(120);
    expect(captureHorizontalScrollLock([host], { zero: true })).toEqual([{ el: host, left: 0 }]);
  });

  it("skips nulls and de-duplicates repeated boxes", () => {
    const host = box(0);
    expect(captureHorizontalScrollLock([host, null, undefined, host])).toHaveLength(1);
  });
});

describe("restoreHorizontalScrollLock", () => {
  it("undoes Chromium's per-keystroke reveal-caret scroll", () => {
    const xterm = box(0);
    const ancestor = box(0);
    const lock = captureHorizontalScrollLock([xterm, ancestor]);

    // One keystroke of 注音: the caret leaves the 1-cell helper textarea and
    // Chromium shoves a scrollable ancestor sideways one cell.
    ancestor.scrollLeft = 9;
    expect(restoreHorizontalScrollLock(lock)).toBe(1);
    expect(ancestor.scrollLeft).toBe(0);

    // Repeated keystrokes must not accumulate — this is what used to walk the
    // view to the scroll maximum and force TSF to commit the composition.
    for (let i = 1; i <= 30; i += 1) {
      xterm.scrollLeft = i * 9;
      ancestor.scrollLeft = i * 9;
      restoreHorizontalScrollLock(lock);
    }
    expect(xterm.scrollLeft).toBe(0);
    expect(ancestor.scrollLeft).toBe(0);
  });

  it("restores a frozen remote pan instead of zeroing it", () => {
    const remoteHost = box(480);
    const lock = captureHorizontalScrollLock([remoteHost]);
    remoteHost.scrollLeft = 489;
    restoreHorizontalScrollLock(lock);
    expect(remoteHost.scrollLeft).toBe(480);
  });

  it("reports 0 corrections when nothing drifted", () => {
    const el = box(0);
    expect(restoreHorizontalScrollLock(captureHorizontalScrollLock([el]))).toBe(0);
  });
});

describe("scroll target collection", () => {
  it("collects the xterm boxes that can absorb a reveal-caret scroll", () => {
    const xterm = box();
    const screen = box();
    const viewport = box();
    const host = {
      querySelector: (selector: string) =>
        ({ ".xterm": xterm, ".xterm-screen": screen, ".xterm-viewport": viewport })[selector] ?? null,
    } as unknown as Element;
    expect(imeInnerScrollTargets(host)).toEqual([host, xterm, screen, viewport]);
  });

  it("walks every ancestor up to the document element", () => {
    const root = { parentElement: null } as unknown as Element;
    const mid = { parentElement: root } as unknown as Element;
    const host = { parentElement: mid } as unknown as Element;
    expect(imeAncestorScrollTargets(host)).toEqual([mid, root]);
  });
});
