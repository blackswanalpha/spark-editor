/* sparkEditor — wheel translation for programs that own the screen */
import { describe, expect, it, vi } from "vitest";

vi.mock("@bridge/commands", () => ({ isTauri: false }));

import { encodeArrow, encodeWheelMouse, type WheelReport } from "@bridge/pty";

const at = (over: Partial<WheelReport> = {}): WheelReport => ({
  up: true,
  col: 0,
  row: 0,
  shift: false,
  alt: false,
  ctrl: false,
  ...over,
});

describe("encodeWheelMouse", () => {
  it("uses wheel buttons 64 and 65", () => {
    expect(encodeWheelMouse(at(), "sgr")).toBe("\x1b[<64;1;1M");
    expect(encodeWheelMouse(at({ up: false }), "sgr")).toBe("\x1b[<65;1;1M");
  });

  it("reports the cell under the pointer, 1-based", () => {
    expect(encodeWheelMouse(at({ col: 11, row: 4 }), "sgr")).toBe("\x1b[<64;12;5M");
  });

  it("folds modifiers into the button", () => {
    expect(encodeWheelMouse(at({ shift: true }), "sgr")).toBe("\x1b[<68;1;1M");
    expect(encodeWheelMouse(at({ alt: true }), "sgr")).toBe("\x1b[<72;1;1M");
    expect(encodeWheelMouse(at({ ctrl: true }), "sgr")).toBe("\x1b[<80;1;1M");
  });

  it("offsets every field by 32 in the legacy encoding", () => {
    expect(encodeWheelMouse(at({ col: 2, row: 3 }), "default")).toBe(
      `\x1b[M${String.fromCharCode(96, 35, 36)}`,
    );
  });

  it("keeps a legacy report six single-byte chars wide", () => {
    const out = encodeWheelMouse(at({ col: 500, row: 0 }), "default");
    expect(out).toHaveLength(6);
    expect(out.charCodeAt(4)).toBe(32 + 95);
    expect([...out].every((c) => c.charCodeAt(0) < 128)).toBe(true);
  });

  it("lets the utf8 encoding carry a wide column", () => {
    expect(encodeWheelMouse(at({ col: 500 }), "utf8").charCodeAt(4)).toBe(32 + 501);
  });
});

describe("encodeArrow", () => {
  it("follows DECCKM", () => {
    expect(encodeArrow("up", false)).toBe("\x1b[A");
    expect(encodeArrow("down", false)).toBe("\x1b[B");
    expect(encodeArrow("up", true)).toBe("\x1bOA");
  });
});
