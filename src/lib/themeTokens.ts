/* ============================================================
   sparkEditor · src/lib/themeTokens.ts
   Bridge from the editor's CSS theme tokens to Shiki themes.
   Keeping these in sync with src/theme/tokens.css is the
   design contract for the three themes.
   ============================================================ */
import type { ThemeRegistration } from "shiki";

function buildTheme(name: string, bg: string, fg: string, c: Record<string, string>): ThemeRegistration {
  return {
    name,
    type: name === "light" ? "light" as const : "dark" as const,
    bg,
    fg,
    colors: c,
    tokenColors: [
      { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: c.comment, fontStyle: "italic" } },
      { scope: ["keyword", "storage.type", "storage.modifier"], settings: { foreground: c.keyword } },
      { scope: ["string", "string.quoted", "string.template"], settings: { foreground: c.string } },
      { scope: ["constant.numeric", "constant.language"], settings: { foreground: c.number } },
      { scope: ["entity.name.function", "support.function"], settings: { foreground: c.func } },
      { scope: ["entity.name.tag", "punctuation.definition.tag"], settings: { foreground: c.tag } },
      { scope: ["entity.name.type", "support.type", "support.class"], settings: { foreground: c.type } },
      { scope: ["entity.other.attribute-name"], settings: { foreground: c.attr } },
      { scope: ["variable.regexp"], settings: { foreground: c.regex } },
    ],
  } as ThemeRegistration;
}

export const themeTokens = {
  light: buildTheme("spark-light", "#ffffff", "#24292f", {
    comment: "#8b93a1", keyword: "#a626a4", string: "#1a7f37", number: "#b25e09",
    func: "#2f6bde", tag: "#c62828", type: "#1f4a9c", attr: "#6f4e37", regex: "#b25e09",
  }),
  dark: buildTheme("spark-dark", "#1c2027", "#e6e9ee", {
    comment: "#6c7686", keyword: "#d2a8ff", string: "#7ee787", number: "#ffb86b",
    func: "#79c0ff", tag: "#ff7b72", type: "#ffa657", attr: "#b392f0", regex: "#f97583",
  }),
  navy: buildTheme("spark-navy", "#0f1d33", "#eaf2ff", {
    comment: "#6c84a8", keyword: "#c792ea", string: "#c3e88d", number: "#f78c6c",
    func: "#82aaff", tag: "#ff5370", type: "#ffcb6b", attr: "#c792ea", regex: "#f78c6c",
  }),
};
