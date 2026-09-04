/* ============================================================
   sparkBook · src/store/explorer.ts
   File explorer store. Holds the root folder, expanded
   directories, lazily-cached children, and selection state
   for the sidebar tree.  Backed by zustand + immer.
   Independent from the document store — the explorer is a
   different concern with its own lifecycle.
   ============================================================ */
import { create } from "zustand";
import { enableMapSet } from "immer";
import {
  readDir,
  createFile as bridgeCreateFile,
  mkdir as bridgeMkdir,
  renamePath as bridgeRename,
  deletePath as bridgeDelete,
  copyPath as bridgeCopy,
  openInTerminal as bridgeOpenInTerminal,
  revealInOS as bridgeRevealInOS,
  watchPath as bridgeWatchPath,
  unwatchPath as bridgeUnwatchPath,
} from "@bridge/commands";
import { on } from "@bridge/events";

enableMapSet();

/* ---------- Types ---------- */
export interface ExplorerNode {
  name: string;
  path: string;        // absolute, joined from parent + name
  isDir: boolean;
  isFile: boolean;
}

/**
 * The directory a path stands for: itself when the tree knows it as a
 * directory — listed, or named as one in its parent's listing — and its
 * parent otherwise. Checking only for a listing treated every collapsed
 * folder as a file, so terminals meant for it opened in its parent.
 */
export function directoryOf(children: Map<string, ExplorerNode[]>, path: string): string {
  if (children.has(path)) return path;
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const parent = idx > 0 ? path.slice(0, idx) || "/" : "/";
  const entry = children.get(parent)?.find((n) => n.path === path);
  return entry?.isDir ? path : parent;
}

export interface FileChangeEvent {
  /** "bulk" carries no path: the host coalesced more changes than it was
   *  willing to send individually, and every cached listing is suspect. */
  kind: "created" | "removed" | "renamed" | "modified" | "bulk";
  path: string;
  from?: string;       // for "renamed"
  isDir?: boolean;
}

export interface CreateFileResult {
  ok: boolean;
  error?: string;
}

/* ---------- State ---------- */
interface State {
  root: string | null;
  explicitRoot: boolean;
  expanded: Set<string>;
  children: Map<string, ExplorerNode[]>;
  loading: Set<string>;
  errors: Map<string, string>;
  selectedPath: string | null;
  showHidden: boolean;
  history: string[];
  historyIndex: number;
  /** Active cut/copy clipboard entry. `pasteInto` consumes it. */
  clipboard: ClipboardEntry | null;
}

/* ---------- Actions ---------- */
export type ClipboardOp = "copy" | "cut";
export interface ClipboardEntry { op: ClipboardOp; path: string; }

interface Actions {
  setRoot: (path: string | null) => Promise<void>;
  goUp: () => Promise<void>;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  toggleShowHidden: () => void;
  setExpanded: (path: string, expanded: boolean) => Promise<void>;
  toggleDir: (path: string) => Promise<void>;
  loadChildren: (path: string) => Promise<void>;
  refresh: (path?: string) => Promise<void>;
  collapseAll: () => void;
  setSelected: (path: string | null) => void;
  createFile: (parentDir: string, name: string) => Promise<CreateFileResult>;
  createFolder: (parentDir: string, name: string) => Promise<CreateFileResult>;
  renamePath: (path: string, newName: string) => Promise<CreateFileResult>;
  /** Move a file/folder to a fully-qualified `to` path (may be in a
   *  different parent directory than the source). */
  moveTo: (from: string, to: string) => Promise<CreateFileResult>;
  deletePath: (path: string) => Promise<CreateFileResult>;
  copyTo: (from: string, to: string) => Promise<CreateFileResult>;
  /** Mark `path` for cut or copy. The actual filesystem copy/delete
   *  happens on `pasteInto(targetDir)`. */
  setClipboard: (entry: ClipboardEntry | null) => void;
  pasteInto: (targetDir: string) => Promise<CreateFileResult>;
  openInTerminal: (cwd: string) => Promise<CreateFileResult>;
  revealInOS: (path: string) => Promise<CreateFileResult>;
  /** Currently a thin wrapper around `renamePath` — a future PR
   *  can layer on language-aware refactors (move symbol, etc.). */
  refactor: (path: string, newName: string) => Promise<CreateFileResult>;
  subscribeToFileChanges: () => Promise<() => void>;
}

/* ---------- Module-scope: monotonic load generation.
   Bumped on every setRoot() so any in-flight loadChildren from a
   previous root can detect it's stale and drop its result. */
let _loadGen = 0;

/* ---------- Module-scope: the host watcher for the current root.
   Exactly one watch is live at a time; retargeting it is the only way
   the tree learns about changes made outside the app. */
let _watchId: string | null = null;
let _watchSeq = 0;

/** Point the host watcher at `root` (or stop it when null). */
async function retargetWatch(root: string | null): Promise<void> {
  const seq = ++_watchSeq;
  const previous = _watchId;
  _watchId = null;
  if (previous) {
    await bridgeUnwatchPath(previous).catch(() => {});
  }
  if (root === null) return;
  try {
    const id = await bridgeWatchPath(root);
    // A newer retarget started while this one was in flight — its watch
    // is the one that should survive, so drop ours rather than clobber it.
    if (seq !== _watchSeq) {
      await bridgeUnwatchPath(id).catch(() => {});
      return;
    }
    _watchId = id;
  } catch {
    // Watching is an enhancement: without it the tree still works, it
    // just needs a manual refresh. Never fail navigation over it.
    _watchId = null;
  }
}

/** Stop watching. Exposed for teardown in tests and on app shutdown. */
export async function stopWatching(): Promise<void> {
  await retargetWatch(null);
}

/* ---------- Helpers ---------- */
export function normalizeRoot(path: string): string {
  if (!path) return "/";
  let p = String(path).trim();
  // Strip surrounding quotes (some dialogs return quoted paths).
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1);
  }
  // Strip file:// URI scheme (case-insensitive).
  p = p.replace(/^file:\/\//i, "");
  // On Windows the file:///C:/foo becomes /C:/foo; strip the leading slash before drive letter.
  p = p.replace(/^\/([A-Za-z]:)/, "$1");
  // Decode percent-encoded characters.
  try { p = decodeURIComponent(p); } catch { /* leave as-is if malformed */ }
  // Normalize all backslashes to forward slashes.
  p = p.replace(/\\/g, "/");
  // Strip trailing slashes (but keep a single "/" for root).
  p = p.replace(/\/+$/, "");
  if (p === "") return "/";
  // Ensure leading slash.
  if (!p.startsWith("/")) p = "/" + p;
  return p;
}

function joinPath(parent: string, name: string): string {
  if (parent.endsWith("/") || parent.endsWith("\\")) return parent + name;
  return parent + "/" + name;
}

function isUnder(child: string, ancestor: string): boolean {
  return child === ancestor || child.startsWith(ancestor + "/") || child.startsWith(ancestor + "\\");
}

/** Return the parent directory of `path`, or `null` if `path` is the root "/". */
function parentOf(path: string): string | null {
  const norm = normalizeRoot(path);
  if (norm === "/") return null;
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  if (idx <= 0) return "/";
  return norm.slice(0, idx) || "/";
}

/** Keep a selection only while it remains inside `root`. */
function keepSelection(selected: string | null, root: string): string | null {
  return selected && isUnder(selected, root) ? selected : null;
}

/** Remove `path` from the loading set without touching anything else. */
function clearLoading(
  get: () => State & Actions,
  set: (p: Partial<State>) => void,
  path: string,
) {
  const loading = get().loading;
  if (!loading.has(path)) return;
  const next = new Set(loading);
  next.delete(path);
  set({ loading: next });
}

/* ---------- internal: push history (truncate forward) ---------- */
function pushHistory(get: () => State & Actions, set: (p: Partial<State>) => void, path: string) {
  const { history, historyIndex } = get();
  if (historyIndex >= 0 && history[historyIndex] === path) return;
  const truncated = historyIndex >= 0 ? history.slice(0, historyIndex + 1) : [];
  truncated.push(path);
  // keep reasonable cap (100)
  const capped = truncated.length > 100 ? truncated.slice(truncated.length - 100) : truncated;
  set({ history: capped, historyIndex: capped.length - 1 });
}

/* ---------- internal: find a non-colliding destination for paste/copy ---------- */
/** True when `p` names an existing file or directory.
 *  The Tauri host returns Err(NotFound) for a missing path; the browser
 *  mock returns a stat with both flags false. Both mean "missing". */
async function pathExists(p: string): Promise<boolean> {
  try {
    const { stat } = await import("@bridge/commands");
    const s = (await stat(p)) as { isFile?: boolean; isDir?: boolean };
    return Boolean(s?.isFile || s?.isDir);
  } catch {
    return false;
  }
}

async function nextAvailableDest(targetDir: string, name: string): Promise<string> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 0; n < 1000; n++) {
    const candidate = joinPath(targetDir, n === 0 ? `${stem} copy${ext}` : `${stem} copy (${n})${ext}`);
    if (!(await pathExists(candidate))) return candidate;
  }
  // Fallback: timestamped name.
  return joinPath(targetDir, `${stem} copy ${Date.now()}${ext}`);
}

/* ---------- Store ---------- */
export const useExplorer = create<State & Actions>((set, get) => ({
  root: null,
  explicitRoot: false,
  expanded: new Set<string>(),
  children: new Map<string, ExplorerNode[]>(),
  loading: new Set<string>(),
  errors: new Map<string, string>(),
  selectedPath: null,
  showHidden: false,
  history: [],
  historyIndex: -1,
  clipboard: null,

  setRoot: async (path) => {
    _loadGen++;
    if (path === null) {
      set({
        root: null,
        explicitRoot: false,
        expanded: new Set<string>(),
        children: new Map<string, ExplorerNode[]>(),
        loading: new Set<string>(),
        errors: new Map<string, string>(),
        selectedPath: null,
        history: [],
        historyIndex: -1,
      });
      void retargetWatch(null);
      window.dispatchEvent(new CustomEvent("spark:explorer:root-changed", { detail: { root: null } }));
      return;
    }
    const normalized = normalizeRoot(path);
    const isSameRoot = get().root === normalized;
    set({
      root: normalized,
      explicitRoot: true,
      expanded: new Set<string>([normalized]),
      children: isSameRoot ? new Map<string, ExplorerNode[]>(get().children) : new Map<string, ExplorerNode[]>(),
      loading: new Set<string>(),
      errors: new Map<string, string>(),
      selectedPath: null,
    });
    pushHistory(get, set as any, normalized);
    if (!isSameRoot) void retargetWatch(normalized);
    window.dispatchEvent(new CustomEvent("spark:explorer:root-changed", { detail: { root: normalized } }));
    await get().loadChildren(normalized);
  },

  goUp: async () => {
    _loadGen++;
    const current = get().root;
    if (!current) return;
    const parent = parentOf(current);
    if (!parent) return;
    const prevExpanded = get().expanded;
    const prevChildren = get().children;
    const keptExpanded = new Set<string>([parent, current]);
    for (const e of prevExpanded) {
      if (e !== current && isUnder(e, parent)) keptExpanded.add(e);
    }
    const keptChildren = new Map<string, ExplorerNode[]>();
    for (const [k, v] of prevChildren) {
      if (isUnder(k, parent)) keptChildren.set(k, v);
    }
    set({
      root: parent,
      explicitRoot: true,
      expanded: keptExpanded,
      children: keptChildren,
      loading: new Set<string>(),
      errors: new Map<string, string>(),
      // Keep the selection when it is still inside the new root — the
      // user navigated up, they did not deselect.
      selectedPath: keepSelection(get().selectedPath, parent),
    });
    pushHistory(get, set as any, parent);
    void retargetWatch(parent);
    window.dispatchEvent(new CustomEvent("spark:explorer:root-changed", { detail: { root: parent } }));
    await get().loadChildren(parent);
  },

  goBack: async () => {
    const { history, historyIndex } = get();
    if (historyIndex <= 0) return;
    const target = history[historyIndex - 1];
    _loadGen++;
    const prevExpanded = get().expanded;
    const prevChildren = get().children;
    const keptExpanded = new Set<string>([target]);
    for (const e of prevExpanded) {
      if (isUnder(e, target)) keptExpanded.add(e);
    }
    const keptChildren = new Map<string, ExplorerNode[]>();
    for (const [k, v] of prevChildren) {
      if (isUnder(k, target)) keptChildren.set(k, v);
    }
    set({
      root: target,
      explicitRoot: true,
      historyIndex: historyIndex - 1,
      expanded: keptExpanded,
      children: keptChildren,
      loading: new Set<string>(),
      errors: new Map<string, string>(),
      selectedPath: keepSelection(get().selectedPath, target),
    });
    void retargetWatch(target);
    window.dispatchEvent(new CustomEvent("spark:explorer:root-changed", { detail: { root: target } }));
    await get().loadChildren(target);
  },

  goForward: async () => {
    const { history, historyIndex } = get();
    if (historyIndex < 0 || historyIndex >= history.length - 1) return;
    const target = history[historyIndex + 1];
    _loadGen++;
    const prevExpanded = get().expanded;
    const prevChildren = get().children;
    const keptExpanded = new Set<string>([target]);
    for (const e of prevExpanded) {
      if (isUnder(e, target)) keptExpanded.add(e);
    }
    const keptChildren = new Map<string, ExplorerNode[]>();
    for (const [k, v] of prevChildren) {
      if (isUnder(k, target)) keptChildren.set(k, v);
    }
    set({
      root: target,
      explicitRoot: true,
      historyIndex: historyIndex + 1,
      expanded: keptExpanded,
      children: keptChildren,
      loading: new Set<string>(),
      errors: new Map<string, string>(),
      selectedPath: keepSelection(get().selectedPath, target),
    });
    void retargetWatch(target);
    window.dispatchEvent(new CustomEvent("spark:explorer:root-changed", { detail: { root: target } }));
    await get().loadChildren(target);
  },

  canGoBack: () => get().historyIndex > 0,
  canGoForward: () => {
    const { history, historyIndex } = get();
    return historyIndex >= 0 && historyIndex < history.length - 1;
  },

  toggleShowHidden: () => {
    set({
      showHidden: !get().showHidden,
    });
  },

  setExpanded: async (path, expanded) => {
    const next = new Set(get().expanded);
    if (expanded) next.add(path);
    else next.delete(path);
    set({ expanded: next });
    if (expanded && !get().children.has(path)) {
      await get().loadChildren(path);
    }
  },

  toggleDir: async (path) => {
    const wasExpanded = get().expanded.has(path);
    await get().setExpanded(path, !wasExpanded);
  },

  loadChildren: async (path) => {
    const myGen = _loadGen;
    const loading = new Set(get().loading);
    const errors = new Map(get().errors);
    loading.add(path);
    errors.delete(path);
    set({ loading, errors });
    try {
      const entries = await readDir(path);
      if (myGen !== _loadGen) {
        // Root changed under us — drop the result, but still clear the
        // loading flag or this row keeps a spinner that never resolves.
        clearLoading(get, set, path);
        return;
      }
      const nodes: ExplorerNode[] = (entries ?? []).map((e: any) => {
        const isDir = Boolean(e.isDir ?? e.is_dir);
        const isFileRaw = e.isFile ?? e.is_file;
        const isFile = isFileRaw !== undefined ? Boolean(isFileRaw) : !isDir;
        return {
          name: e.name,
          path: joinPath(path, e.name),
          isDir,
          isFile,
        };
      });
      const children = new Map(get().children);
      const loadingAfter = new Set(get().loading);
      children.set(path, nodes);
      loadingAfter.delete(path);
      set({ children, loading: loadingAfter });
    } catch (err: any) {
      if (myGen !== _loadGen) {
        clearLoading(get, set, path);
        return;
      }
      const loadingAfter = new Set(get().loading);
      const errorsAfter = new Map(get().errors);
      loadingAfter.delete(path);
      errorsAfter.set(path, String(err?.message ?? err));
      set({ loading: loadingAfter, errors: errorsAfter });
    }
  },

  refresh: async (path) => {
    const root = get().root;
    if (!root) return;
    const target = path ?? root;
    // Collect this directory and all currently-expanded descendants.
    const queue: string[] = [target];
    const visited = new Set<string>([target]);
    const allExpanded = get().expanded;
    // BFS over expanded entries; we only recurse into ones under `target`.
    for (const exp of allExpanded) {
      if (isUnder(exp, target) && !visited.has(exp)) {
        visited.add(exp);
        queue.push(exp);
      }
    }
    for (const p of queue) {
      await get().loadChildren(p);
    }
  },

  collapseAll: () => {
    const root = get().root;
    // Keep the root expanded so the top-level children remain accessible.
    // Clearing everything (including the root) leaves the tree empty with
    // no way to re-expand — the user would perceive this as "cannot access folders".
    set({ expanded: root ? new Set<string>([root]) : new Set<string>() });
  },

  setSelected: (path) => {
    set({ selectedPath: path });
  },

  createFile: async (parentDir, name) => {
    const fullPath = joinPath(parentDir, name);
    try {
      await bridgeCreateFile(fullPath, "");
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
    const cached = get().children.get(parentDir);
    if (cached) {
      if (!cached.some((n) => n.name === name)) {
        const children = new Map(get().children);
        children.set(parentDir, [
          ...cached,
          { name, path: fullPath, isDir: false, isFile: true },
        ]);
        // keep sorted: dirs first, then alpha
        const sorted = children.get(parentDir)!.slice().sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        children.set(parentDir, sorted);
        // ensure parent is expanded so new file is visible immediately
        const expanded = new Set(get().expanded);
        expanded.add(parentDir);
        set({ children, expanded });
      }
    } else {
      void get().refresh(parentDir);
    }
    return { ok: true };
  },

  createFolder: async (parentDir, name) => {
    const fullPath = joinPath(parentDir, name);
    try {
      await bridgeMkdir(fullPath);
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
    const cached = get().children.get(parentDir);
    if (cached) {
      if (!cached.some((n) => n.name === name)) {
        const children = new Map(get().children);
        children.set(parentDir, [
          ...cached,
          { name, path: fullPath, isDir: true, isFile: false },
        ]);
        const sorted = children.get(parentDir)!.slice().sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        children.set(parentDir, sorted);
        const expanded = new Set(get().expanded);
        expanded.add(parentDir);
        set({ children, expanded });
      }
    } else {
      void get().refresh(parentDir);
    }
    // also ensure newly created folder is cached as empty
    if (!get().children.has(fullPath)) {
      const children = new Map(get().children);
      children.set(fullPath, []);
      set({ children });
    }
    return { ok: true };
  },

  renamePath: async (path, newName) => {
    if (!newName || newName.includes("/") || newName.includes("\\")) {
      return { ok: false, error: "Invalid name" };
    }
    const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    const parent = idx > 0 ? path.slice(0, idx) : "/";
    const to = joinPath(parent, newName);
    if (to === path) return { ok: true };
    try {
      await bridgeRename(path, to);
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
    // Eagerly update cache: rewrite children's name/path for the renamed entry,
    // and drop any cached children for the old path (it's gone).
    const children = new Map(get().children);
    // 1) the parent's listing
    const siblings = children.get(parent);
    if (siblings) {
      const replaced = siblings.map((n) =>
        n.path === path ? { ...n, name: newName, path: to } : n,
      );
      const sorted = replaced.slice().sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      children.set(parent, sorted);
    }
    // 2) cached children of the entry itself (if it was a dir): remap keys
    const remapped = new Map<string, ExplorerNode[]>();
    for (const [k, v] of children) {
      if (k === path) {
        // old cached children of renamed dir are now at `to`
        remapped.set(to, v);
      } else if (k.startsWith(path + "/")) {
        remapped.set(to + k.slice(path.length), v);
      } else {
        remapped.set(k, v);
      }
    }
    // 3) expanded set: same key remap
    const expanded = new Set<string>();
    for (const e of get().expanded) {
      if (e === path) expanded.add(to);
      else if (e.startsWith(path + "/")) expanded.add(to + e.slice(path.length));
      else expanded.add(e);
    }
    // 4) selection moves too
    const sel = get().selectedPath;
    const selected = sel === path ? to : (sel && sel.startsWith(path + "/") ? to + sel.slice(path.length) : sel);
    set({ children: remapped, expanded, selectedPath: selected });
    return { ok: true };
  },

  moveTo: async (from, to) => {
    if (from === to) return { ok: true };
    try {
      await bridgeRename(from, to);
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
    const srcIdx = Math.max(from.lastIndexOf("/"), from.lastIndexOf("\\"));
    const dstIdx = Math.max(to.lastIndexOf("/"), to.lastIndexOf("\\"));
    const srcParent = srcIdx > 0 ? from.slice(0, srcIdx) : "/";
    const dstParent = dstIdx > 0 ? to.slice(0, dstIdx) : "/";
    const newName = to.slice(dstIdx + 1);
    const children = new Map(get().children);
    // 1) drop the source entry from its parent's listing
    const srcSiblings = children.get(srcParent);
    if (srcSiblings) {
      children.set(srcParent, srcSiblings.filter((n) => n.path !== from));
    }
    // 2) add the new entry to the dest parent's listing (if cached)
    const destSiblings = children.get(dstParent);
    if (destSiblings && !destSiblings.some((n) => n.path === to)) {
      const srcEntry = srcSiblings?.find((n) => n.path === from);
      const isDir = srcEntry?.isDir ?? false;
      const isFile = srcEntry?.isFile ?? !isDir;
      const next = [...destSiblings, { name: newName, path: to, isDir, isFile }];
      next.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      children.set(dstParent, next);
    }
    // 3) remap cached children keys
    const remapped = new Map<string, ExplorerNode[]>();
    for (const [k, v] of children) {
      if (k === from) remapped.set(to, v);
      else if (k.startsWith(from + "/")) remapped.set(to + k.slice(from.length), v);
      else remapped.set(k, v);
    }
    // 4) remap expanded set
    const expanded = new Set<string>();
    for (const e of get().expanded) {
      if (e === from) expanded.add(to);
      else if (e.startsWith(from + "/")) expanded.add(to + e.slice(from.length));
      else expanded.add(e);
    }
    // 5) ensure dest parent is expanded so the moved entry is visible
    expanded.add(dstParent);
    // 6) selection moves if it pointed inside the moved subtree
    const sel = get().selectedPath;
    const selected = sel === from ? to : (sel && sel.startsWith(from + "/") ? to + sel.slice(from.length) : sel);
    set({ children: remapped, expanded, selectedPath: selected });
    return { ok: true };
  },

  deletePath: async (path) => {
    try {
      await bridgeDelete(path);
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
    const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    const parent = idx > 0 ? path.slice(0, idx) : "/";
    // 1) remove from parent's listing
    const children = new Map(get().children);
    const siblings = children.get(parent);
    if (siblings) {
      children.set(parent, siblings.filter((n) => n.path !== path));
    }
    // 2) drop any cached subtree
    const trimmed = new Map<string, ExplorerNode[]>();
    for (const [k, v] of children) {
      if (k === path || k.startsWith(path + "/")) continue;
      trimmed.set(k, v);
    }
    // 3) collapse/delete from expanded
    const expanded = new Set<string>();
    for (const e of get().expanded) {
      if (e === path || e.startsWith(path + "/")) continue;
      expanded.add(e);
    }
    const sel = get().selectedPath;
    const selected = sel === path || (sel && sel.startsWith(path + "/")) ? null : sel;
    set({ children: trimmed, expanded, selectedPath: selected });
    return { ok: true };
  },

  copyTo: async (from, to) => {
    try {
      await bridgeCopy(from, to);
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
    const idx = Math.max(to.lastIndexOf("/"), to.lastIndexOf("\\"));
    const destParent = idx > 0 ? to.slice(0, idx) : "/";
    const newName = to.slice(idx + 1);
    // Eagerly add to the dest parent's listing if cached.
    const children = new Map(get().children);
    const siblings = children.get(destParent);
    if (siblings) {
      // Look the source up in ITS OWN parent's listing. Searching the
      // destination's listing only works for same-directory duplicates;
      // a cross-directory copy found nothing and defaulted to isDir:false,
      // so copied folders showed up in the tree as files.
      const srcIdx = Math.max(from.lastIndexOf("/"), from.lastIndexOf("\\"));
      const srcParent = srcIdx > 0 ? from.slice(0, srcIdx) : "/";
      const srcEntry =
        children.get(srcParent)?.find((n) => n.path === from) ??
        siblings.find((n) => n.path === from);
      const isDir = srcEntry?.isDir ?? false;
      const isFile = srcEntry?.isFile ?? !isDir;
      if (!siblings.some((n) => n.path === to)) {
        const next = [...siblings, { name: newName, path: to, isDir, isFile }];
        next.sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        children.set(destParent, next);
        const expanded = new Set(get().expanded);
        expanded.add(destParent);
        set({ children, expanded });
      }
    } else {
      void get().loadChildren(destParent);
    }
    return { ok: true };
  },

  setClipboard: (entry) => {
    set({ clipboard: entry });
  },

  pasteInto: async (targetDir) => {
    const clip = get().clipboard;
    if (!clip) return { ok: false, error: "Clipboard is empty" };
    const idx = Math.max(clip.path.lastIndexOf("/"), clip.path.lastIndexOf("\\"));
    const name = idx >= 0 ? clip.path.slice(idx + 1) : clip.path;
    const currentParent = idx > 0 ? clip.path.slice(0, idx) : "/";
    // No-op cut into the same directory.
    if (clip.op === "cut" && currentParent === targetDir) {
      set({ clipboard: null });
      return { ok: true };
    }
    const to = joinPath(targetDir, name);
    if (to === clip.path) {
      // Same path == no-op for cut; for copy we still want a duplicate.
      if (clip.op === "cut") set({ clipboard: null });
      else {
        const dest = await nextAvailableDest(targetDir, name);
        return get().copyTo(clip.path, dest);
      }
      return { ok: true };
    }
    let res: CreateFileResult;
    if (clip.op === "cut") {
      res = await get().moveTo(clip.path, to);
      if (res.ok) set({ clipboard: null });
    } else {
      // Keep the original name when the destination is free; only fall
      // back to "name copy" on a real collision. Always suffixing meant
      // pasting into an empty folder produced "README copy.md".
      const dest = (await pathExists(to)) ? await nextAvailableDest(targetDir, name) : to;
      res = await get().copyTo(clip.path, dest);
    }
    return res;
  },

  openInTerminal: async (cwd) => {
    try {
      await bridgeOpenInTerminal(cwd);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  },

  revealInOS: async (path) => {
    try {
      await bridgeRevealInOS(path);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  },

  refactor: async (path, newName) => {
    // For now, refactor == rename. A future PR can layer language-aware
    // refactors on top (rename symbol, etc.).
    return get().renamePath(path, newName);
  },

  subscribeToFileChanges: async () => {
    // Each call returns its own unlisten so callers can manage
    // their own subscription lifecycle (no module-level caching).
    const unlisten = await on<FileChangeEvent>("file:changed", (evt) => {
      const state = get();
      const root = state.root;
      if (!root || !evt) return;

      // Too much changed at once to name it. Re-read what is on screen
      // rather than trusting listings taken before the storm.
      if (evt.kind === "bulk") {
        for (const dir of state.children.keys()) void state.loadChildren(dir);
        if (!state.children.has(root)) void state.loadChildren(root);
        return;
      }
      if (!evt.path) return;
      // Find the closest known ancestor of evt.path (or evt.from for renames)
      // that exists in our children cache, and refresh it.
      const candidate = evt.kind === "renamed" ? (evt.from ?? evt.path) : evt.path;

      // Walk up one level at a time to the nearest cached directory. The
      // previous version computed the separator index once, before the
      // loop, and then reused it as a slice length against a string that
      // kept shrinking — so it skipped levels and often refreshed the
      // wrong directory (or none).
      const targets = new Set<string>();
      let cursor = candidate;
      for (let depth = 0; depth < 64; depth++) {
        const sep = Math.max(cursor.lastIndexOf("/"), cursor.lastIndexOf("\\"));
        if (sep <= 0) break;
        cursor = cursor.slice(0, sep) || "/";
        if (state.children.has(cursor) || cursor === root) {
          targets.add(cursor);
          break;
        }
        if (cursor === "/") break;
      }

      // A rename moves an entry between two directories; both listings are
      // now stale, so refresh the destination's parent as well.
      if (evt.kind === "renamed" && evt.from && evt.path !== evt.from) {
        const sep = Math.max(evt.path.lastIndexOf("/"), evt.path.lastIndexOf("\\"));
        const destParent = sep > 0 ? evt.path.slice(0, sep) : "/";
        if (state.children.has(destParent)) targets.add(destParent);
      }

      if (targets.size === 0 && isUnder(candidate, root)) targets.add(root);
      for (const a of targets) {
        void state.loadChildren(a);
      }
    });
    return unlisten;
  },
}));

/* ---------- Helpers ---------- */
export const activeExplorerRoot = (): string | null => useExplorer.getState().root;
