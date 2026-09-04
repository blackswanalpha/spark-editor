/* ============================================================
   sparkBook · src/ui/OpenDialog.tsx
   Browser-only fallback for native open/save dialogs. Listens
   for `spark:dialog:openFile` and `spark:dialog:saveFile` events
   dispatched by @bridge/commands when not running inside Tauri.
   ============================================================ */
import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog, DialogFooter } from "./Dialog";
import { Input } from "./Input";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { recentsGet } from "@bridge/commands";
import type { OpenDialogOptions, SaveDialogOptions } from "@bridge/commands";
import "./OpenDialog.css";

type Mode = "file" | "folder" | "save";
type PendingResolve =
  | ((value: string | string[] | null) => void)
  | ((value: string | null) => void)
  | null;

const STATIC_FILES: string[] = [
  "/welcome.md",
  "/notes.md",
  "/hello.ts",
  "/README.md",
];

function fileIcon(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "mode-markdown";
  if (lower.endsWith(".pdf")) return "mode-pdf";
  if (lower.endsWith(".sparkanim")) return "mode-animation";
  if (/\.(png|jpe?g|gif|webp|bmp|ico|avif)$/.test(lower)) return "mode-image";
  if (lower.endsWith(".svg")) return "mode-svg";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx") || lower.endsWith(".js") || lower.endsWith(".json") || lower.endsWith(".html")) return "file-code";
  return "file";
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

export default function OpenDialog() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("file");
  const [pendingResolve, setPendingResolve] = useState<PendingResolve>(null);
  const [opts, setOpts] = useState<OpenDialogOptions | SaveDialogOptions>({});
  const [path, setPath] = useState("");
  const [files, setFiles] = useState<string[]>(STATIC_FILES);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const close = useCallback(
    (value: string | string[] | null) => {
      if (pendingResolve) {
        try {
          (pendingResolve as (v: unknown) => void)(value);
        } catch {
          /* noop */
        }
      }
      setPendingResolve(null);
      setOpen(false);
      setPath("");
    },
    [pendingResolve],
  );

  const refreshFiles = useCallback(async () => {
    try {
      const r = await recentsGet();
      if (Array.isArray(r) && r.length > 0) {
        setFiles(r);
        return;
      }
    } catch {
      /* fall through to static */
    }
    setFiles(STATIC_FILES);
  }, []);

  // Open-file / open-folder event
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ resolve: PendingResolve; opts: OpenDialogOptions }>).detail;
      if (!detail) return;
      const directory = !!detail.opts?.directory;
      setMode(directory ? "folder" : "file");
      setOpts(detail.opts ?? {});
      setPendingResolve(() => detail.resolve);
      setPath("");
      setOpen(true);
      if (!directory) void refreshFiles();
    };
    const onSave = (e: Event) => {
      const detail = (e as CustomEvent<{ resolve: PendingResolve; opts: SaveDialogOptions }>).detail;
      if (!detail) return;
      setMode("save");
      setOpts(detail.opts ?? {});
      setPendingResolve(() => detail.resolve);
      setPath(detail.opts?.defaultPath ?? "");
      setOpen(true);
    };
    window.addEventListener("spark:dialog:openFile", onOpen as EventListener);
    window.addEventListener("spark:dialog:saveFile", onSave as EventListener);
    return () => {
      window.removeEventListener("spark:dialog:openFile", onOpen as EventListener);
      window.removeEventListener("spark:dialog:saveFile", onSave as EventListener);
    };
  }, [refreshFiles]);

  // Autofocus the input once the dialog opens
  useEffect(() => {
    if (open) {
      const t = window.setTimeout(() => inputRef.current?.focus(), 30);
      return () => window.clearTimeout(t);
    }
  }, [open]);

  const onOpenChange = useCallback(
    (next: boolean) => {
      if (!next) close(null);
    },
    [close],
  );

  const confirm = useCallback(() => {
    if (mode === "save") {
      close(path.trim() || null);
      return;
    }
    const trimmed = path.trim();
    if (trimmed) {
      close(trimmed);
    }
  }, [mode, path, close]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        confirm();
      }
    },
    [confirm],
  );

  const title =
    mode === "save"
      ? "Save file"
      : mode === "folder"
        ? "Open folder"
        : "Open file";

  const description =
    mode === "save"
      ? "Type a path to save the current document (mock FS)."
      : mode === "folder"
        ? "Type a folder path. Mock directories: /, /docs, /src."
        : "Pick a known mock file, or type a path below.";

  const acceptLabel = mode === "save" ? "Save" : "Open";

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      size="md"
    >
      <div className="opendialog" onKeyDown={onKeyDown}>
        {mode === "file" && (
          <ul className="opendialog__list" role="listbox" aria-label="Mock files">
            {files.map((p) => (
              <li key={p}>
                <button
                  type="button"
                  className="opendialog__row"
                  onClick={() => close(p)}
                >
                  <Icon name={fileIcon(p)} size={16} className="opendialog__row-icon" />
                  <span className="opendialog__row-name">{basename(p)}</span>
                  <span className="opendialog__row-path">{p}</span>
                </button>
              </li>
            ))}
            {files.length === 0 && (
              <li className="opendialog__empty">No mock files available.</li>
            )}
          </ul>
        )}

        {mode === "folder" && (
          <p className="opendialog__hint">
            Mock directories available: <code>/</code>, <code>/docs</code>, <code>/src</code>.
            Type any path to open it.
          </p>
        )}

        <div className="opendialog__input-row">
          <Input
            ref={inputRef}
            leadingIcon={mode === "folder" ? "folder" : mode === "save" ? "save" : "file"}
            placeholder={
              mode === "folder"
                ? "/docs"
                : mode === "save"
                  ? "/untitled.md"
                  : "/path/to/file.md"
            }
            value={path}
            onChange={(e) => setPath(e.target.value)}
            inputSize="md"
          />
        </div>
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={() => close(null)}>
          Cancel
        </Button>
        <Button
          variant="primary"
          icon={mode === "save" ? "save" : "open"}
          onClick={confirm}
          disabled={!path.trim()}
        >
          {acceptLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
