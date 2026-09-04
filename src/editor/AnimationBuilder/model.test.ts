/* ============================================================
   sparkBook · AnimationBuilder/model.test.ts
   Sampling, keyframe editing and round-tripping.
   ============================================================ */
import { describe, it, expect } from "vitest";
import {
  ease, emptyScene, layerKeyTimes, mixColor, moveKeyframe, parseScene,
  removeKeyframe, sampleLayer, sampleProp, serializeScene, setEasing,
  setKeyframe, snapToFrame, sortedTrack,
  type AnimLayer,
} from "./model";

function layer(tracks: AnimLayer["tracks"] = {}): AnimLayer {
  return {
    id: "l1",
    name: "L",
    kind: "rect",
    visible: true,
    locked: false,
    base: { x: 10, y: 20, width: 100, height: 50, rotation: 0, scale: 1, opacity: 1, fill: "#000000" },
    style: {
      stroke: "#00000000", strokeWidth: 0, radius: 8, text: "",
      fontSize: 48, fontFamily: "Inter", fontWeight: 600, src: "",
    },
    tracks,
  };
}

describe("ease", () => {
  it("pins both ends for every curve", () => {
    for (const kind of ["linear", "easeIn", "easeOut", "easeInOut", "backOut", "bounceOut"] as const) {
      expect(ease(kind, 0)).toBeCloseTo(0, 5);
      expect(ease(kind, 1)).toBeCloseTo(1, 5);
    }
  });

  it("clamps input outside 0..1", () => {
    expect(ease("linear", -3)).toBe(0);
    expect(ease("linear", 4)).toBe(1);
  });

  it("holds the start value across a stepped segment", () => {
    expect(ease("step", 0.99)).toBe(0);
  });
});

describe("sampleProp", () => {
  it("falls back to the base value with no track", () => {
    expect(sampleProp(layer(), "x", 500)).toBe(10);
  });

  it("interpolates linearly between two keyframes", () => {
    const l = layer({ x: [{ t: 0, value: 0, easing: "linear" }, { t: 1000, value: 100, easing: "linear" }] });
    expect(sampleProp(l, "x", 500)).toBeCloseTo(50);
  });

  it("clamps before the first and after the last keyframe", () => {
    const l = layer({ x: [{ t: 200, value: 5, easing: "linear" }, { t: 800, value: 9, easing: "linear" }] });
    expect(sampleProp(l, "x", 0)).toBe(5);
    expect(sampleProp(l, "x", 99999)).toBe(9);
  });

  it("picks the segment its easing belongs to", () => {
    const l = layer({
      x: [
        { t: 0, value: 0, easing: "step" },
        { t: 100, value: 50, easing: "linear" },
        { t: 200, value: 100, easing: "linear" },
      ],
    });
    // Stepped first segment holds 0 right up to the next key…
    expect(sampleProp(l, "x", 99)).toBe(0);
    // …and the linear second segment interpolates normally.
    expect(sampleProp(l, "x", 150)).toBeCloseTo(75);
  });

  it("blends colour keyframes", () => {
    const l = layer({
      fill: [
        { t: 0, value: "#000000", easing: "linear" },
        { t: 100, value: "#ffffff", easing: "linear" },
      ],
    });
    expect(sampleProp(l, "fill", 50)).toBe("#808080");
  });

  it("tolerates unsorted keyframes", () => {
    const l = layer({ x: [{ t: 1000, value: 100, easing: "linear" }, { t: 0, value: 0, easing: "linear" }] });
    expect(sampleProp(l, "x", 500)).toBeCloseTo(50);
  });
});

describe("sampleLayer", () => {
  it("clamps opacity and defaults a missing scale to 1", () => {
    const l = layer({ opacity: [{ t: 0, value: 5, easing: "linear" }] });
    const s = sampleLayer(l, 0);
    expect(s.opacity).toBe(1);
    expect(s.scale).toBe(1);
  });
});

describe("mixColor", () => {
  it("handles short hex and alpha", () => {
    expect(mixColor("#000", "#fff", 1)).toBe("#ffffff");
    expect(mixColor("#00000000", "#00000000", 0.5)).toBe("#00000000");
  });
});

describe("keyframe editing", () => {
  it("adds, replaces and removes at a time", () => {
    let l = layer();
    l = setKeyframe(l, "x", 100, 42);
    expect(l.tracks.x).toHaveLength(1);
    l = setKeyframe(l, "x", 100, 43);
    expect(l.tracks.x).toHaveLength(1);
    expect(l.tracks.x?.[0].value).toBe(43);
    l = removeKeyframe(l, "x", 100);
    expect(l.tracks.x).toBeUndefined();
  });

  it("keeps the track sorted when a key moves past a neighbour", () => {
    let l = layer({
      x: [{ t: 0, value: 0, easing: "linear" }, { t: 100, value: 1, easing: "linear" }],
    });
    l = moveKeyframe(l, "x", 0, 500);
    expect(l.tracks.x?.map((k) => k.t)).toEqual([100, 500]);
  });

  it("never moves a keyframe before zero", () => {
    let l = layer({ x: [{ t: 100, value: 1, easing: "linear" }] });
    l = moveKeyframe(l, "x", 100, -50);
    expect(l.tracks.x?.[0].t).toBe(0);
  });

  it("changes easing on one keyframe only", () => {
    let l = layer({
      x: [{ t: 0, value: 0, easing: "linear" }, { t: 100, value: 1, easing: "linear" }],
    });
    l = setEasing(l, "x", 100, "bounceOut");
    expect(l.tracks.x?.[0].easing).toBe("linear");
    expect(l.tracks.x?.[1].easing).toBe("bounceOut");
  });

  it("reports every distinct key time across tracks", () => {
    const l = layer({
      x: [{ t: 0, value: 0, easing: "linear" }, { t: 300, value: 1, easing: "linear" }],
      opacity: [{ t: 300, value: 0, easing: "linear" }, { t: 900, value: 1, easing: "linear" }],
    });
    expect(layerKeyTimes(l)).toEqual([0, 300, 900]);
  });

  it("does not mutate the layer it is given", () => {
    const l = layer({ x: [{ t: 0, value: 0, easing: "linear" }] });
    const before = JSON.stringify(l);
    setKeyframe(l, "x", 500, 9);
    removeKeyframe(l, "x", 0);
    expect(JSON.stringify(l)).toBe(before);
  });
});

describe("snapToFrame", () => {
  it("rounds to the nearest frame boundary", () => {
    expect(snapToFrame(33, 60)).toBeCloseTo(33.333, 2);
    expect(snapToFrame(0, 60)).toBe(0);
    expect(snapToFrame(100, 10)).toBe(100);
  });
});

describe("sortedTrack", () => {
  it("returns a new array", () => {
    const track = [{ t: 5, value: 1, easing: "linear" as const }];
    expect(sortedTrack(track)).not.toBe(track);
  });
});

describe("parseScene / serializeScene", () => {
  it("round-trips a scene", () => {
    const scene = emptyScene();
    expect(parseScene(serializeScene(scene))).toEqual(scene);
  });

  it("falls back to a starter scene on empty or broken input", () => {
    expect(parseScene("").layers.length).toBeGreaterThan(0);
    expect(parseScene("{not json").layers.length).toBeGreaterThan(0);
    expect(parseScene("[]").layers).toHaveLength(0);
  });

  it("repairs out-of-range and missing fields", () => {
    const parsed = parseScene(JSON.stringify({
      width: -10,
      duration: 5,
      fps: 9999,
      layers: [{ kind: "nope", base: { opacity: 7 }, tracks: { x: "not an array" } }],
    }));
    expect(parsed.width).toBeGreaterThan(0);
    expect(parsed.duration).toBeGreaterThanOrEqual(100);
    expect(parsed.fps).toBeLessThanOrEqual(120);
    expect(parsed.layers[0].kind).toBe("rect");
    expect(parsed.layers[0].base.opacity).toBe(1);
    expect(parsed.layers[0].tracks.x).toBeUndefined();
  });

  it("drops keyframes with no usable time", () => {
    const parsed = parseScene(JSON.stringify({
      layers: [{ tracks: { x: [{ t: "soon", value: 1 }] } }],
    }));
    expect(parsed.layers[0].tracks.x).toBeUndefined();
  });
});
