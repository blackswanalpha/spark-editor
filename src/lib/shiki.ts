/* ============================================================
   sparkBook · src/lib/shiki.ts
   Shiki-based code highlighter. Loaded lazily to keep the
   initial bundle small; the highlight API uses a singleton
   highlighter so subsequent calls are sync.
   ============================================================ */
import { createHighlighter, type Highlighter, type BundledLanguage, type BundledTheme } from "shiki";
import { themeTokens } from "./themeTokens";
import { LANG_SHIKI, LANG_FILE_EXTRA } from "@editor/CodeEditor/languages";

let highlighter: Highlighter | null = null;
let initPromise: Promise<Highlighter> | null = null;

const LANGS: BundledLanguage[] = Array.from(new Set(Object.values(LANG_SHIKI))) as BundledLanguage[];

export async function getHighlighter(): Promise<Highlighter> {
  if (highlighter) return highlighter;
  if (!initPromise) {
    initPromise = createHighlighter({
      themes: [themeTokens.light, themeTokens.dark, themeTokens.navy, themeTokens.amber, themeTokens.red] as unknown as BundledTheme[],
      langs: LANGS,
    }).then((h) => { highlighter = h; return h; });
  }
  return initPromise;
}

export function getHighlighterSync(): Highlighter | null {
  return highlighter;
}

const SHIKI_VALUES = new Set<string>(Object.values(LANG_SHIKI));

export function resolveLang(name?: string): string {
  if (!name) return "txt";
  const k = name.toLowerCase();
  // 1) alias
  const aliased = LANG_FILE_EXTRA[k];
  if (aliased && LANG_SHIKI[aliased]) return LANG_SHIKI[aliased];
  // 2) direct
  if (SHIKI_VALUES.has(k)) return k;
  return "txt";
}

export interface HighlightResult { html: string; bg: string; fg: string }

export type HighlightThemeId = "light" | "dark" | "navy" | "amber" | "red";

export async function highlight(code: string, lang?: string, theme: HighlightThemeId = "dark"): Promise<HighlightResult> {
  const h = await getHighlighter();
  const t =
    theme === "light" ? themeTokens.light :
    theme === "navy" ? themeTokens.navy :
    theme === "amber" ? themeTokens.amber :
    theme === "red" ? themeTokens.red :
    themeTokens.dark;
  const result = h.codeToHtml(code, { lang: resolveLang(lang) as BundledLanguage, theme: t as unknown as BundledTheme });
  // Extract the wrapper's background/foreground for inline placement
  const tmp = document.createElement("div");
  tmp.innerHTML = result;
  const pre = tmp.querySelector("pre");
  const bg = pre?.getAttribute("style")?.match(/background-color:\s*([^;]+)/)?.[1]?.trim() || "";
  return { html: result, bg, fg: "" };
}
