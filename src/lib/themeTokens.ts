/* ============================================================
   sparkBook · src/lib/themeTokens.ts
   Bridge from the editor's CSS theme tokens to Shiki themes.
   Keeping these in sync with src/theme/tokens.css is the
   design contract for the five themes. Values below are generated
   from the same audited palette; change tokens.css first.
   ============================================================ */
import type { ThemeRegistration } from "shiki";

/** Themes whose ground is light. Kept beside isDarkTheme() in
    ThemeProvider — both answer the same question for their own consumer. */
const LIGHT_THEMES = new Set(["spark-light", "spark-amber"]);

function buildTheme(name: string, bg: string, fg: string, c: Record<string, string>): ThemeRegistration {
  return {
    name,
    type: LIGHT_THEMES.has(name) ? ("light" as const) : ("dark" as const),
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
  light: buildTheme("spark-light", "#ffffff", "#171b21", {
    comment: "#616a78", keyword: "#8b1a8b", string: "#146c2e", number: "#9a4d06",
    func: "#1f5ed0", tag: "#b3261e", type: "#0e6f68", attr: "#5f4327", regex: "#a8265c",
  }),
  dark: buildTheme("spark-dark", "#181c23", "#e8ebf0", {
    comment: "#8b95a3", keyword: "#d8b4fe", string: "#86e08e", number: "#ffc078",
    func: "#83c3ff", tag: "#ff8f86", type: "#6fdcc8", attr: "#cfd67a", regex: "#ff9ec4",
  }),
  navy: buildTheme("spark-navy", "#0e1c30", "#e9f1ff", {
    comment: "#8ba2c4", keyword: "#cf9bf0", string: "#c6ec92", number: "#fa9a74",
    func: "#8bb4ff", tag: "#ff7089", type: "#5cd6e8", attr: "#ffd06e", regex: "#ffa8d0",
  }),
  amber: buildTheme("spark-amber", "#fffdf7", "#241a08", {
    comment: "#71603c", keyword: "#a01a63", string: "#146c2e", number: "#9a4d06",
    func: "#1f5ed0", tag: "#b3261e", type: "#0e6f68", attr: "#5f4327", regex: "#7a3d9e",
  }),
  red: buildTheme("spark-red", "#221014", "#ffe9ec", {
    comment: "#bd8b94", keyword: "#ffa8d8", string: "#a8dfae", number: "#ffb066",
    func: "#b8c8f0", tag: "#ff7a76", type: "#8fd9d0", attr: "#ffe08a", regex: "#d5b3ff",
  }),
};
