/* ============================================================
   sparkBook · src/theme/ThemeProvider.tsx
   Reads/writes theme via the bridge; exposes a React context.
   Tauri-aware: on first run the saved preference is loaded via
   the Tauri Store plugin; if not running inside Tauri (dev/preview)
   the renderer falls back to localStorage.

   Boot order matters here. The pre-paint script in index.html has
   already stamped data-theme from localStorage, so the first frame
   is correct. This provider must therefore NOT write the store
   until the Tauri read has resolved — otherwise a window whose
   localStorage is empty (a fresh profile, cleared site data, or the
   pop-out terminal) persists "system" over the real preference in
   settings.json before it has ever been read.
   ============================================================ */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { LazyStore } from "@tauri-apps/plugin-store";
import { emit, listen } from "@tauri-apps/api/event";

export type ThemeId = "light" | "dark" | "navy" | "amber" | "red" | "system";
/** A theme that actually has a palette — "system" always resolves to one of these. */
export type ResolvedTheme = Exclude<ThemeId, "system">;

type ThemeCtx = {
  theme: ThemeId;
  resolved: ResolvedTheme; // navy/amber/red never collapse
  /** True when the resolved palette is a dark one. Drives CodeMirror's `dark` flag. */
  isDark: boolean;
  setTheme: (t: ThemeId) => void;
  cycle: () => void;
};

const Ctx = createContext<ThemeCtx | null>(null);

const ORDER: ThemeId[] = ["light", "dark", "navy", "amber", "red", "system"];
const STORE_KEY = "spark.theme";
const STORE_FILE = "settings.json";
const EVENT = "app:theme-changed";

/** The single source of truth for "is this palette dark?".
    Amber is a light theme despite not being called "light" — the old
    `resolved !== "light"` test got that wrong and handed CodeMirror its
    dark defaults on a cream background. */
const DARK_THEMES = new Set<ResolvedTheme>(["dark", "navy", "red"]);
export function isDarkTheme(t: ResolvedTheme): boolean {
  return DARK_THEMES.has(t);
}

export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === "string" && (ORDER as string[]).includes(v);
}

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
    if (isThemeId(v)) return v;
  } catch {
    /* private mode / disabled storage — fall through to the default */
  }
  return "system";
}

function writeLocal(t: ThemeId) {
  try {
    localStorage.setItem(STORE_KEY, t);
  } catch {
    /* private mode / quota — the in-memory theme still applies */
  }
}

function applyToDocument(t: ThemeId) {
  document.documentElement.setAttribute("data-theme", t);
}

function systemPrefers(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolveTheme(t: ThemeId): ResolvedTheme {
  return t === "system" ? systemPrefers() : t;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>(() =>
    typeof window === "undefined" ? "system" : readLocal(),
  );
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(theme));

  /* Persistence is armed only after the Tauri read has resolved (or been
     ruled out), and suppressed for a change that arrived from persistence
     or from another window — echoing it back would be a redundant write. */
  const hydrated = useRef(false);
  const echo = useRef(false);

  /* Apply to <html> on every change. The pre-paint script already set the
     attribute for the first frame; this keeps it in step afterwards. */
  useEffect(() => {
    applyToDocument(theme);
    setResolved(resolveTheme(theme));

    if (!hydrated.current) return;
    writeLocal(theme);
    if (echo.current) {
      echo.current = false;
      return;
    }
    getStore()?.set(STORE_KEY, theme).catch(() => {});
    emit?.(EVENT, theme).catch(() => {});
  }, [theme]);

  /* Load the persisted theme, then arm persistence. */
  useEffect(() => {
    const s = getStore();
    if (!s) {
      hydrated.current = true;
      writeLocal(theme);
      return;
    }
    let cancelled = false;
    s.get<ThemeId>(STORE_KEY)
      .then((v) => {
        if (cancelled) return;
        if (isThemeId(v) && v !== theme) {
          echo.current = true;
          setThemeState(v);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) hydrated.current = true;
      });
    return () => {
      cancelled = true;
    };
    // Boot-only: `theme` is read once as the pre-hydration value on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* React to OS changes when in "system" mode */
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolved(resolveTheme("system"));
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, [theme]);

  /* Follow theme changes broadcast by another window (the pop-out
     terminal). setTheme now emits this, so the channel is live. */
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen?.<ThemeId>(EVENT, (e) => {
      if (!isThemeId(e.payload)) return;
      setThemeState((prev) => {
        if (prev === e.payload) return prev;
        echo.current = true;
        return e.payload;
      });
    })
      .then((fn) => (unlisten = fn))
      .catch(() => {});
    return () => {
      try {
        unlisten?.();
      } catch {
        /* the listener was never registered (non-Tauri preview) */
      }
    };
  }, []);

  const setTheme = useCallback((t: ThemeId) => {
    if (isThemeId(t)) setThemeState(t);
  }, []);

  const cycle = useCallback(() => {
    setThemeState((prev) => ORDER[(ORDER.indexOf(prev) + 1) % ORDER.length]);
  }, []);

  const value = useMemo<ThemeCtx>(
    () => ({ theme, resolved, isDark: isDarkTheme(resolved), setTheme, cycle }),
    [theme, resolved, setTheme, cycle],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTheme must be used within <ThemeProvider />");
  return v;
}
