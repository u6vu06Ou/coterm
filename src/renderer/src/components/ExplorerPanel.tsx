import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Copy,
  ExternalLink,
  File,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceEntry, WorkspaceSearchResult } from "@shared/types";
import { useAppStore } from "../store/app-store";
import { useI18n } from "../i18n";
import { MAX_TREE_DEPTH, isInsideRoot, pathKey, renderableChildren } from "./explorer-tree-paths";

type NodeState = {
  expanded: boolean;
  loading: boolean;
  children: WorkspaceEntry[] | null;
  error: string | null;
};

type InlineEdit = {
  mode: "rename" | "create";
  path: string;
  parentPath: string;
  kind: "file" | "directory";
  value: string;
};

type MenuTarget = {
  entry: WorkspaceEntry;
  parentPath: string;
  x: number;
  y: number;
};

type ClipboardEntry = {
  projectId: string;
  path: string;
  cut: boolean;
};

export function ExplorerPanel({
  selectedPath,
  onSelectFolder,
}: {
  selectedPath: string | null;
  onSelectFolder: (path: string) => void;
}): React.JSX.Element {
  const { explorerOpen, setExplorerOpen, dockLayout, projects, openArtifact, closeArtifact, explorerRevealRequest } = useAppStore();
  const { t } = useI18n();
  const selectedTile = dockLayout.tiles.find((tile) => tile.terminalId === dockLayout.selectedTerminalId);
  const project = projects.find((item) => item.id === selectedTile?.projectId);
  const rootPath = project?.workspacePath ?? null;
  const [selectedEntryPath, setSelectedEntryPath] = useState(selectedPath);
  const [nodes, setNodes] = useState<Record<string, NodeState>>({});
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [inlineEdit, setInlineEdit] = useState<InlineEdit | null>(null);
  const [clipboardEntry, setClipboardEntry] = useState<ClipboardEntry | null>(null);
  const [operationError, setOperationError] = useState("");
  const [explorerWidth, setExplorerWidth] = useState(280);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<WorkspaceSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuItemsRef = useRef<HTMLButtonElement[]>([]);
  const treeRef = useRef<HTMLDivElement | null>(null);
  // Live DOM handle per workspace path, for scroll-into-view on reveal-in-tree.
  // Populated by callback refs on tree rows; stale entries vanish on unmount.
  const rowRefs = useRef(new Map<string, HTMLElement>());
  // Wall-clock deadline until which the scroll handler ignores scroll events.
  // Right-clicking a row that is even slightly past the pane's fold (a deep
  // tree, or a harness that scrolls the element into view before clicking)
  // makes the browser reveal the row — and that scroll notification arrives a
  // frame or two AFTER the menu mounts, so a naive close-on-scroll kills the
  // menu the same gesture just opened. Ignore scrolls during this short window;
  // a genuine user scroll after it still dismisses the menu as before.
  const menuScrollGuardUntil = useRef(0);
  // Project whose tree is on screen right now; async listings that finish
  // after a project switch compare against it and are discarded.
  const liveProjectId = useRef<string | null>(null);
  liveProjectId.current = project?.id ?? null;

  useEffect(() => setSelectedEntryPath(selectedPath), [selectedPath]);

  useEffect(() => {
    const saved = Number(localStorage.getItem("coterm-explorer-width"));
    if (Number.isFinite(saved) && saved >= 180 && saved <= 720) setExplorerWidth(saved);
  }, []);
  useEffect(() => localStorage.setItem("coterm-explorer-width", String(explorerWidth)), [explorerWidth]);

  const loadNode = useCallback(async (path: string, forceExpanded = false): Promise<void> => {
    if (!project || !rootPath) return;
    if (!isInsideRoot(path, rootPath)) return;
    const requestProjectId = project.id;
    setNodes((current) => ({
      ...current,
      [path]: {
        expanded: forceExpanded || current[path]?.expanded === true,
        loading: true,
        children: current[path]?.children ?? null,
        error: null,
      },
    }));
    try {
      const children = await window.aiTerminal.listWorkspace({
        projectId: project.id,
        path: path === rootPath ? null : path,
      });
      if (liveProjectId.current !== requestProjectId) return;
      setNodes((current) => ({
        ...current,
        [path]: {
          expanded: forceExpanded || current[path]?.expanded === true || path === rootPath,
          loading: false,
          children,
          error: null,
        },
      }));
    } catch (reason) {
      if (liveProjectId.current !== requestProjectId) return;
      setNodes((current) => ({
        ...current,
        [path]: {
          expanded: current[path]?.expanded === true,
          loading: false,
          children: current[path]?.children ?? null,
          error: reason instanceof Error ? reason.message : String(reason),
        },
      }));
    }
  }, [project, rootPath]);

  const trackRow = useCallback((entryPath: string) => (element: HTMLElement | null): void => {
    if (element) rowRefs.current.set(entryPath, element);
    else rowRefs.current.delete(entryPath);
  }, []);

  // Reveal-in-tree (VS Code "reveal in explorer"): expand every ancestor
  // folder of `targetPath`, then select the row and scroll it into view.
  // Walks the real listWorkspace responses so entry paths, separators and
  // casing always match what the tree renders — the clicked terminal path
  // might use forward slashes or different case than the on-disk name.
  // Purely best-effort: anything outside the workspace root, a listing error,
  // or a segment that does not exist simply ends the walk silently.
  const revealPathInTree = useCallback(async (targetPath: string): Promise<void> => {
    if (!project || !rootPath) return;
    const toOsSep = (value: string): string => value.replaceAll("/", "\\").replace(/\\+$/u, "");
    const root = toOsSep(rootPath);
    const target = toOsSep(targetPath);
    const rootLower = root.toLowerCase();
    const targetLower = target.toLowerCase();
    if (targetLower !== rootLower && !targetLower.startsWith(`${rootLower}\\`)) return;
    const segments = target.slice(root.length).split("\\").filter((segment) => segment.length > 0);
    if (segments.length === 0) return;
    let currentPath: string | null = null; // null = workspace root (API wants null)
    let currentKey = rootPath;
    let resolvedPath: string | null = null;
    const requestProjectId = project.id;
    for (let depth = 0; depth < segments.length; depth += 1) {
      let children: WorkspaceEntry[];
      try {
        children = await window.aiTerminal.listWorkspace({ projectId: project.id, path: currentPath });
      } catch {
        return;
      }
      if (liveProjectId.current !== requestProjectId) return;
      // Expanded so the folder opens; the file's own node is never expanded
      // (it has no children to show) — the loop breaks on it below.
      setNodes((current) => ({
        ...current,
        [currentKey]: { expanded: true, loading: false, children, error: null },
      }));
      const wanted = segments[depth]!.toLowerCase();
      const next = children.find((child) => child.name.toLowerCase() === wanted);
      if (!next) {
        resolvedPath = null;
        break;
      }
      resolvedPath = next.path;
      if (depth === segments.length - 1) break;
      currentPath = next.path;
      currentKey = next.path;
    }
    if (!resolvedPath) return;
    const reveal = resolvedPath;
    setSelectedEntryPath(reveal);
    // Expanded rows commit asynchronously as setNodes resolves; retry briefly
    // so the scroll targets the row instead of a still-collapsed tree.
    const tryScroll = (attemptsLeft: number): void => {
      const element = rowRefs.current.get(reveal);
      if (element) {
        element.scrollIntoView({ block: "center" });
        return;
      }
      if (attemptsLeft > 0) requestAnimationFrame(() => tryScroll(attemptsLeft - 1));
    };
    requestAnimationFrame(() => tryScroll(10));
  }, [project, rootPath]);

  useEffect(() => {
    if (!explorerRevealRequest || !project) return;
    if (explorerRevealRequest.projectId !== project.id) return;
    // Drop stale asks: tile selection lands over the WS a beat after the click,
    // so this effect can re-run on the project switch — only requests from the
    // last few seconds belong to a live click.
    if (Date.now() - explorerRevealRequest.at > 10_000) return;
    void revealPathInTree(explorerRevealRequest.path);
  }, [explorerRevealRequest, project, revealPathInTree]);

  useEffect(() => {
    setNodes({});
    setInlineEdit(null);
    setMenu(null);
    if (rootPath) {
      void loadNode(rootPath, true);
      try {
        const saved = JSON.parse(localStorage.getItem(`coterm-explorer-state:${project?.id}`) ?? "null") as { version?: number; width?: number; expandedPaths?: string[]; selectedPath?: string | null; scrollTop?: number; searchQuery?: string } | null;
        if (saved?.version === 1) {
          if (typeof saved.width === "number") setExplorerWidth(Math.min(720, Math.max(180, saved.width)));
          if (typeof saved.selectedPath === "string") setSelectedEntryPath(saved.selectedPath);
          if (typeof saved.searchQuery === "string") setSearchQuery(saved.searchQuery);
          if (Array.isArray(saved.expandedPaths)) for (const path of saved.expandedPaths.slice(0, 300)) if (typeof path === "string" && path !== rootPath && isInsideRoot(path, rootPath)) void loadNode(path, true);
          requestAnimationFrame(() => { if (treeRef.current && typeof saved.scrollTop === "number") treeRef.current.scrollTop = saved.scrollTop; });
        }
      } catch { /* malformed state is ignored */ }
    }
  }, [loadNode, project?.id, rootPath]);

  useEffect(() => {
    if (!project?.id || !rootPath) return;
    // The render that switches project still carries the previous project's
    // nodes (setNodes({}) lands one effect later) — only persist this root's.
    const expandedPaths = Object.entries(nodes).filter(([path, state]) => state.expanded && isInsideRoot(path, rootPath)).map(([path]) => path).slice(0, 300);
    localStorage.setItem(`coterm-explorer-state:${project.id}`, JSON.stringify({ version: 1, width: explorerWidth, expandedPaths, selectedPath: selectedEntryPath, scrollTop: treeRef.current?.scrollTop ?? 0, searchQuery }));
  }, [nodes, explorerWidth, selectedEntryPath, searchQuery, project?.id, rootPath]);

  useEffect(() => {
    const projectId = project?.id;
    if (!projectId || !searchQuery.trim()) { setSearchResults([]); setSearchLoading(false); return; }
    const timer = setTimeout(() => {
      setSearchLoading(true);
      void window.aiTerminal.searchWorkspaceEntries({ projectId, query: searchQuery, maxResults: 300 })
        .then(setSearchResults)
        .catch(() => setSearchResults([]))
        .finally(() => setSearchLoading(false));
    }, 150);
    return () => clearTimeout(timer);
  }, [project?.id, searchQuery]);

  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = explorerWidth;
    const move = (next: PointerEvent): void => setExplorerWidth(Math.min(720, Math.max(180, startWidth + next.clientX - startX)));
    const end = (): void => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
  };

  useEffect(() => {
    if (!menu) return;
    const onOutside = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenu(null);
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const items = menuItemsRef.current.filter(Boolean);
      if (items.length === 0) return;
      event.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "ArrowDown"
        ? (current + 1 + items.length) % items.length
        : (current - 1 + items.length) % items.length;
      items[next]?.focus();
    };
    // The menu is position:fixed, so scrolling any ancestor cannot move it —
    // this only dismisses it, as a courtesy when the anchor drifts away. It
    // must not fire for the deferred scroll notification of the
    // scroll-into-view that opening the menu itself triggered (see the guard
    // ref); any scroll after the guard window closes the menu as before.
    const onScroll = (): void => {
      if (performance.now() < menuScrollGuardUntil.current) return;
      setMenu(null);
    };
    menuItemsRef.current = [];
    window.addEventListener("pointerdown", onOutside);
    window.addEventListener("keydown", onEscape);
    document.addEventListener("scroll", onScroll, true);
    requestAnimationFrame(() => menuItemsRef.current[0]?.focus());
    return () => {
      window.removeEventListener("pointerdown", onOutside);
      window.removeEventListener("keydown", onEscape);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [menu]);

  const refreshNode = useCallback((path: string): void => {
    void loadNode(path, true);
  }, [loadNode]);

  const toggleFolder = useCallback((entry: WorkspaceEntry): void => {
    const state = nodes[entry.path];
    if (state?.expanded) {
      setNodes((current) => ({
        ...current,
        [entry.path]: {
          expanded: false,
          loading: current[entry.path]?.loading ?? false,
          children: current[entry.path]?.children ?? null,
          error: current[entry.path]?.error ?? null,
        },
      }));
      return;
    }
    setNodes((current) => ({
      ...current,
      [entry.path]: {
        expanded: true,
        loading: current[entry.path]?.loading ?? false,
        children: current[entry.path]?.children ?? null,
        error: current[entry.path]?.error ?? null,
      },
    }));
    if (!state?.children) void loadNode(entry.path, true);
  }, [loadNode, nodes]);

  const copyText = useCallback(async (value: string): Promise<void> => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return;
      }
      throw new Error("clipboard unavailable");
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      if (!copied) throw new Error(t("explorer.copyPath.failed"));
    }
  }, [t]);

  const updateOpenArtifactPath = useCallback((oldPath: string, newPath: string): void => {
    const artifact = useAppStore.getState().selectedArtifact;
    if (!artifact) return;
    const oldPrefix = `${oldPath.replace(/[\\/]+$/u, "")}\\`;
    const normalized = artifact.path.replaceAll("/", "\\");
    const oldNormalized = oldPath.replaceAll("/", "\\");
    if (normalized.toLowerCase() === oldNormalized.toLowerCase()) {
      openArtifact(newPath, artifact.title, artifact.projectId);
    } else if (normalized.toLowerCase().startsWith(oldPrefix.toLowerCase())) {
      const suffix = normalized.slice(oldPrefix.length);
      openArtifact(`${newPath}\\${suffix}`, artifact.title, artifact.projectId);
    }
  }, [openArtifact]);

  const deleteOpenArtifact = useCallback((path: string): void => {
    const artifact = useAppStore.getState().selectedArtifact;
    if (!artifact) return;
    const normalized = artifact.path.replaceAll("/", "\\").toLowerCase();
    const target = path.replaceAll("/", "\\").toLowerCase();
    if (normalized === target || normalized.startsWith(`${target}\\`)) closeArtifact();
  }, [closeArtifact]);

  const parentForApi = useCallback((parentPath: string): string | null => parentPath === rootPath ? null : parentPath, [rootPath]);

  const commitInlineEdit = useCallback(async (): Promise<void> => {
    if (!project || !inlineEdit) return;
    const value = inlineEdit.value.trim();
    if (!value) {
      setInlineEdit(null);
      return;
    }
    try {
      if (inlineEdit.mode === "rename") {
        const result = await window.aiTerminal.renameWorkspaceEntry({
          projectId: project.id,
          path: inlineEdit.path,
          newName: value,
          newParentPath: parentForApi(inlineEdit.parentPath),
        });
        updateOpenArtifactPath(inlineEdit.path, result.path);
        refreshNode(inlineEdit.parentPath);
        if (inlineEdit.parentPath !== result.path.slice(0, result.path.length - result.name.length - 1)) {
          refreshNode(result.path.slice(0, result.path.length - result.name.length - 1));
        }
      } else if (inlineEdit.kind === "file") {
        await window.aiTerminal.createWorkspaceFile({ projectId: project.id, parentPath: parentForApi(inlineEdit.parentPath), name: value });
        refreshNode(inlineEdit.parentPath);
      } else {
        await window.aiTerminal.createWorkspaceDirectory({ projectId: project.id, parentPath: parentForApi(inlineEdit.parentPath), name: value });
        refreshNode(inlineEdit.parentPath);
      }
      setOperationError("");
      setInlineEdit(null);
    } catch (reason) {
      setOperationError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [inlineEdit, parentForApi, project, refreshNode, updateOpenArtifactPath]);

  const startCreate = useCallback((parentPath: string, kind: "file" | "directory"): void => {
    setMenu(null);
    setOperationError("");
    setInlineEdit({ mode: "create", path: parentPath, parentPath, kind, value: "" });
    setNodes((current) => ({
      ...current,
      [parentPath]: {
        expanded: true,
        loading: current[parentPath]?.loading ?? false,
        children: current[parentPath]?.children ?? null,
        error: current[parentPath]?.error ?? null,
      },
    }));
  }, []);

  const startRename = useCallback((entry: WorkspaceEntry, parentPath: string): void => {
    setMenu(null);
    setOperationError("");
    setInlineEdit({ mode: "rename", path: entry.path, parentPath, kind: entry.type, value: entry.name });
  }, []);

  const deleteEntry = useCallback(async (entry: WorkspaceEntry, parentPath: string): Promise<void> => {
    setMenu(null);
    if (!window.confirm(t("explorer.delete.confirm", { name: entry.name }))) return;
    try {
      await window.aiTerminal.deleteWorkspaceEntry({ projectId: project?.id ?? "", path: entry.path });
      deleteOpenArtifact(entry.path);
      refreshNode(parentPath);
      setOperationError("");
    } catch (reason) {
      setOperationError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [deleteOpenArtifact, project?.id, refreshNode, t]);

  const duplicateEntry = useCallback(async (entry: WorkspaceEntry, parentPath: string): Promise<void> => {
    setMenu(null);
    if (!project) return;
    try {
      await window.aiTerminal.duplicateWorkspaceEntry({ projectId: project.id, path: entry.path, destinationPath: parentPath });
      refreshNode(parentPath);
      setOperationError("");
    } catch (reason) {
      setOperationError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [project, refreshNode]);

  const pasteEntry = useCallback(async (destinationPath: string): Promise<void> => {
    if (!project || !clipboardEntry) return;
    setMenu(null);
    const name = clipboardEntry.path.split(/[\\/]/u).at(-1) ?? "entry";
    try {
      if (clipboardEntry.cut) {
        const sourceParent = clipboardEntry.path.slice(0, Math.max(0, clipboardEntry.path.length - name.length - 1));
        const result = await window.aiTerminal.renameWorkspaceEntry({
          projectId: project.id,
          path: clipboardEntry.path,
          newName: name,
          newParentPath: parentForApi(destinationPath),
        });
        updateOpenArtifactPath(clipboardEntry.path, result.path);
        refreshNode(sourceParent);
      } else {
        await window.aiTerminal.duplicateWorkspaceEntry({ projectId: project.id, path: clipboardEntry.path, destinationPath });
      }
      refreshNode(destinationPath);
      setClipboardEntry(null);
      setOperationError("");
    } catch (reason) {
      setOperationError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [clipboardEntry, parentForApi, project, refreshNode, updateOpenArtifactPath]);

  const openMenuAt = useCallback((entry: WorkspaceEntry, parentPath: string, clientX: number, clientY: number): void => {
    const menuWidth = 190;
    const menuHeight = entry.type === "directory" ? 390 : 330;
    // Arm the grace window so the click's own deferred focus-scroll does not
    // immediately close the menu it just opened (see the scroll guard ref).
    menuScrollGuardUntil.current = performance.now() + 250;
    setMenu({
      entry,
      parentPath,
      x: Math.max(4, Math.min(clientX, window.innerWidth - menuWidth - 4)),
      y: Math.max(4, Math.min(clientY, window.innerHeight - menuHeight - 4)),
    });
  }, []);

  const openMenu = useCallback((entry: WorkspaceEntry, parentPath: string, event: React.MouseEvent): void => {
    event.preventDefault();
    openMenuAt(entry, parentPath, event.clientX, event.clientY);
  }, [openMenuAt]);

  const relativePath = (entry: WorkspaceEntry): string => entry.relativePath ?? entry.path;

  if (!explorerOpen) {
    return (
      <aside className="explorer-panel collapsed">
        <button data-action-id="explorer.open" title={t("explorer.open")} aria-label={t("explorer.open")} onClick={() => setExplorerOpen(true)}>
          <ChevronRight size={16} />
        </button>
      </aside>
    );
  }

  const renderInlineInput = (edit: InlineEdit): React.JSX.Element => (
    <div className="explorer-inline-row">
      <input
        data-action-id={edit.mode === "rename" ? "explorer.rename.change" : "explorer.create.change"}
        autoFocus
        value={edit.value}
        placeholder={edit.mode === "rename" ? undefined : t(edit.kind === "file" ? "explorer.create.filePlaceholder" : "explorer.create.folderPlaceholder")}
        onChange={(event) => setInlineEdit((current) => current ? { ...current, value: event.target.value } : current)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void commitInlineEdit();
          if (event.key === "Escape") setInlineEdit(null);
        }}
        onBlur={() => { if (edit.mode === "rename") setInlineEdit(null); }}
      />
      <button data-action-id="explorer.inline.submit" title={t("explorer.rename")} onMouseDown={(event) => event.preventDefault()} onClick={() => void commitInlineEdit()}><Check size={13} /></button>
      <button data-action-id="explorer.inline.cancel" title={t("explorer.inline.cancel")} onClick={() => setInlineEdit(null)}><X size={13} /></button>
    </div>
  );

  const renderNode = (entry: WorkspaceEntry, parentPath: string, depth: number, ancestors: ReadonlySet<string> = new Set()): React.JSX.Element => {
    const state = nodes[entry.path];
    const ownKey = pathKey(entry.path);
    const lineage = new Set(ancestors).add(ownKey);
    // Cycle guard: a child that is this folder or one of its ancestors would
    // recurse forever (whole-app crash) — never render it, and cap the depth.
    const visibleChildren = depth >= MAX_TREE_DEPTH ? [] : renderableChildren(state?.children, lineage);
    const selected = selectedEntryPath === entry.path;
    return (
      <div key={entry.path} className="tree-node" role="none">
        {inlineEdit?.mode === "rename" && inlineEdit.path === entry.path
          ? renderInlineInput(inlineEdit)
          : entry.type === "directory" ? (
            <div
              ref={trackRow(entry.path)}
              data-action-id="explorer.folder.open"
              className={`tree-row tree-directory-row ${selected ? "selected" : ""}`}
              style={{ paddingLeft: `${depth * 14 + 4}px` }}
              role="treeitem"
              aria-expanded={state?.expanded === true}
              tabIndex={0}
              onContextMenu={(event) => openMenu(entry, parentPath, event)}
              onKeyDown={(event) => {
                if (event.key === "Enter") setSelectedEntryPath(entry.path);
                if (event.key === "ArrowRight") toggleFolder(entry);
                if (event.key === "ArrowLeft" && state?.expanded) toggleFolder(entry);
                if (event.key === "F10" && event.shiftKey) {
                  event.preventDefault();
                  const bounds = event.currentTarget.getBoundingClientRect();
                  openMenuAt(entry, parentPath, bounds.left + 12, bounds.bottom);
                }
              }}
              onDoubleClick={() => onSelectFolder(entry.path)}
            >
              <button data-action-id="explorer.folder.toggle" type="button" className="tree-chevron" aria-label={state?.expanded ? "Collapse folder" : "Expand folder"} onClick={() => toggleFolder(entry)}>
                {state?.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>
              <button data-action-id="explorer.folder.select" type="button" className="tree-label" onClick={() => setSelectedEntryPath(entry.path)}>
                {state?.expanded ? <FolderOpen size={14} className="tree-folder-icon" /> : <Folder size={14} className="tree-folder-icon" />}<span>{entry.name}</span>
              </button>
            </div>
          ) : (
            <button
              ref={trackRow(entry.path)}
              data-action-id="explorer.file.open"
              type="button"
              className={`tree-row file ${selected ? "selected" : ""}`}
              style={{ paddingLeft: `${depth * 14 + 20}px` }}
              role="treeitem"
              tabIndex={0}
              onClick={() => { setSelectedEntryPath(entry.path); openArtifact(entry.path, entry.name, project?.id); }}
              onContextMenu={(event) => openMenu(entry, parentPath, event)}
              onKeyDown={(event) => { if (event.key === "Enter" && project) openArtifact(entry.path, entry.name, project.id); }}
            >
              <File size={14} /><span>{entry.name}</span>
            </button>
          )}
        {entry.type === "directory" && state?.expanded && (
          <div className="explorer-tree tree-children" role="group">
            {inlineEdit?.mode === "create" && inlineEdit.parentPath === entry.path && renderInlineInput(inlineEdit)}
            {state.loading && <p className="explorer-loading">{t("explorer.loading")}</p>}
            {state.error && <p className="explorer-error">{state.error}</p>}
            {!state.loading && !state.error && state.children?.length === 0 && <p className="explorer-empty">{t("explorer.empty")}</p>}
            {visibleChildren.map((child) => renderNode(child, entry.path, depth + 1, lineage))}
          </div>
        )}
      </div>
    );
  };

  const rootState = rootPath ? nodes[rootPath] : null;
  const menuEntry = menu?.entry;
  const menuParent = menu?.parentPath;

  return (
    <aside className="explorer-panel" style={{ width: explorerWidth, minWidth: explorerWidth }}>
      <header>
        <div><span>EXPLORER</span><strong>{project?.name ?? "No project"}</strong></div>
        <div className="explorer-actions">
          <button data-action-id="explorer.new-file" title={t("explorer.newFile")} aria-label={t("explorer.newFile")} disabled={!rootPath} onClick={() => rootPath && startCreate(rootPath, "file")}><FilePlus size={15} /></button>
          <button data-action-id="explorer.new-folder" title={t("explorer.newFolder")} aria-label={t("explorer.newFolder")} disabled={!rootPath} onClick={() => rootPath && startCreate(rootPath, "directory")}><FolderPlus size={15} /></button>
          <button data-action-id="explorer.refresh" title={t("explorer.refresh")} aria-label={t("explorer.refresh")} disabled={!rootPath} onClick={() => rootPath && refreshNode(rootPath)}><RefreshCw size={15} /></button>
          <button data-action-id="explorer.close" title={t("explorer.close")} aria-label={t("explorer.close")} onClick={() => setExplorerOpen(false)}><ChevronLeft size={16} /></button>
        </div>
      </header>
      <div className="explorer-search-row">
        <Search size={14} />
        <input data-action-id="explorer.search.input" aria-label={t("explorer.search.aria")} placeholder={t("explorer.search.placeholder")} value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />
        {searchQuery && <button data-action-id="explorer.search.clear" type="button" aria-label={t("explorer.search.clear")} onClick={() => setSearchQuery("")}>×</button>}
      </div>
      <div className="explorer-resizer" data-action-id="explorer.resize" role="separator" aria-orientation="vertical" aria-label={t("explorer.resize.aria")} tabIndex={0} onPointerDown={startResize} onDoubleClick={() => setExplorerWidth(280)} onKeyDown={(event) => { if (event.key === "ArrowLeft") setExplorerWidth((value) => Math.max(180, value - 16)); if (event.key === "ArrowRight") setExplorerWidth((value) => Math.min(720, value + 16)); if (event.key === "Enter") setExplorerWidth(280); }} />
      {project && rootPath ? (
        searchQuery.trim() ? (
          <div className="explorer-search-results" role="list" aria-label="Workspace search results">
            {searchLoading && <p className="explorer-loading">Searching…</p>}
            {!searchLoading && searchResults.length === 0 && <p className="explorer-empty">No matching files.</p>}
            {searchResults.map((result, index) => (
              <button key={result.path} data-action-id={`explorer.search.result.${index}`} type="button" className="explorer-search-result" onClick={() => { setSelectedEntryPath(result.path); if (result.type === "file") openArtifact(result.path, result.name, project.id); else { onSelectFolder(result.path); void loadNode(result.path, true); } }}>
                <span>{result.name}</span><small>{result.relativePath}</small>
              </button>
            ))}
          </div>
        ) : <div ref={treeRef} className="explorer-tree explorer-root" role="tree" aria-label={t("explorer.tree.aria")} onScroll={() => {
          localStorage.setItem(`coterm-explorer-state:${project.id}`, JSON.stringify({ version: 1, width: explorerWidth, expandedPaths: Object.entries(nodes).filter(([path, state]) => state.expanded && isInsideRoot(path, rootPath)).map(([path]) => path).slice(0, 300), selectedPath: selectedEntryPath, scrollTop: treeRef.current?.scrollTop ?? 0, searchQuery }));
        }}>
          {inlineEdit?.mode === "create" && inlineEdit.parentPath === rootPath && renderInlineInput(inlineEdit)}
          {rootState?.loading && <p className="explorer-loading">{t("explorer.loading")}</p>}
          {rootState?.error && <p className="explorer-error">{rootState.error}</p>}
          {!rootState?.loading && !rootState?.error && rootState?.children?.length === 0 && <p className="explorer-empty">{t("explorer.empty")}</p>}
          {renderableChildren(rootState?.children, new Set([pathKey(rootPath)])).map((entry) => renderNode(entry, rootPath, 0, new Set([pathKey(rootPath)])))}
        </div>
      ) : <p className="explorer-empty">Select a project.</p>}
      {operationError && <p className="explorer-error" role="alert">{operationError}</p>}
      {menu && menuEntry && menuParent && project && (
        <div ref={menuRef} className="explorer-context-menu" style={{ left: menu.x, top: menu.y }} role="menu">
          <button ref={(element) => { if (element) menuItemsRef.current.push(element); }} data-action-id="explorer.copy-path" role="menuitem" onClick={() => { void copyText(menuEntry.path); setMenu(null); }}><Copy size={13} />{t("explorer.copyPath.label")}</button>
          <button ref={(element) => { if (element) menuItemsRef.current.push(element); }} data-action-id="explorer.context.copy-relative-path" role="menuitem" onClick={() => { void copyText(relativePath(menuEntry)); setMenu(null); }}><Copy size={13} />{t("explorer.copyRelativePath.label")}</button>
          <button ref={(element) => { if (element) menuItemsRef.current.push(element); }} data-action-id="explorer.context.rename" role="menuitem" onClick={() => startRename(menuEntry, menuParent)}><Pencil size={13} />{t("explorer.rename")}</button>
          {menuEntry.type === "directory" && <>
            <button ref={(element) => { if (element) menuItemsRef.current.push(element); }} data-action-id="explorer.context.new-file" role="menuitem" onClick={() => startCreate(menuEntry.path, "file")}><FilePlus size={13} />{t("explorer.newFile")}</button>
            <button ref={(element) => { if (element) menuItemsRef.current.push(element); }} data-action-id="explorer.context.new-folder" role="menuitem" onClick={() => startCreate(menuEntry.path, "directory")}><FolderPlus size={13} />{t("explorer.newFolder")}</button>
          </>}
          <button ref={(element) => { if (element) menuItemsRef.current.push(element); }} data-action-id="explorer.context.copy" role="menuitem" onClick={() => { setClipboardEntry({ projectId: project.id, path: menuEntry.path, cut: false }); setMenu(null); }}><Copy size={13} />{t("explorer.copy")}</button>
          <button ref={(element) => { if (element) menuItemsRef.current.push(element); }} data-action-id="explorer.context.cut" role="menuitem" onClick={() => { setClipboardEntry({ projectId: project.id, path: menuEntry.path, cut: true }); setMenu(null); }}><Clipboard size={13} />{t("explorer.cut")}</button>
          {clipboardEntry && clipboardEntry.projectId === project.id && <button ref={(element) => { if (element) menuItemsRef.current.push(element); }} data-action-id="explorer.context.paste" role="menuitem" disabled={clipboardEntry.path === menuEntry.path} onClick={() => void pasteEntry(menuEntry.type === "directory" ? menuEntry.path : menuParent)}><Clipboard size={13} />{t("explorer.paste")}</button>}
          <button ref={(element) => { if (element) menuItemsRef.current.push(element); }} data-action-id="explorer.context.duplicate" role="menuitem" onClick={() => void duplicateEntry(menuEntry, menuParent)}><Copy size={13} />{t("explorer.duplicate")}</button>
          <button ref={(element) => { if (element) menuItemsRef.current.push(element); }} data-action-id="explorer.context.reveal" role="menuitem" onClick={() => { void window.aiTerminal.revealWorkspaceEntry({ projectId: project.id, path: menuEntry.path }); setMenu(null); }}><FolderOpen size={13} />{t("explorer.reveal")}</button>
          {menuEntry.type === "file" && <button ref={(element) => { if (element) menuItemsRef.current.push(element); }} data-action-id="explorer.context.external" role="menuitem" onClick={() => { void window.aiTerminal.openWorkspaceEntryExternal({ projectId: project.id, path: menuEntry.path }); setMenu(null); }}><ExternalLink size={13} />{t("explorer.external")}</button>}
          <button ref={(element) => { if (element) menuItemsRef.current.push(element); }} data-action-id="explorer.context.refresh" role="menuitem" onClick={() => { refreshNode(menuParent); setMenu(null); }}><RefreshCw size={13} />{t("explorer.refresh")}</button>
          <button ref={(element) => { if (element) menuItemsRef.current.push(element); }} data-action-id="explorer.context.delete" role="menuitem" onClick={() => void deleteEntry(menuEntry, menuParent)}><Trash2 size={13} />{t("explorer.delete")}</button>
        </div>
      )}
    </aside>
  );
}
