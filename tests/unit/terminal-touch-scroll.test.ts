import { describe, expect, it } from "vitest";
import {
  classifySwipeAxis,
  consumeScrollDelta,
  installXtermMouseNaNGuard,
  planTouchWheelEvents,
  shouldOpenReaderOnSwipe,
  terminalCellHeight,
  touchMouseCell,
  xtermMouseReportingActive,
  xtermTriggerMouseEvent,
} from "../../src/renderer/src/components/terminal-touch-scroll";

describe("consumeScrollDelta", () => {
  it("accumulates sub-line movement without losing pixels", () => {
    let residualPx = 0;
    let lines = 0;
    for (let index = 0; index < 10; index += 1) {
      const next = consumeScrollDelta({ residualPx, deltaPx: 8, cellHeightPx: 36 });
      residualPx = next.residualPx;
      lines += next.lines;
    }
    expect({ lines, residualPx }).toEqual({ lines: 2, residualPx: 8 });
  });

  it("preserves direction and lets reversals cancel naturally", () => {
    expect(consumeScrollDelta({ residualPx: 12, deltaPx: -20, cellHeightPx: 16 })).toEqual({
      lines: 0,
      residualPx: -8,
    });
    expect(consumeScrollDelta({ residualPx: -8, deltaPx: -10, cellHeightPx: 16 })).toEqual({
      lines: -1,
      residualPx: -2,
    });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "uses a finite fallback for invalid cell height %s",
    (cellHeightPx) => {
      const result = consumeScrollDelta({ residualPx: 5, deltaPx: 20, cellHeightPx });
      expect(Number.isFinite(result.lines)).toBe(true);
      expect(Number.isFinite(result.residualPx)).toBe(true);
      expect(Math.abs(result.residualPx)).toBeLessThan(16);
    },
  );

  it("keeps the residual bounded when the cell height changes", () => {
    const first = consumeScrollDelta({ residualPx: 30, deltaPx: 10, cellHeightPx: 36 });
    const second = consumeScrollDelta({ residualPx: first.residualPx, deltaPx: 20, cellHeightPx: 18 });
    expect(Math.abs(second.residualPx)).toBeLessThan(18);
  });

  it("normalizes non-finite movement state", () => {
    expect(consumeScrollDelta({
      residualPx: Number.NaN,
      deltaPx: Number.POSITIVE_INFINITY,
      cellHeightPx: 10,
    })).toEqual({ lines: 0, residualPx: 0 });
  });

  it("measures a rendered row and otherwise uses the fallback", () => {
    const host = (height: number | null) => ({
      querySelector: () => height === null ? null : { firstElementChild: { clientHeight: height } },
    }) as unknown as HTMLElement;
    expect(terminalCellHeight(host(24))).toBe(24);
    expect(terminalCellHeight(host(0))).toBe(16);
    expect(terminalCellHeight(host(null))).toBe(16);
  });

  it("derives the row height from .xterm-screen when .xterm-rows is absent (WebGL)", () => {
    // WebGL/canvas renderer keeps no DOM rows — pinch zoom used to leave scroll
    // conversion stuck at the 16px fallback (#53).
    const host = {
      querySelector: (sel: string) =>
        sel === ".xterm-rows" ? null : sel === ".xterm-screen" ? { clientHeight: 600 } : null,
    } as unknown as HTMLElement;
    expect(terminalCellHeight(host, { rows: 30 })).toBe(20);
    expect(terminalCellHeight(host)).toBe(16); // no rows hint → unchanged fallback
    const bare = { querySelector: () => null } as unknown as HTMLElement;
    expect(terminalCellHeight(bare, { rows: 30 })).toBe(16);
  });
});

describe("shouldOpenReaderOnSwipe", () => {
  const base = { readerOpen: false, deltaY: -40, thresholdPx: 6, mouseReportingActive: false };

  it("opens for an upward swipe on an alt-screen (fullscreen) buffer", () => {
    expect(shouldOpenReaderOnSwipe({ ...base, bufferType: "alternate", baseY: 0 })).toBe(true);
  });

  it("opens for an upward swipe on a normal buffer with empty scrollback", () => {
    expect(shouldOpenReaderOnSwipe({ ...base, bufferType: "normal", baseY: 0 })).toBe(true);
  });

  it("does not steal the swipe when real scrollback exists", () => {
    expect(shouldOpenReaderOnSwipe({ ...base, bufferType: "normal", baseY: 257 })).toBe(false);
  });

  it("ignores downward swipes, sub-threshold movement, and an open reader", () => {
    expect(shouldOpenReaderOnSwipe({ ...base, bufferType: "alternate", baseY: 0, deltaY: 40 })).toBe(false);
    expect(shouldOpenReaderOnSwipe({ ...base, bufferType: "alternate", baseY: 0, deltaY: -5 })).toBe(false);
    expect(shouldOpenReaderOnSwipe({ ...base, bufferType: "alternate", baseY: 0, readerOpen: true })).toBe(false);
  });

  it("stays closed when the app reports mouse events (swipe became wheel events, #47)", () => {
    expect(shouldOpenReaderOnSwipe({ ...base, bufferType: "alternate", baseY: 0, mouseReportingActive: true })).toBe(false);
  });
});

describe("planTouchWheelEvents (#47 touch→wheel parity)", () => {
  it("maps scroll-down lines to wheel-down events (action 1, button 4)", () => {
    expect(planTouchWheelEvents(3)).toEqual({ button: 4, action: 1, count: 3 });
  });

  it("maps scroll-up lines to wheel-up events (action 0)", () => {
    expect(planTouchWheelEvents(-2)).toEqual({ button: 4, action: 0, count: 2 });
  });

  it("returns null for zero movement", () => {
    expect(planTouchWheelEvents(0)).toBeNull();
  });

  it("caps a fling so it cannot enqueue an unbounded burst", () => {
    expect(planTouchWheelEvents(10_000)?.count).toBe(64);
  });
});

describe("xterm mouse-service compat (6.0/6.1)", () => {
  const event = { col: 1, row: 2, x: 10, y: 20, button: 4, action: 0, ctrl: false, alt: false, shift: false };

  it("reads 6.0 coreMouseService.areMouseEventsActive", () => {
    const terminal = { _core: { coreMouseService: { areMouseEventsActive: true } } };
    expect(xtermMouseReportingActive(terminal)).toBe(true);
  });

  it("reads 6.1 mouseStateService.areMouseEventsActive", () => {
    const terminal = { _core: { mouseStateService: { areMouseEventsActive: true } } };
    expect(xtermMouseReportingActive(terminal)).toBe(true);
  });

  it("returns false when the private APIs are absent", () => {
    expect(xtermMouseReportingActive({ _core: {} })).toBe(false);
    expect(xtermMouseReportingActive({})).toBe(false);
  });

  it("triggers via 6.0 coreMouseService.triggerMouseEvent", () => {
    const seen: unknown[] = [];
    const terminal = { _core: { coreMouseService: { areMouseEventsActive: true, triggerMouseEvent: (e: unknown) => seen.push(e) } } };
    expect(xtermTriggerMouseEvent(terminal, event)).toBe(true);
    expect(seen).toEqual([event]);
  });

  it("triggers via 6.1 _mouseService._triggerMouseEvent", () => {
    const seen: unknown[] = [];
    const terminal = { _core: { mouseStateService: { areMouseEventsActive: true }, _mouseService: { _triggerMouseEvent: (e: unknown) => seen.push(e) } } };
    expect(xtermTriggerMouseEvent(terminal, event)).toBe(true);
    expect(seen).toEqual([event]);
  });

  it("refuses to trigger when mouse reporting is off", () => {
    const terminal = { _core: { coreMouseService: { areMouseEventsActive: false, triggerMouseEvent: () => { throw new Error("should not run"); } } } };
    expect(xtermTriggerMouseEvent(terminal, event)).toBe(false);
  });

  it("returns false when reporting is on but no trigger seam exists", () => {
    const terminal = { _core: { mouseStateService: { areMouseEventsActive: true } } };
    expect(xtermTriggerMouseEvent(terminal, event)).toBe(false);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "refuses non-finite col/row %s (AT-156: NaN serializes as literal garbage into the PTY)",
    (bad) => {
      for (const [col, row] of [[bad, 2], [1, bad]] as const) {
        const seen: unknown[] = [];
        const terminal = { _core: { coreMouseService: { areMouseEventsActive: true, triggerMouseEvent: (e: unknown) => seen.push(e) } } };
        expect(xtermTriggerMouseEvent(terminal, { ...event, col, row })).toBe(false);
        expect(seen).toHaveLength(0);
      }
    },
  );
});

describe("touchMouseCell (AT-156 touch→wheel coordinates)", () => {
  const base = { clientX: 40, clientY: 32, rectLeft: 8, rectTop: 8, hostWidth: 320, cols: 20, rows: 10, cellHeight: 16 };

  it("maps a touch point to its clamped cell", () => {
    expect(touchMouseCell(base)).toEqual({ col: 2, row: 1 });
    expect(touchMouseCell({ ...base, clientX: 9999, clientY: -50 })).toEqual({ col: 19, row: 0 });
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses an unmeasured/invalid host width %s (reportTouchWheel must not send)",
    (hostWidth) => {
      expect(touchMouseCell({ ...base, hostWidth })).toBeNull();
    },
  );

  it("refuses when there are no addressable cells (cols/rows <= 0)", () => {
    expect(touchMouseCell({ ...base, cols: 0 })).toBeNull();
    expect(touchMouseCell({ ...base, rows: 0 })).toBeNull();
  });

  it("refuses non-finite touch geometry", () => {
    expect(touchMouseCell({ ...base, clientX: Number.NaN })).toBeNull();
    expect(touchMouseCell({ ...base, rectTop: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it("falls back to a height-derived column width only when cols is unusable", () => {
    // cols<=0 is rejected above; the fallback exists for measured-width edge
    // cases and mirrors the legacy cols<=0 branch formula (height * 0.6).
    const cell = touchMouseCell({ ...base, cellHeight: Number.NaN });
    expect(cell).not.toBeNull();
  });
});

describe("installXtermMouseNaNGuard (AT-156 upstream-path firewall)", () => {
  const finite = { col: 3, row: 4, x: 10, y: 20, button: 4, action: 0, ctrl: false, alt: false, shift: false };

  it("drops NaN/Infinity col/row from xterm's own wheel path (6.1 seam)", () => {
    const seen: unknown[] = [];
    const service = { _triggerMouseEvent: (e: unknown) => seen.push(e) };
    const terminal = { _core: { _mouseService: service } };
    installXtermMouseNaNGuard(terminal);
    const trigger = service._triggerMouseEvent as unknown as (e: unknown) => boolean;
    expect(trigger({ ...finite, col: Number.NaN })).toBe(false);
    expect(trigger({ ...finite, row: Number.POSITIVE_INFINITY })).toBe(false);
    trigger(finite);
    expect(seen).toEqual([finite]);
  });

  it("wraps the 6.0 coreMouseService seam and stays idempotent", () => {
    const seen: unknown[] = [];
    const service = { triggerMouseEvent: (e: unknown) => seen.push(e) };
    const terminal = { _core: { coreMouseService: service } };
    installXtermMouseNaNGuard(terminal);
    const wrapped = service.triggerMouseEvent;
    installXtermMouseNaNGuard(terminal);
    expect(service.triggerMouseEvent).toBe(wrapped);
    expect((wrapped as unknown as (e: unknown) => boolean)({ ...finite, col: Number.NaN })).toBe(false);
    (wrapped as unknown as (e: unknown) => void)(finite);
    expect(seen).toEqual([finite]);
  });

  it("no-ops on terminals without a mouse service", () => {
    expect(() => installXtermMouseNaNGuard({ _core: {} })).not.toThrow();
    expect(() => installXtermMouseNaNGuard({})).not.toThrow();
  });
});

describe("classifySwipeAxis (#57 horizontal-biased axis lock)", () => {
  it("stays horizontal despite vertical drift (the pan-hijack bug)", () => {
    // |dx| is 5x |dy| — a sideways swipe with obvious vertical drift.
    expect(classifySwipeAxis(50, 10)).toBe("horizontal");
    expect(classifySwipeAxis(-50, 10)).toBe("horizontal");
    expect(classifySwipeAxis(50, -10)).toBe("horizontal");
    expect(classifySwipeAxis(-50, -10)).toBe("horizontal");
  });

  it("horizontal wins 45° ties, diagonals, and exactly the 0.3 slope boundary", () => {
    expect(classifySwipeAxis(10, 10)).toBe("horizontal");
    // ~31° off vertical used to scroll (0.6); a diagonal thumb arc now pans.
    expect(classifySwipeAxis(6, 10)).toBe("horizontal");
    expect(classifySwipeAxis(-5, 10)).toBe("horizontal");
    // |dx| = |dy| * 0.3 → >= comparison keeps it horizontal.
    expect(classifySwipeAxis(3, 10)).toBe("horizontal");
    expect(classifySwipeAxis(-3, -10)).toBe("horizontal");
  });

  it("classifies vertical only when |dx| < 0.3 * |dy| (near-straight up/down)", () => {
    expect(classifySwipeAxis(2, 10)).toBe("vertical");
    expect(classifySwipeAxis(-2, 10)).toBe("vertical");
    expect(classifySwipeAxis(2, -10)).toBe("vertical");
    expect(classifySwipeAxis(-2, -10)).toBe("vertical");
    expect(classifySwipeAxis(0, 10)).toBe("vertical");
    expect(classifySwipeAxis(0, -10)).toBe("vertical");
  });

  it("degenerate zero movement defaults to horizontal", () => {
    expect(classifySwipeAxis(0, 0)).toBe("horizontal");
  });
});
