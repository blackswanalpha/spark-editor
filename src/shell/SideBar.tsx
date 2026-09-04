/* ============================================================
   sparkBook · src/shell/SideBar.tsx
   Left pane: folder explorer (Files) + recents tab.
   The explorer mirrors designlabs/labs/explorer.html:
     - Lazy read_dir per directory
     - A11Y-004 tree-view keyboard contract
       (↑↓ move, → expand / first child, ← collapse / parent,
        Enter / Space activate, Home / End first / last).
     - Toolbar (new file / refresh / collapse / show hidden)
     - Loader row, empty / error row
   ============================================================ */
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { motion, AnimatePresence } from "@motion/index";
import { Icon } from "@ui/Icon";
import { LangLogo } from "@ui/LangLogo";
import { Spinner as Loader } from "@ui/Loader";
import { Dialog, DialogFooter } from "@ui/Dialog";
import { Input } from "@ui/Input";
import { Button } from "@ui/Button";
import { Popover, PopoverTrigger, PopoverContent } from "@ui/Popover";
import { useExplorer, directoryOf, type ExplorerNode } from "@store/explorer";
import { splitPath, openFolderDialog } from "@bridge/commands";
import { langIdOf } from "@editor/CodeEditor/languages";
import { ExplorerContextMenu } from "./ExplorerContextMenu";
import { openTerminalAt } from "@store/terminal";
import "./SideBar.css";

/* Lightweight error boundary for the file tree — satisfies React's
   "Consider adding an error boundary" suggestion and prevents a single
   bad icon from crashing the whole explorer. */
class TreeErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(err: unknown) {
    console.error("[SideBar] Tree render error:", err);
  }
  render() {
    if (this.state.hasError) {
      return <div className="tree-empty">Explorer error — see console</div>;
    }
    return this.props.children;
  }
}

export interface RecentsEntry { path: string; name: string; }

export interface SideBarProps {
  recents: RecentsEntry[];
  onOpen: (path: string) => void;
  activePath?: string;
  onRequestOpenFolder?: () => void;
  onInfo?: (message: string) => void;
  onError?: (message: string, detail?: string) => void;
  /** Hide the pane. Rendered as a header affordance next to the tabs. */
  onCollapse?: () => void;
}

export function SideBar({
  recents, onOpen, activePath, onRequestOpenFolder, onInfo, onError, onCollapse,
}: SideBarProps) {
  const [tab, setTab] = useState<"files" | "recents">("files");

  /* "Open Recent File" in the palette/menu points here rather than at a
     second file picker — the recents list already lives in this pane. */
  useEffect(() => {
    const onTab = (e: Event) => {
      const want = (e as CustomEvent<{ tab?: "files" | "recents" }>).detail?.tab;
      if (want === "files" || want === "recents") setTab(want);
    };
    window.addEventListener("spark:sidebar:tab", onTab);
    return () => window.removeEventListener("spark:sidebar:tab", onTab);
  }, []);

  return (
    <aside className="sidebar">
      <div className="sidebar__tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "files"}
          className={`sidebar__tab ${tab === "files" ? "is-active" : ""}`}
          onClick={() => setTab("files")}
        >
          <Icon name="folder" size={14} />
          <span>Explorer</span>
        </button>
        <button
          role="tab"
          aria-selected={tab === "recents"}
          className={`sidebar__tab ${tab === "recents" ? "is-active" : ""}`}
          onClick={() => setTab("recents")}
        >
          <Icon name="refresh" size={14} />
          <span>Recents</span>
        </button>
        {onCollapse && (
          <button
            type="button"
            className="sidebar__collapse"
            aria-label="Hide explorer"
            title="Hide explorer (Ctrl+B)"
            onClick={onCollapse}
          >
            <Icon name="sidebar-toggle" size={14} />
          </button>
        )}
      </div>

      <div className="sidebar__body">
        <AnimatePresence mode="wait">
          {tab === "files" ? (
            <motion.div
              key="files"
              className="sidebar__list"
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -4 }}
              transition={{ duration: 0.12 }}
            >
              <ExplorerPane
                onOpen={onOpen}
                activePath={activePath}
                onRequestOpenFolder={onRequestOpenFolder}
                onInfo={onInfo}
                onError={onError}
              />
            </motion.div>
          ) : (
            <motion.ul
              key="recents"
              className="sidebar__list"
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -4 }}
              transition={{ duration: 0.12 }}
            >
              {recents.length ? recents.map((r) => (
                <li key={r.path}>
                  <button
                    className={`sidebar__entry ${activePath === r.path ? "is-active" : ""}`}
                    onClick={() => onOpen(r.path)}
                  >
                    <Icon name="file" size={14} />
                    <span className="sidebar__entry-name">{r.name}</span>
                    <span className="sidebar__entry-path">{r.path}</span>
                  </button>
                </li>
              )) : (
                <div className="sidebar__empty">No recent files.</div>
              )}
            </motion.ul>
          )}
        </AnimatePresence>
      </div>
    </aside>
  );
}

/* ---------- Explorer pane ---------- */
function ExplorerPane({
  onOpen, activePath, onRequestOpenFolder, onInfo, onError,
}: Pick<SideBarProps, "onOpen" | "activePath" | "onRequestOpenFolder" | "onInfo" | "onError">) {
  const root = useExplorer((s) => s.root);
  if (!root) {
    return (
      <div className="sidebar__empty explorer-empty">
        <p>No folder open.</p>
        <button
          type="button"
          className="sidebar__open-btn"
          onClick={() => onRequestOpenFolder?.()}
        >
          Open Folder…
        </button>
      </div>
    );
  }
  return (
    <Explorer
      root={root}
      onOpen={onOpen}
      activePath={activePath}
      onRequestOpenFolder={onRequestOpenFolder}
      onInfo={onInfo}
      onError={onError}
    />
  );
}

/* ---------- Explorer (toolbar + tree) ---------- */
function Explorer({
  root, onOpen, activePath, onRequestOpenFolder, onInfo, onError,
}: {
  root: string;
  onOpen: (path: string) => void;
  activePath?: string;
  onRequestOpenFolder?: () => void;
  onInfo?: (message: string) => void;
  onError?: (message: string, detail?: string) => void;
}) {
  /* Selecting each field separately. Returning an object literal from a
     zustand selector allocates a new object on every store read, so the
     default Object.is comparison never matches and the entire tree
     re-renders on any store write — including ones this pane ignores. */
  const expanded = useExplorer((s) => s.expanded);
  const children = useExplorer((s) => s.children);
  const loading = useExplorer((s) => s.loading);
  const errors = useExplorer((s) => s.errors);
  const showHidden = useExplorer((s) => s.showHidden);
  const selectedPath = useExplorer((s) => s.selectedPath);
  const history = useExplorer((s) => s.history);
  const historyIndex = useExplorer((s) => s.historyIndex);

  const slice = useMemo<Slice>(
    () => ({ expanded, children, loading, errors, showHidden, selectedPath, history, historyIndex }),
    [expanded, children, loading, errors, showHidden, selectedPath, history, historyIndex],
  );

  const segments = splitPath(root);
  const title = segments[segments.length - 1] || root;
  const canGoBack = slice.historyIndex > 0;
  const canGoForward = slice.historyIndex >= 0 && slice.historyIndex < slice.history.length - 1;

  // create bubble + dialog state
  const [bubbleOpen, setBubbleOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createKind, setCreateKind] = useState<"file" | "folder">("file");

  const openCreate = useCallback((kind: "file" | "folder") => {
    setBubbleOpen(false);
    setCreateKind(kind);
    setCreateOpen(true);
  }, []);

  const bubbleCwd = useMemo(() => {
    const sel = slice.selectedPath;
    return sel ? directoryOf(slice.children, sel) : root;
  }, [slice.selectedPath, slice.children, root]);

  return (
    <div className="explorer" aria-label="File explorer">
      <div className="explorer__header">
        <div className="explorer__nav" aria-label="Navigation">
          <button
            type="button"
            className="icon-btn"
            aria-label="Go back"
            title={canGoBack ? `Back to ${slice.history[slice.historyIndex - 1]}` : "Go back"}
            disabled={!canGoBack}
            onClick={() => { void useExplorer.getState().goBack(); }}
          >
            <Icon name="arrow-left" size={14} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Go forward"
            title={canGoForward ? `Forward to ${slice.history[slice.historyIndex + 1]}` : "Go forward"}
            disabled={!canGoForward}
            onClick={() => { void useExplorer.getState().goForward(); }}
          >
            <Icon name="arrow-right" size={14} />
          </button>
          <span className="explorer__title" title={root}>{title}</span>
        </div>
        <span className="explorer__actions">
          <button
            type="button"
            className="icon-btn"
            aria-label="Change folder"
            title="Change folder"
            onClick={() => onRequestOpenFolder?.()}
          >
            <Icon name="folder-open" size={14} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Up to parent folder"
            title="Up to parent folder"
            disabled={root === "/"}
            onClick={() => { void useExplorer.getState().goUp(); }}
          >
            <Icon name="arrow-up" size={14} />
          </button>
          {/* + as bubble (popover) for create file/folder */}
          <Popover open={bubbleOpen} onOpenChange={setBubbleOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="icon-btn"
                aria-label="New file or folder"
                title="New file or folder"
              >
                <Icon name="plus" size={14} />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" sideOffset={6} className="explorer__bubble">
              <div className="explorer__bubble-title">Create new</div>
              <button
                type="button"
                className="explorer__bubble-item"
                onClick={() => openCreate("file")}
              >
                <Icon name="file-plus" size={16} />
                <span>New File…</span>
              </button>
              <button
                type="button"
                className="explorer__bubble-item"
                onClick={() => openCreate("folder")}
              >
                <Icon name="folder-plus" size={16} />
                <span>New Folder…</span>
              </button>
              <div className="explorer__bubble-sep" role="separator" />
              <button
                type="button"
                className="explorer__bubble-item"
                onClick={() => {
                  setBubbleOpen(false);
                  openTerminalAt(bubbleCwd);
                  onInfo?.(`Terminal: ${bubbleCwd}`);
                }}
                title={`Open internal terminal at ${bubbleCwd}`}
              >
                <Icon name="terminal" size={16} />
                <span>Open in Terminal</span>
              </button>
            </PopoverContent>
          </Popover>
          <button
            type="button"
            className="icon-btn"
            aria-label="Refresh explorer"
            title="Refresh explorer"
            onClick={() => { void useExplorer.getState().refresh(); }}
          >
            <Icon name="refresh" size={14} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Collapse folders"
            title="Collapse folders"
            onClick={() => useExplorer.getState().collapseAll()}
          >
            <Icon name="chevron-down" size={14} />
          </button>
          <button
            type="button"
            className={`icon-btn ${slice.showHidden ? "is-on" : ""}`}
            aria-label={slice.showHidden ? "Hide hidden files" : "Show hidden files"}
            aria-pressed={slice.showHidden}
            title={slice.showHidden ? "Hide hidden files" : "Show hidden files"}
            onClick={() => useExplorer.getState().toggleShowHidden()}
          >
            <Icon name={slice.showHidden ? "eye" : "eye-slash"} size={14} />
          </button>
        </span>
      </div>

      <CreateDialog
        open={createOpen}
        kind={createKind}
        onOpenChange={setCreateOpen}
        root={root}
        selectedPath={slice.selectedPath}
        explorerChildren={slice.children}
        onInfo={onInfo}
        onError={onError}
      />

      <Tree
        root={root}
        onOpen={onOpen}
        activePath={activePath}
        slice={slice}
        onRequestCreate={openCreate}
        onInfo={onInfo}
        onError={onError}
      />
    </div>
  );
}

function CreateDialog({
  open, kind, onOpenChange, root, selectedPath, explorerChildren, onInfo, onError,
}: {
  open: boolean;
  kind: "file" | "folder";
  onOpenChange: (o: boolean) => void;
  root: string;
  selectedPath: string | null;
  explorerChildren: Map<string, ExplorerNode[]>;
  onInfo?: (m: string) => void;
  onError?: (m: string, d?: string) => void;
}) {
  const isFile = kind === "file";
  const defaultDir = useMemo(() => {
    if (selectedPath) {
      // if selected is a dir and known, use it; else use its parent
      const sel = selectedPath;
      // heuristic: if sel is in children map or has children, treat as dir_candidate
      const isDirKnown = explorerChildren.has(sel);
      if (isDirKnown) return sel;
      // if selected is a file, use its parent
      const idx = Math.max(sel.lastIndexOf("/"), sel.lastIndexOf("\\"));
      if (idx > 0) return sel.slice(0, idx) || "/";
      return root;
    }
    return root;
  }, [selectedPath, explorerChildren, root]);

  const [targetDir, setTargetDir] = useState(defaultDir);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setTargetDir(defaultDir);
      setName("");
      setBusy(false);
      const t = window.setTimeout(() => nameRef.current?.focus(), 60);
      return () => window.clearTimeout(t);
    }
  }, [open, defaultDir, kind]);

  const confirm = useCallback(async () => {
    const trimmedName = name.trim();
    const trimmedDir = targetDir.trim() || root;
    if (!trimmedName) return;
    if (trimmedName.includes("/") || trimmedName.includes("\\")) {
      onError?.("Invalid name", "Name must not contain / or \\");
      return;
    }
    setBusy(true);
    const api = useExplorer.getState();
    const res = isFile
      ? await api.createFile(trimmedDir, trimmedName)
      : await api.createFolder(trimmedDir, trimmedName);
    setBusy(false);
    if (res.ok) {
      onInfo?.(`${isFile ? "Created file" : "Created folder"} ${trimmedName} in ${trimmedDir}`);
      onOpenChange(false);
      // ensure refresh so newly created entry animates in and is visible
      void api.refresh(trimmedDir);
    } else {
      onError?.(`${isFile ? "Create file" : "Create folder"} failed`, res.error);
    }
  }, [name, targetDir, root, isFile, onInfo, onError, onOpenChange]);

  const onBrowse = useCallback(async () => {
    try {
      const picked = await openFolderDialog();
      if (picked) setTargetDir(picked);
    } catch {
      /* ignore */
    }
  }, []);

  const fullPreview = `${targetDir.replace(/\/+$/, "")}/${name.trim() || (isFile ? "untitled" : "new-folder")}`;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={isFile ? "New File" : "New Folder"}
      description={isFile ? "Create a new file in the selected directory." : "Create a new folder in the selected directory."}
      size="md"
    >
      <div className="create-dialog" onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void confirm(); } }}>
        <div className="create-dialog__field">
          <label className="create-dialog__label">Location</label>
          <div className="create-dialog__row">
            <Input
              value={targetDir}
              onChange={(e) => setTargetDir(e.target.value)}
              placeholder={root}
              leadingIcon="folder"
              inputSize="md"
            />
            <Button variant="secondary" size="md" icon="folder-open" onClick={onBrowse} type="button">
              Browse…
            </Button>
          </div>
          <span className="create-dialog__hint">Current: <code>{root}</code> {selectedPath ? <>· selected: <code>{selectedPath}</code></> : null}</span>
        </div>
        <div className="create-dialog__field">
          <label className="create-dialog__label">{isFile ? "File name" : "Folder name"}</label>
          <Input
            ref={nameRef as any}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={isFile ? "untitled.md" : "new-folder"}
            leadingIcon={isFile ? "file-plus" : "folder-plus"}
            inputSize="md"
          />
          <span className="create-dialog__preview" title={fullPreview}>{fullPreview}</span>
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
        <Button
          variant="primary"
          icon={isFile ? "file-plus" : "folder-plus"}
          onClick={() => { void confirm(); }}
          disabled={!name.trim() || busy}
        >
          {isFile ? "Create file" : "Create folder"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/* ---------- Tree ---------- */
type Slice = {
  expanded: Set<string>;
  children: Map<string, ExplorerNode[]>;
  loading: Set<string>;
  errors: Map<string, string>;
  showHidden: boolean;
  selectedPath: string | null;
  history: string[];
  historyIndex: number;
};

interface TreeContextMenuProps {
  onRequestCreate: (kind: "file" | "folder", targetDir: string) => void;
  onInfo?: (m: string) => void;
  onError?: (m: string, d?: string) => void;
  onOpen?: (p: string) => void;
}

function Tree({
  root, onOpen, activePath, slice, onRequestCreate, onInfo, onError,
}: {
  root: string;
  onOpen: (path: string) => void;
  activePath?: string;
  slice: Slice;
} & TreeContextMenuProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);

  // Flatten visible rows in DOM order. Used for keyboard navigation.
  const visibleRows = (): HTMLButtonElement[] => {
    const root = containerRef.current;
    if (!root) return [];
    const all = Array.from(root.querySelectorAll<HTMLButtonElement>(".tree-item"));
    return all.filter((r) => r.offsetParent !== null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const rows = visibleRows();
    if (rows.length === 0) return;
    const idx = rows.findIndex((r) => r === document.activeElement);
    const fallback = focusedPath
      ? rows.findIndex((r) => r.dataset.path === focusedPath)
      : -1;
    const cur = rows[idx >= 0 ? idx : fallback] ?? rows[0];
    const curPath = cur?.dataset.path ?? null;
    const curIsDir = cur?.dataset.dir === "true";
    const curExpanded = cur?.getAttribute("aria-expanded") === "true";
    const moveTo = (row: HTMLButtonElement) => { row.focus(); setFocusedPath(row.dataset.path ?? null); };

    if (e.altKey && e.key === "ArrowUp") {
      e.preventDefault();
      if (root !== "/") void useExplorer.getState().goUp();
    } else if (e.key === "ArrowDown" && idx < rows.length - 1) {
      e.preventDefault(); moveTo(rows[idx + 1]);
    } else if (e.key === "ArrowUp" && idx > 0) {
      e.preventDefault(); moveTo(rows[idx - 1]);
    } else if (e.key === "ArrowRight" && curIsDir && !curExpanded && curPath) {
      e.preventDefault(); void useExplorer.getState().toggleDir(curPath);
    } else if (e.key === "ArrowRight" && curIsDir && curExpanded && cur) {
      e.preventDefault();
      const first = cur.nextElementSibling?.querySelector<HTMLButtonElement>(".tree-item");
      if (first) moveTo(first);
    } else if (e.key === "ArrowLeft" && curIsDir && curExpanded && curPath) {
      e.preventDefault(); void useExplorer.getState().toggleDir(curPath);
    } else if (e.key === "ArrowLeft" && cur) {
      const parentRow = cur.parentElement?.previousElementSibling as HTMLElement | null;
      if (parentRow?.classList.contains("tree-item")) {
        e.preventDefault(); moveTo(parentRow as HTMLButtonElement);
      }
    } else if ((e.key === "Enter" || e.key === " ") && cur) {
      e.preventDefault(); cur.click();
    } else if (e.key === "Home" && rows.length) {
      e.preventDefault(); moveTo(rows[0]);
    } else if (e.key === "End" && rows.length) {
      e.preventDefault(); moveTo(rows[rows.length - 1]);
    }
  };

  return (
    <div
      className="explorer__tree"
      ref={containerRef}
      onKeyDown={onKeyDown}
      role="presentation"
    >
      <ExplorerContextMenu
        path={root}
        isDir
        name={splitPath(root).pop() || root}
        onRequestCreate={onRequestCreate}
        onInfo={onInfo}
        onError={onError}
        onOpen={onOpen}
      >
        <div
          className="tree-root"
          role="treeitem"
          aria-level={1}
          aria-selected={activePath === root}
          data-path={root}
          data-dir="true"
          tabIndex={focusedPath === null ? 0 : -1}
          onFocus={() => setFocusedPath(root)}
        >
          <Icon name="folder-open" size={14} />
          <span className="tree-root__name">{splitPath(root).pop() || root}</span>
        </div>
      </ExplorerContextMenu>
      <TreeErrorBoundary>
        <div role="tree" aria-label="Files" tabIndex={-1} style={{ outline: "none" }}>
          <TreeLevel
            dirPath={root}
            depth={1}
            onOpen={onOpen}
            activePath={activePath}
            slice={slice}
            onRequestCreate={onRequestCreate}
            onInfo={onInfo}
            onError={onError}
          />
        </div>
      </TreeErrorBoundary>
    </div>
  );
}

function TreeLevel({
  dirPath, depth, onOpen, activePath, slice, onRequestCreate, onInfo, onError,
}: {
  dirPath: string;
  depth: number;
  onOpen: (p: string) => void;
  activePath?: string;
  slice: Slice;
} & TreeContextMenuProps) {
  const raw = slice.children.get(dirPath);
  const isLoading = slice.loading.has(dirPath);
  const error = slice.errors.get(dirPath);
  const expanded = slice.expanded.has(dirPath);

  const visible = useMemo(() => {
    if (!raw) return undefined;
    return raw.filter((n) => slice.showHidden || !n.name.startsWith("."));
  }, [raw, slice.showHidden]);

  /* Kick off the lazy read_dir from an effect, not from render. Calling it
     during render is a side effect React is free to run twice (StrictMode)
     or discard, and it re-fired on every re-render while the request was in
     flight — a request storm on a slow directory. */
  const needsLoad = expanded && !raw && !isLoading && !error;
  useEffect(() => {
    if (needsLoad) void useExplorer.getState().loadChildren(dirPath);
  }, [needsLoad, dirPath]);

  if (!expanded) return null;

  if (isLoading && (!visible || visible.length === 0)) return <LoadingGroup />;

  if (error && (!visible || visible.length === 0)) {
    return <div role="group"><div className="tree-empty">{error}</div></div>;
  }

  if (visible && visible.length === 0) {
    return (
      <ExplorerContextMenu
        path={dirPath}
        isDir
        name={splitPath(dirPath).pop() || dirPath}
        onRequestCreate={onRequestCreate}
        onInfo={onInfo}
        onError={onError}
        onOpen={onOpen}
      >
        <div role="group">
          <div className="tree-empty" data-path={dirPath} data-dir="true">empty folder — right-click to add</div>
        </div>
      </ExplorerContextMenu>
    );
  }

  if (!visible) {
    // The effect above requested the listing; show the loader until it lands.
    return <LoadingGroup />;
  }

  return (
    <div role="group">
      {visible.map((node) => (
        <TreeRow
          key={node.path}
          node={node}
          depth={depth}
          onOpen={onOpen}
          activePath={activePath}
          slice={slice}
          onRequestCreate={onRequestCreate}
          onInfo={onInfo}
          onError={onError}
        />
      ))}
    </div>
  );
}

function TreeRow({
  node, depth, onOpen, activePath, slice, onRequestCreate, onInfo, onError,
}: {
  node: ExplorerNode;
  depth: number;
  onOpen: (p: string) => void;
  activePath?: string;
  slice: Slice;
} & TreeContextMenuProps) {
  const isExpanded = slice.expanded.has(node.path);
  const isActive = activePath === node.path;
  const isSelected = slice.selectedPath === node.path;
  const isHidden = node.name.startsWith(".");
  /* Indent is capped against the row's own width, not just the depth.
     At 12px a level a deeply nested file had more indent than the pane
     was wide, so the name started past the right edge and was clipped
     away entirely. `min()` resolves the percentage against the row, so
     the cap follows the pane as it is resized — half the row is always
     left for the name. */
  const indent = `min(${(depth - 1) * 12 + 6}px, 50%)`;

  const onClick = () => {
    useExplorer.getState().setSelected(node.path);
    if (node.isDir) {
      void useExplorer.getState().toggleDir(node.path);
    } else {
      onOpen(node.path);
    }
  };

  return (
    <>
      <ExplorerContextMenu
        path={node.path}
        isDir={node.isDir}
        name={node.name}
        onRequestCreate={onRequestCreate}
        onInfo={onInfo}
        onError={onError}
        onOpen={onOpen}
      >
        <button
          type="button"
          className={`tree-item ${isHidden ? "tree-item--hidden" : ""} ${isActive ? "is-active" : ""}`}
          role="treeitem"
          aria-level={depth}
          aria-expanded={node.isDir ? isExpanded : undefined}
          aria-selected={isSelected}
          data-path={node.path}
          data-dir={node.isDir ? "true" : "false"}
          tabIndex={-1}
          style={{ paddingLeft: indent }}
          onClick={onClick}
        >
          <span className="tree-item__chev" data-icon="chevron-right" aria-hidden>
            <Icon name="chevron-right" size={12} />
          </span>
          <span className="tree-item__icon" aria-hidden>
            {node.isDir ? (
              <Icon name="folder" size={14} />
            ) : (
              <FileIcon name={node.name} />
            )}
          </span>
          <span className="tree-item__name">{node.name}</span>
        </button>
      </ExplorerContextMenu>
      {node.isDir && isExpanded && (
        <div className="tree-group" role="group">
          <TreeLevel
            dirPath={node.path}
            depth={depth + 1}
            onOpen={onOpen}
            activePath={activePath}
            slice={slice}
            onRequestCreate={onRequestCreate}
            onInfo={onInfo}
            onError={onError}
          />
        </div>
      )}
    </>
  );
}

function FileIcon({ name }: { name: string }) {
  let lid: string | undefined;
  try {
    lid = langIdOf(name);
  } catch {
    lid = undefined;
  }
  if (lid) {
    // LangLogo itself is now defensive; still guard with error boundary fallback
    try {
      return <LangLogo langId={lid} size={14} />;
    } catch {
      return <Icon name="file" size={14} />;
    }
  }
  return <Icon name="file" size={14} />;
}

/* ---------- helpers ---------- */
function LoadingGroup() {
  return (
    <div role="group">
      <div className="loader-row">
        <Loader size={14} />
        <span>read_dir…</span>
      </div>
    </div>
  );
}
