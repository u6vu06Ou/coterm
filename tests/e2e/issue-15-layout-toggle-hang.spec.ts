import { expect, test } from "@playwright/test";
import { launchCoterm } from "./helpers/coterm-launch";

// Issue #15: after long uptime, rapidly switching 全展開→單一→展開→另一單一 can
// hang the entire app for seconds. This spec is a repro/stress harness: four
// tiles with heavy scrollback, then a burst of exclusive/grid toggles while a
// rAF probe measures the worst renderer main-thread stall.
test("issue15: rapid exclusive/grid toggles with heavy scrollback", async () => {
  test.setTimeout(300_000);
  const coterm = await launchCoterm();
  try {
    const { page } = coterm;
    await page.locator(".boot-screen").waitFor({ state: "detached", timeout: 20_000 });

    // Open 4 plain PTY tiles (2x2 even split).
    const layout = await page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      for (let i = 0; i < 4; i++) {
        await window.aiTerminal.openTile({ projectId: projects[0]!.id });
      }
      return window.aiTerminal.getDockLayout();
    });
    expect(layout.tiles.length).toBe(4);
    await page.locator('[data-action-id="terminal.activate"]').first().waitFor({ state: "visible", timeout: 20_000 });

    // Fill each PTY with a scrollback approaching the 2M-char main-process cap
    // (issue: hang shows only after hours of accumulated output). 6400 lines of
    // ~300 chars ≈ 1.9M chars per tile.
    const ids = layout.tiles.map((t) => t.terminalId);
    for (const id of ids) {
      await page.evaluate(async (terminalId) => {
        await window.aiTerminal.writeTerminal({
          terminalId,
          data: "1..6400 | ForEach-Object { ('x' * 290) + ' line ' + $_ }\r",
        });
      }, id);
    }
    // Wait until every tile's main-side scrollback is near the cap (output flushed).
    await expect
      .poll(
        async () =>
          page.evaluate(async ({ tileIds }) => {
            const { projects } = await window.aiTerminal.bootstrap();
            const workspace = await window.aiTerminal.getTerminalWorkspace(projects[0]!.id);
            return tileIds.every((id) => (workspace.scrollback[id] ?? "").length > 1_500_000);
          }, { tileIds: ids }),
        { timeout: 240_000, intervals: [2000, 3000, 5000] },
      )
      .toBe(true);

    // Arm a rAF-gap probe in the page: records the worst main-thread stall.
    await page.evaluate(() => {
      (window as unknown as { __stallProbe: { maxGapMs: number; frames: number; stop: boolean } }).__stallProbe = {
        maxGapMs: 0,
        frames: 0,
        stop: false,
      };
      const probe = (window as unknown as { __stallProbe: { maxGapMs: number; frames: number; stop: boolean } }).__stallProbe;
      let last = performance.now();
      const tick = (): void => {
        if (probe.stop) return;
        const now = performance.now();
        probe.maxGapMs = Math.max(probe.maxGapMs, now - last);
        probe.frames += 1;
        last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    // Hammer: 全展開 → 單一(1) → 展開 → 單一(2) → 展開 → 單一(3) → 展開 → 單一(4) → 展開,
    // fired back-to-back with no breathing room (the issue's trigger shape).
    const rpcCounts = await page.evaluate(async (tileIds: string[]) => {
      const sequence: Array<string | null> = [tileIds[0]!, null, tileIds[1]!, null, tileIds[2]!, null, tileIds[3]!, null];
      let calls = 0;
      for (let cycle = 0; cycle < 3; cycle++) {
        for (const target of sequence) {
          calls += 1;
          await window.aiTerminal.setExclusive({ terminalId: target });
        }
      }
      return calls;
    }, ids);

    // Let the tail settle, then read the probe.
    await page.waitForTimeout(3_000);
    const probe = await page.evaluate(() => {
      const p = (window as unknown as { __stallProbe: { maxGapMs: number; frames: number; stop: boolean } }).__stallProbe;
      p.stop = true;
      return { maxGapMs: p.maxGapMs, frames: p.frames };
    });
    console.log(`issue15 probe: maxGapMs=${probe.maxGapMs.toFixed(0)} frames=${probe.frames} exclusiveRpcCount=${rpcCounts}`);

    // The app must stay interactive after the burst: a tile button click takes
    // effect promptly (UI state oracle, not a timing guess).
    await page.locator('[data-action-id="topbar.terminal.exclusive-toggle"]').first().click();
    await expect(page.locator('[data-action-id="topbar.terminal.show-all"]')).toBeVisible({ timeout: 10_000 });
    await page.locator('[data-action-id="topbar.terminal.show-all"]').click();
    await expect(page.locator('[data-action-id="topbar.terminal.show-all"]')).toHaveCount(0, { timeout: 10_000 });

    // Issue bar: stalls of "數秒～數十秒". A single frame gap beyond 5s on this
    // burst is a repro of the reported hang shape.
    expect(probe.maxGapMs).toBeLessThan(5_000);
  } finally {
    await coterm.close();
  }
});
