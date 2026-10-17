// ponytail: one-shot enumerator — reads ui-total-report.json, prints `<status>\t<action-id>` per line.
// Accepts an optional report path arg; defaults to .review/audits/ui-total-report.json.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = process.cwd();
const reportPath = resolve(process.argv[2] ?? join(root, ".review", "audits", "ui-total-report.json"));
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const order = ["PASS", "FAIL", "BLOCKED", "NOT_COVERED"];
const counts = Object.fromEntries(order.map((s) => [s, 0]));
for (const a of report.actions) {
  counts[a.status] = (counts[a.status] ?? 0) + 1;
  process.stdout.write(`${a.status}\t${a.actionId}\n`);
}
process.stderr.write(
  `# total ${report.actions.length} — PASS ${counts.PASS}, FAIL ${counts.FAIL}, BLOCKED ${counts.BLOCKED}, NOT_COVERED ${counts.NOT_COVERED}\n`,
);
