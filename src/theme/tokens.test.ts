/* sparkEditor · src/theme/tokens.test.ts

   Contrast contract for the five palettes. tokens.css is the source of
   truth; this test parses it and holds every foreground/background pair
   the UI actually renders to WCAG 2.2 AA.

   It exists because the palettes drifted silently: amber shipped white
   text on #d97706 (3.19:1), --text-faint sat under 4.5:1 in three
   themes, and every syntax comment matched --text-faint exactly. None
   of that was visible from reading a diff of hex values. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The suite runs in jsdom, where import.meta.url is an http URL, so the
// file is resolved from the vitest root instead.
const css = readFileSync(resolve(process.cwd(), "src/theme/tokens.css"), "utf8");

type Palette = Record<string, string>;

/** Pull every `--name: #hex` out of each theme's rule block. */
function parseThemes(source: string): Record<string, Palette> {
  const out: Record<string, Palette> = {};
  const blocks = /:root(?:,\s*:root)?(?:\[data-theme="([a-z]+)"\])?[^{]*\{([\s\S]*?)\n\s*\}/g;
  for (const m of source.matchAll(blocks)) {
    const vars: Palette = {};
    for (const v of m[2].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,6})\b/g)) vars[v[1]] = v[2];
    if (Object.keys(vars).length < 10) continue; // the shared/derived blocks
    const name = m[1] ?? "light";
    out[name] = { ...(out[name] ?? {}), ...vars };
  }
  return out;
}

function channels(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance(hex: string): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = channels(hex).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Euclidean RGB distance — a blunt "can you tell these apart" check. */
function distance(a: string, b: string): number {
  const [x, y] = [channels(a), channels(b)];
  return Math.sqrt(x.reduce((s, v, i) => s + (v - y[i]) ** 2, 0));
}

const themes = parseThemes(css);
const NAMES = ["light", "dark", "navy", "amber", "red"] as const;
const SYNTAX = ["keyword", "string", "number", "comment", "func", "tag", "type", "regex", "attr"] as const;

describe("theme tokens", () => {
  it("defines every named theme", () => {
    expect(Object.keys(themes).sort()).toEqual(
      expect.arrayContaining([...NAMES, "system"].sort()),
    );
  });

  describe.each(NAMES)("%s", (name) => {
    const p = () => themes[name];

    it("gives every theme the same token set as light", () => {
      const missing = Object.keys(themes.light).filter((k) => !(k in p()));
      expect(missing).toEqual([]);
    });

    it.each(["surface-1", "surface-2", "surface-3", "surface-4", "bg"])(
      "body text clears 7:1 on --%s",
      (bg) => expect(contrast(p().text, p()[bg])).toBeGreaterThanOrEqual(7),
    );

    it.each(["surface-1", "surface-2", "surface-3", "bg"])(
      "muted text clears 4.5:1 on --%s",
      (bg) => expect(contrast(p()["text-muted"], p()[bg])).toBeGreaterThanOrEqual(4.5),
    );

    // --text-faint reads as real text in 48 rules (hints, empty states,
    // the status bar), not as decoration, so it takes the text threshold.
    it.each(["surface-1", "surface-2", "bg"])(
      "faint text clears 4.5:1 on --%s",
      (bg) => expect(contrast(p()["text-faint"], p()[bg])).toBeGreaterThanOrEqual(4.5),
    );

    // The accent is both a fill and a text colour, and contrast is
    // symmetric, so one value has to satisfy both directions.
    it.each(["surface-1", "surface-2", "surface-3", "bg", "accent-soft"])(
      "accent clears 4.5:1 on --%s",
      (bg) => expect(contrast(p().accent, p()[bg])).toBeGreaterThanOrEqual(4.5),
    );

    it.each(["accent", "accent-hover", "accent-active"])(
      "--accent-fg clears 4.5:1 on --%s",
      (bg) => expect(contrast(p()["accent-fg"], p()[bg])).toBeGreaterThanOrEqual(4.5),
    );

    it("--on-accent clears 4.5:1 on the accent", () => {
      expect(contrast(p()["on-accent"], p().accent)).toBeGreaterThanOrEqual(4.5);
    });

    it.each(["success", "warning", "danger", "info"])(
      "--%s clears 4.5:1 on surface-1 and bg",
      (k) => {
        expect(contrast(p()[k], p()["surface-1"])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(p()[k], p().bg)).toBeGreaterThanOrEqual(4.5);
      },
    );

    it.each(SYNTAX)("--syn-%s clears 4.5:1 on the editor sheet", (k) => {
      expect(contrast(p()[`syn-${k}`], p()["surface-1"])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p()[`syn-${k}`], p()["surface-2"])).toBeGreaterThanOrEqual(4.5);
    });

    // --border is the decorative hairline and is exempt from 1.4.11;
    // --border-strong is what a control boundary must use.
    it("--border-strong clears 3:1 as a control boundary", () => {
      expect(contrast(p()["border-strong"], p()["surface-1"])).toBeGreaterThanOrEqual(3);
      expect(contrast(p()["border-strong"], p().bg)).toBeGreaterThanOrEqual(3);
    });

    it("keeps the terminal legible on its own ground", () => {
      expect(contrast(p()["term-fg"], p()["term-bg"])).toBeGreaterThanOrEqual(7);
      expect(contrast(p()["term-cursor"], p()["term-bg"])).toBeGreaterThanOrEqual(3);
    });

    it("keeps the syntax roles distinguishable from each other", () => {
      const clashes: string[] = [];
      for (let i = 0; i < SYNTAX.length; i++) {
        for (let j = i + 1; j < SYNTAX.length; j++) {
          const d = distance(p()[`syn-${SYNTAX[i]}`], p()[`syn-${SYNTAX[j]}`]);
          if (d < 35) clashes.push(`${SYNTAX[i]}~${SYNTAX[j]} (Δ${Math.round(d)})`);
        }
      }
      expect(clashes).toEqual([]);
    });

    it("keeps the surface ramp monotonic", () => {
      const ramp = ["surface-1", "surface-2", "surface-3", "surface-4"].map((k) => luminance(p()[k]));
      const dir = ramp[1] > ramp[0] ? 1 : -1;
      for (let i = 1; i < ramp.length; i++) {
        expect(Math.sign(ramp[i] - ramp[i - 1])).toBe(dir);
      }
    });
  });
});
