import { expect, test } from "@playwright/test";
import { launchCoterm, readUiActions } from "./helpers/coterm-launch";

// 1.5.45 warroom identity (label). Two oracles, both from the acceptance list:
//   1. a window opened WITH a label paints the top-edge band, and the colour is
//      a function of the group name (same group ⇒ same colour) — not of the
//      terminal id, and not of the agent profile;
//   2. a hand-opened plain terminal is NOT force-coloured, and gains a band only
//      when the user drives the header swatch.
const SCENARIO_TITLE = "warroom label paints a top-edge band and plain terminals stay uncoloured";

test(SCENARIO_TITLE, async () => {
  test.setTimeout(120_000);
  const coterm = await launchCoterm();
  try {
    const { page, logPath } = coterm;

    await page.locator(".boot-screen").waitFor({ state: "detached", timeout: 20_000 });

    // --- 1. An eyes-opened window: openTile with a label (the exact call the
    // agent API makes after parsing { room, group }).
    await page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      await window.aiTerminal.openTile({
        projectId: projects[0]!.id,
        label: { room: "D:/Coterm/.warroom/next-rev", group: "label" },
      });
    });

    const firstBand = page.locator('[data-testid="xterm-label-band"]').first();
    await firstBand.waitFor({ state: "visible", timeout: 15_000 });
    // Desktop identity stays visible alongside the title and label band.
    const header = page.locator(".xterm-pane-frame > header").first();
    const cwd = header.locator('[data-testid="xterm-cwd-label"]');
    await expect(cwd).toBeVisible();
    await expect(cwd).toHaveText(process.cwd());
    await expect(cwd).toHaveAttribute("title", process.cwd());
    await expect(header.locator(".xterm-model-label")).toBeVisible();
    const firstColor = await firstBand.evaluate((el) => getComputedStyle(el).backgroundColor);

    // A colour means a band; a transparent band would mean the label was dropped.
    expect(firstColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(firstColor).not.toBe("transparent");

    // The band sits on the TOP edge of the pane: within the top few pixels of
    // its frame. This is the "上緣" half of the requirement.
    const geometry = await firstBand.evaluate((el) => {
      const band = el.getBoundingClientRect();
      const frame = el.closest(".xterm-pane-frame")!.getBoundingClientRect();
      return { offsetTop: Math.round(band.top - frame.top), height: Math.round(band.height), width: Math.round(band.width) };
    });
    expect(geometry.offsetTop).toBeLessThanOrEqual(3);
    expect(geometry.width).toBeGreaterThan(40);

    // Metadata only: verify team and paid badges without launching paid agents.
    for (const profile of ["claude-team", "codex-team", "claude-official"]) {
      const identity = await page.evaluate(async (agentProfile) => {
        const layout = await window.aiTerminal.getDockLayout();
        return window.aiTerminal.markTerminalAgent({ terminalId: layout.tiles[0]!.terminalId, agentProfile });
      }, profile);
      await expect(header.locator(".xterm-model-label")).toBeVisible();
      await expect(header.locator(".xterm-model-label")).toHaveClass(/rainbow/);
      if (identity.agentHandle) {
        await expect(header.locator(".xterm-agent-handle")).toHaveText(`@${identity.agentHandle}`);
        await expect(header.locator(".xterm-agent-handle")).toBeVisible();
      }
    }

    // --- 2. A second plain terminal in the SAME project must not be coloured.
    await page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      await window.aiTerminal.openTile({ projectId: projects[0]!.id });
    });
    await expect(page.locator(".xterm-pane-frame")).toHaveCount(2);
    // Exactly one band for two tiles: the plain one was not force-coloured.
    await expect(page.locator('[data-testid="xterm-label-band"]')).toHaveCount(1);

    // --- 3. Same group ⇒ same colour. Open a second labelled window with the
    // SAME group but a different room, and require an identical band colour —
    // proving the colour keys off group, not off the tile or the room.
    await page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      await window.aiTerminal.openTile({
        projectId: projects[0]!.id,
        label: { room: "D:/some/other/room", group: "label" },
      });
    });
    const bands = page.locator('[data-testid="xterm-label-band"]');
    await expect(bands).toHaveCount(2);
    const colors = await bands.evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
    expect(colors[1]).toBe(colors[0]);

    // --- 4. Hand-colouring a plain terminal. The swatch is desktop chrome; a
    // tile with no label gains one on click. Drive the tile that has no band
    // yet — located by the data-label-group attribute rather than a
    // :not(:has(...)) selector, which re-evaluates AFTER the click and would
    // then match nothing.
    // 2026-10-03: the swatch lives in the header's ⋯ tools popover.
    const uncolouredFrame = page.locator(".xterm-pane-frame:not([data-label-group])").first();
    await uncolouredFrame.locator('[data-action-id="terminal.header.more"]').click();
    const uncolouredSwatch = page.locator('.xterm-header-menu [data-action-id="terminal.label.cycle"]');
    await expect(uncolouredSwatch).toBeVisible();
    await uncolouredSwatch.click();

    // The clicked tile now carries the first manual group (1甲) and a band.
    await expect(page.locator('[data-testid="xterm-label-band"]')).toHaveCount(3);
    const oneJia = page.locator('.xterm-pane-frame[data-label-group="1甲"]');
    await expect(oneJia).toHaveCount(1);
    await expect(oneJia.locator('[data-testid="xterm-label-band"]')).toHaveCount(1);

    // The swatch is a real audit-covered action: it must appear in the log.
    await expect.poll(
      async () => (await readUiActions(logPath)).map((a) => a.actionId),
      { timeout: 10_000 },
    ).toContain("terminal.label.cycle");
  } finally {
    await coterm.close();
  }
});
