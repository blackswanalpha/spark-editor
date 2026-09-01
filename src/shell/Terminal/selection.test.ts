/* sparkEditor — terminal selection

   The bug these pin down: copy used to run the DOM selection through
   `toString()`, and because rows and spans are absolutely positioned
   that returned every line concatenated with no separator. Selecting
   three lines and pasting them gave one. Everything here works on the
   grid instead, so a selection is text with the shape it had on screen. */
import { describe, expect, it } from "vitest";
import type { PtyRow } from "@bridge/pty";
import type { Grid } from "./grid";
import {
  isEmpty,
  lineAt,
  ordered,
  pointFromPixels,
  rowSegments,
  rowText,
  selectAll,
  selectionText,
  wordAt,
  type Selection,
} from "./selection";

/** A row exactly as the host sends one: sparse spans, no trailing blanks. */
function row(y: number, ...spans: [number, string][]): PtyRow {
  return { y, spans: spans.map(([col, text]) => ({ col, text })) };
}

const COLS = 20;

/*  0: "hello world"
    1: (never painted)
    2: "  indented"
    3: "a" at col 0 and "b" at col 10 — a gap the host never sent */
const GRID: Grid = [
  row(0, [0, "hello world"]),
  null,
  row(2, [0, "  indented"]),
  row(3, [0, "a"], [10, "b"]),
];

const chars = (anchor: [number, number], focus: [number, number]): Selection => ({
  anchor: { row: anchor[0], col: anchor[1] },
  focus: { row: focus[0], col: focus[1] },
  mode: "char",
});

describe("rowText", () => {
  it("pads a sparse row out to the full width", () => {
    expect(rowText(GRID[0], COLS)).toBe("hello world".padEnd(COLS));
  });

  it("puts each span at its own column, leaving the gaps blank", () => {
    // Concatenating the spans would have produced "ab".
    expect(rowText(GRID[3], COLS)).toBe("a" + " ".repeat(9) + "b" + " ".repeat(9));
  });

  it("treats a never-painted row as blank", () => {
    expect(rowText(null, 5)).toBe("     ");
  });

  it("does not let a span run past the right edge", () => {
    expect(rowText(row(0, [3, "abcdef"]), 5)).toBe("   ab");
  });
});

describe("selectionText", () => {
  it("keeps a line break between rows", () => {
    // The regression: this used to come back as one run-together line.
    expect(selectionText(GRID, chars([0, 0], [2, 10]), COLS)).toBe(
      "hello world\n\n  indented",
    );
  });

  it("takes a partial run inside one row", () => {
    expect(selectionText(GRID, chars([0, 6], [0, 11]), COLS)).toBe("world");
  });

  it("orders the ends, so dragging right-to-left copies the same text", () => {
    expect(selectionText(GRID, chars([0, 11], [0, 6]), COLS)).toBe("world");
  });

  it("trims the padding a row carries but keeps leading indent", () => {
    // Every row is `cols` wide; pasting that back would append a
    // screenful of spaces to the command.
    expect(selectionText(GRID, chars([2, 0], [2, COLS]), COLS)).toBe("  indented");
  });

  it("returns nothing for an empty or absent selection", () => {
    expect(selectionText(GRID, null, COLS)).toBe("");
    expect(selectionText(GRID, chars([0, 4], [0, 4]), COLS)).toBe("");
  });

  it("selects the whole visible screen", () => {
    expect(selectionText(GRID, selectAll(GRID.length, COLS), COLS)).toBe(
      "hello world\n\n  indented\na         b",
    );
  });
});

describe("ordered / isEmpty", () => {
  it("sorts anchor and focus regardless of drag direction", () => {
    const back = ordered(chars([3, 2], [1, 5]), COLS);
    expect(back.start).toEqual({ row: 1, col: 5 });
    expect(back.end).toEqual({ row: 3, col: 2 });
  });

  it("widens a line selection to the full row", () => {
    const b = ordered(lineAt({ row: 2, col: 7 }, COLS), COLS);
    expect(b.start).toEqual({ row: 2, col: 0 });
    expect(b.end).toEqual({ row: 2, col: COLS });
  });

  it("treats a zero-width range as no selection", () => {
    expect(isEmpty(null, COLS)).toBe(true);
    expect(isEmpty(chars([1, 3], [1, 3]), COLS)).toBe(true);
    expect(isEmpty(chars([1, 3], [1, 4]), COLS)).toBe(false);
  });
});

describe("rowSegments", () => {
  it("runs the middle rows edge to edge so the block reads as one", () => {
    expect(rowSegments(chars([0, 5], [2, 3]), COLS, 4)).toEqual([
      { y: 0, col: 5, width: COLS - 5 },
      { y: 1, col: 0, width: COLS },
      { y: 2, col: 0, width: 3 },
    ]);
  });

  it("stays inside the viewport", () => {
    // A selection taken before a shrink must not paint off the grid.
    expect(rowSegments(chars([0, 0], [9, 4]), COLS, 2)).toHaveLength(2);
  });

  it("paints nothing for an empty selection", () => {
    expect(rowSegments(null, COLS, 4)).toEqual([]);
    expect(rowSegments(chars([0, 2], [0, 2]), COLS, 4)).toEqual([]);
  });
});

describe("pointFromPixels", () => {
  const cell = { width: 8, height: 16 };
  const size = { rows: 4, cols: COLS };

  it("rounds to the nearest boundary so a drag includes the last cell", () => {
    expect(pointFromPixels(8 * 3 + 5, 0, cell, size)).toEqual({ row: 0, col: 4 });
  });

  it("floors when asked, which is the cell a click landed in", () => {
    expect(pointFromPixels(8 * 3 + 5, 0, cell, size, "floor")).toEqual({ row: 0, col: 3 });
  });

  it("clamps a pointer dragged outside the grid", () => {
    expect(pointFromPixels(-40, -40, cell, size)).toEqual({ row: 0, col: 0 });
    expect(pointFromPixels(9999, 9999, cell, size)).toEqual({ row: 3, col: COLS });
  });
});

describe("wordAt", () => {
  const grid: Grid = [row(0, [0, "cd /usr/local/bin && ls"])];

  it("takes a path as one word, which is what you double-click for", () => {
    const sel = wordAt(grid, { row: 0, col: 6 }, 40);
    expect(selectionText(grid, sel, 40)).toBe("/usr/local/bin");
  });

  it("stops at whitespace", () => {
    expect(selectionText(grid, wordAt(grid, { row: 0, col: 0 }, 40), 40)).toBe("cd");
  });

  it("selects a single cell when it lands on a space", () => {
    const sel = wordAt(grid, { row: 0, col: 2 }, 40);
    expect(selectionText(grid, sel, 40)).toBe("");
    expect(isEmpty(sel, 40)).toBe(false);
  });
});
