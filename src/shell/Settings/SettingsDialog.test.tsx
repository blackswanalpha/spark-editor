/* ============================================================
   sparkEditor · src/shell/Settings/SettingsDialog.test.tsx

   Regression cover for two bugs in the settings sheet:

     1. It could not be moved.
     2. Title and description were separate grid children, so the
        description absorbed the 1fr row and the section list was
        pushed to the bottom of an otherwise empty sheet.

   jsdom does no layout, so (2) is asserted structurally — the two
   rows the grid is declared for are the header and the section
   layout, and nothing else is an in-flow child.
   ============================================================ */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ThemeProvider } from "@theme/ThemeProvider";
import { SettingsDialog } from "./SettingsDialog";

beforeAll(() => {
  // Radix measures the viewport; jsdom needs these before it will mount.
  window.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(cleanup);

function open() {
  return render(
    <ThemeProvider>
      <SettingsDialog open onOpenChange={() => {}} />
    </ThemeProvider>,
  );
}

function sheet(): HTMLElement {
  const el = document.querySelector<HTMLElement>(".settings");
  if (!el) throw new Error("settings sheet did not render");
  return el;
}

function header(): HTMLElement {
  const el = document.querySelector<HTMLElement>(".settings__head");
  if (!el) throw new Error("settings header did not render");
  return el;
}

/** Pixel value of an inline geometry property. */
function px(el: HTMLElement, prop: "left" | "top"): number {
  return parseFloat(el.style[prop]);
}

describe("SettingsDialog", () => {
  it("positions itself with coordinates, not a centring transform", () => {
    open();
    const el = sheet();
    // The entrance animation owns `transform`; positioning must not.
    expect(el.style.left).not.toBe("");
    expect(el.style.top).not.toBe("");
    expect(el.style.width).not.toBe("");
    expect(el.style.height).not.toBe("");
  });

  it("moves when the header is dragged", () => {
    open();
    const el = sheet();
    const startX = px(el, "left");
    const startY = px(el, "top");

    fireEvent.pointerDown(header(), { clientX: 300, clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(header(), { clientX: 380, clientY: 260, pointerId: 1 });

    expect(px(el, "left")).toBe(startX + 80);
    expect(px(el, "top")).toBe(startY + 60);

    fireEvent.pointerUp(header(), { clientX: 380, clientY: 260, pointerId: 1 });

    // The drag has ended: further movement must not follow the pointer.
    fireEvent.pointerMove(header(), { clientX: 500, clientY: 500, pointerId: 1 });
    expect(px(el, "left")).toBe(startX + 80);
  });

  it("does not start a drag from the close button", () => {
    open();
    const el = sheet();
    const startX = px(el, "left");

    const close = screen.getByLabelText("Close settings");
    fireEvent.pointerDown(close, { clientX: 300, clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(header(), { clientX: 420, clientY: 200, pointerId: 1 });

    expect(px(el, "left")).toBe(startX);
  });

  it("keeps the sheet on screen when dragged past the edge", () => {
    open();
    const el = sheet();

    fireEvent.pointerDown(header(), { clientX: 300, clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(header(), { clientX: 9000, clientY: 9000, pointerId: 1 });

    // At least a grab-able strip stays inside the viewport.
    expect(px(el, "left")).toBeLessThanOrEqual(window.innerWidth - 120);
    expect(px(el, "top")).toBeLessThanOrEqual(window.innerHeight - 48);
  });

  it("lays the sheet out as exactly two rows: header, then sections", () => {
    open();
    const el = sheet();
    const inFlow = Array.from(el.children).filter(
      (c) => !(c as HTMLElement).classList.contains("settings__close"),
    );
    expect(inFlow.map((c) => c.className)).toEqual(["settings__head", "settings__layout"]);
    // The description must be inside the header, not a third row of its own.
    expect(header().querySelector(".settings__desc")).not.toBeNull();
  });
});
