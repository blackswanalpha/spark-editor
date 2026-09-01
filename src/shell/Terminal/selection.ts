/* ============================================================
   sparkEditor · src/shell/Terminal/selection.ts

   Selection over the terminal grid, as pure functions.

   The screen is painted as absolutely positioned spans off measured
   cell metrics, which is right for a fixed grid and wrong for the
   browser's own selection: `window.getSelection().toString()` walks
   the DOM, so it returns every row's spans concatenated with no line
   breaks, minus the trailing blanks the host trims off the wire.
   Copying three lines gave you one. So selection is modelled here in
   grid coordinates — (row, col) — and the text is rebuilt from the
   same grid the screen was painted from.

   Everything is viewport-relative: row 0 is the top visible row.
   Scrolling the viewport therefore invalidates a selection, which is
   why the component drops it on scroll rather than trying to track
   rows through the host's scrollback.
   ============================================================ */
import type { PtyRow } from "@bridge/pty";
import type { Grid } from "./grid";

export interface Point {
  row: number;
  col: number;
}

/**
 * A drag in progress or a settled selection. `anchor` is where the
 * pointer went down and `focus` where it is now, so `focus` can be
 * before `anchor` — {@link ordered} sorts them.
 */
export interface Selection {
  anchor: Point;
  focus: Point;
  /** Whole-line selection (triple click) ignores the columns. */
  mode: "char" | "word" | "line";
}

export interface Bounds {
  start: Point;
  /** Exclusive: `end.col` is one past the last selected column. */
  end: Point;
}

const cmp = (a: Point, b: Point) => (a.row !== b.row ? a.row - b.row : a.col - b.col);

/** Anchor/focus sorted into document order, with an exclusive end. */
export function ordered(sel: Selection, cols: number): Bounds {
  const [start, end] = cmp(sel.anchor, sel.focus) <= 0
    ? [sel.anchor, sel.focus]
    : [sel.focus, sel.anchor];

  if (sel.mode === "line") {
    return { start: { row: start.row, col: 0 }, end: { row: end.row, col: cols } };
  }
  return { start: { ...start }, end: { ...end } };
}

export function isEmpty(sel: Selection | null, cols: number): boolean {
  if (!sel) return true;
  const { start, end } = ordered(sel, cols);
  return cmp(start, end) >= 0;
}

/** One row's highlighted column span, for painting the overlay. */
export interface RowSegment {
  y: number;
  col: number;
  /** Width in cells. */
  width: number;
}

/**
 * The highlight rectangles for `sel`, one per row it touches.
 *
 * Rows between the first and last are selected edge to edge, which is
 * what makes a multi-line selection read as one block rather than as
 * three disconnected runs.
 */
export function rowSegments(sel: Selection | null, cols: number, rows: number): RowSegment[] {
  if (!sel || isEmpty(sel, cols)) return [];
  const { start, end } = ordered(sel, cols);
  const out: RowSegment[] = [];

  for (let y = Math.max(0, start.row); y <= Math.min(rows - 1, end.row); y++) {
    const from = y === start.row ? start.col : 0;
    const to = y === end.row ? end.col : cols;
    const col = Math.max(0, Math.min(cols, from));
    const width = Math.max(0, Math.min(cols, to) - col);
    if (width > 0) out.push({ y, col, width });
  }
  return out;
}

/**
 * One row of the grid as a flat `cols`-wide string.
 *
 * Spans carry their starting column and the host drops trailing blank
 * runs, so a row is a sparse thing: splat each span at its column into a
 * blank line rather than concatenating them.
 */
export function rowText(row: PtyRow | null | undefined, cols: number): string {
  const cells = new Array<string>(cols).fill(" ");
  if (row) {
    for (const span of row.spans) {
      let x = span.col;
      // Iterating the string (not indexing it) keeps astral characters
      // and combining marks in one cell, where the host put them.
      for (const ch of span.text) {
        if (x >= cols) break;
        if (x >= 0) cells[x] = ch;
        x += 1;
      }
    }
  }
  return cells.join("");
}

/**
 * The selected text, as it should land on the clipboard.
 *
 * Trailing blanks go per line: the grid is a rectangle, so every row is
 * padded out to `cols`, and pasting that back into a shell would append
 * a screenful of spaces to every command. Line endings are LF — this is
 * text for other applications, not input for a tty.
 */
export function selectionText(
  grid: Grid,
  sel: Selection | null,
  cols: number,
): string {
  if (!sel || isEmpty(sel, cols)) return "";
  const { start, end } = ordered(sel, cols);
  const lines: string[] = [];

  for (let y = Math.max(0, start.row); y <= Math.min(grid.length - 1, end.row); y++) {
    const full = rowText(grid[y], cols);
    const from = y === start.row ? Math.max(0, start.col) : 0;
    const to = y === end.row ? Math.min(cols, end.col) : cols;
    lines.push(full.slice(from, Math.max(from, to)).replace(/\s+$/, ""));
  }
  return lines.join("\n");
}

/** Whole visible screen, for "Select all". */
export function selectAll(rows: number, cols: number): Selection {
  return { anchor: { row: 0, col: 0 }, focus: { row: Math.max(0, rows - 1), col: cols }, mode: "char" };
}

/**
 * Pointer position as a grid cell.
 *
 * `x`/`y` are relative to the grid's top-left. The column rounds to the
 * nearest boundary rather than flooring so that dragging past the middle
 * of a cell includes it — the behaviour every other terminal has, and
 * the reason a one-character selection is possible at all.
 */
export function pointFromPixels(
  x: number,
  y: number,
  cell: { width: number; height: number },
  size: { rows: number; cols: number },
  edge: "round" | "floor" = "round",
): Point {
  const w = cell.width > 0 ? cell.width : 1;
  const h = cell.height > 0 ? cell.height : 1;
  const rawCol = x / w;
  const col = edge === "round" ? Math.round(rawCol) : Math.floor(rawCol);
  return {
    row: Math.max(0, Math.min(size.rows - 1, Math.floor(y / h))),
    col: Math.max(0, Math.min(size.cols, col)),
  };
}

/* Characters a double click treats as part of a word. Terminals pick a
   set wider than \w on purpose: paths, URLs and flags are what you are
   actually reaching for when you double-click in a shell. */
const WORD_CHARS = /[A-Za-z0-9_.\-+~@:/\\%?=&#$]/;

/**
 * The word under `point`, or a single cell when it lands on whitespace.
 * Used by double click, and by the triple click that widens to the line.
 */
export function wordAt(grid: Grid, point: Point, cols: number): Selection {
  const line = rowText(grid[point.row], cols);
  const at = Math.max(0, Math.min(cols - 1, point.col));
  const char = line[at] ?? " ";

  if (!WORD_CHARS.test(char)) {
    return {
      anchor: { row: point.row, col: at },
      focus: { row: point.row, col: at + 1 },
      mode: "word",
    };
  }

  let from = at;
  while (from > 0 && WORD_CHARS.test(line[from - 1])) from -= 1;
  let to = at + 1;
  while (to < cols && WORD_CHARS.test(line[to])) to += 1;

  return {
    anchor: { row: point.row, col: from },
    focus: { row: point.row, col: to },
    mode: "word",
  };
}

/** The whole row under `point` (triple click). */
export function lineAt(point: Point, cols: number): Selection {
  return {
    anchor: { row: point.row, col: 0 },
    focus: { row: point.row, col: cols },
    mode: "line",
  };
}
