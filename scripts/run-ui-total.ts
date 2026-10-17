import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { catalogUiAction, type UiActionCatalogEntry } from "./lib/ui-action-catalog";
import { discoverUiActions, writeUiActionInventory } from "./lib/ui-action-inventory";
import { UI_ACTION_SCENARIOS } from "./lib/ui-action-scenarios";

type ActionStatus = "PASS" | "FAIL" | "BLOCKED" | "NOT_COVERED";

interface TotalActionResult extends UiActionCatalogEntry {
  status: ActionStatus;
  source: string;
  scenarioId: string | null;
  reason: string;
}

interface StepResult {
  name: string;
  status: "PASS" | "FAIL" | "SKIPPED";
  command: string;
}

interface StrictBaseline {
  schemaVersion: 1;
  unresolved: Partial<Record<Extract<ActionStatus, "BLOCKED" | "NOT_COVERED">, string[]>>;
}

const root = process.cwd();
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const skipBuild = args.has("--skip-build");
const strict = args.has("--strict") || process.env.COTERM_UI_TOTAL_STRICT === "1";
const live = args.has("--live") || process.env.COTERM_UI_TOTAL_LIVE === "1";
const strictBaselinePath = argumentValue(rawArgs, "--baseline");
const auditDirectory = join(root, ".review", "audits");
const playwrightReport = join(auditDirectory, "ui-total-playwright.json");
const steps: StepResult[] = [];

await mkdir(auditDirectory, { recursive: true });

let buildPassed = true;
if (skipBuild) {
  steps.push({ name: "build", status: "SKIPPED", command: "npm run build" });
} else {
  buildPassed = run("build", process.execPath, [npmCli(), "run", "build"]);
}

const inventory = await discoverUiActions(root);
await writeUiActionInventory(root, inventory);
const inventoryPassed = inventory.summary.missingActionId === 0
  && inventory.summary.uniqueActionIds === inventory.summary.identified;
steps.push({
  name: "action inventory",
  status: inventoryPassed ? "PASS" : "FAIL",
  command: "npm run check:ui-actions",
});

let playwrightPassed = false;
let playwrightRan = false;
if (buildPassed && inventoryPassed) {
  playwrightRan = true;
  playwrightPassed = run("Playwright scenarios", process.execPath, [
    playwrightCli(),
    "test",
    "--config",
    "playwright.total.config.ts",
  ]);
} else {
  steps.push({
    name: "Playwright scenarios",
    status: "SKIPPED",
    command: "playwright test --config playwright.total.config.ts",
  });
}

const scenarioStatus = playwrightRan
  ? await readScenarioStatuses(playwrightReport, playwrightPassed)
  : new Map<string, boolean>();
const actionSources = new Map(
  inventory.actions
    .filter((action): action is typeof action & { actionId: string } => Boolean(action.actionId))
    .map((action) => [action.actionId, `${action.file}:${action.line}`]),
);
const scenarioByAction = new Map(
  UI_ACTION_SCENARIOS.flatMap((scenario) => scenario.actionIds.map((actionId) => [actionId, scenario] as const)),
);

const actions: TotalActionResult[] = [...actionSources.entries()]
  .map(([actionId, source]) => {
    const catalog = catalogUiAction(actionId);
    const scenario = scenarioByAction.get(actionId);
    if (scenario) {
      if (!playwrightRan) {
        return result(catalog, source, "BLOCKED", scenario.id, "build or inventory gate failed");
      }
      const passed = scenarioStatus.get(scenario.title) ?? playwrightPassed;
      return result(
        catalog,
        source,
        passed ? "PASS" : "FAIL",
        scenario.id,
        passed ? "scenario and state/log oracle passed" : "scenario or oracle failed",
      );
    }
    if (catalog.liveRequired && !live) {
      return result(catalog, source, "BLOCKED", null, "live/destructive action requires explicit --live scenario");
    }
    return result(catalog, source, "NOT_COVERED", null, "stable ID exists; behavioral scenario/oracle not implemented yet");
  })
  .sort((a, b) => a.actionId.localeCompare(b.actionId));

const counts = countStatuses(actions);
const strictBaseline = strictBaselinePath
  ? await loadStrictBaseline(join(root, strictBaselinePath))
  : null;
const unexpectedUnresolved = strictBaseline
  ? actions.filter((action) =>
      (action.status === "BLOCKED" || action.status === "NOT_COVERED")
      && !strictBaseline.unresolved[action.status]?.includes(action.actionId))
  : [];
const baselineLoadFailed = Boolean(strictBaselinePath && !strictBaseline);
const infrastructureFailed = !buildPassed
  || !inventoryPassed
  || (playwrightRan && !playwrightPassed)
  || baselineLoadFailed;
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  mode: { strict, live, skipBuild, strictBaseline: strictBaselinePath ?? null },
  inventory: inventory.summary,
  steps,
  summary: {
    total: actions.length,
    ...counts,
    infrastructureFailed,
  },
  actions,
};

await writeFile(join(auditDirectory, "ui-total-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(join(auditDirectory, "ui-total-report.md"), markdown(report), "utf8");

console.log(
  `UI total: ${actions.length} actions — PASS ${counts.PASS}, FAIL ${counts.FAIL}, BLOCKED ${counts.BLOCKED}, NOT_COVERED ${counts.NOT_COVERED}`,
);
if (strictBaselinePath) {
  console.log(`Strict baseline: ${strictBaselinePath} — unexpected unresolved ${unexpectedUnresolved.length}`);
}
console.log("Reports: .review/audits/ui-total-report.{json,md}");

const strictFailed = strict && (strictBaseline
  ? unexpectedUnresolved.length > 0
  : counts.BLOCKED > 0 || counts.NOT_COVERED > 0);
process.exitCode = infrastructureFailed || counts.FAIL > 0 || strictFailed ? 1 : 0;

function result(
  catalog: UiActionCatalogEntry,
  source: string,
  status: ActionStatus,
  scenarioId: string | null,
  reason: string,
): TotalActionResult {
  return { ...catalog, source, status, scenarioId, reason };
}

function run(name: string, command: string, commandArgs: string[]): boolean {
  const display = [command, ...commandArgs].join(" ");
  const completed = spawnSync(command, commandArgs, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    shell: false,
  });
  const passed = completed.status === 0;
  steps.push({ name, status: passed ? "PASS" : "FAIL", command: display });
  if (completed.error) console.error(completed.error.message);
  return passed;
}

function npmCli(): string {
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath) throw new Error("npm_execpath is unavailable; run this command through npm");
  return npmExecPath;
}

function playwrightCli(): string {
  return join(root, "node_modules", "@playwright", "test", "cli.js");
}

function argumentValue(values: string[], name: string): string | null {
  const index = values.indexOf(name);
  if (index < 0) return null;
  const value = values[index + 1];
  if (!value || value.startsWith("--")) {
    console.error(`${name} requires a repository-relative JSON path`);
    return "__invalid_baseline_path__";
  }
  return value;
}

async function loadStrictBaseline(path: string): Promise<StrictBaseline | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as StrictBaseline;
    if (parsed.schemaVersion !== 1 || !parsed.unresolved || typeof parsed.unresolved !== "object") {
      throw new Error("unsupported baseline schema");
    }
    return parsed;
  } catch (error) {
    console.error(`Unable to load strict UI baseline ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function readScenarioStatuses(path: string, fallback: boolean): Promise<Map<string, boolean>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    const statuses = new Map<string, boolean>();
    visitReporterNode(parsed, statuses);
    return statuses;
  } catch {
    return new Map(UI_ACTION_SCENARIOS.map((scenario) => [scenario.title, fallback]));
  }
}

function visitReporterNode(value: unknown, statuses: Map<string, boolean>): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.title === "string" && typeof record.ok === "boolean" && Array.isArray(record.tests)) {
    statuses.set(record.title, record.ok);
  }
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) child.forEach((entry) => visitReporterNode(entry, statuses));
  }
}

function countStatuses(actionResults: TotalActionResult[]): Record<ActionStatus, number> {
  const counts: Record<ActionStatus, number> = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_COVERED: 0 };
  for (const action of actionResults) counts[action.status] += 1;
  return counts;
}

function markdown(reportData: typeof report): string {
  const rows = reportData.actions.map((action) =>
    `| ${action.actionId} | ${action.status} | ${action.risk} | ${action.surfaces.join(", ")} | ${action.scenarioId ?? "—"} | ${action.reason} |`,
  );
  return [
    "# Coterm UI total-test report",
    "",
    `Generated: ${reportData.generatedAt}`,
    "",
    `- Total: ${reportData.summary.total}`,
    `- PASS: ${reportData.summary.PASS}`,
    `- FAIL: ${reportData.summary.FAIL}`,
    `- BLOCKED: ${reportData.summary.BLOCKED}`,
    `- NOT_COVERED: ${reportData.summary.NOT_COVERED}`,
    `- Strict mode: ${reportData.mode.strict}`,
    `- Live/destructive mode: ${reportData.mode.live}`,
    "",
    "PASS requires a real Playwright scenario plus a state/log oracle. A stable action ID alone is NOT_COVERED. Live or destructive actions stay BLOCKED unless explicitly enabled and supplied with a safe scenario.",
    "",
    "| Action ID | Status | Risk | Surfaces | Scenario | Evidence |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}
