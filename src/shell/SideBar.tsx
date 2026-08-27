/* ============================================================
   sparkEditor · src/shell/SideBar.tsx
   Left pane: file explorer + tabs + recents.
   ============================================================ */
import { useState } from "react";
import { Icon } from "@ui/Icon";
import { motion, AnimatePresence } from "@motion/index";
import "./SideBar.css";

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileEntry[];
}

export interface RecentsEntry { path: string; name: string; }

export function SideBar({
  root, recents, onOpen, activePath,
}: {
  root?: FileEntry[];
  recents: RecentsEntry[];
  onOpen: (path: string) => void;
  activePath?: string;
}) {
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
          <span>Files</span>
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
              {root?.length ? (
                <Tree entries={root} depth={0} onOpen={onOpen} activePath={activePath} />
              ) : (
                <div className="sidebar__empty">No folder open. Use File → Open Folder.</div>
              )}
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

function Tree({
  entries, depth, onOpen, activePath,
}: { entries: FileEntry[]; depth: number; onOpen: (p: string) => void; activePath?: string }) {
  return (
    <ul className="tree" role="tree">
      {entries.map((e) => (
        <TreeNode key={e.path} entry={e} depth={depth} onOpen={onOpen} activePath={activePath} />
      ))}
    </ul>
  );
}

function TreeNode({
  entry, depth, onOpen, activePath,
}: { entry: FileEntry; depth: number; onOpen: (p: string) => void; activePath?: string }) {
  const [open, setOpen] = useState(depth < 1);
  const isActive = activePath === entry.path;

  if (entry.isDir) {
    return (
      <li role="treeitem" aria-expanded={open}>
        <button
          className="tree__row"
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name="chevron-right" size={12} className={`tree__chev ${open ? "is-open" : ""}`} />
          <Icon name="folder" size={14} className="tree__icon" />
          <span className="tree__name">{entry.name}</span>
        </button>
        <AnimatePresence initial={false}>
          {open && entry.children && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.12, ease: [0.2, 0.6, 0.3, 1] }}
              style={{ overflow: "hidden" }}
            >
              <Tree entries={entry.children} depth={depth + 1} onOpen={onOpen} activePath={activePath} />
            </motion.div>
          )}
        </AnimatePresence>
      </li>
    );
  }

  return (
    <li role="treeitem">
      <button
        className={`tree__row ${isActive ? "is-active" : ""}`}
        style={{ paddingLeft: 8 + depth * 12 + 14 }}
        onClick={() => onOpen(entry.path)}
      >
        <Icon name={pickFileIcon(entry.name)} size={14} className="tree__icon" />
        <span className="tree__name">{entry.name}</span>
      </button>
    </li>
  );
}

function pickFileIcon(name: string): string {
  if (/\.(md|markdown)$/i.test(name)) return "mode-markdown";
  if (/\.(ts|tsx|js|jsx|json|html|css|scss|py|rs|go|java|c|cpp|h|hpp|sh|yaml|yml|toml)$/i.test(name)) return "file-code";
  return "file";
}
