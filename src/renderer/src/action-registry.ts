import { catalogUiAction, type UiActionCatalogEntry } from "@shared/ui-action-catalog";

export interface RuntimeActionEntry extends UiActionCatalogEntry {
  /** Stable actionId, e.g. "sidebar.project.create". */
  actionId: string;
  /** Best human-readable label from the element's existing aria-label/title/text. */
  label: string;
  /** Whether selecting this action requires an inline confirm step. */
  requiresConfirm: boolean;
  /** Invoke the element's original DOM click handler. Returns false if unavailable. */
  invoke: () => boolean;
}

const CONSUME_SUFFIX = ".consume";
const PALETTE_PREFIX = "palette.";

/**
 * Click-triggered event attributes. Elements whose data-action-trigger is one
 * of these still fire on a plain click, so they are invokable. pointerdown/
 * mousedown/doubleclick-only triggers are NOT single-click invokable.
 */
const CLICK_TRIGGERS = new Set(["click", ""]);

function isClickTrigger(el: HTMLElement): boolean {
  const trigger = el.dataset.actionTrigger;
  return CLICK_TRIGGERS.has(trigger ?? "");
}

function isDisabled(el: HTMLElement): boolean {
  if (el.tagName === "BUTTON") return (el as HTMLButtonElement).disabled;
  return el.getAttribute("aria-disabled") === "true";
}

function isInputSurface(tag: string): boolean {
  return tag === "input" || tag === "select" || tag === "textarea";
}

function deriveLabel(el: HTMLElement): string {
  const aria = el.getAttribute("aria-label");
  if (aria) return aria;
  const title = el.getAttribute("title");
  if (title) return title;
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  return text.slice(0, 80);
}

function tokens(actionId: string, label: string): string {
  // actionId tokens (sidebar.project.create → "sidebar project create") plus
  // label words. Lowercased for case-insensitive substring/word matching.
  const idTokens = actionId.split(/[._:-]+/).filter(Boolean).join(" ");
  return `${idTokens} ${label}`.toLowerCase();
}

/**
 * Scan the currently mounted DOM for executable click actions and return a
 * deduplicated registry. Excludes palette chrome, disabled elements, non-click
 * triggers, free-text inputs, and consume surfaces (stopPropagation containers).
 */
export function scanRuntimeActions(root: ParentNode = document): RuntimeActionEntry[] {
  const nodes = root.querySelectorAll<HTMLElement>(
    'button[data-action-id], a[data-action-id], [role="button"][data-action-id]',
  );
  const seen = new Set<string>();
  const entries: RuntimeActionEntry[] = [];

  for (const el of Array.from(nodes)) {
    const actionId = el.getAttribute("data-action-id");
    if (!actionId) continue;
    if (actionId.startsWith(PALETTE_PREFIX)) continue;
    if (actionId.endsWith(CONSUME_SUFFIX)) continue;
    if (isDisabled(el)) continue;
    if (isInputSurface(el.tagName.toLowerCase())) continue;
    if (!isClickTrigger(el)) continue;
    if (seen.has(actionId)) continue;
    seen.add(actionId);

    const catalog = catalogUiAction(actionId);
    entries.push({
      ...catalog,
      actionId,
      label: deriveLabel(el),
      requiresConfirm: catalog.risk === "destructive" || catalog.risk === "external",
      invoke: () => {
        // Re-query at invoke time: the element may have unmounted between
        // scan and selection. Invoke via native click() so the original
        // React onClick closure runs unchanged.
        const target = document.querySelector<HTMLElement>(`[data-action-id="${cssEscape(actionId)}"]`);
        if (!target || isDisabled(target)) return false;
        target.click();
        return true;
      },
    });
  }

  return entries;
}

export function filterByQuery(entries: RuntimeActionEntry[], query: string): RuntimeActionEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries
    .map((entry) => ({ entry, hay: tokens(entry.actionId, entry.label) }))
    .filter(({ hay }) => hay.includes(q))
    .map(({ entry }) => entry);
}

// cssEscape is only available in DOM; the registry runs in renderer so this is
// fine. Kept as a helper so the invoke closure stays readable.
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}
