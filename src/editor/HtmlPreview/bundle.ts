/* ============================================================
   sparkBook · src/editor/HtmlPreview/bundle.ts
   No-server HTML bundler.  Rewrites a raw HTML document so
   that local assets (CSS, JS, images) are inlined via the
   Tauri bridge instead of via HTTP.  The result can be fed
   directly to an <iframe srcdoc> without needing any
   localhost server.

   Supported rewrites:
    • <link rel="stylesheet" href="…"> → <style>…</style>
    • <script src="…">                → <script>…</script>
    • <img src="…">                   → data: URI (via base64)
    • <link rel="icon" href="…">      → left as-is (optional)
   External URLs (http://, https://, data:, blob:, //) are
   left untouched.  Relative paths are resolved against the
   HTML file's parent directory (docPath).
   ============================================================ */
import { readFile } from "@bridge/commands";
import { joinPath } from "@bridge/commands";

/* Map extension → MIME for image data URIs */
const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  avif: "image/avif",
};

function isExternal(href: string): boolean {
  const h = href.trim();
  if (!h) return true;
  if (h.startsWith("data:")) return true;
  if (h.startsWith("blob:")) return true;
  if (h.startsWith("#")) return true;
  if (/^(https?:)?\/\//i.test(h)) return true;
  return false;
}

function stripQuery(href: string): string {
  const q = href.indexOf("?");
  const f = href.indexOf("#");
  let end = href.length;
  if (q !== -1) end = Math.min(end, q);
  if (f !== -1) end = Math.min(end, f);
  return href.slice(0, end);
}

function resolveAbsolute(baseDir: string, href: string): string | null {
  if (isExternal(href)) return null;
  const clean = stripQuery(href.trim());
  if (!clean) return null;
  if (clean.startsWith("/")) return clean; // absolute FS path
  // relative
  const joined = joinPath(baseDir || "/", clean);
  return normalizePath(joined);
}

function normalizePath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return "/" + out.join("/");
}

function dirName(path: string | null): string {
  if (!path) return "/";
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (idx <= 0) return "/";
  return path.slice(0, idx) || "/";
}

/* Attempt to guess MIME from extension */
function mimeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

/* Try to read a file as base64 (Tauri) or as text fallback (mock).
   Falls back to readFile if readFileBase64 is unavailable / fails. */
async function tryReadBase64(absPath: string): Promise<string | null> {
  try {
    const mod: any = await import("@bridge/commands");
    if (typeof mod.readFileBase64 === "function") {
      const b64: string = await mod.readFileBase64(absPath);
      return b64;
    }
  } catch {}
  try {
    const txt: string = await readFile(absPath);
    // Not truly base64 but we can base64-encode the text if it's SVG/text
    try {
      return btoa(unescape(encodeURIComponent(txt)));
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * Bundle HTML: inline CSS/JS and optionally images.
 * `options.inlineImages` toggles image data-URI inlining (requires base64).
 */
export async function bundleHtml(
  raw: string,
  docPath: string | null,
  options: { inlineImages?: boolean } = {},
): Promise<{ html: string; warnings: string[] }> {
  const warnings: string[] = [];
  if (!raw.trim()) return { html: raw, warnings };

  const parser = new DOMParser();
  const doc = parser.parseFromString(raw, "text/html");
  const baseDir = dirName(docPath);

  // Inline stylesheets
  const links = Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]'));
  for (const link of links) {
    const href = link.getAttribute("href") ?? "";
    const abs = resolveAbsolute(baseDir, href);
    if (!abs) continue;
    try {
      const css = await readFile(abs);
      const style = doc.createElement("style");
      // Preserve media attribute
      const media = link.getAttribute("media");
      if (media) style.setAttribute("media", media);
      style.setAttribute("data-bundled-from", href);
      style.textContent = `/* bundled: ${href} → ${abs} */\n${css}`;
      link.replaceWith(style);
    } catch (e: any) {
      warnings.push(`CSS not found: ${href} (${e?.kind ?? e?.message ?? String(e)})`);
    }
  }

  // Inline <style> @import — naive one-level expansion for @import "foo.css";
  const styles = Array.from(doc.querySelectorAll<HTMLStyleElement>("style"));
  for (const style of styles) {
    const text = style.textContent ?? "";
    // Match @import url("...") or @import "...";
    const importRe = /@import\s+(?:url\()?["']?([^"')]+)["']?\)?\s*;/g;
    let m: RegExpExecArray | null;
    let replaced = text;
    let had = false;
    while ((m = importRe.exec(text))) {
      const href = m[1];
      const abs = resolveAbsolute(baseDir, href);
      if (!abs) continue;
      try {
        const css = await readFile(abs);
        replaced = replaced.replace(m[0], `/* @import ${href} */\n${css}\n`);
        had = true;
      } catch (e: any) {
        warnings.push(`@import not found: ${href}`);
      }
    }
    if (had) style.textContent = replaced;
  }

  // Inline scripts with src
  const scripts = Array.from(doc.querySelectorAll<HTMLScriptElement>("script[src]"));
  for (const scr of scripts) {
    const src = scr.getAttribute("src") ?? "";
    const abs = resolveAbsolute(baseDir, src);
    if (!abs) continue;
    try {
      const js = await readFile(abs);
      const n = doc.createElement("script");
      for (const { name, value } of Array.from(scr.attributes)) {
        if (name === "src") continue;
        n.setAttribute(name, value);
      }
      n.setAttribute("data-bundled-from", src);
      n.textContent = `/* bundled: ${src} → ${abs} */\n${js}`;
      scr.replaceWith(n);
    } catch (e: any) {
      warnings.push(`JS not found: ${src}`);
    }
  }

  // Optionally inline images
  if (options.inlineImages) {
    const imgs = Array.from(doc.querySelectorAll<HTMLImageElement>("img[src]"));
    for (const img of imgs) {
      const src = img.getAttribute("src") ?? "";
      const abs = resolveAbsolute(baseDir, src);
      if (!abs) continue;
      const mime = mimeFor(abs);
      // Only inline image-like files
      if (!mime.startsWith("image/")) continue;
      const b64 = await tryReadBase64(abs);
      if (!b64) {
        warnings.push(`image not inlined: ${src}`);
        continue;
      }
      img.setAttribute("src", `data:${mime};base64,${b64}`);
      img.setAttribute("data-bundled-from", src);
    }
  }

  // Ensure a <base> that prevents further external file:// resolution
  // We intentionally do NOT set base href so srcDoc stays self-contained.
  // If raw had no <head>, create one.
  if (!doc.head) {
    const head = doc.createElement("head");
    doc.documentElement.prepend(head);
  }

  // Serialize back. Use outerHTML of documentElement or serialize the whole doc.
  const html = "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
  // Preserve original doctype if present? We use standard one.

  return { html, warnings };
}
