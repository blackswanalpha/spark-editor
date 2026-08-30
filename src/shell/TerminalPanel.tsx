/* ============================================================
   sparkEditor · src/shell/TerminalPanel.tsx

   Floating terminal panel around <TerminalView />.

   The panel owns chrome and window management; the shell itself
   lives in the Rust host (src-tauri/src/pty.rs) and the grid is
   painted by TerminalView. xterm.js is gone — there is no terminal
   emulator in the renderer any more, and no simulated command
   table either: `ls`, `vim`, `htop` and everything else are the
   real programs.

   Root: the "Root" toggle respawns the session through
   pkexec/sudo. The OS collects the password on its own; the app
   never sees, stores or forwards a credential.
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@ui/Icon";
import { useExplorer } from "@store/explorer";
import { useDocs } from "@store/documents";
import { useTerminal } from "@store/terminal";
import { openInTerminal, isTauri } from "@bridge/commands";
import { ptyRootSupport, type PtyPrivilege, type RootSupport } from "@bridge/pty";
import { TerminalView, type TerminalStatus } from "./Terminal/TerminalView";
import "./TerminalPanel.css";

function dirOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (idx <= 0) return "/";
  return path.slice(0, idx) || "/";
}

/** Derive the terminal's working directory from what the user is looking at. */
function useTerminalCwd(): string {
  const root = useExplorer((s) => s.root);
  const selected = useExplorer((s) => s.selectedPath);
  const children = useExplorer((s) => s.children);
  const targetCwd = useTerminal((s) => s.targetCwd);
  const activePath = useDocs((s) => {
    const id = s.active;
    return id ? (s.docs[id]?.path ?? null) : null;
  });

  return useMemo(() => {
    // An explicit request ("Open in Terminal" on a folder) wins: the user
    // named the directory, so honouring the tree selection instead would
    // silently ignore them.
    if (targetCwd) return targetCwd;
    if (selected) return children.has(selected) ? selected : dirOf(selected);
    if (activePath) return dirOf(activePath);
    if (root) return root;
    return "/";
  }, [targetCwd, selected, children, activePath, root]);
}

const MIN_W = 380;
const MIN_H = 220;

export function TerminalDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const cwd = useTerminalCwd();
  const privilege = useTerminal((s) => s.privilege);
  const setPrivilege = useTerminal((s) => s.setPrivilege);

  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [size, setSize] = useState({ w: 720, h: 440 });
  const [status, setStatus] = useState<TerminalStatus>({ phase: "starting" });
  const [title, setTitle] = useState<string | null>(null);
  const [rootSupport, setRootSupport] = useState<RootSupport | null>(null);
  const [restartKey, setRestartKey] = useState(0);
  const [popping, setPopping] = useState(false);

  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const placedRef = useRef(false);

  /* Place the panel bottom-right on first open, then leave it where the
     user put it — re-centring on every open loses their arrangement. */
  useEffect(() => {
    if (!open || placedRef.current) return;
    placedRef.current = true;
    setPos({
      x: Math.max(12, window.innerWidth - size.w - 24),
      y: Math.max(12, window.innerHeight - size.h - 56),
    });
  }, [open, size.w, size.h]);

  /* Keep the panel reachable when the window shrinks under it. */
  useEffect(() => {
    if (!open) return;
    const onResize = () => {
      setPos((p) => ({
        x: Math.min(p.x, Math.max(0, window.innerWidth - 120)),
        y: Math.min(p.y, Math.max(0, window.innerHeight - 60)),
      }));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open]);

  useEffect(() => {
    if (!open || !isTauri) return;
    let cancelled = false;
    ptyRootSupport()
      .then((s) => {
        if (!cancelled) setRootSupport(s);
      })
      .catch(() => {
        if (!cancelled) setRootSupport({ available: false, method: "none", alreadyRoot: false });
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  /* ---------- Drag ---------- */

  const onHeaderPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest("button")) return;
      dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [pos],
  );

  const onHeaderPointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    setPos({
      x: Math.max(0, Math.min(window.innerWidth - 80, e.clientX - drag.dx)),
      y: Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.dy)),
    });
  }, []);

  const endDrag = useCallback((e: React.PointerEvent) => {
    dragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  }, []);

  /* ---------- Resize ---------- */

  const onResizePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = size.w;
      const startH = size.h;
      const originX = pos.x;
      const originY = pos.y;

      const onMove = (ev: PointerEvent) => {
        setSize({
          w: Math.max(MIN_W, Math.min(window.innerWidth - originX - 8, startW + ev.clientX - startX)),
          h: Math.max(MIN_H, Math.min(window.innerHeight - originY - 8, startH + ev.clientY - startY)),
        });
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [pos.x, pos.y, size.w, size.h],
  );

  const togglePrivilege = useCallback(() => {
    setPrivilege(privilege === "root" ? "user" : "root");
  }, [privilege, setPrivilege]);

  /* Pop out into a real OS window. The session lives in the Rust host, so
     the new window opens its own — no state has to be handed across, and
     unlike the old Picture-in-Picture/popup fallbacks there is nothing to
     keep in sync or leak. */
  const popOut = useCallback(async () => {
    if (!isTauri || popping) return;
    setPopping(true);
    try {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const existing = await WebviewWindow.getByLabel("terminal");
      if (existing) {
        await existing.setFocus();
        return;
      }
      const url = `index.html?terminal=1&cwd=${encodeURIComponent(cwd)}&privilege=${privilege}`;
      const win = new WebviewWindow("terminal", {
        url,
        title: `Terminal — ${cwd}`,
        width: Math.max(MIN_W, size.w),
        height: Math.max(MIN_H, size.h),
        resizable: true,
        decorations: true,
        focus: true,
      });
      await new Promise<void>((resolve, reject) => {
        void win.once("tauri://created", () => resolve());
        void win.once("tauri://error", (e) => reject(new Error(String(e.payload))));
      });
      // The panel and the OS window would otherwise both hold a shell.
      onOpenChange(false);
    } catch (err) {
      window.dispatchEvent(
        new CustomEvent("spark:toast:error", {
          detail: {
            title: "Could not open a terminal window",
            body: String((err as Error)?.message ?? err),
          },
        }),
      );
    } finally {
      setPopping(false);
    }
  }, [cwd, privilege, popping, size.w, size.h, onOpenChange]);

  const isRoot = privilege === "root";
  const rootBlocked = rootSupport != null && !rootSupport.available;

  if (!open) return null;

  return (
    <div
      className={`term term--floating ${isRoot ? "term--root" : ""}`}
      role="dialog"
      aria-label="Terminal"
      aria-modal="false"
      style={{ left: pos.x, top: pos.y, width: size.w, height: size.h }}
    >
      <div
        className="term__header term__header--draggable"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="term__title">
          <Icon name="terminal" size={16} />
          <span>{title || "Terminal"}</span>
          {isRoot && <span className="term__badge term__badge--root">root</span>}
          <span className="term__cwd" title={cwd}>
            {cwd}
          </span>
        </div>

        <div className="term__actions">
          <button
            type="button"
            className={`term__btn ${isRoot ? "is-on" : ""}`}
            aria-pressed={isRoot}
            disabled={rootBlocked}
            title={
              rootBlocked
                ? "No privilege helper found — install pkexec (polkit) or sudo to use root sessions."
                : isRoot
                  ? "Switch back to a normal user shell"
                  : rootSupport?.alreadyRoot
                    ? "sparkEditor already runs as root"
                    : `Restart this shell as root via ${rootSupport?.method ?? "pkexec"} — your OS will ask for the password`
            }
            onClick={togglePrivilege}
          >
            <Icon name={isRoot ? "alert" : "terminal"} size={14} />
            <span>{isRoot ? "Root" : "User"}</span>
          </button>

          <button
            type="button"
            className="term__btn"
            title="Restart the shell"
            onClick={() => setRestartKey((k) => k + 1)}
          >
            <Icon name="refresh" size={14} />
            <span>Restart</span>
          </button>

          {isTauri && (
            <button
              type="button"
              className="term__btn"
              title="Move the terminal into its own OS window"
              disabled={popping}
              onClick={() => void popOut()}
            >
              <Icon name="external" size={14} />
              <span>Pop out</span>
            </button>
          )}

          <button
            type="button"
            className="term__icon-btn"
            aria-label="Close terminal"
            onClick={() => onOpenChange(false)}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      </div>

      <div className="term__holder">
        <TerminalView
          // A new cwd or privilege is a different shell; remounting keeps
          // the view from briefly painting the previous session's grid.
          key={`${cwd}::${privilege}::${restartKey}`}
          cwd={cwd}
          privilege={privilege}
          onStatus={setStatus}
          onTitle={setTitle}
        />
      </div>

      <div className="term__footer">
        <span className="term__hint">
          {status.phase === "running"
            ? `${status.shell}${status.privilege === "root" ? " · root" : ""}`
            : status.phase === "exited"
              ? `exited (${status.code}) — Restart to start a new shell`
              : status.phase === "failed"
                ? status.message
                : "starting…"}
        </span>
        <span className="term__footer-right">
          {isTauri && (
            <button
              type="button"
              className="term__btn term__btn--sm"
              title={`Open your system terminal at ${cwd}`}
              onClick={() => void openInTerminal(cwd).catch(() => {})}
            >
              <Icon name="external" size={12} /> System terminal
            </button>
          )}
        </span>
      </div>

      <div
        className="term__resizeHandle"
        onPointerDown={onResizePointerDown}
        aria-hidden
        title="Drag to resize"
      />
    </div>
  );
}

/**
 * Terminal-only view for the pop-out window (`index.html?terminal=1`).
 * Same session machinery, no panel chrome.
 */
export function TerminalStandaloneInner({
  cwd,
  privilege = "user",
}: {
  cwd: string;
  privilege?: PtyPrivilege;
}) {
  const [title, setTitle] = useState<string | null>(null);

  useEffect(() => {
    document.title = title ? `${title} — Terminal` : `Terminal — ${cwd}`;
  }, [title, cwd]);

  return (
    <div className="term-standalone">
      <div className="term-standalone__bar">
        <Icon name="terminal" size={14} />
        <span className="term-standalone__name">{title || "Terminal"}</span>
        <span className="term-standalone__cwd">{cwd}</span>
      </div>
      <div className="term-standalone__body">
        <TerminalView cwd={cwd} privilege={privilege} onTitle={setTitle} />
      </div>
    </div>
  );
}
