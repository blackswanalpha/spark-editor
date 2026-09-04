/* ============================================================
   sparkBook · src/editor/AnimationBuilder/index.tsx
   Keyframe animation builder over a `.sparkanim` JSON scene.

   Shape of the thing:
   • The file is the scene. Every edit re-serializes to `doc.raw`,
     so undo/redo, dirty state and save come from the document
     store for free — no private history stack.
   • The stage is SVG sampled at the playhead. Dragging a layer
     writes a keyframe when that property is animated and the base
     value when it is not, which is what "auto-key" means here.
   • Export writes a standalone HTML player with the same sampling
     maths inlined, so a share needs no runtime.
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDocs } from "@store/documents";
import { Button } from "@ui/Button";
import { Icon } from "@ui/Icon";
import { saveFileDialog, writeFile, openFileDialog, readFileBase64, imageMime } from "@bridge/commands";
import { dataUri } from "@lib/binary";
import {
  ANIM_PROPS, EASINGS, createLayer, exportHtml, layerKeyTimes, moveKeyframe,
  parseScene, removeKeyframe, sampleLayer, sampleProp, serializeScene, setEasing,
  setKeyframe, snapToFrame,
  type AnimLayer, type AnimProp, type AnimScene, type Easing, type LayerKind,
} from "./model";
import "./AnimationBuilder.css";
import "../editor.css";

const LAYER_KINDS: Array<{ kind: LayerKind; label: string; icon: string }> = [
  { kind: "rect",    label: "Rectangle", icon: "tool-rect" },
  { kind: "ellipse", label: "Ellipse",   icon: "tool-ellipse" },
  { kind: "text",    label: "Text",      icon: "tool-text" },
  { kind: "image",   label: "Image",     icon: "mode-image" },
];

type Handle = "nw" | "ne" | "sw" | "se";

interface Drag {
  kind: "move" | Handle;
  startX: number; startY: number;
  base: { x: number; y: number; width: number; height: number };
}

export function AnimationBuilder({ docId }: { docId: string }) {
  const doc = useDocs((s) => s.docs[docId]);
  const setRaw = useDocs((s) => s.setRaw);
  const raw = doc?.raw ?? "";

  const [scene, setScene] = useState<AnimScene>(() => parseScene(raw));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const [autoKey, setAutoKey] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [stageScale, setStageScale] = useState(1);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const stageWrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const kfDragRef = useRef<{ layerId: string; prop: AnimProp; from: number } | null>(null);
  const committingRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef(0);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  const selected = useMemo(
    () => scene.layers.find((l) => l.id === selectedId) ?? null,
    [scene, selectedId],
  );

  /* ==============================================================
     Scene ⇄ document
     ============================================================== */
  useEffect(() => {
    // Fresh document: re-read from raw and reset the playhead.
    const parsed = parseScene(useDocs.getState().docs[docId]?.raw ?? "");
    setScene(parsed);
    setSelectedId(parsed.layers[0]?.id ?? null);
    setTime(0);
    setPlaying(false);
  }, [docId]);

  /* Raw changed underneath us — a store undo/redo, or an external
     reload. Re-parse, unless we are the ones who just wrote it. */
  useEffect(() => {
    if (committingRef.current) return;
    const serialized = serializeScene(sceneRef.current);
    if (raw && raw !== serialized) {
      const parsed = parseScene(raw);
      setScene(parsed);
      if (!parsed.layers.some((l) => l.id === selectedId)) {
        setSelectedId(parsed.layers[0]?.id ?? null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw]);

  /** Commit a scene edit to the document. */
  const commit = useCallback((next: AnimScene) => {
    setScene(next);
    committingRef.current = true;
    setRaw(docId, serializeScene(next));
    requestAnimationFrame(() => { committingRef.current = false; });
  }, [docId, setRaw]);

  const patchLayer = useCallback((id: string, fn: (l: AnimLayer) => AnimLayer) => {
    commit({
      ...sceneRef.current,
      layers: sceneRef.current.layers.map((l) => (l.id === id ? fn(l) : l)),
    });
  }, [commit]);

  /* ==============================================================
     Playback
     ============================================================== */
  useEffect(() => {
    if (!playing) {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }
    lastTickRef.current = performance.now();
    const tick = (now: number) => {
      const dt = now - lastTickRef.current;
      lastTickRef.current = now;
      setTime((t) => {
        const next = t + dt;
        if (next < sceneRef.current.duration) return next;
        if (loop) return next % sceneRef.current.duration;
        setPlaying(false);
        return sceneRef.current.duration;
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); };
  }, [playing, loop]);

  /* ==============================================================
     Stage sizing
     ============================================================== */
  useEffect(() => {
    const wrap = stageWrapRef.current;
    if (!wrap) return;
    const fit = () => {
      const pad = 32;
      const sx = (wrap.clientWidth - pad) / scene.width;
      const sy = (wrap.clientHeight - pad) / scene.height;
      setStageScale(Math.max(0.05, Math.min(2, Math.min(sx, sy))));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [scene.width, scene.height]);

  /* ==============================================================
     Property editing
     ============================================================== */
  /** Write `value` for `prop`: as a keyframe when the property is
      already animated or auto-key is on, otherwise as the base value. */
  const applyProp = useCallback((
    layerId: string, prop: AnimProp, value: number | string, key = autoKey,
  ) => {
    patchLayer(layerId, (l) => {
      const animated = (l.tracks[prop]?.length ?? 0) > 0;
      if (animated || key) return setKeyframe(l, prop, snapToFrame(time, sceneRef.current.fps), value);
      return { ...l, base: { ...l.base, [prop]: value } };
    });
  }, [patchLayer, autoKey, time]);

  const toggleKeyAt = useCallback((layerId: string, prop: AnimProp) => {
    const t = snapToFrame(time, sceneRef.current.fps);
    patchLayer(layerId, (l) => {
      const has = (l.tracks[prop] ?? []).some((k) => Math.abs(k.t - t) < 1);
      if (has) return removeKeyframe(l, prop, t);
      return setKeyframe(l, prop, t, sampleProp(l, prop, t));
    });
  }, [patchLayer, time]);

  /* ==============================================================
     Stage interaction
     ============================================================== */
  const startDrag = useCallback((e: React.PointerEvent, layer: AnimLayer, kind: Drag["kind"]) => {
    if (layer.locked) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setSelectedId(layer.id);
    setPlaying(false);
    const s = sampleLayer(layer, time);
    dragRef.current = {
      kind,
      startX: e.clientX,
      startY: e.clientY,
      base: { x: s.x, y: s.y, width: s.width, height: s.height },
    };
  }, [time]);

  const onStagePointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || !selectedId) return;
    const dx = (e.clientX - d.startX) / stageScale;
    const dy = (e.clientY - d.startY) / stageScale;

    if (d.kind === "move") {
      applyProp(selectedId, "x", Math.round(d.base.x + dx));
      applyProp(selectedId, "y", Math.round(d.base.y + dy));
      return;
    }
    // Corner resize: the two anchored edges stay put.
    const west = d.kind === "nw" || d.kind === "sw";
    const north = d.kind === "nw" || d.kind === "ne";
    const w = Math.max(4, Math.round(west ? d.base.width - dx : d.base.width + dx));
    const h = Math.max(4, Math.round(north ? d.base.height - dy : d.base.height + dy));
    applyProp(selectedId, "width", w);
    applyProp(selectedId, "height", h);
    if (west) applyProp(selectedId, "x", Math.round(d.base.x + d.base.width - w));
    if (north) applyProp(selectedId, "y", Math.round(d.base.y + d.base.height - h));
  }, [selectedId, stageScale, applyProp]);

  const endDrag = useCallback(() => { dragRef.current = null; }, []);

  /* ==============================================================
     Timeline interaction
     ============================================================== */
  const seekFromClient = useCallback((clientX: number) => {
    const el = rulerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    setTime(snapToFrame(ratio * sceneRef.current.duration, sceneRef.current.fps));
  }, []);

  const onRulerDown = useCallback((e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setPlaying(false);
    seekFromClient(e.clientX);
  }, [seekFromClient]);

  const onRulerMove = useCallback((e: React.PointerEvent) => {
    if (e.buttons !== 1) return;
    seekFromClient(e.clientX);
  }, [seekFromClient]);

  const onKeyframeDown = useCallback((
    e: React.PointerEvent, layerId: string, prop: AnimProp, t: number,
  ) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    kfDragRef.current = { layerId, prop, from: t };
    setTime(t);
  }, []);

  const onTrackMove = useCallback((e: React.PointerEvent) => {
    const k = kfDragRef.current;
    if (!k || e.buttons !== 1) return;
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const to = snapToFrame(ratio * sceneRef.current.duration, sceneRef.current.fps);
    if (Math.abs(to - k.from) < 1) return;
    patchLayer(k.layerId, (l) => moveKeyframe(l, k.prop, k.from, to));
    kfDragRef.current = { ...k, from: to };
    setTime(to);
  }, [patchLayer]);

  const endKfDrag = useCallback(() => { kfDragRef.current = null; }, []);

  /* ==============================================================
     Layer management
     ============================================================== */
  const addLayer = useCallback((kind: LayerKind) => {
    const l = createLayer(kind, sceneRef.current);
    commit({ ...sceneRef.current, layers: [...sceneRef.current.layers, l] });
    setSelectedId(l.id);
  }, [commit]);

  const deleteLayer = useCallback((id: string) => {
    const layers = sceneRef.current.layers.filter((l) => l.id !== id);
    commit({ ...sceneRef.current, layers });
    if (selectedId === id) setSelectedId(layers.at(-1)?.id ?? null);
  }, [commit, selectedId]);

  const duplicateLayer = useCallback((id: string) => {
    const src = sceneRef.current.layers.find((l) => l.id === id);
    if (!src) return;
    const copy: AnimLayer = {
      ...src,
      id: `${src.id}-c${Date.now().toString(36)}`,
      name: `${src.name} copy`,
      base: { ...src.base },
      style: { ...src.style },
      tracks: Object.fromEntries(
        Object.entries(src.tracks).map(([k, v]) => [k, v?.map((kf) => ({ ...kf }))]),
      ),
    };
    commit({ ...sceneRef.current, layers: [...sceneRef.current.layers, copy] });
    setSelectedId(copy.id);
  }, [commit]);

  const reorderLayer = useCallback((id: string, dir: 1 | -1) => {
    const layers = sceneRef.current.layers.slice();
    const idx = layers.findIndex((l) => l.id === id);
    const next = idx + dir;
    if (idx < 0 || next < 0 || next >= layers.length) return;
    [layers[idx], layers[next]] = [layers[next], layers[idx]];
    commit({ ...sceneRef.current, layers });
  }, [commit]);

  const pickImage = useCallback(async (layerId: string) => {
    const picked = await openFileDialog({
      multiple: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
    });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return;
    try {
      const b64 = await readFileBase64(path);
      patchLayer(layerId, (l) => ({ ...l, style: { ...l.style, src: dataUri(b64, imageMime(path)) } }));
    } catch {
      setNotice("That image could not be read.");
    }
  }, [patchLayer]);

  /* ==============================================================
     Export
     ============================================================== */
  const exportStandalone = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const base = (doc?.name ?? "animation").replace(/\.[^.]+$/, "");
      const path = await saveFileDialog({
        defaultPath: `${base}.html`,
        filters: [{ name: "HTML", extensions: ["html"] }],
      });
      if (!path) return;
      await writeFile(path, exportHtml(sceneRef.current, base));
      setNotice(`Exported to ${path}`);
    } catch {
      setNotice("Export failed.");
    } finally {
      setBusy(false);
    }
  }, [doc?.name]);

  /* ==============================================================
     Keyboard
     ============================================================== */
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA") return;
    const frame = 1000 / scene.fps;
    switch (e.key) {
      case " ": setPlaying((p) => !p); break;
      case "Home": setTime(0); break;
      case "End": setTime(scene.duration); break;
      case "ArrowLeft": setTime((t) => Math.max(0, snapToFrame(t - frame, scene.fps))); break;
      case "ArrowRight": setTime((t) => Math.min(scene.duration, snapToFrame(t + frame, scene.fps))); break;
      case "Delete": case "Backspace": if (selectedId) deleteLayer(selectedId); break;
      default: return;
    }
    e.preventDefault();
  }, [scene.fps, scene.duration, selectedId, deleteLayer]);

  if (!doc) return null;

  const pct = scene.duration > 0 ? (time / scene.duration) * 100 : 0;

  return (
    <div className="anim" tabIndex={0} onKeyDown={onKeyDown}>
      {/* ---------- Transport ---------- */}
      <div className="anim__topbar">
        <div className="anim__group">
          <Button size="sm" variant="ghost" icon="skip-back" aria-label="Go to start"
            title="Go to start (Home)" onClick={() => { setPlaying(false); setTime(0); }} />
          <Button size="sm" variant={playing ? "primary" : "secondary"}
            icon={playing ? "pause" : "play"} aria-label={playing ? "Pause" : "Play"}
            title="Play / pause (Space)" onClick={() => setPlaying((p) => !p)} />
          <Button size="sm" variant="ghost" icon="skip-forward" aria-label="Go to end"
            title="Go to end (End)" onClick={() => { setPlaying(false); setTime(scene.duration); }} />
          <Button size="sm" variant={loop ? "primary" : "ghost"} icon="loop"
            aria-label="Loop" aria-pressed={loop} title="Loop playback" onClick={() => setLoop((v) => !v)} />
          <span className="anim__time">{(time / 1000).toFixed(2)}s / {(scene.duration / 1000).toFixed(2)}s</span>
        </div>

        <div className="anim__sep" aria-hidden />

        <div className="anim__group">
          <label className="anim__field"><span>Duration</span>
            <input type="number" min={100} max={600000} step={100} value={scene.duration}
              onChange={(e) => commit({ ...scene, duration: Math.max(100, +e.target.value || 100) })} />
            <em>ms</em>
          </label>
          <label className="anim__field"><span>FPS</span>
            <input type="number" min={1} max={120} value={scene.fps}
              onChange={(e) => commit({ ...scene, fps: Math.max(1, Math.min(120, +e.target.value || 1)) })} />
          </label>
          <label className="anim__field"><span>Stage</span>
            <input type="number" min={16} max={8192} value={scene.width}
              aria-label="Stage width"
              onChange={(e) => commit({ ...scene, width: Math.max(16, +e.target.value || 16) })} />
            <em>×</em>
            <input type="number" min={16} max={8192} value={scene.height}
              aria-label="Stage height"
              onChange={(e) => commit({ ...scene, height: Math.max(16, +e.target.value || 16) })} />
          </label>
          <label className="anim__field"><span>BG</span>
            <input type="color" value={scene.background}
              aria-label="Stage background"
              onChange={(e) => commit({ ...scene, background: e.target.value })} />
          </label>
        </div>

        <div className="anim__spacer" aria-hidden />

        <label className="anim__check" title="New values become keyframes at the playhead">
          <input type="checkbox" checked={autoKey} onChange={(e) => setAutoKey(e.target.checked)} />
          <span>Auto-key</span>
        </label>
        <Button size="sm" variant="secondary" icon="export" loading={busy} onClick={exportStandalone}>
          Export HTML
        </Button>
      </div>

      {notice && (
        <div className="anim__notice" role="status">
          <span>{notice}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}>
            <Icon name="close" size={12} />
          </button>
        </div>
      )}

      {/* ---------- Body ---------- */}
      <div className="anim__body">
        {/* Layer list */}
        <aside className="anim__layers">
          <header className="anim__panelhead">
            <h3>Layers</h3>
          </header>
          <div className="anim__addrow">
            {LAYER_KINDS.map((k) => (
              <Button key={k.kind} size="sm" variant="ghost" icon={k.icon}
                aria-label={`Add ${k.label}`} title={`Add ${k.label}`} onClick={() => addLayer(k.kind)} />
            ))}
          </div>
          <ul className="anim__layerlist">
            {[...scene.layers].reverse().map((l) => (
              <li key={l.id}
                className={`anim__layeritem ${l.id === selectedId ? "is-active" : ""}`}
                onClick={() => setSelectedId(l.id)}>
                <button type="button" className="anim__iconbtn"
                  aria-label={l.visible ? `Hide ${l.name}` : `Show ${l.name}`}
                  title={l.visible ? "Hide" : "Show"}
                  onClick={(e) => { e.stopPropagation(); patchLayer(l.id, (x) => ({ ...x, visible: !x.visible })); }}>
                  <Icon name={l.visible ? "eye" : "eye-slash"} size={13} />
                </button>
                <button type="button" className="anim__iconbtn"
                  aria-label={l.locked ? `Unlock ${l.name}` : `Lock ${l.name}`}
                  title={l.locked ? "Unlock" : "Lock"}
                  onClick={(e) => { e.stopPropagation(); patchLayer(l.id, (x) => ({ ...x, locked: !x.locked })); }}>
                  <Icon name={l.locked ? "lock" : "unlock"} size={13} />
                </button>
                <input className="anim__layername" value={l.name}
                  aria-label={`Name of ${l.name}`}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => patchLayer(l.id, (x) => ({ ...x, name: e.target.value }))} />
              </li>
            ))}
            {scene.layers.length === 0 && <li className="anim__empty">Add a shape to begin.</li>}
          </ul>
          {selected && (
            <div className="anim__layeractions">
              <Button size="sm" variant="ghost" icon="copy" aria-label="Duplicate layer"
                title="Duplicate" onClick={() => duplicateLayer(selected.id)} />
              <Button size="sm" variant="ghost" icon="arrow-up" aria-label="Raise layer"
                title="Raise" onClick={() => reorderLayer(selected.id, 1)} />
              <Button size="sm" variant="ghost" icon="chevron-down" aria-label="Lower layer"
                title="Lower" onClick={() => reorderLayer(selected.id, -1)} />
              <Button size="sm" variant="ghost" icon="trash" aria-label="Delete layer"
                title="Delete" onClick={() => deleteLayer(selected.id)} />
            </div>
          )}
        </aside>

        {/* Stage */}
        <div ref={stageWrapRef} className="anim__stagewrap" onClick={() => setSelectedId(null)}>
          <svg
            ref={svgRef}
            className="anim__stage"
            viewBox={`0 0 ${scene.width} ${scene.height}`}
            width={scene.width * stageScale}
            height={scene.height * stageScale}
            style={{ background: scene.background }}
            onPointerMove={onStagePointerMove}
            onPointerUp={endDrag}
            onPointerLeave={endDrag}
            onClick={(e) => e.stopPropagation()}
          >
            {scene.layers.map((layer) => {
              const s = sampleLayer(layer, time);
              const cx = s.x + s.width / 2;
              const cy = s.y + s.height / 2;
              const st = layer.style;
              const transform =
                `rotate(${s.rotation} ${cx} ${cy}) ` +
                `translate(${cx} ${cy}) scale(${s.scale}) translate(${-cx} ${-cy})`;
              const strokeProps = st.strokeWidth > 0
                ? { stroke: st.stroke, strokeWidth: st.strokeWidth }
                : {};
              return (
                <g key={layer.id} opacity={layer.visible ? s.opacity : 0} transform={transform}
                   style={{ cursor: layer.locked ? "not-allowed" : "move" }}
                   onPointerDown={(e) => startDrag(e, layer, "move")}>
                  {layer.kind === "ellipse" && (
                    <ellipse cx={cx} cy={cy} rx={s.width / 2} ry={s.height / 2} fill={s.fill} {...strokeProps} />
                  )}
                  {layer.kind === "rect" && (
                    <rect x={s.x} y={s.y} width={s.width} height={s.height} rx={st.radius} fill={s.fill} {...strokeProps} />
                  )}
                  {layer.kind === "text" && (
                    <text x={s.x} y={s.y + st.fontSize} fill={s.fill}
                      fontSize={st.fontSize} fontFamily={st.fontFamily} fontWeight={st.fontWeight}>
                      {st.text}
                    </text>
                  )}
                  {layer.kind === "image" && (
                    st.src
                      ? <image href={st.src} x={s.x} y={s.y} width={s.width} height={s.height}
                          preserveAspectRatio="xMidYMid slice" />
                      : <rect x={s.x} y={s.y} width={s.width} height={s.height}
                          fill="none" stroke="#8a93a3" strokeDasharray="8 6" strokeWidth={2} />
                  )}
                </g>
              );
            })}

            {/* Selection frame + resize handles */}
            {selected && (() => {
              const s = sampleLayer(selected, time);
              const hs = 8 / stageScale;
              const corners: Array<[Handle, number, number]> = [
                ["nw", s.x, s.y],
                ["ne", s.x + s.width, s.y],
                ["sw", s.x, s.y + s.height],
                ["se", s.x + s.width, s.y + s.height],
              ];
              return (
                <g className="anim__selection" pointerEvents="none">
                  <rect x={s.x} y={s.y} width={s.width} height={s.height}
                    fill="none" stroke="#1f5ed0" strokeWidth={1.5 / stageScale}
                    strokeDasharray={`${5 / stageScale} ${4 / stageScale}`} />
                  {corners.map(([h, hx, hy]) => (
                    <rect key={h} x={hx - hs / 2} y={hy - hs / 2} width={hs} height={hs}
                      fill="#ffffff" stroke="#1f5ed0" strokeWidth={1.5 / stageScale}
                      pointerEvents="all"
                      style={{ cursor: h === "nw" || h === "se" ? "nwse-resize" : "nesw-resize" }}
                      onPointerDown={(e) => startDrag(e, selected, h)} />
                  ))}
                </g>
              );
            })()}
          </svg>
        </div>

        {/* Properties */}
        <aside className="anim__props">
          <header className="anim__panelhead"><h3>Properties</h3></header>
          {!selected ? (
            <p className="anim__hint">Select a layer to edit its properties and set keyframes.</p>
          ) : (
            <>
              {selected.kind === "text" && (
                <>
                  <label className="anim__field anim__field--stack"><span>Text</span>
                    <input type="text" value={selected.style.text}
                      onChange={(e) => patchLayer(selected.id, (l) => ({ ...l, style: { ...l.style, text: e.target.value } }))} />
                  </label>
                  <label className="anim__field"><span>Size</span>
                    <input type="number" min={4} max={400} value={selected.style.fontSize}
                      onChange={(e) => patchLayer(selected.id, (l) => ({ ...l, style: { ...l.style, fontSize: Math.max(4, +e.target.value || 4) } }))} />
                  </label>
                  <label className="anim__field"><span>Weight</span>
                    <select value={selected.style.fontWeight}
                      onChange={(e) => patchLayer(selected.id, (l) => ({ ...l, style: { ...l.style, fontWeight: +e.target.value } }))}>
                      {[300, 400, 500, 600, 700, 800].map((w) => <option key={w} value={w}>{w}</option>)}
                    </select>
                  </label>
                </>
              )}

              {selected.kind === "rect" && (
                <label className="anim__field"><span>Radius</span>
                  <input type="number" min={0} max={400} value={selected.style.radius}
                    onChange={(e) => patchLayer(selected.id, (l) => ({ ...l, style: { ...l.style, radius: Math.max(0, +e.target.value || 0) } }))} />
                </label>
              )}

              {selected.kind === "image" && (
                <div className="anim__field anim__field--stack">
                  <span>Source</span>
                  <Button size="sm" variant="secondary" icon="open" onClick={() => pickImage(selected.id)}>
                    {selected.style.src ? "Replace image…" : "Choose image…"}
                  </Button>
                </div>
              )}

              <label className="anim__field"><span>Stroke</span>
                <input type="color" value={normalizeHex(selected.style.stroke)}
                  aria-label="Stroke colour"
                  onChange={(e) => patchLayer(selected.id, (l) => ({ ...l, style: { ...l.style, stroke: e.target.value } }))} />
                <input type="number" min={0} max={80} value={selected.style.strokeWidth}
                  aria-label="Stroke width"
                  onChange={(e) => patchLayer(selected.id, (l) => ({ ...l, style: { ...l.style, strokeWidth: Math.max(0, +e.target.value || 0) } }))} />
              </label>

              <div className="anim__divider" aria-hidden />

              {ANIM_PROPS.map((p) => {
                const value = sampleProp(selected, p.key, time);
                const track = selected.tracks[p.key] ?? [];
                const keyed = track.some((k) => Math.abs(k.t - snapToFrame(time, scene.fps)) < 1);
                return (
                  <div key={p.key} className="anim__propRow">
                    <button
                      type="button"
                      className={`anim__keybtn ${keyed ? "is-keyed" : ""} ${track.length ? "is-animated" : ""}`}
                      aria-label={keyed ? `Remove ${p.label} keyframe` : `Add ${p.label} keyframe`}
                      aria-pressed={keyed}
                      title={keyed ? "Remove keyframe at playhead" : "Add keyframe at playhead"}
                      onClick={() => toggleKeyAt(selected.id, p.key)}
                    >
                      <Icon name="keyframe" size={11} />
                    </button>
                    <span className="anim__proplabel">{p.label}</span>
                    {p.kind === "color" ? (
                      <input type="color" value={normalizeHex(String(value))}
                        aria-label={p.label}
                        onChange={(e) => applyProp(selected.id, p.key, e.target.value)} />
                    ) : (
                      <input type="number" min={p.min} max={p.max} step={p.step ?? 1}
                        value={roundTo(Number(value), p.step ?? 1)}
                        aria-label={p.label}
                        onChange={(e) => applyProp(selected.id, p.key, +e.target.value || 0)} />
                    )}
                  </div>
                );
              })}
            </>
          )}
        </aside>
      </div>

      {/* ---------- Timeline ---------- */}
      <div className="anim__timeline">
        <div className="anim__tlhead">
          <span className="anim__tltitle">Timeline</span>
          <span className="anim__tlhint">Drag a diamond to retime · click the ruler to scrub</span>
        </div>

        <div className="anim__tlgrid">
          <div className="anim__tlgutter">
            <div className="anim__tlrulerlabel">Layer</div>
            {scene.layers.map((l) => {
              const open = expanded.has(l.id);
              return (
                <div key={l.id} className="anim__tlgutteritem">
                  <div className={`anim__tlrowlabel ${l.id === selectedId ? "is-active" : ""}`}
                    onClick={() => setSelectedId(l.id)}>
                    <button type="button" className="anim__iconbtn"
                      aria-label={open ? `Collapse ${l.name}` : `Expand ${l.name}`}
                      aria-expanded={open}
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          if (next.has(l.id)) next.delete(l.id); else next.add(l.id);
                          return next;
                        });
                      }}>
                      <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
                    </button>
                    <span className="anim__tlname">{l.name}</span>
                  </div>
                  {open && Object.keys(l.tracks).length === 0 && (
                    <div className="anim__tlproplabel anim__tlproplabel--muted">no keyframes yet</div>
                  )}
                  {open && ANIM_PROPS.filter((p) => (l.tracks[p.key]?.length ?? 0) > 0).map((p) => (
                    <div key={p.key} className="anim__tlproplabel">{p.label}</div>
                  ))}
                </div>
              );
            })}
          </div>

          <div className="anim__tltracks">
            <div ref={rulerRef} className="anim__tlruler"
              onPointerDown={onRulerDown} onPointerMove={onRulerMove}>
              {buildTicks(scene.duration).map((tick) => (
                <span key={tick} className="anim__tick" style={{ left: `${(tick / scene.duration) * 100}%` }}>
                  {(tick / 1000).toFixed(tick % 1000 === 0 ? 0 : 1)}s
                </span>
              ))}
              <div className="anim__playhead" style={{ left: `${pct}%` }} />
            </div>

            {scene.layers.map((l) => {
              const open = expanded.has(l.id);
              const summary = layerKeyTimes(l);
              return (
                <div key={l.id} className="anim__tllayer">
                  <div className={`anim__tlrow ${l.id === selectedId ? "is-active" : ""}`}
                    onPointerMove={onTrackMove} onPointerUp={endKfDrag} onPointerLeave={endKfDrag}
                    onClick={() => setSelectedId(l.id)}>
                    {summary.map((t) => (
                      <span key={t} className="anim__kf anim__kf--summary"
                        style={{ left: `${(t / scene.duration) * 100}%` }}
                        title={`${(t / 1000).toFixed(2)}s`}
                        onClick={(e) => { e.stopPropagation(); setTime(t); }} />
                    ))}
                    <div className="anim__playline" style={{ left: `${pct}%` }} />
                  </div>

                  {open && ANIM_PROPS.filter((p) => (l.tracks[p.key]?.length ?? 0) > 0).map((p) => (
                    <div key={p.key} className="anim__tlrow anim__tlrow--prop"
                      onPointerMove={onTrackMove} onPointerUp={endKfDrag} onPointerLeave={endKfDrag}>
                      {(l.tracks[p.key] ?? []).map((k) => (
                        <span
                          key={`${p.key}-${k.t}`}
                          className={`anim__kf ${Math.abs(k.t - time) < 1 ? "is-current" : ""}`}
                          style={{ left: `${(k.t / scene.duration) * 100}%` }}
                          title={`${p.label} @ ${(k.t / 1000).toFixed(2)}s — ${k.easing}`}
                          onPointerDown={(e) => onKeyframeDown(e, l.id, p.key, k.t)}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            patchLayer(l.id, (x) => removeKeyframe(x, p.key, k.t));
                          }}
                        />
                      ))}
                      <div className="anim__playline" style={{ left: `${pct}%` }} />
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        {/* Easing for the keyframe at the playhead */}
        {selected && (
          <div className="anim__easingbar">
            <span className="anim__easinglabel">Easing at playhead</span>
            {ANIM_PROPS.filter((p) =>
              (selected.tracks[p.key] ?? []).some((k) => Math.abs(k.t - snapToFrame(time, scene.fps)) < 1),
            ).map((p) => {
              const t = snapToFrame(time, scene.fps);
              const kf = (selected.tracks[p.key] ?? []).find((k) => Math.abs(k.t - t) < 1);
              return (
                <label key={p.key} className="anim__field">
                  <span>{p.label}</span>
                  <select value={kf?.easing ?? "easeInOut"}
                    onChange={(e) => patchLayer(selected.id, (l) => setEasing(l, p.key, t, e.target.value as Easing))}>
                    {EASINGS.map((es) => <option key={es} value={es}>{es}</option>)}
                  </select>
                </label>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** Ruler ticks at a readable density for the scene length. */
function buildTicks(duration: number): number[] {
  const targets = [100, 250, 500, 1000, 2000, 5000, 10000];
  const step = targets.find((s) => duration / s <= 12) ?? 30000;
  const out: number[] = [];
  for (let t = 0; t <= duration; t += step) out.push(t);
  return out;
}

/** `<input type="color">` rejects 8-digit hex and anything non-hex. */
function normalizeHex(v: string): string {
  const m = /^#([0-9a-f]{6})/i.exec(v.trim());
  if (m) return `#${m[1]}`;
  const short = /^#([0-9a-f]{3})$/i.exec(v.trim());
  if (short) return `#${short[1].split("").map((c) => c + c).join("")}`;
  return "#000000";
}

function roundTo(v: number, step: number): number {
  const digits = step < 1 ? String(step).split(".")[1]?.length ?? 2 : 0;
  return Number(v.toFixed(digits));
}

export default AnimationBuilder;
