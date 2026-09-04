/* ============================================================
   sparkBook · src/editor/ImageViewer/index.tsx
   Read-only raster surface for png/jpg/gif/webp/bmp/ico/avif.

   Principles:
   • File is source of truth. `doc.raw` holds base64 bytes; this
     surface never writes them back.
   • View transforms (zoom / pan / rotate / flip) are local state,
     not edits — the file on disk is untouched.
   • Hand off to the image editor with one click; the editor reads
     the same bytes.
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDocs } from "@store/documents";
import { Button } from "@ui/Button";
import { Icon } from "@ui/Icon";
import { imageMime, extname } from "@bridge/commands";
import { base64ToObjectUrl, base64ByteLength, formatBytes } from "@lib/binary";
import "./ImageViewer.css";
import "../editor.css";

const ZOOM_MIN = 0.02;
const ZOOM_MAX = 64;
const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];

type Backdrop = "checker" | "dark" | "light";

/** Next zoom stop above/below `z`, so the buttons feel like a camera. */
function stepZoom(z: number, dir: 1 | -1): number {
  if (dir > 0) {
    const hit = ZOOM_STEPS.find((s) => s > z + 1e-6);
    return Math.min(ZOOM_MAX, hit ?? z * 1.5);
  }
  const hit = [...ZOOM_STEPS].reverse().find((s) => s < z - 1e-6);
  return Math.max(ZOOM_MIN, hit ?? z / 1.5);
}

export function ImageViewer({ docId }: { docId: string }) {
  const doc = useDocs((s) => s.docs[docId]);
  const setMode = useDocs((s) => s.setMode);

  const [zoom, setZoom] = useState(1);
  const [fitMode, setFitMode] = useState(true);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0);      // degrees, multiples of 90
  const [flipX, setFlipX] = useState(false);
  const [flipY, setFlipY] = useState(false);
  const [backdrop, setBackdrop] = useState<Backdrop>("checker");
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  const mime = useMemo(() => imageMime(doc?.path ?? doc?.name ?? ""), [doc?.path, doc?.name]);
  const raw = doc?.raw ?? "";

  /* Object URL rather than a data URI: a 10 MB PNG as a data URI is a
     10 MB string the webview re-parses on every re-render. */
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!raw) { setUrl(null); return; }
    let objectUrl: string | null = null;
    try {
      objectUrl = base64ToObjectUrl(raw, mime);
      setUrl(objectUrl);
      setError(null);
    } catch {
      setUrl(null);
      setError("These bytes could not be read as an image.");
    }
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [raw, mime]);

  const byteSize = useMemo(() => base64ByteLength(raw), [raw]);

  /* ---------- Fit ---------- */
  const computeFit = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp || !natural) return 1;
    // Rotation swaps the axes, so fit has to measure the rotated box.
    const swapped = rotation % 180 !== 0;
    const w = swapped ? natural.h : natural.w;
    const h = swapped ? natural.w : natural.h;
    const pad = 48;
    const sx = (vp.clientWidth - pad) / w;
    const sy = (vp.clientHeight - pad) / h;
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.min(sx, sy)));
  }, [natural, rotation]);

  const applyFit = useCallback(() => {
    setZoom(computeFit());
    setPan({ x: 0, y: 0 });
    setFitMode(true);
  }, [computeFit]);

  const applyActual = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setFitMode(false);
  }, []);

  // Re-fit whenever the pane resizes while fit mode is on.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const ro = new ResizeObserver(() => { if (fitMode) setZoom(computeFit()); });
    ro.observe(vp);
    return () => ro.disconnect();
  }, [fitMode, computeFit]);

  useEffect(() => { if (fitMode && natural) setZoom(computeFit()); }, [natural, rotation, fitMode, computeFit]);

  /* ---------- Interaction ---------- */
  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;   // plain wheel keeps scrolling the pane
    e.preventDefault();
    setFitMode(false);
    setZoom((z) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z * (e.deltaY < 0 ? 1.12 : 1 / 1.12))));
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
  }, [pan]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setPan({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) });
  }, []);

  const endDrag = useCallback(() => { dragRef.current = null; }, []);

  const rotate = useCallback((dir: 1 | -1) => {
    setRotation((r) => (((r + dir * 90) % 360) + 360) % 360);
  }, []);

  const reset = useCallback(() => {
    setRotation(0); setFlipX(false); setFlipY(false); applyFit();
  }, [applyFit]);

  /* Keyboard: the surface owns focus, so the shortcuts do not fight
     the code editor's bindings. */
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const step = e.shiftKey ? 80 : 24;
    switch (e.key) {
      case "+": case "=": setFitMode(false); setZoom((z) => stepZoom(z, 1)); break;
      case "-": case "_": setFitMode(false); setZoom((z) => stepZoom(z, -1)); break;
      case "0": applyActual(); break;
      case "f": case "F": applyFit(); break;
      case "r": rotate(1); break;
      case "R": rotate(-1); break;
      case "h": setFlipX((v) => !v); break;
      case "v": setFlipY((v) => !v); break;
      case "ArrowLeft":  setPan((p) => ({ ...p, x: p.x + step })); break;
      case "ArrowRight": setPan((p) => ({ ...p, x: p.x - step })); break;
      case "ArrowUp":    setPan((p) => ({ ...p, y: p.y + step })); break;
      case "ArrowDown":  setPan((p) => ({ ...p, y: p.y - step })); break;
      default: return;
    }
    e.preventDefault();
  }, [applyActual, applyFit, rotate]);

  if (!doc) return null;

  const transform =
    `translate(${pan.x}px, ${pan.y}px) rotate(${rotation}deg) ` +
    `scale(${zoom * (flipX ? -1 : 1)}, ${zoom * (flipY ? -1 : 1)})`;

  return (
    <div className="img-view" data-backdrop={backdrop}>
      <div className="img-view__toolbar">
        <div className="img-view__group">
          <Button size="sm" variant="ghost" icon="minus" aria-label="Zoom out"
            title="Zoom out (−)"
            onClick={() => { setFitMode(false); setZoom((z) => stepZoom(z, -1)); }} />
          <span className="img-view__zoom" title="Current zoom">{Math.round(zoom * 100)}%</span>
          <Button size="sm" variant="ghost" icon="plus" aria-label="Zoom in"
            title="Zoom in (+)"
            onClick={() => { setFitMode(false); setZoom((z) => stepZoom(z, 1)); }} />
          <Button size="sm" variant={fitMode ? "primary" : "ghost"} onClick={applyFit} title="Fit to window (F)">Fit</Button>
          <Button size="sm" variant={!fitMode && zoom === 1 ? "primary" : "ghost"} onClick={applyActual} title="Actual size (0)">1:1</Button>
        </div>

        <div className="img-view__sep" aria-hidden />

        <div className="img-view__group">
          <Button size="sm" variant="ghost" icon="undo" aria-label="Rotate left"
            title="Rotate left (Shift+R)" onClick={() => rotate(-1)} />
          <Button size="sm" variant="ghost" icon="redo" aria-label="Rotate right"
            title="Rotate right (R)" onClick={() => rotate(1)} />
          <Button size="sm" variant={flipX ? "primary" : "ghost"} onClick={() => setFlipX((v) => !v)} title="Flip horizontal (H)">Flip H</Button>
          <Button size="sm" variant={flipY ? "primary" : "ghost"} onClick={() => setFlipY((v) => !v)} title="Flip vertical (V)">Flip V</Button>
          <Button size="sm" variant="ghost" onClick={reset} title="Reset view">Reset</Button>
        </div>

        <div className="img-view__sep" aria-hidden />

        <div className="img-view__group" role="group" aria-label="Backdrop">
          {(["checker", "dark", "light"] as Backdrop[]).map((b) => (
            <button
              key={b}
              type="button"
              className={`img-view__swatch img-view__swatch--${b} ${backdrop === b ? "is-active" : ""}`}
              aria-label={`${b} backdrop`}
              aria-pressed={backdrop === b}
              title={`${b} backdrop`}
              onClick={() => setBackdrop(b)}
            />
          ))}
        </div>

        <div className="img-view__spacer" aria-hidden />

        <Button
          size="sm"
          variant="primary"
          icon="mode-imageedit"
          onClick={() => setMode(docId, "imageedit")}
          title="Open these pixels in the image editor"
        >
          Edit
        </Button>
      </div>

      <div
        ref={viewportRef}
        className="img-view__viewport"
        tabIndex={0}
        role="img"
        aria-label={`${doc.name}${natural ? `, ${natural.w} by ${natural.h} pixels` : ""}`}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => (fitMode ? applyActual() : applyFit())}
        onKeyDown={onKeyDown}
      >
        {error ? (
          <div className="img-view__empty">
            <Icon name="alert" size={22} />
            <p>{error}</p>
          </div>
        ) : url ? (
          <img
            className="img-view__img"
            src={url}
            alt={doc.name}
            draggable={false}
            style={{ transform }}
            onLoad={(e) => {
              const el = e.currentTarget;
              setNatural({ w: el.naturalWidth, h: el.naturalHeight });
            }}
            onError={() => setError("These bytes could not be read as an image.")}
          />
        ) : (
          <div className="img-view__empty"><p>Loading…</p></div>
        )}
      </div>

      <div className="img-view__info">
        <span>{natural ? `${natural.w} × ${natural.h}` : "—"}</span>
        <span className="img-view__dot" aria-hidden>·</span>
        <span>{(extname(doc.path ?? doc.name) || "img").toUpperCase()}</span>
        <span className="img-view__dot" aria-hidden>·</span>
        <span>{formatBytes(byteSize)}</span>
        {rotation !== 0 && (<><span className="img-view__dot" aria-hidden>·</span><span>{rotation}°</span></>)}
        <span className="img-view__spacer" aria-hidden />
        <span className="img-view__hint">Ctrl+wheel zoom · drag to pan · double-click toggles fit</span>
      </div>
    </div>
  );
}

export default ImageViewer;
