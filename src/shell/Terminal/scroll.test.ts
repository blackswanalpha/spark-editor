/* sparkEditor — terminal viewport scrolling */
import { describe, expect, it } from "vitest";

import {
  offsetForThumbFraction,
  scrollIntentForKey,
  thumbGeometry,
  wheelRows,
} from "./scroll";

const CTX = { rowsPerNotch: 3, cellHeight: 17, viewportRows: 24 };

describe("wheelRows", () => {
  it("scrolls towards older output when the wheel goes up", () => {
    expect(wheelRows(-100, 0, CTX)).toBeGreaterThan(0);
    expect(wheelRows(100, 0, CTX)).toBeLessThan(0);
  });

  it("treats a line-mode notch as the configured step", () => {
    expect(wheelRows(-1, 1, CTX)).toBe(3);
    expect(wheelRows(-1, 1, { ...CTX, rowsPerNotch: 8 })).toBe(8);
  });

  it("keeps a trackpad's pixel deltas sub-row instead of flinging the viewport", () => {
    // A few pixels of finger travel must not become a whole notch.
    expect(Math.abs(wheelRows(-4, 0, CTX))).toBeLessThan(1);
    // One mouse notch (~100px in WebKit) still lands near the step.
    expect(wheelRows(-100, 0, CTX)).toBeCloseTo(5.88, 1);
  });

  it("maps a page-mode delta to the viewport", () => {
    expect(wheelRows(-1, 2, CTX)).toBe(23);
  });

  it("ignores non-deltas", () => {
    expect(wheelRows(0, 0, CTX)).toBe(0);
    expect(wheelRows(Number.NaN, 0, CTX)).toBe(0);
  });
});

describe("scrollIntentForKey", () => {
  const key = (over: Partial<KeyboardEvent>) =>
    ({
      key: "PageUp",
      shiftKey: true,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      ...over,
    }) as KeyboardEvent;

  const ctx = { viewportRows: 24, scrollbackMax: 500 };

  it("pages the viewport on shift+PageUp/PageDown", () => {
    expect(scrollIntentForKey(key({}), ctx)).toEqual({ delta: 23 });
    expect(scrollIntentForKey(key({ key: "PageDown" }), ctx)).toEqual({ delta: -23 });
  });

  it("jumps to the ends on shift+Home/End", () => {
    expect(scrollIntentForKey(key({ key: "Home" }), ctx)).toEqual({ absolute: 500 });
    expect(scrollIntentForKey(key({ key: "End" }), ctx)).toEqual({ absolute: 0 });
  });

  it("leaves unshifted keys to the shell", () => {
    expect(scrollIntentForKey(key({ shiftKey: false }), ctx)).toBeNull();
    expect(scrollIntentForKey(key({ ctrlKey: true }), ctx)).toBeNull();
    expect(scrollIntentForKey(key({ key: "a" }), ctx)).toBeNull();
  });
});

describe("thumbGeometry", () => {
  it("sits at the bottom of the track when the view is live", () => {
    const { top, height } = thumbGeometry(0, 76, 24);
    expect(top + height).toBeCloseTo(1, 5);
  });

  it("sits at the top when fully scrolled back", () => {
    expect(thumbGeometry(76, 76, 24).top).toBe(0);
  });

  it("stays grabbable when the history dwarfs the viewport", () => {
    expect(thumbGeometry(0, 5000, 24).height).toBeGreaterThanOrEqual(0.04);
  });

  it("round-trips through offsetForThumbFraction", () => {
    for (const offset of [0, 17, 40, 76]) {
      const { top } = thumbGeometry(offset, 76, 24);
      expect(offsetForThumbFraction(top, 76, 24)).toBe(offset);
    }
  });
});

describe("offsetForThumbFraction", () => {
  it("clamps to the buffer", () => {
    expect(offsetForThumbFraction(-1, 76, 24)).toBe(76);
    expect(offsetForThumbFraction(2, 76, 24)).toBe(0);
  });
});
