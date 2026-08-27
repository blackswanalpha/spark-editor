/* ============================================================
   sparkEditor · src/editor/CodeEditor/languages.ts
   Comprehensive language registry for the code editor.

   Owns:
     • imports of all CodeMirror language packages
     • LangId, LangFactory types
     • LANG_LOADERS, LANG_LABELS, LANG_COMMENT, LANG_SHIKI,
       LANG_ICON, LANG_FILE_EXTRA maps
     • ALL_LANGS
     • langFor, langIdOf, fileIconFor
     • detectLangFromExt, detectLangFromContent, guessLang
   ============================================================ */
import type { Extension } from "@codemirror/state";
import { markdown as mdLang } from "@codemirror/lang-markdown";
import { javascript as jsLang } from "@codemirror/lang-javascript";
import { python as pyLang } from "@codemirror/lang-python";
import { html as htmlLang } from "@codemirror/lang-html";
import { css as cssLang } from "@codemirror/lang-css";
import { json as jsonLang } from "@codemirror/lang-json";
import { rust as rustLang } from "@codemirror/lang-rust";
import { go as goLang } from "@codemirror/lang-go";
import { yaml as yamlLang } from "@codemirror/lang-yaml";
import { sql as sqlLang } from "@codemirror/lang-sql";
import type { BundledLanguage } from "shiki";

/** No-op CodeMirror extension factory used for languages we
 *  recognise but don't have a CodeMirror grammar package for. */
const noLang: LangFactory = () => [];

/* ----------------------------------------------------------------
   Types
   ---------------------------------------------------------------- */
export type LangId =
  | "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs"
  | "vue" | "svelte"
  | "json" | "jsonc" | "json5"
  | "yaml" | "yml" | "toml"
  | "xml" | "xhtml" | "svg"
  | "html" | "htm"
  | "css" | "scss" | "sass" | "less" | "styl" | "postcss"
  | "md" | "markdown" | "mdx"
  | "py" | "pyw"
  | "rs" | "go" | "c" | "h" | "cpp" | "cc" | "cxx" | "hpp" | "hxx"
  | "java" | "cs" | "rb" | "php" | "phtml"
  | "swift" | "kt" | "kts" | "scala" | "m" | "mm"
  | "sh" | "bash" | "zsh" | "fish" | "ps1" | "bat" | "cmd"
  | "sql" | "graphql" | "gql"
  | "tex" | "lua" | "pl" | "r" | "dart" | "zig";

export type LangFactory = () => Extension;

/* ----------------------------------------------------------------
   Language loaders — keyed by canonical short ids.
   ---------------------------------------------------------------- */
export const LANG_LOADERS: Record<string, LangFactory> = {
  // JavaScript family
  ts:      () => jsLang({ jsx: false, typescript: true }),
  tsx:     () => jsLang({ jsx: true,  typescript: true }),
  js:      () => jsLang({ jsx: false, typescript: false }),
  jsx:     () => jsLang({ jsx: true,  typescript: false }),
  mjs:     () => jsLang({ jsx: false, typescript: false }),
  cjs:     () => jsLang({ jsx: false, typescript: false }),
  vue:     () => jsLang({ jsx: false, typescript: false }),
  svelte:  () => jsLang({ jsx: false, typescript: false }),

  // Data / config
  json:    () => jsonLang(),
  jsonc:   () => jsonLang(),
  json5:   () => jsonLang(),
  yaml:    () => yamlLang(),
  yml:     () => yamlLang(),
  toml:    () => jsonLang(),
  xml:     noLang,
  xhtml:   noLang,
  svg:     noLang,

  // Web
  html:    () => htmlLang(),
  htm:     () => htmlLang(),
  css:     () => cssLang(),
  scss:    () => cssLang(),
  sass:    () => cssLang(),
  less:    () => cssLang(),
  styl:    () => cssLang(),
  postcss: () => cssLang(),

  // Systems / scripting
  py:      () => pyLang(),
  pyw:     () => pyLang(),
  rs:      () => rustLang(),
  go:      () => goLang(),
  c:       noLang,
  h:       noLang,
  cpp:     noLang,
  cc:      noLang,
  cxx:     noLang,
  hpp:     noLang,
  hxx:     noLang,
  java:    noLang,
  cs:      noLang,
  rb:      noLang,
  php:     noLang,
  phtml:   noLang,
  swift:   noLang,
  kt:      noLang,
  kts:     noLang,
  scala:   noLang,
  m:       noLang,
  mm:      noLang,

  // Shell
  sh:      noLang,
  bash:    noLang,
  zsh:     noLang,
  fish:    noLang,
  ps1:     noLang,
  bat:     noLang,
  cmd:     noLang,

  // Data / query
  sql:     () => sqlLang(),
  graphql: noLang,
  gql:     noLang,

  // Docs / markup
  md:      () => mdLang(),
  markdown:() => mdLang(),
  mdx:     () => mdLang(),
  tex:     noLang,

  // Other
  lua:     noLang,
  pl:      noLang,
  r:       noLang,
  dart:    noLang,
  zig:     noLang,
};

/* ----------------------------------------------------------------
   Human-readable labels
   ---------------------------------------------------------------- */
export const LANG_LABELS: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript JSX",
  js: "JavaScript",
  jsx: "JavaScript JSX",
  mjs: "JavaScript (ESM)",
  cjs: "JavaScript (CJS)",
  vue: "Vue",
  svelte: "Svelte",
  json: "JSON",
  jsonc: "JSON (with comments)",
  json5: "JSON5",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  xml: "XML",
  xhtml: "XHTML",
  svg: "SVG",
  html: "HTML",
  htm: "HTML",
  css: "CSS",
  scss: "SCSS",
  sass: "Sass",
  less: "Less",
  styl: "Stylus",
  postcss: "PostCSS",
  md: "Markdown",
  markdown: "Markdown",
  mdx: "MDX",
  py: "Python",
  pyw: "Python",
  rs: "Rust",
  go: "Go",
  c: "C",
  h: "C Header",
  cpp: "C++",
  cc: "C++",
  cxx: "C++",
  hpp: "C++ Header",
  hxx: "C++ Header",
  java: "Java",
  cs: "C#",
  rb: "Ruby",
  php: "PHP",
  phtml: "PHP",
  swift: "Swift",
  kt: "Kotlin",
  kts: "Kotlin Script",
  scala: "Scala",
  m: "Objective-C",
  mm: "Objective-C++",
  sh: "Shell",
  bash: "Bash",
  zsh: "Zsh",
  fish: "Fish",
  ps1: "PowerShell",
  bat: "Batch",
  cmd: "Batch",
  sql: "SQL",
  graphql: "GraphQL",
  gql: "GraphQL",
  tex: "TeX",
  lua: "Lua",
  pl: "Perl",
  r: "R",
  dart: "Dart",
  zig: "Zig",
};

/* ----------------------------------------------------------------
   Comment prefix per language id (used by the fallback
   toggleComment command when CodeMirror's built-in doesn't fire).
   ---------------------------------------------------------------- */
export const LANG_COMMENT: Record<string, string> = {
  py: "# ",
  rb: "# ",
  pl: "# ",
  r:  "# ",
  yaml: "# ",
  yml: "# ",
  toml: "# ",
  sh: "# ",
  bash: "# ",
  zsh: "# ",
  fish: "# ",
  ps1: "# ",
  sql: "-- ",
  lua: "-- ",
  tex: "% ",
  bat: ":: ",
  cmd: ":: ",
};

/* ----------------------------------------------------------------
   Shiki bundled-language ids. Values must be valid
   `BundledLanguage` strings; keys are our canonical short ids.
   ---------------------------------------------------------------- */
export const LANG_SHIKI: Record<string, BundledLanguage> = {
  ts:       "ts",
  tsx:      "tsx",
  js:       "js",
  jsx:      "jsx",
  mjs:      "javascript",
  cjs:      "javascript",
  vue:      "vue",
  svelte:   "svelte",
  json:     "json",
  jsonc:    "jsonc",
  json5:    "json5",
  yaml:     "yaml",
  yml:      "yaml",
  toml:     "toml",
  xml:      "xml",
  xhtml:    "html",
  svg:      "xml",
  html:     "html",
  htm:      "html",
  css:      "css",
  scss:     "scss",
  sass:     "sass",
  less:     "less",
  styl:     "stylus",
  postcss:  "postcss",
  py:       "python",
  pyw:      "python",
  rs:       "rust",
  go:       "go",
  c:        "c",
  h:        "c",
  cpp:      "cpp",
  cc:       "cpp",
  cxx:      "cpp",
  hpp:      "cpp",
  hxx:      "cpp",
  java:     "java",
  cs:       "csharp",
  rb:       "ruby",
  php:      "php",
  phtml:    "php",
  swift:    "swift",
  kt:       "kotlin",
  kts:      "kotlin",
  scala:    "scala",
  m:        "objective-c",
  mm:       "objective-cpp",
  sh:       "bash",
  bash:     "bash",
  zsh:      "bash",
  fish:     "fish",
  ps1:      "powershell",
  bat:      "bat",
  cmd:      "bat",
  sql:      "sql",
  graphql:  "graphql",
  gql:      "graphql",
  md:       "markdown",
  markdown: "markdown",
  mdx:      "mdx",
  tex:      "latex",
  lua:      "lua",
  pl:       "perl",
  r:        "r",
  dart:     "dart",
  zig:      "zig",
};

/* ----------------------------------------------------------------
   Icon names for the file tree (consumed by <Icon name=… />).
   ---------------------------------------------------------------- */
export const LANG_ICON: Record<string, string> = {
  md:       "mode-markdown",
  markdown: "mode-markdown",
  mdx:      "mode-markdown",
  dart:     "lang-dart",
};

/* ----------------------------------------------------------------
   Extra file extensions / aliases → canonical id.
   detectLangFromExt checks this map first, then falls back to
   LANG_LOADERS so any id that doubles as an ext works too.
   ---------------------------------------------------------------- */
export const LANG_FILE_EXTRA: Record<string, string> = {
  // Spoken / alternate names
  typescript: "ts",
  javascript: "js",
  py: "py",
  python: "py",
  python3: "py",
  rust: "rs",
  rs: "rs",
  go: "go",
  golang: "go",
  shell: "sh",
  bash: "bash",
  sh: "sh",
  zsh: "zsh",
  yml: "yaml",
  yaml: "yaml",
  md: "md",
  markdown: "md",
  mdown: "md",
  objc: "m",
  "objective-c": "m",
  "objc++": "mm",
  "objective-cpp": "mm",
  "c++": "cpp",
  cpp: "cpp",
  "c#": "cs",
  csharp: "cs",
  kt: "kt",
  kotlin: "kt",
  rb: "rb",
  ruby: "rb",
  php: "php",
  sql: "sql",
  pl: "pl",
  perl: "pl",
  r: "r",
  dart: "dart",
  zig: "zig",
  // Common alternative extensions
  tsx: "tsx",
  jsx: "jsx",
  mjs: "mjs",
  cjs: "cjs",
  vue: "vue",
  svelte: "svelte",
  json: "json",
  jsonc: "jsonc",
  json5: "json5",
  toml: "toml",
  xml: "xml",
  xhtml: "xhtml",
  svg: "svg",
  html: "html",
  htm: "htm",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  styl: "styl",
  pcss: "postcss",
  postcss: "postcss",
  pyw: "pyw",
  h: "h",
  cc: "cpp",
  cxx: "cpp",
  hpp: "hpp",
  hxx: "hxx",
  java: "java",
  cs: "cs",
  phtml: "phtml",
  swift: "swift",
  kts: "kts",
  scala: "scala",
  mm: "mm",
  fish: "fish",
  ps1: "ps1",
  bat: "bat",
  cmd: "cmd",
  graphql: "graphql",
  gql: "gql",
  mdx: "mdx",
  tex: "tex",
  latex: "tex",
  lua: "lua",
};

/** All known language ids (canonical). */
export const ALL_LANGS: LangId[] = Object.keys(LANG_LOADERS) as LangId[];

/* ----------------------------------------------------------------
   Detection
   ---------------------------------------------------------------- */
export function detectLangFromExt(name: string): string | undefined {
  const m = name.toLowerCase().match(/\.([a-z0-9+#-]+)$/);
  if (!m) return undefined;
  const ext = m[1];
  return LANG_FILE_EXTRA[ext] ?? (LANG_LOADERS[ext] ? ext : undefined);
}

export function detectLangFromContent(text: string): string | undefined {
  const head = text.slice(0, 2048);
  if (/<!doctype\s+html|<html[\s>]/i.test(head)) return "html";
  if (/^\s*<\?xml[\s>]/i.test(head)) return "xml";
  if (/^\s*<svg[\s>]/i.test(head)) return "svg";
  if (/^\s*\{[\s\S]*"[^"]+"\s*:/m.test(head) && /[\}\]]\s*$/.test(head)) return "json";
  if (/^\s*package\s+main\b/m.test(head)) return "go";
  if (/^\s*fn\s+main\s*\(/m.test(head)) return "rs";
  if (/^\s*def\s+\w+\s*\([^)]*\)\s*:/m.test(head)) return "py";
  if (/^\s*(import\s+.*from\s+|export\s+(default\s+)?(?:const|function|class)\s+|const\s+\w+\s*[:=])/m.test(head)) return "js";
  if (/^\s*---\s*$/m.test(head) && /^\s*\w+:\s+/m.test(head)) return "yaml";
  if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/im.test(head)) return "sql";
  if (/^\s*<\?php\b/i.test(head)) return "php";
  return undefined;
}

export function langIdOf(name: string, explicitLang?: string, content?: string): string | undefined {
  const id = (explicitLang || detectLangFromExt(name) || (content ? detectLangFromContent(content) : undefined) || "").toLowerCase();
  return id || undefined;
}

export function langFor(name: string, explicitLang?: string, content?: string): Extension {
  const id = (explicitLang || detectLangFromExt(name) || (content ? detectLangFromContent(content) : undefined) || "").toLowerCase();
  const factory = LANG_LOADERS[id];
  return factory ? factory() : [];
}

/** Convenience helper: best-effort language id for a file name. */
export function guessLang(name: string): string {
  return langIdOf(name) ?? "";
}

/** Icon name for the file tree, based on extension. */
export function fileIconFor(name: string): string {
  const id = detectLangFromExt(name);
  if (id && LANG_ICON[id]) return LANG_ICON[id];
  return "file";
}
