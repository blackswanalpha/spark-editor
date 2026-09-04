# sparkBook — Explanation

*Understanding-oriented. Companion to `docs/explanation/` and the code in `src/` + `src-tauri/`.*

> If `README.md` says *how to run it* and `docs/reference/` says *what each part does*, this file says **why it is shaped this way**, what was deliberately *not* built, and what constraints make the current design the least-bad option.

---

## 1. What sparkBook is

A desktop editor — one window, one binary — that gives one writer one place to switch between three kinds of editing without leaving the document:

1. **Markdown** — plain text with lightweight markup, rendered live with toolbar + split preview.
2. **Rich text** — a WYSIWYG projection of the *same* document (Tiptap/ProseMirror) produced from a shared intermediate representation.
3. **Code** — a syntax-aware text surface (CodeMirror 6) with language detection by extension and Shiki-bridged highlighting.

It is a **Tauri host (Rust) wrapping a React renderer (TypeScript + Vite)**. The renderer is the only thing the user sees; Tauri provides the window, native dialogs, FS access, and OS integrations a browser cannot.

## 2. Why three modes in one window

Most editors commit to one camp. Notion (rich), Obsidian (markdown), VS Code (code) each optimise a single workflow and handle the others as an afterthought (paste a code block into Notion; paste rich text into VS Code). Writers, students, and developers all hit the gap in a single sitting — a README with a fenced diagram, a book chapter with a runnable snippet, lecture notes that mix prose, math, and code.

Switching apps breaks clipboard flows, selection history, and attention. sparkBook's bet is that **the document, not the app, is the unit of work**, and that the editor should follow the file rather than the other way around. Open any file, the mode follows its extension; flip modes from the palette without leaving the document.

## 3. Design tenets (and what they rule out)

| Tenet | Means | Rules out |
|---|---|---|
| **The file is the source of truth.** | No proprietary save format, no project file, no DB. `.md` is CommonMark; code is raw text. Open it elsewhere and it is the same file. | Lock-in, migrations, import/export. |
| **The renderer is a web app.** | React, TypeScript, Vite. Anything you can do in a browser you can do on the surface. | Native widget toolkits, per-platform UI forks. |
| **The shell is small.** | Rust does only what the browser cannot: `read_file`/`write_file`/`read_dir`/`stat`, dialogs, window geometry, recents, clipboard. See `src-tauri/src/lib.rs:38`. | Putting business logic in Rust. Logic lives in `src/`. |
| **One document, many views.** | An IR sits between the file and the surfaces. Each surface reads from and writes to it. See `src/ir/types.ts:14`. | Re-parsing one mode's output to produce another on every keystroke. |
| **Offline-first.** | No required network at runtime. Fonts and icons are bundled; renderer ships with no remote fetches. | Accounts, sync servers, collaboration (for now). |

## 4. Architecture: two processes, one contract

```
┌──────────────────────────────────── React renderer ──────────────────────┐
│  UI shell (TitleBar, SideBar, CommandPalette, StatusBar)  mode router    │
│  Document store (Zustand + Immer)  ⇄  IR  ⇄  Markdown | Rich | Code     │
│                                          │                               │
└──────────────────────────────────────────┼───────────────────────────────┘
                                           │ invoke() / listen()
┌──────────────────────────────────────────┼───────────────────────────────┐
│  Tauri host (Rust)  commands/fs, dialog, window, recents, clipboard       │
└──────────────────────────────────────────┼───────────────────────────────┘
                                           ▼
                                      OS filesystem
```

**Process boundary** (`src/bridge/commands.ts:13`):

- Renderer **invokes** named commands; host **emits** events (`file:changed`, `window:focus`).
- Every cross-boundary value is serialisable. The renderer never gets a Rust handle.
- Security is simple: renderer is a web page with no arbitrary-FS access; host's command surface is enumerated in `docs/reference/host-commands.md`.
- In plain Vite (no Tauri), `src/bridge/commands.ts:41` falls back to an in-memory `MEMORY_FS` so the UI is developable in the browser.

**Why not Electron** — Tauri's host is a few thousand lines of Rust, the binary stays small (`Cargo.toml:32` — `lto`, `opt-level="s"`, `panic="abort"`), and the renderer remains a normal Vite+React app any web developer can extend.

## 5. The IR: one model, three projections

```ts
// src/ir/types.ts:14
type Block =
  | { kind: "paragraph";  id: string; inlines: Inline[] }
  | { kind: "heading";    id: string; level: 1|2|3|4|5|6; inlines: Inline[] }
  | { kind: "blockquote"; id: string; children: Block[] }
  | { kind: "list";       id: string; ordered: boolean; items: ListItem[] }
  | { kind: "code";       id: string; lang?: string; value: string }
  | { kind: "thematic";   id: string }
  | { kind: "html";       id: string; value: string };
type Document = { version: 1; blocks: Block[] };
```

Without an IR, every mode switch would re-parse the outgoing surface into the incoming one. With an IR, switching is a **remount**: each surface walks the same tree and lays it out differently. Cursor/selection and undo history are keyed by stable block `id` (`src/ir/ids.ts`), so they survive the switch.

Practical consequences:

- **Markdown** — serialise IR → CommonMark; edit as plain text, diff back to IR per block. Lossy only for `html` blocks (stored verbatim).
- **Rich** — one React component per block/inline; React events bubble as IR patches; DOM reconciles to IR after every patch.
- **Code** — single `code` block; CodeMirror 6 owns the buffer (`src/editor/CodeEditor/index.tsx:22`), IR tracks the whole block as a unit.

Ids are **stable within a session, regenerated on load** — saved files stay human-diffable; the on-disk format never carries editor internals. Not in the IR by design: cursor/selection, undo stacks, comments/presence (future overlays keyed by `BlockId`).

## 6. Data flow (open → edit → save)

1. `⌘O` / *File → Open* → host dialog returns `{ path, contents }`.
2. Renderer dispatches `document:open` → store parses bytes → IR, picks mode (`App.tsx:34` — `pickMode`), mounts the surface, pushes to recents (host-side `recents.json`).
3. Edits: surface → `store.setRaw`/`setIr` → IR → re-render. Markdown and rich surfaces share the IR, so the off-screen surface stays consistent for free.
4. `⌘S` → serialise IR (CommonMark for `.md`, raw for code) → `write_file` on host → file watcher ignores its own write. Toast on error.

Dirty tracking and undo live in `src/store/documents.ts:28` — `past`/`future` stacks per doc, capped at 100 snapshots.

## 7. What sparkBook is not (intentionally)

- **Not a cloud editor** — no account, no sync, no server. Put your folder in git/Syncthing/Dropbox if you want sync.
- **Not an IDE** — no DAP, no LSP, no project indexing. Code mode is a *good text surface*, not IntelliJ.
- **Not a Notion clone** — no databases, blocks-as-API, or permissions.
- **Not multi-user** — single window, single user, local files. Real-time collaboration would be built as an overlay on block ids later, not by complicating the core.

These are not "not yet" features; they are scope guards. Each would pull the data model, security, and distribution story in a different direction.

## 8. Trade-offs and open seams

| Decision | Upside | Cost / what to watch |
|---|---|---|
| IR not persisted | Files stay portable and diffable | Format upgrades need a migrator (`version: 1` leaves room) |
| Code as single `code` block | Simple, undo delegates to CodeMirror history | Coarser IR undo granularity for code; acceptable today |
| Store in renderer (not host) | Undo/mode switch are fast, synchronous | Session state must be rehydrated via host on boot (`app_data_dir`) |
| `decorations: false` + custom TitleBar | Full design control, `TitleBar.tsx` is the chrome | Must re-implement drag, snap, and window controls per platform |
| Browser-mock FS | Fast iteration without Rust toolchain | Mock must stay faithful to `HostError` variants (`lib.rs:4`) or tests drift |

Future seams already marked in the code: the file-watch event (`file:changed`) is wired for `notify` but guarded to ignore self-writes; the host's `recents_*` and `app_state_*` commands anticipate window-geometry and last-session restore.

## 9. Further reading

- `docs/explanation/overview.md` — product narrative and audience.
- `docs/explanation/architecture.md` — process boundary and layer talk table.
- `docs/explanation/data-model.md` — full IR rationale, per-surface mapping, on-disk boundary.
- `docs/reference/renderer-modules.md` and `docs/reference/host-commands.md` — factual lookups.
- `designlabs/` — the same UI rendered as plain HTML+CSS for visual verification without a build.

