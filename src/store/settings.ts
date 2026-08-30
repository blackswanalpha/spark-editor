/* ============================================================
   sparkEditor · src/store/settings.ts

   User settings: appearance, editor and terminal preferences.

   Persistence mirrors ThemeProvider — the Tauri Store plugin
   (settings.json) when running in the app, localStorage when not.
   Both are written: localStorage is what the pop-out terminal
   window reads synchronously on boot, before the async Tauri read
   resolves, so the pop-out never paints with default sizes first.

   Live sync across windows goes over the Tauri event bus
   ("app:settings-changed"), the same channel the theme uses.
   ============================================================ */
import { create } from "zustand";
import { LazyStore } from "@tauri-apps/plugin-store";
import { emit, listen } from "@tauri-apps/api/event";
import type { PtyPrivilege } from "@bridge/pty";

/* ---------- Shape ---------- */

export type Density = "comfortable" | "compact";
export type TerminalCursorStyle = "block" | "bar" | "underline";

export interface AppearanceSettings {
  density: Density;
  /** Multiplier applied to the --size-* type scale. */
  uiFontScale: number;
}

export interface EditorSettings {
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
  lineNumbers: boolean;
}

export interface TerminalSettings {
  fontSize: number;
  lineHeight: number;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  /** Rows scrolled per wheel notch. */
  scrollRows: number;
  /** Privilege a freshly opened terminal starts with. */
  defaultPrivilege: PtyPrivilege;
  /** Viewport the "Mobile" toggle snaps the terminal to. */
  mobileWidth: number;
  mobileHeight: number;
}

export interface Settings {
  appearance: AppearanceSettings;
  editor: EditorSettings;
  terminal: TerminalSettings;
}

export const DEFAULTS: Settings = {
  appearance: { density: "comfortable", uiFontScale: 1 },
  editor: { fontSize: 13.5, tabSize: 2, wordWrap: true, lineNumbers: true },
  terminal: {
    fontSize: 13,
    lineHeight: 1.35,
    cursorStyle: "block",
    cursorBlink: true,
    scrollRows: 3,
    defaultPrivilege: "user",
    mobileWidth: 450,
    mobileHeight: 844,
  },
};

/** Device presets offered by the mobile toggle's picker. */
export const MOBILE_PRESETS: { id: string; label: string; w: number; h: number }[] = [
  // Wider than any real handset on purpose: it is the default because a
  // 390px grid is about 44 columns, which wraps most command output.
  { id: "wide", label: "Wide", w: 450, h: 844 },
  { id: "iphone-se", label: "iPhone SE", w: 375, h: 667 },
  { id: "iphone-14", label: "iPhone 14", w: 390, h: 844 },
  { id: "iphone-pro-max", label: "iPhone 15 Pro Max", w: 430, h: 932 },
  { id: "pixel-7", label: "Pixel 7", w: 412, h: 915 },
  { id: "galaxy-s22", label: "Galaxy S22", w: 360, h: 780 },
];

/* ---------- Bounds ----------
   Every numeric control is clamped on write rather than trusted from
   the input, because these values reach CSS and the pty geometry: a
   font size of 0 makes the terminal compute an infinite column count. */

const LIMITS = {
  uiFontScale: [0.85, 1.4],
  editorFontSize: [10, 28],
  tabSize: [1, 8],
  terminalFontSize: [9, 24],
  terminalLineHeight: [1, 2],
  scrollRows: [1, 12],
  mobileWidth: [280, 640],
  mobileHeight: [400, 1200],
} as const;

function clamp(n: number, [lo, hi]: readonly [number, number], fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/* ---------- Merge ----------
   Persisted JSON is untrusted: it may come from an older version that
   never wrote a key, or a hand-edited settings.json. Every field is
   validated against the default rather than spread wholesale. */

function coerce(raw: unknown): Settings {
  const r = (raw ?? {}) as Partial<Settings>;
  const a = (r.appearance ?? {}) as Partial<AppearanceSettings>;
  const e = (r.editor ?? {}) as Partial<EditorSettings>;
  const t = (r.terminal ?? {}) as Partial<TerminalSettings>;
  const d = DEFAULTS;

  return {
    appearance: {
      density: a.density === "compact" ? "compact" : "comfortable",
      uiFontScale: clamp(Number(a.uiFontScale), LIMITS.uiFontScale, d.appearance.uiFontScale),
    },
    editor: {
      fontSize: clamp(Number(e.fontSize), LIMITS.editorFontSize, d.editor.fontSize),
      tabSize: Math.round(clamp(Number(e.tabSize), LIMITS.tabSize, d.editor.tabSize)),
      wordWrap: typeof e.wordWrap === "boolean" ? e.wordWrap : d.editor.wordWrap,
      lineNumbers: typeof e.lineNumbers === "boolean" ? e.lineNumbers : d.editor.lineNumbers,
    },
    terminal: {
      fontSize: clamp(Number(t.fontSize), LIMITS.terminalFontSize, d.terminal.fontSize),
      lineHeight: clamp(Number(t.lineHeight), LIMITS.terminalLineHeight, d.terminal.lineHeight),
      cursorStyle:
        t.cursorStyle === "bar" || t.cursorStyle === "underline" ? t.cursorStyle : "block",
      cursorBlink: typeof t.cursorBlink === "boolean" ? t.cursorBlink : d.terminal.cursorBlink,
      scrollRows: Math.round(clamp(Number(t.scrollRows), LIMITS.scrollRows, d.terminal.scrollRows)),
      defaultPrivilege: t.defaultPrivilege === "root" ? "root" : "user",
      mobileWidth: Math.round(clamp(Number(t.mobileWidth), LIMITS.mobileWidth, d.terminal.mobileWidth)),
      mobileHeight: Math.round(
        clamp(Number(t.mobileHeight), LIMITS.mobileHeight, d.terminal.mobileHeight),
      ),
    },
  };
}

/* ---------- Persistence ---------- */

const STORE_FILE = "settings.json";
const STORE_KEY = "spark.settings";
const EVENT = "app:settings-changed";

function inTauri(): boolean {
  if (typeof window === "undefined") return false;
  return "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
}

let tauriStore: LazyStore | null = null;
function getStore(): LazyStore | null {
  if (!inTauri()) return null;
  if (!tauriStore) tauriStore = new LazyStore(STORE_FILE, { autoSave: true });
  return tauriStore;
}

/* `emit` and `listen` reach through window.__TAURI_INTERNALS__ and throw
   synchronously when it is absent, so they are gated rather than
   try/caught — a browser preview must not lose settings changes to a
   thrown broadcast. */
function broadcast(next: Settings) {
  if (!inTauri()) return;
  void emit(EVENT, next).catch(() => {});
}

function subscribeToBroadcast(handler: (s: Settings) => void): Promise<() => void> {
  if (!inTauri()) return Promise.resolve(() => {});
  return listen<Settings>(EVENT, (e) => handler(e.payload)).catch(() => () => {});
}

function readLocal(): Settings {
  try {
    const v = localStorage.getItem(STORE_KEY);
    return coerce(v ? JSON.parse(v) : null);
  } catch {
    return coerce(null);
  }
}

function writeLocal(s: Settings) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* private mode / quota — the in-memory settings still apply */
  }
}

/* ---------- CSS application ----------
   Appearance is the one section with no React consumer: the type scale
   and density live in CSS tokens, so the store writes them onto <html>
   and every component that already reads --size-* follows. */

export function applyAppearance(a: AppearanceSettings) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const base = { xs: 11, sm: 12, md: 13.5, lg: 16, xl: 20, "2xl": 26 };
  for (const [k, px] of Object.entries(base)) {
    root.style.setProperty(`--size-${k}`, `${round2(px * a.uiFontScale)}px`);
  }
  root.setAttribute("data-density", a.density);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ---------- Store ---------- */

interface SettingsState {
  settings: Settings;
  /** True once the Tauri-backed read has resolved (or been ruled out). */
  hydrated: boolean;
  setAppearance: (patch: Partial<AppearanceSettings>) => void;
  setEditor: (patch: Partial<EditorSettings>) => void;
  setTerminal: (patch: Partial<TerminalSettings>) => void;
  resetSection: (section: keyof Settings) => void;
  resetAll: () => void;
}

/** Persist + broadcast. Called on every mutation, never on remote echo. */
function persist(next: Settings) {
  writeLocal(next);
  getStore()?.set(STORE_KEY, next).catch(() => {});
  broadcast(next);
}

export const useSettings = create<SettingsState>((set, get) => {
  const initial = typeof window === "undefined" ? DEFAULTS : readLocal();
  applyAppearance(initial.appearance);

  const patch = (section: keyof Settings, values: Record<string, unknown>) => {
    const prev = get().settings;
    const next = coerce({ ...prev, [section]: { ...prev[section], ...values } });
    if (JSON.stringify(next) === JSON.stringify(prev)) return;
    if (section === "appearance") applyAppearance(next.appearance);
    set({ settings: next });
    persist(next);
  };

  return {
    settings: initial,
    hydrated: false,
    setAppearance: (p) => patch("appearance", p as Record<string, unknown>),
    setEditor: (p) => patch("editor", p as Record<string, unknown>),
    setTerminal: (p) => patch("terminal", p as Record<string, unknown>),
    resetSection: (section) =>
      patch(section, DEFAULTS[section] as unknown as Record<string, unknown>),
    resetAll: () => {
      applyAppearance(DEFAULTS.appearance);
      set({ settings: DEFAULTS });
      persist(DEFAULTS);
    },
  };
});

/** Adopt settings written by another window without re-broadcasting. */
function adopt(raw: unknown) {
  const next = coerce(raw);
  const prev = useSettings.getState().settings;
  if (JSON.stringify(next) === JSON.stringify(prev)) return;
  applyAppearance(next.appearance);
  useSettings.setState({ settings: next });
  writeLocal(next);
}

/**
 * Boot-time hydration. Safe to call from more than one window; each
 * reads the same file and the last writer does not clobber, because
 * this path never persists.
 */
export function hydrateSettings(): () => void {
  let cancelled = false;
  let unlisten: (() => void) | null = null;

  getStore()
    ?.get<Settings>(STORE_KEY)
    .then((v) => {
      if (cancelled || v == null) return;
      adopt(v);
    })
    .catch(() => {})
    .finally(() => {
      if (!cancelled) useSettings.setState({ hydrated: true });
    });

  if (!getStore()) useSettings.setState({ hydrated: true });

  void subscribeToBroadcast((payload) => {
    if (cancelled) return;
    adopt(payload);
  }).then((fn) => {
    if (cancelled) fn();
    else unlisten = fn;
  });

  return () => {
    cancelled = true;
    unlisten?.();
  };
}

/* Non-React readers (command registry, imperative helpers). */
export const getSettings = () => useSettings.getState().settings;

export { LIMITS };
