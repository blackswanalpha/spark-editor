/* ============================================================
   sparkBook · src/editor/MarkdownEditor/renderMd.ts
   Tiny, safe, dependency-free markdown renderer. Supports:
     • headings #…######
     • **bold**, *italic*, ~~strike~~, `code`
     • links [text](url)
     • unordered (-) and ordered (1.) lists
     • > blockquotes
     • ``` fenced code blocks ``` (rendered as <pre><code>)
     • --- horizontal rule
   Output is HTML-escaped before any markdown rules apply, so
   user input is never injected as raw HTML.
   ============================================================ */
const ESC: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
function esc(s: string) { return s.replace(/[&<>"']/g, (c) => ESC[c]); }

function inline(s: string): string {
  return s
    .replace(/`([^`\n]+)`/g, (_, c) => `<code>${esc(c)}</code>`)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, a, b) =>
      `<img alt="${esc(a)}" src="${esc(b)}" />`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, a, b) =>
      `<a href="${esc(b)}" rel="noreferrer noopener">${esc(a)}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/  $/gm, "<br/>");
}

export function renderMd(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];

    // fenced code block
    const fence = ln.match(/^```\s*([\w-]*)\s*$/);
    if (fence) {
      const lang = fence[1] || "";
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      out.push(`<pre data-lang="${esc(lang)}"><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }

    // heading
    const h = ln.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(esc(h[2]))}</h${lvl}>`);
      i++; continue;
    }

    // hr
    if (/^-{3,}\s*$/.test(ln)) { out.push("<hr/>"); i++; continue; }

    // blockquote
    if (/^>\s?/.test(ln)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, "")); i++; }
      out.push(`<blockquote>${inline(esc(buf.join(" ")))}</blockquote>`);
      continue;
    }

    // unordered list
    if (/^[-*+]\s+/.test(ln)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
        items.push(`<li>${inline(esc(lines[i].replace(/^[-*+]\s+/, "")))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // ordered list
    if (/^\d+\.\s+/.test(ln)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${inline(esc(lines[i].replace(/^\d+\.\s+/, "")))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // blank line
    if (ln.trim() === "") { i++; continue; }

    // paragraph (collect until blank line)
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^```|^#{1,6}\s|^[-*+]\s|^\d+\.\s|^>\s?/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(esc(para.join(" ")))}</p>`);
  }
  return out.join("\n");
}
