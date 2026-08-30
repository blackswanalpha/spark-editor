/* ============================================================
   sparkEditor · src/shell/Terminal/scroll.ts

   Viewport scrolling for the host-driven terminal.

   The grid is exactly as tall as the panel, so there is nothing for
   the browser to scroll: moving through history means asking the
   host to slide its window into vt100's scrollback. Everything here
   turns a gesture into a row count, kept out of the component so it
   can be tested without a DOM.
   ============================================================ */

/** The step Settings ships with, and the baseline pixel gestures scale against. */
const DEFAULT_ROWS_PER_NOTCH = 3;

export interface WheelContext {
  /** Settings → Terminal → Scroll step. */
  rowsPerNotch: number;
  /** Measured cell height in px, for pixel-mode deltas. */
  cellHeight: number;
  /** Visible rows, which is what a page-mode delta means. */
  viewportRows: number;
}

/**
 * Rows a wheel event should move the viewport by. Positive is towards
 * older output, matching `pty_scroll`'s delta.
 *
 * The three delta modes are genuinely different units and treating them
 * alike is what makes a trackpad unusable: a trackpad reports a handful
 * of *pixels* per frame, so scaling those by the per-notch row count
 * flings the viewport through thousands of rows on one flick. Pixels are
 * converted through the cell height instead, which makes a drag move the
 * content the distance the fingers moved.
 */
export function wheelRows(deltaY: number, deltaMode: number, ctx: WheelContext): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
  const rowsPerNotch = Math.max(1, ctx.rowsPerNotch);
  switch (deltaMode) {
    case 2: // DOM_DELTA_PAGE
      return -deltaY * Math.max(1, ctx.viewportRows - 1);
    case 1: // DOM_DELTA_LINE — already in rows
      return -deltaY * rowsPerNotch;
    default: {
      // DOM_DELTA_PIXEL. The step setting still scales the result, so a
      // larger step speeds a trackpad up in the same proportion it speeds
      // a notched wheel up.
      const height = ctx.cellHeight > 0 ? ctx.cellHeight : 1;
      return (-deltaY / height) * (rowsPerNotch / DEFAULT_ROWS_PER_NOTCH);
    }
  }
}

/** Either a relative nudge or a jump to a fixed offset. */
export type ScrollIntent = { delta: number } | { absolute: number };

export interface KeyScrollContext {
  viewportRows: number;
  /** Largest offset the buffer can take, from the last frame. */
  scrollbackMax: number;
}

/**
 * The viewport scroll a key press asks for, or `null` when the key
 * belongs to the shell.
 *
 * Shift is the discriminator, as in xterm and gnome-terminal: bare
 * PageUp must still reach the program running in the terminal, because
 * pagers and editors bind it themselves.
 */
export function scrollIntentForKey(
  e: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey">,
  ctx: KeyScrollContext,
): ScrollIntent | null {
  if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return null;
  const page = Math.max(1, ctx.viewportRows - 1);
  switch (e.key) {
    case "PageUp":
      return { delta: page };
    case "PageDown":
      return { delta: -page };
    case "Home":
      return { absolute: ctx.scrollbackMax };
    case "End":
      return { absolute: 0 };
    default:
      return null;
  }
}

export interface ThumbGeometry {
  /** Fraction of the track the thumb starts at. */
  top: number;
  /** Fraction of the track the thumb covers. */
  height: number;
}

/**
 * Where the scrollbar thumb sits, as fractions of the track.
 *
 * `scrollback` counts rows *above* the viewport that are hidden below
 * it, so offset 0 is the live bottom and the thumb belongs at the end of
 * the track — the inversion is the whole subtlety here.
 */
export function thumbGeometry(
  scrollback: number,
  scrollbackMax: number,
  viewportRows: number,
): ThumbGeometry {
  const total = scrollbackMax + Math.max(1, viewportRows);
  const height = Math.max(0.04, Math.max(1, viewportRows) / total);
  const above = Math.max(0, scrollbackMax - scrollback);
  const top = Math.min(1 - height, above / total);
  return { top: Math.max(0, top), height };
}

/**
 * The scrollback offset that puts the thumb's centre under `fraction`
 * of the track — the inverse of {@link thumbGeometry}, for a drag.
 */
export function offsetForThumbFraction(
  fraction: number,
  scrollbackMax: number,
  viewportRows: number,
): number {
  const total = scrollbackMax + Math.max(1, viewportRows);
  const above = Math.round(fraction * total);
  return Math.max(0, Math.min(scrollbackMax, scrollbackMax - above));
}
