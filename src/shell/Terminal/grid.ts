/* ============================================================
   sparkBook · src/shell/Terminal/grid.ts

   Frame -> grid reduction, kept separate from the React component
   so the paint path can be tested without a DOM.

   The host sends only the rows that changed since the last frame
   (a full frame on resize, first paint, or an explicit refresh).
   Applying that correctly is the whole correctness story of the
   renderer: drop a delta and the screen is silently wrong until
   something else repaints that row.
   ============================================================ */
import type { PtyFrame, PtyRow } from "@bridge/pty";

/** The visible grid, indexed by row. `null` rows have never been painted. */
export type Grid = (PtyRow | null)[];

export function emptyGrid(rows: number): Grid {
  return new Array<PtyRow | null>(rows).fill(null);
}

/**
 * Apply one frame's row deltas onto `prev`.
 *
 * Returns `prev` itself when nothing changed, so React can skip the
 * re-render. A full frame, or one whose row count differs, starts from a
 * blank grid — a delta computed against a differently-shaped screen
 * would land rows at the wrong index.
 */
export function applyFrame(prev: Grid, frame: PtyFrame): Grid {
  const reshaped = frame.full || prev.length !== frame.rows;
  if (!reshaped && frame.lines.length === 0) return prev;

  const next: Grid = reshaped ? emptyGrid(frame.rows) : prev.slice();
  for (const line of frame.lines) {
    // A row index past the end can arrive when a resize and a frame
    // cross on the wire; dropping it beats growing the grid to a size
    // the host is not rendering.
    if (line.y >= 0 && line.y < next.length) next[line.y] = line;
  }
  return next;
}

/**
 * Whether `frame` should be applied given the last sequence number seen.
 * Frames travel over an async event channel, so an older one can arrive
 * after a newer one and would otherwise repaint stale rows.
 */
export function isFresh(frame: PtyFrame, lastSeq: number): boolean {
  return frame.seq > lastSeq;
}
