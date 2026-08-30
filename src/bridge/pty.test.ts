/* sparkEditor — terminal key/paste encoding
   These run without a DOM terminal because encoding is pure: a
   KeyboardEvent-shaped input in, tty bytes out. */
import { describe, expect, it, vi } from "vitest";

vi.mock("@bridge/commands", () => ({ isTauri: false }));

import { encodeKey, encodePaste, type KeyContext } from "./pty";

const NORMAL: KeyContext = { applicationCursor: false };
const APP: KeyContext = { applicationCursor: true };

function key(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...init,
  } as KeyboardEvent;
}

describe("encodeKey", () => {
  it("passes printable characters straight through", () => {
    expect(encodeKey(key({ key: "a" }), NORMAL)).toBe("a");
    expect(encodeKey(key({ key: "Z" }), NORMAL)).toBe("Z");
    expect(encodeKey(key({ key: " " }), NORMAL)).toBe(" ");
    expect(encodeKey(key({ key: "é" }), NORMAL)).toBe("é");
  });

  it("sends CR for Enter, not LF", () => {
    // A tty line discipline expects CR; sending LF submits nothing in bash.
    expect(encodeKey(key({ key: "Enter" }), NORMAL)).toBe("\r");
  });

  it("sends DEL for Backspace", () => {
    expect(encodeKey(key({ key: "Backspace" }), NORMAL)).toBe("\x7f");
    expect(encodeKey(key({ key: "Backspace", ctrlKey: true }), NORMAL)).toBe("\x1b\x7f");
  });

  it("maps ctrl+letter to its control code", () => {
    expect(encodeKey(key({ key: "c", ctrlKey: true }), NORMAL)).toBe("\x03"); // SIGINT
    expect(encodeKey(key({ key: "d", ctrlKey: true }), NORMAL)).toBe("\x04"); // EOF
    expect(encodeKey(key({ key: "z", ctrlKey: true }), NORMAL)).toBe("\x1a"); // SIGTSTP
    expect(encodeKey(key({ key: "a", ctrlKey: true }), NORMAL)).toBe("\x01");
    // Case must not matter: shift+ctrl+C still produces ^C.
    expect(encodeKey(key({ key: "C", ctrlKey: true }), NORMAL)).toBe("\x03");
  });

  it("switches arrow encoding with DECCKM", () => {
    expect(encodeKey(key({ key: "ArrowUp" }), NORMAL)).toBe("\x1b[A");
    expect(encodeKey(key({ key: "ArrowUp" }), APP)).toBe("\x1bOA");
    expect(encodeKey(key({ key: "ArrowLeft" }), NORMAL)).toBe("\x1b[D");
    expect(encodeKey(key({ key: "ArrowRight" }), APP)).toBe("\x1bOC");
  });

  it("encodes modified arrows in xterm's CSI 1 ; mod form", () => {
    expect(encodeKey(key({ key: "ArrowLeft", ctrlKey: true }), NORMAL)).toBe("\x1b[1;5D");
    expect(encodeKey(key({ key: "ArrowRight", altKey: true }), NORMAL)).toBe("\x1b[1;3C");
    expect(encodeKey(key({ key: "ArrowUp", shiftKey: true }), NORMAL)).toBe("\x1b[1;2A");
  });

  it("ESC-prefixes alt combinations (readline meta)", () => {
    expect(encodeKey(key({ key: "b", altKey: true }), NORMAL)).toBe("\x1bb");
    expect(encodeKey(key({ key: "f", altKey: true }), NORMAL)).toBe("\x1bf");
  });

  it("encodes navigation and function keys", () => {
    expect(encodeKey(key({ key: "Tab" }), NORMAL)).toBe("\t");
    expect(encodeKey(key({ key: "Tab", shiftKey: true }), NORMAL)).toBe("\x1b[Z");
    expect(encodeKey(key({ key: "Delete" }), NORMAL)).toBe("\x1b[3~");
    expect(encodeKey(key({ key: "PageUp" }), NORMAL)).toBe("\x1b[5~");
    expect(encodeKey(key({ key: "F1" }), NORMAL)).toBe("\x1bOP");
    expect(encodeKey(key({ key: "F12" }), NORMAL)).toBe("\x1b[24~");
    expect(encodeKey(key({ key: "Escape" }), NORMAL)).toBe("\x1b");
  });

  it("produces nothing for bare modifiers", () => {
    for (const k of ["Shift", "Control", "Alt", "Meta", "CapsLock"]) {
      expect(encodeKey(key({ key: k }), NORMAL)).toBeNull();
    }
  });

  it("leaves Cmd/Super shortcuts to the app", () => {
    // Cmd+W must close the tab, not type a 'w' into the shell.
    expect(encodeKey(key({ key: "w", metaKey: true }), NORMAL)).toBeNull();
    expect(encodeKey(key({ key: "c", metaKey: true }), NORMAL)).toBeNull();
  });

  it("returns null for unhandled named keys", () => {
    expect(encodeKey(key({ key: "ScrollLock" }), NORMAL)).toBeNull();
  });
});

describe("encodePaste", () => {
  it("normalises CRLF and LF to CR", () => {
    // Pasting "a\r\nb" as-is submits twice: once for CR, once for LF.
    expect(encodePaste("a\r\nb", false)).toBe("a\rb");
    expect(encodePaste("a\nb", false)).toBe("a\rb");
  });

  it("wraps in bracketed-paste markers when the program asked for them", () => {
    expect(encodePaste("ls", true)).toBe("\x1b[200~ls\x1b[201~");
  });

  it("normalises inside the brackets too", () => {
    expect(encodePaste("a\nb", true)).toBe("\x1b[200~a\rb\x1b[201~");
  });

  it("handles empty input", () => {
    expect(encodePaste("", false)).toBe("");
  });
});
