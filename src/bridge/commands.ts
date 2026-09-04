/* ============================================================
   sparkBook · src/bridge/commands.ts
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
    try {
      return (await tInvoke<T>(cmd, args)) as T;
    } catch (e: unknown) {
      // WebKitGTK on Linux often logs "IPC custom protocol failed → postMessage fallback"
      // and may surface as TypeError: Load failed or "Couldn't find callback id" after
      // a reload/HMR while Rust is still processing. Fall back to the in-memory mock
      // so the UI remains usable in `vite` dev without a hard crash, and avoid
      // spamming unhandled rejections. Real Tauri errors still propagate after the
      // fallback check below.
      const msg = String((e as Error)?.message ?? e ?? "");
      if (msg.includes("Load failed") || msg.includes("callback id") || msg.includes("custom protocol")) {
        console.warn(`[bridge] invoke "${cmd}" fell back to mock (Tauri IPC unavailable):`, msg);
        return mock<T>(cmd, args);
      }
      throw e;
    }
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
/** Read a file as base64 (binary-safe).  Falls back to text→base64 in browser mock. */
export const readFileBase64 = (path: string) => call<string>("read_file_base64", { path });
export const readFileBinary = (path: string) => readFileBase64(path);
export const writeFile = (path: string, contents: string) => call<WriteReceipt>("write_file", { path, contents });
/** Write raw bytes given as a base64 string. Used by the image editor and
    any surface whose document is binary rather than text. */
export const writeFileBase64 = (path: string, base64: string) =>
  call<WriteReceipt>("write_file_base64", { path, contents: base64 });
export const stat      = (path: string) => call<FileStat>("stat", { path });
export const readDir   = (path: string) => call<DirEntry[]>("read_dir", { path });
export const renamePath= (from: string, to: string) => call<void>("rename", { from, to });
export const deletePath= (path: string) => call<void>("delete", { path });
export const copyPath  = (from: string, to: string) => call<void>("copy", { from, to });

/** Open the host's terminal emulator rooted at `cwd`. No-op in browser mock. */
export const openInTerminal = (cwd: string) => call<void>("open_in_terminal", { cwd });
/** Reveal `path` in the OS file manager (Finder/Explorer/Nautilus). */
export const revealInOS = (path: string) => call<void>("reveal_in_folder", { path });
/** Open a file with the OS default application. */
export const openWithOS = (path: string) => call<void>("open_with_os", { path });

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
  ["/welcome.md", `# Welcome to sparkBook\n\nThis is a *demo* document.\n\n\`\`\`ts\nconst hello = "world";\n\`\`\`\n`],
  ["/notes.md",   `# Notes\n\n- Markdown surface\n- Rich text\n- Code`],
  ["/hello.ts",   `// hello.ts\nexport const greet = (n: string) => \`Hello, \${n}!\`;\n`],
  ["/README.md",  `# sparkBook\n\nUnifies markdown, rich text, and code in one window.`],
  ["/docs/README.md", `# docs/\n\nReference and explanation documents.`],
  ["/demo/index.html", `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="./style.css"><title>Demo</title></head><body><h1>Hello HTML preview</h1><p>This file is rendered via <code>HtmlPreview</code> without a server.</p><script src="./app.js"></script></body></html>`],
  ["/demo/style.css", `body{font-family:Inter,sans-serif;padding:24px;color:#222}h1{color:#6c5ce7}`],
  ["/demo/app.js", `console.log("bundled js works"); document.body.insertAdjacentHTML("beforeend","<p><em>js bundled ✓</em></p>")`],
  ["/demo/logo.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80"><rect x="10" y="10" width="180" height="60" rx="10" fill="#6c5ce7"/><text x="100" y="45" text-anchor="middle" fill="white" font-family="Inter" font-size="16">spark svg</text></svg>`],
  ["/sample.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600"><rect x="80" y="80" width="220" height="140" rx="12" fill="#6c5ce7" stroke="#2d3436" stroke-width="2"/><circle cx="520" cy="180" r="70" fill="#00cec9" stroke="#2d3436" stroke-width="2"/><text x="80" y="300" fill="#2d3436" font-size="20" font-family="Inter">Editable SVG — select, drag, recolour</text></svg>`],
]);

/**
 * Binary fixtures for the mock host. Kept apart from `MEMORY_FS` because
 * `read_file_base64` must return these payloads verbatim rather than
 * base64-encoding a text string. They give the image and PDF surfaces
 * something real to open when the renderer runs under plain `vite`.
 */
const MEMORY_BIN = new Map<string, string>([
  ["/sample.png",
    "iVBORw0KGgoAAAANSUhEUgAAAPAAAADwCAYAAAA+VemSAAADIklEQVR42u3TQQ0AIAwEwTrBGX55QHBU8NBfM4/NGbiJ" +
    "MW+qb3GWOufkAAtgASyABbAAFsAAC2ABLIAFsAAWwAALYAEsgAWwABbAAAtgASyABbAAFsACGGABLIAFsAAWwAIYYAEs" +
    "gAWwABbAAhhgASyABbAAFsACGGABLIAFsAAWwAJYAAMsgAWwABbAAlgAAyyABbAAFsACWAADLIAFsAAWwAJYAAPs5AAL" +
    "YAEsgAWwABbAAAtgASyABbAAFsAAC2ABLIAFsAAWwAALYAEsgAWwABbAcnKABbAAFsACWAALYIAFsAAWwAJYAAtggAWw" +
    "ABbAAlgAC2CABbAAFsACWAALYAEMsAAWwAJYAAtgAQywABbAAlgAC2ABDLAAFsACWAALYAEMsAAWwAJYAAtgASyAARbA" +
    "AlgAC2ABLIABFsACWAALYAEsgAEWwAJYAAtgASyAAXZygAWwABbAAlgAC2CABbAAFsACWAALYIAFsAAWwAJYAAtggAWw" +
    "ABbAAlgAC2ABDLAAFsACWAALYAEMsAAWwAJYAAtgAQywABbAAlgAq1ymWrf/qG0ODrAAFsACWAALYAEMsAAWwAJYAAtg" +
    "AQywABbAAlgAC2ABDLAAFsACWAALYAEsgAEWwAJYAAtgASyAARbAAlgAC2ABLIABFsACWAALYAEsgAEWwAJYAAtgASyA" +
    "BTDAAlgAC2ABLIAFMMACWAALYAEsgAUwwAJYAAtgASyABTDATg6wABbAAlgAC2ABDLAAFsACWAALYAEMsAAWwAJYAAtg" +
    "AQywABbAAlgAC2ABLIABFsACWAALYAEsgAEWwAJYAAtgASyAARbAAlgAC2ABLIABFsACWAALYAEsgAUwwAJYAAtgASyA" +
    "BTDAAlgAC2ABLIAFMMACWAALYAEsgAUwwAJYAAtgASyABbAABlgAC2ABLIAFsAAGWAALYAEsgAWwAAZYAAtgASyABbAA" +
    "lpMDLIAFsAAWwAJYAAMsgAWwABbAAlgAAyyABbAAFsACWAADLIAFsAAWwAJYAMvBARbAAlgAC2ABLIABFsACWAALYAEs" +
    "gAEWwAJYAAtglXtym/2aWdeeNgAAAABJRU5ErkJggg=="],
  ["/sample.pdf",
    "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwg" +
    "L1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2Ug" +
    "L1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA0MjAgMzAwXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAg" +
    "UiA+PiA+PiAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCAxNjEgPj4Kc3RyZWFtCkJU" +
    "IC9GMSAyMiBUZiA0OCAyMTAgVGQgKHNwYXJrQm9vayBQREYgc2FtcGxlKSBUaiBFVApCVCAvRjEgMTIgVGYgNDggMTc4" +
    "IFRkIChTY3JvbGwsIHpvb20sIHNlYXJjaCBhbmQgc2VsZWN0IHRoaXMgdGV4dC4pIFRqIEVUCjAuMTIgMC4zNyAwLjgy" +
    "IHJnIDQ4IDYwIDMyMCA5MCByZSBmCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvRm9udCAvU3VidHlw" +
    "ZSAvVHlwZTEgL0Jhc2VGb250IC9IZWx2ZXRpY2EgPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAK" +
    "MDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0" +
    "MSAwMDAwMCBuIAowMDAwMDAwNDUzIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFy" +
    "dHhyZWYKNTIzCiUlRU9GCg=="],
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
  "/demo",
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
      const isFile = MEMORY_FS.has(p) || MEMORY_BIN.has(p);
      return { path: p, isFile, isDir: false, size: 0, mtime: new Date().toISOString() } as unknown as T;
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
          { name: "sample.svg", isFile: true,  isDir: false },
          { name: "sample.png", isFile: true,  isDir: false },
          { name: "sample.pdf", isFile: true,  isDir: false },
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
    case "write_file_base64": {
      MEMORY_BIN.set(args.path, args.contents);
      return { path: args.path, bytes: args.contents.length, mtime: new Date().toISOString(), device: 0, inode: 0 } as unknown as T;
    }
    case "read_file_base64":
    case "read_file_binary": {
      const bin = MEMORY_BIN.get(args.path);
      if (bin !== undefined) return bin as unknown as T;
      const v = MEMORY_FS.get(args.path);
      if (v === undefined) throw { kind: "NotFound", path: args.path };
      try { return btoa(unescape(encodeURIComponent(v))) as unknown as T; } catch { return "" as unknown as T; }
    }
    case "watch_path":
      return ("mock-" + Math.random().toString(36).slice(2)) as unknown as T;
    case "unwatch_path":
      return undefined as unknown as T;
    case "rename": {
      // Move every MEMORY_FS / MEMORY_DIRS entry whose key starts with `${from}/`
      // to use `${to}/` instead. Refuse if `to` collides.
      const from = args.from as string;
      const to = args.to as string;
      if (MEMORY_FS.has(to) || MEMORY_DIRS.has(to)) {
        throw { kind: "AlreadyExists", path: to };
      }
      const fromPrefix = from + "/";
      const toPrefix = to + "/";
      const renameKey = (k: string) => (k === from ? to : k.startsWith(fromPrefix) ? toPrefix + k.slice(fromPrefix.length) : k);
      for (const k of Array.from(MEMORY_FS.keys())) {
        const v = MEMORY_FS.get(k);
        MEMORY_FS.delete(k);
        MEMORY_FS.set(renameKey(k), v as string);
      }
      for (const d of Array.from(MEMORY_DIRS)) {
        MEMORY_DIRS.delete(d);
        MEMORY_DIRS.add(renameKey(d));
      }
      return undefined as unknown as T;
    }
    case "delete": {
      // Remove a file or (recursively) a directory from the mock.
      const p = args.path as string;
      const prefix = p + "/";
      for (const k of Array.from(MEMORY_FS.keys())) {
        if (k === p || k.startsWith(prefix)) MEMORY_FS.delete(k);
      }
      for (const d of Array.from(MEMORY_DIRS)) {
        if (d === p || d.startsWith(prefix)) MEMORY_DIRS.delete(d);
      }
      return undefined as unknown as T;
    }
    case "copy": {
      const from = args.from as string;
      const to = args.to as string;
      if (MEMORY_FS.has(to) || MEMORY_DIRS.has(to)) {
        throw { kind: "AlreadyExists", path: to };
      }
      const fromPrefix = from + "/";
      const toPrefix = to + "/";
      const renameKey = (k: string) => k.startsWith(fromPrefix) ? toPrefix + k.slice(fromPrefix.length) : k;
      for (const [k, v] of MEMORY_FS) {
        if (k === from) { MEMORY_FS.set(to, v); }
        else if (k.startsWith(fromPrefix)) { MEMORY_FS.set(renameKey(k), v); }
      }
      for (const d of Array.from(MEMORY_DIRS)) {
        if (d === from) MEMORY_DIRS.add(to);
        else if (d.startsWith(fromPrefix)) { MEMORY_DIRS.add(renameKey(d)); }
      }
      return undefined as unknown as T;
    }
    case "open_in_terminal":
    case "reveal_in_folder":
    case "open_with_os":
      return undefined as unknown as T;
    case "recents_get":
      return [
        "/welcome.md", "/notes.md", "/hello.ts", "/README.md",
        "/demo/index.html", "/sample.svg", "/sample.png", "/sample.pdf",
      ] as unknown as T;
    case "open_file":
    case "open_folder":
    case "save_file":
      return null as unknown as T;
    default:
      return null as unknown as T;
  }
}

/* ---------- App state ---------- */
/* App state used to live behind `app_state_get` / `app_state_set`. Those
   Rust commands were never implemented; the workspace cache now owns that
   job renderer-side — see src/store/projects.ts. */

/* ---------- Recents ---------- */
export const recentsGet  = () => call<string[]>("recents_get");
export const recentsAdd  = (path: string) => call<string[]>("recents_add", { path });
export const recentsClear= () => call<void>("recents_clear");

/* ---------- Window ---------- */

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

/** Raster image extensions the viewer and the image editor can open. */
export const IMAGE_EXTENSIONS = [
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif",
] as const;

/** Extensions that must be read as bytes rather than as UTF-8 text. */
export const BINARY_EXTENSIONS: readonly string[] = [...IMAGE_EXTENSIONS, "pdf"];

/** Lowercase extension without the dot; "" when the path has none. */
export function extname(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/** True when `path` should be loaded through `readFileBase64`. */
export function isBinaryPath(path: string): boolean {
  return BINARY_EXTENSIONS.includes(extname(path));
}

/** MIME type for an image extension. Falls back to PNG. */
export function imageMime(path: string): string {
  switch (extname(path)) {
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif":  return "image/gif";
    case "webp": return "image/webp";
    case "bmp":  return "image/bmp";
    case "ico":  return "image/x-icon";
    case "avif": return "image/avif";
    case "svg":  return "image/svg+xml";
    default:     return "image/png";
  }
}

/**
 * Pick an editor mode from a file path based on its extension.
 *  - raster images → "image" (viewer; switch to "imageedit" to edit)
 *  - .pdf  → "pdf"
 *  - .sparkanim → "animation"
 *  - .svg  → "svg"
 *  - .html / .htm → "html" (webview preview)
 *  - .md / .markdown → "markdown"
 *  - .json → "rich"
 *  - everything else → "code"
 */
export function pickMode(path: string): ModeName {
  const lower = path.toLowerCase();
  const ext = extname(lower);
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (lower.endsWith(".sparkanim") || lower.endsWith(".anim.json")) return "animation";
  if (lower.endsWith(".svg")) return "svg";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".json")) return "rich";
  return "code";
}

type ModeName =
  | "markdown" | "rich" | "code" | "html" | "svg"
  | "image" | "imageedit" | "animation" | "pdf";

export { isTauri };
