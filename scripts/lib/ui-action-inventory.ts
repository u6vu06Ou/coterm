import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import ts from "typescript";

export interface UiActionSource {
  file: string;
  line: number;
  tag: string;
  actionId: string | null;
  testId: string | null;
  ariaLabel: string | null;
  title: string | null;
  className: string | null;
  events: string[];
}

export interface UiActionInventorySummary {
  generatedAt: string;
  sourceRoot: string;
  total: number;
  identified: number;
  uniqueActionIds: number;
  missingActionId: number;
}

export interface UiActionInventory {
  summary: UiActionInventorySummary;
  actions: UiActionSource[];
}

const actionEvents = new Set([
  "onClick",
  "onDoubleClick",
  "onPointerDown",
  "onMouseDown",
  "onChange",
  "onSubmit",
]);
const interactiveTags = new Set(["button", "a", "input", "select", "textarea", "summary"]);

export async function discoverUiActions(root: string): Promise<UiActionInventory> {
  const sourceRoot = join(root, "src", "renderer", "src");
  const files = await collect(sourceRoot);
  const actions: UiActionSource[] = [];

  for (const file of files) {
    const sourceText = await readFile(file, "utf8");
    const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    visit(source);

    function visit(node: ts.Node): void {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(source);
        if (/^[a-z]/.test(tag)) {
          const attributes = new Map<string, string | boolean>();
          let resolvedActionIds: string[] = [];
          for (const property of node.attributes.properties) {
            if (!ts.isJsxAttribute(property)) continue;
            const name = property.name.getText(source);
            const value = attributeValue(property, source);
            attributes.set(name, value);
            if (name === "data-action-id") {
              resolvedActionIds = resolveAttributeValues(property, source);
            }
          }
          const events = [...attributes.keys()].filter((name) => actionEvents.has(name));
          const role = attributes.get("role");
          const interactive = interactiveTags.has(tag) || role === "button" || role === "menuitem" || events.length > 0;
          // disabled={...} controls are interactive when enabled; only omit a
          // permanently disabled bare `disabled` element.
          if (interactive && attributes.get("disabled") !== true) {
            const position = source.getLineAndCharacterOfPosition(node.getStart(source));
            const actionIds = resolvedActionIds.length > 0 ? resolvedActionIds : [null];
            for (const actionId of actionIds) {
              actions.push({
                file: relative(root, file).replaceAll("\\", "/"),
                line: position.line + 1,
                tag,
                actionId,
                testId: clean(attributes.get("data-testid")),
                ariaLabel: clean(attributes.get("aria-label")),
                title: clean(attributes.get("title")),
                className: clean(attributes.get("className")),
                events,
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }
  }

  actions.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const identified = actions.filter((action) => action.actionId);
  return {
    summary: {
      generatedAt: new Date().toISOString(),
      sourceRoot: relative(root, sourceRoot).replaceAll("\\", "/"),
      total: actions.length,
      identified: identified.length,
      uniqueActionIds: new Set(identified.map((action) => action.actionId)).size,
      missingActionId: actions.length - identified.length,
    },
    actions,
  };
}

export async function writeUiActionInventory(root: string, inventory: UiActionInventory): Promise<void> {
  const outputJson = join(root, ".review", "audits", "ui-action-inventory.json");
  const outputMarkdown = join(root, ".review", "audits", "ui-action-inventory.md");
  await mkdir(dirname(outputJson), { recursive: true });
  await writeFile(outputJson, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
  await writeFile(outputMarkdown, markdown(inventory), "utf8");
}

async function collect(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry): Promise<string[]> => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collect(path);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [path] : [];
  }));
  return nested.flat();
}

function attributeValue(attribute: ts.JsxAttribute, source: ts.SourceFile): string | boolean {
  const initializer = attribute.initializer;
  if (!initializer) return true;
  if (ts.isStringLiteral(initializer)) return initializer.text;
  if (ts.isJsxExpression(initializer)) return initializer.expression?.getText(source) ?? "";
  return initializer.getText(source);
}

function resolveAttributeValues(attribute: ts.JsxAttribute, source: ts.SourceFile): string[] {
  const initializer = attribute.initializer;
  if (!initializer) return [];
  if (ts.isStringLiteral(initializer)) return [initializer.text];
  if (!ts.isJsxExpression(initializer) || !initializer.expression) return [];
  const expression = initializer.expression;
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return [expression.text];
  }
  if (!ts.isIdentifier(expression)) {
    const value = clean(expression.getText(source));
    return value ? [value] : [];
  }

  // A mapped literal catalog such as
  // STT_FIELDS.map(({ actionId }) => <input data-action-id={actionId} />)
  // represents one runtime surface per catalog entry. Resolve those literal
  // values instead of reporting the identifier name itself as a fake ID.
  let cursor: ts.Node | undefined = expression;
  while (cursor) {
    if (
      ts.isCallExpression(cursor)
      && ts.isPropertyAccessExpression(cursor.expression)
      && cursor.expression.name.text === "map"
      && ts.isIdentifier(cursor.expression.expression)
    ) {
      return mappedObjectPropertyValues(source, cursor.expression.expression.text, expression.text);
    }
    cursor = cursor.parent;
  }
  return [];
}

function mappedObjectPropertyValues(source: ts.SourceFile, arrayName: string, propertyName: string): string[] {
  const values: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === arrayName
      && node.initializer
    ) {
      const initializer = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer;
      if (!ts.isArrayLiteralExpression(initializer)) return;
      for (const element of initializer.elements) {
        if (!ts.isObjectLiteralExpression(element)) continue;
        const property = element.properties.find((candidate): candidate is ts.PropertyAssignment =>
          ts.isPropertyAssignment(candidate) && candidate.name.getText(source).replaceAll(/["']/g, "") === propertyName,
        );
        if (property && (ts.isStringLiteral(property.initializer) || ts.isNoSubstitutionTemplateLiteral(property.initializer))) {
          values.push(property.initializer.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...new Set(values)];
}

function clean(value: string | boolean | undefined): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.replaceAll("\n", " ").slice(0, 160);
}

function markdown(inventory: UiActionInventory): string {
  const rows = inventory.actions.map((action) => {
    const hint = action.actionId ?? action.testId ?? action.ariaLabel ?? action.title ?? action.className ?? "—";
    return `| ${escapeCell(action.file)}:${action.line} | ${escapeCell(action.tag)} | ${escapeCell(hint)} | ${action.actionId ? "yes" : "NO"} | ${escapeCell(action.events.join(", ") || "semantic")} |`;
  });
  return [
    "# Coterm UI action inventory",
    "",
    `Generated: ${inventory.summary.generatedAt}`,
    "",
    `- Interactive surfaces: ${inventory.summary.total}`,
    `- Stable action IDs: ${inventory.summary.identified}`,
    `- Unique action IDs: ${inventory.summary.uniqueActionIds}`,
    `- Missing action IDs: ${inventory.summary.missingActionId}`,
    "",
    "This is a static discovery report. It inventories human-interactive renderer elements; it does not claim that an action passed until a Playwright scenario supplies a state/log oracle.",
    "",
    "| Source | Element | Best current hint | Stable ID | Events |",
    "|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

function escapeCell(value: string | number): string {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}
