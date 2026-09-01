/* ============================================================
   sparkEditor · src/shell/useSidebarLayout.ts

   Explorer pane geometry: width, collapsed state, and the drag
   interaction that changes them. Persisted to localStorage so the
   pane comes back the size the user left it.

   Kept out of App.tsx because the drag needs pointer capture and
   because the clamping rules are worth testing on their own.

   The drag deliberately does NOT go through React state. Setting
   state on every frame re-rendered the whole shell — including the
   file tree, where every row carries a Radix context menu — so the
   pane lagged the pointer on any real project. Instead the width is
   written straight onto the pane element while the pointer is down
   and committed to state once, on release. `paneRef` is how the
   element gets here; attach it to the element the width applies to.
   ============================================================ */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 640;
export const SIDEBAR_DEFAULT = 260;
/** Dragging narrower than this snaps the pane closed, like an IDE. */
export const SIDEBAR_COLLAPSE_AT = 120;

/** The plugin rail's fixed column, from the grid in App.css. */
const RAIL_WIDTH = 51;
/** Editor width that must survive however far the pane is dragged. */
const MAIN_MIN = 320;

const WIDTH_KEY = "spark.sidebar.width";
const COLLAPSED_KEY = "spark.sidebar.collapsed";

/**
 * The widest the pane may be in a viewport of `viewportWidth`.
 *
 * SIDEBAR_MAX alone is not enough: on a 900px window a 640px pane leaves
 * about 200px of editor, and on a narrower one the pane simply ran past
 * the window. The floor is SIDEBAR_MIN so the return value is always a
 * usable width rather than something negative on a tiny viewport.
 */
export function maxWidthFor(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return SIDEBAR_MAX;
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, viewportWidth - RAIL_WIDTH - MAIN_MIN));
}

export function clampWidth(px: number, max: number = SIDEBAR_MAX): number {
  // NaN has no sensible clamp, so it falls back. Infinities do — a
  // runaway drag should pin at the edge, not snap back to the default.
  if (Number.isNaN(px)) return SIDEBAR_DEFAULT;
  const ceiling = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, max));
  return Math.round(Math.min(ceiling, Math.max(SIDEBAR_MIN, px)));
}

/** The clamp against the live window, which is what a drag has to obey. */
function clampToViewport(px: number): number {
  const viewport = typeof window === "undefined" ? 0 : window.innerWidth;
  return clampWidth(px, maxWidthFor(viewport));
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
  /** Attach to the element the width applies to, so the drag can move it. */
  paneRef: React.MutableRefObject<HTMLElement | null>;
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
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;

  const paneRef = useRef<HTMLElement | null>(null);
  const rafRef = useRef(0);
  /** Width the DOM is showing while a drag is in flight, else null. */
  const liveRef = useRef<number | null>(null);

  const setWidth = useCallback((px: number) => {
    setWidthState(clampToViewport(px));
  }, []);

  const setCollapsed = useCallback((v: boolean) => {
    setCollapsedState(v);
  }, []);

  const toggle = useCallback(() => {
    setCollapsedState((v) => !v);
  }, []);

  const reset = useCallback(() => {
    setCollapsedState(false);
    setWidthState(clampToViewport(SIDEBAR_DEFAULT));
  }, []);

  /* Persist. The drag no longer sets state per frame, so this runs once
     per settled width rather than sixty times a second — which matters,
     because localStorage writes are synchronous. */
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

  /* A render that happens mid-drag (a toast, a terminal frame, anything)
     would repaint the pane at the last committed width and make it jump
     backwards under the pointer. Re-applying the live width after every
     commit keeps the element where the drag put it. */
  useLayoutEffect(() => {
    const live = liveRef.current;
    if (live != null && paneRef.current) paneRef.current.style.width = `${live}px`;
  });

  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = collapsedRef.current ? 0 : widthRef.current;
    const handle = e.currentTarget as HTMLElement;
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* capture unsupported — the window listeners below still work */
    }
    setDragging(true);

    let pending = startWidth;

    const paint = () => {
      rafRef.current = 0;

      /* Below the snap threshold the pane closes rather than becoming a
         useless sliver the user then has to find the edge of again.
         Crossing the threshold is the one thing in a drag that has to go
         through React, because collapsing unmounts the pane. */
      if (pending < SIDEBAR_COLLAPSE_AT) {
        liveRef.current = null;
        if (!collapsedRef.current) setCollapsedState(true);
        return;
      }
      if (collapsedRef.current) setCollapsedState(false);

      const next = clampToViewport(pending);
      liveRef.current = next;
      // The width goes on the element directly; state catches up on
      // release. This is the whole reason the drag tracks the pointer.
      if (paneRef.current) paneRef.current.style.width = `${next}px`;
    };

    const onMove = (ev: PointerEvent) => {
      pending = startWidth + (ev.clientX - startX);
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(paint);
    };

    const onUp = () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
        paint();
      }
      // Commit whatever the DOM is showing, then hand the element back to
      // React so the next render owns its width again.
      const live = liveRef.current;
      liveRef.current = null;
      if (live != null) {
        if (paneRef.current) paneRef.current.style.removeProperty("width");
        setWidthState(live);
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
  }, []);

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
          setWidthState(clampToViewport(next));
        }
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (collapsed) {
          setCollapsedState(false);
          return;
        }
        setWidthState(clampToViewport(widthRef.current + step));
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
      const cap = maxWidthFor(window.innerWidth);
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
    paneRef,
    setWidth,
    toggle,
    setCollapsed,
    reset,
    startResize,
    onHandleKeyDown,
  };
}
