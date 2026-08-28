/* ============================================================
   sparkEditor · src/editor/CodeEditor/languages.ts
   Central registry of supported programming languages and
   their CodeMirror 6 extensions.

   Exports:
     LANG_LOADERS, LANG_LABELS, LANG_COMMENT, LANG_SHIKI,
     LANG_ICON, LANG_FILE_EXTRA, ALL_LANGS, detectLangFromExt,
     detectLangFromContent, langFor, langIdOf, guessLang,
     fileIconFor.

   The DART/FLUTTER grammar is hand-rolled as a CodeMirror 6
   `StreamParser`. All other languages without an official
   `@codemirror/lang-*` package are built from a small
   `makeSimpleParser` helper.
   ============================================================ */

import { StreamLanguage, type StreamParser } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { javascript as jsLang } from "@codemirror/lang-javascript";
import { python as pyLang } from "@codemirror/lang-python";
import { html as htmlLang } from "@codemirror/lang-html";
import { css as cssLang } from "@codemirror/lang-css";
import { json as jsonLang } from "@codemirror/lang-json";
import { rust as rustLang } from "@codemirror/lang-rust";
import { go as goLang } from "@codemirror/lang-go";
import { yaml as yamlLang } from "@codemirror/lang-yaml";
import { sql as sqlLang } from "@codemirror/lang-sql";
import { markdown as mdLang } from "@codemirror/lang-markdown";
import type { Extension } from "@codemirror/state";

void t;

export type LangId = string;
export type LangFactory = () => Extension;

/* ============================================================
   DART / FLUTTER STREAM PARSER
   ============================================================ */
type DartState = { inTriple: '"' | "'" | null; inBlockComment: boolean };

const DART_KEYWORDS = new Set<string>([
  "abstract", "as", "assert", "async", "await", "break", "case", "catch",
  "class", "const", "continue", "covariant", "default", "deferred", "do",
  "dynamic", "else", "enum", "export", "extends", "extension", "external",
  "factory", "final", "finally", "for", "Function", "get", "hide", "if",
  "implements", "import", "in", "interface", "is", "library", "mixin", "new",
  "on", "operator", "part", "rethrow", "return", "sealed", "set", "show",
  "static", "super", "switch", "sync", "this", "throw", "try", "typedef",
  "var", "void", "when", "while", "with", "yield", "late", "required", "record",
]);
const DART_TYPES = new Set<string>([
  "bool", "double", "int", "num", "String", "List", "Map", "Set", "Iterable",
  "Future", "Stream", "Symbol", "Object", "dynamic", "void", "var",
]);
const DART_CONSTS = new Set<string>(["true", "false", "null"]);
const DART_PUNCT = "{}[]();,.<>:?!&|~^%+-=*/\\";

const dartStartState = (): DartState => ({ inTriple: null, inBlockComment: false });

const dartParser: StreamParser<DartState> = {
  name: "dart",
  startState: dartStartState,
  languageData: {
    commentTokens: { line: "//", block: { open: "/*", close: "*/" } },
    closeBrackets: { brackets: ["(", "[", "{", "'", '"'] },
  },
  token(stream, state) {
    if (state.inTriple) {
      const quote = state.inTriple;
      while (!stream.eol()) {
        const ch = stream.next();
        if (ch === "\\") { stream.next(); continue; }
        if (ch === "$") {
          if (stream.peek() === "{") return "string";
          if (/[A-Za-z_]/.test(stream.peek() ?? "")) {
            stream.match(/[A-Za-z_][A-Za-z0-9_]*/);
            return "variableName";
          }
        }
        if (ch === quote && stream.peek() === quote) {
          stream.next();
          state.inTriple = null;
          return "string";
        }
      }
      return "string";
    }
    if (state.inBlockComment) {
      while (!stream.eol()) {
        const ch = stream.next();
        if (ch === "*" && stream.peek() === "/") {
          stream.next();
          state.inBlockComment = false;
          return "comment";
        }
      }
      return "comment";
    }
    if (stream.eatSpace()) return null;
    if (stream.match("//")) { stream.skipToEnd(); return "comment"; }
    if (stream.match("/*")) { state.inBlockComment = true; return "comment"; }
    if (stream.match(/r'[^'\n]*'/)) return "string";
    if (stream.match(/r"[^"\n]*"/)) return "string";
    if (stream.match('"""')) { state.inTriple = '"'; return "string"; }
    if (stream.match("'''")) { state.inTriple = "'"; return "string"; }
    const quote = stream.peek();
    if (quote === '"' || quote === "'") {
      stream.next();
      while (!stream.eol()) {
        const ch = stream.next();
        if (ch === "\\") { stream.next(); continue; }
        if (ch === "$") {
          if (stream.peek() === "{") return "string";
          if (/[A-Za-z_]/.test(stream.peek() ?? "")) {
            stream.match(/[A-Za-z_][A-Za-z0-9_]*/);
            return "variableName";
          }
        }
        if (ch === quote) return "string";
      }
      return "string";
    }
    if (stream.match(/^0[xX][0-9a-fA-F]+/)) return "number";
    if (stream.match(/^0[bB][01]+/)) return "number";
    if (stream.match(/^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/)) return "number";
    if (stream.match(/^@[A-Za-z_][A-Za-z0-9_.]*/)) return "attributeName";
    const idMatch = stream.match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (idMatch && typeof idMatch !== "boolean") {
      const w = idMatch[0];
      if (DART_KEYWORDS.has(w)) return "keyword";
      if (DART_TYPES.has(w)) return "typeName";
      if (DART_CONSTS.has(w)) return "atom";
      return "variableName";
    }
    if (DART_PUNCT.indexOf(stream.peek() ?? "") >= 0) {
      stream.next();
      return "operator";
    }
    stream.next();
    return null;
  },
};

/* ============================================================
   makeSimpleParser
   ============================================================ */
type SimpleSpec = {
  readonly name: string;
  readonly keywords?: ReadonlySet<string>;
  readonly types?: ReadonlySet<string>;
  readonly constants?: ReadonlySet<string>;
  readonly lineComment: string;
  readonly blockComment?: { readonly open: string; readonly close: string };
  readonly stringDelims?: readonly string[];
  readonly rawPrefix?: string;
  readonly supportsInterpolation?: boolean;
  readonly punctuation?: string;
  readonly extra?: { readonly match: RegExp; readonly tag: string }[];
};

const DEFAULT_PUNCT = "{}[]();,.<>:?!&|~^%+-=*/\\";

function makeSimpleParser(spec: SimpleSpec): StreamParser<unknown> {
  const punct = spec.punctuation ?? DEFAULT_PUNCT;
  const strDelims = spec.stringDelims ?? [`"`, "'"];
  const keywords = spec.keywords ?? new Set<string>();
  const types = spec.types ?? new Set<string>();
  const constants = spec.constants ?? new Set<string>();
  const extras = spec.extra ?? [];

  type State = { inBlock: boolean };
  const startState = (): State => ({ inBlock: false });

  return {
    name: spec.name,
    startState,
    languageData: {
      commentTokens: spec.blockComment
        ? { line: spec.lineComment, block: spec.blockComment }
        : { line: spec.lineComment },
      closeBrackets: { brackets: ["(", "[", "{", ...strDelims] },
    },
    token(stream, stateRaw) {
      const state = stateRaw as State;
      if (state.inBlock) {
        while (!stream.eol()) {
          const ch = stream.next();
          if (spec.blockComment && ch === spec.blockComment.close[0] && stream.match(spec.blockComment.close.slice(1))) {
            state.inBlock = false;
            return "comment";
          }
        }
        return "comment";
      }
      if (stream.eatSpace()) return null;
      if (spec.lineComment && stream.match(spec.lineComment)) { stream.skipToEnd(); return "comment"; }
      if (spec.blockComment && stream.match(spec.blockComment.open)) { state.inBlock = true; return "comment"; }
      for (const e of extras) if (stream.match(e.match)) return e.tag;
      if (spec.rawPrefix && stream.match(new RegExp(`^${spec.rawPrefix}['"]`))) {
        const delim = stream.peek();
        while (!stream.eol()) {
          const ch = stream.next();
          if (ch === "\\") { stream.next(); continue; }
          if (ch === delim) return "string";
        }
        return "string";
      }
      const d = stream.peek();
      if (d && strDelims.indexOf(d) >= 0) {
        stream.next();
        while (!stream.eol()) {
          const ch = stream.next();
          if (ch === "\\") { stream.next(); continue; }
          if (spec.supportsInterpolation && ch === "$") {
            if (stream.peek() === "{") return "string";
            if (/[A-Za-z_]/.test(stream.peek() ?? "")) {
              stream.match(/[A-Za-z_][A-Za-z0-9_]*/);
              return "variableName";
            }
          }
          if (ch === d) return "string";
        }
        return "string";
      }
      if (stream.match(/^0[xX][0-9a-fA-F]+/)) return "number";
      if (stream.match(/^0[bB][01]+/)) return "number";
      if (stream.match(/^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/)) return "number";
      const idMatch = stream.match(/^[A-Za-z_][A-Za-z0-9_]*/);
      if (idMatch && typeof idMatch !== "boolean") {
        const w = idMatch[0];
        if (keywords.has(w)) return "keyword";
        if (types.has(w)) return "typeName";
        if (constants.has(w)) return "atom";
        return "variableName";
      }
      if (d && punct.indexOf(d) >= 0) { stream.next(); return "operator"; }
      stream.next();
      return null;
    },
  };
}

/* ============================================================
   Keyword / type / constant sets
   ============================================================ */
const C_KEYWORDS = new Set([
  "auto", "break", "case", "char", "const", "continue", "default", "do",
  "double", "else", "enum", "extern", "float", "for", "goto", "if",
  "inline", "int", "long", "register", "restrict", "return", "short",
  "signed", "sizeof", "static", "struct", "switch", "typedef", "union",
  "unsigned", "void", "volatile", "while", "_Bool", "_Complex", "_Imaginary",
  "nullptr", "true", "false",
]);
const C_TYPES = new Set([
  "size_t", "ssize_t", "ptrdiff_t", "int8_t", "int16_t", "int32_t", "int64_t",
  "uint8_t", "uint16_t", "uint32_t", "uint64_t", "FILE", "NULL",
]);
const CPP_KEYWORDS = new Set(["...C_KEYWORDS", "alignas", "alignof", "and", "and_eq", "asm", "bitand", "bitor", "bool", "catch", "class", "concept", "consteval", "constexpr", "constinit", "const_cast", "co_await", "co_return", "co_yield", "decltype", "delete", "dynamic_cast", "explicit", "export", "friend", "mutable", "namespace", "new", "noexcept", "not", "not_eq", "operator", "or", "or_eq", "private", "protected", "public", "reinterpret_cast", "requires", "static_assert", "static_cast", "template", "this", "thread_local", "throw", "try", "typeid", "typename", "using", "virtual", "xor", "xor_eq"]);
const CPP_TYPES = new Set(["std", "string", "vector", "map", "set", "pair", "tuple", "array", "deque", "list", "queue", "stack", "optional", "variant", "shared_ptr", "unique_ptr", "weak_ptr", "function", "initializer_list", "string_view"]);
const JAVA_KEYWORDS = new Set(["abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "const", "continue", "default", "do", "double", "else", "enum", "extends", "final", "finally", "float", "for", "if", "implements", "import", "instanceof", "int", "interface", "long", "new", "package", "private", "protected", "public", "return", "short", "static", "super", "switch", "this", "throw", "try", "void", "volatile", "while", "var", "record", "sealed"]);
const JAVA_TYPES = new Set(["String", "Object", "Integer", "Long", "Double", "Float", "Boolean", "List", "ArrayList", "Map", "HashMap", "Set", "HashSet", "Stream", "Optional", "Throwable", "Exception"]);
const JAVA_CONSTS = new Set(["true", "false", "null"]);
const KOTLIN_KEYWORDS = new Set(["as", "break", "class", "continue", "do", "else", "false", "for", "fun", "if", "in", "interface", "is", "null", "object", "package", "return", "super", "this", "throw", "true", "try", "val", "var", "when", "while", "by", "import", "abstract", "data", "enum", "final", "internal", "open", "operator", "out", "override", "private", "protected", "public", "sealed", "suspend", "tailrec"]);
const KOTLIN_TYPES = new Set(["Any", "Boolean", "Byte", "Char", "Double", "Float", "Int", "Long", "Short", "String", "Unit", "Nothing", "Array", "List", "Map", "Set", "Sequence", "Pair"]);
const SCALA_KEYWORDS = new Set(["case", "class", "def", "do", "else", "extends", "false", "for", "if", "import", "match", "new", "null", "object", "override", "package", "private", "protected", "return", "sealed", "super", "this", "throw", "trait", "try", "true", "type", "val", "var", "while", "with", "yield"]);
const SCALA_TYPES = new Set(["Any", "Boolean", "Byte", "Char", "Double", "Float", "Int", "Long", "Option", "String", "Unit", "List", "Map", "Set", "Array", "Some", "None"]);
const CLOJURE_KEYWORDS = new Set(["def", "defn", "defn-", "defmacro", "defmulti", "defmethod", "defrecord", "deftype", "defonce", "ns", "require", "use", "import", "let", "do", "if", "when", "cond", "case", "loop", "recur", "fn", "throw", "try", "catch", "finally", "and", "or", "not", "true", "false", "nil", "quote", "atom", "comment", "declare"]);
const CLOJURE_TYPES = new Set(["PersistentList", "PersistentVector", "PersistentHashMap", "LazySeq"]);
const CSHARP_KEYWORDS = new Set(["abstract", "as", "base", "bool", "break", "byte", "case", "catch", "char", "class", "const", "continue", "decimal", "default", "delegate", "do", "double", "else", "enum", "event", "explicit", "extern", "false", "finally", "fixed", "float", "for", "foreach", "goto", "if", "implicit", "in", "int", "interface", "internal", "is", "lock", "long", "namespace", "new", "null", "object", "operator", "out", "override", "params", "private", "protected", "public", "readonly", "ref", "return", "sbyte", "sealed", "short", "sizeof", "static", "string", "struct", "switch", "this", "throw", "true", "try", "typeof", "uint", "ulong", "unchecked", "unsafe", "ushort", "using", "var", "virtual", "void", "volatile", "while", "async", "await", "yield"]);
const CSHARP_TYPES = new Set(["String", "Int32", "Int64", "Object", "List", "Dictionary", "HashSet", "Task", "Action", "Func", "DateTime", "Exception"]);
const FSHARP_KEYWORDS = new Set(["abstract", "and", "as", "assert", "base", "begin", "class", "default", "delegate", "do", "done", "downcast", "downto", "elif", "else", "end", "exception", "extern", "false", "finally", "for", "fun", "function", "if", "in", "inherit", "inline", "interface", "internal", "lazy", "let", "match", "member", "module", "mutable", "namespace", "new", "null", "of", "open", "or", "override", "private", "public", "rec", "return", "static", "struct", "then", "to", "true", "try", "type", "upcast", "use", "val", "void", "when", "while", "with", "yield", "not"]);
const FSHARP_TYPES = new Set(["string", "int", "int16", "int32", "int64", "uint", "float", "float32", "single", "double", "decimal", "bool", "char", "byte", "obj", "unit", "list", "array", "seq", "option", "Result", "Map", "Set", "BigInt"]);
const SWIFT_KEYWORDS = new Set(["class", "deinit", "enum", "extension", "func", "import", "init", "inout", "internal", "let", "open", "operator", "private", "protocol", "public", "static", "struct", "subscript", "typealias", "var", "break", "case", "continue", "default", "defer", "do", "else", "fallthrough", "for", "guard", "if", "in", "repeat", "return", "switch", "where", "while", "as", "Any", "catch", "false", "is", "nil", "super", "self", "Self", "throw", "throws", "true", "try", "async", "await", "actor", "some", "any", "final", "lazy", "override", "weak", "get", "set"]);
const SWIFT_TYPES = new Set(["String", "Int", "UInt", "Double", "Float", "Bool", "Array", "Dictionary", "Set", "Optional", "Result", "Error", "Range", "Sequence", "Collection", "AnyObject", "Void", "Character", "Data", "URL", "UUID", "Date"]);
const OBJC_KEYWORDS = new Set(["auto", "break", "case", "char", "const", "continue", "default", "do", "double", "else", "enum", "extern", "float", "for", "goto", "if", "inline", "int", "long", "register", "return", "short", "signed", "sizeof", "static", "struct", "switch", "typedef", "union", "unsigned", "void", "volatile", "while", "self", "super", "nil", "YES", "NO", "TRUE", "FALSE", "nonatomic", "atomic", "strong", "weak", "copy", "readonly", "readwrite", "property", "synthesize", "dynamic", "end", "import", "in", "inout", "out"]);
const OBJC_TYPES = new Set(["NSString", "NSArray", "NSDictionary", "NSNumber", "NSSet", "NSData", "NSDate", "NSError", "NSURL", "NSObject", "NSMutableArray", "NSMutableDictionary", "NSInteger", "BOOL", "UIView", "UIViewController", "UIImage", "UIColor", "UIFont", "UITableView"]);
const PHP_KEYWORDS = new Set(["abstract", "and", "array", "as", "break", "callable", "case", "catch", "class", "clone", "const", "continue", "declare", "default", "die", "do", "echo", "else", "elseif", "empty", "endfor", "endforeach", "endif", "endswitch", "endwhile", "eval", "exit", "extends", "final", "finally", "fn", "for", "foreach", "function", "global", "goto", "if", "implements", "include", "include_once", "instanceof", "interface", "isset", "list", "match", "namespace", "new", "or", "print", "private", "protected", "public", "readonly", "require", "require_once", "return", "static", "switch", "throw", "trait", "try", "unset", "use", "var", "while", "xor", "yield"]);
const PHP_TYPES = new Set(["bool", "int", "float", "string", "array", "iterable", "object", "void", "mixed", "null", "false", "true", "self", "static", "Exception", "Error", "Throwable", "Closure", "Generator"]);
const RUBY_KEYWORDS = new Set(["BEGIN", "END", "alias", "and", "begin", "break", "case", "class", "def", "defined?", "do", "else", "elsif", "end", "ensure", "false", "for", "if", "in", "module", "next", "nil", "not", "or", "redo", "rescue", "retry", "return", "self", "super", "then", "true", "undef", "unless", "until", "when", "while", "yield"]);
const RUBY_TYPES = new Set(["Array", "Hash", "String", "Symbol", "Integer", "Float", "Numeric", "Object", "Class", "Module", "Proc", "Lambda", "Range", "Set", "Enumerable", "IO", "File", "Regexp", "Time", "Exception", "StandardError"]);
const PERL_KEYWORDS = new Set(["if", "elsif", "else", "unless", "while", "until", "for", "foreach", "do", "sub", "my", "our", "local", "use", "no", "require", "package", "BEGIN", "END", "return", "last", "next", "redo", "goto", "print", "split", "join", "map", "grep", "sort", "push", "pop", "shift", "defined", "die", "warn", "exit", "eval"]);
const PERL_TYPES = new Set(["scalar", "array", "hash", "glob", "ref", "true", "false", "undef"]);
const LUA_KEYWORDS = new Set([
  "and", "break", "do", "else", "elseif", "end", "false", "for", "function",
  "goto", "if", "in", "local", "nil", "not", "or", "repeat", "return",
  "then", "true", "until", "while",
]);
const LUA_TYPES = new Set(["self", "string", "number", "boolean", "nil", "table", "function", "print", "pairs", "ipairs", "tostring", "tonumber", "type", "error", "pcall", "require"]);
const R_KEYWORDS = new Set(["...C_KEYWORDS", "if", "else", "while", "for", "repeat", "function", "in", "next", "break", "TRUE", "FALSE", "NULL", "Inf", "NaN", "NA"]);
const R_TYPES = new Set(["c", "list", "vector", "matrix", "array", "data.frame", "factor", "numeric", "character", "logical", "integer", "function"]);
const HASKELL_KEYWORDS = new Set(["case", "class", "data", "deriving", "do", "else", "if", "import", "in", "infix", "infixl", "infixr", "instance", "let", "module", "newtype", "of", "then", "type", "where", "forall"]);
const HASKELL_TYPES = new Set(["Int", "Integer", "Float", "Double", "Bool", "Char", "String", "Maybe", "Either", "IO", "List", "Ordering", "Eq", "Ord", "Show", "Num", "Functor", "Applicative", "Monad"]);
const OCAML_KEYWORDS = new Set(["and", "as", "assert", "begin", "class", "do", "done", "downto", "else", "end", "exception", "external", "false", "for", "fun", "function", "if", "in", "include", "inherit", "initializer", "lazy", "let", "match", "method", "module", "mutable", "new", "object", "of", "open", "or", "private", "rec", "sig", "struct", "then", "to", "true", "try", "type", "val", "virtual", "when", "while", "with"]);
const OCAML_TYPES = new Set(["int", "float", "char", "string", "bool", "unit", "list", "array", "ref", "option", "result"]);
const ELIXIR_KEYWORDS = new Set(["after", "and", "case", "catch", "cond", "def", "defp", "defmodule", "defprotocol", "defmacro", "defstruct", "else", "end", "fn", "for", "if", "in", "import", "nil", "not", "or", "quote", "raise", "receive", "rescue", "try", "unless", "use", "when", "while", "with", "do", "true", "false"]);
const ELIXIR_TYPES = new Set(["atom", "binary", "float", "function", "integer", "list", "map", "nil", "tuple", "String", "Atom", "Integer", "Float", "List", "Map", "Tuple", "Function"]);
const ERLANG_KEYWORDS = new Set(["after", "and", "andalso", "case", "catch", "cond", "div", "end", "fun", "if", "let", "not", "of", "or", "orelse", "receive", "rem", "try", "when", "true", "false", "undefined", "module", "export", "import"]);
const ERLANG_TYPES = new Set(["atom", "binary", "boolean", "float", "function", "integer", "list", "map", "nil", "number", "tuple"]);
const BASH_KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "case", "esac", "for", "while", "until", "do", "done", "function", "in"]);
const BASH_TYPES = new Set(["true", "false", "PATH", "HOME", "USER", "SHELL", "PWD"]);
const POWERSHELL_KEYWORDS = new Set(["if", "else", "elseif", "for", "foreach", "while", "do", "until", "switch", "function", "param", "return", "throw", "try", "catch", "finally", "begin", "process", "end", "in", "not", "and", "or", "class", "enum", "break", "continue", "exit", "true", "false", "null"]);
const POWERSHELL_TYPES = new Set(["string", "int", "long", "double", "bool", "char", "object", "array", "hashtable"]);
const TOML_KEYWORDS = new Set(["true", "false", "inf", "nan"]);
const TOML_TYPES: ReadonlySet<string> = new Set<string>();
const INI_KEYWORDS = new Set(["true", "false", "yes", "no", "on", "off"]);
const INI_TYPES: ReadonlySet<string> = new Set<string>();
const DOCKER_KEYWORDS = new Set(["FROM", "RUN", "CMD", "LABEL", "EXPOSE", "ENV", "ADD", "COPY", "ENTRYPOINT", "VOLUME", "USER", "WORKDIR", "ARG", "HEALTHCHECK", "AS"]);
const DOCKER_TYPES: ReadonlySet<string> = new Set<string>();
const MAKE_KEYWORDS = new Set(["ifeq", "ifneq", "ifdef", "ifndef", "else", "endif", "include", "define", "endef", "override", "export", "unexport", "vpath", "subst", "patsubst", "filter", "sort", "wildcard", "foreach", "if", "or", "and", "call", "eval", "error", "warning"]);
const MAKE_TYPES: ReadonlySet<string> = new Set<string>();
const NGINX_KEYWORDS = new Set(["http", "server", "location", "events", "upstream", "if", "return", "rewrite", "listen", "root", "proxy_pass", "proxy_set_header", "include", "worker_processes", "worker_connections", "user", "pid"]);
const NGINX_TYPES = new Set(["main", "http", "server", "location", "events", "stream", "mail", "on", "off", "always"]);
const TERRAFORM_KEYWORDS = new Set(["resource", "module", "variable", "output", "provider", "data", "locals", "terraform", "lifecycle", "depends_on", "count", "for_each", "dynamic", "true", "false", "null", "if", "for", "in", "required_providers", "required_version"]);
const TERRAFORM_TYPES = new Set(["string", "number", "bool", "list", "set", "map", "object", "tuple", "any"]);
const GRAPHQL_KEYWORDS = new Set(["query", "mutation", "subscription", "fragment", "type", "interface", "union", "enum", "input", "schema", "scalar", "extend", "implements", "directive", "on", "true", "false", "null"]);
const GRAPHQL_TYPES = new Set([
  "Int", "Float", "String", "Boolean", "ID", "DateTime", "Date", "Time",
  "EmailAddress", "URL", "UUID",
]);
const SASS_KEYWORDS = new Set([
  "extend", "include", "mixin", "function", "if", "else", "for", "each",
  "while", "return", "debug", "warn", "error", "import", "use", "forward",
  "true", "false", "null",
]);
const LESS_KEYWORDS = new Set([
  "import", "include", "extend", "mixin", "function", "if", "else", "for",
  "each", "while", "return", "true", "false", "when", "guarded", "default",
  "plugin", "keyframes", "global",
]);

/* ============================================================
   Parser instances
   ============================================================ */
const cParser = makeSimpleParser({
  name: "c",
  keywords: C_KEYWORDS,
  types: C_TYPES,
  constants: new Set(["true", "false", "NULL"]),
  lineComment: "//",
  blockComment: { open: "/*", close: "*/" },
  stringDelims: ['"', "'"],
  extra: [
    { match: /^\s*#\s*include/, tag: "keyword" },
    { match: /^\s*#\s*define/, tag: "keyword" },
    { match: /^\s*#\s*(if|ifdef|ifndef|else|elif|endif|pragma|error|warning)\b/, tag: "keyword" },
  ],
});
const cppParser = makeSimpleParser({
  name: "cpp",
  keywords: CPP_KEYWORDS,
  types: CPP_TYPES,
  constants: new Set(["true", "false", "nullptr", "NULL"]),
  lineComment: "//",
  blockComment: { open: "/*", close: "*/" },
  stringDelims: ['"', "'"],
  extra: [
    { match: /^\s*#\s*include/, tag: "keyword" },
    { match: /^\s*#\s*define/, tag: "keyword" },
    { match: /^\s*#\s*(if|ifdef|ifndef|else|elif|endif|pragma|error|warning)\b/, tag: "keyword" },
  ],
});
const javaParser = makeSimpleParser({
  name: "java",
  keywords: JAVA_KEYWORDS,
  types: JAVA_TYPES,
  constants: JAVA_CONSTS,
  lineComment: "//",
  blockComment: { open: "/*", close: "*/" },
  stringDelims: ['"', "'"],
  extra: [{ match: /^@[A-Za-z_][A-Za-z0-9_.]*/, tag: "attributeName" }],
});
const kotlinParser = makeSimpleParser({
  name: "kotlin",
  keywords: KOTLIN_KEYWORDS,
  types: KOTLIN_TYPES,
  constants: new Set(["true", "false", "null"]),
  lineComment: "//",
  blockComment: { open: "/*", close: "*/" },
  stringDelims: ['"', "'"],
  extra: [{ match: /^@[A-Za-z_][A-Za-z0-9_.]*/, tag: "attributeName" }],
});
const scalaParser = makeSimpleParser({
  name: "scala",
  keywords: SCALA_KEYWORDS,
  types: SCALA_TYPES,
  constants: new Set(["true", "false", "null"]),
  lineComment: "//",
  blockComment: { open: "/*", close: "*/" },
  stringDelims: ['"', "'"],
  extra: [{ match: /^@[A-Za-z_][A-Za-z0-9_.]*/, tag: "attributeName" }],
});
const clojureParser = makeSimpleParser({
  name: "clojure",
  keywords: CLOJURE_KEYWORDS,
  types: CLOJURE_TYPES,
  constants: new Set(["true", "false", "nil"]),
  lineComment: ";",
  stringDelims: ['"'],
  punctuation: "{}[]();,`#'~^@",
});
const csharpParser = makeSimpleParser({
  name: "csharp",
  keywords: CSHARP_KEYWORDS,
  types: CSHARP_TYPES,
  constants: new Set(["true", "false", "null"]),
  lineComment: "//",
  blockComment: { open: "/*", close: "*/" },
  stringDelims: ['"', "'", "`"],
});
const fsharpParser = makeSimpleParser({
  name: "fsharp",
  keywords: FSHARP_KEYWORDS,
  types: FSHARP_TYPES,
  constants: new Set(["true", "false"]),
  lineComment: "//",
  blockComment: { open: "(*", close: "*)" },
  stringDelims: ['"'],
});
const vbParser = makeSimpleParser({
  name: "vb",
  keywords: new Set([
    "AddHandler", "AddressOf", "Alias", "And", "AndAlso", "As", "Boolean",
    "ByRef", "Byte", "ByVal", "Call", "Case", "Catch", "CBool", "CByte",
    "CChar", "CDate", "CDbl", "CDec", "CInt", "Class", "CLng", "CObj",
    "Const", "Continue", "CSByte", "CShort", "CSng", "CStr", "CType",
    "CUInt", "CULng", "CUShort", "Date", "Decimal", "Declare", "Default",
    "Delegate", "Dim", "DirectCast", "Do", "Double", "Each", "Else",
    "ElseIf", "End", "EndIf", "Enum", "Erase", "Error", "Event", "Exit",
    "Explicit", "False", "Finally", "For", "Friend", "Function", "Get",
    "GetType", "Global", "GoSub", "GoTo", "Handles", "If", "Implements",
    "Imports", "In", "Inherits", "Integer", "Interface", "Is", "IsNot",
    "Let", "Lib", "Like", "Long", "Loop", "Me", "Mod", "Module", "MustInherit",
    "MustOverride", "MyBase", "MyClass", "Namespace", "Narrowing", "New",
    "Next", "Not", "Nothing", "NotInheritable", "NotOverridable", "Object",
    "Of", "On", "Operator", "Option", "Optional", "Or", "OrElse", "Out",
    "Overloads", "Overridable", "Overrides", "ParamArray", "Partial",
    "Private", "Property", "Protected", "Public", "RaiseEvent", "ReadOnly",
    "ReDim", "REM", "RemoveHandler", "Resume", "Return", "SByte", "Select",
    "Set", "Shadows", "Shared", "Short", "Single", "Static", "Step", "Stop",
    "String", "Structure", "Sub", "SyncLock", "Then", "Throw", "To", "True",
    "Try", "TryCast", "TypeOf", "UInteger", "ULong", "UShort", "Using",
    "Variant", "Wend", "When", "While", "Widening", "With", "WithEvents",
    "WriteOnly", "Xor",
  ]),
  types: new Set<string>(),
  constants: new Set(["True", "False", "Nothing"]),
  lineComment: "'",
  stringDelims: ['"'],
  punctuation: "{}[]();,.<>:?!&|~^%+-=*/\\",
});
const swiftParser = makeSimpleParser({
  name: "swift",
  keywords: SWIFT_KEYWORDS,
  types: SWIFT_TYPES,
  constants: new Set(["true", "false", "nil"]),
  lineComment: "//",
  blockComment: { open: "/*", close: "*/" },
  stringDelims: ['"'],
  extra: [{ match: /^@[A-Za-z_][A-Za-z0-9_.]*/, tag: "attributeName" }],
});
const objcParser = makeSimpleParser({
  name: "objc",
  keywords: OBJC_KEYWORDS,
  types: OBJC_TYPES,
  constants: new Set(["true", "false", "nil", "YES", "NO", "TRUE", "FALSE", "NULL"]),
  lineComment: "//",
  blockComment: { open: "/*", close: "*/" },
  stringDelims: ['"', "'"],
  extra: [{ match: /^@[A-Za-z_][A-Za-z0-9_]*/, tag: "attributeName" }],
});
const phpParser = makeSimpleParser({
  name: "php",
  keywords: PHP_KEYWORDS,
  types: PHP_TYPES,
  constants: new Set(["true", "false", "null"]),
  lineComment: "//",
  blockComment: { open: "/*", close: "*/" },
  stringDelims: ['"', "'"],
  supportsInterpolation: true,
  rawPrefix: "r",
  extra: [{ match: /^\$[A-Za-z_][A-Za-z0-9_]*/, tag: "variableName" }],
});
const rubyParser = makeSimpleParser({
  name: "ruby",
  keywords: RUBY_KEYWORDS,
  types: RUBY_TYPES,
  constants: new Set(["true", "false", "nil"]),
  lineComment: "#",
  blockComment: { open: "=begin", close: "=end" },
  stringDelims: ['"', "'"],
  supportsInterpolation: true,
  extra: [
    { match: /^@[A-Za-z_][A-Za-z0-9_]*/, tag: "attributeName" },
    { match: /^@@[A-Za-z_][A-Za-z0-9_]*/, tag: "variableName" },
    { match: /^:[A-Za-z_][A-Za-z0-9_]*/, tag: "atom" },
  ],
});
const perlParser = makeSimpleParser({
  name: "perl",
  keywords: PERL_KEYWORDS,
  types: PERL_TYPES,
  constants: new Set(["true", "false", "undef"]),
  lineComment: "#",
  stringDelims: ['"', "'", "`"],
  extra: [
    { match: /^\$[A-Za-z_][A-Za-z0-9_]*/, tag: "variableName" },
    { match: /^@[A-Za-z_][A-Za-z0-9_]*/, tag: "variableName" },
    { match: /^%[A-Za-z_][A-Za-z0-9_]*/, tag: "variableName" },
  ],
});
const luaParser = makeSimpleParser({
  name: "lua",
  keywords: LUA_KEYWORDS,
  types: LUA_TYPES,
  constants: new Set(["true", "false", "nil"]),
  lineComment: "--",
  blockComment: { open: "--[[", close: "]]" },
  stringDelims: ['"', "'"],
});
const rParser = makeSimpleParser({
  name: "r",
  keywords: R_KEYWORDS,
  types: R_TYPES,
  constants: new Set(["TRUE", "FALSE", "NULL", "NA", "NaN", "Inf"]),
  lineComment: "#",
  stringDelims: ['"', "'"],
});
const haskellParser = makeSimpleParser({
  name: "haskell",
  keywords: HASKELL_KEYWORDS,
  types: HASKELL_TYPES,
  constants: new Set(["True", "False"]),
  lineComment: "--",
  blockComment: { open: "{-", close: "-}" },
  stringDelims: ['"'],
});
const ocamlParser = makeSimpleParser({
  name: "ocaml",
  keywords: OCAML_KEYWORDS,
  types: OCAML_TYPES,
  constants: new Set(["true", "false"]),
  lineComment: "",
  blockComment: { open: "(*", close: "*)" },
  stringDelims: ['"'],
});
const elixirParser = makeSimpleParser({
  name: "elixir",
  keywords: ELIXIR_KEYWORDS,
  types: ELIXIR_TYPES,
  constants: new Set(["true", "false", "nil"]),
  lineComment: "#",
  stringDelims: ['"', "'"],
  supportsInterpolation: true,
  extra: [
    { match: /:[A-Za-z_][A-Za-z0-9_?!]*/, tag: "atom" },
    { match: /^@[A-Za-z_][A-Za-z0-9_.]*/, tag: "attributeName" },
  ],
});
const erlangParser = makeSimpleParser({
  name: "erlang",
  keywords: ERLANG_KEYWORDS,
  types: ERLANG_TYPES,
  constants: new Set(["true", "false", "undefined"]),
  lineComment: "%",
  stringDelims: ['"'],
  extra: [{ match: /^[A-Z][A-Za-z0-9_]*/, tag: "variableName" }],
});
const shellscriptParser = makeSimpleParser({
  name: "shell",
  keywords: BASH_KEYWORDS,
  types: BASH_TYPES,
  constants: new Set(["true", "false"]),
  lineComment: "#",
  stringDelims: ['"', "'"],
  supportsInterpolation: true,
  extra: [{ match: /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/, tag: "variableName" }],
});
const powershellParser = makeSimpleParser({
  name: "powershell",
  keywords: POWERSHELL_KEYWORDS,
  types: POWERSHELL_TYPES,
  constants: new Set(["$true", "$false", "$null"]),
  lineComment: "#",
  blockComment: { open: "<#", close: "#>" },
  stringDelims: ['"', "'"],
  supportsInterpolation: true,
  extra: [{ match: /^\$[A-Za-z_][A-Za-z0-9_:?]*/, tag: "variableName" }],
});
const batParser = makeSimpleParser({
  name: "bat",
  keywords: new Set([
    "if", "else", "for", "in", "do", "goto", "call", "set", "setlocal",
    "endlocal", "echo", "exit", "rem", "not", "exist", "errorlevel",
    "defined", "cmdextversion", "equ", "neq", "lss", "leq", "gtr", "geq",
  ]),
  types: new Set<string>(),
  constants: new Set<string>(),
  lineComment: "REM",
  stringDelims: ['"'],
  extra: [
    { match: /^\$\{[A-Za-z_][A-Za-z0-9_]*\}/, tag: "variableName" },
    { match: /^\^[A-Za-z_]/, tag: "operator" },
  ],
});
const tomlParser = makeSimpleParser({
  name: "toml",
  keywords: TOML_KEYWORDS,
  types: TOML_TYPES,
  constants: new Set(["true", "false", "inf", "nan"]),
  lineComment: "#",
  stringDelims: ['"', "'"],
  extra: [{ match: /^\[\[?[^[\]]+\]?\]/, tag: "typeName" }],
});
const iniParser = makeSimpleParser({
  name: "ini",
  keywords: INI_KEYWORDS,
  types: INI_TYPES,
  constants: new Set<string>(),
  lineComment: ";",
  stringDelims: ['"'],
  extra: [{ match: /^\[[^\]]+\]/, tag: "typeName" }],
});
const dockerfileParser = makeSimpleParser({
  name: "dockerfile",
  keywords: DOCKER_KEYWORDS,
  types: DOCKER_TYPES,
  constants: new Set<string>(),
  lineComment: "#",
  stringDelims: ['"', "'"],
  extra: [{ match: /^[A-Z_][A-Z0-9_]*(?=\s*=)/, tag: "variableName" }],
});
const makefileParser = makeSimpleParser({
  name: "makefile",
  keywords: MAKE_KEYWORDS,
  types: MAKE_TYPES,
  constants: new Set<string>(),
  lineComment: "#",
  stringDelims: ['"', "'"],
  extra: [
    { match: /^[A-Za-z0-9_./-]+(?=\s*:)/, tag: "typeName" },
    { match: /^\$[(\{][A-Za-z0-9_]+[)\}]/, tag: "variableName" },
    { match: /^\$[A-Za-z@<^*?]/, tag: "variableName" },
  ],
});
const nginxParser = makeSimpleParser({
  name: "nginx",
  keywords: NGINX_KEYWORDS,
  types: NGINX_TYPES,
  constants: new Set<string>(),
  lineComment: "#",
  stringDelims: ['"', "'"],
  extra: [{ match: /^[A-Za-z_][A-Za-z0-9_]*\s+/, tag: "attributeName" }],
});
const terraformParser = makeSimpleParser({
  name: "terraform",
  keywords: TERRAFORM_KEYWORDS,
  types: TERRAFORM_TYPES,
  constants: new Set(["true", "false", "null"]),
  lineComment: "#",
  blockComment: { open: "/*", close: "*/" },
  stringDelims: ['"'],
  extra: [{ match: /^\$\{[A-Za-z_][A-Za-z0-9_]*\}/, tag: "variableName" }],
});
const graphqlParser = makeSimpleParser({
  name: "graphql",
  keywords: GRAPHQL_KEYWORDS,
  types: GRAPHQL_TYPES,
  constants: new Set(["true", "false", "null"]),
  lineComment: "#",
  stringDelims: ['"'],
  extra: [
    { match: /^\$\w+/, tag: "variableName" },
    { match: /^@[A-Za-z_][A-Za-z0-9_]*/, tag: "attributeName" },
  ],
});
const sassParser = makeSimpleParser({
  name: "sass",
  keywords: SASS_KEYWORDS,
  types: new Set<string>(),
  constants: new Set(["true", "false", "null"]),
  lineComment: "//",
  stringDelims: ['"', "'"],
  extra: [
    { match: /^\$[A-Za-z_][A-Za-z0-9_-]*/, tag: "variableName" },
    { match: /^&/, tag: "operator" },
  ],
});
const lessParser = makeSimpleParser({
  name: "less",
  keywords: LESS_KEYWORDS,
  types: new Set<string>(),
  constants: new Set(["true", "false"]),
  lineComment: "//",
  blockComment: { open: "/*", close: "*/" },
  stringDelims: ['"', "'"],
  extra: [{ match: /^@[A-Za-z_][A-Za-z0-9_-]*/, tag: "variableName" }],
});
const vueParser = makeSimpleParser({
  name: "vue",
  keywords: new Set<string>(),
  types: new Set<string>(),
  constants: new Set<string>(),
  lineComment: "",
  blockComment: { open: "<!--", close: "-->" },
  stringDelims: ['"', "'"],
  extra: [{ match: /^\{\{[^}]*\}\}/, tag: "meta" }],
});
const svelteParser = makeSimpleParser({
  name: "svelte",
  keywords: new Set<string>(),
  types: new Set<string>(),
  constants: new Set<string>(),
  lineComment: "",
  blockComment: { open: "<!--", close: "-->" },
  stringDelims: ['"', "'"],
  extra: [{ match: /^\{[#:@/][^}]*\}/, tag: "meta" }],
});
/* ============================================================
   LANG_LOADERS / LANG_LABELS / LANG_COMMENT / LANG_SHIKI /
   LANG_ICON / LANG_FILE_EXTRA / ALL_LANGS / detection
   ============================================================ */

export const LANG_LOADERS: Record<string, LangFactory> = {
  ts:  () => jsLang({ jsx: false, typescript: true }),
  mts: () => jsLang({ jsx: false, typescript: true }),
  cts: () => jsLang({ jsx: false, typescript: true }),
  tsx: () => jsLang({ jsx: true,  typescript: true }),
  js:  () => jsLang({ jsx: false, typescript: false }),
  mjs: () => jsLang({ jsx: false, typescript: false }),
  cjs: () => jsLang({ jsx: false, typescript: false }),
  jsx: () => jsLang({ jsx: true,  typescript: false }),
  vue: () => StreamLanguage.define(vueParser),
  svelte: () => StreamLanguage.define(svelteParser),
  html: () => htmlLang(),
  htm:  () => htmlLang(),
  css:  () => cssLang(),
  scss: () => cssLang(),
  sass: () => StreamLanguage.define(sassParser),
  less: () => StreamLanguage.define(lessParser),
  json: () => jsonLang(),
  jsonc: () => jsonLang(),
  yaml: () => yamlLang(),
  yml:  () => yamlLang(),
  toml: () => StreamLanguage.define(tomlParser),
  ini:  () => StreamLanguage.define(iniParser),
  conf: () => StreamLanguage.define(iniParser),
  xml: () => htmlLang(),
  xhtml: () => htmlLang(),
  svg: () => htmlLang(),
  py:  () => pyLang(),
  rs:  () => rustLang(),
  go:  () => goLang(),
  c:   () => StreamLanguage.define(cParser),
  h:   () => StreamLanguage.define(cParser),
  cpp: () => StreamLanguage.define(cppParser),
  cc:  () => StreamLanguage.define(cppParser),
  cxx: () => StreamLanguage.define(cppParser),
  hpp: () => StreamLanguage.define(cppParser),
  hxx: () => StreamLanguage.define(cppParser),
  java: () => StreamLanguage.define(javaParser),
  kt:  () => StreamLanguage.define(kotlinParser),
  kts: () => StreamLanguage.define(kotlinParser),
  scala: () => StreamLanguage.define(scalaParser),
  clj: () => StreamLanguage.define(clojureParser),
  cs:  () => StreamLanguage.define(csharpParser),
  csx: () => StreamLanguage.define(csharpParser),
  fs:  () => StreamLanguage.define(fsharpParser),
  fsx: () => StreamLanguage.define(fsharpParser),
  vb:  () => StreamLanguage.define(vbParser),
  swift: () => StreamLanguage.define(swiftParser),
  m:   () => StreamLanguage.define(objcParser),
  mm:  () => StreamLanguage.define(objcParser),
  php: () => StreamLanguage.define(phpParser),
  rb:  () => StreamLanguage.define(rubyParser),
  pl:  () => StreamLanguage.define(perlParser),
  pm:  () => StreamLanguage.define(perlParser),
  lua: () => StreamLanguage.define(luaParser),
  r:   () => StreamLanguage.define(rParser),
  hs:  () => StreamLanguage.define(haskellParser),
  ml:  () => StreamLanguage.define(ocamlParser),
  ex:  () => StreamLanguage.define(elixirParser),
  exs: () => StreamLanguage.define(elixirParser),
  erl: () => StreamLanguage.define(erlangParser),
  dart: () => StreamLanguage.define(dartParser),
  sh:  () => StreamLanguage.define(shellscriptParser),
  bash: () => StreamLanguage.define(shellscriptParser),
  zsh: () => StreamLanguage.define(shellscriptParser),
  ps1: () => StreamLanguage.define(powershellParser),
  bat:  () => StreamLanguage.define(batParser),
  cmd:  () => StreamLanguage.define(batParser),
  makefile: () => StreamLanguage.define(makefileParser),
  mk:       () => StreamLanguage.define(makefileParser),
  dockerfile: () => StreamLanguage.define(dockerfileParser),
  nginx: () => StreamLanguage.define(nginxParser),
  tf:   () => StreamLanguage.define(terraformParser),
  hcl:  () => StreamLanguage.define(terraformParser),
  graphql: () => StreamLanguage.define(graphqlParser),
  gql:     () => StreamLanguage.define(graphqlParser),
  md:       () => mdLang(),
  markdown: () => mdLang(),
  sql: () => sqlLang(),
};

export const LANG_LABELS: Record<string, string> = {
  ts: "TypeScript",
  mts: "TypeScript (ESM)",
  cts: "TypeScript (CJS)",
  tsx: "TypeScript JSX",
  js: "JavaScript",
  mjs: "JavaScript (ESM)",
  cjs: "JavaScript (CJS)",
  jsx: "JavaScript JSX",
  vue: "Vue",
  svelte: "Svelte",
  html: "HTML",
  htm: "HTML",
  css: "CSS",
  scss: "SCSS",
  sass: "Sass",
  less: "Less",
  json: "JSON",
  jsonc: "JSON (with comments)",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  ini: "INI",
  conf: "Config",
  xml: "XML",
  xhtml: "XHTML",
  svg: "SVG",
  py: "Python",
  rs: "Rust",
  go: "Go",
  c: "C",
  h: "C/C++ Header",
  cpp: "C++",
  cc: "C++",
  cxx: "C++",
  hpp: "C++ Header",
  hxx: "C++ Header",
  java: "Java",
  kt: "Kotlin",
  kts: "Kotlin Script",
  scala: "Scala",
  clj: "Clojure",
  cs: "C#",
  csx: "C# Script",
  fs: "F#",
  fsx: "F# Script",
  vb: "Visual Basic",
  swift: "Swift",
  m: "Objective-C",
  mm: "Objective-C++",
  php: "PHP",
  rb: "Ruby",
  pl: "Perl",
  pm: "Perl Module",
  lua: "Lua",
  r: "R",
  hs: "Haskell",
  ml: "OCaml",
  ex: "Elixir",
  exs: "Elixir Script",
  erl: "Erlang",
  dart: "Dart",
  sh: "Shell",
  bash: "Bash",
  zsh: "Zsh",
  ps1: "PowerShell",
  bat: "Batch",
  cmd: "Batch",
  makefile: "Makefile",
  mk: "Makefile",
  dockerfile: "Dockerfile",
  nginx: "Nginx",
  tf: "Terraform",
  hcl: "HCL",
  graphql: "GraphQL",
  gql: "GraphQL",
  md: "Markdown",
  markdown: "Markdown",
  sql: "SQL",
};

export const LANG_COMMENT: Record<string, string> = {
  ts: "// ", tsx: "// ", js: "// ", jsx: "// ",
  mjs: "// ", cjs: "// ", mts: "// ", cts: "// ",
  vue: "<!-- ", svelte: "<!-- ",
  css: "/* ", scss: "// ", sass: "// ", less: "// ",
  json: "// ", yaml: "# ", toml: "# ", ini: "; ",
  py: "# ", rs: "// ", go: "// ",
  c: "// ", h: "// ", cpp: "// ", cc: "// ", cxx: "// ", hpp: "// ", hxx: "// ",
  java: "// ", kt: "// ", kts: "// ", scala: "// ", clj: "; ",
  cs: "// ", csx: "// ", fs: "// ", fsx: "// ", vb: "' ",
  swift: "// ", m: "// ", mm: "// ",
  php: "// ", rb: "# ", pl: "# ", pm: "# ",
  lua: "-- ", r: "# ", hs: "-- ", ml: "(* ",
  ex: "# ", exs: "# ", erl: "% ",
  dart: "// ",
  sh: "# ", bash: "# ", zsh: "# ", ps1: "# ",
  bat: ":: ", cmd: ":: ",
  makefile: "# ", mk: "# ",
  dockerfile: "# ", nginx: "# ",
  tf: "# ", hcl: "# ",
  graphql: "# ", gql: "# ",
  md: "<!-- ", markdown: "<!-- ",
  sql: "-- ",
  xml: "<!-- ", xhtml: "<!-- ", svg: "<!-- ",
  html: "<!-- ", htm: "<!-- ",
};

export const LANG_SHIKI: Record<string, string> = {
  ts: "ts", mts: "ts", cts: "ts", tsx: "tsx",
  js: "js", mjs: "js", cjs: "js", jsx: "jsx",
  vue: "vue", svelte: "svelte",
  html: "html", htm: "html",
  css: "css", scss: "scss", sass: "sass", less: "less",
  json: "json", jsonc: "json",
  yaml: "yaml", yml: "yaml",
  toml: "toml", ini: "ini", conf: "ini",
  xml: "html", xhtml: "html", svg: "html",
  py: "python", rs: "rust", go: "go",
  c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hxx: "cpp",
  java: "java", kt: "kotlin", kts: "kotlin", scala: "scala", clj: "clojure",
  cs: "csharp", csx: "csharp", fs: "fsharp", fsx: "fsharp", vb: "vb",
  swift: "swift", m: "objective-c", mm: "objective-c",
  php: "php", rb: "ruby", pl: "perl", pm: "perl",
  lua: "lua", r: "r", hs: "haskell", ml: "ocaml",
  ex: "elixir", exs: "elixir", erl: "erlang",
  dart: "dart",
  sh: "bash", bash: "bash", zsh: "bash",
  ps1: "powershell",
  bat: "bat", cmd: "bat",
  makefile: "makefile", mk: "makefile",
  dockerfile: "dockerfile", nginx: "nginx",
  tf: "terraform", hcl: "terraform",
  graphql: "graphql", gql: "graphql",
  md: "md", markdown: "md",
  sql: "sql",
};

export const LANG_ICON: Record<string, string> = {
  ts: "file-code", mts: "file-code", cts: "file-code", tsx: "file-code",
  js: "file-code", mjs: "file-code", cjs: "file-code", jsx: "file-code",
  vue: "file-code", svelte: "file-code",
  html: "file-code", htm: "file-code",
  css: "file-code", scss: "file-code", sass: "file-code", less: "file-code",
  json: "file-code", jsonc: "file-code",
  yaml: "file-code", yml: "file-code",
  toml: "file-code", ini: "file-code", conf: "file-code",
  xml: "file-code", xhtml: "file-code", svg: "file-code",
  py: "file-code", rs: "file-code", go: "file-code",
  c: "file-code", h: "file-code",
  cpp: "file-code", cc: "file-code", cxx: "file-code", hpp: "file-code", hxx: "file-code",
  java: "file-code", kt: "file-code", kts: "file-code", scala: "file-code", clj: "file-code",
  cs: "file-code", csx: "file-code", fs: "file-code", fsx: "file-code", vb: "file-code",
  swift: "file-code", m: "file-code", mm: "file-code",
  php: "file-code", rb: "file-code", pl: "file-code", pm: "file-code",
  lua: "file-code", r: "file-code", hs: "file-code", ml: "file-code",
  ex: "file-code", exs: "file-code", erl: "file-code",
  dart: "lang-dart",
  sh: "file-code", bash: "file-code", zsh: "file-code",
  ps1: "file-code", bat: "file-code", cmd: "file-code",
  makefile: "file-code", mk: "file-code",
  dockerfile: "file-code", nginx: "file-code",
  tf: "file-code", hcl: "file-code",
  graphql: "file-code", gql: "file-code",
  md: "file-code", markdown: "file-code",
  sql: "file-code",
};

export const LANG_FILE_EXTRA: Record<string, string> = {
  typescript: "ts",
  javascript: "js",
  python: "py",
  rust: "rs",
  shell: "bash",
  sh: "sh",
  bash: "bash",
  markdown: "md",
  yml: "yaml",
  dockerfile: "dockerfile",
  makefile: "makefile",
  "objective-c": "m",
  objc: "m",
  cpp: "cpp",
  cxx: "cpp",
  csharp: "cs",
  "c#": "cs",
  fsharp: "fs",
  "f#": "fs",
  visualbasic: "vb",
  "visual-basic": "vb",
  vb: "vb",
  "tsconfig.json": "json",
  "package.json": "json",
  "package-lock.json": "json",
  ".eslintrc.json": "json",
  "composer.json": "json",
  "manifest.json": "json",
  ".prettierrc": "json",
  ".prettierrc.json": "json",
  jsconfig: "json",
  pyproject: "toml",
  cargo: "toml",
  "rust-toolchain": "toml",
  "go.mod": "toml",
  "go.sum": "toml",
  "pubspec.yaml": "yaml",
  "pubspec.yml": "yaml",
  "docker-compose.yml": "yaml",
  "docker-compose.yaml": "yaml",
  ".gitlab-ci.yml": "yaml",
  ".travis.yml": "yaml",
  "vite.config.js": "js",
  "vite.config.ts": "ts",
  "vite.config.mjs": "js",
  "webpack.config.js": "js",
  "rollup.config.js": "js",
  "tailwind.config.js": "js",
  "tailwind.config.ts": "ts",
  "postcss.config.js": "js",
  "jest.config.js": "js",
  "jest.config.ts": "ts",
  "babel.config.js": "js",
  ".babelrc": "json",
  ".babelrc.json": "json",
  "eslint.config.js": "js",
  "eslint.config.mjs": "js",
  "eslint.config.cjs": "js",
  ".eslintrc.js": "js",
  ".eslintrc.cjs": "js",
  ".eslintrc.yml": "yaml",
  ".eslintrc.yaml": "yaml",
  tsconfig: "json",
  nginx: "nginx",
  "apache2.conf": "ini",
  "httpd.conf": "ini",
  "php.ini": "ini",
  "user.ini": "ini",
  "my.cnf": "ini",
  ".npmrc": "ini",
  ".yarnrc": "ini",
  ".editorconfig": "ini",
  ".gitconfig": "ini",
  ".dockerignore": "ini",
  ".gitignore": "ini",
  ".env": "ini",
  ".envrc": "bash",
  "terraform.tfvars": "ini",
  rakefile: "ruby",
  gemfile: "ruby",
  brewfile: "ruby",
  podfile: "ruby",
  fastfile: "ruby",
  appfile: "ruby",
  matchfile: "ruby",
  deliverfile: "ruby",
  supplyfile: "ruby",
  scanfile: "ruby",
  snapfile: "ruby",
  gymfile: "ruby",
  notaryfile: "ruby",
  vagrantfile: "ruby",
  berksfile: "ruby",
  policyfile: "ruby",
  thorfile: "ruby",
  guardfile: "ruby",
  capfile: "ruby",
  cheffile: "ruby",
  halite: "ruby",
  mspec: "ruby",
  puppetfile: "ruby",
  ".rspec": "ruby",
  ".rubocop.yml": "yaml",
  ".rubocop.yaml": "yaml",
};

export const ALL_LANGS: string[] = Object.keys(LANG_LOADERS);

export function detectLangFromExt(name: string): string | undefined {
  if (!name) return undefined;
  const lower = name.toLowerCase();
  const stem = lower.split(/[\\/]/).pop() ?? "";

  if (stem === "dockerfile" || stem === "containerfile") return "dockerfile";
  if (
    stem === "makefile" || stem === "gnumakefile" ||
    stem === "rakefile" || stem === "gemfile" || stem === "brewfile"
  ) return "makefile";
  if (stem === "nginx.conf") return "nginx";
  if (
    stem === ".bashrc" || stem === ".bash_profile" || stem === ".bash_login" ||
    stem === ".bash_aliases" || stem === ".zshrc" || stem === ".zshenv" ||
    stem === ".profile" || stem === ".zprofile"
  ) return "bash";

  if (LANG_FILE_EXTRA[stem]) return LANG_FILE_EXTRA[stem];

  const m = stem.match(/\.([a-z0-9+#-]+)$/);
  if (m) {
    const ext = m[1];
    if (LANG_LOADERS[ext]) return ext;
  }

  return undefined;
}

export function detectLangFromContent(text: string): string | undefined {
  const head = text.slice(0, 2048);
  if (/<!doctype\s+html|<html[\s>]/i.test(head)) return "html";
  if (/^\s*<\?xml[\s>]/i.test(head) || /^\s*<svg[\s>]/i.test(head)) return "xml";
  if (/^\s*\{[\s\S]*"[^"]+"\s*:/m.test(head) && /[\}\]]\s*$/.test(head)) return "json";
  if (/^\s*package\s+main\b/m.test(head)) return "go";
  if (/^\s*fn\s+main\s*\(/m.test(head)) return "rs";
  if (/^\s*def\s+\w+\s*\([^)]*\)\s*:/m.test(head)) return "py";
  if (/^\s*(import\s+.*from\s+|export\s+(default\s+)?(?:const|function|class)\s+|const\s+\w+\s*[:=])/m.test(head)) return "js";
  if (/^\s*---\s*$/m.test(head) && /^\s*\w+:\s+/m.test(head)) return "yaml";
  if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/im.test(head)) return "sql";
  if (/^\s*(FROM|RUN|CMD|LABEL|EXPOSE|ENV)\b/m.test(head) && /\bAS\s+\w+/i.test(head)) return "dockerfile";
  if (/^\s*(if|else|fi|for|while|do|done)\b/m.test(head) && /\$\{?\w+\}?/.test(head)) return "sh";
  if (/^\s*(server|upstream|location|events|http)\s*\{/m.test(head)) return "nginx";
  if (/^\s*resource\s+"[^"]+"\s+"/m.test(head)) return "tf";
  if (/^\s*(query|mutation|subscription|fragment|type\s+\w+)\s+\w+/m.test(head) && /\{[\s\S]*\}/.test(head)) return "graphql";
  if (/^\s*<\?php\b/.test(head)) return "php";
  const shebang = head.match(/^\s*#!.*\b(python|ruby|node|bash|sh|perl|lua)\b/);
  if (shebang) {
    const k = shebang[1]?.toLowerCase();
    if (k === "python") return "py";
    if (k === "ruby") return "rb";
    if (k === "node") return "js";
    if (k === "bash" || k === "sh") return "sh";
    if (k === "perl") return "pl";
    if (k === "lua") return "lua";
  }
  return undefined;
}

export function langFor(name: string, explicitLang?: string, content?: string): Extension {
  const id = (
    explicitLang
    || detectLangFromExt(name)
    || (content ? detectLangFromContent(content) : undefined)
    || ""
  ).toLowerCase();
  const factory = LANG_LOADERS[id];
  return factory ? factory() : [];
}

export function langIdOf(name: string, explicitLang?: string, content?: string): string | undefined {
  const id = (
    explicitLang
    || detectLangFromExt(name)
    || (content ? detectLangFromContent(content) : undefined)
    || ""
  ).toLowerCase();
  return id || undefined;
}

export function guessLang(name: string): string {
  return langIdOf(name) ?? "";
}

export function fileIconFor(name: string): string {
  const id = langIdOf(name);
  if (!id) return "file";
  return LANG_ICON[id] ?? "file-code";
}

/**
 * Resolve a filename to our internal `LangId` (the file extension
 * key used throughout this module). Useful for the side-bar file
 * tree so it can render the real language logo via
 * `<LangLogo langId={…} />`. Returns `undefined` for non-code files
 * so the caller can fall back to a generic file icon.
 */
export function langIdForFile(filename: string): string | undefined {
  return langIdOf(filename);
}
