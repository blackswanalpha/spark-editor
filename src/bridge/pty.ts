/* ============================================================
   sparkEditor · src/bridge/pty.ts

   Typed bridge to the Rust PTY host (src-tauri/src/pty.rs).

   The host owns terminal emulation: it runs the shell, parses the
   VT stream and pushes resolved cell grids. This module only moves
   bytes and frames across the IPC boundary — there is no terminal
   emulator in the renderer.

   Outside Tauri every call rejects with `PtyUnavailable` so the
   terminal UI can show one honest message instead of pretending a
   shell exists in the browser.
   ============================================================ */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "@bridge/commands";

/* ---------- Wire types (mirror pty.rs) ---------- */

export type PtyPrivilege = "user" | "root";

export interface PtySpan {
  /** Column this run starts at (0-based). */
  col: number;
  text: string;
  /** `#rrggbb`, or absent for the theme default. */
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export interface PtyRow {
  y: number;
  spans: PtySpan[];
}

export interface PtyFrame {
  id: string;
  rows: number;
  cols: number;
  /** Changed rows only, unless `full`. */
  lines: PtyRow[];
  full: boolean;
  cursorRow: number;
  cursorCol: number;
  cursorVisible: boolean;
  title?: string;
  applicationCursor: boolean;
  bracketedPaste: boolean;
  scrollback: number;
  seq: number;
}

export interface PtyExit {
  id: string;
  code: number;
  message?: string;
}

export interface PtySessionInfo {
  id: string;
  shell: string;
  cwd: string;
  privilege: PtyPrivilege;
  rows: number;
  cols: number;
}

export interface RootSupport {
  available: boolean;
  /** "pkexec" | "sudo" | "none" */
  method: string;
  alreadyRoot: boolean;
}

export class PtyUnavailable extends Error {
  constructor() {
    super("Terminal sessions need the desktop app — there is no shell in a browser tab.");
    this.name = "PtyUnavailable";
  }
}

function host<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) return Promise.reject(new PtyUnavailable());
  return invoke<T>(cmd, args);
}

/* ---------- Commands ---------- */

export function ptySpawn(opts: {
  cwd: string;
  rows?: number;
  cols?: number;
  shell?: string;
  privilege?: PtyPrivilege;
}): Promise<PtySessionInfo> {
  return host<PtySessionInfo>("pty_spawn", {
    cwd: opts.cwd,
    rows: opts.rows,
    cols: opts.cols,
    shell: opts.shell,
    privilege: opts.privilege ?? "user",
  });
}

export const ptyWrite = (id: string, data: string) => host<void>("pty_write", { id, data });
export const ptyResize = (id: string, rows: number, cols: number) =>
  host<void>("pty_resize", { id, rows, cols });
export const ptyRefresh = (id: string) => host<void>("pty_refresh", { id });
export const ptyKill = (id: string) => host<void>("pty_kill", { id });
export const ptyList = () => host<PtySessionInfo[]>("pty_list");
export const ptyRootSupport = () => host<RootSupport>("pty_root_support");
export const ptyDefaultShell = () => host<string>("pty_default_shell");

/** Scroll the viewport into scrollback. Positive `delta` = older output. */
export const ptyScroll = (id: string, delta: number, absolute?: number) =>
  host<number>("pty_scroll", { id, delta, absolute });

/* ---------- Events ---------- */

async function subscribe<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (!isTauri) return () => {};
  try {
    return await listen<T>(event, (e) => handler(e.payload));
  } catch {
    return () => {};
  }
}

/**
 * Frames carrying changed rows. `pty://cursor` delivers the cheaper
 * cursor-only updates; both are handed to the same handler because the
 * renderer applies them identically.
 */
export async function onPtyFrame(handler: (f: PtyFrame) => void): Promise<UnlistenFn> {
  const [a, b] = await Promise.all([
    subscribe<PtyFrame>("pty://frame", handler),
    subscribe<PtyFrame>("pty://cursor", handler),
  ]);
  return () => {
    a();
    b();
  };
}

export const onPtyExit = (handler: (e: PtyExit) => void) => subscribe<PtyExit>("pty://exit", handler);

/* ---------- Key encoding ----------

   Translating a DOM KeyboardEvent into the bytes a real tty expects.
   Kept here (not in the component) so it is testable without a DOM
   renderer, and so the popped-out terminal window shares one
   implementation.
*/

const CSI = "\x1b[";
const SS3 = "\x1bO";

const FN_KEYS: Record<string, string> = {
  F1: `${SS3}P`,
  F2: `${SS3}Q`,
  F3: `${SS3}R`,
  F4: `${SS3}S`,
  F5: `${CSI}15~`,
  F6: `${CSI}17~`,
  F7: `${CSI}18~`,
  F8: `${CSI}19~`,
  F9: `${CSI}20~`,
  F10: `${CSI}21~`,
  F11: `${CSI}23~`,
  F12: `${CSI}24~`,
};

const ARROWS: Record<string, string> = {
  ArrowUp: "A",
  ArrowDown: "B",
  ArrowRight: "C",
  ArrowLeft: "D",
};

export interface KeyContext {
  /** DECCKM — from the latest frame. */
  applicationCursor: boolean;
}

/**
 * Encode a key press as terminal input, or return `null` when the key
 * carries no bytes (a bare modifier, or a shortcut the UI handles).
 */
export function encodeKey(e: KeyboardEvent, ctx: KeyContext): string | null {
  const { key, ctrlKey, altKey, metaKey, shiftKey } = e;

  // Bare modifiers produce nothing.
  if (key === "Shift" || key === "Control" || key === "Alt" || key === "Meta" || key === "CapsLock") {
    return null;
  }

  // Cmd/Super shortcuts belong to the app (copy, paste, close), never the tty.
  if (metaKey) return null;

  const arrow = ARROWS[key];
  if (arrow) {
    if (ctrlKey || altKey || shiftKey) {
      // xterm's modifyOtherKeys form: CSI 1 ; <mod> <final>
      const mod = 1 + (shiftKey ? 1 : 0) + (altKey ? 2 : 0) + (ctrlKey ? 4 : 0);
      return `${CSI}1;${mod}${arrow}`;
    }
    return ctx.applicationCursor ? `${SS3}${arrow}` : `${CSI}${arrow}`;
  }

  if (FN_KEYS[key]) return FN_KEYS[key];

  switch (key) {
    case "Enter":
      return "\r";
    case "Tab":
      return shiftKey ? `${CSI}Z` : "\t";
    case "Backspace":
      // ctrl+backspace deletes the previous word (readline's ESC DEL).
      return ctrlKey ? "\x1b\x7f" : "\x7f";
    case "Escape":
      return "\x1b";
    case "Delete":
      return `${CSI}3~`;
    case "Insert":
      return `${CSI}2~`;
    case "Home":
      return ctx.applicationCursor ? `${SS3}H` : `${CSI}H`;
    case "End":
      return ctx.applicationCursor ? `${SS3}F` : `${CSI}F`;
    case "PageUp":
      return `${CSI}5~`;
    case "PageDown":
      return `${CSI}6~`;
    default:
      break;
  }

  // Ctrl+<letter> and the ctrl punctuation range.
  if (ctrlKey && !altKey && key.length === 1) {
    const c = key.toLowerCase();
    if (c >= "a" && c <= "z") {
      return String.fromCharCode(c.charCodeAt(0) - 96);
    }
    const punct: Record<string, string> = {
      "@": "\x00",
      "[": "\x1b",
      "\\": "\x1c",
      "]": "\x1d",
      "^": "\x1e",
      _: "\x1f",
      " ": "\x00",
      "?": "\x7f",
    };
    if (punct[key]) return punct[key];
    return null;
  }

  // Alt+<char> is ESC-prefixed (readline's meta).
  if (altKey && key.length === 1) return `\x1b${key}`;

  // Any single printable character.
  if (key.length === 1) return key;

  return null;
}

/** Wrap pasted text for bracketed-paste-aware programs (vim, fish, zsh). */
export function encodePaste(text: string, bracketed: boolean): string {
  // Normalise line endings: a tty expects CR, and a stray CRLF would
  // submit twice.
  const normalized = text.replace(/\r\n/g, "\r").replace(/\n/g, "\r");
  return bracketed ? `${CSI}200~${normalized}${CSI}201~` : normalized;
}
