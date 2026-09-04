/* ============================================================
   sparkBook · src/editor/AnimationBuilder/model.ts
   Scene model, keyframe interpolation and export for the
   animation builder.

   The document is plain JSON (`.sparkanim`), so the file stays
   diffable and hand-editable — the timeline is a view over it,
   not a private binary format. Everything here is pure: the
   component renders `sampleLayer(layer, t)` and never mutates a
   scene in place.
   ============================================================ */

export type LayerKind = "rect" | "ellipse" | "text" | "image";

export type AnimProp =
  | "x" | "y" | "width" | "height"
  | "rotation" | "scale" | "opacity" | "fill";

export const ANIM_PROPS: Array<{ key: AnimProp; label: string; kind: "number" | "color"; min?: number; max?: number; step?: number }> = [
  { key: "x",        label: "X",        kind: "number", step: 1 },
  { key: "y",        label: "Y",        kind: "number", step: 1 },
  { key: "width",    label: "Width",    kind: "number", min: 1, step: 1 },
  { key: "height",   label: "Height",   kind: "number", min: 1, step: 1 },
  { key: "rotation", label: "Rotation", kind: "number", step: 1 },
  { key: "scale",    label: "Scale",    kind: "number", min: 0, step: 0.01 },
  { key: "opacity",  label: "Opacity",  kind: "number", min: 0, max: 1, step: 0.01 },
  { key: "fill",     label: "Fill",     kind: "color" },
];

export type Easing =
  | "linear" | "easeIn" | "easeOut" | "easeInOut"
  | "backOut" | "bounceOut" | "step";

export const EASINGS: Easing[] = [
  "linear", "easeIn", "easeOut", "easeInOut", "backOut", "bounceOut", "step",
];

export interface Keyframe {
  /** Milliseconds from the start of the scene. */
  t: number;
  value: number | string;
  /** Easing applied on the segment that *starts* at this keyframe. */
  easing: Easing;
}

export interface AnimLayer {
  id: string;
  name: string;
  kind: LayerKind;
  visible: boolean;
  locked: boolean;
  /** Values used wherever a property has no keyframes. */
  base: Record<AnimProp, number | string>;
  /** Non-animated appearance. */
  style: {
    stroke: string;
    strokeWidth: number;
    radius: number;
    text: string;
    fontSize: number;
    fontFamily: string;
    fontWeight: number;
    /** Data URI for image layers. */
    src: string;
  };
  tracks: Partial<Record<AnimProp, Keyframe[]>>;
}

export interface AnimScene {
  version: 1;
  width: number;
  height: number;
  /** Total scene length in milliseconds. */
  duration: number;
  fps: number;
  background: string;
  layers: AnimLayer[];
}

export const DEFAULT_STYLE: AnimLayer["style"] = {
  stroke: "#00000000",
  strokeWidth: 0,
  radius: 8,
  text: "Hello",
  fontSize: 48,
  fontFamily: "Inter, system-ui, sans-serif",
  fontWeight: 600,
  src: "",
};

let seq = 0;
function nextId(): string {
  seq += 1;
  return `l${Date.now().toString(36)}${seq.toString(36)}`;
}

export function createLayer(kind: LayerKind, scene: AnimScene): AnimLayer {
  const w = kind === "text" ? 320 : 220;
  const h = kind === "text" ? 64 : 140;
  return {
    id: nextId(),
    name: `${kind[0].toUpperCase()}${kind.slice(1)} ${scene.layers.length + 1}`,
    kind,
    visible: true,
    locked: false,
    base: {
      x: Math.round(scene.width / 2 - w / 2),
      y: Math.round(scene.height / 2 - h / 2),
      width: w,
      height: h,
      rotation: 0,
      scale: 1,
      opacity: 1,
      fill: kind === "text" ? "#171b21" : "#1f5ed0",
    },
    style: { ...DEFAULT_STYLE },
    tracks: {},
  };
}

export function emptyScene(): AnimScene {
  const scene: AnimScene = {
    version: 1,
    width: 960,
    height: 540,
    duration: 3000,
    fps: 60,
    background: "#ffffff",
    layers: [],
  };
  const box = createLayer("rect", scene);
  box.name = "Box";
  box.tracks = {
    x: [
      { t: 0, value: 80, easing: "easeInOut" },
      { t: 3000, value: scene.width - 300, easing: "linear" },
    ],
    opacity: [
      { t: 0, value: 0, easing: "easeOut" },
      { t: 600, value: 1, easing: "linear" },
    ],
    rotation: [
      { t: 0, value: 0, easing: "easeInOut" },
      { t: 3000, value: 360, easing: "linear" },
    ],
  };
  scene.layers.push(box);
  return scene;
}

/* ------------------------------------------------------------------
   Easing
   ------------------------------------------------------------------ */

export function ease(kind: Easing, t: number): number {
  const x = Math.min(1, Math.max(0, t));
  switch (kind) {
    case "linear":    return x;
    case "easeIn":    return x * x;
    case "easeOut":   return 1 - (1 - x) * (1 - x);
    case "easeInOut": return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    case "backOut": {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
    }
    case "bounceOut": {
      const n1 = 7.5625;
      const d1 = 2.75;
      if (x < 1 / d1) return n1 * x * x;
      if (x < 2 / d1) { const v = x - 1.5 / d1; return n1 * v * v + 0.75; }
      if (x < 2.5 / d1) { const v = x - 2.25 / d1; return n1 * v * v + 0.9375; }
      const v = x - 2.625 / d1;
      return n1 * v * v + 0.984375;
    }
    // A stepped segment holds its start value until the next keyframe.
    case "step":      return 0;
    default:          return x;
  }
}

/* ------------------------------------------------------------------
   Colour interpolation
   ------------------------------------------------------------------ */

function hexToRgba(hex: string): [number, number, number, number] {
  const s = hex.trim().replace("#", "");
  const grab = (i: number, len: number) =>
    parseInt(len === 1 ? s[i] + s[i] : s.slice(i, i + 2), 16);
  if (s.length === 3 || s.length === 4) {
    return [grab(0, 1), grab(1, 1), grab(2, 1), s.length === 4 ? grab(3, 1) : 255];
  }
  if (s.length === 6 || s.length === 8) {
    return [grab(0, 2), grab(2, 2), grab(4, 2), s.length === 8 ? grab(6, 2) : 255];
  }
  return [0, 0, 0, 255];
}

function rgbaToHex(c: [number, number, number, number]): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return c[3] >= 255 ? `#${h(c[0])}${h(c[1])}${h(c[2])}` : `#${h(c[0])}${h(c[1])}${h(c[2])}${h(c[3])}`;
}

export function mixColor(a: string, b: string, k: number): string {
  const ca = hexToRgba(a);
  const cb = hexToRgba(b);
  return rgbaToHex([
    ca[0] + (cb[0] - ca[0]) * k,
    ca[1] + (cb[1] - ca[1]) * k,
    ca[2] + (cb[2] - ca[2]) * k,
    ca[3] + (cb[3] - ca[3]) * k,
  ]);
}

/* ------------------------------------------------------------------
   Sampling
   ------------------------------------------------------------------ */

/** Keyframes sorted by time. Callers never rely on insertion order. */
export function sortedTrack(track: Keyframe[]): Keyframe[] {
  return [...track].sort((a, b) => a.t - b.t);
}

/**
 * Value of one property at time `t`. Before the first keyframe the first
 * value holds; after the last, the last value holds — the same clamping
 * every timeline tool uses, so scrubbing past the end never blanks a layer.
 */
export function sampleProp(
  layer: AnimLayer, prop: AnimProp, t: number,
): number | string {
  const track = layer.tracks[prop];
  if (!track || track.length === 0) return layer.base[prop];
  const kfs = sortedTrack(track);
  if (t <= kfs[0].t) return kfs[0].value;
  if (t >= kfs[kfs.length - 1].t) return kfs[kfs.length - 1].value;

  let i = 0;
  while (i < kfs.length - 1 && kfs[i + 1].t <= t) i++;
  const a = kfs[i];
  const b = kfs[i + 1];
  const span = b.t - a.t;
  const raw = span <= 0 ? 1 : (t - a.t) / span;
  const k = ease(a.easing, raw);

  if (typeof a.value === "string" || typeof b.value === "string") {
    return mixColor(String(a.value), String(b.value), k);
  }
  return a.value + (b.value - a.value) * k;
}

export interface SampledLayer {
  x: number; y: number; width: number; height: number;
  rotation: number; scale: number; opacity: number; fill: string;
}

export function sampleLayer(layer: AnimLayer, t: number): SampledLayer {
  const num = (p: AnimProp, fallback = 0) => {
    const v = Number(sampleProp(layer, p, t));
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    x: num("x"),
    y: num("y"),
    width: Math.max(0, num("width")),
    height: Math.max(0, num("height")),
    rotation: num("rotation"),
    scale: num("scale", 1),
    opacity: Math.max(0, Math.min(1, num("opacity", 1))),
    fill: String(sampleProp(layer, "fill", t)),
  };
}

/* ------------------------------------------------------------------
   Keyframe editing (pure — each returns a new layer)
   ------------------------------------------------------------------ */

/** Snap a time to the nearest frame boundary for the scene's fps. */
export function snapToFrame(t: number, fps: number): number {
  const frame = 1000 / Math.max(1, fps);
  return Math.round(t / frame) * frame;
}

export function setKeyframe(
  layer: AnimLayer, prop: AnimProp, t: number, value: number | string, easing: Easing = "easeInOut",
): AnimLayer {
  const track = sortedTrack(layer.tracks[prop] ?? []);
  const at = track.findIndex((k) => Math.abs(k.t - t) < 1);
  const next = at >= 0
    ? track.map((k, i) => (i === at ? { ...k, value } : k))
    : sortedTrack([...track, { t, value, easing }]);
  return { ...layer, tracks: { ...layer.tracks, [prop]: next } };
}

export function removeKeyframe(layer: AnimLayer, prop: AnimProp, t: number): AnimLayer {
  const track = layer.tracks[prop];
  if (!track) return layer;
  const next = track.filter((k) => Math.abs(k.t - t) >= 1);
  const tracks = { ...layer.tracks };
  if (next.length === 0) delete tracks[prop];
  else tracks[prop] = next;
  return { ...layer, tracks };
}

export function moveKeyframe(
  layer: AnimLayer, prop: AnimProp, from: number, to: number,
): AnimLayer {
  const track = layer.tracks[prop];
  if (!track) return layer;
  const next = sortedTrack(
    track.map((k) => (Math.abs(k.t - from) < 1 ? { ...k, t: Math.max(0, to) } : k)),
  );
  return { ...layer, tracks: { ...layer.tracks, [prop]: next } };
}

export function setEasing(
  layer: AnimLayer, prop: AnimProp, t: number, easing: Easing,
): AnimLayer {
  const track = layer.tracks[prop];
  if (!track) return layer;
  return {
    ...layer,
    tracks: {
      ...layer.tracks,
      [prop]: track.map((k) => (Math.abs(k.t - t) < 1 ? { ...k, easing } : k)),
    },
  };
}

/** Every distinct keyframe time on a layer, across all its tracks. */
export function layerKeyTimes(layer: AnimLayer): number[] {
  const times = new Set<number>();
  for (const track of Object.values(layer.tracks)) {
    for (const k of track ?? []) times.add(Math.round(k.t));
  }
  return [...times].sort((a, b) => a - b);
}

/* ------------------------------------------------------------------
   Serialization
   ------------------------------------------------------------------ */

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);

/** Parse a `.sparkanim` document, repairing anything malformed rather
    than throwing — a half-edited file should still open. */
export function parseScene(raw: string): AnimScene {
  if (!raw.trim()) return emptyScene();
  let data: any;
  try { data = JSON.parse(raw); } catch { return emptyScene(); }
  if (!data || typeof data !== "object") return emptyScene();

  const scene: AnimScene = {
    version: 1,
    width: Math.max(1, num(data.width, 960)),
    height: Math.max(1, num(data.height, 540)),
    duration: Math.max(100, num(data.duration, 3000)),
    fps: Math.max(1, Math.min(120, num(data.fps, 60))),
    background: str(data.background, "#ffffff"),
    layers: [],
  };

  const rawLayers = Array.isArray(data.layers) ? data.layers : [];
  scene.layers = rawLayers.map((l: any, i: number): AnimLayer => {
    const kind: LayerKind = ["rect", "ellipse", "text", "image"].includes(l?.kind) ? l.kind : "rect";
    const base = l?.base ?? {};
    const style = l?.style ?? {};
    const tracks: AnimLayer["tracks"] = {};
    for (const { key } of ANIM_PROPS) {
      const t = l?.tracks?.[key];
      if (!Array.isArray(t) || t.length === 0) continue;
      tracks[key] = sortedTrack(
        t
          .filter((k: any) => k && typeof k === "object" && Number.isFinite(k.t))
          .map((k: any) => ({
            t: Math.max(0, k.t),
            value: typeof k.value === "string" ? k.value : num(k.value, 0),
            easing: (EASINGS.includes(k.easing) ? k.easing : "easeInOut") as Easing,
          })),
      );
      if (tracks[key]!.length === 0) delete tracks[key];
    }
    return {
      id: str(l?.id, `l${i}`),
      name: str(l?.name, `Layer ${i + 1}`),
      kind,
      visible: l?.visible !== false,
      locked: l?.locked === true,
      base: {
        x: num(base.x, 0),
        y: num(base.y, 0),
        width: Math.max(0, num(base.width, 200)),
        height: Math.max(0, num(base.height, 120)),
        rotation: num(base.rotation, 0),
        scale: num(base.scale, 1),
        opacity: Math.max(0, Math.min(1, num(base.opacity, 1))),
        fill: str(base.fill, "#1f5ed0"),
      },
      style: {
        stroke: str(style.stroke, DEFAULT_STYLE.stroke),
        strokeWidth: Math.max(0, num(style.strokeWidth, 0)),
        radius: Math.max(0, num(style.radius, 8)),
        text: str(style.text, DEFAULT_STYLE.text),
        fontSize: Math.max(1, num(style.fontSize, 48)),
        fontFamily: str(style.fontFamily, DEFAULT_STYLE.fontFamily),
        fontWeight: num(style.fontWeight, 600),
        src: str(style.src, ""),
      },
      tracks,
    };
  });

  return scene;
}

export function serializeScene(scene: AnimScene): string {
  return `${JSON.stringify(scene, null, 2)}\n`;
}

/* ------------------------------------------------------------------
   Standalone HTML export
   ------------------------------------------------------------------ */

/**
 * A single self-contained HTML file that replays the scene with the same
 * sampling code used here. Nothing is fetched at runtime, so the export
 * works from a file:// path or inside an email attachment.
 */
export function exportHtml(scene: AnimScene, title: string): string {
  const json = JSON.stringify(scene);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#101215; font:13px/1.5 Inter, system-ui, sans-serif; color:#e7eaf0; }
  .wrap { display:grid; gap:12px; justify-items:center; padding:24px; }
  svg { background:${escapeHtml(scene.background)}; border-radius:8px;
        box-shadow:0 8px 40px rgba(0,0,0,.45); max-width:100%; height:auto; }
  .bar { display:flex; gap:8px; align-items:center; }
  button { font:inherit; padding:5px 12px; border-radius:6px; border:1px solid #3a4150;
           background:#1b1f26; color:inherit; cursor:pointer; }
  button:hover { background:#242a33; }
  input[type=range] { width:260px; accent-color:#6aa2ff; }
  code { font-family:ui-monospace, monospace; color:#9aa4b4; min-width:76px; }
</style>
</head>
<body>
<div class="wrap">
  <svg id="stage" viewBox="0 0 ${scene.width} ${scene.height}" width="${scene.width}" height="${scene.height}"></svg>
  <div class="bar">
    <button id="play">Pause</button>
    <input id="scrub" type="range" min="0" max="${scene.duration}" value="0" step="1">
    <code id="time">0.00s</code>
    <label><input id="loop" type="checkbox" checked> loop</label>
  </div>
</div>
<script>
const SCENE = ${json};
${SAMPLER_SOURCE}
const stage = document.getElementById("stage");
const SVGNS = "http://www.w3.org/2000/svg";
const nodes = SCENE.layers.map(function (layer) {
  var g = document.createElementNS(SVGNS, "g");
  var el;
  if (layer.kind === "ellipse") el = document.createElementNS(SVGNS, "ellipse");
  else if (layer.kind === "text") el = document.createElementNS(SVGNS, "text");
  else if (layer.kind === "image") el = document.createElementNS(SVGNS, "image");
  else el = document.createElementNS(SVGNS, "rect");
  g.appendChild(el);
  stage.appendChild(g);
  return { layer: layer, g: g, el: el };
});

function render(t) {
  nodes.forEach(function (n) {
    var s = sampleLayer(n.layer, t);
    var st = n.layer.style;
    n.g.setAttribute("opacity", n.layer.visible ? String(s.opacity) : "0");
    var cx = s.x + s.width / 2, cy = s.y + s.height / 2;
    n.g.setAttribute("transform",
      "rotate(" + s.rotation + " " + cx + " " + cy + ") " +
      "translate(" + cx + " " + cy + ") scale(" + s.scale + ") translate(" + (-cx) + " " + (-cy) + ")");
    if (n.layer.kind === "ellipse") {
      n.el.setAttribute("cx", cx); n.el.setAttribute("cy", cy);
      n.el.setAttribute("rx", s.width / 2); n.el.setAttribute("ry", s.height / 2);
      n.el.setAttribute("fill", s.fill);
    } else if (n.layer.kind === "text") {
      n.el.setAttribute("x", s.x); n.el.setAttribute("y", s.y + st.fontSize);
      n.el.setAttribute("fill", s.fill);
      n.el.setAttribute("font-size", st.fontSize);
      n.el.setAttribute("font-family", st.fontFamily);
      n.el.setAttribute("font-weight", st.fontWeight);
      n.el.textContent = st.text;
    } else if (n.layer.kind === "image") {
      n.el.setAttribute("x", s.x); n.el.setAttribute("y", s.y);
      n.el.setAttribute("width", s.width); n.el.setAttribute("height", s.height);
      n.el.setAttribute("preserveAspectRatio", "xMidYMid slice");
      if (st.src) n.el.setAttribute("href", st.src);
    } else {
      n.el.setAttribute("x", s.x); n.el.setAttribute("y", s.y);
      n.el.setAttribute("width", s.width); n.el.setAttribute("height", s.height);
      n.el.setAttribute("rx", st.radius); n.el.setAttribute("fill", s.fill);
    }
    if (st.strokeWidth > 0) {
      n.el.setAttribute("stroke", st.stroke);
      n.el.setAttribute("stroke-width", st.strokeWidth);
    }
  });
}

var t = 0, playing = true, last = performance.now();
var playBtn = document.getElementById("play");
var scrub = document.getElementById("scrub");
var timeEl = document.getElementById("time");
var loopEl = document.getElementById("loop");
playBtn.onclick = function () { playing = !playing; playBtn.textContent = playing ? "Pause" : "Play"; last = performance.now(); };
scrub.oninput = function () { t = +scrub.value; playing = false; playBtn.textContent = "Play"; render(t); timeEl.textContent = (t/1000).toFixed(2) + "s"; };
function frame(now) {
  var dt = now - last; last = now;
  if (playing) {
    t += dt;
    if (t > SCENE.duration) { t = loopEl.checked ? 0 : SCENE.duration; if (!loopEl.checked) { playing = false; playBtn.textContent = "Play"; } }
    scrub.value = t;
    timeEl.textContent = (t/1000).toFixed(2) + "s";
  }
  render(t);
  requestAnimationFrame(frame);
}
render(0);
requestAnimationFrame(frame);
</script>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

/* The exported player needs the same easing + sampling maths as the editor.
   It is inlined as source rather than imported so the export stays a
   single file with no build step. Keep in sync with `ease` / `sampleProp`. */
const SAMPLER_SOURCE = `
function ease(kind, t) {
  var x = Math.min(1, Math.max(0, t));
  switch (kind) {
    case "linear": return x;
    case "easeIn": return x * x;
    case "easeOut": return 1 - (1 - x) * (1 - x);
    case "easeInOut": return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    case "backOut": { var c1 = 1.70158, c3 = c1 + 1;
      return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); }
    case "bounceOut": { var n1 = 7.5625, d1 = 2.75, v;
      if (x < 1 / d1) return n1 * x * x;
      if (x < 2 / d1) { v = x - 1.5 / d1; return n1 * v * v + 0.75; }
      if (x < 2.5 / d1) { v = x - 2.25 / d1; return n1 * v * v + 0.9375; }
      v = x - 2.625 / d1; return n1 * v * v + 0.984375; }
    case "step": return 0;
    default: return x;
  }
}
function hexToRgba(hex) {
  var s = String(hex).trim().replace("#", "");
  function grab(i, len) { return parseInt(len === 1 ? s[i] + s[i] : s.slice(i, i + 2), 16); }
  if (s.length === 3 || s.length === 4) return [grab(0,1), grab(1,1), grab(2,1), s.length === 4 ? grab(3,1) : 255];
  if (s.length === 6 || s.length === 8) return [grab(0,2), grab(2,2), grab(4,2), s.length === 8 ? grab(6,2) : 255];
  return [0, 0, 0, 255];
}
function mixColor(a, b, k) {
  var ca = hexToRgba(a), cb = hexToRgba(b);
  function h(n) { return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0"); }
  var out = [0,1,2,3].map(function (i) { return ca[i] + (cb[i] - ca[i]) * k; });
  return out[3] >= 255 ? "#" + h(out[0]) + h(out[1]) + h(out[2]) : "#" + h(out[0]) + h(out[1]) + h(out[2]) + h(out[3]);
}
function sampleProp(layer, prop, t) {
  var track = layer.tracks[prop];
  if (!track || !track.length) return layer.base[prop];
  var kfs = track.slice().sort(function (a, b) { return a.t - b.t; });
  if (t <= kfs[0].t) return kfs[0].value;
  if (t >= kfs[kfs.length - 1].t) return kfs[kfs.length - 1].value;
  var i = 0;
  while (i < kfs.length - 1 && kfs[i + 1].t <= t) i++;
  var a = kfs[i], b = kfs[i + 1];
  var span = b.t - a.t;
  var k = ease(a.easing, span <= 0 ? 1 : (t - a.t) / span);
  if (typeof a.value === "string" || typeof b.value === "string") return mixColor(a.value, b.value, k);
  return a.value + (b.value - a.value) * k;
}
function sampleLayer(layer, t) {
  return {
    x: +sampleProp(layer, "x", t) || 0,
    y: +sampleProp(layer, "y", t) || 0,
    width: Math.max(0, +sampleProp(layer, "width", t) || 0),
    height: Math.max(0, +sampleProp(layer, "height", t) || 0),
    rotation: +sampleProp(layer, "rotation", t) || 0,
    scale: +sampleProp(layer, "scale", t),
    opacity: Math.max(0, Math.min(1, +sampleProp(layer, "opacity", t))),
    fill: String(sampleProp(layer, "fill", t))
  };
}
`;
