/* ============================================================
   sparkEditor · src/store/documents.ts
   Document store. Holds open documents, active doc, dirty,
   per-doc history (undo/redo).  Backed by zustand + immer.
   ============================================================ */
import { create } from "zustand";
import { produce, enableMapSet } from "immer";
import type { Document } from "@ir/types";
import { newId } from "@ir/ids";

enableMapSet();

export type DocMode = "markdown" | "rich" | "code";

export interface OpenDoc {
  id: string;
  path: string | null;          // null = unsaved buffer
  name: string;
  mode: DocMode;
  language?: string;
  ir: Document;
  raw: string;                  // raw text — used for code / markdown
  dirty: boolean;
  cursor: { line: number; col: number };
}

interface State {
  docs: Record<string, OpenDoc>;
  order: string[];
  active: string | null;
  history: Record<string, { past: Snapshot[]; future: Snapshot[] }>;
}
interface Snapshot { ir: Document; raw: string }

interface Actions {
  open: (init: Partial<OpenDoc> & { name: string }) => string;
  close: (id: string) => void;
  setActive: (id: string) => void;
  setMode: (id: string, mode: DocMode) => void;
  setRaw:  (id: string, raw: string) => void;
  setIr:   (id: string, ir: Document) => void;
  setCursor: (id: string, c: { line: number; col: number }) => void;
  markClean: (id: string) => void;
  undo: (id: string) => void;
  redo: (id: string) => void;
  setName: (id: string, name: string) => void;
  setPath: (id: string, path: string) => void;
}

export const useDocs = create<State & Actions>((set, get) => ({
  docs: {}, order: [], active: null,
  history: {},

  open: (init) => {
    const id = newId("doc");
    const doc: OpenDoc = {
      id,
      path: init.path ?? null,
      name: init.name,
      mode: init.mode ?? "markdown",
      language: init.language,
      ir: init.ir ?? { version: 1, blocks: [] },
      raw: init.raw ?? "",
      dirty: false,
      cursor: { line: 1, col: 1 },
    };
    set((s) => ({
      docs: { ...s.docs, [id]: doc },
      order: [...s.order, id],
      active: id,
      history: { ...s.history, [id]: { past: [], future: [] } },
    }));
    return id;
  },

  close: (id) => set((s) => {
    const { [id]: _, ...rest } = s.docs;
    const { [id]: __, ...histRest } = s.history;
    const order = s.order.filter((x) => x !== id);
    return {
      docs: rest,
      history: histRest,
      order,
      active: s.active === id ? (order[order.length - 1] ?? null) : s.active,
    };
  }),

  setActive: (id) => set({ active: id }),

  setMode: (id, mode) => set((s) => ({
    docs: { ...s.docs, [id]: { ...s.docs[id], mode } },
  })),

  setRaw: (id, raw) => {
    const before = get().docs[id];
    if (!before || before.raw === raw) return;
    set((s) => ({
      docs: {
        ...s.docs,
        [id]: { ...s.docs[id], raw, dirty: true },
      },
      history: {
        ...s.history,
        [id]: { past: [...s.history[id].past, { ir: before.ir, raw: before.raw }].slice(-100), future: [] },
      },
    }));
  },

  setIr: (id, ir) => {
    const before = get().docs[id];
    if (!before) return;
    set((s) => ({
      docs: { ...s.docs, [id]: { ...s.docs[id], ir, dirty: true } },
      history: {
        ...s.history,
        [id]: { past: [...s.history[id].past, { ir: before.ir, raw: before.raw }].slice(-100), future: [] },
      },
    }));
  },

  setCursor: (id, c) => set((s) => ({
    docs: { ...s.docs, [id]: { ...s.docs[id], cursor: c } },
  })),

  markClean: (id) => set((s) => ({
    docs: { ...s.docs, [id]: { ...s.docs[id], dirty: false } },
  })),

  undo: (id) => set((s) => {
    const h = s.history[id];
    if (!h || !h.past.length) return s;
    const prev = h.past[h.past.length - 1];
    const cur = s.docs[id];
    return {
      docs: { ...s.docs, [id]: { ...cur, ir: prev.ir, raw: prev.raw, dirty: true } },
      history: { ...s.history, [id]: { past: h.past.slice(0, -1), future: [{ ir: cur.ir, raw: cur.raw }, ...h.future] } },
    };
  }),

  redo: (id) => set((s) => {
    const h = s.history[id];
    if (!h || !h.future.length) return s;
    const next = h.future[0];
    const cur = s.docs[id];
    return {
      docs: { ...s.docs, [id]: { ...cur, ir: next.ir, raw: next.raw, dirty: true } },
      history: { ...s.history, [id]: { past: [...h.past, { ir: cur.ir, raw: cur.raw }], future: h.future.slice(1) } },
    };
  }),

  setName: (id, name) => set((s) => ({ docs: { ...s.docs, [id]: { ...s.docs[id], name } } })),
  setPath: (id, path) => set((s) => ({ docs: { ...s.docs, [id]: { ...s.docs[id], path } } })),
}));

/* helpers */
export const activeDoc = () => {
  const s = useDocs.getState();
  return s.active ? s.docs[s.active] : null;
};
