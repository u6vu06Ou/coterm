import { describe, expect, it } from "vitest";
import { catalogUiAction } from "../../scripts/lib/ui-action-catalog";
import { discoverUiActions } from "../../scripts/lib/ui-action-inventory";
import { UI_ACTION_SCENARIOS } from "../../scripts/lib/ui-action-scenarios";

describe("UI action total-test catalog", () => {
  it("catalogs every interactive renderer surface with a unique stable ID", async () => {
    const inventory = await discoverUiActions(process.cwd());
    const actionIds = inventory.actions.flatMap((action) => action.actionId ? [action.actionId] : []);

    expect(inventory.summary.missingActionId).toBe(0);
    expect(inventory.summary.uniqueActionIds).toBe(inventory.summary.identified);
    expect(actionIds.map(catalogUiAction)).toHaveLength(inventory.summary.total);
  });

  it("keeps dangerous actions out of the default safe lane", () => {
    for (const actionId of [
      "settings.backup.restore",
      "sidebar.project.delete",
      "terminal.close",
      "topbar.mobile.stop",
    ]) {
      expect(catalogUiAction(actionId)).toMatchObject({
        risk: "destructive",
        liveRequired: true,
      });
    }
  });

  it("references existing action IDs once from executable scenarios", async () => {
    const inventory = await discoverUiActions(process.cwd());
    const existing = new Set(inventory.actions.map((action) => action.actionId));
    const covered = UI_ACTION_SCENARIOS.flatMap((scenario) => scenario.actionIds);

    expect(new Set(covered).size).toBe(covered.length);
    for (const actionId of covered) expect(existing.has(actionId)).toBe(true);
  });
});
