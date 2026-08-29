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
import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "@motion/index";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TitleBar } from "@shell/TitleBar";
import { MenuBar } from "@shell/MenuBar";
import { SideBar } from "@shell/SideBar";
import { PluginRail } from "@shell/PluginRail";
import { Tabs } from "@ui/Tabs";
import { StatusBar } from "@ui/StatusBar";
import { CommandPalette } from "@shell/CommandPalette";
import { CodeEditor } from "@editor/CodeEditor";
import { MarkdownEditor } from "@editor/MarkdownEditor";
import { RichEditor } from "@editor/RichEditor";
import { HtmlPreview } from "@editor/HtmlPreview";
import { SvgEditor } from "@editor/SvgEditor";
import { SplashScreen } from "@shell/SplashScreen";
import { WelcomeWizard } from "@shell/WelcomeWizard";
import { OnboardingScreen } from "@shell/Onboarding";
import { shouldShowWelcome } from "@shell/firstRun";
import { ThemeProvider, useTheme } from "@theme/ThemeProvider";
import { ToastProvider, useToast } from "@ui/Toast";
import { useDocs } from "@store/documents";
import { useExplorer } from "@store/explorer";
import { readFile, recentsAdd, recentsGet, isTauri, pickMode } from "@bridge/commands";
import { checkForUpdates, checkForUpdatesOnBoot } from "@bridge/updater";
import { buildCommands, bindPalette, type CommandSpec, currentRoot, setCurrentRoot } from "@commands/registry";
import { Button } from "@ui/Button";
import { Icon } from "@ui/Icon";
import OpenDialog from "@ui/OpenDialog";
import SaveAsModal from "@shell/SaveAsModal";
import UnsavedChangesModal, { type UnsavedChoice } from "@shell/UnsavedChangesModal";
import "./App.css";

function Shell() {
  const { resolved } = useTheme();
  const toast = useToast();
  const docs = useDocs((s) => s.docs);
  const order = useDocs((s) => s.order);
  const active = useDocs((s) => s.active);
  const setActive = useDocs((s) => s.setActive);
  const open = useDocs((s) => s.open);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showStatus, setShowStatus] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [recents, setRecents] = useState<{ path: string; name: string }[]>([]);

  /* SaveAs modal state */
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [saveAsDocId, setSaveAsDocId] = useState<string | null>(null);
  const [saveAsBusy, setSaveAsBusy] = useState(false);
  const [saveAsError, setSaveAsError] = useState<string | null>(null);

  /* Unsaved-changes modal state */
  const [unsavedOpen, setUnsavedOpen] = useState(false);
  const [unsavedDocId, setUnsavedDocId] = useState<string | null>(null);
  const [unsavedContext, setUnsavedContext] = useState<string>("");
  const [unsavedBusy, setUnsavedBusy] = useState(false);
  const [unsavedError, setUnsavedError] = useState<string | null>(null);

  /* Boot + first-run wizard state */
  const [bootReady, setBootReady] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(false);

  const pendingCloseRef = useRef<(() => void) | null>(null);

  const commandsRef = useRef<CommandSpec[]>([]);
  commandsRef.current = useMemo(() => buildCommands(), [paletteOpen]);

  useEffect(() => { bindPalette({ open: () => setPaletteOpen(true), close: () => setPaletteOpen(false) }); }, []);

  /* Toast bridge: registry runs outside React and dispatches events
     that we forward to the in-tree toast API. */
  useEffect(() => {
    const onSuccess = (e: Event) => {
      const d = (e as CustomEvent<{ title: string; body?: string }>).detail;
      if (d?.title) toast.success(d.title, d.body);
    };
    const onError = (e: Event) => {
      const d = (e as CustomEvent<{ title: string; body?: string }>).detail;
      if (d?.title) toast.error(d.title, d.body);
    };
    window.addEventListener("spark:toast:success", onSuccess);
    window.addEventListener("spark:toast:error", onError);
    return () => {
      window.removeEventListener("spark:toast:success", onSuccess);
      window.removeEventListener("spark:toast:error", onError);
    };
  }, [toast]);

  /* Listen for "open Save As" requests (dispatched by file.save when
     the active doc has no path). */
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ docId: string }>).detail;
      setSaveAsDocId(detail?.docId ?? active ?? null);
      setSaveAsError(null);
      setSaveAsOpen(true);
    };
    window.addEventListener("spark:saveas:open", onOpen);
    return () => window.removeEventListener("spark:saveas:open", onOpen);
  }, [active]);

  /* Tab close request: route through the unsaved-changes guard. */
  useEffect(() => {
    const onClose = (e: Event) => {
      const detail = (e as CustomEvent<{ id: string }>).detail;
      const id = detail?.id;
      if (!id) return;
      const doc = useDocs.getState().docs[id];
      if (!doc) return;
      if (!doc.dirty) {
        useDocs.getState().close(id);
        toast.info("Tab closed");
        return;
      }
      pendingCloseRef.current = () => {
        useDocs.getState().close(id);
        toast.info("Tab closed");
      };
      setUnsavedDocId(id);
      setUnsavedContext("");
      setUnsavedError(null);
      setUnsavedOpen(true);
    };
    window.addEventListener("spark:tab:close:request", onClose);
    return () => window.removeEventListener("spark:tab:close:request", onClose);
  }, [toast]);

  /* Window close request: guard the active doc, then close the Tauri
     window. */
  useEffect(() => {
    const onClose = async () => {
      const id = active;
      const doc = id ? useDocs.getState().docs[id] : null;
      if (!doc?.dirty) {
        try { await getCurrentWindow().close(); } catch {}
        return;
      }
      pendingCloseRef.current = async () => {
        try { await getCurrentWindow().close(); } catch {}
      };
      setUnsavedDocId(id);
      setUnsavedContext("Quitting will discard your unsaved changes.");
      setUnsavedError(null);
      setUnsavedOpen(true);
    };
    window.addEventListener("spark:window:close:request", onClose);
    return () => window.removeEventListener("spark:window:close:request", onClose);
  }, [active]);

  // Boot: refresh recents + open last session (best effort).
  // First run (no recents, nothing open, never onboarded) opens the
  // welcome wizard instead of force-loading the sample document.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let recentsCount = 0;
      try {
        const r = await recentsGet();
        recentsCount = r.length;
        setRecents(r.map((path) => ({ path, name: path.split("/").pop() || path })));
      } catch {}
      if (shouldShowWelcome({ recentsCount, docsOpen: order.length })) {
        if (!cancelled) {
          setWelcomeOpen(true);
          setBootReady(true);
        }
        return;
      }
      try {
        if (order.length === 0) {
          const text = await readFile("/welcome.md");
          const id = open({ name: "welcome.md", path: "/welcome.md", mode: "markdown", raw: text });
          await recentsAdd("/welcome.md").catch(() => {});
        }
      } catch (e: any) {
        toast.error("Could not open welcome document", e?.kind || "Unknown error");
      }
      if (!cancelled) setBootReady(true);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Subscribe the explorer to host file:changed events once.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    useExplorer.getState().subscribeToFileChanges().then((fn) => {
      if (cancelled) { fn(); } else { unlisten = fn; }
    });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // OTA: silent check on boot + manual check via Help → Check for Updates
  useEffect(() => {
    if (isTauri) checkForUpdatesOnBoot(toast);
    const onCheck = () => { void checkForUpdates({ silent: false, onInfo: toast.info, onSuccess: toast.success, onError: toast.error }); };
    window.addEventListener("spark:help:checkForUpdates", onCheck);
    return () => window.removeEventListener("spark:help:checkForUpdates", onCheck);
  }, [toast]);

  // Help → Show Welcome Screen (re-opens the first-run wizard)
  useEffect(() => {
    const onWelcome = () => setWelcomeOpen(true);
    window.addEventListener("spark:help:welcome", onWelcome);
    return () => window.removeEventListener("spark:help:welcome", onWelcome);
  }, []);

  // Folder open: keep the registry's `currentRoot` and the explorer store
  // in sync so the three readers see the same value.
  useEffect(() => {
    const onFolderOpen = (e: Event) => {
      const path = (e as CustomEvent<{ path: string }>).detail?.path;
      if (!path) return;
      setCurrentRoot(path);
      void useExplorer.getState().setRoot(path);
    };
    window.addEventListener("spark:folder:open", onFolderOpen);
    return () => window.removeEventListener("spark:folder:open", onFolderOpen);
  }, []);

  const activeDoc = active ? docs[active] : null;

  const explorerRoot = useExplorer((s) => s.root);
  const explicitRoot = useExplorer((s) => s.explicitRoot);
  useEffect(() => {
    if (explicitRoot) return;
    if (explorerRoot) return;
    const path = activeDoc?.path;
    if (!path) return;
    const parent = path.split(/[\\/]/).slice(0, -1).join("/") || "/";
    void useExplorer.getState().setRoot(parent);
  }, [explicitRoot, explorerRoot, activeDoc?.path]);

  const tabList = order.map((id) => {
    const d = docs[id];
    return {
      id,
      label: d.name + (d.dirty ? "" : ""),
      icon: d.mode === "markdown" ? "mode-markdown" : d.mode === "rich" ? "mode-rich" : d.mode === "html" ? "mode-html" : d.mode === "svg" ? "mode-svg" : "mode-code",
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

      <MenuBar commands={commandsRef.current} hasActiveDoc={!!activeDoc} />

      <div className="app__rail">
        <PluginRail />
      </div>

      <AnimatePresence>
        {showSidebar && (
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
              onRequestOpenFolder={() => {
                window.dispatchEvent(new CustomEvent("spark:command", { detail: { id: "file.openFolder" } }));
              }}
              onInfo={(msg) => toast.info(msg)}
              onError={(title, detail) => toast.error(title, detail)}
            />
          </motion.aside>
        )}
      </AnimatePresence>

      <SplashScreen ready={bootReady} />

      <main className="app__main">
        {order.length > 0 ? (
          <>
            <Tabs
              tabs={tabList}
              activeId={active || ""}
              onSelect={setActive}
              onClose={(id) => { window.dispatchEvent(new CustomEvent("spark:tab:close:request", { detail: { id } })); }}
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
                    {activeDoc.mode === "html"     && <HtmlPreview    docId={activeDoc.id} />}
                    {activeDoc.mode === "svg"      && <SvgEditor      docId={activeDoc.id} />}
                    {activeDoc.mode === "code"     && <CodeEditor     docId={activeDoc.id} />}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </>
        ) : (
          <OnboardingScreen
            recents={recents}
            onCreate={() => commandsRef.current.find(c => c.id === "file.new")?.run()}
            onOpenFolder={() => commandsRef.current.find(c => c.id === "file.openFolder")?.run()}
            onOpenFile={() => commandsRef.current.find(c => c.id === "file.open")?.run()}
            onOpenRecent={async (path) => {
              try {
                const text = await readFile(path);
                open({ name: path.split("/").pop() || path, path, mode: pickMode(path), raw: text });
                await recentsAdd(path).catch(() => {});
              } catch (e: any) {
                toast.error("Open failed", e?.kind || "Unknown error");
              }
            }}
            onPalette={() => commandsRef.current.find(c => c.id === "view.commandPalette")?.run()}
          />
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
      <WelcomeWizard open={welcomeOpen} onOpenChange={setWelcomeOpen} />
      <OpenDialog />
      <SaveAsModal
        open={saveAsOpen}
        onOpenChange={(o) => {
          setSaveAsOpen(o);
          if (!o) { setSaveAsError(null); setSaveAsDocId(null); }
        }}
        currentName={saveAsDocId ? (docs[saveAsDocId]?.name ?? "Untitled") : "Untitled"}
        currentPath={saveAsDocId ? (docs[saveAsDocId]?.path ?? null) : null}
        busy={saveAsBusy}
        errorMessage={saveAsError}
        onConfirm={async (path) => {
          if (!saveAsDocId) return;
          setSaveAsBusy(true);
          setSaveAsError(null);
          const result = await useDocs.getState().saveDocumentAs(saveAsDocId, { defaultPath: path });
          setSaveAsBusy(false);
          if (result.ok) {
            toast.success("File saved");
            setSaveAsOpen(false);
            if (pendingCloseRef.current) {
              const fn = pendingCloseRef.current;
              pendingCloseRef.current = null;
              fn();
            }
          } else if (result.reason === "cancelled") {
            // user closed native dialog with cancel; leave modal open
          } else {
            setSaveAsError(result.error instanceof Error ? result.error.message : String(result.error ?? "Unknown error"));
          }
        }}
      />
      <UnsavedChangesModal
        open={unsavedOpen}
        onOpenChange={(o) => {
          if (!unsavedBusy) {
            setUnsavedOpen(o);
            if (!o) { setUnsavedDocId(null); setUnsavedError(null); pendingCloseRef.current = null; }
          }
        }}
        documentName={unsavedDocId ? (docs[unsavedDocId]?.name ?? "Untitled") : "Untitled"}
        context={unsavedContext}
        busy={unsavedBusy}
        errorMessage={unsavedError}
        onChoose={async (choice: UnsavedChoice) => {
          const id = unsavedDocId;
          if (!id) return;
          if (choice === "cancel") {
            setUnsavedOpen(false);
            pendingCloseRef.current = null;
            return;
          }
          if (choice === "discard") {
            setUnsavedOpen(false);
            const fn = pendingCloseRef.current;
            pendingCloseRef.current = null;
            if (fn) fn();
            return;
          }
          // "save"
          const doc = useDocs.getState().docs[id];
          if (!doc) { setUnsavedOpen(false); return; }
          setUnsavedBusy(true);
          setUnsavedError(null);
          if (!doc.path) {
            setUnsavedBusy(false);
            setUnsavedOpen(false);
            setSaveAsDocId(id);
            setSaveAsError(null);
            setSaveAsOpen(true);
            return;
          }
          const result = await useDocs.getState().saveDocument(id);
          setUnsavedBusy(false);
          if (result.ok) {
            toast.success("File saved");
            setUnsavedOpen(false);
            const fn = pendingCloseRef.current;
            pendingCloseRef.current = null;
            if (fn) fn();
          } else {
            setUnsavedError(result.error instanceof Error ? result.error.message : String(result.error ?? "Unknown error"));
          }
        }}
      />
    </div>
  );
}

function isMac() {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

function isTerminalWindow() {
  try { return new URLSearchParams(window.location.search).has("terminal"); } catch { return false; }
}

function TerminalStandalone() {
  const params = new URLSearchParams(window.location.search);
  const initialCwd = params.get("cwd") || "/";
  // minimal standalone terminal window — used for Tauri pop-out OS window
  // Reuse the same XTerm logic but without the main app chrome
  const [cwd] = useState(initialCwd);
  // listen for cwd updates from main window via postMessage / storage
  const [liveCwd, setLiveCwd] = useState(cwd);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.data && e.data.type === "spark:terminal:cwd" && typeof e.data.cwd === "string") setLiveCwd(e.data.cwd);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === "spark:terminal:cwd" && e.newValue) setLiveCwd(e.newValue);
    };
    window.addEventListener("message", onMsg);
    window.addEventListener("storage", onStorage);
    // also poll for Tauri event
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<string>("terminal:cwd", (ev) => { if (typeof ev.payload === "string") setLiveCwd(ev.payload); });
      } catch {}
    })();
    return () => {
      window.removeEventListener("message", onMsg);
      window.removeEventListener("storage", onStorage);
      try { unlisten?.(); } catch {}
    };
  }, []);
  // lazy import the terminal UI
  const TerminalPanelLazy = React.lazy(() => import("@shell/TerminalPanel").then(m => ({ default: m.TerminalStandaloneInner })));
  return (
    <React.Suspense fallback={<div style={{padding:12,color:"#a2abb8",background:"#1c2027",height:"100vh"}}>Loading terminal…</div>}>
      <TerminalPanelLazy cwd={liveCwd} />
    </React.Suspense>
  );
}

export default function App() {
  if (isTerminalWindow()) {
    return (
      <ThemeProvider>
        <TerminalStandalone />
      </ThemeProvider>
    );
  }
  return (
    <ThemeProvider>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </ThemeProvider>
  );
}
