/* ============================================================
   sparkEditor · src/editor/CodeEditor/index.tsx
   CodeMirror 6-based code surface with:
     • gutter
     • syntax highlighting (Shiki themes bridged through CM6)
     • autocomplete + lint gutter
     • per-doc mode (cursor position, dirty, line wrap)
     • language detection (extension + content heuristics)
     • top toolbar: go-to-line, toggle-comment, toggle-wrap, format
     • language chip in the corner
     • listens to global spark:code:* + view.toggleWordWrap events
   ============================================================ */
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import {
  EditorView,
  lineNumbers,
  highlightActiveLine,
  keymap,
  type ViewUpdate,
} from "@codemirror/view";
import {
  EditorState,
  Compartment,
  StateCommand,
  EditorSelection,
  type Extension,
} from "@codemirror/state";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  toggleComment,
} from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import {
  bracketMatching,
  indentOnInput,
  foldGutter,
  foldKeymap,
  syntaxHighlighting,
  defaultHighlightStyle,
  HighlightStyle,
} from "@codemirror/language";
import { autocompletion } from "@codemirror/autocomplete";
import { lintGutter } from "@codemirror/lint";
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
import { tagExtension } from "./highlightBridge";
import { useDocs } from "@store/documents";
import { useTheme } from "@theme/ThemeProvider";
import { Button } from "@ui/Button";
import "../editor.css";
import "./CodeEditor.css";

/* ----------------------------------------------------------------
   Language detection: extension + content heuristics
   ---------------------------------------------------------------- */

type LangFactory = () => Extension;

const LANG_LOADERS: Record<string, LangFactory> = {
  ts:  () => jsLang({ jsx: false, typescript: true }),
  tsx: () => jsLang({ jsx: true,  typescript: true }),
  js:  () => jsLang({ jsx: false, typescript: false }),
  jsx: () => jsLang({ jsx: true,  typescript: false }),
  mjs: () => jsLang({ jsx: false, typescript: false }),
  cjs: () => jsLang({ jsx: false, typescript: false }),
  json:    () => jsonLang(),
  html:    () => htmlLang(),
  htm:     () => htmlLang(),
  css:     () => cssLang(),
  scss:    () => cssLang(),
  md:      () => mdLang(),
  markdown:() => mdLang(),
  py:      () => pyLang(),
  rs:      () => rustLang(),
  go:      () => goLang(),
  yml:     () => yamlLang(),
  yaml:    () => yamlLang(),
  sql:     () => sqlLang(),
};

const LANG_LABELS: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript JSX",
  js: "JavaScript",
  jsx: "JavaScript JSX",
  mjs: "JavaScript (ESM)",
  cjs: "JavaScript (CJS)",
  json: "JSON",
  html: "HTML",
  htm: "HTML",
  css: "CSS",
  scss: "SCSS",
  md: "Markdown",
  markdown: "Markdown",
  py: "Python",
  rs: "Rust",
  go: "Go",
  yml: "YAML",
  yaml: "YAML",
  sql: "SQL",
};

/** Comment prefix per language id. */
const COMMENT_PREFIX: Record<string, string> = {
  py: "# ",
  sql: "-- ",
};

function detectLangFromExt(name: string): string | undefined {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return undefined;
  const ext = m[1];
  return LANG_LOADERS[ext] ? ext : undefined;
}

function detectLangFromContent(text: string): string | undefined {
  const head = text.slice(0, 2048);
  if (/<!doctype\s+html|<html[\s>]/i.test(head)) return "html";
  if (/^\s*\{[\s\S]*"[^"]+"\s*:/m.test(head) && /[\]}]\s*$/.test(head)) return "json";
  if (/^\s*package\s+main\b/m.test(head)) return "go";
  if (/^\s*fn\s+main\s*\(/m.test(head)) return "rs";
  if (/^\s*def\s+\w+\s*\([^)]*\)\s*:/m.test(head)) return "py";
  if (/^\s*(import\s+.*from\s+|export\s+(default\s+)?(?:const|function|class)\s+|const\s+\w+\s*[:=])/m.test(head)) return "js";
  if (/^\s*---\s*$/m.test(head) && /^\s*\w+:\s+/m.test(head)) return "yaml";
  if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/im.test(head)) return "sql";
  return undefined;
}

function langFor(name: string, explicitLang?: string, content?: string): Extension {
  const id = (explicitLang || detectLangFromExt(name) || (content ? detectLangFromContent(content) : undefined) || "").toLowerCase();
  const factory = LANG_LOADERS[id];
  return factory ? factory() : [];
}

function langIdOf(name: string, explicitLang?: string, content?: string): string | undefined {
  const id = (explicitLang || detectLangFromExt(name) || (content ? detectLangFromContent(content) : undefined) || "").toLowerCase();
  return id || undefined;
}

/* ----------------------------------------------------------------
   Per-doc word-wrap preference (module-level ref)
   Stores word-wrap prefs by docId, plus a "current language"
   key used by the fallback comment-toggle command.
   ---------------------------------------------------------------- */
type WrapMapValue = boolean | string;
const wordWrapByDoc: Map<string, WrapMapValue> = new Map();

/* ----------------------------------------------------------------
   Comment-toggle helper (uses CodeMirror's toggleComment when
   available; falls back to a small custom command that toggles
   a per-language prefix on each selected line, or the current
   line if no selection).
   ---------------------------------------------------------------- */
type LineEditSpec = { from: number; to: number; insert: string };

const lineCommentCmd: StateCommand = ({ state, dispatch }) => {
  if (toggleComment({ state, dispatch })) return true;

  const lang = wordWrapByDoc.get("__lang__");
  const langId = typeof lang === "string" ? lang : "js";
  const prefix = COMMENT_PREFIX[langId] || "// ";
  const sel = state.selection.main;
  const fromLine = state.doc.lineAt(sel.from);
  const toLine = state.doc.lineAt(sel.to);
  const changes: LineEditSpec[] = [];

  for (let n = fromLine.number; n <= toLine.number; n++) {
    const line = state.doc.line(n);
    const trimmed = line.text.trimStart();
    const leadingWS = line.text.slice(0, line.text.length - trimmed.length);
    const isCommented = trimmed.startsWith(prefix);
    const body = isCommented ? trimmed.slice(prefix.length) : prefix + trimmed;
    const insert = `${leadingWS}${body}`;
    const replaceFrom = line.from;
    const replaceTo = line.from + leadingWS.length + trimmed.length;
    changes.push({ from: replaceFrom, to: replaceTo, insert });
  }

  if (changes.length && dispatch) {
    const tr = state.update({
      changes: changes.sort((a, b) => b.from - a.from),
      selection: state.selection,
    });
    dispatch(tr);
    return true;
  }
  return false;
};

/* ----------------------------------------------------------------
   Goto-line: tiny StateCommand used by both the toolbar and
   the inline input.
   ---------------------------------------------------------------- */
const goToLineCmd = (line: number): StateCommand => ({ state, dispatch }) => {
  const total = state.doc.lines;
  const target = Math.max(1, Math.min(total, Math.floor(line)));
  const pos = state.doc.line(target).from;
  if (dispatch) {
    const tr = state.update({
      selection: EditorSelection.cursor(pos),
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    dispatch(tr);
  }
  return true;
};

/* ----------------------------------------------------------------
   Component
   ---------------------------------------------------------------- */
interface Props {
  docId: string;
  onCursor?: (c: { line: number; col: number }) => void;
}

export function CodeEditor({ docId, onCursor }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langComp = useRef(new Compartment()).current;
  const themeComp = useRef(new Compartment()).current;
  const wrapComp = useRef(new Compartment()).current;

  const doc = useDocs((s) => s.docs[docId]);
  const setRaw = useDocs((s) => s.setRaw);
  const setCursor = useDocs((s) => s.setCursor);
  const { resolved } = useTheme();

  const [gotoOpen, setGotoOpen] = useState(false);
  const [gotoValue, setGotoValue] = useState("");

  // Remember the current language so the fallback comment-toggle
  // command can pick the right prefix.
  const currentLangId = useMemo(
    () => langIdOf(doc?.name ?? "", doc?.language, doc?.raw ?? "") ?? "",
    [doc?.name, doc?.language, doc?.raw],
  );
  useEffect(() => {
    wordWrapByDoc.set("__lang__", currentLangId);
  }, [currentLangId]);

  /* -- Build the editor once per docId ------------------------ */
  useEffect(() => {
    if (!ref.current || !doc) return;
    const initialWrap = wordWrapByDoc.get(docId) ?? true;
    const state = EditorState.create({
      doc: doc.raw,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        history(),
        bracketMatching(),
        indentOnInput(),
        foldGutter(),
        autocompletion(),
        lintGutter(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        syntaxHighlighting(HighlightStyle.define([
          { tag: tagExtension.keyword, color: "var(--syn-keyword)", fontWeight: "600" },
          { tag: tagExtension.string,  color: "var(--syn-string)" },
          { tag: tagExtension.number,  color: "var(--syn-number)" },
          { tag: tagExtension.comment, color: "var(--syn-comment)", fontStyle: "italic" },
          { tag: tagExtension.variableName, color: "var(--syn-func)" },
          { tag: tagExtension.typeName, color: "var(--syn-type)" },
          { tag: tagExtension.tagName, color: "var(--syn-tag)" },
          { tag: tagExtension.attributeName, color: "var(--syn-attr)" },
        ])),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...foldKeymap,
          indentWithTab,
          { key: "Mod-/", run: lineCommentCmd },
        ]),
        langComp.of(langFor(doc.name, doc.language, doc.raw)),
        themeComp.of(EditorView.theme({}, { dark: resolved !== "light" })),
        wrapComp.of(initialWrap ? EditorView.lineWrapping : []),
        EditorView.updateListener.of((v: ViewUpdate) => {
          if (v.docChanged) setRaw(docId, v.state.doc.toString());
          if (v.selectionSet || v.docChanged) {
            const pos = v.state.selection.main.head;
            const line = v.state.doc.lineAt(pos);
            const c = { line: line.number, col: pos - line.from + 1 };
            setCursor(docId, c);
            onCursor?.(c);
          }
        }),
      ],
    });
    const v = new EditorView({ state, parent: ref.current });
    viewRef.current = v;
    return () => {
      v.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  /* -- Language swap when the doc's name or language changes -- */
  useEffect(() => {
    const v = viewRef.current;
    if (!v || !doc) return;
    v.dispatch({
      effects: langComp.reconfigure(langFor(doc.name, doc.language, doc.raw)),
    });
  }, [doc?.language, doc?.name, doc?.raw]);

  /* -- Theme swap -------------------------------------------- */
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    v.dispatch({
      effects: themeComp.reconfigure(EditorView.theme({}, { dark: resolved !== "light" })),
    });
  }, [resolved]);

  /* -- Toolbar handlers -------------------------------------- */
  const openGoTo = useCallback(() => {
    setGotoOpen(true);
    setGotoValue("");
    requestAnimationFrame(() => {
      const el = ref.current?.querySelector<HTMLInputElement>(".code-editor__goto input");
      el?.focus();
      el?.select();
    });
  }, []);

  const submitGoTo = useCallback(() => {
    const n = parseInt(gotoValue, 10);
    const v = viewRef.current;
    if (Number.isFinite(n) && n > 0 && v) {
      v.focus();
      goToLineCmd(n)({ state: v.state, dispatch: v.dispatch.bind(v) });
    }
    setGotoOpen(false);
    setGotoValue("");
  }, [gotoValue]);

  const cancelGoTo = useCallback(() => {
    setGotoOpen(false);
    setGotoValue("");
    viewRef.current?.focus();
  }, []);

  const toggleCommentAction = useCallback(() => {
    const v = viewRef.current;
    if (!v) return;
    v.focus();
    lineCommentCmd({ state: v.state, dispatch: v.dispatch.bind(v) });
  }, []);

  const toggleWrapAction = useCallback(() => {
    const v = viewRef.current;
    if (!v) return;
    const cur = wordWrapByDoc.get(docId);
    const next = typeof cur === "boolean" ? !cur : false;
    wordWrapByDoc.set(docId, next);
    v.dispatch({
      effects: wrapComp.reconfigure(next ? EditorView.lineWrapping : []),
    });
  }, [docId]);

  const formatAction = useCallback(() => {
    // TODO: integrate a real formatter (prettier / language server).
    console.info("[CodeEditor] Format (TODO)");
  }, []);

  /* -- Global window events ---------------------------------- */
  useEffect(() => {
    const onGoto = () => openGoTo();
    const onToggle = () => toggleCommentAction();
    const onFormat = () => formatAction();
    const onToggleWrap = () => toggleWrapAction();
    window.addEventListener("spark:code:gotoLine", onGoto);
    window.addEventListener("spark:code:toggleComment", onToggle);
    window.addEventListener("spark:code:format", onFormat);
    window.addEventListener("view.toggleWordWrap", onToggleWrap as EventListener);
    return () => {
      window.removeEventListener("spark:code:gotoLine", onGoto);
      window.removeEventListener("spark:code:toggleComment", onToggle);
      window.removeEventListener("spark:code:format", onFormat);
      window.removeEventListener("view.toggleWordWrap", onToggleWrap as EventListener);
    };
  }, [openGoTo, toggleCommentAction, formatAction, toggleWrapAction]);

  if (!doc) return null;

  const langLabel = LANG_LABELS[currentLangId] || (currentLangId ? currentLangId.toUpperCase() : "Plain");
  const cursor = doc.cursor;

  return (
    <div className="code-editor">
      <div className="code-editor__toolbar" role="toolbar" aria-label="Code editor toolbar">
        <Button
          size="sm"
          variant="ghost"
          icon="search"
          aria-label="Go to line"
          title="Go to line (Ctrl+G)"
          onClick={openGoTo}
        />
        <Button
          size="sm"
          variant="ghost"
          icon="quote"
          aria-label="Toggle line comment"
          title="Toggle line comment (Ctrl+/)"
          onClick={toggleCommentAction}
        />
        <Button
          size="sm"
          variant="ghost"
          icon="mode-rich"
          aria-label="Toggle word wrap"
          title="Toggle word wrap"
          onClick={toggleWrapAction}
        />
        <Button
          size="sm"
          variant="ghost"
          icon="code"
          aria-label="Format document"
          title="Format document"
          onClick={formatAction}
        />
        <span className="code-editor__divider" />
        {gotoOpen ? (
          <span className="code-editor__goto">
            <span className="code-editor__goto-label">Go to line:</span>
            <input
              type="text"
              inputMode="numeric"
              value={gotoValue}
              onChange={(e) => setGotoValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitGoTo();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelGoTo();
                }
              }}
              onBlur={() => setGotoOpen(false)}
              placeholder="1"
            />
          </span>
        ) : null}
        <span className="code-editor__spacer" />
        <span className="code-editor__status" aria-live="polite">
          <span>Ln {cursor.line}, Col {cursor.col}</span>
          <span className="code-editor__status-sep" />
          <span>UTF-8</span>
        </span>
      </div>
      <div className="code-editor__body">
        <span className="code-editor__langchip" aria-hidden>{langLabel}</span>
        <div ref={ref} className="editor editor--code" />
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------
   Public helper: re-exported for the file tree.
   ---------------------------------------------------------------- */
export function guessLang(name: string): string {
  return langIdOf(name) ?? "";
}
