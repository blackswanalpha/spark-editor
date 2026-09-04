/* ============================================================
   sparkBook · src/editor/PdfReader/index.tsx
   Paged PDF reader built on pdf.js.

   Shape of the thing:
   • `doc.raw` holds the file's bytes as base64; they are decoded
     once and handed straight to pdf.js. Nothing is written back —
     this surface is read-only by design.
   • Pages render lazily. A 400-page report would otherwise rasterise
     400 canvases on open; an IntersectionObserver keeps only what
     is near the viewport painted.
   • A real text layer is rendered over each page, so selection,
     copy and search work on the document's own text rather than on
     an image of it.
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useDocs } from "@store/documents";
import { Button } from "@ui/Button";
import { Icon } from "@ui/Icon";
import { base64ToBytes, base64ByteLength, formatBytes } from "@lib/binary";
import "./PdfReader.css";
import "../editor.css";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type SideMode = "none" | "thumbs" | "outline";
type ZoomMode = "fit-width" | "fit-page" | "custom";

interface OutlineNode {
  title: string;
  page: number | null;
  depth: number;
}

interface SearchHit {
  page: number;
  snippet: string;
  count: number;
}

const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export function PdfReader({ docId }: { docId: string }) {
  const doc = useDocs((s) => s.docs[docId]);
  const raw = doc?.raw ?? "";

  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [current, setCurrent] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [scale, setScale] = useState(1);
  const [zoomMode, setZoomMode] = useState<ZoomMode>("fit-width");
  const [rotation, setRotation] = useState(0);
  const [side, setSide] = useState<SideMode>("none");
  const [outline, setOutline] = useState<OutlineNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const textCacheRef = useRef<Map<number, string> | null>(null);
  const firstViewportRef = useRef<{ width: number; height: number } | null>(null);

  /* ==============================================================
     Load
     ============================================================== */
  useEffect(() => {
    let cancelled = false;
    let handle: PDFDocumentProxy | null = null;
    setLoading(true);
    setError(null);
    setPdf(null);
    setOutline([]);
    setHits(null);
    textCacheRef.current = null;
    pageRefs.current.clear();

    (async () => {
      try {
        if (!raw) throw new Error("empty");
        const bytes = base64ToBytes(raw);
        const task = pdfjs.getDocument({
          data: bytes,
          // The viewer runs offline: never reach out for a CMap or a font.
          isEvalSupported: false,
          useSystemFonts: true,
        });
        handle = await task.promise;
        if (cancelled) { await handle.destroy(); return; }
        setPdf(handle);
        setPageCount(handle.numPages);
        setCurrent(1);
        setPageInput("1");

        const first = await handle.getPage(1);
        const vp = first.getViewport({ scale: 1 });
        firstViewportRef.current = { width: vp.width, height: vp.height };

        const raw_outline = await handle.getOutline().catch(() => null);
        if (raw_outline && !cancelled) {
          setOutline(await flattenOutline(handle, raw_outline, 0));
        }
      } catch {
        if (!cancelled) {
          setError(
            raw ? "This file could not be opened as a PDF." : "The document is empty.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      // Destroying tears down the worker; leaking one per tab switch would
      // pile up background threads for the life of the session.
      handle?.destroy().catch(() => {});
    };
  }, [raw]);

  /* ==============================================================
     Zoom
     ============================================================== */
  const recomputeFit = useCallback(() => {
    const el = scrollRef.current;
    const vp = firstViewportRef.current;
    if (!el || !vp) return;
    const swapped = rotation % 180 !== 0;
    const w = swapped ? vp.height : vp.width;
    const h = swapped ? vp.width : vp.height;
    if (zoomMode === "fit-width") {
      setScale(Math.max(0.1, (el.clientWidth - 48) / w));
    } else if (zoomMode === "fit-page") {
      setScale(Math.max(0.1, Math.min((el.clientWidth - 48) / w, (el.clientHeight - 48) / h)));
    }
  }, [zoomMode, rotation]);

  useEffect(() => {
    recomputeFit();
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(recomputeFit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [recomputeFit, pdf]);

  const nudgeZoom = useCallback((dir: 1 | -1) => {
    setZoomMode("custom");
    setScale((s) => {
      const next = dir > 0
        ? ZOOM_PRESETS.find((p) => p > s + 1e-3) ?? Math.min(8, s * 1.25)
        : [...ZOOM_PRESETS].reverse().find((p) => p < s - 1e-3) ?? Math.max(0.1, s / 1.25);
      return next;
    });
  }, []);

  /* ==============================================================
     Navigation
     ============================================================== */
  const goToPage = useCallback((n: number) => {
    const target = Math.max(1, Math.min(pageCount || 1, Math.round(n)));
    const el = pageRefs.current.get(target);
    const scroller = scrollRef.current;
    if (el && scroller) {
      scroller.scrollTo({ top: el.offsetTop - 12, behavior: "smooth" });
    }
    setCurrent(target);
    setPageInput(String(target));
  }, [pageCount]);

  /* Track which page is under the top of the viewport so the counter and
     the thumbnail highlight follow the scroll. */
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !pageCount) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const mid = scroller.scrollTop + scroller.clientHeight * 0.35;
        let best = 1;
        for (const [n, el] of pageRefs.current) {
          if (el.offsetTop <= mid) best = Math.max(best, n);
        }
        setCurrent((c) => (c === best ? c : best));
        setPageInput((p) => (p === String(best) ? p : String(best)));
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [pageCount]);

  /* ==============================================================
     Search
     ============================================================== */
  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!pdf || q.length < 2) { setHits(null); return; }
    setSearching(true);
    try {
      if (!textCacheRef.current) {
        // Extracting every page's text is the expensive part; do it once
        // per document and reuse it for later queries.
        const cache = new Map<number, string>();
        for (let n = 1; n <= pdf.numPages; n++) {
          const page = await pdf.getPage(n);
          const content = await page.getTextContent();
          cache.set(n, content.items.map((i) => ("str" in i ? i.str : "")).join(" "));
        }
        textCacheRef.current = cache;
      }
      const needle = q.toLowerCase();
      const found: SearchHit[] = [];
      for (const [n, text] of textCacheRef.current) {
        const hay = text.toLowerCase();
        let count = 0;
        let at = hay.indexOf(needle);
        const firstAt = at;
        while (at !== -1) { count++; at = hay.indexOf(needle, at + needle.length); }
        if (count > 0) {
          const from = Math.max(0, firstAt - 40);
          found.push({
            page: n,
            count,
            snippet: `${from > 0 ? "…" : ""}${text.slice(from, firstAt + needle.length + 60).trim()}…`,
          });
        }
      }
      setHits(found);
      if (found.length) goToPage(found[0].page);
    } finally {
      setSearching(false);
    }
  }, [pdf, query, goToPage]);

  const totalMatches = useMemo(
    () => (hits ? hits.reduce((n, h) => n + h.count, 0) : 0),
    [hits],
  );

  /* ==============================================================
     Keyboard
     ============================================================== */
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT") return;
    if (e.ctrlKey || e.metaKey) {
      if (e.key === "=" || e.key === "+") { e.preventDefault(); nudgeZoom(1); }
      else if (e.key === "-") { e.preventDefault(); nudgeZoom(-1); }
      else if (e.key === "0") { e.preventDefault(); setZoomMode("custom"); setScale(1); }
      return;
    }
    if (e.key === "PageDown" || e.key === "n") { e.preventDefault(); goToPage(current + 1); }
    else if (e.key === "PageUp" || e.key === "p") { e.preventDefault(); goToPage(current - 1); }
    else if (e.key === "Home") { e.preventDefault(); goToPage(1); }
    else if (e.key === "End") { e.preventDefault(); goToPage(pageCount); }
  }, [current, pageCount, goToPage, nudgeZoom]);

  if (!doc) return null;

  return (
    <div className="pdfv" tabIndex={0} onKeyDown={onKeyDown}>
      {/* ---------- Toolbar ---------- */}
      <div className="pdfv__toolbar">
        <div className="pdfv__group">
          <Button size="sm" variant={side === "thumbs" ? "primary" : "ghost"} icon="grid"
            aria-label="Thumbnails" aria-pressed={side === "thumbs"} title="Page thumbnails"
            onClick={() => setSide((s) => (s === "thumbs" ? "none" : "thumbs"))} />
          <Button size="sm" variant={side === "outline" ? "primary" : "ghost"} icon="list-ul"
            aria-label="Outline" aria-pressed={side === "outline"} title="Document outline"
            onClick={() => setSide((s) => (s === "outline" ? "none" : "outline"))}
            disabled={outline.length === 0} />
        </div>

        <div className="pdfv__sep" aria-hidden />

        <div className="pdfv__group">
          <Button size="sm" variant="ghost" icon="chevron-up" aria-label="Previous page"
            title="Previous page (PageUp)" onClick={() => goToPage(current - 1)} disabled={current <= 1} />
          <input
            className="pdfv__pageinput"
            aria-label="Page number"
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value.replace(/[^\d]/g, ""))}
            onKeyDown={(e) => { if (e.key === "Enter") goToPage(+pageInput || 1); }}
            onBlur={() => setPageInput(String(current))}
          />
          <span className="pdfv__count">/ {pageCount || "—"}</span>
          <Button size="sm" variant="ghost" icon="chevron-down" aria-label="Next page"
            title="Next page (PageDown)" onClick={() => goToPage(current + 1)} disabled={current >= pageCount} />
        </div>

        <div className="pdfv__sep" aria-hidden />

        <div className="pdfv__group">
          <Button size="sm" variant="ghost" icon="minus" aria-label="Zoom out" onClick={() => nudgeZoom(-1)} />
          <span className="pdfv__zoom">{Math.round(scale * 100)}%</span>
          <Button size="sm" variant="ghost" icon="plus" aria-label="Zoom in" onClick={() => nudgeZoom(1)} />
          <Button size="sm" variant={zoomMode === "fit-width" ? "primary" : "ghost"}
            onClick={() => setZoomMode("fit-width")} title="Fit page width">Width</Button>
          <Button size="sm" variant={zoomMode === "fit-page" ? "primary" : "ghost"}
            onClick={() => setZoomMode("fit-page")} title="Fit whole page">Page</Button>
          <Button size="sm" variant="ghost" icon="redo" aria-label="Rotate"
            title="Rotate 90°" onClick={() => setRotation((r) => (r + 90) % 360)} />
        </div>

        <div className="pdfv__spacer" aria-hidden />

        <div className="pdfv__search">
          <Icon name="search" size={13} />
          <input
            aria-label="Search the document"
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void runSearch(); }}
          />
          {hits && (
            <span className="pdfv__hitcount">
              {totalMatches} in {hits.length} page{hits.length === 1 ? "" : "s"}
            </span>
          )}
          <Button size="sm" variant="secondary" loading={searching} onClick={() => void runSearch()}>Find</Button>
        </div>
      </div>

      {/* ---------- Body ---------- */}
      <div className="pdfv__body" data-side={side}>
        {side !== "none" && (
          <aside className="pdfv__side">
            {side === "thumbs" && pdf && (
              <ul className="pdfv__thumbs">
                {Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => (
                  <li key={n}>
                    <button
                      type="button"
                      className={`pdfv__thumb ${n === current ? "is-active" : ""}`}
                      onClick={() => goToPage(n)}
                      aria-label={`Go to page ${n}`}
                      aria-current={n === current}
                    >
                      <Thumbnail pdf={pdf} pageNumber={n} rotation={rotation} />
                      <span>{n}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {side === "outline" && (
              <ul className="pdfv__outline">
                {outline.map((node, i) => (
                  <li key={`${node.title}-${i}`} style={{ paddingLeft: 8 + node.depth * 12 }}>
                    <button type="button" disabled={node.page == null}
                      onClick={() => node.page != null && goToPage(node.page)}>
                      {node.title || "Untitled"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        )}

        <div ref={scrollRef} className="pdfv__scroll">
          {loading && <div className="pdfv__state">Opening document…</div>}
          {error && (
            <div className="pdfv__state pdfv__state--error">
              <Icon name="alert" size={20} />
              <p>{error}</p>
            </div>
          )}
          {pdf && Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => (
            <PdfPage
              key={n}
              pdf={pdf}
              pageNumber={n}
              scale={scale}
              rotation={rotation}
              scrollRef={scrollRef}
              highlight={query.trim().length >= 2 && !!hits?.some((h) => h.page === n) ? query.trim() : ""}
              pageRefs={pageRefs}
            />
          ))}

          {hits && hits.length > 0 && (
            <div className="pdfv__results">
              <h4>Matches</h4>
              <ul>
                {hits.map((h) => (
                  <li key={h.page}>
                    <button type="button" onClick={() => goToPage(h.page)}>
                      <b>p.{h.page}</b> <span>{h.snippet}</span>
                      {h.count > 1 && <em>×{h.count}</em>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {hits && hits.length === 0 && (
            <div className="pdfv__state">No matches for “{query.trim()}”.</div>
          )}
        </div>
      </div>

      {/* ---------- Status ---------- */}
      <div className="pdfv__status">
        <span>Page {current} of {pageCount || "—"}</span>
        <span className="pdfv__dot" aria-hidden>·</span>
        <span>{formatBytes(base64ByteLength(raw))}</span>
        <span className="pdfv__spacer" aria-hidden />
        <span className="pdfv__hint">PageUp/PageDown to page · Ctrl +/− to zoom · text is selectable</span>
      </div>
    </div>
  );
}

/* ==================================================================
   One page: canvas + selectable text layer, rendered when near view
   ================================================================== */
function PdfPage({
  pdf, pageNumber, scale, rotation, scrollRef, highlight, pageRefs,
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  rotation: number;
  scrollRef: React.RefObject<HTMLDivElement>;
  highlight: string;
  /* The shared page map, not a callback: an inline `register` prop would
     change identity on every parent render — which happens on every scroll
     tick — and tear down this page's IntersectionObserver each time. */
  pageRefs: React.MutableRefObject<Map<number, HTMLDivElement>>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const taskRef = useRef<RenderTask | null>(null);
  const [near, setNear] = useState(false);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  /* Placeholder geometry so the scrollbar is correct before a page paints. */
  useEffect(() => {
    let cancelled = false;
    pdf.getPage(pageNumber).then((page: PDFPageProxy) => {
      if (cancelled) return;
      const vp = page.getViewport({ scale, rotation });
      setSize({ w: vp.width, h: vp.height });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [pdf, pageNumber, scale, rotation]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const map = pageRefs.current;
    map.set(pageNumber, el);
    const io = new IntersectionObserver(
      (entries) => setNear(entries.some((e) => e.isIntersecting)),
      // A generous margin means a page is ready by the time it is scrolled to.
      { root: scrollRef.current, rootMargin: "800px 0px" },
    );
    io.observe(el);
    return () => { io.disconnect(); map.delete(pageNumber); };
  }, [pageNumber, pageRefs, scrollRef]);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;

    (async () => {
      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;
      const viewport = page.getViewport({ scale, rotation });
      const canvas = canvasRef.current;
      const textEl = textRef.current;
      if (!canvas) return;

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      taskRef.current?.cancel();
      const task = page.render({
        canvasContext: ctx,
        viewport,
        transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
      } as Parameters<PDFPageProxy["render"]>[0]);
      taskRef.current = task;
      try {
        await task.promise;
      } catch {
        return;   // superseded by a newer scale/rotation, or unmounted
      }
      if (cancelled || !textEl) return;

      // pdf.js positions text spans with calc(var(--scale-factor) * …).
      textEl.replaceChildren();
      textEl.style.setProperty("--scale-factor", String(scale));
      const content = await page.getTextContent();
      if (cancelled) return;
      const layer = new pdfjs.TextLayer({
        textContentSource: content,
        container: textEl,
        viewport,
      });
      await layer.render();
      if (cancelled) return;
      if (highlight) applyHighlight(textEl, highlight);
    })();

    return () => { cancelled = true; taskRef.current?.cancel(); };
  }, [pdf, pageNumber, scale, rotation, near, highlight]);

  return (
    <div
      ref={rootRef}
      className="pdfv__page"
      data-page={pageNumber}
      style={size ? { width: size.w, height: size.h } : undefined}
    >
      <canvas ref={canvasRef} className="pdfv__canvas" />
      <div ref={textRef} className="textLayer" />
      {!near && <div className="pdfv__pagehint">Page {pageNumber}</div>}
    </div>
  );
}

/* ==================================================================
   Thumbnail
   ================================================================== */
function Thumbnail({ pdf, pageNumber, rotation }: { pdf: PDFDocumentProxy; pageNumber: number; rotation: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    let task: RenderTask | null = null;
    (async () => {
      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1, rotation });
      const viewport = page.getViewport({ scale: 118 / base.width, rotation });
      const canvas = ref.current;
      if (!canvas) return;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      task = page.render({ canvasContext: ctx, viewport } as Parameters<PDFPageProxy["render"]>[0]);
      await task.promise.catch(() => {});
    })();
    return () => { cancelled = true; task?.cancel(); };
  }, [pdf, pageNumber, rotation]);
  return <canvas ref={ref} />;
}

/* ==================================================================
   Helpers
   ================================================================== */

/** Mark every text span containing `needle`, so a search result is
    visible on the page and not only in the results list. */
function applyHighlight(container: HTMLElement, needle: string) {
  const q = needle.toLowerCase();
  for (const span of Array.from(container.querySelectorAll("span"))) {
    span.classList.toggle("is-hit", (span.textContent ?? "").toLowerCase().includes(q));
  }
}

/** Flatten pdf.js's nested outline into rows with a resolved page number. */
async function flattenOutline(
  pdf: PDFDocumentProxy,
  items: Array<{ title: string; dest: unknown; items?: unknown[] }>,
  depth: number,
): Promise<OutlineNode[]> {
  const out: OutlineNode[] = [];
  for (const item of items) {
    let page: number | null = null;
    try {
      const dest = typeof item.dest === "string" ? await pdf.getDestination(item.dest) : item.dest;
      if (Array.isArray(dest) && dest[0]) {
        page = (await pdf.getPageIndex(dest[0] as never)) + 1;
      }
    } catch {
      page = null;   // a broken destination should not hide the whole outline
    }
    out.push({ title: item.title, page, depth });
    if (Array.isArray(item.items) && item.items.length) {
      out.push(...(await flattenOutline(pdf, item.items as never, depth + 1)));
    }
  }
  return out;
}

export default PdfReader;
