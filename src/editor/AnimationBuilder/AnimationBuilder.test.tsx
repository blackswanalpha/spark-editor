/* sparkBook · AnimationBuilder.test.tsx
   Render smoke test plus the two interactions that carry the surface:
   a keyframe toggle and a stage edit must both reach `doc.raw`, since
   the file is the scene. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

vi.mock("@bridge/commands", () => ({
  saveFileDialog: vi.fn(async () => null),
  writeFile: vi.fn(async () => ({ path: "", bytes: 0, mtime: "", device: 0, inode: 0 })),
  openFileDialog: vi.fn(async () => null),
  readFileBase64: vi.fn(async () => ""),
  imageMime: () => "image/png",
}));

/* jsdom has neither of these; the stage observes its own box to fit the
   scene, and playback drives a rAF loop. */
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", NoopResizeObserver);

import { useDocs } from "@store/documents";
import { AnimationBuilder } from "./index";
import { emptyScene, parseScene, serializeScene } from "./model";

function openScene(): string {
  return useDocs.getState().open({
    name: "intro.sparkanim",
    path: "/intro.sparkanim",
    mode: "animation",
    raw: serializeScene(emptyScene()),
  });
}

const sceneOf = (id: string) => parseScene(useDocs.getState().docs[id].raw);

beforeEach(() => {
  cleanup();
  useDocs.setState({ docs: {}, order: [], active: null, history: {} });
  vi.clearAllMocks();
});

describe("AnimationBuilder", () => {
  it("renders the transport, the stage and the starter layer", () => {
    const id = openScene();
    render(<AnimationBuilder docId={id} />);
    expect(screen.getByTitle("Play / pause (Space)")).toBeTruthy();
    expect(screen.getByLabelText("Loop")).toBeTruthy();
    expect(screen.getByDisplayValue("Box")).toBeTruthy();
    expect(document.querySelector(".anim__stage")).toBeTruthy();
  });

  it("shows the scene length and stage size from the file", () => {
    const id = openScene();
    render(<AnimationBuilder docId={id} />);
    expect(screen.getByDisplayValue("3000")).toBeTruthy();
    expect(screen.getByLabelText("Stage width")).toHaveProperty("value", "960");
  });

  it("writes a duration change back to the document", () => {
    const id = openScene();
    render(<AnimationBuilder docId={id} />);
    fireEvent.change(screen.getByDisplayValue("3000"), { target: { value: "5000" } });
    expect(sceneOf(id).duration).toBe(5000);
    expect(useDocs.getState().docs[id].dirty).toBe(true);
  });

  it("adds a layer of the chosen kind", () => {
    const id = openScene();
    render(<AnimationBuilder docId={id} />);
    fireEvent.click(screen.getByLabelText("Add Text"));
    const scene = sceneOf(id);
    expect(scene.layers).toHaveLength(2);
    expect(scene.layers[1].kind).toBe("text");
  });

  it("removes the selected layer", () => {
    const id = openScene();
    render(<AnimationBuilder docId={id} />);
    fireEvent.click(screen.getByDisplayValue("Box"));
    fireEvent.click(screen.getByLabelText("Delete layer"));
    expect(sceneOf(id).layers).toHaveLength(0);
  });

  it("toggles a keyframe at the playhead", () => {
    const id = openScene();
    render(<AnimationBuilder docId={id} />);
    // The starter scene animates x/opacity/rotation but never width.
    expect(sceneOf(id).layers[0].tracks.width).toBeUndefined();
    fireEvent.click(screen.getByLabelText("Add Width keyframe"));
    expect(sceneOf(id).layers[0].tracks.width).toHaveLength(1);
    fireEvent.click(screen.getByLabelText("Remove Width keyframe"));
    expect(sceneOf(id).layers[0].tracks.width).toBeUndefined();
  });

  it("edits an animated property as a keyframe, not as the base value", () => {
    const id = openScene();
    render(<AnimationBuilder docId={id} />);
    const before = sceneOf(id).layers[0];
    // "Rotation" also names the easing select once a key sits at the
    // playhead, so target the number field by role.
    fireEvent.change(screen.getByRole("spinbutton", { name: "Rotation" }), { target: { value: "45" } });
    const after = sceneOf(id).layers[0];
    expect(after.base.rotation).toBe(before.base.rotation);
    expect(after.tracks.rotation?.find((k) => k.t === 0)?.value).toBe(45);
  });

  it("re-parses when the document's raw changes underneath it", () => {
    const id = openScene();
    render(<AnimationBuilder docId={id} />);
    const next = emptyScene();
    next.layers[0].name = "Renamed";
    act(() => { useDocs.getState().setRaw(id, serializeScene(next)); });
    expect(screen.getByDisplayValue("Renamed")).toBeTruthy();
  });

  it("survives a document whose JSON is broken", () => {
    const id = useDocs.getState().open({
      name: "broken.sparkanim", mode: "animation", raw: "{ not json",
    });
    render(<AnimationBuilder docId={id} />);
    expect(document.querySelector(".anim__stage")).toBeTruthy();
  });
});
