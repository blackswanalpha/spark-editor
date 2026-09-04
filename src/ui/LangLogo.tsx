/* ============================================================
   sparkBook · src/ui/LangLogo.tsx
   Real SVG language logo icons backed by
   `react-material-icon-theme`. Looks up the VS Code Material
   Icon Theme icon name from our internal `LangId` (file
   extension) and renders the official logo.

   Used by:
     • The code editor's language chip (top-left pill)
     • The file tree in the side bar
     • Any consumer that does `<Icon name="lang-dart" />` —
       the alias `lang-dart` keeps working too (DartIcon).

   Exports:
     • LANG_ICON_NAME — our `LangId` → Material Icon Theme name
     • LangLogo        — React component (forwardRef)
   ============================================================ */

import { forwardRef, type CSSProperties } from "react";
import { getIconSvg, hasIcon } from "react-material-icon-theme";

/** Our LangId (extension) → VS Code Material Icon Theme icon name. */
export const LANG_ICON_NAME: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  vue: "vue", svelte: "svelte",
  html: "html", htm: "html", xhtml: "html", svg: "html",
  css: "css", scss: "sass", sass: "sass", less: "less",
  json: "json", jsonc: "json",
  yaml: "yaml", yml: "yaml", toml: "toml",
  ini: "settings", conf: "settings",
  xml: "xml",
  py: "python", rs: "rust", go: "go",
  c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hxx: "cpp",
  java: "java",
  kt: "java", kts: "java",
  scala: "scala", clj: "clojure",
  cs: "visualstudio", csx: "visualstudio",
  fs: "visualstudio", fsx: "visualstudio",
  vb: "visualstudio",
  swift: "swift", m: "c", mm: "cpp",
  php: "php", rb: "ruby",
  pl: "perl", pm: "perl",
  lua: "javascript",
  r: "python",
  hs: "haskell", ml: "haskell",
  ex: "elixir", exs: "elixir",
  erl: "erlang",
  dart: "dart",
  sh: "console", bash: "console", zsh: "console",
  ps1: "powershell",
  bat: "console", cmd: "console",
  makefile: "makefile", mk: "makefile",
  dockerfile: "docker",
  nginx: "nginx",
  tf: "terraform", hcl: "hcl",
  graphql: "graphql", gql: "graphql",
  md: "markdown", markdown: "markdown",
  sql: "database",
};

interface LangLogoProps {
  langId: string;
  size?: number | string;
  className?: string;
  style?: CSSProperties;
  title?: string;
  opacity?: number;
}

export const LangLogo = forwardRef<HTMLSpanElement, LangLogoProps>(function LangLogo(
  { langId, size = 16, className, style, title, opacity },
  ref,
) {
  // Defensive: normalize langId and guard against library throwing
  const normalized = String(langId ?? "").toLowerCase().trim();
  let svg = "";
  try {
    const mapped = (normalized && LANG_ICON_NAME[normalized]) ?? "file";
    const safe =
      typeof hasIcon === "function" && hasIcon(mapped) ? mapped : "file";
    const candidate =
      typeof getIconSvg === "function" ? getIconSvg(safe) : null;
    // Fallback chain: mapped → file → empty
    svg =
      candidate ??
      (typeof getIconSvg === "function" ? getIconSvg("file") : null) ??
      "";
    // Ensure inner <svg> fills the wrapper span (iconData svgs have no
    // explicit width/height — they rely on the container). Inject 100%
    // sizing so a 14px wrapper correctly constrains a 32px viewBox.
    if (svg && svg.includes("<svg")) {
      // Only inject if the svg tag doesn't already declare width/height
      const hasWidth = /\swidth=/.test(svg);
      const hasHeight = /\sheight=/.test(svg);
      if (!hasWidth || !hasHeight) {
        svg = svg.replace(
          "<svg",
          '<svg width="100%" height="100%" style="display:block"',
        );
      }
      // Ensure display:block even if width/height existed
      if (!svg.includes('style="display:block"') && !svg.includes("style='display:block'")) {
        // Add style if missing — inject into opening tag
        if (!hasWidth && !hasHeight) {
          // already injected above
        } else if (!svg.includes("style=")) {
          svg = svg.replace("<svg", '<svg style="display:block"');
        }
      }
    }
  } catch {
    svg = "";
  }

  const cls = ["lang-logo", className].filter(Boolean).join(" ");
  const wrapStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: size,
    height: size,
    lineHeight: 0,
    opacity: opacity ?? 0.95,
    flex: "0 0 auto",
    ...style,
  };

  // If svg could not be resolved, render a lightweight fallback instead of
  // injecting empty HTML (which would leave an empty span and confuse a11y).
  if (!svg) {
    return (
      <span
        ref={ref}
        className={cls}
        style={wrapStyle}
        title={title ?? normalized}
        aria-hidden={title ? undefined : true}
      >
        {/* generic file glyph fallback */}
        <span aria-hidden style={{ fontSize: size, lineHeight: 1 }}>
          📄
        </span>
      </span>
    );
  }

  return (
    <span
      ref={ref}
      className={cls}
      style={wrapStyle}
      title={title ?? normalized}
      aria-hidden={title ? undefined : true}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
});
