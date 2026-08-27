/* ============================================================
   sparkEditor · src/lib/shiki.ts
   Shiki-based code highlighter. Loaded lazily to keep the
   initial bundle small; the highlight API uses a singleton
   highlighter so subsequent calls are sync.
   ============================================================ */
import { createHighlighter, type Highlighter, type BundledLanguage, type BundledTheme } from "shiki";
import { themeTokens } from "./themeTokens";

let highlighter: Highlighter | null = null;
let initPromise: Promise<Highlighter> | null = null;

const LANGS: BundledLanguage[] = [
  "ts", "tsx", "js", "jsx", "json", "html", "css", "scss",
  "python", "rust", "go", "java", "c", "cpp", "bash", "yaml", "toml", "sql", "md",
];

export async function getHighlighter(): Promise<Highlighter> {
  if (highlighter) return highlighter;
  if (!initPromise) {
    initPromise = createHighlighter({
      themes: [themeTokens.light, themeTokens.dark, themeTokens.navy] as unknown as BundledTheme[],
      langs: LANGS,
    }).then((h) => { highlighter = h; return h; });
  }
  return initPromise;
}

export function getHighlighterSync(): Highlighter | null {
  return highlighter;
}

const LANG_ALIAS: Record<string, string> = {
  typescript: "ts", javascript: "js", py: "python", rs: "rust", sh: "bash", yml: "yaml", md: "md", markdown: "md",
};

export function resolveLang(name?: string): string {
  if (!name) return "txt";
  const k = name.toLowerCase();
  return LANG_ALIAS[k] ?? (LANGS as readonly string[]).includes(k) ? k : "txt";
}

export interface HighlightResult { html: string; bg: string; fg: string }

export async function highlight(code: string, lang?: string, theme: "light" | "dark" | "navy" = "dark"): Promise<HighlightResult> {
  const h = await getHighlighter();
  const t = theme === "light" ? themeTokens.light : theme === "navy" ? themeTokens.navy : themeTokens.dark;
  const result = h.codeToHtml(code, { lang: resolveLang(lang) as BundledLanguage, theme: t as unknown as BundledTheme });
  // Extract the wrapper's background/foreground for inline placement
  const tmp = document.createElement("div");
  tmp.innerHTML = result;
  const pre = tmp.querySelector("pre");
  const bg = pre?.getAttribute("style")?.match(/background-color:\s*([^;]+)/)?.[1]?.trim() || "";
  return { html: result, bg, fg: "" };
}
