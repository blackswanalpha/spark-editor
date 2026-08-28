/* ============================================================
   sparkEditor · src/theme/ThemeProvider.tsx
   Reads/writes theme via the bridge; exposes a React context.
   Tauri-aware: on first run the saved preference is loaded via
   the Tauri Store plugin; if not running inside Tauri (dev/preview)
   the renderer falls back to localStorage.
   ============================================================ */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { LazyStore } from "@tauri-apps/plugin-store";
import { listen } from "@tauri-apps/api/event";

export type ThemeId = "light" | "dark" | "navy" | "amber" | "system";

type ThemeCtx = {
  theme: ThemeId;
  resolved: "light" | "dark" | "navy" | "amber"; // navy/amber never collapse
  setTheme: (t: ThemeId) => void;
  cycle: () => void;
};

const Ctx = createContext<ThemeCtx | null>(null);

const ORDER: ThemeId[] = ["light", "dark", "navy", "amber", "system"];
const STORE_KEY = "spark.theme";
const STORE_FILE = "settings.json";

let store: LazyStore | null = null;
function getStore() {
  if (typeof window === "undefined") return null;
  const isTauri = "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
  if (!isTauri) return null;
  if (!store) store = new LazyStore(STORE_FILE, { autoSave: true });
  return store;
}

function readLocal(): ThemeId {
  try {
    const v = localStorage.getItem(STORE_KEY);
    if (v && (ORDER as string[]).includes(v)) return v as ThemeId;
  } catch {}
  return "system";
}
function writeLocal(t: ThemeId) {
  try { localStorage.setItem(STORE_KEY, t); } catch {}
}

function applyToDocument(t: ThemeId) {
  document.documentElement.setAttribute("data-theme", t);
}

function systemPrefers(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolveTheme(t: ThemeId): "light" | "dark" | "navy" | "amber" {
  if (t === "navy") return "navy";
  if (t === "amber") return "amber";
  if (t === "light" || t === "dark") return t;
  return systemPrefers();
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>(() => {
    if (typeof window === "undefined") return "system";
    return readLocal();
  });
  const [resolved, setResolved] = useState<"light" | "dark" | "navy" | "amber">(() => resolveTheme(theme));

  // Apply to <html> on every change
  useEffect(() => {
    applyToDocument(theme);
    setResolved(resolveTheme(theme));
    writeLocal(theme);
    const s = getStore();
    s?.set(STORE_KEY, theme).catch(() => {});
  }, [theme]);

  // React to OS changes when in "system" mode
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolved(resolveTheme("system"));
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, [theme]);

  // Optional: react to Tauri broadcast theme changes
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen?.<ThemeId>("app:theme-changed", (e) => {
      if (e.payload && (ORDER as string[]).includes(e.payload)) setThemeState(e.payload);
    })
      .then((fn) => (unlisten = fn))
      .catch(() => {});
    return () => { try { unlisten?.(); } catch {} };
  }, []);

  // Load persisted theme on boot
  useEffect(() => {
    const s = getStore();
    s?.get<ThemeId>(STORE_KEY)
      .then((v) => {
        if (v && (ORDER as string[]).includes(v)) setThemeState(v as ThemeId);
      })
      .catch(() => {});
  }, []);

  const setTheme = useCallback((t: ThemeId) => setThemeState(t), []);
  const cycle = useCallback(() => {
    setThemeState((prev) => ORDER[(ORDER.indexOf(prev) + 1) % ORDER.length]);
  }, []);

  const value = useMemo<ThemeCtx>(() => ({ theme, resolved, setTheme, cycle }), [theme, resolved, setTheme, cycle]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTheme must be used within <ThemeProvider />");
  return v;
}
