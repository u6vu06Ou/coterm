import type { UiActionSurface } from "./ui-action-catalog";

export const UI_ACTION_AUDIT_SCENARIO_TITLE =
  "records privacy-safe stable action IDs for external audit";

export interface UiActionScenario {
  id: string;
  title: string;
  file: string;
  actionIds: string[];
  surfaces: UiActionSurface[];
}

/**
 * Each scenario maps a set of actionIds to a Playwright test whose `test(title)`
 * equals `scenario.title`. run-ui-total reads the Playwright JSON report and
 * marks every actionId PASS/FAIL based on whether its scenario's test passed.
 *
 * Contract (see scripts/run-ui-total.ts):
 * - test title MUST equal scenario.title (exact match)
 * - test MUST drive [data-action-id="..."] and assert a state/log oracle
 * - a stable action ID alone is NOT_COVERED; PASS requires a real scenario
 */
export const UI_ACTION_SCENARIOS: UiActionScenario[] = [
  {
    id: "app-fallback-reload",
    title: "app fallback reload restores the selected terminal",
    file: "tests/e2e/ui-action-recovery-gaps.spec.ts",
    actionIds: ["app.error.reload"],
    surfaces: ["desktop"],
  },
  {
    id: "artifact-fallback-close",
    title: "artifact fallback close clears failed preview and preserves terminal",
    file: "tests/e2e/ui-action-recovery-gaps.spec.ts",
    actionIds: ["artifact.preview.close"],
    surfaces: ["desktop"],
  },
  {
    id: "sunmoon-worktree-copy",
    title: "sunmoon worktree row copies its exact path and audits",
    file: "tests/e2e/ui-action-recovery-gaps.spec.ts",
    actionIds: ["`sidebar.pulse.worktree.row:${index}`"],
    surfaces: ["desktop"],
  },
  {
    id: "desktop-settings-audit",
    title: UI_ACTION_AUDIT_SCENARIO_TITLE,
    file: "tests/e2e/ui-action-audit.spec.ts",
    actionIds: ["topbar.settings.open", "settings.proxy.change", "settings.close"],
    surfaces: ["desktop"],
  },
  {
    id: "sidebar-actions",
    title: "sidebar project + archive actions render and audit",
    file: "tests/e2e/ui-action-sidebar.spec.ts",
    actionIds: [
      "sidebar.collapse",
      "sidebar.expand",
      "sidebar.search.change",
      "sidebar.search-result.open",
      "sidebar.project.create",
      "sidebar.project.create-empty",
      "sidebar.project.actions.open",
      "sidebar.project.history.open",
      "sidebar.project.rename",
      "sidebar.project.rename.start",
      "sidebar.project.rename.change",
      "sidebar.project.rename.submit",
      "sidebar.project.pin-toggle",
      "sidebar.project.archive",
      "sidebar.archive.toggle",
      "sidebar.archive.restore",
      "sidebar.history.close",
      "sidebar.attention.item.select",
    ],
    surfaces: ["desktop"],
  },
  {
    id: "worktree-sandbox-action",
    title: "worktree sandbox opens an isolated terminal and audits the action",
    file: "tests/e2e/ui-action-worktree.spec.ts",
    actionIds: ["sidebar.project.open-sandbox"],
    surfaces: ["desktop"],
  },
  {
    id: "worktree-manager-actions",
    title: "worktree manager dialog renders actions and audits them",
    file: "tests/e2e/ui-action-worktree-manager.spec.ts",
    actionIds: [
      "sidebar.project.manage-sandboxes",
      "worktree.dialog.backdrop.dismiss",
      "worktree.dialog.consume",
      "worktree.dialog.close",
      "worktree.dialog.diff.toggle",
      "worktree.dialog.merge",
      "worktree.dialog.abort",
      "worktree.dialog.cleanup",
      "worktree.dialog.resume",
    ],
    surfaces: ["desktop"],
  },
  {
    id: "topbar-desktop-actions",
    title: "topbar desktop actions render and audit",
    file: "tests/e2e/ui-action-topbar.spec.ts",
    actionIds: [
      "topbar.theme.toggle",
      "topbar.terminal.refresh",
      "topbar.terminal.exclusive-toggle",
      "topbar.terminal.show-all",
    ],
    surfaces: ["desktop"],
  },
  {
    // f2 (1.5.46): sidebar session branches — inline expand, open-row focus,
    // group-handle click fallback. Drag paths are audited via the click
    // fallback (drag events have no audit listener, same as reading mode).
    id: "sidebar-session-branches",
    title: "sidebar session branches expand, focus open sessions and audit",
    file: "tests/e2e/ui-action-sidebar-sessions.spec.ts",
    actionIds: ["sidebar.session.open", "sidebar.sessions.group.open", "sidebar.open-tile.focus"],
    surfaces: ["desktop"],
  },
  {
    // f2 (1.5.46): whole-group drag onto the dock opens tiles (skips already-
    // open sessions); folder drag-to-reorder stays disjoint (rule #4).
    id: "sidebar-session-group-dragout",
    title: "session group drag-out opens dock tiles and folder reorder stays intact",
    file: "tests/e2e/ui-action-sidebar-sessions.spec.ts",
    actionIds: [],
    surfaces: ["desktop"],
  },
  {
    // 閱讀模式 (1.5.44): full enter→drag sidebar rows→fill→exit→restore cycle.
    id: "reading-mode-cycle",
    title: "reading mode enter/drag/exit restores the original layout",
    file: "tests/e2e/ui-action-reading-mode.spec.ts",
    actionIds: ["topbar.reading-mode.toggle"],
    surfaces: ["desktop"],
  },
  {
    // 2026-10-02: dock picker button + popover grid of the 7 layout preset
    // thumbnails plus the exit item. Mounted only on the desktop reading dock;
    // covered at run level by the reading-mode cycle scenario until a
    // dedicated scenario drives the popover items.
    id: "reading-layout-popover",
    title: "reading layout popover picks a preset and exits reading mode",
    file: "tests/e2e/ui-action-reading-mode.spec.ts",
    actionIds: ["reading.picker.toggle", "reading.preset.select", "reading.mode.toggle"],
    surfaces: ["desktop"],
  },
  {
    // 殭屍格回收 (1.5.44): a PTY exiting on its own reclaims its dock tile.
    id: "zombie-tile-reclaim",
    title: "zombie tile is reclaimed when its PTY exits on its own",
    file: "tests/e2e/ui-action-reading-mode.spec.ts",
    actionIds: [],
    surfaces: ["desktop"],
  },
  // topbar.mobile.* actions: the mobile dock branch is gated on
  // matchMedia("(max-width: 600px)").matches, which is always false in the
  // desktop Electron window (minWidth:1024). The spec injects a matchMedia mock
  // via launchCoterm's initScripts so the branch mounts. BLOCKED mobile actions
  // (attach.*/paste/stop — live/destructive) are intentionally NOT listed.
  {
    id: "topbar-mobile-actions",
    title: "topbar mobile dock actions render and audit",
    file: "tests/e2e/ui-action-topbar-mobile.spec.ts",
    actionIds: [
      "topbar.mobile.terminal.select",
      "topbar.mobile.enter",
      "topbar.mobile.keys.toggle",
      "topbar.mobile.key.up",
      "topbar.mobile.key.down",
      "topbar.mobile.key.left",
      "topbar.mobile.key.right",
      "topbar.mobile.key.escape",
      "topbar.mobile.key.tab",
      "topbar.mobile.refresh",
      "topbar.mobile.input.open",
      "topbar.mobile.paste-fallback.consume",
      "topbar.mobile.paste-fallback.textarea",
      "topbar.mobile.paste-fallback.confirm",
      "topbar.mobile.paste-fallback.cancel",
      "topbar.mobile.settings.open",
    ],
    surfaces: ["mobile-web"],
  },
  {
    id: "settings-panel-actions",
    title: "settings panel controls render and audit",
    file: "tests/e2e/ui-action-settings.spec.ts",
      actionIds: [
        "settings.backdrop.dismiss",
        "settings.drawer.consume",
        "settings.language.change",
        "settings.provider.change",
        "settings.claude-keepalive.change",
        "settings.terminal-font-size.change",
        "settings.code-theme.change",
        "settings.terminal-theme.change",
        "settings.permission.change",
        "settings.theme.change",
      "settings.agent-api.toggle",
      "settings.agent-token.toggle",
      "settings.browser-network.mode.change",
      "settings.browser-network.hosts.change",
      "settings.browser.superpowers-p0.toggle",
      "settings.browser.superpowers-p1.toggle",
      "settings.browser-secret.issue.value.change",
      "settings.browser-secret.issue.submit",
      "settings.voice.toggle",
      "settings.voice-language.change",
      "settings.voice-stt-url.change",
      "settings.voice-stt-model.change",
      "settings.voice-stt-api-key.change",
      "settings.voice-stt-api-key.clear",
      "settings.voice-streaming.toggle",
      "settings.dashboard.select",
    ],
    surfaces: ["desktop"],
  },
  // settings.custom-model.remove is destructive (window.confirm + profile
  // deletion) and intentionally stays BLOCKED like settings.backup.restore —
  // the scenario covers the other 19 registry-form actions with real clicks.
  {
    id: "settings-custom-model-actions",
    title: "settings custom model registry form renders and audits",
    file: "tests/e2e/ui-action-settings.spec.ts",
    actionIds: [
      "settings.custom-model.add",
      "settings.custom-model.id.change",
      "settings.custom-model.harness.change",
      "settings.custom-model.label.change",
      "settings.custom-model.model.change",
      "settings.custom-model.base-url.change",
      "settings.custom-model.auth-token.change",
      "settings.custom-model.local.change",
      "settings.custom-model.context-window.change",
      "settings.custom-model.reasoning-effort.change",
      "settings.custom-model.env.toggle",
      "settings.custom-model.env.add",
      "settings.custom-model.env-key.change",
      "settings.custom-model.env-value.change",
      "settings.custom-model.env.remove",
      "settings.custom-model.save",
      "settings.custom-model.edit",
      "settings.custom-model.auth-token.replace",
      "settings.custom-model.cancel",
    ],
    surfaces: ["desktop"],
  },
  {
    id: "wizard-actions",
    title: "first-run wizard steps render and audit",
    file: "tests/e2e/ui-action-wizard.spec.ts",
    actionIds: [
      "wizard.step.select",
      "wizard.shell.select",
      "wizard.ime.change",
      "wizard.language.zh-tw.select",
      "wizard.language.en-us.select",
      "wizard.workspace.choose",
      "wizard.back",
      "wizard.next",
      "wizard.complete",
    ],
    surfaces: ["desktop"],
  },
  {
    id: "artifact-rail-actions",
    title: "artifact rail controls render and audit",
    file: "tests/e2e/ui-action-artifact.spec.ts",
    actionIds: [
      "artifact.resize",
      "artifact.open",
      "artifact.back",
      "artifact.close",
      "artifact.edit",
      "artifact.editor.change",
      "artifact.save",
      "artifact.revert",
    ],
    surfaces: ["desktop"],
  },
  {
    id: "explorer-panel-actions",
    title: "explorer panel controls render and audit",
    file: "tests/e2e/ui-action-explorer.spec.ts",
    actionIds: [
      "explorer.open",
      "explorer.close",
      "explorer.folder.toggle",
      "explorer.file.open",
      "explorer.copy-path",
    ],
    surfaces: ["desktop"],
  },
  {
    id: "terminal-dock-actions",
    title: "terminal dock selection and modes render and audit",
    file: "tests/e2e/ui-action-terminal.spec.ts",
    actionIds: [
      "terminal.activate",
      "terminal.clean-view.toggle",
      "terminal.clean-view.consume",
      "terminal.search.consume",
      "terminal.search.input",
      "terminal.search.previous",
      "terminal.search.next",
      "terminal.search.close",
    ],
    surfaces: ["desktop"],
  },
  {
    // Header double-click solo toggle: blank dblclick on a pane header fires the
    // same setExclusive the topbar tab does; a second one restores the grid.
    id: "terminal-header-solo",
    title: "pane header double-click maximizes the pane and a second one restores the grid",
    file: "tests/e2e/ui-action-header-solo.spec.ts",
    actionIds: ["terminal.header.exclusive-toggle"],
    surfaces: ["desktop"],
  },
  {
    // 1.5.45 warroom identity: an eyes-opened window carries a label and paints
    // the top-edge band; a hand-opened plain terminal is NOT force-coloured and
    // only gets one when the user cycles the header swatch.
    id: "terminal-label-band",
    title: "warroom label paints a top-edge band and plain terminals stay uncoloured",
    file: "tests/e2e/ui-action-terminal-label.spec.ts",
    actionIds: ["terminal.label.cycle", "terminal.header.more", "terminal.header.menu.consume"],
    surfaces: ["desktop"],
  },
  {
    id: "picker-dialog-actions",
    title: "LLM picker dialog controls render and audit",
    file: "tests/e2e/ui-action-picker.spec.ts",
    actionIds: [
      "picker.backdrop.dismiss",
      "picker.dialog.consume",
      "picker.close",
      "picker.plain.select",
      // 分層改對後的兩個動作：chip 層有 DOM 計數 oracle，refresh 有真點擊。
      "picker.agent.selectHarness",
      "picker.status.refresh",
    ],
    surfaces: ["desktop"],
  },
  {
    id: "app-error-actions",
    title: "app error banner dismiss renders and audits",
    file: "tests/e2e/ui-action-app.spec.ts",
    actionIds: ["app.error.dismiss"],
    surfaces: ["desktop"],
  },
  {
    id: "command-palette-actions",
    title: "command palette controls render and audit",
    file: "tests/e2e/ui-action-palette.spec.ts",
    actionIds: [
      "palette.backdrop.dismiss",
      "palette.dialog.consume",
      "palette.search.change",
      "palette.item.select",
      "palette.close",
    ],
    surfaces: ["desktop"],
  },
  {
    id: "checkpoint-rail-actions",
    title: "checkpoint rail controls render and audit",
    file: "tests/e2e/ui-action-checkpoint.spec.ts",
    actionIds: [
      "topbar.checkpoint.toggle",
      "checkpoint.resize",
      "checkpoint.close",
      "checkpoint.diff",
      "checkpoint.restore",
      "checkpoint.hunk.restore",
      "checkpoint.undo",
      "checkpoint.redo",
    ],
    surfaces: ["desktop"],
  },
  // v1.5.41 gap scenarios (issue #97): the session-wide browser grant button
  // and the WebGL degraded badge both arrived without e2e coverage.
  {
    id: "browser-approval-session-grant",
    title: "browser approval session grant renders and audits",
    file: "tests/e2e/ui-action-browser-approval.spec.ts",
    actionIds: ["browserApproval.acceptForSession"],
    surfaces: ["desktop"],
  },
  {
    id: "terminal-renderer-degraded",
    title: "terminal renderer degraded badge rebuilds the engine and audits",
    file: "tests/e2e/ui-action-browser-approval.spec.ts",
    actionIds: ["terminal.renderer.degraded"],
    surfaces: ["desktop"],
  },
  // Desktop settings sheet: the tab rail is the only way to reach a pane, so the
  // rail entries are first-class actions with their own scenario.
  {
    id: "settings-tab-rail-actions",
    title: "settings tab rail switches panes, locale and focus",
    file: "tests/e2e/ui-action-settings-tabs.spec.ts",
    actionIds: [
      "settings.tab.general",
      "settings.tab.appearance",
      "settings.tab.agent",
      "settings.tab.voice",
      "settings.tab.browser",
      "settings.tab.security",
      "settings.tab.data",
    ],
    surfaces: ["desktop"],
  },
];

