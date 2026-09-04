/* sparkBook · ImageViewer.test.tsx
   The viewer must never write to the file it is showing, and the "Edit"
   handoff must land on the editor surface with the same bytes. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", NoopResizeObserver);
// jsdom implements neither half of the object-URL API.
vi.stubGlobal("URL", Object.assign(URL, {
  createObjectURL: vi.fn(() => "blob:mock"),
  revokeObjectURL: vi.fn(),
}));

import { useDocs } from "@store/documents";
import { ImageViewer } from "./index";

/* 1×1 transparent PNG. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function openImage(name = "photo.png") {
  return useDocs.getState().open({
    name, path: `/${name}`, mode: "image", raw: PNG_B64,
  });
}

beforeEach(() => {
  cleanup();
  useDocs.setState({ docs: {}, order: [], active: null, history: {} });
  vi.clearAllMocks();
});

describe("ImageViewer", () => {
  it("renders the image and the view controls", () => {
    const id = openImage();
    render(<ImageViewer docId={id} />);
    expect(screen.getByAltText("photo.png")).toBeTruthy();
    expect(screen.getByTitle("Fit to window (F)")).toBeTruthy();
    expect(screen.getByTitle("Actual size (0)")).toBeTruthy();
  });

  it("reports the file type and size", () => {
    const id = openImage();
    render(<ImageViewer docId={id} />);
    expect(screen.getByText("PNG")).toBeTruthy();
    expect(screen.getByText("70 B")).toBeTruthy();
  });

  it("changes zoom without touching the document", () => {
    const id = openImage();
    render(<ImageViewer docId={id} />);
    fireEvent.click(screen.getByTitle("Zoom in (+)"));
    expect(screen.getByTitle("Current zoom").textContent).not.toBe("100%");
    expect(useDocs.getState().docs[id].dirty).toBe(false);
    expect(useDocs.getState().docs[id].raw).toBe(PNG_B64);
  });

  it("rotates as a view transform only", () => {
    const id = openImage();
    render(<ImageViewer docId={id} />);
    fireEvent.click(screen.getByTitle("Rotate right (R)"));
    expect(screen.getByAltText("photo.png").getAttribute("style")).toContain("rotate(90deg)");
    expect(useDocs.getState().docs[id].dirty).toBe(false);
  });

  it("hands the same bytes to the editor", () => {
    const id = openImage();
    render(<ImageViewer docId={id} />);
    fireEvent.click(screen.getByTitle("Open these pixels in the image editor"));
    expect(useDocs.getState().docs[id].mode).toBe("imageedit");
    expect(useDocs.getState().docs[id].raw).toBe(PNG_B64);
    expect(useDocs.getState().docs[id].dirty).toBe(false);
  });

  it("reports bytes that are not an image rather than rendering nothing", () => {
    const id = useDocs.getState().open({
      name: "broken.png", path: "/broken.png", mode: "image", raw: "not-base64!!!",
    });
    render(<ImageViewer docId={id} />);
    expect(screen.getByText(/could not be read as an image/i)).toBeTruthy();
  });
});
