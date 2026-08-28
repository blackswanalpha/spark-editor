/* ============================================================
   sparkEditor · src/editor/HtmlPreview/index.tsx
   No-server HTML webview.  Renders the active document's
   raw HTML inside an <iframe srcdoc> after inlining local
   assets (CSS <link>, <script src>) via the Tauri bridge
   `readFile`.  No localhost HTTP server is spawned — all
   resolution is done through the host FS commands.

   Behaviours:
   • Resolves relative href/src against the document's
     parent directory (doc.path).
   • Leaves http(s)://, data:, blob:, // URLs untouched.
   • Shows bundled warnings inline.
   • Code ↔ Preview split toggle (CodeMirror for editing).
   • Refresh, open-external (tauri shell), device toggle,
     inline-images toggle.
   • Browser mock: works with MEMORY_FS.
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { html as htmlLang } from "@codemirror/lang-html";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, HighlightStyle } from "@codemirror/language";
import { tagExtension } from "../CodeEditor/highlightBridge";
import { useDocs } from "@store/documents";
import { useTheme } from "@theme/ThemeProvider";
import { Button } from "@ui/Button";
import { bundleHtml } from "./bundle";
import "./HtmlPreview.css";
import "../editor.css";

export function HtmlPreview({ docId }: { docId: string }) {
  const doc = useDocs((s) => s.docs[docId]);
  const setRaw = useDocs((s) => s.setRaw);
  const { resolved } = useTheme();

  const [srcDoc, setSrcDoc] = useState<string>(doc?.raw ?? "");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [showCode, setShowCode] = useState(true);
  const [inlineImages, setInlineImages] = useState(false);
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [zoom, setZoom] = useState(1);

  // CodeMirror for the HTML source
  const ref = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeComp = useRef(new Compartment()).current;

  useEffect(() => {
    if (!ref.current || !doc) return;
    if (!showCode) return;
    const state = EditorState.create({
      doc: doc.raw,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        bracketMatching(),
        htmlLang(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        syntaxHighlighting(HighlightStyle.define([
          { tag: tagExtension.tagName, color: "var(--syn-tag)" },
          { tag: tagExtension.attributeName, color: "var(--syn-attr)" },
          { tag: tagExtension.string, color: "var(--syn-string)" },
          { tag: tagExtension.comment, color: "var(--syn-comment)", fontStyle: "italic" },
          { tag: tagExtension.keyword, color: "var(--syn-keyword)", fontWeight: "600" },
        ])),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        themeComp.of(EditorView.theme({}, { dark: resolved !== "light" })),
        EditorView.updateListener.of((v) => {
          if (v.docChanged) setRaw(docId, v.state.doc.toString());
        }),
      ],
    });
    const v = new EditorView({ state, parent: ref.current });
    viewRef.current = v;
    return () => { v.destroy(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, showCode]);

  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    v.dispatch({ effects: themeComp.reconfigure(EditorView.theme({}, { dark: resolved !== "light" })) });
  }, [resolved]);

  // Keep CM in sync when doc changes externally (e.g. file reload) but avoid loop
  useEffect(() => {
    const v = viewRef.current;
    if (!v || !doc) return;
    const cur = v.state.doc.toString();
    if (cur !== doc.raw) {
      v.dispatch({ changes: { from: 0, to: cur.length, insert: doc.raw } });
    }
  }, [doc?.raw]);

  const rebuild = useCallback(async () => {
    if (!doc) return;
    setBusy(true);
    try {
      const { html, warnings: w } = await bundleHtml(doc.raw, doc.path, { inlineImages });
      setSrcDoc(html);
      setWarnings(w);
    } catch (e: any) {
      setSrcDoc(doc.raw);
      setWarnings([String(e?.message ?? e)]);
    } finally {
      setBusy(false);
    }
  }, [doc, inlineImages]);

  // Auto rebuild with debounce when raw or inlineImages toggles
  useEffect(() => {
    const t = setTimeout(() => { void rebuild(); }, inlineImages ? 120 : 180);
    return () => clearTimeout(t);
  }, [rebuild]);

  // Also rebuild on doc path change
  useEffect(() => { void rebuild(); }, [doc?.path]);

  const urlLabel = useMemo(() => doc?.path ?? "untitled.html (unsaved)", [doc?.path]);

  if (!doc) return null;

  return (
    <div className={`html-preview ${showCode ? "html-preview--with-code" : ""}`}>
      <div className="html-preview__toolbar" role="toolbar" aria-label="HTML preview toolbar">
        <Button size="sm" variant="ghost" icon="refresh" onClick={() => void rebuild()} title="Reload preview" disabled={busy}>
          {busy ? "Bundling…" : "Reload"}
        </Button>
        <Button size="sm" variant={showCode ? "secondary" : "ghost"} icon={showCode ? "sidebar-toggle" : "code"} onClick={() => setShowCode(v => !v)} title={showCode ? "Hide source" : "Show source"}>
          {showCode ? "Hide code" : "Show code"}
        </Button>
        <span className="html-preview__divider" />
        <Button size="sm" variant={device === "desktop" ? "secondary" : "ghost"} icon="maximize" onClick={() => setDevice("desktop")} title="Desktop width">Desktop</Button>
        <Button size="sm" variant={device === "mobile" ? "secondary" : "ghost"} icon="restore" onClick={() => setDevice("mobile")} title="Mobile width (390px)">Mobile</Button>
        <span className="html-preview__divider" />
        <Button size="sm" variant={inlineImages ? "secondary" : "ghost"} icon="file" onClick={() => setInlineImages(v => !v)} title={inlineImages ? "Images: inline as data URI" : "Images: leave as-is"}>
          {inlineImages ? "Images inlined" : "Inline images"}
        </Button>
        <span className="html-preview__divider" />
        <Button size="sm" variant="ghost" icon="plus" onClick={() => setZoom(z => Math.min(2, +(z + 0.1).toFixed(2)))} title="Zoom in">+</Button>
        <Button size="sm" variant="ghost" icon="minus" onClick={() => setZoom(z => Math.max(0.5, +(z - 0.1).toFixed(2)))} title="Zoom out">−</Button>
        <span style={{ fontSize: 11, color: "var(--text-muted)", minWidth: 32, textAlign: "center" }}>{Math.round(zoom * 100)}%</span>
        <span className="html-preview__spacer" />
        <div className="html-preview__url" title={urlLabel}><span>{urlLabel}</span></div>
      </div>

      {warnings.length > 0 && (
        <div className="html-preview__warnings" role="status" aria-live="polite">
          <strong>{warnings.length} warning{warnings.length > 1 ? "s" : ""}:</strong>
          <ul>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      )}

      <div className="html-preview__split">
        {showCode && (
          <div className="html-preview__code">
            <div ref={ref} className="editor editor--code" style={{ flex: 1, minHeight: 0 }} />
          </div>
        )}
        <div className="html-preview__frame-wrap" style={{ zoom: zoom as any }}>
          <iframe
            title="HTML preview"
            className={`html-preview__frame ${device === "mobile" ? "html-preview__frame--mobile" : ""}`}
            srcDoc={srcDoc}
            sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
            // allow-same-origin is needed so the iframe can use data: URIs and not be doubly isolated,
            // but we do NOT allow top navigation. Scripts run isolated in srcDoc.
            loading="eager"
          />
          <span className="html-preview__dev-hint">no-server · bundled via bridge · {device}</span>
        </div>
      </div>
    </div>
  );
}
