import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { enUS } from "../../src/renderer/src/i18n/locales/en-US";
import { zhTW } from "../../src/renderer/src/i18n/locales/zh-TW";

// Coverage contract: every hard-coded visible string in the five remaining
// terminal-first components must have a dictionary key in both locales, and
// the component source must consume it via useI18n().t().

const SIDEBAR_KEYS = [
  "sidebar.expand",
  "sidebar.collapse",
  "sidebar.search.placeholder",
  "sidebar.search.aria",
  "sidebar.search.results.aria",
  "sidebar.search.busy",
  "sidebar.search.empty",
  "sidebar.projects",
  "sidebar.projects.add",
  "sidebar.project.name.aria",
  "sidebar.project.openTerminal",
  "sidebar.project.openTerminal.aria",
  "sidebar.project.openSandbox",
  "sidebar.project.history",
  "sidebar.project.history.aria",
  "sidebar.project.more",
  "sidebar.project.more.aria",
  "sidebar.project.rename",
  "sidebar.project.unpin",
  "sidebar.project.pin",
  "sidebar.project.archive",
  "sidebar.project.delete",
  "sidebar.project.archive.confirm",
  "sidebar.project.delete.confirm",
  "sidebar.project.empty",
  "sidebar.archive.section",
  "sidebar.archive.restore",
  "sidebar.archive.empty",
  "sidebar.archive.hint",
  "sidebar.history.dialog.aria",
  "sidebar.history.title",
  "sidebar.history.close.aria",
  "sidebar.history.loading",
  "sidebar.history.empty",
  "sidebar.history.resume",
  "sidebar.history.resume.disabled",
  "sidebar.history.noSummary",
  "sidebar.history.resumeError",
  "sidebar.sessions.group.hint",
  "sidebar.sessions.open.hint",
  "sidebar.view.toOpen",
  "sidebar.view.toAll",
  "sidebar.view.openEmpty",
  "sidebar.search.kind.project",
  "sidebar.search.kind.conversation",
  "sidebar.search.kind.terminal",
  "sidebar.search.kind.handoff",
  "sidebar.search.kind.artifact",
  "sidebar.search.kind.event",
] as const;

const ARTIFACT_KEYS = [
  "artifact.resize.aria",
  "artifact.heading.preview",
  "artifact.heading.output",
  "artifact.heading.default",
  "artifact.back.title",
  "artifact.reveal.title",
  "artifact.close.title",
  "artifact.empty",
  "artifact.loading",
  "artifact.save.saving",
  "artifact.save.save",
  "artifact.save.revert",
  "artifact.edit",
  "artifact.image.alt",
  "artifact.pdf.title",
  "artifact.html.title",
  "artifact.editor.aria",
] as const;

const WIZARD_KEYS = [
  "wizard.step.welcome",
  "wizard.step.workspace",
  "wizard.step.providers",
  "wizard.step.shell",
  "wizard.step.ime",
  "wizard.privacy.note",
  "wizard.welcome.title",
  "wizard.welcome.body1",
  "wizard.welcome.body2",
  "wizard.workspace.title",
  "wizard.workspace.body",
  "wizard.workspace.choose",
  "wizard.providers.title",
  "wizard.providers.body",
  "wizard.shell.title",
  "wizard.shell.body",
  "wizard.ime.title",
  "wizard.ime.body",
  "wizard.ime.placeholder",
  "wizard.ime.composing",
  "wizard.ime.ok",
  "wizard.ime.waiting",
  "wizard.back",
  "wizard.next",
  "wizard.complete",
  "wizard.skip",
] as const;

const PICKER_KEYS = [
  "picker.dialog.aria",
  "picker.header",
  "picker.close.aria",
  "picker.status.missing",
  "picker.status.online",
  "picker.status.offline",
  "picker.copy.copied",
  "picker.copy.aria",
  "picker.plain",
  "picker.footer",
] as const;

const DOCK_KEYS = [
  "dock.agentDriven.title",
  "dock.agentDriven.label",
  "dock.shell",
  "dock.close.aria",
  "dock.close.title",
  "dock.session.title",
  "dock.rendererDegraded.label",
  "dock.rendererDegraded.title",
  "dock.search.placeholder",
  "dock.search.next",
  "dock.search.previous",
  "dock.search.close",
  "dock.search.noResult",
] as const;

const PALETTE_KEYS = [
  "palette.dialog.aria",
  "palette.search.placeholder",
  "palette.search.aria",
  "palette.close.aria",
  "palette.empty",
  "palette.confirm",
] as const;

const CHECKPOINT_KEYS = [
  "checkpoint.heading",
  "checkpoint.empty",
  "checkpoint.turn.label",
  "checkpoint.phase.pre",
  "checkpoint.phase.post",
  "checkpoint.diff.title",
  "checkpoint.restore.title",
  "checkpoint.restore.preview",
  "checkpoint.undo.title",
  "checkpoint.redo.title",
  "checkpoint.close.title",
  "checkpoint.resize.aria",
  "checkpoint.partial",
  "checkpoint.failed",
  "checkpoint.drift",
  "checkpoint.confirm.required",
  "checkpoint.binary",
  "checkpoint.oversize",
] as const;

const BROWSER_APPROVAL_KEYS = [
  "browserApproval.dialog.aria",
  "browserApproval.title",
  "browserApproval.body",
  "browserApproval.action",
  "browserApproval.origin",
  "browserApproval.risk",
  "browserApproval.level2",
  "browserApproval.level3",
  "browserApproval.levelUnknown",
  "browserApproval.locator",
  "browserApproval.more",
  "browserApproval.decline",
  "browserApproval.accept",
  // Issue #93 — session-wide grant must be explained in words, not only on the button.
  "browserApproval.acceptForSession",
  "browserApproval.sessionNote",
] as const;


const ALL_KEYS = [
  ...SIDEBAR_KEYS,
  ...ARTIFACT_KEYS,
  ...WIZARD_KEYS,
  ...PICKER_KEYS,
  ...DOCK_KEYS,
  ...PALETTE_KEYS,
  ...CHECKPOINT_KEYS,
  ...BROWSER_APPROVAL_KEYS,
] as const;

describe("component i18n key coverage", () => {
  it("zh-TW dictionary defines every component key", () => {
    for (const key of ALL_KEYS) {
      expect(zhTW, `zh-TW missing ${key}`).toHaveProperty(key);
      expect(typeof zhTW[key as keyof typeof zhTW]).toBe("string");
    }
  });

  it("en-US dictionary defines every component key", () => {
    for (const key of ALL_KEYS) {
      expect(enUS, `en-US missing ${key}`).toHaveProperty(key);
      expect(typeof enUS[key as keyof typeof enUS]).toBe("string");
    }
  });

  it("no component key is identical between locales (each is actually translated)", () => {
    const ALLOWED_MATCH: string[] = [
      "sidebar.search.kind.terminal",
      "sidebar.history.resume",
      "artifact.heading.preview",
      "artifact.heading.output",
      "artifact.heading.default",
      "wizard.step.workspace",
      "wizard.step.providers",
      "wizard.step.shell",
      "wizard.shell.title",
      "dock.agentDriven.label",
      "dock.shell",
      "dock.session.title",
    ];
    for (const key of ALL_KEYS) {
      const zh = zhTW[key as keyof typeof zhTW];
      const en = enUS[key as keyof typeof enUS];
      if (zh === en && !ALLOWED_MATCH.includes(key)) {
        expect.fail(`unexpected identical translation for ${key}: "${zh}"`);
      }
    }
  });
});

describe("component source uses useI18n", () => {
  const files = [
    "src/renderer/src/components/Sidebar.tsx",
    "src/renderer/src/components/ArtifactRail.tsx",
    "src/renderer/src/components/CheckpointRail.tsx",
    "src/renderer/src/components/FirstRunWizard.tsx",
    "src/renderer/src/components/LLMPickerDialog.tsx",
    "src/renderer/src/components/BrowserApprovalDialog.tsx",
    "src/renderer/src/components/TerminalDock.tsx",
    "src/renderer/src/components/CommandPalette.tsx",
  ];

  for (const file of files) {
    it(`${file} imports and calls useI18n`, () => {
      const source = readFileSync(resolve(file), "utf8");
      expect(source, `${file} must import useI18n`).toContain("useI18n");
      expect(source, `${file} must call t(`).toMatch(/\bt\(/);
    });
  }
});
