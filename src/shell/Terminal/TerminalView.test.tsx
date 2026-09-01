/* sparkEditor — what the terminal surface actually sends

   The encoder is unit-tested in bridge/pty.test.ts. This covers the
   wiring between a real key press on the focused surface and the bytes
   handed to `pty_write`, which is where a key can be lost without any
   encoder test noticing: an early return, a guard in the wrong order,
   or a handler attached to the wrong element. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

/* `vi.mock` is hoisted above every top-level binding, so the spies have
   to live somewhere the factory can reach at call time rather than at
   definition time — `vi.hoisted` is that place. */
const { ptyWrite, unlisten, frameHandlers } = vi.hoisted(() => ({
  ptyWrite: vi.fn(() => Promise.resolve()),
  unlisten: vi.fn(),
  frameHandlers: [] as ((f: unknown) => void)[],
}));

vi.mock("@bridge/commands", () => ({ isTauri: false }));

/* jsdom has no ResizeObserver, and the surface observes its own box to
   derive rows/cols. A stub that never fires is enough: the size the
   component falls back to is the one these assertions care about. */
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", NoopResizeObserver);

/* jsdom has no pointer capture; the surface uses it to keep a drag alive
   once the pointer leaves the element. */
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

vi.mock("@bridge/clipboard", () => ({
  writeClipboardText: vi.fn(() => Promise.resolve(true)),
  readClipboardText: vi.fn(() => Promise.resolve("pasted")),
}));

vi.mock("@bridge/pty", async (importActual) => {
  // The encoders are the real ones — this is a wiring test, not a
  // re-test of the encoding.
  const actual = await importActual<typeof import("@bridge/pty")>();
  return {
    ...actual,
    ptySpawn: vi.fn(() =>
      Promise.resolve({
        id: "pty-1",
        shell: "/bin/bash",
        cwd: "/tmp",
        privilege: "user" as const,
        rows: 24,
        cols: 80,
      }),
    ),
    ptyWrite,
    ptyResize: vi.fn(() => Promise.resolve()),
    ptyRefresh: vi.fn(() => Promise.resolve()),
    ptyKill: vi.fn(() => Promise.resolve()),
    ptyScroll: vi.fn(() => Promise.resolve(0)),
    ptyList: vi.fn(() => Promise.resolve([{ id: "pty-1" }])),
    onPtyFrame: vi.fn((_id: string, handler: (f: unknown) => void) => {
      frameHandlers.push(handler);
      return Promise.resolve(unlisten);
    }),
    onPtyExit: vi.fn(() => Promise.resolve(unlisten)),
  };
});

import { TerminalView } from "./TerminalView";

/** Mount and wait for the session to reach "running". */
async function mountTerminal() {
  render(<TerminalView cwd="/tmp" privilege="user" />);
  // Let the spawn promise chain settle.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  const surface = screen.getByRole("textbox", { name: "Terminal" });
  act(() => surface.focus());
  return surface;
}

/** Push a frame at the component, as the host's event would. */
function pushFrame(over: Record<string, unknown> = {}) {
  act(() => {
    for (const handler of frameHandlers) {
      handler({
        id: "pty-1",
        rows: 24,
        cols: 80,
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
        seq: seq++,
        ...over,
      });
    }
  });
}
let seq = 1;

/** A pointer event as the browser would deliver it (jsdom has no PointerEvent). */
function pointer(el: HTMLElement, type: string, init: MouseEventInit = {}) {
  act(() => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
  });
}

/** A real keydown on the focused surface, as the browser would deliver it. */
function press(el: HTMLElement, init: KeyboardEventInit & { key: string }) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    el.dispatchEvent(event);
  });
  return event;
}

describe("TerminalView — keys reach the pty", () => {
  beforeEach(() => {
    ptyWrite.mockClear();
    frameHandlers.length = 0;
  });
  afterEach(cleanup);

  it("sends back-tab for Shift+Tab, and cancels the browser's focus move", async () => {
    /* The regression: Shift+Tab produced nothing in the terminal, so
       anything bound to it in a full-screen program was unreachable. If
       the default is not cancelled the webview moves focus instead and
       the shell never sees the key. */
    const surface = await mountTerminal();
    const event = press(surface, { key: "Tab", shiftKey: true });

    expect(ptyWrite).toHaveBeenCalledWith("pty-1", "\x1b[Z");
    expect(event.defaultPrevented).toBe(true);
  });

  it("sends a plain tab for Tab", async () => {
    const surface = await mountTerminal();
    const event = press(surface, { key: "Tab" });
    expect(ptyWrite).toHaveBeenCalledWith("pty-1", "\t");
    expect(event.defaultPrevented).toBe(true);
  });

  it("sends SIGINT for Ctrl+C and text for an ordinary key", async () => {
    const surface = await mountTerminal();
    press(surface, { key: "c", ctrlKey: true });
    expect(ptyWrite).toHaveBeenCalledWith("pty-1", "\x03");

    ptyWrite.mockClear();
    press(surface, { key: "a" });
    expect(ptyWrite).toHaveBeenCalledWith("pty-1", "a");
  });

  it("keeps the clipboard bindings away from the shell", async () => {
    const surface = await mountTerminal();
    press(surface, { key: "v", ctrlKey: true });
    press(surface, { key: "C", ctrlKey: true, shiftKey: true });
    // Neither may be typed into the running program.
    expect(ptyWrite).not.toHaveBeenCalled();
  });

  it("keeps focus on the surface after a key it handles", async () => {
    const surface = await mountTerminal();
    press(surface, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(surface);
  });
});

describe("TerminalView — a program that owns the mouse", () => {
  beforeEach(() => {
    ptyWrite.mockClear();
    frameHandlers.length = 0;
  });
  afterEach(cleanup);

  it("hands a click to the program instead of swallowing it", async () => {
    /* The regression: with mouse reporting on — every full-screen TUI —
       the surface declined to select AND sent nothing, so clicking in a
       TUI did nothing at all and there was no way to copy out of one. */
    const surface = await mountTerminal();
    pushFrame({ mouseMode: "buttonMotion", mouseEncoding: "sgr", alternateScreen: true });

    pointer(surface, "pointerdown", { button: 0, clientX: 0, clientY: 0 });
    expect(ptyWrite).toHaveBeenCalledWith("pty-1", "\x1b[<0;1;1M");

    ptyWrite.mockClear();
    pointer(surface, "pointerup", { button: 0, clientX: 0, clientY: 0 });
    expect(ptyWrite).toHaveBeenCalledWith("pty-1", "\x1b[<0;1;1m");
  });

  it("lets shift override the program so text can still be selected", async () => {
    // The standard override, and the only way to copy out of a TUI.
    const surface = await mountTerminal();
    pushFrame({ mouseMode: "buttonMotion", mouseEncoding: "sgr", alternateScreen: true });

    pointer(surface, "pointerdown", { button: 0, shiftKey: true, clientX: 0, clientY: 0 });
    // A selection drag must not be reported to the program as a click.
    expect(ptyWrite).not.toHaveBeenCalled();
  });

  it("still selects normally when no program asked for the mouse", async () => {
    const surface = await mountTerminal();
    pointer(surface, "pointerdown", { button: 0, clientX: 0, clientY: 0 });
    expect(ptyWrite).not.toHaveBeenCalled();
  });
});
