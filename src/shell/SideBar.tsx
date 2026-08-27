/* ============================================================
   sparkEditor · src/shell/SideBar.tsx
   Left pane: folder explorer (Files) + recents tab.
   The explorer mirrors designlabs/labs/explorer.html:
     - Lazy read_dir per directory
     - A11Y-004 tree-view keyboard contract
       (↑↓ move, → expand / first child, ← collapse / parent,
        Enter / Space activate, Home / End first / last).
     - Toolbar (new file / refresh / collapse / show hidden)
     - Loader row, empty / error row
   ============================================================ */
import { useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "@motion/index";
import { Icon } from "@ui/Icon";
import { Spinner as Loader } from "@ui/Loader";
import { useExplorer, type ExplorerNode } from "@store/explorer";
import { splitPath } from "@bridge/commands";
import "./SideBar.css";

export interface RecentsEntry { path: string; name: string; }

export interface SideBarProps {
  recents: RecentsEntry[];
  onOpen: (path: string) => void;
  activePath?: string;
  onRequestOpenFolder?: () => void;
  onInfo?: (message: string) => void;
  onError?: (message: string, detail?: string) => void;
}

export function SideBar({
  recents, onOpen, activePath, onRequestOpenFolder, onInfo, onError,
}: SideBarProps) {
  const [tab, setTab] = useState<"files" | "recents">("files");
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
      onInfo={onInfo}
      onError={onError}
    />
  );
}

/* ---------- Explorer (toolbar + tree) ---------- */
function Explorer({
  root, onOpen, activePath, onInfo, onError,
}: {
  root: string;
  onOpen: (path: string) => void;
  activePath?: string;
  onInfo?: (message: string) => void;
  onError?: (message: string, detail?: string) => void;
}) {
  // Single map selector — re-renders only when the relevant slice changes.
  const slice = useExplorer((s) => ({
    expanded: s.expanded,
    children: s.children,
    loading: s.loading,
    errors: s.errors,
    showHidden: s.showHidden,
    selectedPath: s.selectedPath,
  }));

  const segments = splitPath(root);
  const title = segments[segments.length - 1] || root;

  const onNewFile = async () => {
    const raw = window.prompt(`New file in ${root}`, "untitled.md");
    if (!raw) return;
    const name = raw.trim();
    if (!name) return;
    const res = await useExplorer.getState().createFile(root, name);
    if (res.ok) onInfo?.(`Created ${name}`);
    else onError?.("Create file failed", res.error);
  };

  return (
    <div className="explorer" aria-label="File explorer">
      <div className="explorer__header">
        <span className="explorer__title" title={root}>{title}</span>
        <span className="explorer__actions">
          <button
            type="button"
            className="icon-btn"
            aria-label="New file"
            title="New file"
            onClick={onNewFile}
          >
            <Icon name="plus" size={14} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Refresh explorer"
            title="Refresh"
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
            aria-label="Show hidden files"
            aria-pressed={slice.showHidden}
            title="Show hidden"
            onClick={() => useExplorer.getState().toggleShowHidden()}
          >
            <Icon name="file" size={14} />
          </button>
        </span>
      </div>

      <Tree
        root={root}
        onOpen={onOpen}
        activePath={activePath}
        slice={slice}
      />
    </div>
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
};

function Tree({
  root, onOpen, activePath, slice,
}: {
  root: string;
  onOpen: (path: string) => void;
  activePath?: string;
  slice: Slice;
}) {
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

    if (e.key === "ArrowDown" && idx < rows.length - 1) {
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
      <div role="tree" aria-label="Files" tabIndex={-1} style={{ outline: "none" }}>
        <TreeLevel
          dirPath={root}
          depth={1}
          onOpen={onOpen}
          activePath={activePath}
          slice={slice}
        />
      </div>
    </div>
  );
}

function TreeLevel({
  dirPath, depth, onOpen, activePath, slice,
}: {
  dirPath: string;
  depth: number;
  onOpen: (p: string) => void;
  activePath?: string;
  slice: Slice;
}) {
  const raw = slice.children.get(dirPath);
  const isLoading = slice.loading.has(dirPath);
  const error = slice.errors.get(dirPath);
  const expanded = slice.expanded.has(dirPath);

  const visible = useMemo(() => {
    if (!raw) return undefined;
    return raw.filter((n) => slice.showHidden || !n.name.startsWith("."));
  }, [raw, slice.showHidden]);

  if (!expanded) return null;

  if (isLoading && (!visible || visible.length === 0)) return <LoadingGroup />;

  if (error && (!visible || visible.length === 0)) {
    return <div role="group"><div className="tree-empty">{error}</div></div>;
  }

  if (visible && visible.length === 0) {
    return <div role="group"><div className="tree-empty">empty folder</div></div>;
  }

  if (!visible) {
    // Trigger load if not already.
    void useExplorer.getState().loadChildren(dirPath);
    return <LoadingGroup />;
  }

  return (
    <div role="group">
      {visible.map((node) => (
        <TreeRow key={node.path} node={node} depth={depth} onOpen={onOpen} activePath={activePath} slice={slice} />
      ))}
    </div>
  );
}

function TreeRow({
  node, depth, onOpen, activePath, slice,
}: {
  node: ExplorerNode;
  depth: number;
  onOpen: (p: string) => void;
  activePath?: string;
  slice: Slice;
}) {
  const isExpanded = slice.expanded.has(node.path);
  const isActive = activePath === node.path;
  const isSelected = slice.selectedPath === node.path;
  const isHidden = node.name.startsWith(".");
  const indent = (depth - 1) * 12 + 6;

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
          <Icon name={node.isDir ? "folder" : pickFileIcon(node.name)} size={14} />
        </span>
        <span className="tree-item__name">{node.name}</span>
      </button>
      {node.isDir && isExpanded && (
        <div className="tree-group" role="group">
          <TreeLevel
            dirPath={node.path}
            depth={depth + 1}
            onOpen={onOpen}
            activePath={activePath}
            slice={slice}
          />
        </div>
      )}
    </>
  );
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

function pickFileIcon(name: string): string {
  if (/\.(md|markdown)$/i.test(name)) return "mode-markdown";
  if (/\.(ts|tsx|js|jsx|json|html|css|scss|py|rs|go|java|c|cpp|h|hpp|sh|yaml|yml|toml)$/i.test(name)) return "file-code";
  return "file";
}
