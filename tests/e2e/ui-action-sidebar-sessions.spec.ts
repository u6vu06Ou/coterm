import { expect, test, type Page } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchCoterm, readUiActions } from "./helpers/coterm-launch";

// Isolated workspace per run: the panel merges ~/.claude history by project
// path, and the default cwd (this repo) has history of its own — an extra
// row would make the seeded count nondeterministic.
async function isolatedWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "coterm-f2-ws-"));
}

// f2 (1.5.46, next-rev board): sidebar session branches — sessions render
// INLINE under their folder (desktop replaces the fullscreen panel), open
// sessions highlight and focus their tile instead of re-opening, and the
// whole group can be dragged (or click-fallback opened) into the dock.
// Folder drag-to-reorder must be unaffected: project rows use text/plain,
// session drags use application/x-coterm-session(-group).

const SESSION_A = "11111111-2222-3333-4444-555555555555";
const SESSION_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SESSION_C = "99999999-8888-7777-6666-555555555555";

const seededSessions = [
  { title: "Alpha session", profileId: "claude-local-main", nativeSessionId: SESSION_A },
  { title: "Beta session", profileId: "claude-local-main", nativeSessionId: SESSION_B },
  { title: "Gamma session", profileId: "claude-local-main", nativeSessionId: SESSION_C },
];

/** Dispatch a full HTML5 drag sequence between two elements (React-safe). */
async function dragBetween(page: Page, sourceSelector: string, targetSelector: string): Promise<void> {
  await page.evaluate(([src, tgt]) => {
    const source = document.querySelector(src!);
    const target = document.querySelector(tgt!);
    if (!source || !target) throw new Error(`drag endpoints missing: ${src} -> ${tgt}`);
    const dt = new DataTransfer();
    source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, [sourceSelector, targetSelector]);
}

async function openBoundTile(page: Page, nativeSessionId: string | null): Promise<string> {
  // Bind to TestProject by NAME: with two projects seeded, bootstrap order
  // (projects[0]) is not guaranteed — binding to the wrong project makes the
  // TestProject panel unable to see the session as open.
  return page.evaluate(async (sid) => {
    const { projects } = await window.aiTerminal.bootstrap();
    const project = projects.find((p) => p.name === "TestProject") ?? projects[0]!;
    const layout = await window.aiTerminal.openTile({ projectId: project.id });
    const terminalId = layout.selectedTerminalId!;
    if (sid) await window.aiTerminal.setTerminalNativeSessionId({ terminalId, nativeSessionId: sid });
    return terminalId;
  }, nativeSessionId);
}

async function selectedTileId(page: Page): Promise<string | null> {
  const layout = await page.evaluate(async () => window.aiTerminal.getDockLayout());
  return layout.selectedTerminalId;
}

test("sidebar session branches expand, focus open sessions and audit", async () => {
  const coterm = await launchCoterm({ seededSessions, defaultWorkspacePath: await isolatedWorkspace() });
  try {
    const { page, logPath } = coterm;
    await page.locator('[data-action-id="topbar.terminal.refresh"]').waitFor({ state: "visible", timeout: 30_000 });
    await page.locator("section.project-group").first().waitFor({ state: "visible" });

    // Expand: the INLINE branch renders (desktop never opens the old overlay).
    await page.locator('[data-action-id="sidebar.project.history.open"]').first().dispatchEvent("click");
    await expect(page.locator(".project-sessions")).toBeVisible();
    await expect(page.locator('.project-history-overlay')).toHaveCount(0);
    await expect(page.locator('[data-action-id="sidebar.session.open"]')).toHaveCount(3, { timeout: 15_000 });
    await expect(page.locator(".project-session-row.open")).toHaveCount(0);

    // Open a tile and bind session A to it → its row highlights live.
    const tileA = await openBoundTile(page, SESSION_A);
    await expect(page.locator('[data-action-id="terminal.activate"]')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator(".project-session-row.open")).toHaveCount(1, { timeout: 15_000 });

    // Move selection away, then click the OPEN row → focus flips back to it
    // (rule #3: already-open sessions focus instead of re-opening).
    const tilePlain = await openBoundTile(page, null);
    await expect(page.locator('[data-action-id="terminal.activate"]')).toHaveCount(2, { timeout: 30_000 });
    await page.evaluate((tid) => window.aiTerminal.selectTile({ terminalId: tid }), tilePlain);
    await expect.poll(() => selectedTileId(page)).toBe(tilePlain);

    await page.locator(".project-session-row.open").click();
    await expect.poll(() => selectedTileId(page)).toBe(tileA);
    // No third tile may appear: focusing must not open anything.
    await expect(page.locator('[data-action-id="terminal.activate"]')).toHaveCount(2);

    // open-tiles (1.5.47): the always-on live branch under the project folder
    // lists BOTH windows without any history expand; clicking a row focuses it.
    const liveRows = page.locator('[data-action-id="sidebar.open-tile.focus"]');
    await expect(liveRows).toHaveCount(2);
    await liveRows.last().click();
    await expect.poll(() => selectedTileId(page)).toBe(tilePlain);

    // Collapse via the branch's close button.
    await page.locator('[data-action-id="sidebar.history.close"]').click();
    await expect(page.locator(".project-sessions")).toHaveCount(0);

    // Group handle CLICK fallback (a11y path for the drag-out): opens the two
    // not-yet-open sessions as tiles; A stays single (3 concurrent + plain = 4).
    await page.locator('[data-action-id="sidebar.project.history.open"]').first().dispatchEvent("click");
    await expect(page.locator('[data-action-id="sidebar.sessions.group.open"]')).toBeVisible();
    await page.locator('[data-action-id="sidebar.sessions.group.open"]').click();
    await expect(page.locator('[data-action-id="terminal.activate"]')).toHaveCount(4, { timeout: 30_000 });

    // Audit oracle for the click-driven actions.
    const ids = (await readUiActions(logPath)).map((a) => a.actionId);
    expect(ids).toContain("sidebar.project.history.open");
    expect(ids).toContain("sidebar.session.open");
    expect(ids).toContain("sidebar.sessions.group.open");
    expect(ids).toContain("sidebar.open-tile.focus");
    expect(ids).toContain("sidebar.history.close");
  } finally {
    await coterm.close();
  }
});

test("session group drag-out opens dock tiles and folder reorder stays intact", async () => {
  // The group drop spawns PTYs sequentially — each can take tens of seconds
  // in a fresh e2e window, so this test needs room.
  test.setTimeout(240_000);
  const coterm = await launchCoterm({
    projectNames: ["SecondProject"],
    seededSessions,
    defaultWorkspacePath: await isolatedWorkspace(),
  });
  try {
    const { page } = coterm;
    await page.locator('[data-action-id="topbar.terminal.refresh"]').waitFor({ state: "visible", timeout: 30_000 });
    await page.locator("section.project-group").first().waitFor({ state: "visible" });

    // Session A is already live → the group drop must skip it (no duplicate).
    await openBoundTile(page, SESSION_A);
    await expect(page.locator('[data-action-id="terminal.activate"]')).toHaveCount(1, { timeout: 30_000 });

    // Two projects share the sidebar and their row order is not guaranteed —
    // open the panel on TestProject (where the sessions were seeded).
    const testProject = page.locator("section.project-group").filter({ hasText: "TestProject" });
    await testProject.locator('[data-action-id="sidebar.project.history.open"]').dispatchEvent("click");
    await expect(page.locator('[data-action-id="sidebar.session.open"]')).toHaveCount(3, { timeout: 15_000 });
    await expect(page.locator('[data-action-id="sidebar.sessions.group.open"]')).toBeVisible();
    // A's binding must be visible as an "open" row before the drag, or the
    // group drop has no way to skip it.
    await expect(page.locator(".project-session-row.open")).toHaveCount(1, { timeout: 15_000 });

    // Drag the whole group onto the main dock shell: B and C open, A is not
    // doubled (3 tiles total = A + B + C).
    await dragBetween(page, '[data-action-id="sidebar.sessions.group.open"]', "section.workspace-shell");
    await expect(page.locator('[data-action-id="terminal.activate"]')).toHaveCount(3, { timeout: 60_000 });

    // Folder reorder must be untouched by session drags: grab the session row
    // (dragstart) and hover a project row — order must NOT change, and the
    // project's own drag-to-reorder still works when dragging the ROW itself.
    // Bootstrap project order is not pinned — capture it, never hardcode it.
    const orderBefore = await page.evaluate(async () =>
      (await window.aiTerminal.bootstrap()).projects.map((p) => p.name));
    expect([...orderBefore].sort()).toEqual(["SecondProject", "TestProject"]);

    await page.evaluate(() => {
      const row = document.querySelector('[data-action-id="sidebar.session.open"]');
      const target = document.querySelectorAll(".project-row")[1];
      if (!row || !target) throw new Error("session row / project row missing");
      const dt = new DataTransfer();
      row.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      row.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await page.waitForTimeout(300);
    const orderAfterSessionDrag = await page.evaluate(async () =>
      (await window.aiTerminal.bootstrap()).projects.map((p) => p.name));
    expect(orderAfterSessionDrag).toEqual(orderBefore);

    // Project-row drag still reorders. The id rides in text/plain (the drop
    // handler's fallback) because the component-state fast path only fills
    // during real pointer drags, not back-to-back dispatched DragEvents. The
    // dragged row's project id is matched by NAME from the DOM so the test
    // doesn't care which project renders first.
    await page.evaluate(async () => {
      const { projects } = await window.aiTerminal.bootstrap();
      const rows = [...document.querySelectorAll(".project-row")];
      if (rows.length < 2 || projects.length < 2) throw new Error("project rows missing");
      const draggedName = rows[0]!.textContent ?? "";
      const dragged = projects.find((p) => draggedName.includes(p.name));
      if (!dragged) throw new Error(`no project matches dragged row "${draggedName}"`);
      const dt = new DataTransfer();
      rows[0]!.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
      dt.setData("text/plain", dragged.id);
      rows[1]!.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      rows[1]!.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      rows[0]!.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await expect.poll(async () =>
      (await page.evaluate(async () =>
        (await window.aiTerminal.bootstrap()).projects.map((p) => p.name))),
    ).toEqual([...orderBefore].reverse());
  } finally {
    await coterm.close();
  }
});
