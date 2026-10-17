import { join, resolve } from "node:path";
import { discoverUiActions, writeUiActionInventory } from "./lib/ui-action-inventory";

const root = resolve(import.meta.dirname, "..");
const checkOnly = process.argv.includes("--check");
const inventory = await discoverUiActions(root);

if (!checkOnly) await writeUiActionInventory(root, inventory);

console.log(
  `UI actions: ${inventory.summary.total}; stable IDs: ${inventory.summary.identified}; missing IDs: ${inventory.summary.missingActionId}`,
);
if (!checkOnly) console.log(join(root, ".review", "audits", "ui-action-inventory.md"));
if (
  checkOnly
  && (inventory.summary.missingActionId > 0
    || inventory.summary.uniqueActionIds !== inventory.summary.identified)
) {
  process.exitCode = 1;
}
