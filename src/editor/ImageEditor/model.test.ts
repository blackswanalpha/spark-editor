/* ============================================================
   sparkBook · ImageEditor/model.test.ts
   Colour parsing, adjustment serialization and flood fill.
   Canvas-backed helpers are exercised in the app, not here:
   jsdom has no 2D context to draw into.
   ============================================================ */
import { describe, it, expect } from "vitest";
import {
  NEUTRAL_ADJUSTMENTS, filterString, floodFill, isNeutral, parseColor, toHex,
  type RGBA,
} from "./model";

/** jsdom ships no ImageData; floodFill only needs this shape. */
function imageData(width: number, height: number, fill: RGBA): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = fill.r;
    data[i * 4 + 1] = fill.g;
    data[i * 4 + 2] = fill.b;
    data[i * 4 + 3] = fill.a;
  }
  return { data, width, height, colorSpace: "srgb" } as ImageData;
}

function pixelAt(img: ImageData, x: number, y: number): RGBA {
  const i = (y * img.width + x) * 4;
  return { r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: img.data[i + 3] };
}

function setPixel(img: ImageData, x: number, y: number, c: RGBA) {
  const i = (y * img.width + x) * 4;
  img.data[i] = c.r; img.data[i + 1] = c.g; img.data[i + 2] = c.b; img.data[i + 3] = c.a;
}

const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 255 };
const RED: RGBA = { r: 255, g: 0, b: 0, a: 255 };
const BLUE: RGBA = { r: 0, g: 0, b: 255, a: 255 };

describe("parseColor", () => {
  it("reads every hex length", () => {
    expect(parseColor("#f00")).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(parseColor("#ff0000")).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(parseColor("#ff000080").a).toBe(128);
    expect(parseColor("#f008").a).toBe(136);
  });

  it("reads rgb() and rgba()", () => {
    expect(parseColor("rgb(1, 2, 3)")).toEqual({ r: 1, g: 2, b: 3, a: 255 });
    expect(parseColor("rgba(1, 2, 3, 0.5)").a).toBe(128);
  });

  it("falls back to opaque black on nonsense", () => {
    expect(parseColor("chartreuse-ish")).toEqual(BLACK);
  });
});

describe("toHex", () => {
  it("pads and clamps", () => {
    expect(toHex({ r: 1, g: 2, b: 3, a: 255 })).toBe("#010203");
    expect(toHex({ r: 999, g: -5, b: 3, a: 255 })).toBe("#ff0003");
  });
});

describe("filterString", () => {
  it("is 'none' at neutral", () => {
    expect(filterString(NEUTRAL_ADJUSTMENTS)).toBe("none");
    expect(isNeutral(NEUTRAL_ADJUSTMENTS)).toBe(true);
  });

  it("omits zero-valued optional effects", () => {
    const s = filterString({ ...NEUTRAL_ADJUSTMENTS, brightness: 120 });
    expect(s).toContain("brightness(120%)");
    expect(s).not.toContain("blur");
    expect(s).not.toContain("sepia");
  });

  it("includes effects once they are non-zero", () => {
    const s = filterString({ ...NEUTRAL_ADJUSTMENTS, blur: 3, invert: 100 });
    expect(s).toContain("blur(3px)");
    expect(s).toContain("invert(100%)");
  });
});

describe("floodFill", () => {
  it("fills a uniform region and reports the change", () => {
    const img = imageData(4, 4, BLACK);
    expect(floodFill(img, 0, 0, RED, 0)).toBe(true);
    expect(pixelAt(img, 3, 3)).toEqual(RED);
  });

  it("stops at a colour boundary", () => {
    const img = imageData(5, 1, BLACK);
    setPixel(img, 2, 0, BLUE);
    floodFill(img, 0, 0, RED, 0);
    expect(pixelAt(img, 1, 0)).toEqual(RED);
    expect(pixelAt(img, 2, 0)).toEqual(BLUE);
    expect(pixelAt(img, 3, 0)).toEqual(BLACK);
  });

  it("crosses a boundary once tolerance allows it", () => {
    const img = imageData(3, 1, BLACK);
    setPixel(img, 1, 0, { r: 10, g: 10, b: 10, a: 255 });
    floodFill(img, 0, 0, RED, 20);
    expect(pixelAt(img, 2, 0)).toEqual(RED);
  });

  it("reports no change when the region already has the fill colour", () => {
    const img = imageData(3, 3, RED);
    expect(floodFill(img, 1, 1, RED, 0)).toBe(false);
  });

  it("ignores a start point outside the bitmap", () => {
    const img = imageData(2, 2, BLACK);
    expect(floodFill(img, -1, 0, RED, 0)).toBe(false);
    expect(floodFill(img, 0, 5, RED, 0)).toBe(false);
    expect(pixelAt(img, 0, 0)).toEqual(BLACK);
  });

  it("reaches around a barrier rather than through it", () => {
    // A wall down the middle with a gap on the bottom row.
    const img = imageData(3, 3, BLACK);
    setPixel(img, 1, 0, BLUE);
    setPixel(img, 1, 1, BLUE);
    floodFill(img, 0, 0, RED, 0);
    expect(pixelAt(img, 2, 0)).toEqual(RED);   // via the gap at (1,2)
    expect(pixelAt(img, 1, 0)).toEqual(BLUE);
  });
});
