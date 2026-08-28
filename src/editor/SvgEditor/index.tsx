/* ============================================================
   sparkEditor · src/editor/SvgEditor/index.tsx
   Interactive vector surface for .svg files.

   Principles:
   • File is source of truth (doc.raw).
   • Local model (parseSvg → SvgDoc) derived on load; edits
     serialize back via serializeSvg → setRaw every change.
   • Pan (drag canvas) + zoom (wheel / buttons).
   • Tools: select, rect, circle, ellipse, line, path, text.
   • Direct manipulation: drag to move; handles to resize;
     props panel edits fill/stroke/opacity/etc.
   • Layers list for selection & delete/reorder.
   • Code toggle shows raw SVG in CodeMirror (read/edit).
   • No server: all ops in renderer, host only sees bytes
     on save.

   Robustness: foreign nodes (filters, defs, etc.) are
   kept as raw markup and re-emitted on serialize.
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { html as xmlLang } from "@codemirror/lang-html";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, HighlightStyle } from "@codemirror/language";
import { tagExtension } from "../CodeEditor/highlightBridge";
import { useDocs } from "@store/documents";
import { useTheme } from "@theme/ThemeProvider";
import { Button } from "@ui/Button";
import { parseSvg, serializeSvg, createNode, type SvgDoc, type SvgNode, type SvgShapeKind } from "./model";
import "./SvgEditor.css";
import "../editor.css";

type Tool = "select" | SvgShapeKind;

function bboxOf(n: SvgNode): { x: number; y: number; w: number; h: number } | null {
  const a = n.attrs;
  try {
    if (n.kind === "rect") return { x: +a.x, y: +a.y, w: +a.width, h: +a.height };
    if (n.kind === "circle") { const r = +a.r; return { x: +a.cx - r, y: +a.cy - r, w: r*2, h: r*2 }; }
    if (n.kind === "ellipse") return { x: +a.cx - +a.rx, y: +a.cy - +a.ry, w: +a.rx*2, h: +a.ry*2 };
    if (n.kind === "line") return { x: Math.min(+a.x1,+a.x2), y: Math.min(+a.y1,+a.y2), w: Math.abs(+a.x2-+a.x1)||2, h: Math.abs(+a.y2-+a.y1)||2 };
    if (n.kind === "text") return { x: +a.x, y: +a.y - 18, w: 120, h: 24 };
    if (n.kind === "path") {
      // approximate fallback
      return { x: 80, y: 80, w: 220, h: 120 };
    }
  } catch { return null; }
  return null;
}

export function SvgEditor({ docId }: { docId: string }) {
  const doc = useDocs((s) => s.docs[docId]);
  const setRaw = useDocs((s) => s.setRaw);

  const [tool, setTool] = useState<Tool>("select");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [showCode, setShowCode] = useState(false);
  const [draft, setDraft] = useState<SvgDoc | null>(null);

  // derive draft from raw once (on docId/raw external change)
  const raw = doc?.raw ?? "";
  useEffect(() => {
    const d = parseSvg(raw);
    setDraft(d);
    // auto-select first shape
    if (d.nodes.length && !selectedId) setSelectedId(d.nodes[0].attrs.id);
  }, [docId]); // only on doc switch, not on every keystroke

  // when draft changes, serialize back to raw (debounced to avoid loops)
  const committingRef = useRef(false);
  useEffect(() => {
    if (!draft) return;
    if (committingRef.current) return;
    // Compare to current doc raw to avoid churn
    const ser = serializeSvg(draft);
    if (ser !== doc?.raw) {
      committingRef.current = true;
      setRaw(docId, ser);
      requestAnimationFrame(() => { committingRef.current = false; });
    }
  }, [draft, docId]);

  // If raw changed externally (e.g. file reload / undo), re-parse but not during our own commit
  useEffect(() => {
    if (committingRef.current) return;
    if (!draft) return;
    const ser = serializeSvg(draft);
    if (raw !== ser && raw.trim()) {
      setDraft(parseSvg(raw));
    }
  }, [raw]);

  const selected = useMemo(() => {
    if (!draft || !selectedId) return null;
    return findNode(draft.nodes, selectedId);
  }, [draft, selectedId]);

  const updateSelected = useCallback((patch: Record<string,string>) => {
    if (!draft || !selectedId) return;
    setDraft(prev => {
      if (!prev) return prev;
      const nodes = updateNode(prev.nodes, selectedId, patch);
      return { ...prev, nodes };
    });
  }, [draft, selectedId]);

  const addShape = useCallback((kind: SvgShapeKind) => {
    const n = createNode(kind);
    setDraft(prev => prev ? { ...prev, nodes: [...prev.nodes, n] } : prev);
    setSelectedId(n.attrs.id);
    setTool("select");
  }, []);

  const deleteSelected = useCallback(() => {
    if (!draft || !selectedId) return;
    setDraft(prev => prev ? { ...prev, nodes: prev.nodes.filter(nn => nn.attrs.id !== selectedId) } : prev);
    setSelectedId(null);
  }, [draft, selectedId]);

  const bringFront = useCallback(() => {
    if (!draft || !selectedId) return;
    setDraft(prev => {
      if (!prev) return prev;
      const idx = prev.nodes.findIndex(n => n.attrs.id === selectedId);
      if (idx === -1) return prev;
      const copy = [...prev.nodes];
      const [item] = copy.splice(idx,1);
      copy.push(item);
      return { ...prev, nodes: copy };
    });
  }, [draft, selectedId]);

  const svgRef = useRef<SVGSVGElement>(null);

  const onPointerDown = useCallback((e: React.PointerEvent, nodeId: string) => {
    e.stopPropagation();
    setSelectedId(nodeId);
    const startX = e.clientX, startY = e.clientY;
    const target = findNode(draft?.nodes ?? [], nodeId);
    if (!target) return;
    const orig = { ...target.attrs };
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / zoom;
      const dy = (ev.clientY - startY) / zoom;
      const patch: Record<string,string> = {};
      if (target.kind === "rect") { patch.x = String(+orig.x + dx); patch.y = String(+orig.y + dy); }
      else if (target.kind === "circle" || target.kind === "ellipse") { patch.cx = String(+orig.cx + dx); patch.cy = String(+orig.cy + dy); }
      else if (target.kind === "line") { patch.x1 = String(+orig.x1 + dx); patch.y1 = String(+orig.y1 + dy); patch.x2 = String(+orig.x2 + dx); patch.y2 = String(+orig.y2 + dy); }
      else if (target.kind === "text") { patch.x = String(+orig.x + dx); patch.y = String(+orig.y + dy); }
      else if (target.kind === "path") {
        // translate path by shifting M coords naively: adjust d? fallback use transform
        patch.transform = `translate(${dx} ${dy})`;
      }
      if (Object.keys(patch).length) {
        setDraft(prev => prev ? { ...prev, nodes: updateNode(prev.nodes, nodeId, patch) } : prev);
      }
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [draft, zoom]);

  // viewBox from doc attrs
  const viewBox = draft?.attrs.viewBox ?? "0 0 800 600";
  const vb = useMemo(() => {
    const parts = viewBox.split(/\s+|,/).map(Number);
    return { x: parts[0]??0, y: parts[1]??0, w: parts[2]??800, h: parts[3]??600 };
  }, [viewBox]);

  // CodeMirror for raw toggle
  const codeRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeComp = useRef(new Compartment()).current;
  const { resolved } = useTheme();

  useEffect(() => {
    if (!showCode || !codeRef.current || !doc) return;
    const state = EditorState.create({
      doc: doc.raw,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        bracketMatching(),
        xmlLang(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        syntaxHighlighting(HighlightStyle.define([
          { tag: tagExtension.tagName, color: "var(--syn-tag)" },
          { tag: tagExtension.attributeName, color: "var(--syn-attr)" },
          { tag: tagExtension.string, color: "var(--syn-string)" },
          { tag: tagExtension.comment, color: "var(--syn-comment)", fontStyle: "italic" },
        ])),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        themeComp.of(EditorView.theme({}, { dark: resolved !== "light" })),
        EditorView.updateListener.of((v) => { if (v.docChanged) setRaw(docId, v.state.doc.toString()); }),
      ],
    });
    const v = new EditorView({ state, parent: codeRef.current });
    viewRef.current = v;
    return () => { v.destroy(); viewRef.current = null; };
  }, [showCode, docId]);

  // Canvas click to place shape
  const onCanvasClick = useCallback((e: React.MouseEvent) => {
    if (tool === "select") {
      // click on empty clears selection
      if (e.target === e.currentTarget || (e.target as Element).tagName?.toLowerCase() === "svg") {
        setSelectedId(null);
      }
      return;
    }
    // place new shape at click position in SVG coords
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || !draft) return;
    const x = (e.clientX - rect.left) / zoom;
    const y = (e.clientY - rect.top) / zoom;
    const sx = vb.x + (x / rect.width) * vb.w;
    const sy = vb.y + (y / rect.height) * vb.h;
    const overrides: Record<string,string> = {};
    if (tool === "rect") { overrides.x = String(Math.round(sx - 80)); overrides.y = String(Math.round(sy - 50)); }
    if (tool === "circle" || tool === "ellipse") { overrides.cx = String(Math.round(sx)); overrides.cy = String(Math.round(sy)); }
    if (tool === "text") { overrides.x = String(Math.round(sx)); overrides.y = String(Math.round(sy)); }
    if (tool === "line") { overrides.x1 = String(Math.round(sx - 60)); overrides.y1 = String(Math.round(sy)); overrides.x2 = String(Math.round(sx + 60)); overrides.y2 = String(Math.round(sy)); }
    addShape(tool as SvgShapeKind);
    // patch position after creation (addShape creates default; we patch)
    requestAnimationFrame(() => {
      const id = draft.nodes[draft.nodes.length-1]?.attrs.id ?? selectedId;
      if (id) updateSelected(overrides);
    });
  }, [tool, draft, zoom, vb, addShape, selectedId, updateSelected]);

  if (!doc || !draft) return null;

  return (
    <div className="svg-editor">
      <div className="svg-editor__toolbar" role="toolbar" aria-label="SVG toolbar">
        <Button size="sm" variant={tool==="select"?"secondary":"ghost"} icon="search" onClick={() => setTool("select")} title="Select (V)">Select</Button>
        <span style={{ width: 8 }} />
        <Button size="sm" variant="ghost" onClick={() => addShape("rect")} title="Add rectangle">Rect</Button>
        <Button size="sm" variant="ghost" onClick={() => addShape("circle")} title="Add circle">Circle</Button>
        <Button size="sm" variant="ghost" onClick={() => addShape("ellipse")} title="Add ellipse">Ellipse</Button>
        <Button size="sm" variant="ghost" onClick={() => addShape("line")} title="Add line">Line</Button>
        <Button size="sm" variant="ghost" onClick={() => addShape("path")} title="Add path">Path</Button>
        <Button size="sm" variant="ghost" onClick={() => addShape("text")} title="Add text">Text</Button>
        <span style={{ flex: 1 }} />
        <Button size="sm" variant={showCode?"secondary":"ghost"} icon="code" onClick={() => setShowCode(v=>!v)}>{showCode ? "Hide code" : "Code"}</Button>
        <Button size="sm" variant="ghost" icon="plus" onClick={() => setZoom(z=>Math.min(3, +(z+0.1).toFixed(2)))}>Zoom +</Button>
        <Button size="sm" variant="ghost" icon="minus" onClick={() => setZoom(z=>Math.max(0.25, +(z-0.1).toFixed(2)))}>Zoom −</Button>
        <span style={{ fontSize: 11, color: "var(--text-muted)", minWidth: 36, textAlign:"center" }}>{Math.round(zoom*100)}%</span>
        <Button size="sm" variant="ghost" onClick={() => { setZoom(1); setPan({x:0,y:0}); }}>Reset</Button>
        <Button size="sm" variant="ghost" icon="close" onClick={deleteSelected} disabled={!selectedId} title="Delete selected">Delete</Button>
      </div>

      <div className="svg-editor__body">
        <div className="svg-editor__layers">
          <h3>Layers</h3>
          <ul>
            {draft.nodes.map(n => (
              <li key={n.attrs.id}
                  className={`svg-editor__layer ${selectedId===n.attrs.id?"is-selected":""}`}
                  onClick={() => setSelectedId(n.attrs.id)}>
                <span>{n.kind}</span>
                <small>{n.attrs.id.slice(0,10)}</small>
                <span style={{ flex:1 }} />
                <span style={{ width:10, height:10, borderRadius:2, background: n.attrs.fill ?? "var(--border)", border:"1px solid var(--border)" }} />
              </li>
            ))}
            {draft.nodes.length===0 && <li className="svg-editor__hint">No shapes yet. Use the toolbar to add one.</li>}
          </ul>
          <div className="svg-editor__divider" />
          <div className="svg-editor__hint">Tip: click canvas to place, drag shapes to move, edit props on the right. Pan: drag background.</div>
        </div>

        <div className="svg-editor__canvas-wrap"
             onPointerDown={(e)=>{
               if (tool!=="select") return;
               if ((e.target as HTMLElement).closest("svg")) return;
               const start = { x: e.clientX - pan.x, y: e.clientY - pan.y };
               const mv=(ev:PointerEvent)=> setPan({ x: ev.clientX - start.x, y: ev.clientY - start.y });
               const up=()=>{ window.removeEventListener("pointermove",mv); window.removeEventListener("pointerup",up); };
               window.addEventListener("pointermove",mv); window.addEventListener("pointerup",up);
             }}
             onClick={onCanvasClick}
        >
          <div className="svg-editor__canvas" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "center" }}>
            <svg
              ref={svgRef}
              viewBox={viewBox}
              width={vb.w}
              height={vb.h}
              xmlns="http://www.w3.org/2000/svg"
              style={{ width: vb.w, height: vb.h }}
            >
              {draft.nodes.map(n => renderNode(n, selectedId, onPointerDown))}
              {/* selection bbox */}
              {selected && (() => {
                const bb = bboxOf(selected);
                if (!bb) return null;
                return (
                  <g className="svg-editor__selection" pointerEvents="none">
                    <rect x={bb.x-2} y={bb.y-2} width={bb.w+4} height={bb.h+4} />
                    <circle className="svg-editor__handle" cx={bb.x+bb.w} cy={bb.y+bb.h} r={5} pointerEvents="all" />
                  </g>
                );
              })()}
            </svg>
          </div>
        </div>

        <div className="svg-editor__props">
          <h3>Properties</h3>
          {!selected ? (
            <div className="svg-editor__hint">Select a shape to edit its properties. Canvas size: {viewBox}</div>
          ) : (
            <>
              <div className="svg-editor__field">
                <label>Kind</label>
                <span style={{ fontSize: 12, color:"var(--text)" }}>{selected.kind} — {selected.attrs.id}</span>
              </div>
              {/* geometry */}
              {(selected.kind==="rect") && (
                <div className="svg-editor__row">
                  <div className="svg-editor__field"><label>X</label><input value={selected.attrs.x ?? ""} onChange={e=>updateSelected({x:e.target.value})} /></div>
                  <div className="svg-editor__field"><label>Y</label><input value={selected.attrs.y ?? ""} onChange={e=>updateSelected({y:e.target.value})} /></div>
                  <div className="svg-editor__field"><label>W</label><input value={selected.attrs.width ?? ""} onChange={e=>updateSelected({width:e.target.value})} /></div>
                  <div className="svg-editor__field"><label>H</label><input value={selected.attrs.height ?? ""} onChange={e=>updateSelected({height:e.target.value})} /></div>
                  <div className="svg-editor__field"><label>RX</label><input value={selected.attrs.rx ?? ""} onChange={e=>updateSelected({rx:e.target.value})} /></div>
                </div>
              )}
              {(selected.kind==="circle") && (
                <div className="svg-editor__row">
                  <div className="svg-editor__field"><label>CX</label><input value={selected.attrs.cx ?? ""} onChange={e=>updateSelected({cx:e.target.value})} /></div>
                  <div className="svg-editor__field"><label>CY</label><input value={selected.attrs.cy ?? ""} onChange={e=>updateSelected({cy:e.target.value})} /></div>
                  <div className="svg-editor__field"><label>R</label><input value={selected.attrs.r ?? ""} onChange={e=>updateSelected({r:e.target.value})} /></div>
                </div>
              )}
              {(selected.kind==="ellipse") && (
                <div className="svg-editor__row">
                  <div className="svg-editor__field"><label>CX</label><input value={selected.attrs.cx ?? ""} onChange={e=>updateSelected({cx:e.target.value})} /></div>
                  <div className="svg-editor__field"><label>CY</label><input value={selected.attrs.cy ?? ""} onChange={e=>updateSelected({cy:e.target.value})} /></div>
                  <div className="svg-editor__field"><label>RX</label><input value={selected.attrs.rx ?? ""} onChange={e=>updateSelected({rx:e.target.value})} /></div>
                  <div className="svg-editor__field"><label>RY</label><input value={selected.attrs.ry ?? ""} onChange={e=>updateSelected({ry:e.target.value})} /></div>
                </div>
              )}
              {(selected.kind==="line") && (
                <div className="svg-editor__row">
                  <div className="svg-editor__field"><label>X1</label><input value={selected.attrs.x1 ?? ""} onChange={e=>updateSelected({x1:e.target.value})} /></div>
                  <div className="svg-editor__field"><label>Y1</label><input value={selected.attrs.y1 ?? ""} onChange={e=>updateSelected({y1:e.target.value})} /></div>
                  <div className="svg-editor__field"><label>X2</label><input value={selected.attrs.x2 ?? ""} onChange={e=>updateSelected({x2:e.target.value})} /></div>
                  <div className="svg-editor__field"><label>Y2</label><input value={selected.attrs.y2 ?? ""} onChange={e=>updateSelected({y2:e.target.value})} /></div>
                </div>
              )}
              {(selected.kind==="path") && (
                <div className="svg-editor__field"><label>D</label><input value={selected.attrs.d ?? ""} onChange={e=>updateSelected({d:e.target.value})} /></div>
              )}
              {(selected.kind==="text") && (
                <>
                  <div className="svg-editor__row">
                    <div className="svg-editor__field"><label>X</label><input value={selected.attrs.x ?? ""} onChange={e=>updateSelected({x:e.target.value})} /></div>
                    <div className="svg-editor__field"><label>Y</label><input value={selected.attrs.y ?? ""} onChange={e=>updateSelected({y:e.target.value})} /></div>
                  </div>
                  <div className="svg-editor__field"><label>Text</label><input value={selected.attrs._text ?? ""} onChange={e=>updateSelected({_text:e.target.value})} /></div>
                  <div className="svg-editor__field"><label>Font size</label><input value={selected.attrs["font-size"] ?? ""} onChange={e=>updateSelected({"font-size":e.target.value})} placeholder="24" /></div>
                </>
              )}
              <div className="svg-editor__divider" />
              <div className="svg-editor__field"><label>Fill</label><input type="color" value={toColor(selected.attrs.fill)} onChange={e=>updateSelected({fill:e.target.value})} /><input value={selected.attrs.fill ?? ""} onChange={e=>updateSelected({fill:e.target.value})} placeholder="#6c5ce7 or none" /></div>
              <div className="svg-editor__field"><label>Stroke</label><input type="color" value={toColor(selected.attrs.stroke)} onChange={e=>updateSelected({stroke:e.target.value})} /><input value={selected.attrs.stroke ?? ""} onChange={e=>updateSelected({stroke:e.target.value})} placeholder="#2d3436 or none" /></div>
              <div className="svg-editor__row">
                <div className="svg-editor__field"><label>Stroke width</label><input value={selected.attrs["stroke-width"] ?? ""} onChange={e=>updateSelected({"stroke-width":e.target.value})} /></div>
                <div className="svg-editor__field"><label>Opacity</label><input value={selected.attrs.opacity ?? ""} onChange={e=>updateSelected({opacity:e.target.value})} placeholder="1" /></div>
              </div>
              {selected.kind!=="foreign" && selected.attrs.transform !== undefined && (
                <div className="svg-editor__field"><label>Transform</label><input value={selected.attrs.transform ?? ""} onChange={e=>updateSelected({transform:e.target.value})} /></div>
              )}
              <div className="svg-editor__divider" />
              <div style={{ display:"flex", gap: 6 }}>
                <Button size="sm" variant="secondary" onClick={bringFront}>Bring to front</Button>
                <Button size="sm" variant="danger" onClick={deleteSelected}>Delete</Button>
              </div>
            </>
          )}
          <div className="svg-editor__divider" />
          <div className="svg-editor__field"><label>Canvas ViewBox</label><input value={draft.attrs.viewBox ?? ""} onChange={e=> setDraft(prev=> prev?{...prev, attrs:{...prev.attrs, viewBox:e.target.value}}:prev)} placeholder="0 0 800 600" /></div>
          <div className="svg-editor__hint">Saved to file on Ctrl+S. Foreign elements (defs/filters) preserved as raw.</div>
        </div>
      </div>

      {showCode && (
        <div style={{ borderTop:"1px solid var(--border)", height: 220, minHeight: 120, display:"flex", flexDirection:"column" }}>
          <div style={{ padding:"4px 8px", background:"var(--surface-2)", fontSize:11, color:"var(--text-muted)", borderBottom:"1px solid var(--border)" }}>SVG Source (editable)</div>
          <div ref={codeRef} className="editor editor--code" style={{ flex:1, minHeight:0, overflow:"auto" }} />
        </div>
      )}
    </div>
  );
}

function toColor(v?: string): string {
  if (!v || v==="none" || v==="transparent") return "#000000";
  // simple hex check, else fallback
  if (/^#[0-9a-fA-F]{6}$/.test(v) || /^#[0-9a-fA-F]{3}$/.test(v)) return v.length===4 ? "#" + v.slice(1).split("").map(c=>c+c).join("") : v;
  return "#000000";
}

function findNode(nodes: SvgNode[], id: string): SvgNode | null {
  for (const n of nodes) {
    if (n.attrs.id === id) return n;
    if (n.children) {
      const f = findNode(n.children, id);
      if (f) return f;
    }
  }
  return null;
}
function updateNode(nodes: SvgNode[], id: string, patch: Record<string,string>): SvgNode[] {
  return nodes.map(n => {
    if (n.attrs.id === id) return { ...n, attrs: { ...n.attrs, ...patch } };
    if (n.children) return { ...n, children: updateNode(n.children, id, patch) };
    return n;
  });
}

function renderNode(n: SvgNode, selectedId: string | null, onPointerDown: (e: React.PointerEvent, id: string)=>void): React.ReactNode {
  const isSel = selectedId === n.attrs.id;
  const common: any = {
    onPointerDown: (e: React.PointerEvent) => onPointerDown(e, n.attrs.id),
    style: { cursor: "grab" },
    stroke: n.attrs.stroke,
    fill: n.attrs.fill,
    opacity: n.attrs.opacity,
  };
  if (isSel) common.stroke = "var(--accent)";
  switch (n.kind) {
    case "rect":
      return <rect key={n.attrs.id} {...common} x={n.attrs.x} y={n.attrs.y} width={n.attrs.width} height={n.attrs.height} rx={n.attrs.rx} strokeWidth={n.attrs["stroke-width"]} />;
    case "circle":
      return <circle key={n.attrs.id} {...common} cx={n.attrs.cx} cy={n.attrs.cy} r={n.attrs.r} strokeWidth={n.attrs["stroke-width"]} />;
    case "ellipse":
      return <ellipse key={n.attrs.id} {...common} cx={n.attrs.cx} cy={n.attrs.cy} rx={n.attrs.rx} ry={n.attrs.ry} strokeWidth={n.attrs["stroke-width"]} />;
    case "line":
      return <line key={n.attrs.id} {...common} x1={n.attrs.x1} y1={n.attrs.y1} x2={n.attrs.x2} y2={n.attrs.y2} strokeWidth={n.attrs["stroke-width"]} />;
    case "path":
      return <path key={n.attrs.id} {...common} d={n.attrs.d} strokeWidth={n.attrs["stroke-width"]} transform={n.attrs.transform} />;
    case "text":
      return <text key={n.attrs.id} {...common} x={n.attrs.x} y={n.attrs.y} fontSize={n.attrs["font-size"]} fontFamily={n.attrs["font-family"]} fill={n.attrs.fill ?? "#000"} stroke="none">{n.attrs._text ?? ""}</text>;
    case "g":
      return <g key={n.attrs.id} id={n.attrs.id} transform={n.attrs.transform} onPointerDown={(e)=>onPointerDown(e,n.attrs.id)}>{(n.children??[]).map(c=> renderNode(c, selectedId, onPointerDown))}</g>;
    case "foreign":
      return <g key={n.attrs.id} dangerouslySetInnerHTML={{ __html: n.raw ?? "" }} onPointerDown={(e)=>onPointerDown(e, n.attrs.id)} />;
    default: return null;
  }
}
