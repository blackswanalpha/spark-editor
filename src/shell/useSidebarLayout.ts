/* ============================================================
   sparkEditor · src/shell/useSidebarLayout.ts

   Explorer pane geometry: width, collapsed state, and the drag
   interaction that changes them. Persisted to localStorage so the
   pane comes back the size the user left it.

   Kept out of App.tsx because the drag needs pointer capture and
   rAF batching to stay smooth, and because the clamping rules are
   worth testing on their own.
   ============================================================ */
import { useCallback, useEffect, useRef, useState } from "react";

export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 640;
export const SIDEBAR_DEFAULT = 260;
/** Dragging narrower than this snaps the pane closed, like an IDE. */
export const SIDEBAR_COLLAPSE_AT = 120;

const WIDTH_KEY = "spark.sidebar.width";
const COLLAPSED_KEY = "spark.sidebar.collapsed";

export function clampWidth(px: number): number {
  // NaN has no sensible clamp, so it falls back. Infinities do — a
  // runaway drag should pin at the edge, not snap back to the default.
  if (Number.isNaN(px)) return SIDEBAR_DEFAULT;
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, px)));
}

function readWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    if (raw == null) return SIDEBAR_DEFAULT;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? clampWidth(n) : SIDEBAR_DEFAULT;
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export interface SidebarLayout {
  width: number;
  collapsed: boolean;
  dragging: boolean;
  setWidth: (px: number) => void;
  toggle: () => void;
  setCollapsed: (v: boolean) => void;
  /** Reset to the default width (double-click on the handle). */
  reset: () => void;
  /** Attach to the resize handle's `onPointerDown`. */
  startResize: (e: React.PointerEvent) => void;
  /** Attach to the resize handle's `onKeyDown` — arrows resize, Enter toggles. */
  onHandleKeyDown: (e: React.KeyboardEvent) => void;
}

export function useSidebarLayout(): SidebarLayout {
  const [width, setWidthState] = useState<number>(readWidth);
  const [collapsed, setCollapsedState] = useState<boolean>(readCollapsed);
  const [dragging, setDragging] = useState(false);

  // The live value during a drag: state updates are batched, but the
  // pointermove handler needs the previous width immediately.
  const widthRef = useRef(width);
  widthRef.current = width;
  const rafRef = useRef(0);

  const setWidth = useCallback((px: number) => {
    setWidthState(clampWidth(px));
  }, []);

  const setCollapsed = useCallback((v: boolean) => {
    setCollapsedState(v);
  }, []);

  const toggle = useCallback(() => {
    setCollapsedState((v) => !v);
  }, []);

  const reset = useCallback(() => {
    setCollapsedState(false);
    setWidthState(SIDEBAR_DEFAULT);
  }, []);

  /* Persist. Writing on every drag frame would hammer localStorage, so
     this only runs when the settled value changes. */
  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      /* storage unavailable (private mode) — geometry just won't persist */
    }
  }, [width]);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      /* as above */
    }
  }, [collapsed]);

  const startResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = collapsed ? 0 : widthRef.current;
      const handle = e.currentTarget as HTMLElement;
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        /* capture unsupported — the window listeners below still work */
      }
      setDragging(true);

      let pending = startWidth;
      const commit = () => {
        rafRef.current = 0;
        // Below the snap threshold the pane closes rather than becoming a
        // useless sliver the user then has to find the edge of again.
        if (pending < SIDEBAR_COLLAPSE_AT) {
          setCollapsedState(true);
        } else {
          setCollapsedState(false);
          setWidthState(clampWidth(pending));
        }
      };

      const onMove = (ev: PointerEvent) => {
        pending = startWidth + (ev.clientX - startX);
        if (rafRef.current) return;
        rafRef.current = requestAnimationFrame(commit);
      };

      const onUp = () => {
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = 0;
          commit();
        }
        setDragging(false);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        try {
          handle.releasePointerCapture(e.pointerId);
        } catch {
          /* already released */
        }
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [collapsed],
  );

  const onHandleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 48 : 16;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (collapsed) return;
        const next = widthRef.current - step;
        // Narrowing past the threshold collapses — and so does narrowing
        // when already at the minimum, otherwise the keyboard path could
        // never close the pane (clampWidth would pin it at SIDEBAR_MIN
        // forever).
        if (next < SIDEBAR_COLLAPSE_AT || widthRef.current <= SIDEBAR_MIN) {
          setCollapsedState(true);
        } else {
          setWidthState(clampWidth(next));
        }
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (collapsed) {
          setCollapsedState(false);
          return;
        }
        setWidthState(clampWidth(widthRef.current + step));
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      } else if (e.key === "Home") {
        e.preventDefault();
        reset();
      }
    },
    [collapsed, toggle, reset],
  );

  /* Never leave the pane wider than the window after a shrink. */
  useEffect(() => {
    const onResize = () => {
      const cap = Math.max(SIDEBAR_MIN, window.innerWidth - 320);
      setWidthState((w) => (w > cap ? clampWidth(cap) : w));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /* A drag in flight must not survive unmount. */
  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  return {
    width,
    collapsed,
    dragging,
    setWidth,
    toggle,
    setCollapsed,
    reset,
    startResize,
    onHandleKeyDown,
  };
}
