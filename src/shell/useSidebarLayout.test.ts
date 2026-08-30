/* sparkEditor — explorer pane geometry */
import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  clampWidth,
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
