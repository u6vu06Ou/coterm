export type UiActionRisk = "safe" | "stateful" | "destructive" | "external";
export type UiActionSurface = "desktop" | "web" | "mobile-web";
export type UiActionCapability =
  | "opens-dialog"
  | "writes-terminal"
  | "mutates-state"
  | "navigates"
  | "read-only";

export interface UiActionCatalogEntry {
  actionId: string;
  area: string;
  risk: UiActionRisk;
  surfaces: UiActionSurface[];
  liveRequired: boolean;
  capability: UiActionCapability;
}

const DESTRUCTIVE_ACTIONS = new Set([
  "settings.backup.restore",
  "settings.custom-model.remove",
  "sidebar.project.delete",
  "terminal.close",
  "topbar.app.quit",
  "topbar.mobile.stop",
]);

const EXTERNAL_ACTIONS = new Set([
  "artifact.openBrowser",
  "artifact.reveal",
  "browserApproval.accept",
  "picker.agent.select",
  "picker.command.copy",
  "settings.backup.create",
  "settings.diagnostics.export",
  "sidebar.history.resume",
  "sidebar.project.open-agent",
  "terminal.rehydrate",
  "topbar.mobile.attach.change",
  "topbar.mobile.attach.open",
  "topbar.mobile.paste",
  "topbar.voice.hold",
  "topbar.voice.recover-insert",
  "wizard.workspace.choose",
]);

const STATEFUL_SEGMENTS = [
  ".archive",
  ".change",
  ".complete",
  ".create",
  ".edit",
  ".pin-toggle",
  ".rename",
  ".resize",
  ".restore",
  ".revert",
  ".save",
  ".select",
  ".submit",
  ".toggle",
];

// palette.* are UI chrome of the Command Palette itself: backdrop dismiss,
// dialog consume, search input, item select, close. They mutate only palette
// open/confirm state, never workspace data — safe despite `.select`/`.change`.
const PALETTE_SAFE_PREFIX = "palette.";

const OPENS_DIALOG_AREAS = new Set(["picker", "settings", "manual", "wizard", "palette"]);

export function catalogUiAction(actionId: string): UiActionCatalogEntry {
  const external = EXTERNAL_ACTIONS.has(actionId);
  const isPalette = actionId.startsWith(PALETTE_SAFE_PREFIX);
  const risk: UiActionRisk = DESTRUCTIVE_ACTIONS.has(actionId)
    ? "destructive"
    : external
      ? "external"
      : isPalette
        ? "safe"
        : STATEFUL_SEGMENTS.some((segment) => actionId.includes(segment))
          ? "stateful"
          : "safe";

  return {
    actionId,
    area: actionId.split(".")[0] ?? "unknown",
    risk,
    surfaces: surfacesFor(actionId),
    liveRequired: external || DESTRUCTIVE_ACTIONS.has(actionId),
    capability: capabilityFor(actionId, risk),
  };
}

function capabilityFor(actionId: string, risk: UiActionRisk): UiActionCapability {
  if (risk === "destructive") return "mutates-state";
  if (actionId === "topbar.voice.recover-insert") return "writes-terminal";
  if (risk === "external") return "navigates";
  const area = actionId.split(".")[0] ?? "";
  if (OPENS_DIALOG_AREAS.has(area)) return "opens-dialog";
  if (actionId.startsWith("terminal.") || actionId.includes(".paste")) return "writes-terminal";
  if (risk === "stateful") return "mutates-state";
  return "read-only";
}

export function surfacesFor(actionId: string): UiActionSurface[] {
  if (actionId === "topbar.app.quit") {
    return ["desktop"];
  }
  if (actionId.startsWith("topbar.mobile.")) {
    return ["mobile-web"];
  }
  if (actionId.startsWith("topbar.")) {
    return ["desktop", "web"];
  }
  return ["desktop", "web", "mobile-web"];
}
