/* ============================================================
   sparkEditor · src/store/terminal.ts
   Terminal UI store — panel visibility, the list of open terminal
   sessions, which one is in front, and whether the panel is pinned
   to the mobile viewport.

   The shells themselves live in the Rust host; this store only
   holds what the panel needs to decide which sessions to show and
   what to spawn them with. The transitions are in
   shell/Terminal/sessions.ts, shared with the pop-out window.
   ============================================================ */
import { create } from "zustand";
import { useExplorer } from "@store/explorer";
import { getSettings } from "@store/settings";
import {
  closeSession as removeSession,
  createSession,
  findByCwd,
  nextActiveAfterClose,
  patchSession,
  type TerminalSession,
} from "@shell/Terminal/sessions";
import type { PtyPrivilege } from "@bridge/pty";

interface TerminalState {
  isOpen: boolean;
  sessions: TerminalSession[];
  activeId: string | null;
  /** Name for the next tab. Never decremented, so names are not reused. */
  nextOrdinal: number;
  /** Panel pinned to the mobile viewport from Settings → Terminal. */
  mobile: boolean;

  open: () => void;
  close: () => void;
  toggle: () => void;
  /** Open the panel with a session at `cwd`, reusing one already there. */
  openAt: (cwd: string) => void;
  /** Create the first session if the panel opened without one. */
  ensureSession: (cwd: string) => void;
  /** The "+" button: always a new tab, always focused. */
  addSession: (cwd: string) => void;
  closeSession: (id: string) => void;
  setActiveSession: (id: string) => void;
  setPrivilege: (id: string, p: PtyPrivilege) => void;
  restartSession: (id: string) => void;
  setSessionTitle: (id: string, title: string | null) => void;
  setMobile: (m: boolean) => void;
}

const defaultPrivilege = () => getSettings().terminal.defaultPrivilege;

export const useTerminal = create<TerminalState>((set) => ({
  isOpen: false,
  sessions: [],
  activeId: null,
  nextOrdinal: 1,
  mobile: false,

  // Opening does not spawn anything: the panel derives the cwd from the
  // explorer and calls ensureSession once it has one.
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((s) => ({ isOpen: !s.isOpen })),

  openAt: (cwd) =>
    set((s) => {
      // Clicking "Open in Terminal" on the same folder twice should land
      // you back in that shell, not stack duplicate tabs.
      const existing = findByCwd(s.sessions, cwd);
      if (existing) return { isOpen: true, activeId: existing.id };
      const session = createSession(cwd, defaultPrivilege(), s.nextOrdinal);
      return {
        isOpen: true,
        sessions: [...s.sessions, session],
        activeId: session.id,
        nextOrdinal: s.nextOrdinal + 1,
      };
    }),

  // Idempotent, so the panel's mount effect running twice under React's
  // StrictMode double-invoke cannot open two shells.
  ensureSession: (cwd) =>
    set((s) => {
      if (s.sessions.length > 0) {
        return s.activeId ? {} : { activeId: s.sessions[0].id };
      }
      const session = createSession(cwd, defaultPrivilege(), s.nextOrdinal);
      return { sessions: [session], activeId: session.id, nextOrdinal: s.nextOrdinal + 1 };
    }),

  addSession: (cwd) =>
    set((s) => {
      const session = createSession(cwd, defaultPrivilege(), s.nextOrdinal);
      return {
        sessions: [...s.sessions, session],
        activeId: session.id,
        nextOrdinal: s.nextOrdinal + 1,
      };
    }),

  closeSession: (id) =>
    set((s) => {
      const activeId = nextActiveAfterClose(s.sessions, id, s.activeId);
      const sessions = removeSession(s.sessions, id);
      // The last tab closing closes the panel: an empty terminal panel is
      // just chrome around nothing.
      return { sessions, activeId, isOpen: sessions.length > 0 };
    }),

  setActiveSession: (id) => set({ activeId: id }),

  // Privilege is per session and keyed by the view, so flipping it
  // respawns that one shell and leaves the other tabs alone.
  setPrivilege: (id, privilege) =>
    set((s) => ({ sessions: patchSession(s.sessions, id, { privilege }) })),

  restartSession: (id) =>
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, restartKey: x.restartKey + 1 } : x,
      ),
    })),

  setSessionTitle: (id, title) =>
    set((s) => ({ sessions: patchSession(s.sessions, id, { title }) })),

  setMobile: (mobile) => set({ mobile }),
}));

/** Imperative entry point for non-React callers (context menu, bubble menu). */
export function openTerminalAt(cwd: string) {
  // Keep the explorer selection in sync so the panel's cwd derivation and
  // the tree agree about where "here" is.
  try {
    useExplorer.getState().setSelected(cwd);
  } catch {
    /* explorer not mounted */
  }
  useTerminal.getState().openAt(cwd);
}

export function closeTerminal() {
  useTerminal.getState().close();
}

/** The session the panel's actions apply to, if any. */
export function activeSession(): TerminalSession | null {
  const { sessions, activeId } = useTerminal.getState();
  return sessions.find((s) => s.id === activeId) ?? null;
}
