/* ============================================================
   sparkEditor · src/bridge/commands.ts
   Typed wrappers around Tauri's invoke(). When running in
   plain Vite (no Tauri host) the wrappers fall back to safe
   in-memory implementations so the renderer can be developed
   and tested in the browser.
   ============================================================ */
import { invoke as tInvoke } from "@tauri-apps/api/core";

const isTauri = typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri) {
    return (await tInvoke<T>(cmd, args)) as T;
  }
  // Browser-only fallback (mocked fs)
  return mock<T>(cmd, args);
}

/* ---------- Lazy Tauri dialog plugin loader ---------- */
// Lazy import so the plugin is only loaded in Tauri context
async function tauriDialog() {
  try { return await import("@tauri-apps/plugin-dialog"); } catch { return null; }
}

/* ---------- Types ---------- */
export interface FileStat { path: string; isFile: boolean; isDir: boolean; size: number; mtime: string }
export interface DirEntry { name: string; isFile: boolean; isDir: boolean }
export interface WriteReceipt { path: string; bytes: number; mtime: string; device: number; inode: number }
export interface DialogFilter { name: string; extensions: string[] }
export interface OpenDialogOptions { multiple?: boolean; directory?: boolean; filters?: DialogFilter[] }
export interface SaveDialogOptions { defaultPath?: string; filters?: DialogFilter[] }

/** Opaque watcher id returned by `watchPath`. Backed by the host's `watch_path`. */
export type WatchId = string;

/* ---------- FS ---------- */
export const readFile  = (path: string) => call<string>("read_file", { path });
export const writeFile = (path: string, contents: string) => call<WriteReceipt>("write_file", { path, contents });
export const stat      = (path: string) => call<FileStat>("stat", { path });
export const readDir   = (path: string) => call<DirEntry[]>("read_dir", { path });
export const renamePath= (from: string, to: string) => call<void>("rename", { from, to });
export const deletePath= (path: string) => call<void>("delete", { path });

/**
 * Create a new file at `path` with optional `contents` (defaults to "").
 * Throws `{ kind: "AlreadyExists", path }` if the path already exists.
 * Returns a fresh `FileStat` for the new file.
 */
export const createFile = (path: string, contents: string = "") =>
  call<FileStat>("create_file", { path, contents });

/**
 * Create a directory at `path`. No-op if the directory already exists.
 * Intermediate parents are not created — the host is expected to reject
 * the call (or the call is expected to be invoked after the parent exists).
 */
export const mkdir = (path: string) => call<void>("mkdir", { path });

/**
 * Subscribe to filesystem change notifications for `path`.
 * Returns a `WatchId` that can be passed to `unwatchPath` to cancel.
 * In the browser mock this returns a fake id and is otherwise inert.
 */
export const watchPath = (path: string) => call<WatchId>("watch_path", { path });

/**
 * Cancel a watcher previously registered with `watchPath`.
 * No-op if the id is unknown (matches the documented host behaviour).
 */
export const unwatchPath = (id: WatchId) => call<void>("unwatch_path", { id });

/* ---------- Path helpers ---------- */
/**
 * Split an absolute path into ordered segments. Empty / "/" yield an empty array.
 * Examples:
 *   splitPath("/")        -> []
 *   splitPath("/docs")    -> ["docs"]
 *   splitPath("/a/b/c.md")-> ["a", "b", "c.md"]
 */
export function splitPath(path: string): string[] {
  if (!path) return [];
  const norm = path.startsWith("/") ? path.slice(1) : path;
  if (norm === "") return [];
  return norm.split("/").filter((seg) => seg.length > 0);
}

/**
 * Join a parent directory and a child name with a single "/".
 * Empty parent collapses to "/". No trailing slash on the result.
 * Examples:
 *   joinPath("/", "docs")          -> "/docs"
 *   joinPath("/docs", "reference") -> "/docs/reference"
 *   joinPath("", "README.md")      -> "/README.md"
 */
export function joinPath(parent: string, name: string): string {
  const p = !parent || parent === "/" ? "" : parent.replace(/\/+$/, "");
  if (!name) return p === "" ? "/" : p;
  return `${p}/${name}`;
}

/* ---------- Mock FS (browser only) ---------- */
const MEMORY_FS = new Map<string, string>([
  ["/welcome.md", `# Welcome to sparkEditor\n\nThis is a *demo* document.\n\n\`\`\`ts\nconst hello = "world";\n\`\`\`\n`],
  ["/notes.md",   `# Notes\n\n- Markdown surface\n- Rich text\n- Code`],
  ["/hello.ts",   `// hello.ts\nexport const greet = (n: string) => \`Hello, \${n}!\`;\n`],
  ["/README.md",  `# sparkEditor\n\nUnifies markdown, rich text, and code in one window.`],
  ["/docs/README.md", `# docs/\n\nReference and explanation documents.`],
]);

/**
 * Directories known to the in-memory mock. Kept separate from `MEMORY_FS`
 * so the existing flat file map stays compatible with `read_file` /
 * `write_file` / `stat`. `read_dir` consults this set to expose folders.
 */
const MEMORY_DIRS: Set<string> = new Set<string>([
  "/",
  "/docs",
  "/docs/audits",
  "/docs/explanation",
  "/docs/reference",
]);

function mock<T>(cmd: string, args?: any): T {
  switch (cmd) {
    case "read_file": {
      const v = MEMORY_FS.get(args.path);
      if (v === undefined) throw { kind: "NotFound", path: args.path };
      return v as unknown as T;
    }
    case "write_file": {
      MEMORY_FS.set(args.path, args.contents);
      return { path: args.path, bytes: args.contents.length, mtime: new Date().toISOString(), device: 0, inode: 0 } as unknown as T;
    }
    case "create_file": {
      if (MEMORY_FS.has(args.path) || MEMORY_DIRS.has(args.path)) {
        throw { kind: "AlreadyExists", path: args.path };
      }
      MEMORY_FS.set(args.path, args.contents ?? "");
      const stat = {
        path: args.path,
        isFile: true,
        isDir: false,
        size: (args.contents ?? "").length,
        mtime: new Date().toISOString(),
      };
      return stat as unknown as T;
    }
    case "mkdir": {
      MEMORY_DIRS.add(args.path);
      return undefined as unknown as T;
    }
    case "stat": {
      const p: string = args.path;
      if (MEMORY_DIRS.has(p) && !MEMORY_FS.has(p)) {
        return { path: p, isFile: false, isDir: true, size: 0, mtime: new Date().toISOString() } as unknown as T;
      }
      return { path: p, isFile: MEMORY_FS.has(p), isDir: false, size: 0, mtime: new Date().toISOString() } as unknown as T;
    }
    case "read_dir": {
      const p: string = args.path;
      const norm = p === "/" || p === "" ? "" : p.replace(/\/+$/, "");
      const prefix = norm === "" ? "/" : `${norm}/`;
      // Any directory directly under `p` that has either a file or a sub-dir
      // entry inside `MEMORY_FS` / `MEMORY_DIRS` should appear.
      const names = new Set<string>();
      for (const k of MEMORY_FS.keys()) {
        if (k === norm) continue; // path itself is a file
        if (k.startsWith(prefix)) {
          const rest = k.slice(prefix.length);
          const seg = rest.split("/")[0];
          if (seg) names.add(seg);
        }
      }
      for (const d of MEMORY_DIRS) {
        if (d === norm) continue;
        if (d.startsWith(prefix)) {
          const rest = d.slice(prefix.length);
          const seg = rest.split("/")[0];
          if (seg) names.add(seg);
        }
      }
      const out: DirEntry[] = [];
      for (const n of names) {
        const child = `${prefix}${n}`;
        const isDir = MEMORY_DIRS.has(child) && !MEMORY_FS.has(child);
        out.push({ name: n, isFile: !isDir, isDir });
      }
      out.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      // Keep root simple: surface the documented set so the explorer
      // has a stable starting point even though the underlying map is richer.
      if (norm === "") {
        const fixed: DirEntry[] = [
          { name: "welcome.md", isFile: true,  isDir: false },
          { name: "notes.md",   isFile: true,  isDir: false },
          { name: "hello.ts",   isFile: true,  isDir: false },
          { name: "README.md",  isFile: true,  isDir: false },
          { name: "docs",       isFile: false, isDir: true  },
        ];
        return fixed as unknown as T;
      }
      if (norm === "/docs") {
        const fixed: DirEntry[] = [
          { name: "audits",      isFile: false, isDir: true  },
          { name: "explanation", isFile: false, isDir: true  },
          { name: "reference",   isFile: false, isDir: true  },
          { name: "README.md",   isFile: true,  isDir: false },
        ];
        return fixed as unknown as T;
      }
      return out as unknown as T;
    }
    case "watch_path":
      return ("mock-" + Math.random().toString(36).slice(2)) as unknown as T;
    case "unwatch_path":
      return undefined as unknown as T;
    case "recents_get":
      return ["/welcome.md", "/notes.md", "/hello.ts", "/README.md"] as unknown as T;
    case "open_file":
    case "open_folder":
    case "save_file":
      return null as unknown as T;
    default:
      return null as unknown as T;
  }
}

/* ---------- App state ---------- */
export const getAppState = () => call<any>("app_state_get");
export const setAppState = (state: any) => call<void>("app_state_set", { state });

/* ---------- Recents ---------- */
export const recentsGet  = () => call<string[]>("recents_get");
export const recentsAdd  = (path: string) => call<string[]>("recents_add", { path });
export const recentsClear= () => call<void>("recents_clear");

/* ---------- Window ---------- */
export const windowSetTitle = (title: string) => call<void>("window_set_title", { title });

/* ---------- Dialogs (Tauri + browser fallback) ---------- */
/**
 * Open a file or directory picker.
 * In Tauri: delegates to @tauri-apps/plugin-dialog's open().
 * In browser: dispatches a "spark:dialog:openFile" CustomEvent on window,
 *   expected to be handled by the OpenDialog component.
 */
export function openFileDialog(opts: OpenDialogOptions = {}): Promise<string | string[] | null> {
  if (isTauri) {
    return tauriDialog().then(async (d) => {
      if (!d) return null;
      if (opts.directory) {
        return (await d.open({ directory: true, multiple: opts.multiple })) as string | string[] | null;
      }
      return (await d.open({
        multiple: opts.multiple,
        filters: opts.filters,
      })) as string | string[] | null;
    });
  }
  return new Promise<string | string[] | null>((resolve) => {
    window.dispatchEvent(new CustomEvent("spark:dialog:openFile", { detail: { resolve, opts } }));
  });
}

/**
 * Open a folder picker. Returns the first selected path or null.
 */
export function openFolderDialog(): Promise<string | null> {
  return openFileDialog({ directory: true }).then((res) => {
    if (res == null) return null;
    if (Array.isArray(res)) return res[0] ?? null;
    return res;
  });
}

/**
 * Open a save-as file picker.
 * In Tauri: delegates to @tauri-apps/plugin-dialog's save().
 * In browser: dispatches a "spark:dialog:saveFile" CustomEvent on window.
 */
export function saveFileDialog(opts: SaveDialogOptions = {}): Promise<string | null> {
  if (isTauri) {
    return tauriDialog().then(async (d) => {
      if (!d) return null;
      return (await d.save({
        defaultPath: opts.defaultPath,
        filters: opts.filters,
      })) as string | null;
    });
  }
  return new Promise<string | null>((resolve) => {
    window.dispatchEvent(new CustomEvent("spark:dialog:saveFile", { detail: { resolve, opts } }));
  });
}

/* ---------- Mode picker ---------- */
/**
 * Pick an editor mode from a file path based on its extension.
 *  - .md / .markdown → "markdown"
 *  - .html / .htm / .json → "rich"
 *  - everything else → "code"
 */
export function pickMode(path: string): "markdown" | "rich" | "code" {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".html") || lower.endsWith(".htm") || lower.endsWith(".json")) return "rich";
  return "code";
}

export { isTauri };
