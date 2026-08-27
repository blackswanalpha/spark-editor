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
import { readDir, createFile as bridgeCreateFile } from "@bridge/commands";
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
  expanded: Set<string>;
  children: Map<string, ExplorerNode[]>;
  loading: Set<string>;
  errors: Map<string, string>;
  selectedPath: string | null;
  showHidden: boolean;
}

/* ---------- Actions ---------- */
interface Actions {
  setRoot: (path: string | null) => Promise<void>;
  toggleShowHidden: () => void;
  setExpanded: (path: string, expanded: boolean) => Promise<void>;
  toggleDir: (path: string) => Promise<void>;
  loadChildren: (path: string) => Promise<void>;
  refresh: (path?: string) => Promise<void>;
  collapseAll: () => void;
  setSelected: (path: string | null) => void;
  createFile: (parentDir: string, name: string) => Promise<CreateFileResult>;
  subscribeToFileChanges: () => Promise<() => void>;
}

/* ---------- Module-scope: keep the latest unlisten so the
   subscribe action is idempotent (App.tsx calls it once). */
let _fileChangeUnlisten: (() => void) | null = null;

/* ---------- Helpers ---------- */
function joinPath(parent: string, name: string): string {
  if (parent.endsWith("/") || parent.endsWith("\\")) return parent + name;
  return parent + "/" + name;
}

function isUnder(child: string, ancestor: string): boolean {
  return child === ancestor || child.startsWith(ancestor + "/") || child.startsWith(ancestor + "\\");
}

/* ---------- Store ---------- */
export const useExplorer = create<State & Actions>((set, get) => ({
  root: null,
  expanded: new Set<string>(),
  children: new Map<string, ExplorerNode[]>(),
  loading: new Set<string>(),
  errors: new Map<string, string>(),
  selectedPath: null,
  showHidden: false,

  setRoot: async (path) => {
    if (path === null) {
      set({
        root: null,
        expanded: new Set<string>(),
        children: new Map<string, ExplorerNode[]>(),
        loading: new Set<string>(),
        errors: new Map<string, string>(),
        selectedPath: null,
      });
      return;
    }
    set({
      root: path,
      expanded: new Set<string>([path]),
      children: new Map<string, ExplorerNode[]>(),
      loading: new Set<string>(),
      errors: new Map<string, string>(),
    });
    await get().loadChildren(path);
  },

  toggleShowHidden: () => {
    set({
      showHidden: !get().showHidden,
      children: new Map<string, ExplorerNode[]>(),
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
    const loading = new Set(get().loading);
    const errors = new Map(get().errors);
    loading.add(path);
    errors.delete(path);
    set({ loading, errors });
    try {
      const entries = await readDir(path);
      const nodes: ExplorerNode[] = (entries ?? []).map((e) => ({
        name: e.name,
        path: joinPath(path, e.name),
        isDir: e.isDir,
        isFile: e.isFile,
      }));
      const children = new Map(get().children);
      const loadingAfter = new Set(get().loading);
      children.set(path, nodes);
      loadingAfter.delete(path);
      set({ children, loading: loadingAfter });
    } catch (err: any) {
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
    set({ expanded: new Set<string>() });
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
    // If the parent is currently cached (i.e. expanded earlier), splice in.
    const cached = get().children.get(parentDir);
    if (cached) {
      if (!cached.some((n) => n.name === name)) {
        const children = new Map(get().children);
        children.set(parentDir, [
          ...cached,
          { name, path: fullPath, isDir: false, isFile: true },
        ]);
        set({ children });
      }
    } else {
      // Otherwise trigger a refresh so the next expansion picks it up.
      void get().refresh(parentDir);
    }
    return { ok: true };
  },

  subscribeToFileChanges: async () => {
    if (_fileChangeUnlisten) return _fileChangeUnlisten;
    _fileChangeUnlisten = await on<FileChangeEvent>("file:changed", (evt) => {
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
    return _fileChangeUnlisten;
  },
}));

/* ---------- Helpers ---------- */
export const activeExplorerRoot = (): string | null => useExplorer.getState().root;
