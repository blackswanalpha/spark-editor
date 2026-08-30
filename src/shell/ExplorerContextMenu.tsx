/* ============================================================
   sparkEditor · src/shell/ExplorerContextMenu.tsx
   Right-click bubble menu for the file explorer. Wraps a
   trigger element and renders a context menu with:
     • New File        • Cut
     • New Folder      • Copy
     • Open in Terminal • Paste
     • Reveal in OS    • Rename
     • Refactor        • Delete
   Entries are filtered based on whether the target is a
   file/folder/root and on current clipboard state.
   ============================================================ */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ContextMenu, type ContextMenuEntry } from "@ui/ContextMenu";
import { Input } from "@ui/Input";
import { Dialog, DialogFooter } from "@ui/Dialog";
import { Button } from "@ui/Button";
import { useExplorer } from "@store/explorer";
import { openTerminalAt } from "@store/terminal";

export type ExplorerAction =
  | "new-file"
  | "new-folder"
  | "open-in-terminal"
  | "reveal-in-os"
  | "cut"
  | "copy"
  | "paste"
  | "rename"
  | "refactor"
  | "delete";

export interface ExplorerContextMenuProps {
  /** The path the right-click landed on. For directory-row this is the
   *  directory path; for the empty tree area this is the explorer root. */
  path: string;
  /** Whether the target is a directory. Determines which entries are
   *  shown (e.g. "Open in terminal" needs a directory). */
  isDir: boolean;
  /** Display name (used for the delete-confirm dialog). */
  name: string;
  /** Called when the user wants to create a new file/folder here.
   *  The parent component owns the CreateDialog; we just route the
   *  click back via this callback so existing behaviour is reused. */
  onRequestCreate: (kind: "file" | "folder", targetDir: string) => void;
  /** Called when the user opens the file with the OS (double-click flow). */
  onOpen?: (path: string) => void;
  /** Info / error toasts. */
  onInfo?: (message: string) => void;
  onError?: (title: string, detail?: string) => void;
  /** The element that should receive right-clicks. */
  children: React.ReactElement;
}

function parentDir(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (idx <= 0) return "/";
  return path.slice(0, idx) || "/";
}

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

export function ExplorerContextMenu({
  path, isDir, name, onRequestCreate, onOpen, onInfo, onError, children,
}: ExplorerContextMenuProps) {
  const clipboard = useExplorer((s) => s.clipboard);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const targetDir = isDir ? path : parentDir(path);
  const hasClipboard = !!clipboard;

  const entries = useMemo<ContextMenuEntry[]>(() => {
    const list: ContextMenuEntry[] = [
      { id: "new-file",   label: "New File…",        icon: "file-plus" },
      { id: "new-folder", label: "New Folder…",      icon: "folder-plus" },
    ];
    if (isDir) {
      list.push({ id: "open-in-terminal", label: "Open in Terminal",  icon: "terminal" });
    }
    list.push({ id: "reveal-in-os", label: "Reveal in File Manager", icon: "external" });
    list.push({ separator: true, id: "sep-1" });
    list.push({ id: "cut",  label: "Cut",  icon: "scissors", shortcut: "⌘X" });
    list.push({ id: "copy", label: "Copy", icon: "copy",     shortcut: "⌘C" });
    list.push({ id: "paste", label: "Paste", icon: "clipboard", shortcut: "⌘V", disabled: !hasClipboard });
    list.push({ separator: true, id: "sep-2" });
    list.push({ id: "rename",   label: "Rename…", icon: "pencil" });
    list.push({ id: "refactor", label: "Refactor…", icon: "arrows-clockwise" });
    list.push({ separator: true, id: "sep-3" });
    list.push({ id: "delete", label: "Delete", icon: "trash", destructive: true, shortcut: "⌫" });
    return list;
  }, [isDir, hasClipboard]);

  const runAction = useCallback(async (id: string) => {
    const api = useExplorer.getState();
    switch (id as ExplorerAction) {
      case "new-file":
        onRequestCreate("file", targetDir);
        return;
      case "new-folder":
        onRequestCreate("folder", targetDir);
        return;
      case "open-in-terminal": {
        // Route to the in-app terminal panel instead of spawning an OS terminal.
        // Keep explorer selection in sync so TerminalPanel cwd derives correctly.
        const dir = isDir ? path : parentDir(path);
        openTerminalAt(dir);
        onInfo?.(`Terminal: ${dir}`);
        return;
      }
      case "reveal-in-os": {
        const res = await api.revealInOS(path);
        if (!res.ok) onError?.("Reveal failed", res.error);
        return;
      }
      case "cut": {
        api.setClipboard({ op: "cut", path });
        onInfo?.(`Cut: ${name}`);
        return;
      }
      case "copy": {
        api.setClipboard({ op: "copy", path });
        onInfo?.(`Copied: ${name}`);
        return;
      }
      case "paste": {
        if (!clipboard) return;
        const res = await api.pasteInto(targetDir);
        if (!res.ok) onError?.("Paste failed", res.error);
        else onInfo?.(`Pasted into ${basename(targetDir) || targetDir}`);
        return;
      }
      case "rename":
        setRenameOpen(true);
        return;
      case "refactor":
        // Today refactor == rename. A future PR can route to language-aware
        // refactor providers; for now we surface it via the rename dialog
        // so users can pick a new identifier.
        setRenameOpen(true);
        return;
      case "delete":
        setDeleteOpen(true);
        return;
    }
  }, [path, name, targetDir, clipboard, onRequestCreate, onInfo, onError]);

  return (
    <>
      <ContextMenu entries={entries} onSelect={runAction}>
        {children}
      </ContextMenu>
      <RenameDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        path={path}
        initialName={name}
        onInfo={onInfo}
        onError={onError}
      />
      <DeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        path={path}
        name={name}
        isDir={isDir}
        onInfo={onInfo}
        onError={onError}
      />
    </>
  );
}

/* ---------- Rename dialog ---------- */
function RenameDialog({
  open, onOpenChange, path, initialName, onInfo, onError,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  path: string;
  initialName: string;
  onInfo?: (m: string) => void;
  onError?: (m: string, d?: string) => void;
}) {
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);

  // reset on open
  useEffect(() => {
    if (open) { setName(initialName); setBusy(false); }
  }, [open, initialName]);

  const confirm = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === initialName) { onOpenChange(false); return; }
    if (trimmed.includes("/") || trimmed.includes("\\")) {
      onError?.("Invalid name", "Name must not contain / or \\");
      return;
    }
    setBusy(true);
    const res = await useExplorer.getState().renamePath(path, trimmed);
    setBusy(false);
    if (res.ok) {
      onInfo?.(`Renamed to ${trimmed}`);
      onOpenChange(false);
    } else {
      onError?.("Rename failed", res.error);
    }
  }, [name, initialName, path, onInfo, onError, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Rename" description="Choose a new name." size="sm">
      <div className="create-dialog">
        <div className="create-dialog__field">
          <label className="create-dialog__label">New name</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={initialName}
            inputSize="md"
            autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void confirm(); } }}
          />
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
        <Button variant="primary" onClick={() => { void confirm(); }} disabled={!name.trim() || busy}>
          Rename
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/* ---------- Delete confirm dialog ---------- */
function DeleteDialog({
  open, onOpenChange, path, name, isDir, onInfo, onError,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  path: string;
  name: string;
  isDir: boolean;
  onInfo?: (m: string) => void;
  onError?: (m: string, d?: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const confirm = useCallback(async () => {
    setBusy(true);
    const res = await useExplorer.getState().deletePath(path);
    setBusy(false);
    if (res.ok) {
      onInfo?.(`Deleted ${isDir ? "folder" : "file"} ${name}`);
      // Note: any tab still open for `path` will surface a "missing file" error
      // on its next save attempt; the editor already handles that case.
      onOpenChange(false);
    } else {
      onError?.("Delete failed", res.error);
    }
  }, [path, name, isDir, onInfo, onError, onOpenChange]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={isDir ? "Delete folder?" : "Delete file?"}
      description={isDir
        ? `This will recursively delete “${name}” and all of its contents.`
        : `This will permanently delete “${name}”.`}
      size="sm"
    >
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
        <Button variant="danger" onClick={() => { void confirm(); }} disabled={busy}>
          Delete
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
