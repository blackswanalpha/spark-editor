/* ============================================================
   sparkBook · src/shell/Terminal/useCellMetrics.ts

   Measures one monospace cell so the grid can convert pixels to
   rows/cols. Measuring beats hard-coding: the user's font stack,
   the OS's font rendering and the app's zoom all move these
   numbers, and a wrong cell size shows up as a shell that thinks
   the window is a different width than it looks.
   ============================================================ */
import { useEffect, useState } from "react";

export interface CellMetrics {
  width: number;
  height: number;
}

const FALLBACK: CellMetrics = { width: 8, height: 17 };

/**
 * Measure the advance width and line height of `fontFamily` at
 * `fontSize`/`lineHeight`, using a detached probe element.
 *
 * The probe measures 100 characters and divides, so sub-pixel advance
 * widths (common with variable fonts) do not accumulate error across a
 * wide row.
 */
export function measureCell(
  fontFamily: string,
  fontSize: number,
  lineHeight: number,
  host?: Document,
): CellMetrics {
  const doc = host ?? document;
  if (!doc?.body) return FALLBACK;

  const probe = doc.createElement("div");
  probe.style.cssText = [
    "position:absolute",
    "visibility:hidden",
    "pointer-events:none",
    "top:-9999px",
    "left:-9999px",
    "white-space:pre",
    `font-family:${fontFamily}`,
    `font-size:${fontSize}px`,
    `line-height:${lineHeight}`,
    "font-variant-ligatures:none",
    "font-kerning:none",
  ].join(";");
  probe.textContent = "0".repeat(100);

  doc.body.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  doc.body.removeChild(probe);

  const width = rect.width / 100;
  const height = rect.height;
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    return FALLBACK;
  }
  return { width, height };
}

/**
 * Cell metrics that re-measure once webfonts finish loading — the first
 * measurement usually lands on the fallback font, which is a different
 * width and would leave the grid mis-sized until the next resize.
 */
export function useCellMetrics(fontFamily: string, fontSize: number, lineHeight: number): CellMetrics {
  const [metrics, setMetrics] = useState<CellMetrics>(() =>
    measureCell(fontFamily, fontSize, lineHeight),
  );

  useEffect(() => {
    let cancelled = false;
    const remeasure = () => {
      if (cancelled) return;
      const next = measureCell(fontFamily, fontSize, lineHeight);
      setMetrics((prev) =>
        Math.abs(prev.width - next.width) < 0.01 && Math.abs(prev.height - next.height) < 0.01
          ? prev
          : next,
      );
    };

    remeasure();
    // document.fonts is absent in older webviews and in jsdom.
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    fonts?.ready?.then(remeasure).catch(() => {});
    window.addEventListener("resize", remeasure);
    return () => {
      cancelled = true;
      window.removeEventListener("resize", remeasure);
    };
  }, [fontFamily, fontSize, lineHeight]);

  return metrics;
}
