/* ============================================================
   sparkEditor · src/shell/TerminalPanel.tsx
   xterm.js terminal with:
     - cwd synced to Explorer selection (file → parent, dir → itself, fallback → root)
     - Independent floating window: non-modal draggable panel inside main
       window (main stays fully interactive)
     - True out-of-window popout: Document Picture-in-Picture (iframe
       hosting terminal-only view) or Tauri WebviewWindow or
       window.open popup — all are OS-level windows that can be
       moved/resized outside main window bounds, main stays active.
     - Bubble / context-menu “Open in Terminal” routes here via
       useTerminal.openAt(cwd) (no external OS terminal spawn)
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@ui/Icon";
import { useExplorer } from "@store/explorer";
import { useDocs } from "@store/documents";
import { useTerminal } from "@store/terminal";
import { readDir, stat, openInTerminal, isTauri } from "@bridge/commands";
import "./TerminalPanel.css";

type XTermType = InstanceType<typeof import("@xterm/xterm").Terminal>;
type FitAddonType = InstanceType<typeof import("@xterm/addon-fit").FitAddon>;

declare global {
  interface Window {
    documentPictureInPicture?: {
      requestWindow: (opts?: { width?: number; height?: number }) => Promise<Window>;
      window?: Window | null;
    };
  }
}

function dirOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (idx <= 0) return "/";
  return path.slice(0, idx) || "/";
}

function useTerminalCwd(): string {
  const root = useExplorer((s) => s.root);
  const selected = useExplorer((s) => s.selectedPath);
  const activePath = useDocs((s) => {
    const id = s.active;
    return id ? s.docs[id]?.path ?? null : null;
  });
  const children = useExplorer((s) => s.children);
  const targetCwd = useTerminal((s) => s.targetCwd);

  return useMemo(() => {
    if (selected) {
      if (children.has(selected)) return selected;
      return dirOf(selected);
    }
    if (targetCwd) return targetCwd;
    if (activePath) return dirOf(activePath);
    if (root) return root;
    return "/";
  }, [selected, targetCwd, activePath, root, children]);
}

async function copyStylesTo(dest: Document) {
  for (const ss of Array.from(document.styleSheets)) {
    try {
      const rules = Array.from(ss.cssRules).map((r) => r.cssText).join("\n");
      const style = dest.createElement("style");
      style.textContent = rules;
      dest.head.appendChild(style);
    } catch {
      try {
        if ((ss as CSSStyleSheet).href) {
          const link = dest.createElement("link");
          link.rel = "stylesheet";
          link.href = (ss as CSSStyleSheet).href!;
          dest.head.appendChild(link);
        }
      } catch { /* ignore */ }
    }
  }
  const extra = dest.createElement("style");
  extra.textContent = `body{margin:0;background:#1c2027;color:#e6e9ee;font-family:var(--font-ui);overflow:hidden}`;
  dest.head.appendChild(extra);
}

/* ---------- xterm host ---------- */
function XTermHost({
  cwd,
  containerRef,
}: {
  cwd: string;
  containerRef: React.RefObject<HTMLDivElement>;
}) {
  const termRef = useRef<XTermType | null>(null);
  const fitRef = useRef<FitAddonType | null>(null);
  const cwdRef = useRef(cwd);
  const historyRef = useRef<string[]>([]);
  const histIdxRef = useRef(-1);
  const lineBufRef = useRef("");

  cwdRef.current = cwd;

  const writePrompt = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const short = cwdRef.current.replace(/.*\//, "") || "/";
    term.write(`\r\n\x1b[33m${short}\x1b[0m $ `);
  }, []);

  const handleCommand = useCallback(async (raw: string) => {
    const term = termRef.current;
    if (!term) return;
    const input = raw.trim();
    if (!input) return;
    historyRef.current.push(input);
    histIdxRef.current = historyRef.current.length;
    const [cmd, ...args] = input.split(/\s+/);
    switch (cmd) {
      case "help": term.writeln("\r\nCommands: help, clear, pwd, ls, cd <dir>, echo <text>, open <path>"); break;
      case "clear": term.clear(); break;
      case "pwd": term.writeln(`\r\n${cwdRef.current}`); break;
      case "echo": term.writeln(`\r\n${args.join(" ")}`); break;
      case "ls": {
        try {
          const target = args[0]
            ? args[0].startsWith("/") ? args[0] : `${cwdRef.current.replace(/\/+$/, "")}/${args[0]}`
            : cwdRef.current;
          const entries = await readDir(target);
          if (!entries || entries.length === 0) term.writeln("\r\n(empty)");
          else {
            const names = entries.map((e: any) => e.isDir || e.is_dir ? `\x1b[34m${e.name}/\x1b[0m` : e.name).join("  ");
            term.writeln(`\r\n${names}`);
          }
        } catch (e: any) { term.writeln(`\r\nls: ${String(e?.message ?? e)}`); }
        break;
      }
      case "cd": {
        const dest = args[0];
        if (!dest) { term.writeln(`\r\ncd: missing operand`); break; }
        let next: string;
        if (dest === "..") next = dirOf(cwdRef.current);
        else if (dest.startsWith("/")) next = dest;
        else next = `${cwdRef.current.replace(/\/+$/, "")}/${dest}`;
        try {
          const s: any = await stat(next);
          const isDir = s?.isDir ?? s?.is_dir ?? false;
          if (!isDir) term.writeln(`\r\ncd: not a directory: ${next}`);
          else {
            cwdRef.current = next.replace(/\/+$/, "") || "/";
            useExplorer.getState().setSelected(cwdRef.current);
            useTerminal.getState().setTargetCwd(cwdRef.current);
            // broadcast to external OS window (PiP iframe / popup / Tauri)
            try { localStorage.setItem("spark:terminal:cwd", cwdRef.current); } catch {}
            try {
              const bc = new BroadcastChannel("spark-terminal");
              bc.postMessage({ type: "cwd", cwd: cwdRef.current });
              bc.close();
            } catch {}
            try { window.dispatchEvent(new CustomEvent("spark:terminal:cwd", { detail: { cwd: cwdRef.current } })); } catch {}
            try {
              const { emit } = await import("@tauri-apps/api/event");
              await emit("terminal:cwd", cwdRef.current);
            } catch {}
            // also postMessage to any external window refs (handled by parent)
            term.writeln(`\r\n→ ${cwdRef.current}`);
          }
        } catch (e: any) { term.writeln(`\r\ncd: ${String(e?.message ?? e)}`); }
        break;
      }
      case "open": {
        const p = args[0];
        if (!p) term.writeln("\r\nopen: missing path");
        else term.writeln(`\r\n(open) ${p} — use Explorer to open files`);
        break;
      }
      default: term.writeln(`\r\n${cmd}: command not found (try help)`);
    }
  }, []);

  const prevCwd = useRef(cwd);
  useEffect(() => {
    if (prevCwd.current !== cwd) {
      cwdRef.current = cwd;
      prevCwd.current = cwd;
      termRef.current?.writeln(`\r\n\x1b[2m[cwd: ${cwd}]\x1b[0m`);
      fitRef.current?.fit();
    }
  }, [cwd]);

  useEffect(() => {
    let term: XTermType | null = null;
    let fit: FitAddonType | null = null;
    let disposed = false;
    if (!containerRef.current) return;
    (async () => {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      if (disposed || !containerRef.current) return;
      term = new Terminal({
        cursorBlink: true,
        fontFamily: "JetBrains Mono, ui-monospace, monospace",
        fontSize: 13,
        lineHeight: 1.35,
        theme: { background: "#1c2027", foreground: "#e6e9ee", cursor: "#6d9bff", selectionBackground: "rgba(109,155,255,0.3)" },
        convertEol: true,
        scrollback: 5000,
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current!);
      fit.fit();
      term.writeln("\x1b[1m spark terminal \x1b[0m  — type help");
      term.writeln(`\x1b[2m cwd: ${cwdRef.current} \x1b[0m`);
      term.write("\r\n\x1b[33m" + (cwdRef.current.replace(/.*\//, "") || "/") + "\x1b[0m $ ");
      termRef.current = term;
      fitRef.current = fit;
      const onData = term.onData(async (data) => {
        const code = data.charCodeAt(0);
        if (code === 13) {
          const line = lineBufRef.current;
          term!.writeln("");
          lineBufRef.current = "";
          await handleCommand(line);
          if (!disposed) writePrompt();
          return;
        }
        if (code === 127) {
          if (lineBufRef.current.length > 0) { lineBufRef.current = lineBufRef.current.slice(0, -1); term!.write("\b \b"); }
          return;
        }
        if (code === 3) { term!.writeln("^C"); lineBufRef.current = ""; writePrompt(); return; }
        if (code === 12) { term!.clear(); writePrompt(); return; }
        if (data === "\x1b[A") {
          if (!historyRef.current.length) return;
          histIdxRef.current = Math.max(0, histIdxRef.current - 1);
          const h = historyRef.current[histIdxRef.current] ?? "";
          term!.write("\r\x1b[K\x1b[33m" + (cwdRef.current.replace(/.*\//, "") || "/") + "\x1b[0m $ " + h);
          lineBufRef.current = h; return;
        }
        if (data === "\x1b[B") {
          if (!historyRef.current.length) return;
          histIdxRef.current = Math.min(historyRef.current.length, histIdxRef.current + 1);
          const h = historyRef.current[histIdxRef.current] ?? "";
          term!.write("\r\x1b[K\x1b[33m" + (cwdRef.current.replace(/.*\//, "") || "/") + "\x1b[0m $ " + h);
          lineBufRef.current = h; return;
        }
        if (data >= " " || data === "\t") { lineBufRef.current += data; term!.write(data); }
      });
      const ro = new ResizeObserver(() => fit?.fit());
      ro.observe(containerRef.current!);
      (term as any).__ro = ro;
      (term as any).__onData = onData;
    })();
    return () => {
      disposed = true;
      try { (termRef.current as any)?.__ro?.disconnect(); } catch {}
      try { (termRef.current as any)?.__onData?.dispose(); } catch {}
      try { termRef.current?.dispose(); } catch {}
      termRef.current = null; fitRef.current = null;
    };
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => fitRef.current?.fit(), 60);
    return () => window.clearTimeout(id);
  }, [cwd]);

  useEffect(() => {
    const onResize = () => fitRef.current?.fit();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return null;
}

/* ---------- Standalone terminal for OS window (Tauri/popup/PiP iframe) ---------- */
export function TerminalStandaloneInner({ cwd }: { cwd: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [liveCwd, setLiveCwd] = useState(cwd);

  useEffect(() => { setLiveCwd(cwd); }, [cwd]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.data && e.data.type === "spark:terminal:cwd" && typeof e.data.cwd === "string") setLiveCwd(e.data.cwd);
      if (e.data && e.data.type === "cwd" && typeof e.data.cwd === "string") setLiveCwd(e.data.cwd);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === "spark:terminal:cwd" && e.newValue) setLiveCwd(e.newValue);
    };
    const onCustom = (e: Event) => {
      const d = (e as CustomEvent<{ cwd: string }>).detail;
      if (d?.cwd) setLiveCwd(d.cwd);
    };
    window.addEventListener("message", onMsg);
    window.addEventListener("storage", onStorage);
    window.addEventListener("spark:terminal:cwd" as any, onCustom);
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel("spark-terminal");
      bc.onmessage = (ev) => {
        const d = ev.data as any;
        if (d?.type === "cwd" && typeof d.cwd === "string") setLiveCwd(d.cwd);
        if (d?.type === "spark:terminal:cwd" && typeof d.cwd === "string") setLiveCwd(d.cwd);
      };
    } catch {}
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<string>("terminal:cwd", (ev) => {
          if (typeof ev.payload === "string") setLiveCwd(ev.payload);
        });
      } catch {}
    })();
    return () => {
      window.removeEventListener("message", onMsg);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("spark:terminal:cwd" as any, onCustom);
      try { bc?.close(); } catch {}
      try { unlisten?.(); } catch {}
    };
  }, []);

  return (
    <div style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: "column", background: "#1c2027" }}>
      <div style={{ height: 32, display: "flex", alignItems: "center", gap: 8, padding: "0 10px", background: "#232830", borderBottom: "1px solid #3a4150", color: "#a2abb8", font: "12px Inter,sans-serif" }}>
        <Icon name="terminal" size={14} />
        <span style={{ fontWeight: 600, color: "#e6e9ee" }}>Terminal</span>
        <span style={{ fontFamily: "var(--font-code)", fontSize: 11, color: "#6c7686", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{liveCwd}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex", padding: 6, background: "#1c2027" }}>
        <div ref={containerRef} style={{ flex: 1, minHeight: 0, borderRadius: 8, overflow: "hidden", background: "#1c2027" }} />
        <XTermHost cwd={liveCwd} containerRef={containerRef} />
      </div>
    </div>
  );
}

/* ---------- Independent floating PiP/popup window ---------- */
export function TerminalDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const cwd = useTerminalCwd();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const holderRef = useRef<HTMLDivElement | null>(null);
  const pipWindowRef = useRef<Window | null>(null);
  const popupRef = useRef<Window | null>(null);
  const [isPopped, setIsPopped] = useState(false);
  const [pipSupported, setPipSupported] = useState(false);

  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [size, setSize] = useState({ w: 640, h: 420 });
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setPos({ x: Math.max(12, vw - size.w - 24), y: Math.max(12, vh - size.h - 48) });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    setPipSupported(typeof window !== "undefined" && !!window.documentPictureInPicture);
  }, []);

  // broadcast cwd to external OS window when live and popped
  useEffect(() => {
    if (!isPopped) return;
    try { localStorage.setItem("spark:terminal:cwd", cwd); } catch {}
    // BroadcastChannel
    try {
      const bc = new BroadcastChannel("spark-terminal");
      bc.postMessage({ type: "cwd", cwd });
      bc.close();
    } catch {}
    // postMessage to PiP/popup iframe/window
    try { pipWindowRef.current?.postMessage({ type: "spark:terminal:cwd", cwd }, "*"); } catch {}
    try {
      const iframe = pipWindowRef.current?.document.querySelector("iframe") as HTMLIFrameElement | null;
      iframe?.contentWindow?.postMessage({ type: "spark:terminal:cwd", cwd }, "*");
    } catch {}
    try { popupRef.current?.postMessage({ type: "spark:terminal:cwd", cwd }, "*"); } catch {}
    try { window.dispatchEvent(new CustomEvent("spark:terminal:cwd", { detail: { cwd } })); } catch {}
    // Tauri event
    (async () => {
      try {
        const { emit } = await import("@tauri-apps/api/event");
        await emit("terminal:cwd", cwd);
      } catch {}
    })();
  }, [cwd, isPopped]);

  const popOut = useCallback(async () => {
    if (isPopped) return;
    const url = `index.html?terminal=1&cwd=${encodeURIComponent(cwd)}`;
    // 1) Try native Document PiP — true always-on-top OS window, can be moved outside main bounds
    //    We host the terminal via an <iframe> that loads the terminal-only view,
    //    so the terminal renders natively in the PiP window's own JS context.
    if (window.documentPictureInPicture) {
      try {
        const pipWin = await window.documentPictureInPicture.requestWindow({ width: size.w, height: size.h });
        pipWindowRef.current = pipWin;
        pipWin.document.title = `Terminal — ${cwd}`;
        pipWin.document.body.style.margin = "0";
        pipWin.document.body.style.background = "#1c2027";
        pipWin.document.body.style.height = "100vh";
        pipWin.document.body.style.overflow = "hidden";
        await copyStylesTo(pipWin.document);
        // Use absolute URL so PiP iframe resolves correctly (PiP doc is about:blank)
        const absUrl = new URL(url, window.location.href).toString();
        const iframe = pipWin.document.createElement("iframe");
        iframe.src = absUrl;
        iframe.style.cssText = "width:100%;height:100%;border:none;background:#1c2027;display:block;";
        iframe.allow = "clipboard-read; clipboard-write";
        pipWin.document.body.appendChild(iframe);
        setIsPopped(true);
        const onClose = () => {
          pipWindowRef.current = null;
          setIsPopped(false);
        };
        pipWin.addEventListener("pagehide", onClose);
        pipWin.addEventListener("beforeunload", onClose as any);
        // focus PiP OS window
        try { pipWin.focus(); } catch {}
        return;
      } catch (e) {
        console.warn("[terminal] PiP failed, trying Tauri/popup", e);
      }
    }
    // 2) Tauri: create a true OS window via WebviewWindow
    if (isTauri) {
      try {
        const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const existing = await WebviewWindow.getByLabel("terminal");
        if (existing) {
          try { await existing.setFocus(); } catch {}
          setIsPopped(true);
          return;
        }
        const win = new WebviewWindow("terminal", {
          url,
          title: `Terminal — ${cwd}`,
          width: size.w,
          height: size.h,
          resizable: true,
          decorations: true,
          alwaysOnTop: true,
          center: true,
          focus: true,
        } as any);
        // Tauri window close detection
        win.once("tauri://close-requested", () => setIsPopped(false));
        // also poll in case window is closed externally
        const poll = setInterval(async () => {
          try {
            const w = await WebviewWindow.getByLabel("terminal");
            // getByLabel returns null after close in newer API; if we get a window, check if it's destroyed
            if (!w) { clearInterval(poll); setIsPopped(false); }
          } catch { clearInterval(poll); setIsPopped(false); }
        }, 1000);
        setTimeout(() => clearInterval(poll), 60000);
        setIsPopped(true);
        try { localStorage.setItem("spark:terminal:cwd", cwd); } catch {}
        try {
          const { emit } = await import("@tauri-apps/api/event");
          await emit("terminal:cwd", cwd);
        } catch {}
        return;
      } catch (e) {
        console.warn("[terminal] Tauri window failed, falling back to popup", e);
      }
    }
    // 3) Fallback: window.open popup — also an OS-level window outside main bounds
    try {
      const features = `width=${size.w},height=${size.h},popup=1,noopener`;
      const pop = window.open(url, "spark-terminal", features);
      if (!pop) throw new Error("Popup blocked — allow popups for this site");
      popupRef.current = pop;
      setIsPopped(true);
      try { localStorage.setItem("spark:terminal:cwd", cwd); } catch {}
      const poll = setInterval(() => {
        if (pop.closed) { clearInterval(poll); setIsPopped(false); popupRef.current = null; }
      }, 600);
      try { pop.focus(); } catch {}
    } catch (e) {
      console.warn("[terminal] popup fallback failed", e);
      window.dispatchEvent(new CustomEvent("spark:toast:error" as any, { detail: { title: "Pop out failed", body: String((e as Error)?.message ?? e) } } as any));
    }
  }, [cwd, isPopped, size.w, size.h]);

  const popIn = useCallback(() => {
    const pip = pipWindowRef.current;
    if (pip) { try { pip.close(); } catch {} pipWindowRef.current = null; }
    const pop = popupRef.current;
    if (pop) { try { pop.close(); } catch {} popupRef.current = null; }
    if (isTauri) {
      (async () => {
        try {
          const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
          const w = await WebviewWindow.getByLabel("terminal");
          if (w) await (w as any).close();
        } catch {}
      })();
    }
    setIsPopped(false);
  }, [isTauri]);

  useEffect(() => {
    if (!open) {
      const pip = pipWindowRef.current;
      if (pip) try { pip.close(); } catch {}
      const pop = popupRef.current;
      if (pop) try { pop.close(); } catch {}
      pipWindowRef.current = null;
      popupRef.current = null;
      setIsPopped(false);
      if (isTauri) {
        (async () => {
          try {
            const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
            const w = await WebviewWindow.getByLabel("terminal");
            if (w) await (w as any).close();
          } catch {}
        })();
      }
    }
  }, [open]);

  // detect external window closed externally (user clicks X on OS window)
  useEffect(() => {
    if (!isPopped) return;
    const id = setInterval(() => {
      const pipClosed = pipWindowRef.current ? (pipWindowRef.current as any).closed : false;
      const popClosed = popupRef.current ? popupRef.current.closed : false;
      if ((pipWindowRef.current && pipClosed) || (popupRef.current && popClosed)) {
        pipWindowRef.current = null;
        popupRef.current = null;
        setIsPopped(false);
      }
    }, 700);
    return () => clearInterval(id);
  }, [isPopped]);

  const onHeaderPointerDown = useCallback((e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("button")) return;
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, [pos]);

  const onHeaderPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const nx = Math.max(0, Math.min(window.innerWidth - 80, e.clientX - dragRef.current.dx));
    const ny = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dragRef.current.dy));
    setPos({ x: nx, y: ny });
  }, []);

  const onHeaderPointerUp = useCallback((e: React.PointerEvent) => {
    dragRef.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
  }, []);

  const onResizePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = size.w;
    const startH = size.h;
    const onMove = (ev: PointerEvent) => {
      const nw = Math.max(360, Math.min(window.innerWidth - pos.x - 8, startW + ev.clientX - startX));
      const nh = Math.max(200, Math.min(window.innerHeight - pos.y - 8, startH + ev.clientY - startY));
      setSize({ w: nw, h: nh });
      window.dispatchEvent(new Event("resize"));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.dispatchEvent(new Event("resize"));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [pos, size]);

  if (!open) return null;

  return (
    <div
      className="term term--floating"
      role="dialog"
      aria-label="Terminal"
      aria-modal="false"
      style={{ left: pos.x, top: pos.y, width: size.w, height: size.h }}
    >
      <div
        className="term__header term__header--draggable"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
      >
        <div className="term__title">
          <Icon name="terminal" size={16} />
          <span>Terminal</span>
          <span className="term__cwd" title={cwd}>{cwd}</span>
          {isPopped && <span className="term__badge">floating</span>}
        </div>
        <div className="term__actions">
          {!isPopped ? (
            <button type="button" className="term__btn" title={pipSupported ? "Pop out to always-on-top OS window (PiP)" : "Pop out to separate OS window"} onClick={popOut}>
              <Icon name="external" size={14} />
              <span>Pop out</span>
            </button>
          ) : (
            <button type="button" className="term__btn" title="Bring terminal back into main window" onClick={popIn}>
              <Icon name="sidebar-toggle" size={14} />
              <span>Pop in</span>
            </button>
          )}
          <button type="button" className="term__icon-btn" aria-label="Close terminal" onClick={() => onOpenChange(false)}>
            <Icon name="close" size={16} />
          </button>
        </div>
      </div>

      <div ref={holderRef} className="term__holder">
        {isPopped ? (
          <div className="term__popped-note">
            <Icon name="external" size={18} />
            <div>
              <div className="term__popped-title">Terminal is in floating window</div>
              <div className="term__popped-sub">Main window stays active. The OS window can be moved/resized outside main window bounds.</div>
            </div>
            <button type="button" className="term__btn" onClick={popIn}>Pop in</button>
          </div>
        ) : (
          <>
            <div ref={containerRef} className="term__xterm" />
            <XTermHost cwd={cwd} containerRef={containerRef} />
          </>
        )}
      </div>

      <div className="term__footer">
        <span>help · clear · pwd · ls · cd · echo</span>
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
          {isTauri && (
            <button type="button" className="term__btn" style={{ height: 22, fontSize: 11 }} title={`Open system terminal at ${cwd}`} onClick={() => { void openInTerminal(cwd); }}>
              <Icon name="terminal" size={12} /> System terminal
            </button>
          )}
          <span className="term__hint">{isPopped ? "OS window — main window still active" : pipSupported ? "Drag header to move · Pop out → OS window (outside main bounds)" : "Drag header to move · Pop out → separate OS window"}</span>
        </span>
      </div>

      {!isPopped && <div className="term__resizeHandle" onPointerDown={onResizePointerDown} aria-hidden title="Drag to resize" />}
    </div>
  );
}
