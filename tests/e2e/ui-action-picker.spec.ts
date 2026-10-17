import { expect, test } from "@playwright/test";
import { launchCoterm, readUiActions } from "./helpers/coterm-launch";
// Playwright transpiles spec-relative TS imports; the tsconfig `@shared` alias
// is not guaranteed on this runner, so use the relative path.
import { deriveAgentOptions, pickerBackendGroups } from "../../src/shared/agent-options";

const PICKER_SCENARIO_TITLE = "LLM picker dialog controls render and audit";

// The expected DOM order is derived from the same function the renderer calls —
// no hand-maintained list to drift when a profile is added
// (picker-e2e-agent-order-gate). One row per BACKEND now: the row carries its
// primary profile id and, when the backend has more than one harness, each
// harness chip carries its own id right after it.
const BACKEND_ROWS = pickerBackendGroups(deriveAgentOptions());
const PAID_AGENTS = deriveAgentOptions().filter((option) => !option.local && !option.hidden);
// Row layer: one `picker.agent.select` per backend row (primary) + one per PAID
// option. Harness layers live on chips with their own action id — mixing both
// layers into one count was rework#1's failing assertion (11 vs rendered 7).
const ROW_SELECT_IDS = [
  ...BACKEND_ROWS.map((row) => row.primaryId),
  ...PAID_AGENTS.map((option) => option.id),
];
// Chip layer: every harness chip of a multi-harness row carries picker.agent.selectHarness.
const HARNESS_CHIP_IDS = BACKEND_ROWS.flatMap((row) =>
  row.members.length > 1 ? row.members.map((member) => member.id) : [],
);
// Columns: the FREE column (backends, not harness duplicates) + PAID.
const EXPECTED_COLUMN_COUNT = 2;
// The six words a status can show. A raw i18n key or a dev code reaching the
// label is the bug this guards.
const STATUS_WORDS = ["線上", "今日額度用完", "離線", "已停用", "偵測中", "未安裝", "Online", "Daily quota spent", "Offline", "Retired", "Checking", "Not installed"];

const NEXT_RELEASE_AGENTS = [
  "claude-local-long2",
  "codex-local-long2",
] as const;

test(PICKER_SCENARIO_TITLE, async () => {
  const coterm = await launchCoterm();
  try {
    const { page, logPath } = coterm;

    await page.locator("section.project-group").first().waitFor({ state: "visible" });

    // f1b bug 3 regression guard (maintainer 2026-09-22 「模型選擇清單不見了」): the
    // model list still has an entry point and renders the full free/paid
    // columns — this is the "清單存在" assertion. Entry is the sidebar
    // per-project "+" (the top-bar duplicate was removed in v1.5.54);
    // dispatch a native click because force-click can miss the React
    // handler when the project-main div overlaps.
    await page.locator('[data-action-id="sidebar.project.open-agent"]').first().dispatchEvent("click");
    const dialog = page.locator('[data-action-id="picker.dialog.consume"]');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog.locator('[data-action-id="picker.agent.select"]')).toHaveCount(ROW_SELECT_IDS.length);
    await expect(dialog.locator('[data-action-id="picker.agent.selectHarness"]')).toHaveCount(HARNESS_CHIP_IDS.length);
    await expect(dialog.locator(".llm-picker-column")).toHaveCount(EXPECTED_COLUMN_COUNT);
    await page.locator('[data-action-id="picker.close"]').click();
    await expect(dialog).toHaveCount(0);

    // The sidebar path reopens the dialog (openTile + setPickerState chained
    // onClick; a native click again for handler reliability).
    await page.locator('[data-action-id="sidebar.project.open-agent"]').first().dispatchEvent("click");
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    const agentItems = dialog.locator('[data-action-id="picker.agent.select"]');
    await expect(agentItems).toHaveCount(ROW_SELECT_IDS.length);
    await expect.poll(async () => agentItems.evaluateAll((items) =>
      items.map((item) => item.getAttribute("data-agent-id")),
    )).toEqual([...ROW_SELECT_IDS]);
    const harnessChips = dialog.locator('[data-action-id="picker.agent.selectHarness"]');
    await expect.poll(async () => harnessChips.evaluateAll((items) =>
      items.map((item) => item.getAttribute("data-agent-id")),
    )).toEqual([...HARNESS_CHIP_IDS]);
    for (const profile of NEXT_RELEASE_AGENTS) {
      // Presence check only: a primary id renders BOTH on its row button and on
      // its harness chip (both layers carry data-agent-id), so toHaveCount(1)
      // would under-count multi-harness primaries.
      await expect(dialog.locator(`[data-agent-id="${profile}"]`).first()).toBeVisible();
    }
    // One backend never appears as two rows: the DOM order itself is unique per
    // backend, asserted by the derived list above; here the visible proof is
    // that GLM shows up as ONE row carrying BOTH harness chips.
    const glmRow = dialog.locator('[data-backend="my-glm-flash"]');
    await expect(glmRow).toHaveCount(1);
    await expect(glmRow.locator('[data-agent-id="claude-local-main"]')).toHaveCount(1);
    await expect(glmRow.locator('[data-agent-id="codex-local-main"]')).toHaveCount(1);
    // Every free row states its liveness in plain words — never a raw i18n key,
    // never a bare HTTP code in the label.
    const statusLabels = dialog.locator('[data-testid="picker-status"]');
    await expect(statusLabels.first()).toBeVisible();
    for (const label of await statusLabels.allInnerTexts()) {
      expect(STATUS_WORDS).toContain(label.trim());
    }
    // 重探 is a real control: it re-runs the probe without closing the dialog.
    await dialog.locator('[data-action-id="picker.status.refresh"]').click();
    await expect(dialog).toBeVisible();

    // Hot model registry (stage 1) acceptance: save a custom profile via the
    // raw main RPC (NOT the store action) so the picker refresh can only come
    // from the profilesChanged broadcast — then reopen the picker and the new
    // profile must be there WITHOUT an app restart.
    await page.evaluate(async () => {
      await (window as unknown as {
        aiTerminal: { setSettings(patch: Record<string, unknown>): Promise<unknown> };
      }).aiTerminal.setSettings({
        customProfiles: {
          "claude-e2e-hotprobe": {
            local: true,
            label: "E2E Hot Probe",
            // A model name the family table has never seen: it must become a
            // row of its own, not fold into a neighbour and not vanish.
            model: "e2e-hotprobe-model",
            env: {},
          },
        },
      });
    });

    const list = dialog.locator(".llm-picker-list");
    const geometry = await list.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(geometry.clientHeight).toBeGreaterThan(0);
    expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight);
    const lastAgent = dialog.locator('[data-agent-id="codex-official"]');
    await lastAgent.scrollIntoViewIfNeeded();
    await expect(lastAgent).toBeInViewport();

    await dialog.locator("header strong").click();
    await expect(dialog).toBeVisible();

    await page.locator('[data-action-id="picker.close"]').click();
    await expect(dialog).toHaveCount(0);

    await page.locator('[data-action-id="sidebar.project.open-agent"]').first().dispatchEvent("click");
    await expect(dialog).toBeVisible();
    // Reopened after the hot save: the custom profile must now be listed (the
    // broadcast path updated the store; no restart, no store round-trip).
    const probeItem = dialog.locator('[data-agent-id="claude-e2e-hotprobe"]');
    await expect(probeItem).toHaveCount(1);
    await expect(probeItem).toContainText("E2E Hot Probe");
    await expect(dialog.locator('[data-backend="e2e-hotprobe-model"]')).toHaveCount(1);
    await page.locator('[data-action-id="picker.plain.select"]').click();
    await expect(dialog).toHaveCount(0);

    await page.locator('[data-action-id="sidebar.project.open-agent"]').first().dispatchEvent("click");
    await expect(dialog).toBeVisible();
    await page.locator('[data-action-id="picker.backdrop.dismiss"]').click({ position: { x: 5, y: 5 } });
    await expect(dialog).toHaveCount(0);

    await expect.poll(async () => (await readUiActions(logPath)).map((a) => a.actionId), { timeout: 10_000 }).toEqual(
      expect.arrayContaining([
        "picker.dialog.consume",
        "picker.close",
        "picker.plain.select",
        "picker.backdrop.dismiss",
        "picker.status.refresh",
      ]),
    );
  } finally {
    await coterm.close();
  }
});
