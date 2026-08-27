/* ============================================================
   sparkEditor · src/App.tsx
   Top-level shell.  Wires together:
     • ThemeProvider  (3 themes + system)
     • ToastProvider
     • Splash overlay
     • Custom TitleBar (replaces OS default)
     • Tabs | Sidebar | Editor | StatusBar
     • CommandPalette
   The default OS title bar is suppressed via src-tauri config
   (decorations: false, titleBarStyle: "Overlay" on macOS) so
   the rendered titlebar IS the chrome.
   ============================================================ */
import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "@motion/index";
import { TitleBar } from "@shell/TitleBar";
import { SideBar } from "@shell/SideBar";
import { Tabs } from "@ui/Tabs";
import { StatusBar } from "@ui/StatusBar";
import { CommandPalette } from "@shell/CommandPalette";
import { CodeEditor } from "@editor/CodeEditor";
import { MarkdownEditor } from "@editor/MarkdownEditor";
import { RichEditor } from "@editor/RichEditor";
import { SplashScreen } from "@shell/SplashScreen";
import { ThemeProvider, useTheme } from "@theme/ThemeProvider";
import { ToastProvider, useToast } from "@ui/Toast";
import { useDocs } from "@store/documents";
import { readFile, recentsAdd, recentsGet, isTauri } from "@bridge/commands";
import { buildCommands, bindPalette, type CommandSpec, currentRoot, setCurrentRoot } from "@commands/registry";
import { Button } from "@ui/Button";
import { Icon } from "@ui/Icon";
import OpenDialog from "@ui/OpenDialog";
import "./App.css";

function pickMode(path: string): "markdown" | "rich" | "code" {
  if (/\.(md|markdown)$/i.test(path)) return "markdown";
  if (/\.(html?|json)$/i.test(path)) return "rich";
  return "code";
}

function Shell() {
  const { resolved } = useTheme();
  const toast = useToast();
  const docs = useDocs((s) => s.docs);
  const order = useDocs((s) => s.order);
  const active = useDocs((s) => s.active);
  const setActive = useDocs((s) => s.setActive);
  const close = useDocs((s) => s.close);
  const open = useDocs((s) => s.open);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showStatus, setShowStatus] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [recents, setRecents] = useState<{ path: string; name: string }[]>([]);
  const [root, setRoot] = useState<string | null>(currentRoot);

  const commandsRef = useRef<CommandSpec[]>([]);
  commandsRef.current = useMemo(() => buildCommands(), [paletteOpen]); // rebuild when palette visibility toggles

  useEffect(() => { bindPalette({ open: () => setPaletteOpen(true), close: () => setPaletteOpen(false) }); }, []);

  // Boot: refresh recents + open last session (best effort)
  useEffect(() => {
    (async () => {
      try {
        const r = await recentsGet();
        setRecents(r.map((path) => ({ path, name: path.split("/").pop() || path })));
      } catch {}
      // Open a welcome doc on first run
      try {
        if (order.length === 0) {
          const text = await readFile("/welcome.md");
          const id = open({ name: "welcome.md", path: "/welcome.md", mode: "markdown", raw: text });
          await recentsAdd("/welcome.md").catch(() => {});
        }
      } catch (e: any) {
        toast.error("Could not open welcome document", e?.kind || "Unknown error");
      }
    })();
  }, []);

  // Global keybindings
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMod = isMac() ? e.metaKey : e.ctrlKey;
      if (isMod && e.shiftKey && (e.key === "P" || e.key === "p")) { e.preventDefault(); setPaletteOpen(true); }
      else if (isMod && (e.key === "s" || e.key === "S")) { e.preventDefault(); commandsRef.current.find(c => c.id === "file.save")?.run(); }
      else if (isMod && (e.key === "n" || e.key === "N")) { e.preventDefault(); commandsRef.current.find(c => c.id === "file.new")?.run(); }
      else if (isMod && (e.key === "w" || e.key === "W")) { e.preventDefault(); commandsRef.current.find(c => c.id === "tab.close")?.run(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Listen to "spark:command" events from menus
  useEffect(() => {
    const onCmd = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      if (!id) return;
      const c = commandsRef.current.find((x) => x.id === id);
      c?.run();
    };
    window.addEventListener("spark:command", onCmd);
    return () => window.removeEventListener("spark:command", onCmd);
  }, []);

  // Sidebar/Status bar toggles
  useEffect(() => {
    const sb = () => setShowSidebar((v) => !v);
    const st = () => setShowStatus((v) => !v);
    window.addEventListener("spark:toggleSidebar", sb);
    window.addEventListener("spark:toggleStatusBar", st);
    return () => {
      window.removeEventListener("spark:toggleSidebar", sb);
      window.removeEventListener("spark:toggleStatusBar", st);
    };
  }, []);

  // Folder open
  useEffect(() => {
    const onFolderOpen = (e: Event) => {
      const ev = e as CustomEvent<{ path: string }>;
      if (!ev.detail?.path) return;
      setRoot(ev.detail.path);
      setCurrentRoot(ev.detail.path);
    };
    window.addEventListener("spark:folder:open", onFolderOpen);
    return () => window.removeEventListener("spark:folder:open", onFolderOpen);
  }, []);

  const activeDoc = active ? docs[active] : null;
  const tabList = order.map((id) => {
    const d = docs[id];
    return {
      id,
      label: d.name + (d.dirty ? "" : ""),
      icon: d.mode === "markdown" ? "mode-markdown" : d.mode === "rich" ? "mode-rich" : "mode-code",
      dirty: d.dirty,
      closable: true,
    };
  });

  return (
    <div className="app" data-theme-resolved={resolved}>
      <TitleBar
        title={activeDoc?.name || "Untitled"}
        dirty={activeDoc?.dirty}
        platform={isTauri ? (navigator.userAgent.includes("Mac") ? "macos" : "windows") : "windows"}
      />

      <AnimatePresence>
        {showSidebar && order.length > 0 && (
          <motion.aside
            key="sidebar"
            className="app__sidebar"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 260, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.2, 0.6, 0.3, 1] }}
          >
            <SideBar
              recents={recents}
              onOpen={async (path) => {
                try {
                  const text = await readFile(path);
                  open({ name: path.split("/").pop() || path, path, mode: pickMode(path), raw: text });
                  await recentsAdd(path).catch(() => {});
                } catch (e: any) {
                  toast.error("Open failed", e?.kind || "Unknown error");
                }
              }}
              activePath={activeDoc?.path || undefined}
            />
          </motion.aside>
        )}
      </AnimatePresence>

      <main className="app__main">
        <SplashScreen />
        {order.length > 0 ? (
          <>
            <Tabs
              tabs={tabList}
              activeId={active || ""}
              onSelect={setActive}
              onClose={(id) => { close(id); toast.info("Tab closed"); }}
            />
            <div className="app__editor">
              <AnimatePresence mode="wait">
                {activeDoc && (
                  <motion.div
                    key={activeDoc.id + activeDoc.mode}
                    className="app__editor-inner"
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -2 }}
                    transition={{ duration: 0.14 }}
                  >
                    {activeDoc.mode === "markdown" && <MarkdownEditor docId={activeDoc.id} />}
                    {activeDoc.mode === "rich"     && <RichEditor     docId={activeDoc.id} />}
                    {activeDoc.mode === "code"     && <CodeEditor     docId={activeDoc.id} />}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </>
        ) : (
          <EmptyState onCreate={() => commandsRef.current.find(c => c.id === "file.new")?.run()} />
        )}
      </main>

      <AnimatePresence>
        {showStatus && activeDoc && (
          <motion.div
            key="status"
            className="app__status-wrap"
            initial={{ y: 24, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 24, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.2, 0.6, 0.3, 1] }}
          >
            <StatusBar
              mode={activeDoc.mode}
              language={activeDoc.language}
              line={activeDoc.cursor.line}
              col={activeDoc.cursor.col}
              dirty={activeDoc.dirty}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        commands={commandsRef.current}
      />
      <OpenDialog />
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="empty">
      <img src="/spark-mark.svg" alt="" width={64} height={64} className="empty__logo" />
      <h1 className="empty__title">sparkEditor</h1>
      <p className="empty__sub">Open a file, or start a new document to begin.</p>
      <div className="empty__actions">
        <Button variant="primary" icon="plus" onClick={onCreate}>New document</Button>
        <Button variant="secondary" icon="folder" onClick={() => window.dispatchEvent(new CustomEvent("spark:command", { detail: { id: "file.open" } }))}>
          Open…
        </Button>
        <Button variant="ghost" icon="command" onClick={() => window.dispatchEvent(new CustomEvent("spark:command", { detail: { id: "view.commandPalette" } }))}>
          Command palette
        </Button>
      </div>
      <p className="empty__hint">
        <kbd>{isMac() ? "⌘" : "Ctrl"}</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd> to open the command palette
      </p>
    </div>
  );
}

function isMac() {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </ThemeProvider>
  );
}
