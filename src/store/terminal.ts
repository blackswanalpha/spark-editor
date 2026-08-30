/* ============================================================
   sparkEditor · src/store/terminal.ts
   Terminal UI store — visibility, target cwd, and the privilege
   level the next session spawns with.

   The shell itself lives in the Rust host; this store only holds
   what the panel needs to decide *which* session to show.
   ============================================================ */
import { create } from "zustand";
import { useExplorer } from "@store/explorer";
import type { PtyPrivilege } from "@bridge/pty";

interface TerminalState {
  isOpen: boolean;
  /** cwd requested explicitly (e.g. "Open in Terminal" on a folder).
   *  When null the panel derives cwd from explorer/editor state. */
  targetCwd: string | null;
  /** Privilege the next spawned session runs with. */
  privilege: PtyPrivilege;
  open: () => void;
  close: () => void;
  toggle: () => void;
  openAt: (cwd: string) => void;
  setTargetCwd: (cwd: string | null) => void;
  setPrivilege: (p: PtyPrivilege) => void;
}

export const useTerminal = create<TerminalState>((set) => ({
  isOpen: false,
  targetCwd: null,
  privilege: "user",
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
  openAt: (cwd) => set({ isOpen: true, targetCwd: cwd }),
  setTargetCwd: (cwd) => set({ targetCwd: cwd }),
  // Dropping privilege back to user must not silently keep an elevated
  // shell alive; the panel keys its session on privilege and respawns.
  setPrivilege: (privilege) => set({ privilege }),
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
