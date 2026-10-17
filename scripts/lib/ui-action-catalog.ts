// Re-export the shared single source of truth so the audit scripts, the
// renderer runtime registry, and future Agent API all share one risk/
// surface/capability classification. The canonical module lives in
// src/shared/ui-action-catalog.ts; this file keeps the historical import
// path (`scripts/lib/ui-action-catalog`) working for existing scripts/tests.
export {
  catalogUiAction,
  surfacesFor,
  type UiActionRisk,
  type UiActionSurface,
  type UiActionCapability,
  type UiActionCatalogEntry,
} from "../../src/shared/ui-action-catalog";
