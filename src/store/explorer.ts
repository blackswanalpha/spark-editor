/* ============================================================
   sparkEditor · src/store/explorer.ts
   File explorer store. Holds the root folder, expanded
   directories, lazily-cached children, and selection state
   for the sidebar tree.  Backed by zustand + immer.
   Independent from the document store — the explorer is a
   different concern with its own lifecycle.
   ============================================================ */
import { create } from "zustand";
import { enableMapSet } from "immer";
import { readDir, createFile as bridgeCreateFile, mkdir as bridgeMkdir } from "@bridge/commands";
import { on } from "@bridge/events";

enableMapSet();

/* ---------- Types ---------- */
export interface ExplorerNode {
  name: string;
  path: string;        // absolute, joined from parent + name
  isDir: boolean;
  isFile: boolean;
}

export interface FileChangeEvent {
  kind: "created" | "removed" | "renamed" | "modified";
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
}

/* ---------- Actions ---------- */
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
  subscribeToFileChanges: () => Promise<() => void>;
}

/* ---------- Module-scope: monotonic load generation.
   Bumped on every setRoot() so any in-flight loadChildren from a
   previous root can detect it's stale and drop its result. */
let _loadGen = 0;

/* ---------- Helpers ---------- */
function normalizeRoot(path: string): string {
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
      console.info("[explorer] setRoot", { from: get().root, to: null });
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
    console.info("[explorer] setRoot", { from: get().root === normalized ? normalized : "(previous)", to: normalized, isSameRoot });
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
      selectedPath: null,
    });
    pushHistory(get, set as any, parent);
    console.info("[explorer] goUp", { from: current, to: parent });
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
      selectedPath: null,
    });
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
      selectedPath: null,
    });
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
      if (myGen !== _loadGen) return;
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
      if (myGen !== _loadGen) return;
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

  subscribeToFileChanges: async () => {
    // Each call returns its own unlisten so callers can manage
    // their own subscription lifecycle (no module-level caching).
    const unlisten = await on<FileChangeEvent>("file:changed", (evt) => {
      const state = get();
      const root = state.root;
      if (!root || !evt?.path) return;
      // Find the closest known ancestor of evt.path (or evt.from for renames)
      // that exists in our children cache, and refresh it.
      const candidate = evt.kind === "renamed" ? (evt.from ?? evt.path) : evt.path;
      const ancestors: string[] = [];
      let cursor = candidate;
      // Walk up until we hit root or run out.
      const sepIdx = Math.max(cursor.lastIndexOf("/"), cursor.lastIndexOf("\\"));
      while (sepIdx > 0) {
        cursor = cursor.slice(0, sepIdx);
        if (state.children.has(cursor) || cursor === root) {
          ancestors.push(cursor);
          break;
        }
        const next = Math.max(cursor.lastIndexOf("/"), cursor.lastIndexOf("\\"));
        if (next <= 0) break;
        cursor = cursor.slice(0, next);
      }
      // Walk up: if none cached yet, but the event is directly under root, refresh root.
      if (ancestors.length === 0 && isUnder(candidate, root)) {
        ancestors.push(root);
      }
      for (const a of ancestors) {
        void state.loadChildren(a);
      }
    });
    return unlisten;
  },
}));

/* ---------- Helpers ---------- */
export const activeExplorerRoot = (): string | null => useExplorer.getState().root;
