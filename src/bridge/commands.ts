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

/* ---------- FS ---------- */
export const readFile  = (path: string) => call<string>("read_file", { path });
export const writeFile = (path: string, contents: string) => call<WriteReceipt>("write_file", { path, contents });
export const stat      = (path: string) => call<FileStat>("stat", { path });
export const readDir   = (path: string) => call<DirEntry[]>("read_dir", { path });
export const renamePath= (from: string, to: string) => call<void>("rename", { from, to });
export const deletePath= (path: string) => call<void>("delete", { path });

/* ---------- Mock FS (browser only) ---------- */
const MEMORY_FS = new Map<string, string>([
  ["/welcome.md", `# Welcome to sparkEditor\n\nThis is a *demo* document.\n\n\`\`\`ts\nconst hello = "world";\n\`\`\`\n`],
  ["/notes.md",   `# Notes\n\n- Markdown surface\n- Rich text\n- Code`],
  ["/hello.ts",   `// hello.ts\nexport const greet = (n: string) => \`Hello, \${n}!\`;\n`],
  ["/README.md",  `# sparkEditor\n\nUnifies markdown, rich text, and code in one window.`],
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
    case "stat":
      return { path: args.path, isFile: MEMORY_FS.has(args.path), isDir: false, size: 0, mtime: new Date().toISOString() } as unknown as T;
    case "read_dir":
      return [
        { name: "welcome.md",  isFile: true, isDir: false },
        { name: "notes.md",    isFile: true, isDir: false },
        { name: "hello.ts",    isFile: true, isDir: false },
        { name: "README.md",   isFile: true, isDir: false },
      ] as unknown as T;
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
