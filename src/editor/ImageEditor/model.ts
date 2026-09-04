/* ============================================================
   sparkBook · src/editor/ImageEditor/model.ts
   Layer model, compositing, pixel operations and history for the
   raster editor.

   The document is a stack of same-size offscreen canvases. Every
   tool writes into exactly one layer's 2D context; compositing is
   a separate pass, so a mistake in a tool can never corrupt a
   layer the user was not painting on.

   History snapshots the whole document as PNG data URLs. That is
   heavier per step than a per-layer diff, but it survives layer
   add/remove/reorder without a second code path — which is where
   hand-rolled undo stacks usually break.
   ============================================================ */

export type BlendMode =
  | "normal" | "multiply" | "screen" | "overlay"
  | "darken" | "lighten" | "color-dodge" | "color-burn"
  | "hard-light" | "soft-light" | "difference" | "exclusion"
  | "hue" | "saturation" | "color" | "luminosity";

export const BLEND_MODES: BlendMode[] = [
  "normal", "multiply", "screen", "overlay",
  "darken", "lighten", "color-dodge", "color-burn",
  "hard-light", "soft-light", "difference", "exclusion",
  "hue", "saturation", "color", "luminosity",
];

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  /** 0..1 */
  opacity: number;
  blend: BlendMode;
  canvas: HTMLCanvasElement;
}

export interface ImageDoc {
  width: number;
  height: number;
  /** Bottom-most first, matching canvas paint order. */
  layers: Layer[];
}

export interface Rect { x: number; y: number; w: number; h: number }

/** Adjustment values in the units the CSS `filter` property expects. */
export interface Adjustments {
  brightness: number;   // % — 100 is neutral
  contrast: number;     // %
  saturate: number;     // %
  hueRotate: number;    // deg
  blur: number;         // px
  grayscale: number;    // %
  sepia: number;        // %
  invert: number;       // %
}

export const NEUTRAL_ADJUSTMENTS: Adjustments = {
  brightness: 100, contrast: 100, saturate: 100, hueRotate: 0,
  blur: 0, grayscale: 0, sepia: 0, invert: 0,
};

export function isNeutral(a: Adjustments): boolean {
  return (
    a.brightness === 100 && a.contrast === 100 && a.saturate === 100 &&
    a.hueRotate === 0 && a.blur === 0 && a.grayscale === 0 &&
    a.sepia === 0 && a.invert === 0
  );
}

/** Serialize adjustments into a canvas/CSS `filter` string. */
export function filterString(a: Adjustments): string {
  if (isNeutral(a)) return "none";
  return [
    `brightness(${a.brightness}%)`,
    `contrast(${a.contrast}%)`,
    `saturate(${a.saturate}%)`,
    `hue-rotate(${a.hueRotate}deg)`,
    a.blur > 0 ? `blur(${a.blur}px)` : "",
    a.grayscale > 0 ? `grayscale(${a.grayscale}%)` : "",
    a.sepia > 0 ? `sepia(${a.sepia}%)` : "",
    a.invert > 0 ? `invert(${a.invert}%)` : "",
  ].filter(Boolean).join(" ");
}

/* ------------------------------------------------------------------
   Layer construction
   ------------------------------------------------------------------ */

let layerSeq = 0;
function nextLayerId(): string {
  layerSeq += 1;
  return `layer-${Date.now().toString(36)}-${layerSeq}`;
}

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** 2D context with alpha, throwing rather than returning null — every
    call site would otherwise need the same unreachable guard. */
export function ctx2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const c = canvas.getContext("2d", { willReadFrequently: true });
  if (!c) throw new Error("2D canvas context unavailable");
  return c;
}

export function createLayer(w: number, h: number, name: string): Layer {
  return {
    id: nextLayerId(),
    name,
    visible: true,
    locked: false,
    opacity: 1,
    blend: "normal",
    canvas: makeCanvas(w, h),
  };
}

/** A layer holding a copy of `source`, sized to the document. */
export function layerFromImage(
  img: CanvasImageSource, w: number, h: number, name: string,
): Layer {
  const layer = createLayer(w, h, name);
  ctx2d(layer.canvas).drawImage(img, 0, 0, w, h);
  return layer;
}

export function cloneLayer(layer: Layer, name?: string): Layer {
  const copy = createLayer(layer.canvas.width, layer.canvas.height, name ?? `${layer.name} copy`);
  copy.opacity = layer.opacity;
  copy.blend = layer.blend;
  copy.visible = layer.visible;
  ctx2d(copy.canvas).drawImage(layer.canvas, 0, 0);
  return copy;
}

/* ------------------------------------------------------------------
   Compositing
   ------------------------------------------------------------------ */

/**
 * Paint every visible layer of `doc` onto `target`.
 * `previewLayerId` + `previewFilter` render one layer through a filter
 * without baking it, which is how the adjustments panel previews live.
 */
export function compose(
  doc: ImageDoc,
  target: HTMLCanvasElement,
  opts: { previewLayerId?: string | null; previewFilter?: string } = {},
): void {
  if (target.width !== doc.width) target.width = doc.width;
  if (target.height !== doc.height) target.height = doc.height;
  const c = ctx2d(target);
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, doc.width, doc.height);
  for (const layer of doc.layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    c.globalAlpha = layer.opacity;
    c.globalCompositeOperation = layer.blend === "normal" ? "source-over" : layer.blend;
    c.filter =
      opts.previewLayerId && layer.id === opts.previewLayerId && opts.previewFilter
        ? opts.previewFilter
        : "none";
    c.drawImage(layer.canvas, 0, 0);
  }
  c.restore();
}

/** A single canvas holding the flattened document. */
export function flatten(doc: ImageDoc): HTMLCanvasElement {
  const out = makeCanvas(doc.width, doc.height);
  compose(doc, out);
  return out;
}

/** Bake a filter into a layer's own pixels. */
export function bakeFilter(layer: Layer, filter: string): void {
  if (filter === "none") return;
  const tmp = makeCanvas(layer.canvas.width, layer.canvas.height);
  const t = ctx2d(tmp);
  t.filter = filter;
  t.drawImage(layer.canvas, 0, 0);
  const c = ctx2d(layer.canvas);
  c.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
  c.drawImage(tmp, 0, 0);
}

/* ------------------------------------------------------------------
   Document-level transforms
   ------------------------------------------------------------------ */

/** Resize the document and every layer, scaling their contents. */
export function resizeDoc(doc: ImageDoc, w: number, h: number, smooth = true): ImageDoc {
  const width = Math.max(1, Math.round(w));
  const height = Math.max(1, Math.round(h));
  const layers = doc.layers.map((layer) => {
    const next = makeCanvas(width, height);
    const c = ctx2d(next);
    c.imageSmoothingEnabled = smooth;
    c.imageSmoothingQuality = "high";
    c.drawImage(layer.canvas, 0, 0, width, height);
    return { ...layer, canvas: next };
  });
  return { width, height, layers };
}

/** Rotate the document by ±90°, swapping its axes. */
export function rotateDoc(doc: ImageDoc, dir: 1 | -1): ImageDoc {
  const width = doc.height;
  const height = doc.width;
  const layers = doc.layers.map((layer) => {
    const next = makeCanvas(width, height);
    const c = ctx2d(next);
    c.translate(width / 2, height / 2);
    c.rotate((dir * Math.PI) / 2);
    c.drawImage(layer.canvas, -doc.width / 2, -doc.height / 2);
    return { ...layer, canvas: next };
  });
  return { width, height, layers };
}

/** Mirror every layer across the given axis. */
export function flipDoc(doc: ImageDoc, axis: "x" | "y"): ImageDoc {
  const layers = doc.layers.map((layer) => {
    const next = makeCanvas(doc.width, doc.height);
    const c = ctx2d(next);
    if (axis === "x") { c.translate(doc.width, 0); c.scale(-1, 1); }
    else { c.translate(0, doc.height); c.scale(1, -1); }
    c.drawImage(layer.canvas, 0, 0);
    return { ...layer, canvas: next };
  });
  return { ...doc, layers };
}

/** Crop every layer to `rect`, clamped to the current bounds. */
export function cropDoc(doc: ImageDoc, rect: Rect): ImageDoc {
  const x = Math.max(0, Math.round(Math.min(rect.x, rect.x + rect.w)));
  const y = Math.max(0, Math.round(Math.min(rect.y, rect.y + rect.h)));
  const w = Math.max(1, Math.min(doc.width - x, Math.round(Math.abs(rect.w))));
  const h = Math.max(1, Math.min(doc.height - y, Math.round(Math.abs(rect.h))));
  const layers = doc.layers.map((layer) => {
    const next = makeCanvas(w, h);
    ctx2d(next).drawImage(layer.canvas, x, y, w, h, 0, 0, w, h);
    return { ...layer, canvas: next };
  });
  return { width: w, height: h, layers };
}

/** Merge `layer` down into the layer beneath it. Returns a new stack. */
export function mergeDown(doc: ImageDoc, layerId: string): ImageDoc | null {
  const idx = doc.layers.findIndex((l) => l.id === layerId);
  if (idx <= 0) return null;                 // nothing beneath the bottom layer
  const upper = doc.layers[idx];
  const lower = doc.layers[idx - 1];
  const merged = cloneLayer(lower, lower.name);
  merged.id = lower.id;
  const c = ctx2d(merged.canvas);
  c.globalAlpha = upper.opacity;
  c.globalCompositeOperation = upper.blend === "normal" ? "source-over" : upper.blend;
  if (upper.visible) c.drawImage(upper.canvas, 0, 0);
  c.globalAlpha = 1;
  c.globalCompositeOperation = "source-over";
  const layers = doc.layers.slice();
  layers.splice(idx - 1, 2, merged);
  return { ...doc, layers };
}

/* ------------------------------------------------------------------
   Pixel operations
   ------------------------------------------------------------------ */

export interface RGBA { r: number; g: number; b: number; a: number }

/** Parse `#rgb`, `#rrggbb`, `#rrggbbaa` or `rgb()/rgba()` into channels. */
export function parseColor(css: string): RGBA {
  const s = css.trim();
  if (s.startsWith("#")) {
    const hex = s.slice(1);
    const expand = (h: string) => parseInt(h.length === 1 ? h + h : h, 16);
    if (hex.length === 3 || hex.length === 4) {
      return {
        r: expand(hex[0]), g: expand(hex[1]), b: expand(hex[2]),
        a: hex.length === 4 ? expand(hex[3]) : 255,
      };
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255,
      };
    }
  }
  const m = s.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const parts = m[1].split(",").map((p) => parseFloat(p));
    return {
      r: parts[0] | 0, g: parts[1] | 0, b: parts[2] | 0,
      a: parts.length > 3 ? Math.round(parts[3] * 255) : 255,
    };
  }
  return { r: 0, g: 0, b: 0, a: 255 };
}

export function toHex({ r, g, b }: RGBA): string {
  const h = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * Scanline flood fill starting at (sx, sy).
 * `tolerance` is 0–255 per-channel distance; 0 fills only exact matches.
 * Mutates `data` in place and reports whether anything changed.
 */
export function floodFill(
  data: ImageData, sx: number, sy: number, fill: RGBA, tolerance: number,
): boolean {
  const { width: w, height: h } = data;
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return false;

  const px = new Uint32Array(data.data.buffer);
  const startIdx = y0 * w + x0;
  const start = px[startIdx];

  // Little-endian packing: 0xAABBGGRR. `>>> 0` keeps it unsigned — the
  // shift alone yields a negative number, which would never compare equal
  // to the unsigned value read out of the Uint32Array view.
  const target = (((fill.a << 24) | (fill.b << 16) | (fill.g << 8) | fill.r) >>> 0);
  if (start === target && tolerance === 0) return false;

  const sr = start & 0xff;
  const sg = (start >> 8) & 0xff;
  const sb = (start >> 16) & 0xff;
  const sa = (start >>> 24) & 0xff;

  const matches = (v: number): boolean => {
    if (v === start) return true;
    if (tolerance === 0) return false;
    return (
      Math.abs((v & 0xff) - sr) <= tolerance &&
      Math.abs(((v >> 8) & 0xff) - sg) <= tolerance &&
      Math.abs(((v >> 16) & 0xff) - sb) <= tolerance &&
      Math.abs(((v >>> 24) & 0xff) - sa) <= tolerance
    );
  };

  const seen = new Uint8Array(w * h);
  const stack: number[] = [startIdx];
  let changed = false;

  while (stack.length) {
    const idx = stack.pop() as number;
    if (seen[idx]) continue;
    const y = (idx / w) | 0;
    const rowStart = y * w;
    const rowEnd = rowStart + w - 1;

    // Walk left, then right, filling the whole run before queueing neighbours.
    let left = idx;
    while (left > rowStart && !seen[left - 1] && matches(px[left - 1])) left--;
    let right = idx;
    while (right < rowEnd && !seen[right + 1] && matches(px[right + 1])) right++;

    for (let i = left; i <= right; i++) {
      if (seen[i] || !matches(px[i])) continue;
      px[i] = target;
      seen[i] = 1;
      changed = true;
      if (y > 0) {
        const up = i - w;
        if (!seen[up] && matches(px[up])) stack.push(up);
      }
      if (y < h - 1) {
        const down = i + w;
        if (!seen[down] && matches(px[down])) stack.push(down);
      }
    }
  }
  return changed;
}

/** Read one pixel as CSS hex. Returns null outside the canvas. */
export function pickColor(canvas: HTMLCanvasElement, x: number, y: number): string | null {
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return null;
  const d = ctx2d(canvas).getImageData(px, py, 1, 1).data;
  return toHex({ r: d[0], g: d[1], b: d[2], a: d[3] });
}

/* ------------------------------------------------------------------
   History
   ------------------------------------------------------------------ */

interface LayerSnapshot {
  id: string; name: string; visible: boolean; locked: boolean;
  opacity: number; blend: BlendMode; data: string;
}
export interface DocSnapshot {
  width: number; height: number; layers: LayerSnapshot[]; activeId: string | null;
}

export function snapshot(doc: ImageDoc, activeId: string | null): DocSnapshot {
  return {
    width: doc.width,
    height: doc.height,
    activeId,
    layers: doc.layers.map((l) => ({
      id: l.id, name: l.name, visible: l.visible, locked: l.locked,
      opacity: l.opacity, blend: l.blend,
      data: l.canvas.toDataURL("image/png"),
    })),
  };
}

/**
 * Rebuild a document from a snapshot. Layer bitmaps decode asynchronously,
 * so this resolves only once every layer has painted — restoring into a
 * half-decoded stack is how undo appears to "lose" a layer.
 */
export async function restoreSnapshot(snap: DocSnapshot): Promise<ImageDoc> {
  const layers = await Promise.all(
    snap.layers.map(
      (l) =>
        new Promise<Layer>((resolve) => {
          const canvas = makeCanvas(snap.width, snap.height);
          const img = new Image();
          img.onload = () => {
            ctx2d(canvas).drawImage(img, 0, 0);
            resolve({ ...l, canvas });
          };
          img.onerror = () => resolve({ ...l, canvas });
          img.src = l.data;
        }),
    ),
  );
  return { width: snap.width, height: snap.height, layers };
}

export const HISTORY_LIMIT = 24;
