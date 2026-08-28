/* ============================================================
   sparkEditor · src/editor/SvgEditor/model.ts
   Minimal SVG model used by the interactive surface.  The
   model is lossless with respect to `raw` only for the
   subset we manage (rect, circle, ellipse, line, path,
   text, g).  Everything else is preserved via `foreign`
   node pass-through when we parse/serialize.
   ============================================================ */
export type SvgShapeKind = "rect" | "circle" | "ellipse" | "line" | "path" | "text" | "g";
export interface SvgNode {
  id: string;
  kind: SvgShapeKind | "foreign";
  attrs: Record<string, string>;
  children?: SvgNode[];
  /** raw markup for foreign nodes */
  raw?: string;
}

export interface SvgDoc {
  attrs: Record<string, string>; // on <svg>
  nodes: SvgNode[];
}

function genId(prefix = "n"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

export function parseSvg(raw: string): SvgDoc {
  const parser = new DOMParser();
  const doc = parser.parseFromString(raw, "image/svg+xml");
  const el = doc.documentElement;
  if (!el || el.tagName.toLowerCase() !== "svg") {
    // Not an svg - return empty wrapper
    return { attrs: { viewBox: "0 0 800 600", xmlns: "http://www.w3.org/2000/svg" }, nodes: [] };
  }
  const attrs: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;
  if (!attrs.viewBox) attrs.viewBox = "0 0 800 600";
  if (!attrs.xmlns) attrs.xmlns = "http://www.w3.org/2000/svg";

  const nodes: SvgNode[] = [];
  for (const ch of Array.from(el.children)) {
    nodes.push(parseEl(ch as Element));
  }
  return { attrs, nodes };
}

function parseEl(el: Element): SvgNode {
  const tag = el.tagName.toLowerCase();
  const kindSet = new Set(["rect","circle","ellipse","line","path","text","g"]);
  const kind: SvgNode["kind"] = kindSet.has(tag) ? (tag as SvgShapeKind) : "foreign";
  const attrs: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;
  if (!attrs.id) attrs.id = genId(tag);
  if (kind === "foreign") {
    return { id: attrs.id, kind, attrs, raw: el.outerHTML };
  }
  const children: SvgNode[] | undefined = kind === "g" || kind === "text"
    ? Array.from(el.children).map(c => parseEl(c as Element))
    : undefined;
  // preserve textContent for <text>
  if (kind === "text" && !children?.length && el.textContent) {
    attrs["_text"] = el.textContent;
  }
  return { id: attrs.id, kind, attrs, children };
}

export function serializeSvg(doc: SvgDoc): string {
  const attrStr = Object.entries(doc.attrs).map(([k,v]) => `${k}="${esc(v)}"`).join(" ");
  const inner = doc.nodes.map(serNode).join("\n  ");
  return `<svg ${attrStr}>\n  ${inner}\n</svg>\n`;
}

function serNode(n: SvgNode): string {
  if (n.kind === "foreign" && n.raw) return n.raw;
  const filtered = { ...n.attrs };
  let textContent: string | null = null;
  if (n.kind === "text" && filtered["_text"] !== undefined) {
    textContent = filtered["_text"];
    delete filtered["_text"];
  }
  const attrStr = Object.entries(filtered).map(([k,v]) => `${k}="${esc(v)}"`).join(" ");
  if (n.kind === "g") {
    const ch = (n.children ?? []).map(serNode).join("\n    ");
    return `<g ${attrStr}>${ch ? "\n    " + ch + "\n  " : ""}</g>`;
  }
  if (n.kind === "text") {
    const body = textContent != null ? escText(textContent) : (n.children ?? []).map(serNode).join("");
    return `<text ${attrStr}>${body}</text>`;
  }
  // void-ish shapes self-close
  return `<${n.kind} ${attrStr} />`;
}

function esc(s: string): string {
  return s.replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
function escText(s: string): string {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

export function createNode(kind: SvgShapeKind, overrides: Record<string,string> = {}): SvgNode {
  const id = genId(kind);
  const base: Record<string,string> = { id, fill: "#6c5ce7", stroke: "#2d3436", "stroke-width": "2" };
  switch (kind) {
    case "rect": return { id, kind, attrs: { ...base, x: "100", y: "100", width: "160", height: "100", rx: "8", ...overrides } };
    case "circle": return { id, kind, attrs: { ...base, cx: "200", cy: "200", r: "60", ...overrides } };
    case "ellipse": return { id, kind, attrs: { ...base, cx: "200", cy: "200", rx: "80", ry: "50", ...overrides } };
    case "line": return { id, kind, attrs: { id, stroke: "#2d3436", "stroke-width": "2", x1: "100", y1: "100", x2: "300", y2: "200", ...overrides } };
    case "path": return { id, kind, attrs: { ...base, d: "M 100 180 C 150 80, 250 80, 300 180", fill: "none", ...overrides } };
    case "text": return { id, kind, attrs: { id, x: "120", y: "200", fill: "#2d3436", "font-size": "24", "font-family": "Inter, sans-serif", _text: "Hello SVG", ...overrides } };
    case "g": return { id, kind, attrs: { id, ...overrides }, children: [] };
    default: return { id, kind, attrs: { id, ...overrides } };
  }
}
