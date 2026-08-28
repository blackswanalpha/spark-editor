/* ============================================================
   sparkEditor · src/store/terminal.ts
   Terminal UI store — controls visibility + target cwd for the
   internal xterm panel. Explorer folders route here instead of
   spawning an OS terminal.
   ============================================================ */
import { create } from "zustand";
import { useExplorer } from "@store/explorer";

interface TerminalState {
  isOpen: boolean;
  /** cwd override requested by explorer (folder path). When null, panel derives cwd from explorer selection. */
  targetCwd: string | null;
  open: () => void;
  close: () => void;
  toggle: () => void;
  openAt: (cwd: string) => void;
  setTargetCwd: (cwd: string | null) => void;
}

export const useTerminal = create<TerminalState>((set) => ({
  isOpen: false,
  targetCwd: null,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
  openAt: (cwd) => set({ isOpen: true, targetCwd: cwd }),
  setTargetCwd: (cwd) => set({ targetCwd: cwd }),
}));

// imperative helpers for non-React callers (ExplorerContextMenu, bubble menu)
export function openTerminalAt(cwd: string) {
  // keep explorer selection in sync so terminal cwd derivation stays correct
  try { useExplorer.getState().setSelected(cwd); } catch { /* ignore */ }
  useTerminal.getState().openAt(cwd);
  window.dispatchEvent(new CustomEvent("spark:terminal:open", { detail: { cwd } }));
}

export function closeTerminal() {
  useTerminal.getState().close();
  window.dispatchEvent(new CustomEvent("spark:terminal:close"));
}
