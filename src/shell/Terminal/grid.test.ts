/* sparkBook — terminal frame -> grid reduction */
import { describe, expect, it, vi } from "vitest";

vi.mock("@bridge/commands", () => ({ isTauri: false }));

import type { PtyFrame, PtyRow } from "@bridge/pty";
import { applyFrame, emptyGrid, isFresh } from "./grid";

function row(y: number, text: string): PtyRow {
  return { y, spans: [{ col: 0, text }] };
}

function frame(over: Partial<PtyFrame> = {}): PtyFrame {
  return {
    id: "pty-1",
    rows: 3,
    cols: 20,
    lines: [],
    full: false,
    cursorRow: 0,
    cursorCol: 0,
    cursorVisible: true,
    applicationCursor: false,
    bracketedPaste: false,
    scrollback: 0,
    scrollbackMax: 0,
    alternateScreen: false,
    mouseMode: "none",
    mouseEncoding: "default",
    seq: 1,
    ...over,
  };
}

const textOf = (g: ReturnType<typeof emptyGrid>) =>
  g.map((r) => (r ? r.spans.map((s) => s.text).join("") : null));

describe("emptyGrid", () => {
  it("allocates the requested number of unpainted rows", () => {
    expect(emptyGrid(3)).toEqual([null, null, null]);
    expect(emptyGrid(0)).toEqual([]);
  });
});

describe("applyFrame", () => {
  it("paints the rows a delta carries and leaves the rest alone", () => {
    let grid = emptyGrid(3);
    grid = applyFrame(grid, frame({ full: true, lines: [row(0, "a"), row(1, "b"), row(2, "c")] }));
    expect(textOf(grid)).toEqual(["a", "b", "c"]);

    grid = applyFrame(grid, frame({ seq: 2, lines: [row(1, "B")] }));
    expect(textOf(grid)).toEqual(["a", "B", "c"]);
  });

  it("returns the same array when a delta carries no rows", () => {
    // Identity matters: React skips the re-render on an unchanged grid,
    // and cursor-only frames are the common case during typing.
    const grid = applyFrame(emptyGrid(3), frame({ full: true, lines: [row(0, "a")] }));
    expect(applyFrame(grid, frame({ seq: 2, lines: [] }))).toBe(grid);
  });

  it("does not mutate the previous grid", () => {
    const before = applyFrame(emptyGrid(2), frame({ rows: 2, full: true, lines: [row(0, "a")] }));
    const snapshot = textOf(before);
    applyFrame(before, frame({ rows: 2, seq: 2, lines: [row(0, "z")] }));
    expect(textOf(before)).toEqual(snapshot);
  });

  it("starts from blank on a full frame, so stale rows cannot survive", () => {
    let grid = applyFrame(emptyGrid(3), frame({ full: true, lines: [row(0, "a"), row(1, "b")] }));
    grid = applyFrame(grid, frame({ seq: 2, full: true, lines: [row(0, "x")] }));
    expect(textOf(grid)).toEqual(["x", null, null]);
  });

  it("reshapes when the row count changes, even without the full flag", () => {
    // A delta computed against a differently-shaped screen would land
    // rows at the wrong index.
    let grid = applyFrame(emptyGrid(3), frame({ full: true, lines: [row(0, "a"), row(2, "c")] }));
    grid = applyFrame(grid, frame({ seq: 2, rows: 5, lines: [row(4, "e")] }));
    expect(grid).toHaveLength(5);
    expect(textOf(grid)).toEqual([null, null, null, null, "e"]);
  });

  it("drops a row index outside the grid instead of growing it", () => {
    // A resize and a frame can cross on the wire.
    const grid = applyFrame(emptyGrid(3), frame({ full: true, lines: [row(0, "a"), row(9, "off")] }));
    expect(grid).toHaveLength(3);
    expect(textOf(grid)).toEqual(["a", null, null]);
  });

  it("ignores a negative row index", () => {
    const grid = applyFrame(emptyGrid(2), frame({ rows: 2, full: true, lines: [row(-1, "bad")] }));
    expect(textOf(grid)).toEqual([null, null]);
  });

  it("handles a zero-row frame", () => {
    expect(applyFrame(emptyGrid(3), frame({ rows: 0, full: true, lines: [] }))).toEqual([]);
  });
});

describe("isFresh", () => {
  it("accepts a newer sequence and rejects a replay", () => {
    expect(isFresh(frame({ seq: 5 }), 4)).toBe(true);
    expect(isFresh(frame({ seq: 4 }), 4)).toBe(false);
    expect(isFresh(frame({ seq: 3 }), 4)).toBe(false);
  });

  it("accepts the first frame of a session", () => {
    // Sessions reset the counter to -1, and the host's first seq is 0.
    expect(isFresh(frame({ seq: 0 }), -1)).toBe(true);
  });
});
