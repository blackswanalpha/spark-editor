/* sparkEditor — explorer pane geometry */
import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  clampWidth,
  maxWidthFor,
  useSidebarLayout,
  SIDEBAR_COLLAPSE_AT,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
} from "./useSidebarLayout";

describe("clampWidth", () => {
  it("keeps values inside the usable range", () => {
    expect(clampWidth(300)).toBe(300);
    expect(clampWidth(10)).toBe(SIDEBAR_MIN);
    expect(clampWidth(99999)).toBe(SIDEBAR_MAX);
    expect(clampWidth(SIDEBAR_MIN)).toBe(SIDEBAR_MIN);
    expect(clampWidth(SIDEBAR_MAX)).toBe(SIDEBAR_MAX);
  });

  it("rounds to whole pixels", () => {
    expect(clampWidth(300.7)).toBe(301);
  });

  it("falls back to the default for junk input", () => {
    expect(clampWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT);
    expect(clampWidth(Number.POSITIVE_INFINITY)).toBe(SIDEBAR_MAX);
  });
});

describe("useSidebarLayout", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("starts at the default width, expanded", () => {
    const { result } = renderHook(() => useSidebarLayout());
    expect(result.current.width).toBe(SIDEBAR_DEFAULT);
    expect(result.current.collapsed).toBe(false);
  });

  it("persists width and collapsed state across mounts", () => {
    const first = renderHook(() => useSidebarLayout());
    act(() => first.result.current.setWidth(420));
    act(() => first.result.current.setCollapsed(true));
    first.unmount();

    const second = renderHook(() => useSidebarLayout());
    expect(second.result.current.width).toBe(420);
    expect(second.result.current.collapsed).toBe(true);
  });

  it("clamps a persisted width that is out of range", () => {
    localStorage.setItem("spark.sidebar.width", "5000");
    const { result } = renderHook(() => useSidebarLayout());
    expect(result.current.width).toBe(SIDEBAR_MAX);
  });

  it("ignores a corrupt persisted width", () => {
    localStorage.setItem("spark.sidebar.width", "not-a-number");
    const { result } = renderHook(() => useSidebarLayout());
    expect(result.current.width).toBe(SIDEBAR_DEFAULT);
  });

  it("toggles collapsed without losing the remembered width", () => {
    const { result } = renderHook(() => useSidebarLayout());
    act(() => result.current.setWidth(380));
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(false);
    // Reopening must restore the size the user chose, not the default.
    expect(result.current.width).toBe(380);
  });

  it("reset restores the default and reopens the pane", () => {
    const { result } = renderHook(() => useSidebarLayout());
    act(() => result.current.setWidth(600));
    act(() => result.current.setCollapsed(true));
    act(() => result.current.reset());
    expect(result.current.width).toBe(SIDEBAR_DEFAULT);
    expect(result.current.collapsed).toBe(false);
  });

  describe("keyboard resizing", () => {
    const arrow = (key: string, shiftKey = false) =>
      ({ key, shiftKey, preventDefault: () => {} }) as React.KeyboardEvent;

    it("widens and narrows in steps", () => {
      const { result } = renderHook(() => useSidebarLayout());
      act(() => result.current.onHandleKeyDown(arrow("ArrowRight")));
      expect(result.current.width).toBe(SIDEBAR_DEFAULT + 16);
      act(() => result.current.onHandleKeyDown(arrow("ArrowLeft")));
      expect(result.current.width).toBe(SIDEBAR_DEFAULT);
    });

    it("uses a coarse step with shift", () => {
      const { result } = renderHook(() => useSidebarLayout());
      act(() => result.current.onHandleKeyDown(arrow("ArrowRight", true)));
      expect(result.current.width).toBe(SIDEBAR_DEFAULT + 48);
    });

    it("snaps closed when narrowed past the collapse threshold", () => {
      const { result } = renderHook(() => useSidebarLayout());
      act(() => result.current.setWidth(SIDEBAR_MIN));
      // From the minimum, one narrow step lands under the threshold only
      // because the clamp floor is above it — so drive it explicitly.
      for (let i = 0; i < 20 && !result.current.collapsed; i++) {
        act(() => result.current.onHandleKeyDown(arrow("ArrowLeft")));
      }
      expect(result.current.collapsed).toBe(true);
      expect(SIDEBAR_COLLAPSE_AT).toBeLessThan(SIDEBAR_MIN);
    });

    it("ArrowRight reopens a collapsed pane", () => {
      const { result } = renderHook(() => useSidebarLayout());
      act(() => result.current.setCollapsed(true));
      act(() => result.current.onHandleKeyDown(arrow("ArrowRight")));
      expect(result.current.collapsed).toBe(false);
    });

    it("Enter toggles and Home resets", () => {
      const { result } = renderHook(() => useSidebarLayout());
      act(() => result.current.onHandleKeyDown(arrow("Enter")));
      expect(result.current.collapsed).toBe(true);
      act(() => result.current.onHandleKeyDown(arrow("Home")));
      expect(result.current.collapsed).toBe(false);
      expect(result.current.width).toBe(SIDEBAR_DEFAULT);
    });

    it("never exceeds the maximum", () => {
      const { result } = renderHook(() => useSidebarLayout());
      for (let i = 0; i < 60; i++) {
        act(() => result.current.onHandleKeyDown(arrow("ArrowRight", true)));
      }
      expect(result.current.width).toBe(SIDEBAR_MAX);
    });
  });
});

describe("maxWidthFor", () => {
  it("never lets the pane crowd the editor out of the window", () => {
    // 900px window: rail (51) + pane + 320 of editor has to fit.
    expect(maxWidthFor(900)).toBe(900 - 51 - 320);
    // A roomy window is limited by the pane's own maximum instead.
    expect(maxWidthFor(1600)).toBe(SIDEBAR_MAX);
  });

  it("still returns a usable width on a tiny viewport", () => {
    expect(maxWidthFor(200)).toBe(SIDEBAR_MIN);
    expect(maxWidthFor(0)).toBe(SIDEBAR_MAX);
  });
});

describe("dragging", () => {
  // Sibling of the suite above, so it needs its own clean slate: a
  // persisted width would change what a drag starts from.
  beforeEach(() => localStorage.clear());

  /** A pointer event shaped like the one the resize handle hands over. */
  function pointerDown(clientX: number) {
    const handle = document.createElement("div");
    document.body.appendChild(handle);
    handle.setPointerCapture = () => {};
    handle.releasePointerCapture = () => {};
    return { clientX, pointerId: 1, currentTarget: handle, preventDefault: () => {} } as unknown as React.PointerEvent;
  }

  const move = (clientX: number) =>
    window.dispatchEvent(new MouseEvent("pointermove", { clientX }));
  const up = () => window.dispatchEvent(new MouseEvent("pointerup", {}));

  const frame = () =>
    act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });

  it("moves the pane element without re-rendering, then commits on release", async () => {
    const { result } = renderHook(() => useSidebarLayout());
    const pane = document.createElement("aside");
    document.body.appendChild(pane);
    result.current.paneRef.current = pane;

    act(() => result.current.startResize(pointerDown(300)));
    act(() => void move(380));
    await frame();

    /* The whole point of the change: the element tracks the pointer while
       React state stays put, so the file tree is not re-rendered sixty
       times a second and the pane does not lag behind the cursor. */
    expect(pane.style.width).toBe(`${SIDEBAR_DEFAULT + 80}px`);
    expect(result.current.width).toBe(SIDEBAR_DEFAULT);

    act(() => void up());
    expect(result.current.width).toBe(SIDEBAR_DEFAULT + 80);
    expect(result.current.dragging).toBe(false);
    // React owns the width again once the drag is over.
    expect(pane.style.width).toBe("");
  });

  it("collapses when dragged past the snap threshold", async () => {
    const { result } = renderHook(() => useSidebarLayout());
    const pane = document.createElement("aside");
    result.current.paneRef.current = pane;

    act(() => result.current.startResize(pointerDown(300)));
    act(() => void move(300 - SIDEBAR_DEFAULT));
    await frame();
    expect(result.current.collapsed).toBe(true);

    act(() => void up());
    // The remembered width survives the collapse.
    expect(result.current.width).toBe(SIDEBAR_DEFAULT);
  });

  it("cannot be dragged wider than the window allows", async () => {
    const { result } = renderHook(() => useSidebarLayout());
    const pane = document.createElement("aside");
    result.current.paneRef.current = pane;

    act(() => result.current.startResize(pointerDown(0)));
    act(() => void move(5000));
    await frame();
    act(() => void up());

    expect(result.current.width).toBeLessThanOrEqual(maxWidthFor(window.innerWidth));
  });
});
