/* ============================================================
   sparkBook · lib/binary.test.ts
   Base64 round-trips, size maths and data-URI handling.
   ============================================================ */
import { describe, it, expect } from "vitest";
import {
  base64ByteLength, base64ToBytes, bytesToBase64, dataUri, formatBytes, stripDataUri,
} from "./binary";

describe("base64 round-trip", () => {
  it("survives arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 65, 66, 67]);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });

  it("handles an empty payload", () => {
    expect(bytesToBase64(new Uint8Array())).toBe("");
    expect(base64ToBytes("")).toHaveLength(0);
  });

  it("survives a payload past the chunking threshold", () => {
    const bytes = new Uint8Array(70_000).map((_, i) => i % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("decodes a payload that still carries its data-URI prefix", () => {
    const b64 = bytesToBase64(new Uint8Array([1, 2, 3]));
    expect(Array.from(base64ToBytes(`data:image/png;base64,${b64}`))).toEqual([1, 2, 3]);
  });

  it("ignores whitespace inside the payload", () => {
    const b64 = bytesToBase64(new Uint8Array([1, 2, 3, 4, 5, 6]));
    const wrapped = `${b64.slice(0, 4)}\n  ${b64.slice(4)}`;
    expect(Array.from(base64ToBytes(wrapped))).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("stripDataUri", () => {
  it("removes only a real prefix", () => {
    expect(stripDataUri("data:image/png;base64,AAA")).toBe("AAA");
    expect(stripDataUri("AAA")).toBe("AAA");
    // A bare comma is not a data URI and must survive untouched.
    expect(stripDataUri("AA,BB")).toBe("AA,BB");
  });
});

describe("dataUri", () => {
  it("does not double the prefix", () => {
    expect(dataUri("AAA", "image/png")).toBe("data:image/png;base64,AAA");
    expect(dataUri("data:image/jpeg;base64,AAA", "image/png")).toBe("data:image/png;base64,AAA");
  });
});

describe("base64ByteLength", () => {
  it("matches the decoded length for every padding case", () => {
    for (const n of [0, 1, 2, 3, 4, 5, 100, 1023]) {
      const bytes = new Uint8Array(n);
      expect(base64ByteLength(bytesToBase64(bytes))).toBe(n);
    }
  });
});

describe("formatBytes", () => {
  it("picks a readable unit", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1024)).toBe("1.0 kB");
    expect(formatBytes(1024 * 1024 * 3)).toBe("3.0 MB");
    expect(formatBytes(1024 * 1024 * 1024 * 2)).toBe("2.0 GB");
  });

  it("reports an em dash for nonsense", () => {
    expect(formatBytes(NaN)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
  });
});
