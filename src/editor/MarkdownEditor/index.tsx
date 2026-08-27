/* ============================================================
   sparkEditor · src/editor/MarkdownEditor/index.tsx
   Markdown surface — toolbar + CodeMirror 6 editor + live
   preview pane.  The preview is built from the same raw text
   the editor holds, rendered with a tiny built-in md→html
   pipeline (we keep it self-contained instead of pulling in
   remark to keep the renderer bundle slim).
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown as mdLang } from "@codemirror/lang-markdown";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, HighlightStyle } from "@codemirror/language";
import { tagExtension } from "../CodeEditor/highlightBridge";
import { useDocs } from "@store/documents";
import { useTheme } from "@theme/ThemeProvider";
import { Icon } from "@ui/Icon";
import { Button } from "@ui/Button";
import { motion } from "@motion/index";
import { renderMd } from "./renderMd";
import "../editor.css";

export function MarkdownEditor({ docId }: { docId: string }) {
  const doc = useDocs((s) => s.docs[docId]);
  const setRaw = useDocs((s) => s.setRaw);
  const setCursor = useDocs((s) => s.setCursor);
  const ref = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [preview, setPreview] = useState(true);
  const { resolved } = useTheme();
  const themeComp = useRef(new Compartment()).current;

  useEffect(() => {
    if (!ref.current || !doc) return;
    const state = EditorState.create({
      doc: doc.raw,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        bracketMatching(),
        mdLang(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        syntaxHighlighting(HighlightStyle.define([
          { tag: tagExtension.heading, color: "var(--syn-keyword)", fontWeight: "700" },
          { tag: tagExtension.emphasis, color: "var(--syn-tag)", fontStyle: "italic" },
          { tag: tagExtension.strong, color: "var(--syn-func)", fontWeight: "700" },
          { tag: tagExtension.link, color: "var(--syn-keyword)", textDecoration: "underline" },
          { tag: tagExtension.url, color: "var(--syn-keyword)" },
          { tag: tagExtension.monospace, color: "var(--syn-string)", fontFamily: "var(--font-code)" },
          { tag: tagExtension.quote, color: "var(--syn-muted)", fontStyle: "italic" },
          { tag: tagExtension.list, color: "var(--syn-func)" },
          { tag: tagExtension.meta, color: "var(--syn-comment)" },
        ])),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        themeComp.of(EditorView.theme({}, { dark: resolved !== "light" })),
        EditorView.updateListener.of((v) => {
          if (v.docChanged) setRaw(docId, v.state.doc.toString());
          if (v.selectionSet || v.docChanged) {
            const pos = v.state.selection.main.head;
            const ln = v.state.doc.lineAt(pos);
            setCursor(docId, { line: ln.number, col: pos - ln.from + 1 });
          }
        }),
      ],
    });
    const v = new EditorView({ state, parent: ref.current });
    viewRef.current = v;
    return () => { v.destroy(); viewRef.current = null; };
  }, [docId]);

  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    v.dispatch({ effects: themeComp.reconfigure(EditorView.theme({}, { dark: resolved !== "light" })) });
  }, [resolved]);

  const html = useMemo(() => renderMd(doc?.raw ?? ""), [doc?.raw]);

  const insert = useCallback((left: string, right = "") => {
    const v = viewRef.current;
    if (!v) return;
    const { from, to } = v.state.selection.main;
    const sel = v.state.sliceDoc(from, to);
    v.dispatch({ changes: { from, to, insert: `${left}${sel}${right}` }, selection: { anchor: from + left.length, head: from + left.length + sel.length } });
    v.focus();
  }, []);

  const insertAtLineStart = useCallback((prefix: string) => {
    const v = viewRef.current;
    if (!v) return;
    const pos = v.state.selection.main.head;
    const line = v.state.doc.lineAt(pos);
    v.dispatch({
      changes: { from: line.from, insert: prefix },
      selection: { anchor: pos + prefix.length },
    });
    v.focus();
  }, []);

  const insertDivider = useCallback(() => {
    const v = viewRef.current;
    if (!v) return;
    const pos = v.state.selection.main.head;
    const line = v.state.doc.lineAt(pos);
    const lineEnd = line.to;
    v.dispatch({
      changes: { from: lineEnd, insert: "\n---\n" },
      selection: { anchor: lineEnd + 5 },
    });
    v.focus();
  }, []);

  const insertCodeBlock = useCallback(() => {
    const v = viewRef.current;
    if (!v) return;
    const { from, to } = v.state.selection.main;
    const sel = v.state.sliceDoc(from, to);
    const block = "```\n" + sel + "\n```";
    v.dispatch({
      changes: { from, to, insert: block },
      selection: { anchor: from + 4 },
    });
    v.focus();
  }, []);

  const insertImage = useCallback(() => {
    const url = window.prompt("Image URL", "https://") ?? "";
    insert(`![alt](${url})`, "");
  }, [insert]);

  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    const content = v.contentDOM;
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key !== "b" && key !== "i" && key !== "e" && key !== "k") return;
      e.preventDefault();
      if (key === "b") insert("**", "**");
      else if (key === "i") insert("_", "_");
      else if (key === "e") insert("`", "`");
      else if (key === "k") insert("[", "](https://)");
    };
    content.addEventListener("keydown", handler);
    return () => content.removeEventListener("keydown", handler);
  }, [insert]);

  useEffect(() => {
    const onBold = () => insert("**", "**");
    const onItalic = () => insert("_", "_");
    const onInlineCode = () => insert("`", "`");
    const onLink = () => insert("[", "](https://)");
    window.addEventListener("spark:md:format:bold", onBold);
    window.addEventListener("spark:md:format:italic", onItalic);
    window.addEventListener("spark:md:format:inlineCode", onInlineCode);
    window.addEventListener("spark:md:format:link", onLink);
    return () => {
      window.removeEventListener("spark:md:format:bold", onBold);
      window.removeEventListener("spark:md:format:italic", onItalic);
      window.removeEventListener("spark:md:format:inlineCode", onInlineCode);
      window.removeEventListener("spark:md:format:link", onLink);
    };
  }, [insert]);

  const wordCount = useMemo(() => {
    const text = doc?.raw ?? "";
    return text.trim().split(/\s+/).filter(Boolean).length;
  }, [doc?.raw]);

  const cursorPos = doc?.cursor;

  return (
    <div className={`md-editor ${preview ? "md-editor--with-preview" : ""}`}>
      <div className="md-editor__toolbar">
        <Button size="sm" variant="ghost" icon="h1" onClick={() => insert("# ")} title="Heading 1" />
        <Button size="sm" variant="ghost" icon="h2" onClick={() => insert("## ")} title="Heading 2" />
        <Button size="sm" variant="ghost" icon="h3" onClick={() => insert("### ")} title="Heading 3" />
        <span className="md-editor__divider" />
        <Button size="sm" variant="ghost" icon="bold" onClick={() => insert("**", "**")} title="Bold (⌘B)" />
        <Button size="sm" variant="ghost" icon="italic" onClick={() => insert("_", "_")} title="Italic (⌘I)" />
        <Button size="sm" variant="ghost" icon="link" onClick={() => insert("[", "](https://)")} title="Link (⌘K)" />
        <Button size="sm" variant="ghost" icon="list-ul" onClick={() => insert("- ")} title="Bulleted list" />
        <Button size="sm" variant="ghost" icon="list-ol" onClick={() => insert("1. ")} title="Numbered list" />
        <Button size="sm" variant="ghost" icon="quote" onClick={() => insert("> ")} title="Blockquote" />
        <span className="md-editor__divider" />
        <Button size="sm" variant="ghost" icon="code" onClick={() => insert("`", "`")} title="Inline code (⌘E)" />
        <Button size="sm" variant="ghost" icon="divider" onClick={insertDivider} title="Thematic break (---)" />
        <Button size="sm" variant="ghost" icon="check" onClick={() => insertAtLineStart("- [ ] ")} title="Task list" />
        <Button size="sm" variant="ghost" icon="file" onClick={insertImage} title="Image" />
        <Button size="sm" variant="ghost" icon="code" onClick={insertCodeBlock} title="Code block" />
        <span style={{ flex: 1 }} />
        <span className="md-editor__status" style={{ color: "var(--text-muted)", fontSize: "var(--size-xs, 12px)" }}>
          <span style={{ marginRight: 12 }}>Markdown</span>
          <span style={{ marginRight: 12 }}>
            Ln {cursorPos?.line ?? 1}, Col {cursorPos?.col ?? 1}
          </span>
          <span>{wordCount} words</span>
        </span>
        <Button
          size="sm"
          variant={preview ? "secondary" : "ghost"}
          icon={preview ? "maximize" : "restore"}
          onClick={() => setPreview((v) => !v)}
        >
          {preview ? "Hide preview" : "Show preview"}
        </Button>
      </div>

      <div className="md-editor__split">
        <div ref={ref} className="editor editor--md" />
        {preview && (
          <motion.div
            className="md-editor__preview"
            initial={{ opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.18, ease: [0.2, 0.6, 0.3, 1] }}
          >
            <div className="md-rendered" dangerouslySetInnerHTML={{ __html: html }} />
          </motion.div>
        )}
      </div>
    </div>
  );
}
