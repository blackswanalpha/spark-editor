/* ============================================================
   sparkEditor · src/shell/SaveAsModal.tsx
   Controlled "Save As…" dialog. Parent owns the open state
   and decides what to do with the chosen path.
   ============================================================ */
import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog, DialogFooter } from "@ui/Dialog";
import { Input } from "@ui/Input";
import { Button } from "@ui/Button";
import { saveFileDialog, type DialogFilter } from "@bridge/commands";
import "./SaveAsModal.css";

export interface SaveAsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentName: string;
  currentPath: string | null;
  initialPath?: string;
  filters?: DialogFilter[];
  onConfirm: (path: string) => void | Promise<void>;
  busy?: boolean;
  errorMessage?: string | null;
}

export default function SaveAsModal({
  open,
  onOpenChange,
  currentName,
  currentPath,
  initialPath,
  filters,
  onConfirm,
  busy = false,
  errorMessage = null,
}: SaveAsModalProps) {
  const seed = initialPath ?? currentPath ?? currentName;
  const [path, setPath] = useState<string>(seed);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) setPath(seed);
  }, [open, seed]);

  useEffect(() => {
    if (open) {
      const t = window.setTimeout(() => inputRef.current?.focus(), 30);
      return () => window.clearTimeout(t);
    }
    return;
  }, [open]);

  const handleCancel = useCallback(() => {
    if (busy) return;
    onOpenChange(false);
  }, [busy, onOpenChange]);

  const handleBrowse = useCallback(async () => {
    if (busy) return;
    try {
      const picked = await saveFileDialog({ defaultPath: path || undefined, filters });
      if (typeof picked === "string" && picked.length > 0) {
        setPath(picked);
      }
    } catch {
      /* user cancelled or bridge failed; keep current path */
    }
  }, [busy, path, filters]);

  const handleSave = useCallback(async () => {
    const trimmed = path.trim();
    if (!trimmed || busy) return;
    await onConfirm(trimmed);
  }, [path, busy, onConfirm]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void handleSave();
      }
    },
    [handleSave],
  );

  const description = currentPath
    ? `Currently: ${currentPath}`
    : "This document has not been saved yet.";

  const trimmed = path.trim();
  const canSave = trimmed.length > 0 && !busy;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
      title="Save As…"
      description={description}
      size="md"
    >
      <div className="saveas" onKeyDown={handleKeyDown}>
        <div className="saveas__row">
          <Input
            ref={inputRef}
            leadingIcon="file"
            value={path}
            placeholder="/path/to/file.md"
            disabled={busy}
            onChange={(e) => setPath(e.target.value)}
            aria-label="New file path"
          />
          <Button
            variant="secondary"
            icon="folder"
            onClick={handleBrowse}
            disabled={busy}
          >
            Browse…
          </Button>
        </div>

        {errorMessage && (
          <p className="saveas__error" role="alert">
            {errorMessage}
          </p>
        )}

        <p className="saveas__hint">
          Save as: <strong>{currentName}</strong>
        </p>
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={handleCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          icon="save"
          onClick={handleSave}
          disabled={!canSave}
          loading={busy}
        >
          Save
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
