/* ============================================================
   sparkBook · src/editor/ImageEditor/index.tsx
   Layered raster editor — the small set of Photoshop that people
   actually reach for.

   Shape of the thing:
   • The document (src/editor/ImageEditor/model.ts) is a stack of
     offscreen canvases. Tools write to exactly one of them.
   • Strokes land on a scratch canvas first and are composited on
     pointer-up. That is what makes brush opacity behave — a single
     stroke crossing itself must not darken.
   • Undo is a document-level snapshot stack owned here, not the
     text store's raw-string history: layers cannot be expressed
     as a string diff.
   • The file only changes when the flattened result is written
     back into `doc.raw` (debounced) and the user saves.
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDocs } from "@store/documents";
import { Button } from "@ui/Button";
import { Icon } from "@ui/Icon";
import { imageMime, extname } from "@bridge/commands";
import { base64ToObjectUrl, canvasToBase64, loadImage, formatBytes, base64ByteLength } from "@lib/binary";
import {
  BLEND_MODES, NEUTRAL_ADJUSTMENTS, HISTORY_LIMIT,
  compose, cloneLayer, createLayer, cropDoc, ctx2d, filterString, flipDoc,
  floodFill, isNeutral, layerFromImage, makeCanvas, mergeDown, parseColor,
  pickColor, resizeDoc, restoreSnapshot, rotateDoc, snapshot, bakeFilter,
  type Adjustments, type BlendMode, type DocSnapshot, type ImageDoc, type Layer, type Rect,
} from "./model";
import "./ImageEditor.css";
import "../editor.css";

type Tool =
  | "move" | "select" | "brush" | "eraser" | "bucket"
  | "rect" | "ellipse" | "line" | "text" | "eyedropper" | "crop";

const TOOLS: Array<{ id: Tool; label: string; icon: string; key: string }> = [
  { id: "move",       label: "Move layer",  icon: "tool-move",       key: "V" },
  { id: "select",     label: "Rectangular select", icon: "tool-select", key: "M" },
  { id: "brush",      label: "Brush",       icon: "tool-brush",      key: "B" },
  { id: "eraser",     label: "Eraser",      icon: "tool-eraser",     key: "E" },
  { id: "bucket",     label: "Paint bucket", icon: "tool-bucket",    key: "G" },
  { id: "rect",       label: "Rectangle",   icon: "tool-rect",       key: "U" },
  { id: "ellipse",    label: "Ellipse",     icon: "tool-ellipse",    key: "O" },
  { id: "line",       label: "Line",        icon: "tool-line",       key: "L" },
  { id: "text",       label: "Text",        icon: "tool-text",       key: "T" },
  { id: "eyedropper", label: "Eyedropper",  icon: "tool-eyedropper", key: "I" },
  { id: "crop",       label: "Crop",        icon: "tool-crop",       key: "C" },
];

const FORMATS = [
  { mime: "image/png",  label: "PNG",  lossy: false },
  { mime: "image/jpeg", label: "JPEG", lossy: true },
  { mime: "image/webp", label: "WebP", lossy: true },
];

const FONTS = [
  "Inter, system-ui, sans-serif",
  "Georgia, serif",
  "JetBrains Mono, ui-monospace, monospace",
  "Impact, Haettenschweiler, sans-serif",
  "Comic Sans MS, cursive",
];

const ZOOM_MIN = 0.05;
const ZOOM_MAX = 32;

/** Normalized rect with positive width/height. */
function normRect(r: Rect): Rect {
  return {
    x: Math.min(r.x, r.x + r.w),
    y: Math.min(r.y, r.y + r.h),
    w: Math.abs(r.w),
    h: Math.abs(r.h),
  };
}

interface Stroke {
  tool: Tool;
  start: { x: number; y: number };
  last: { x: number; y: number };
  /** Snapshot of the active layer, used by the move tool. */
  origin?: HTMLCanvasElement;
}

export function ImageEditor({ docId }: { docId: string }) {
  const doc = useDocs((s) => s.docs[docId]);
  const setRaw = useDocs((s) => s.setRaw);
  const setMode = useDocs((s) => s.setMode);

  /* ---------- Document ---------- */
  const [image, setImage] = useState<ImageDoc | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Bumped whenever a layer bitmap mutates: canvases live outside React. */
  const [rev, setRev] = useState(0);
  const bump = useCallback(() => setRev((r) => r + 1), []);

  /* ---------- View ---------- */
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(true);
  const [pointerPos, setPointerPos] = useState<{ x: number; y: number } | null>(null);

  /* ---------- Tools ---------- */
  const [tool, setTool] = useState<Tool>("brush");
  const [color, setColor] = useState("#1f5ed0");
  const [altColor, setAltColor] = useState("#ffffff");
  const [brushSize, setBrushSize] = useState(24);
  const [hardness, setHardness] = useState(80);      // %
  const [brushOpacity, setBrushOpacity] = useState(100); // %
  const [tolerance, setTolerance] = useState(24);
  const [shapeFilled, setShapeFilled] = useState(true);
  const [strokeWidth, setStrokeWidth] = useState(4);
  const [textValue, setTextValue] = useState("Double-click to edit");
  const [fontSize, setFontSize] = useState(48);
  const [fontFamily, setFontFamily] = useState(FONTS[0]);
  const [fontBold, setFontBold] = useState(false);
  const [fontItalic, setFontItalic] = useState(false);

  const [selection, setSelection] = useState<Rect | null>(null);
  const [cropRect, setCropRect] = useState<Rect | null>(null);

  /* ---------- Adjustments (live preview on the active layer) ---------- */
  const [adjust, setAdjust] = useState<Adjustments>(NEUTRAL_ADJUSTMENTS);

  /* ---------- Output ---------- */
  const sourceMime = useMemo(() => imageMime(doc?.path ?? doc?.name ?? ""), [doc?.path, doc?.name]);
  const [format, setFormat] = useState(sourceMime === "image/svg+xml" ? "image/png" : sourceMime);
  const [quality, setQuality] = useState(92);

  /* ---------- Resize dialog state ---------- */
  const [resizeW, setResizeW] = useState(0);
  const [resizeH, setResizeH] = useState(0);
  const [keepAspect, setKeepAspect] = useState(true);
  const [showResize, setShowResize] = useState(false);

  /* ---------- History ---------- */
  const pastRef = useRef<DocSnapshot[]>([]);
  const futureRef = useRef<DocSnapshot[]>([]);
  const [historyDepth, setHistoryDepth] = useState({ past: 0, future: 0 });

  /* ---------- Refs ---------- */
  const viewRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const scratchRef = useRef<HTMLCanvasElement | null>(null);
  const stageWrapRef = useRef<HTMLDivElement>(null);
  const strokeRef = useRef<Stroke | null>(null);
  const syncTimer = useRef<number | null>(null);
  const imageRef = useRef<ImageDoc | null>(null);
  imageRef.current = image;

  const activeLayer = useMemo(
    () => image?.layers.find((l) => l.id === activeId) ?? null,
    // `rev` is deliberate: layer bitmaps mutate in place, so the identity
    // of the layer object is not enough to re-derive panel state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [image, activeId, rev],
  );

  /* ==============================================================
     Load
     ============================================================== */
  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    setLoadError(null);
    const raw = useDocs.getState().docs[docId]?.raw ?? "";
    if (!raw) {
      // A brand-new image buffer: start on a blank 1280×800 canvas.
      const blank: ImageDoc = { width: 1280, height: 800, layers: [] };
      const bg = createLayer(blank.width, blank.height, "Background");
      const c = ctx2d(bg.canvas);
      c.fillStyle = "#ffffff";
      c.fillRect(0, 0, blank.width, blank.height);
      blank.layers.push(bg);
      setImage(blank);
      setActiveId(bg.id);
      imageRef.current = blank;
      // A blank buffer has no bytes yet. Encode it now, or an immediate
      // Ctrl+S before the first brush stroke would write a zero-byte file.
      syncNow();
      return;
    }
    (async () => {
      try {
        url = base64ToObjectUrl(raw, sourceMime);
        const img = await loadImage(url);
        if (cancelled) return;
        const w = img.naturalWidth || 1;
        const h = img.naturalHeight || 1;
        const bg = layerFromImage(img, w, h, "Background");
        setImage({ width: w, height: h, layers: [bg] });
        setActiveId(bg.id);
        setResizeW(w);
        setResizeH(h);
        pastRef.current = [];
        futureRef.current = [];
        setHistoryDepth({ past: 0, future: 0 });
      } catch {
        if (!cancelled) setLoadError("These bytes could not be decoded as an image.");
      } finally {
        if (url) URL.revokeObjectURL(url);
      }
    })();
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
    // Re-run only on document switch: this surface owns `raw` afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  /* Keep the resize fields in step with the canvas. Only the dimensions
     matter here; depending on `image` itself would re-run on every stroke. */
  useEffect(() => {
    const cur = imageRef.current;
    if (!cur) return;
    setResizeW(cur.width);
    setResizeH(cur.height);
  }, [image?.width, image?.height]);

  /* ==============================================================
     History
     ============================================================== */
  const pushHistory = useCallback(() => {
    const cur = imageRef.current;
    if (!cur) return;
    pastRef.current = [...pastRef.current, snapshot(cur, activeId)].slice(-HISTORY_LIMIT);
    futureRef.current = [];
    setHistoryDepth({ past: pastRef.current.length, future: 0 });
  }, [activeId]);

  const undo = useCallback(async () => {
    const cur = imageRef.current;
    const prev = pastRef.current.at(-1);
    if (!cur || !prev) return;
    futureRef.current = [...futureRef.current, snapshot(cur, activeId)].slice(-HISTORY_LIMIT);
    pastRef.current = pastRef.current.slice(0, -1);
    const restored = await restoreSnapshot(prev);
    setImage(restored);
    setActiveId(prev.activeId ?? restored.layers.at(-1)?.id ?? null);
    setHistoryDepth({ past: pastRef.current.length, future: futureRef.current.length });
    bump();
  }, [activeId, bump]);

  const redo = useCallback(async () => {
    const cur = imageRef.current;
    const next = futureRef.current.at(-1);
    if (!cur || !next) return;
    pastRef.current = [...pastRef.current, snapshot(cur, activeId)].slice(-HISTORY_LIMIT);
    futureRef.current = futureRef.current.slice(0, -1);
    const restored = await restoreSnapshot(next);
    setImage(restored);
    setActiveId(next.activeId ?? restored.layers.at(-1)?.id ?? null);
    setHistoryDepth({ past: pastRef.current.length, future: futureRef.current.length });
    bump();
  }, [activeId, bump]);

  /* The menu and palette route Undo/Redo here rather than to the text
     store, whose raw-string history cannot express a layer stack. */
  useEffect(() => {
    const onUndo = (e: Event) => {
      if ((e as CustomEvent<{ docId?: string }>).detail?.docId === docId) void undo();
    };
    const onRedo = (e: Event) => {
      if ((e as CustomEvent<{ docId?: string }>).detail?.docId === docId) void redo();
    };
    window.addEventListener("spark:surface:undo", onUndo);
    window.addEventListener("spark:surface:redo", onRedo);
    return () => {
      window.removeEventListener("spark:surface:undo", onUndo);
      window.removeEventListener("spark:surface:redo", onRedo);
    };
  }, [docId, undo, redo]);

  /* ==============================================================
     Write the flattened result back into the document
     ============================================================== */
  const flattenForExport = useCallback((src: ImageDoc): HTMLCanvasElement => {
    const out = makeCanvas(src.width, src.height);
    // JPEG has no alpha: without a matte, transparency renders black.
    if (format === "image/jpeg") {
      const c = ctx2d(out);
      c.fillStyle = "#ffffff";
      c.fillRect(0, 0, src.width, src.height);
    }
    compose(src, out);
    return out;
  }, [format]);

  const syncNow = useCallback(() => {
    const cur = imageRef.current;
    if (!cur) return;
    try {
      const flat = flattenForExport(cur);
      setRaw(docId, canvasToBase64(flat, format, quality / 100));
    } catch {
      /* Encoding can fail on a document larger than the canvas limit;
         the in-memory layers are still intact, so keep editing. */
    }
  }, [docId, format, quality, flattenForExport, setRaw]);

  const scheduleSync = useCallback(() => {
    if (syncTimer.current != null) window.clearTimeout(syncTimer.current);
    syncTimer.current = window.setTimeout(() => {
      syncTimer.current = null;
      syncNow();
    }, 450);
  }, [syncNow]);

  useEffect(() => () => { if (syncTimer.current != null) window.clearTimeout(syncTimer.current); }, []);

  /* Format or quality changed — re-encode so what is on disk matches
     what the export bar says. */
  useEffect(() => {
    if (!imageRef.current) return;
    scheduleSync();
  }, [format, quality, scheduleSync]);

  /* ==============================================================
     Rendering
     ============================================================== */
  const previewFilter = useMemo(() => filterString(adjust), [adjust]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !image) return;
    compose(image, view, {
      previewLayerId: isNeutral(adjust) ? null : activeId,
      previewFilter,
    });
    // The in-flight stroke lives on the scratch canvas, drawn on top with
    // the brush's opacity so the user sees the real result while dragging.
    const scratch = scratchRef.current;
    if (scratch && strokeRef.current) {
      const c = ctx2d(view);
      c.save();
      c.globalAlpha = brushOpacity / 100;
      if (strokeRef.current.tool === "eraser") c.globalCompositeOperation = "destination-out";
      c.filter = softFilter(hardness, brushSize, strokeRef.current.tool);
      c.drawImage(scratch, 0, 0);
      c.restore();
    }
  }, [image, rev, adjust, activeId, previewFilter, brushOpacity, hardness, brushSize]);

  /* Overlay: selection marquee, crop box, brush ring. Drawn in document
     coordinates with line widths divided by zoom so they stay 1px on
     screen at any magnification. */
  useEffect(() => {
    const ov = overlayRef.current;
    if (!ov || !image) return;
    if (ov.width !== image.width) ov.width = image.width;
    if (ov.height !== image.height) ov.height = image.height;
    const c = ctx2d(ov);
    c.clearRect(0, 0, ov.width, ov.height);
    const px = 1 / zoom;

    const marquee = (r: Rect, stroke: string) => {
      const n = normRect(r);
      c.save();
      c.lineWidth = px * 1.5;
      c.setLineDash([px * 5, px * 4]);
      c.strokeStyle = "rgba(0,0,0,0.75)";
      c.strokeRect(n.x, n.y, n.w, n.h);
      c.setLineDash([]);
      c.lineWidth = px;
      c.strokeStyle = stroke;
      c.strokeRect(n.x, n.y, n.w, n.h);
      c.restore();
    };

    if (cropRect) {
      const n = normRect(cropRect);
      c.save();
      c.fillStyle = "rgba(0,0,0,0.45)";
      c.beginPath();
      c.rect(0, 0, ov.width, ov.height);
      c.rect(n.x + n.w, n.y, -n.w, n.h);   // reverse winding punches the hole
      c.fill("evenodd");
      c.restore();
      marquee(cropRect, "#ffffff");
    }
    if (selection) marquee(selection, "#ffffff");

    if (pointerPos && (tool === "brush" || tool === "eraser")) {
      c.save();
      c.lineWidth = px;
      c.strokeStyle = "rgba(0,0,0,0.85)";
      c.beginPath();
      c.arc(pointerPos.x, pointerPos.y, brushSize / 2, 0, Math.PI * 2);
      c.stroke();
      c.strokeStyle = "rgba(255,255,255,0.9)";
      c.lineWidth = px;
      c.beginPath();
      c.arc(pointerPos.x, pointerPos.y, brushSize / 2 + px, 0, Math.PI * 2);
      c.stroke();
      c.restore();
    }
  }, [image, selection, cropRect, pointerPos, tool, brushSize, zoom, rev]);

  /* ---------- Fit ---------- */
  const computeFit = useCallback(() => {
    const wrap = stageWrapRef.current;
    if (!wrap || !image) return 1;
    const pad = 48;
    const sx = (wrap.clientWidth - pad) / image.width;
    const sy = (wrap.clientHeight - pad) / image.height;
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.min(sx, sy, 1)));
  }, [image]);

  useEffect(() => {
    const wrap = stageWrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => { if (fit) setZoom(computeFit()); });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [fit, computeFit]);

  useEffect(() => { if (fit) setZoom(computeFit()); }, [fit, computeFit, image?.width, image?.height]);

  /* ==============================================================
     Pointer → document coordinates
     ============================================================== */
  const toDoc = useCallback((e: React.PointerEvent | React.MouseEvent) => {
    const ov = overlayRef.current;
    if (!ov) return { x: 0, y: 0 };
    const r = ov.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / zoom,
      y: (e.clientY - r.top) / zoom,
    };
  }, [zoom]);

  /** Clip a context to the active selection so tools respect it. */
  const clipToSelection = useCallback((c: CanvasRenderingContext2D) => {
    if (!selection) return;
    const n = normRect(selection);
    c.beginPath();
    c.rect(n.x, n.y, n.w, n.h);
    c.clip();
  }, [selection]);

  const ensureScratch = useCallback((): HTMLCanvasElement | null => {
    if (!image) return null;
    let s = scratchRef.current;
    if (!s || s.width !== image.width || s.height !== image.height) {
      s = makeCanvas(image.width, image.height);
      scratchRef.current = s;
    } else {
      ctx2d(s).clearRect(0, 0, s.width, s.height);
    }
    return s;
  }, [image]);

  /* ==============================================================
     Tool handlers
     ============================================================== */
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (!image || e.button !== 0) return;
    const p = toDoc(e);
    const layer = image.layers.find((l) => l.id === activeId);

    if (tool === "eyedropper") {
      const view = viewRef.current;
      const hex = view ? pickColor(view, p.x, p.y) : null;
      if (hex) (e.altKey ? setAltColor : setColor)(hex);
      return;
    }

    if (tool === "select" || tool === "crop") {
      (e.target as Element).setPointerCapture?.(e.pointerId);
      strokeRef.current = { tool, start: p, last: p };
      if (tool === "select") setSelection({ x: p.x, y: p.y, w: 0, h: 0 });
      else setCropRect({ x: p.x, y: p.y, w: 0, h: 0 });
      return;
    }

    if (!layer || layer.locked) return;

    if (tool === "text") {
      pushHistory();
      const c = ctx2d(layer.canvas);
      c.save();
      clipToSelection(c);
      c.fillStyle = color;
      c.textBaseline = "alphabetic";
      c.font = `${fontItalic ? "italic " : ""}${fontBold ? "700 " : "400 "}${fontSize}px ${fontFamily}`;
      c.fillText(textValue, p.x, p.y);
      c.restore();
      bump();
      scheduleSync();
      return;
    }

    if (tool === "bucket") {
      pushHistory();
      const c = ctx2d(layer.canvas);
      const region = selection ? normRect(selection) : { x: 0, y: 0, w: layer.canvas.width, h: layer.canvas.height };
      const rx = Math.max(0, Math.floor(region.x));
      const ry = Math.max(0, Math.floor(region.y));
      const rw = Math.max(1, Math.min(layer.canvas.width - rx, Math.floor(region.w)));
      const rh = Math.max(1, Math.min(layer.canvas.height - ry, Math.floor(region.h)));
      const data = c.getImageData(rx, ry, rw, rh);
      const changed = floodFill(data, p.x - rx, p.y - ry, parseColor(e.altKey ? altColor : color), tolerance);
      if (changed) {
        c.putImageData(data, rx, ry);
        bump();
        scheduleSync();
      }
      return;
    }

    (e.target as Element).setPointerCapture?.(e.pointerId);
    pushHistory();

    if (tool === "move") {
      const origin = makeCanvas(layer.canvas.width, layer.canvas.height);
      ctx2d(origin).drawImage(layer.canvas, 0, 0);
      strokeRef.current = { tool, start: p, last: p, origin };
      return;
    }

    const scratch = ensureScratch();
    if (!scratch) return;
    strokeRef.current = { tool, start: p, last: p };

    if (tool === "brush" || tool === "eraser") {
      const c = ctx2d(scratch);
      c.save();
      clipToSelection(c);
      c.fillStyle = tool === "eraser" ? "#000000" : (e.altKey ? altColor : color);
      c.beginPath();
      c.arc(p.x, p.y, brushSize / 2, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }
    bump();
  }, [
    image, activeId, tool, toDoc, color, altColor, brushSize, tolerance, selection,
    textValue, fontSize, fontFamily, fontBold, fontItalic,
    pushHistory, clipToSelection, ensureScratch, bump, scheduleSync,
  ]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const p = toDoc(e);
    setPointerPos(p);
    const s = strokeRef.current;
    if (!s || !image) return;
    const layer = image.layers.find((l) => l.id === activeId);

    if (s.tool === "select") { setSelection({ x: s.start.x, y: s.start.y, w: p.x - s.start.x, h: p.y - s.start.y }); return; }
    if (s.tool === "crop")   { setCropRect({ x: s.start.x, y: s.start.y, w: p.x - s.start.x, h: p.y - s.start.y }); return; }
    if (!layer) return;

    if (s.tool === "move" && s.origin) {
      const c = ctx2d(layer.canvas);
      c.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
      c.drawImage(s.origin, Math.round(p.x - s.start.x), Math.round(p.y - s.start.y));
      bump();
      return;
    }

    const scratch = scratchRef.current;
    if (!scratch) return;
    const c = ctx2d(scratch);

    if (s.tool === "brush" || s.tool === "eraser") {
      c.save();
      clipToSelection(c);
      c.strokeStyle = s.tool === "eraser" ? "#000000" : color;
      c.lineWidth = brushSize;
      c.lineCap = "round";
      c.lineJoin = "round";
      c.beginPath();
      c.moveTo(s.last.x, s.last.y);
      c.lineTo(p.x, p.y);
      c.stroke();
      c.restore();
      s.last = p;
      bump();
      return;
    }

    if (s.tool === "rect" || s.tool === "ellipse" || s.tool === "line") {
      c.clearRect(0, 0, scratch.width, scratch.height);
      c.save();
      clipToSelection(c);
      c.fillStyle = color;
      c.strokeStyle = altColor;
      c.lineWidth = strokeWidth;
      c.lineCap = "round";
      const r = normRect({ x: s.start.x, y: s.start.y, w: p.x - s.start.x, h: p.y - s.start.y });
      if (s.tool === "rect") {
        if (shapeFilled) c.fillRect(r.x, r.y, r.w, r.h);
        if (strokeWidth > 0) c.strokeRect(r.x, r.y, r.w, r.h);
      } else if (s.tool === "ellipse") {
        c.beginPath();
        c.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
        if (shapeFilled) c.fill();
        if (strokeWidth > 0) c.stroke();
      } else {
        c.strokeStyle = color;
        c.lineWidth = Math.max(1, strokeWidth);
        c.beginPath();
        c.moveTo(s.start.x, s.start.y);
        // Shift constrains to 0/45/90°, the way every editor does it.
        const end = e.shiftKey ? constrain(s.start, p) : p;
        c.lineTo(end.x, end.y);
        c.stroke();
      }
      c.restore();
      s.last = p;
      bump();
    }
  }, [image, activeId, toDoc, color, altColor, brushSize, strokeWidth, shapeFilled, clipToSelection, bump]);

  const onPointerUp = useCallback(() => {
    const s = strokeRef.current;
    if (!s || !image) { strokeRef.current = null; return; }
    strokeRef.current = null;

    if (s.tool === "select") {
      setSelection((cur) => {
        if (!cur) return null;
        const n = normRect(cur);
        return n.w < 2 || n.h < 2 ? null : n;   // a click clears the marquee
      });
      return;
    }
    if (s.tool === "crop") {
      setCropRect((cur) => (cur && Math.abs(cur.w) > 2 && Math.abs(cur.h) > 2 ? normRect(cur) : null));
      return;
    }
    if (s.tool === "move") { bump(); scheduleSync(); return; }

    const layer = image.layers.find((l) => l.id === activeId);
    const scratch = scratchRef.current;
    if (layer && scratch) {
      const c = ctx2d(layer.canvas);
      c.save();
      c.globalAlpha = brushOpacity / 100;
      if (s.tool === "eraser") c.globalCompositeOperation = "destination-out";
      c.filter = softFilter(hardness, brushSize, s.tool);
      c.drawImage(scratch, 0, 0);
      c.restore();
      ctx2d(scratch).clearRect(0, 0, scratch.width, scratch.height);
    }
    bump();
    scheduleSync();
  }, [image, activeId, brushOpacity, hardness, brushSize, bump, scheduleSync]);

  /* ==============================================================
     Layer operations
     ============================================================== */
  const withHistory = useCallback((fn: () => void) => {
    pushHistory();
    fn();
    bump();
    scheduleSync();
  }, [pushHistory, bump, scheduleSync]);

  const addLayer = useCallback(() => withHistory(() => {
    setImage((cur) => {
      if (!cur) return cur;
      const l = createLayer(cur.width, cur.height, `Layer ${cur.layers.length + 1}`);
      setActiveId(l.id);
      return { ...cur, layers: [...cur.layers, l] };
    });
  }), [withHistory]);

  const duplicateLayer = useCallback(() => withHistory(() => {
    setImage((cur) => {
      if (!cur || !activeId) return cur;
      const idx = cur.layers.findIndex((l) => l.id === activeId);
      if (idx < 0) return cur;
      const copy = cloneLayer(cur.layers[idx]);
      setActiveId(copy.id);
      const layers = cur.layers.slice();
      layers.splice(idx + 1, 0, copy);
      return { ...cur, layers };
    });
  }), [withHistory, activeId]);

  const deleteLayer = useCallback(() => withHistory(() => {
    setImage((cur) => {
      if (!cur || !activeId || cur.layers.length <= 1) return cur;
      const idx = cur.layers.findIndex((l) => l.id === activeId);
      const layers = cur.layers.filter((l) => l.id !== activeId);
      setActiveId(layers[Math.min(idx, layers.length - 1)]?.id ?? null);
      return { ...cur, layers };
    });
  }), [withHistory, activeId]);

  const moveLayer = useCallback((dir: 1 | -1) => withHistory(() => {
    setImage((cur) => {
      if (!cur || !activeId) return cur;
      const idx = cur.layers.findIndex((l) => l.id === activeId);
      const next = idx + dir;
      if (idx < 0 || next < 0 || next >= cur.layers.length) return cur;
      const layers = cur.layers.slice();
      [layers[idx], layers[next]] = [layers[next], layers[idx]];
      return { ...cur, layers };
    });
  }), [withHistory, activeId]);

  const mergeLayerDown = useCallback(() => withHistory(() => {
    setImage((cur) => {
      if (!cur || !activeId) return cur;
      const merged = mergeDown(cur, activeId);
      if (!merged) return cur;
      const idx = cur.layers.findIndex((l) => l.id === activeId);
      setActiveId(cur.layers[idx - 1].id);
      return merged;
    });
  }), [withHistory, activeId]);

  const patchLayer = useCallback((id: string, patch: Partial<Layer>) => {
    setImage((cur) =>
      cur ? { ...cur, layers: cur.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)) } : cur,
    );
    scheduleSync();
  }, [scheduleSync]);

  /* ==============================================================
     Selection / transform actions
     ============================================================== */
  const fillSelection = useCallback((c: string) => withHistory(() => {
    const layer = imageRef.current?.layers.find((l) => l.id === activeId);
    if (!layer) return;
    const ctx = ctx2d(layer.canvas);
    const r = selection ? normRect(selection) : { x: 0, y: 0, w: layer.canvas.width, h: layer.canvas.height };
    ctx.fillStyle = c;
    ctx.fillRect(r.x, r.y, r.w, r.h);
  }), [withHistory, activeId, selection]);

  const clearSelection = useCallback(() => withHistory(() => {
    const layer = imageRef.current?.layers.find((l) => l.id === activeId);
    if (!layer) return;
    const ctx = ctx2d(layer.canvas);
    const r = selection ? normRect(selection) : { x: 0, y: 0, w: layer.canvas.width, h: layer.canvas.height };
    ctx.clearRect(r.x, r.y, r.w, r.h);
  }), [withHistory, activeId, selection]);

  const applyCrop = useCallback(() => {
    const r = cropRect ?? selection;
    if (!r) return;
    withHistory(() => {
      setImage((cur) => (cur ? cropDoc(cur, r) : cur));
      setCropRect(null);
      setSelection(null);
    });
  }, [cropRect, selection, withHistory]);

  const applyRotate = useCallback((dir: 1 | -1) => withHistory(() => {
    setImage((cur) => (cur ? rotateDoc(cur, dir) : cur));
    setSelection(null);
    setCropRect(null);
  }), [withHistory]);

  const applyFlip = useCallback((axis: "x" | "y") => withHistory(() => {
    setImage((cur) => (cur ? flipDoc(cur, axis) : cur));
  }), [withHistory]);

  const applyResize = useCallback(() => withHistory(() => {
    setImage((cur) => (cur ? resizeDoc(cur, resizeW, resizeH) : cur));
    setSelection(null);
    setCropRect(null);
    setShowResize(false);
  }), [withHistory, resizeW, resizeH]);

  const bakeAdjustments = useCallback(() => {
    if (isNeutral(adjust) || !activeLayer) return;
    withHistory(() => {
      const layer = imageRef.current?.layers.find((l) => l.id === activeId);
      if (layer) bakeFilter(layer, filterString(adjust));
      setAdjust(NEUTRAL_ADJUSTMENTS);
    });
  }, [adjust, activeLayer, activeId, withHistory]);

  /* ==============================================================
     Keyboard
     ============================================================== */
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      void (e.shiftKey ? redo() : undo());
      return;
    }
    if (mod && (e.key === "y" || e.key === "Y")) { e.preventDefault(); void redo(); return; }
    if (mod && (e.key === "d" || e.key === "D")) { e.preventDefault(); setSelection(null); return; }
    if (mod) return;
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); clearSelection(); return; }
    if (e.key === "Escape") { setSelection(null); setCropRect(null); return; }
    if (e.key === "[") { e.preventDefault(); setBrushSize((s) => Math.max(1, Math.round(s * 0.8))); return; }
    if (e.key === "]") { e.preventDefault(); setBrushSize((s) => Math.min(600, Math.round(s * 1.25) + 1)); return; }
    if (e.key === "x" || e.key === "X") {
      e.preventDefault();
      setColor(altColor); setAltColor(color);
      return;
    }
    const hit = TOOLS.find((t) => t.key === e.key.toUpperCase());
    if (hit) { e.preventDefault(); setTool(hit.id); }
  }, [undo, redo, clearSelection, altColor, color]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    setFit(false);
    setZoom((z) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z * (e.deltaY < 0 ? 1.12 : 1 / 1.12))));
  }, []);

  if (!doc) return null;

  if (loadError) {
    return (
      <div className="imged imged--error">
        <Icon name="alert" size={24} />
        <p>{loadError}</p>
        <Button size="sm" onClick={() => setMode(docId, "image")}>Back to viewer</Button>
      </div>
    );
  }

  const bytes = base64ByteLength(doc.raw);
  const fmt = FORMATS.find((f) => f.mime === format) ?? FORMATS[0];

  return (
    <div className="imged" tabIndex={0} onKeyDown={onKeyDown}>
      {/* ---------- Top bar ---------- */}
      <div className="imged__topbar">
        <div className="imged__group">
          <Button size="sm" variant="ghost" icon="undo" aria-label="Undo"
            title="Undo (Ctrl+Z)" disabled={historyDepth.past === 0} onClick={() => void undo()} />
          <Button size="sm" variant="ghost" icon="redo" aria-label="Redo"
            title="Redo (Ctrl+Shift+Z)" disabled={historyDepth.future === 0} onClick={() => void redo()} />
        </div>

        <div className="imged__sep" aria-hidden />

        <div className="imged__group">
          <Button size="sm" variant="ghost" icon="minus" aria-label="Zoom out"
            onClick={() => { setFit(false); setZoom((z) => Math.max(ZOOM_MIN, z / 1.25)); }} />
          <span className="imged__zoom">{Math.round(zoom * 100)}%</span>
          <Button size="sm" variant="ghost" icon="plus" aria-label="Zoom in"
            onClick={() => { setFit(false); setZoom((z) => Math.min(ZOOM_MAX, z * 1.25)); }} />
          <Button size="sm" variant={fit ? "primary" : "ghost"} onClick={() => setFit(true)}>Fit</Button>
          <Button size="sm" variant={!fit && zoom === 1 ? "primary" : "ghost"}
            onClick={() => { setFit(false); setZoom(1); }}>1:1</Button>
        </div>

        <div className="imged__sep" aria-hidden />

        <div className="imged__group">
          <Button size="sm" variant="ghost" icon="undo" aria-label="Rotate left"
            title="Rotate canvas left" onClick={() => applyRotate(-1)} />
          <Button size="sm" variant="ghost" icon="redo" aria-label="Rotate right"
            title="Rotate canvas right" onClick={() => applyRotate(1)} />
          <Button size="sm" variant="ghost" icon="flip-h" aria-label="Flip horizontal"
            title="Flip canvas horizontally" onClick={() => applyFlip("x")} />
          <Button size="sm" variant="ghost" icon="flip-v" aria-label="Flip vertical"
            title="Flip canvas vertically" onClick={() => applyFlip("y")} />
          <Button size="sm" variant={showResize ? "primary" : "ghost"}
            onClick={() => setShowResize((v) => !v)}>Resize…</Button>
        </div>

        <div className="imged__spacer" aria-hidden />

        <div className="imged__group">
          <label className="imged__field">
            <span>Format</span>
            <select value={format} onChange={(e) => setFormat(e.target.value)}>
              {FORMATS.map((f) => <option key={f.mime} value={f.mime}>{f.label}</option>)}
            </select>
          </label>
          {fmt.lossy && (
            <label className="imged__field">
              <span>Quality</span>
              <input type="range" min={10} max={100} value={quality}
                onChange={(e) => setQuality(+e.target.value)} />
              <b>{quality}</b>
            </label>
          )}
          <Button size="sm" variant="ghost" icon="mode-image"
            title="Back to the read-only viewer" onClick={() => setMode(docId, "image")}>View</Button>
        </div>
      </div>

      {showResize && image && (
        <div className="imged__resizebar">
          <label className="imged__field">
            <span>Width</span>
            <input type="number" min={1} max={8192} value={resizeW}
              onChange={(e) => {
                const w = Math.max(1, +e.target.value || 1);
                setResizeW(w);
                if (keepAspect) setResizeH(Math.max(1, Math.round((w * image.height) / image.width)));
              }} />
          </label>
          <label className="imged__field">
            <span>Height</span>
            <input type="number" min={1} max={8192} value={resizeH}
              onChange={(e) => {
                const h = Math.max(1, +e.target.value || 1);
                setResizeH(h);
                if (keepAspect) setResizeW(Math.max(1, Math.round((h * image.width) / image.height)));
              }} />
          </label>
          <label className="imged__check">
            <input type="checkbox" checked={keepAspect} onChange={(e) => setKeepAspect(e.target.checked)} />
            <span>Lock aspect</span>
          </label>
          <Button size="sm" variant="primary" onClick={applyResize}>Apply</Button>
          <Button size="sm" variant="ghost" onClick={() => setShowResize(false)}>Cancel</Button>
        </div>
      )}

      {/* ---------- Tool options ---------- */}
      <div className="imged__optionbar">
        <div className="imged__swatches">
          <button type="button" className="imged__swatch" title="Foreground colour (X swaps)"
            style={{ background: color }} onClick={() => document.getElementById(`fg-${docId}`)?.click()} />
          <input id={`fg-${docId}`} className="imged__colorinput" type="color"
            value={color} onChange={(e) => setColor(e.target.value)} />
          <button type="button" className="imged__swatch imged__swatch--alt" title="Background colour"
            style={{ background: altColor }} onClick={() => document.getElementById(`bg-${docId}`)?.click()} />
          <input id={`bg-${docId}`} className="imged__colorinput" type="color"
            value={altColor} onChange={(e) => setAltColor(e.target.value)} />
        </div>

        {(tool === "brush" || tool === "eraser") && (
          <>
            <label className="imged__field"><span>Size</span>
              <input type="range" min={1} max={300} value={brushSize} onChange={(e) => setBrushSize(+e.target.value)} />
              <b>{brushSize}</b>
            </label>
            <label className="imged__field"><span>Hardness</span>
              <input type="range" min={0} max={100} value={hardness} onChange={(e) => setHardness(+e.target.value)} />
              <b>{hardness}%</b>
            </label>
            <label className="imged__field"><span>Opacity</span>
              <input type="range" min={1} max={100} value={brushOpacity} onChange={(e) => setBrushOpacity(+e.target.value)} />
              <b>{brushOpacity}%</b>
            </label>
          </>
        )}

        {tool === "bucket" && (
          <label className="imged__field"><span>Tolerance</span>
            <input type="range" min={0} max={200} value={tolerance} onChange={(e) => setTolerance(+e.target.value)} />
            <b>{tolerance}</b>
          </label>
        )}

        {(tool === "rect" || tool === "ellipse" || tool === "line") && (
          <>
            {tool !== "line" && (
              <label className="imged__check">
                <input type="checkbox" checked={shapeFilled} onChange={(e) => setShapeFilled(e.target.checked)} />
                <span>Fill</span>
              </label>
            )}
            <label className="imged__field"><span>Stroke</span>
              <input type="range" min={0} max={60} value={strokeWidth} onChange={(e) => setStrokeWidth(+e.target.value)} />
              <b>{strokeWidth}</b>
            </label>
          </>
        )}

        {tool === "text" && (
          <>
            <label className="imged__field imged__field--grow"><span>Text</span>
              <input type="text" value={textValue} onChange={(e) => setTextValue(e.target.value)} />
            </label>
            <label className="imged__field"><span>Size</span>
              <input type="number" min={6} max={400} value={fontSize} onChange={(e) => setFontSize(+e.target.value || 12)} />
            </label>
            <label className="imged__field"><span>Font</span>
              <select value={fontFamily} onChange={(e) => setFontFamily(e.target.value)}>
                {FONTS.map((f) => <option key={f} value={f}>{f.split(",")[0]}</option>)}
              </select>
            </label>
            <Button size="sm" variant={fontBold ? "primary" : "ghost"} icon="bold"
              aria-label="Bold" onClick={() => setFontBold((v) => !v)} />
            <Button size="sm" variant={fontItalic ? "primary" : "ghost"} icon="italic"
              aria-label="Italic" onClick={() => setFontItalic((v) => !v)} />
          </>
        )}

        {(tool === "select" || selection) && (
          <div className="imged__group">
            <Button size="sm" variant="ghost" onClick={() => fillSelection(color)} disabled={!selection}>Fill</Button>
            <Button size="sm" variant="ghost" onClick={clearSelection} disabled={!selection}>Erase</Button>
            <Button size="sm" variant="ghost" onClick={applyCrop} disabled={!selection}>Crop to selection</Button>
            <Button size="sm" variant="ghost" onClick={() => setSelection(null)} disabled={!selection}>Deselect</Button>
          </div>
        )}

        {tool === "crop" && (
          <div className="imged__group">
            <Button size="sm" variant="primary" onClick={applyCrop} disabled={!cropRect}>Apply crop</Button>
            <Button size="sm" variant="ghost" onClick={() => setCropRect(null)} disabled={!cropRect}>Cancel</Button>
          </div>
        )}
      </div>

      {/* ---------- Body ---------- */}
      <div className="imged__body">
        {/* Tool rail */}
        <nav className="imged__tools" aria-label="Tools">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`imged__tool ${tool === t.id ? "is-active" : ""}`}
              aria-label={t.label}
              aria-pressed={tool === t.id}
              title={`${t.label} (${t.key})`}
              onClick={() => setTool(t.id)}
            >
              <Icon name={t.icon} size={17} />
            </button>
          ))}
        </nav>

        {/* Stage */}
        <div ref={stageWrapRef} className="imged__stagewrap" onWheel={onWheel}>
          {image && (
            <div
              className="imged__stage"
              style={{ width: image.width * zoom, height: image.height * zoom }}
            >
              <canvas
                ref={viewRef}
                className="imged__canvas"
                width={image.width}
                height={image.height}
                style={{ width: image.width * zoom, height: image.height * zoom }}
              />
              <canvas
                ref={overlayRef}
                className="imged__overlay"
                data-tool={tool}
                width={image.width}
                height={image.height}
                style={{ width: image.width * zoom, height: image.height * zoom }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onPointerLeave={() => setPointerPos(null)}
              />
            </div>
          )}
        </div>

        {/* Right panel */}
        <aside className="imged__panel">
          <section className="imged__section">
            <header className="imged__sectionhead">
              <h3>Layers</h3>
              <div className="imged__group">
                <Button size="sm" variant="ghost" icon="plus" aria-label="Add layer" title="Add layer" onClick={addLayer} />
                <Button size="sm" variant="ghost" icon="copy" aria-label="Duplicate layer" title="Duplicate layer" onClick={duplicateLayer} />
                <Button size="sm" variant="ghost" icon="arrow-up" aria-label="Raise layer" title="Raise layer" onClick={() => moveLayer(1)} />
                <Button size="sm" variant="ghost" icon="chevron-down" aria-label="Lower layer" title="Lower layer" onClick={() => moveLayer(-1)} />
                <Button size="sm" variant="ghost" icon="layers" aria-label="Merge down" title="Merge down" onClick={mergeLayerDown} />
                <Button size="sm" variant="ghost" icon="trash" aria-label="Delete layer" title="Delete layer"
                  onClick={deleteLayer} disabled={(image?.layers.length ?? 0) <= 1} />
              </div>
            </header>
            <ul className="imged__layers">
              {[...(image?.layers ?? [])].reverse().map((l) => (
                <li
                  key={l.id}
                  className={`imged__layer ${l.id === activeId ? "is-active" : ""}`}
                  onClick={() => setActiveId(l.id)}
                >
                  <button
                    type="button"
                    className="imged__layervis"
                    aria-label={l.visible ? `Hide ${l.name}` : `Show ${l.name}`}
                    title={l.visible ? "Hide layer" : "Show layer"}
                    onClick={(e) => { e.stopPropagation(); patchLayer(l.id, { visible: !l.visible }); }}
                  >
                    <Icon name={l.visible ? "eye" : "eye-slash"} size={14} />
                  </button>
                  <button
                    type="button"
                    className="imged__layervis"
                    aria-label={l.locked ? `Unlock ${l.name}` : `Lock ${l.name}`}
                    title={l.locked ? "Unlock layer" : "Lock layer"}
                    onClick={(e) => { e.stopPropagation(); patchLayer(l.id, { locked: !l.locked }); }}
                  >
                    <Icon name={l.locked ? "lock" : "unlock"} size={14} />
                  </button>
                  <input
                    className="imged__layername"
                    value={l.name}
                    aria-label={`Layer name for ${l.name}`}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => patchLayer(l.id, { name: e.target.value })}
                  />
                  <span className="imged__layerpct">{Math.round(l.opacity * 100)}%</span>
                </li>
              ))}
            </ul>

            {activeLayer && (
              <div className="imged__layerprops">
                <label className="imged__field"><span>Opacity</span>
                  <input type="range" min={0} max={100} value={Math.round(activeLayer.opacity * 100)}
                    onChange={(e) => patchLayer(activeLayer.id, { opacity: +e.target.value / 100 })} />
                  <b>{Math.round(activeLayer.opacity * 100)}%</b>
                </label>
                <label className="imged__field"><span>Blend</span>
                  <select value={activeLayer.blend}
                    onChange={(e) => patchLayer(activeLayer.id, { blend: e.target.value as BlendMode })}>
                    {BLEND_MODES.map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                </label>
              </div>
            )}
          </section>

          <section className="imged__section">
            <header className="imged__sectionhead">
              <h3>Adjust</h3>
              <div className="imged__group">
                <Button size="sm" variant="ghost" onClick={() => setAdjust(NEUTRAL_ADJUSTMENTS)}
                  disabled={isNeutral(adjust)}>Reset</Button>
                <Button size="sm" variant="primary" onClick={bakeAdjustments}
                  disabled={isNeutral(adjust)}>Apply</Button>
              </div>
            </header>
            <p className="imged__note">Previews on the selected layer. Apply bakes it into the pixels.</p>
            {ADJUST_FIELDS.map((f) => (
              <label key={f.key} className="imged__field">
                <span>{f.label}</span>
                <input
                  type="range"
                  min={f.min}
                  max={f.max}
                  value={adjust[f.key]}
                  onChange={(e) => setAdjust((a) => ({ ...a, [f.key]: +e.target.value }))}
                />
                <b>{adjust[f.key]}{f.unit}</b>
              </label>
            ))}
          </section>
        </aside>
      </div>

      {/* ---------- Status ---------- */}
      <div className="imged__status">
        <span>{image ? `${image.width} × ${image.height}` : "—"}</span>
        <span className="imged__dot" aria-hidden>·</span>
        <span>{image?.layers.length ?? 0} layer{(image?.layers.length ?? 0) === 1 ? "" : "s"}</span>
        <span className="imged__dot" aria-hidden>·</span>
        <span>{fmt.label} {formatBytes(bytes)}</span>
        {selection && (
          <>
            <span className="imged__dot" aria-hidden>·</span>
            <span>sel {Math.round(selection.w)} × {Math.round(selection.h)}</span>
          </>
        )}
        <span className="imged__spacer" aria-hidden />
        <span className="imged__pos">
          {pointerPos ? `${Math.floor(pointerPos.x)}, ${Math.floor(pointerPos.y)}` : `${extname(doc.path ?? doc.name).toUpperCase() || "IMG"}`}
        </span>
      </div>
    </div>
  );
}

const ADJUST_FIELDS: Array<{ key: keyof Adjustments; label: string; min: number; max: number; unit: string }> = [
  { key: "brightness", label: "Brightness", min: 0,    max: 300, unit: "%" },
  { key: "contrast",   label: "Contrast",   min: 0,    max: 300, unit: "%" },
  { key: "saturate",   label: "Saturation", min: 0,    max: 300, unit: "%" },
  { key: "hueRotate",  label: "Hue",        min: -180, max: 180, unit: "°" },
  { key: "blur",       label: "Blur",       min: 0,    max: 40,  unit: "px" },
  { key: "grayscale",  label: "Grayscale",  min: 0,    max: 100, unit: "%" },
  { key: "sepia",      label: "Sepia",      min: 0,    max: 100, unit: "%" },
  { key: "invert",     label: "Invert",     min: 0,    max: 100, unit: "%" },
];

/** Soft brushes are a blur on the composited stroke, not a per-stamp
    gradient: one filter pass keeps the edge even along the whole path. */
function softFilter(hardness: number, size: number, tool: Tool): string {
  if (tool !== "brush" && tool !== "eraser") return "none";
  if (hardness >= 100) return "none";
  const radius = ((100 - hardness) / 100) * (size / 4);
  return radius < 0.4 ? "none" : `blur(${radius.toFixed(2)}px)`;
}

/** Snap `p` to the nearest 45° ray from `origin`. */
function constrain(origin: { x: number; y: number }, p: { x: number; y: number }) {
  const dx = p.x - origin.x;
  const dy = p.y - origin.y;
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(dx, dy);
  return { x: origin.x + Math.cos(angle) * len, y: origin.y + Math.sin(angle) * len };
}

export default ImageEditor;
