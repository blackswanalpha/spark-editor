/* ============================================================
   sparkEditor · src/commands/registry.ts
   Central command table consumed by the palette, the menu,
   the title bar's MenuMirror, and keybinding dispatch.
   ============================================================ */
import { useDocs, type DocMode } from "@store/documents";
import {
  readFile,
  recentsAdd,
  openFileDialog,
  openFolderDialog,
  pickMode,
} from "@bridge/commands";

export interface CommandSpec {
  id: string;
  title: string;
  category?: string;
  icon?: string;
  shortcut?: string;
  keywords?: string[];
  run: () => unknown;
}

let palette: { open: () => void; close: () => void } | null = null;
export function bindPalette(p: { open: () => void; close: () => void }) { palette = p; }
export const openPalette = () => palette?.open();

/* Folder root state — exported so App can read it on first mount. */
export let currentRoot: string | null = null;
export function setCurrentRoot(path: string | null) { currentRoot = path; }

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const mod = (key: string) => isMac ? `⌘+${key}` : `Ctrl+${key}`;

export function buildCommands(): CommandSpec[] {
  const docs = useDocs.getState();
  const active = () => {
    const a = useDocs.getState().active;
    return a ? useDocs.getState().docs[a] : null;
  };
  const runIfActive = (fn: (a: NonNullable<ReturnType<typeof active>>) => void) => () => {
    const a = active();
    if (a) fn(a);
  };

  return [
    {
      id: "view.commandPalette", title: "Command Palette", category: "View",
      icon: "command", shortcut: mod("Shift+P"),
      keywords: ["palette", "search", "commands"],
      run: () => { openPalette(); },
    },
    {
      id: "view.toggleSidebar", title: "Toggle Sidebar", category: "View",
      icon: "sidebar-toggle", shortcut: mod("B"),
      run: () => { window.dispatchEvent(new CustomEvent("spark:toggleSidebar")); },
    },
    {
      id: "view.toggleStatusBar", title: "Toggle Status Bar", category: "View",
      run: () => { window.dispatchEvent(new CustomEvent("spark:toggleStatusBar")); },
    },
    {
      id: "view.toggleWordWrap", title: "Toggle Word Wrap", category: "View",
      icon: "mode-rich",
      run: () => { window.dispatchEvent(new CustomEvent("spark:view:toggleWordWrap")); },
    },
    {
      id: "view.togglePreview", title: "Toggle Preview", category: "View",
      icon: "mode-markdown",
      run: () => { window.dispatchEvent(new CustomEvent("spark:view:togglePreview")); },
    },
    {
      id: "view.zoomIn", title: "Zoom In", category: "View",
      icon: "plus",
      shortcut: mod("="),
      run: () => { window.dispatchEvent(new CustomEvent("spark:view:zoom:in")); },
    },
    {
      id: "view.zoomOut", title: "Zoom Out", category: "View",
      icon: "minus",
      shortcut: mod("-"),
      run: () => { window.dispatchEvent(new CustomEvent("spark:view:zoom:out")); },
    },
    {
      id: "view.zoomReset", title: "Reset Zoom", category: "View",
      icon: "restore",
      shortcut: mod("0"),
      run: () => { window.dispatchEvent(new CustomEvent("spark:view:zoom:reset")); },
    },
    {
      id: "view.switchMode", title: "Switch Mode (cycle)", category: "View",
      icon: "mode-code",
      run: () => {
        const a = active(); if (!a) return;
        const order: DocMode[] = ["markdown", "rich", "code", "html", "svg"];
        const next = order[(order.indexOf(a.mode) + 1) % order.length];
        useDocs.getState().setMode(a.id, next);
      },
    },
    { id: "view.markdown", title: "Switch to Markdown", category: "View", icon: "mode-markdown",
      run: runIfActive((a) => { useDocs.getState().setMode(a.id, "markdown"); }) },
    { id: "view.rich",     title: "Switch to Rich Text", category: "View", icon: "mode-rich",
      run: runIfActive((a) => { useDocs.getState().setMode(a.id, "rich"); }) },
    { id: "view.html",     title: "Switch to HTML Preview", category: "View", icon: "mode-html",
      run: runIfActive((a) => { useDocs.getState().setMode(a.id, "html"); }) },
    { id: "view.svg",      title: "Switch to SVG Editor", category: "View", icon: "mode-svg",
      run: runIfActive((a) => { useDocs.getState().setMode(a.id, "svg"); }) },
    { id: "view.code",     title: "Switch to Code",      category: "View", icon: "mode-code",
      run: runIfActive((a) => { useDocs.getState().setMode(a.id, "code"); }) },

    {
      id: "file.new", title: "New Document", category: "File",
      icon: "plus", shortcut: mod("N"),
      run: () => { docs.open({ name: "Untitled", mode: "markdown", raw: "" }); },
    },
    {
      id: "file.open", title: "Open File…", category: "File",
      icon: "open", shortcut: mod("O"),
      run: async () => {
        const result = await openFileDialog({ multiple: false });
        if (result == null) return;
        const path = Array.isArray(result) ? result[0] : result;
        if (!path) return;
        const text = await readFile(path);
        docs.open({ name: path.split("/").pop() || "untitled", path, mode: pickMode(path), raw: text });
        await recentsAdd(path);
      },
    },
    {
      id: "file.openFolder", title: "Open Folder…", category: "File",
      icon: "folder-open", shortcut: mod("Shift+O"),
      keywords: ["folder", "directory", "workspace"],
      run: async () => {
        const path = await openFolderDialog();
        if (!path) return;
        setCurrentRoot(path);
        window.dispatchEvent(new CustomEvent("spark:folder:open", { detail: { path } }));
      },
    },
    {
      id: "file.recent", title: "Open Recent", category: "File",
      icon: "refresh",
      keywords: ["recent", "history"],
      run: () => { openPalette(); },
    },
    {
      id: "file.save", title: "Save", category: "File",
      icon: "save", shortcut: mod("S"),
      run: async () => {
        const a = active(); if (!a) return;
        if (!a.path) {
          window.dispatchEvent(new CustomEvent("spark:saveas:open", { detail: { docId: a.id } }));
          return;
        }
        const result = await useDocs.getState().saveDocument(a.id);
        if (result.ok) {
          window.dispatchEvent(new CustomEvent("spark:toast:success", { detail: { title: "File saved" } }));
        } else if (result.reason === "error") {
          const msg = result.error instanceof Error ? result.error.message : String(result.error ?? "Unknown error");
          window.dispatchEvent(new CustomEvent("spark:toast:error", { detail: { title: "Save failed", body: msg } }));
        }
      },
    },
    {
      id: "file.saveAs", title: "Save As…", category: "File",
      icon: "save", shortcut: mod("Shift+S"),
      run: async () => {
        const a = active(); if (!a) return;
        const result = await useDocs.getState().saveDocumentAs(a.id);
        if (result.ok) {
          window.dispatchEvent(new CustomEvent("spark:toast:success", { detail: { title: "File saved" } }));
        } else if (result.reason === "error") {
          const msg = result.error instanceof Error ? result.error.message : String(result.error ?? "Unknown error");
          window.dispatchEvent(new CustomEvent("spark:toast:error", { detail: { title: "Save failed", body: msg } }));
        }
      },
    },
    {
      id: "file.revert", title: "Revert File", category: "File",
      icon: "refresh",
      run: async () => {
        const a = active(); if (!a || !a.path) return;
        try {
          const text = await readFile(a.path);
          useDocs.getState().setRaw(a.id, text);
          useDocs.getState().markClean(a.id);
        } catch (e: unknown) {
          const err = e as { kind?: unknown };
          const msg = err?.kind != null
            ? String(err.kind)
            : e instanceof Error
              ? e.message
              : String(e ?? "Unknown error");
          window.dispatchEvent(new CustomEvent("spark:toast:error", { detail: { title: "Revert failed", body: msg } }));
        }
      },
    },
    {
      id: "tab.close", title: "Close Tab", category: "File",
      icon: "close", shortcut: mod("W"),
      run: () => { const a = active(); if (a) window.dispatchEvent(new CustomEvent("spark:tab:close:request", { detail: { id: a.id } })); },
    },

    { id: "edit.undo", title: "Undo", category: "Edit", icon: "undo",  shortcut: mod("Z"),
      run: runIfActive((a) => { useDocs.getState().undo(a.id); }) },
    { id: "edit.redo", title: "Redo", category: "Edit", icon: "redo",  shortcut: mod("Shift+Z"),
      run: runIfActive((a) => { useDocs.getState().redo(a.id); }) },
    {
      id: "code.goToLine", title: "Go to Line", category: "Edit",
      icon: "search", shortcut: mod("G"),
      run: () => { window.dispatchEvent(new CustomEvent("spark:code:gotoLine")); },
    },
    {
      id: "code.toggleComment", title: "Toggle Line Comment", category: "Edit",
      icon: "quote", shortcut: mod("/"),
      run: () => { window.dispatchEvent(new CustomEvent("spark:code:toggleComment")); },
    },
    {
      id: "code.format", title: "Format Code", category: "Edit",
      icon: "code", shortcut: mod("Shift+I"),
      run: () => { window.dispatchEvent(new CustomEvent("spark:code:format")); },
    },
    {
      id: "edit.find", title: "Find", category: "Edit",
      icon: "search", shortcut: mod("F"),
      run: () => { window.dispatchEvent(new CustomEvent("spark:edit:find")); },
    },
    {
      id: "edit.replace", title: "Replace", category: "Edit",
      icon: "search", shortcut: mod("H"),
      run: () => { window.dispatchEvent(new CustomEvent("spark:edit:replace")); },
    },

    /* ---------- Selection ---------- */
    {
      id: "selection.selectAll", title: "Select All", category: "Selection",
      icon: "search", shortcut: mod("A"),
      run: () => { window.dispatchEvent(new CustomEvent("spark:selection:selectAll")); },
    },
    {
      id: "selection.copyLineUp", title: "Copy Line Up", category: "Selection",
      icon: "undo", shortcut: mod("Shift+Alt+Up"),
      run: () => { window.dispatchEvent(new CustomEvent("spark:selection:copyLineUp")); },
    },
    {
      id: "selection.copyLineDown", title: "Copy Line Down", category: "Selection",
      icon: "chevron-down", shortcut: mod("Shift+Alt+Down"),
      run: () => { window.dispatchEvent(new CustomEvent("spark:selection:copyLineDown")); },
    },
    {
      id: "selection.moveLineUp", title: "Move Line Up", category: "Selection",
      icon: "undo", shortcut: "Alt+Up",
      run: () => { window.dispatchEvent(new CustomEvent("spark:selection:moveLineUp")); },
    },
    {
      id: "selection.moveLineDown", title: "Move Line Down", category: "Selection",
      icon: "chevron-down", shortcut: "Alt+Down",
      run: () => { window.dispatchEvent(new CustomEvent("spark:selection:moveLineDown")); },
    },

    /* ---------- Format ---------- */
    { id: "format.bold",        title: "Toggle Bold",        category: "Format", icon: "bold",        shortcut: mod("B"),
      run: runIfActive((a) => emitFormat(a.mode, "bold")) },
    { id: "format.italic",      title: "Toggle Italic",      category: "Format", icon: "italic",      shortcut: mod("I"),
      run: runIfActive((a) => emitFormat(a.mode, "italic")) },
    { id: "format.inlineCode",  title: "Toggle Inline Code", category: "Format", icon: "code",
      shortcut: mod("E"),
      run: runIfActive((a) => emitFormat(a.mode, "inlineCode")) },
    { id: "format.link",        title: "Toggle Link",        category: "Format", icon: "link",        shortcut: mod("K"),
      run: runIfActive((a) => emitFormat(a.mode, "link")) },
    {
      id: "format.headingPromote", title: "Promote Heading", category: "Format",
      icon: "h1", shortcut: mod("["),
      run: () => { window.dispatchEvent(new CustomEvent("spark:md:format:headingPromote")); },
    },
    {
      id: "format.headingDemote", title: "Demote Heading", category: "Format",
      icon: "h3", shortcut: mod("]"),
      run: () => { window.dispatchEvent(new CustomEvent("spark:md:format:headingDemote")); },
    },
    {
      id: "format.listBullet", title: "Bullet List", category: "Format",
      icon: "list-ul", shortcut: mod("Shift+8"),
      run: () => { window.dispatchEvent(new CustomEvent("spark:md:format:listBullet")); },
    },
    {
      id: "format.listNumber", title: "Numbered List", category: "Format",
      icon: "list-ol", shortcut: mod("Shift+7"),
      run: () => { window.dispatchEvent(new CustomEvent("spark:md:format:listNumber")); },
    },
    {
      id: "format.quote", title: "Block Quote", category: "Format",
      icon: "quote", shortcut: mod("Shift+."),
      run: () => { window.dispatchEvent(new CustomEvent("spark:md:format:quote")); },
    },

    /* ---------- Window ---------- */
    {
      id: "window.minimize", title: "Minimize", category: "Window",
      icon: "minimize",
      run: () => { window.dispatchEvent(new CustomEvent("spark:window:minimize")); },
    },
    {
      id: "window.maximize", title: "Maximize", category: "Window",
      icon: "maximize",
      run: () => { window.dispatchEvent(new CustomEvent("spark:window:maximize")); },
    },
    {
      id: "window.close", title: "Close Window", category: "Window",
      icon: "close", shortcut: mod("Shift+W"),
      run: () => { window.dispatchEvent(new CustomEvent("spark:window:close:request")); },
    },

    /* ---------- Help ---------- */
    {
      id: "help.about", title: "About sparkEditor", category: "Help",
      icon: "command",
      run: () => { window.dispatchEvent(new CustomEvent("spark:help:about", { detail: { silent: true } })); },
    },
    {
      id: "help.docs", title: "Documentation", category: "Help",
      icon: "file",
      run: () => { window.dispatchEvent(new CustomEvent("spark:help:docs", { detail: { silent: true } })); },
    },
    {
      id: "help.releaseNotes", title: "Release Notes", category: "Help",
      icon: "file",
      run: () => { window.dispatchEvent(new CustomEvent("spark:help:releaseNotes", { detail: { silent: true } })); },
    },
    {
      id: "help.reportIssue", title: "Report Issue", category: "Help",
      icon: "alert",
      run: () => { window.dispatchEvent(new CustomEvent("spark:help:reportIssue", { detail: { silent: true } })); },
    },
    {
      id: "help.checkForUpdates", title: "Check for Updates…", category: "Help",
      icon: "refresh",
      keywords: ["ota", "update", "updater"],
      run: () => { window.dispatchEvent(new CustomEvent("spark:help:checkForUpdates")); },
    },
    {
      id: "help.devtools", title: "Toggle Developer Tools", category: "Help",
      icon: "code",
      run: () => { window.dispatchEvent(new CustomEvent("spark:devtools:toggle")); },
    },
  ];
}

function emitFormat(mode: DocMode, kind: "bold" | "italic" | "inlineCode" | "link") {
  const prefix = mode === "markdown" ? "spark:md:format"
               : mode === "rich"     ? "spark:rich:format"
               :                       "spark:code:format";
  window.dispatchEvent(new CustomEvent(`${prefix}:${kind}`));
}
