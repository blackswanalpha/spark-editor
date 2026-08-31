/* Position maths for restoring a persisted caret. Pure — jsdom does no
   layout, so the pixel half of restoreViewState is covered by hand. */
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { posFromCursor, safeScrollTop } from "./viewState";

const doc = EditorState.create({ doc: "alpha\nbravo\ncharlie" });

describe("posFromCursor", () => {
  it("maps line 1 col 1 to offset 0", () => {
    expect(posFromCursor(doc, { line: 1, col: 1 })).toBe(0);
  });

  it("maps a mid-document position", () => {
    // "alpha\n" is 6 chars; line 2 col 3 -> 6 + 2
    expect(posFromCursor(doc, { line: 2, col: 3 })).toBe(8);
  });

  it("clamps a line past the end of a file that shrank on disk", () => {
    expect(posFromCursor(doc, { line: 9999, col: 1 })).toBe(doc.doc.line(3).from);
  });

  it("clamps a column past the end of its line", () => {
    expect(posFromCursor(doc, { line: 1, col: 9999 })).toBe(doc.doc.line(1).to);
  });

  it("treats a zero or negative line or column as 1", () => {
    expect(posFromCursor(doc, { line: 0, col: 0 })).toBe(0);
    expect(posFromCursor(doc, { line: -4, col: -4 })).toBe(0);
  });

  it("returns 0 for a missing cursor", () => {
    expect(posFromCursor(doc, undefined)).toBe(0);
  });

  it("handles CRLF documents", () => {
    const crlf = EditorState.create({ doc: "one\r\ntwo" });
    expect(posFromCursor(crlf, { line: 2, col: 1 })).toBe(crlf.doc.line(2).from);
  });
});

describe("safeScrollTop", () => {
  it("passes a positive offset through, rounded", () => {
    expect(safeScrollTop(120.6)).toBe(121);
  });

  it("floors anything not a usable offset to 0", () => {
    for (const v of [0, -5, NaN, Infinity, null, undefined, "tall", {}]) {
      expect(safeScrollTop(v)).toBe(0);
    }
  });
});
