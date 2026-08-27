# sparkEditor

> One window. Three modes. The file is the source of truth.

A desktop editor that unifies **Markdown**, **Rich Text**, and **Code** editing under a single Tauri + React shell. No cloud, no proprietary format, no lock-in — open any file, the correct mode is selected from its extension, and you can flip modes without leaving the document.

![Tauri](https://img.shields.io/badge/Tauri-2.x-24C8DB) ![React](https://img.shields.io/badge/React-18-61DAFB) ![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6) ![License](https://img.shields.io/badge/license-MIT-green)

---

## Why sparkEditor

Most editors pick a camp: Notion-style rich text, Obsidian-style markdown, or VS Code-style code. Writers, students, and developers end up context-switching between all three in a single sitting — a research note with a fenced snippet, a README with a diagram, a blog post with embedded code. sparkEditor collapses that into one binary, one window, one document model.

## Features

| Area | Detail |
|---|---|
| **Three editor surfaces** | `MarkdownEditor` (CodeMirror 6 + live preview + toolbar), `RichEditor` (Tiptap/ProseMirror), `CodeEditor` (CodeMirror 6 with language detection, gutter, bracket matching) |
| **One IR** | Intermediate Representation — a block-structured tree (`src/ir/types.ts:14`) shared by all surfaces. Mode switching is a remount, not a re-parse |
| **Document store** | Zustand + Immer (`src/store/documents.ts:50`), per-doc undo/redo (100 depth), dirty tracking, cursor position |
| **Shell** | Custom `TitleBar`, `SideBar` (recents), `CommandPalette`, `StatusBar`, `SplashScreen` — all animated with Framer Motion |
| **File as truth** | No project file. Markdown round-trips through CommonMark; code is raw text. Open the same `.md` in any other tool |
| **Native host** | Rust (Tauri 2) — `read_file`, `write_file`, `read_dir`, `stat`, dialogs, window-state, recents persisted to `app_data_dir/recents.json` |
| **Offline-first & theming** | Ships with Inter + JetBrains Mono (variable), three themes (light/dark/system) via CSS custom properties |
| **Browser fallback** | `src/bridge/commands.ts:41` mocks the FS when running in plain Vite so the renderer is testable without Tauri |

## Architecture at a glance

```
React renderer (webview) ──invoke()/listen()──► Tauri host (Rust) ──► OS filesystem
  Document store (Zustand) ─► IR (blocks) ─► Markdown|Rich|Code surface
  Command registry (palette, menus, keybindings)
  Theme + Toast + Motion
```

- Renderer cannot touch FS directly; host exposes a small enumerated command surface (`src-tauri/src/lib.rs:38`).
- All cross-boundary values are serialisable (strings/objects). Renderer never holds a Rust handle.
- File watcher (`notify` — planned) re-emits `file:changed` to the renderer, ignoring its own writes to avoid echo.

See [`explanation.md`](explanation.md) and [`docs/`](../docs/) for the full design discussion (Diátaxis layout).

## Quick start

```bash
# prerequisites: Node 20+, Rust stable, Tauri system deps
#   https://tauri.app/start/prerequisites/

npm install
npm run dev      # Vite on http://localhost:1420 — opens Tauri window if host built
npm run build    # tsc -b && vite build → dist/ → Tauri bundle
npm run tauri dev    # full Tauri dev with hot reload
npm run tauri build  # platform installer
```

Browser-only development (no Rust toolchain needed):

```bash
npm run dev
# renderer runs with in-memory MEMORY_FS (welcome.md, notes.md, hello.ts)
```

## Scripts

| Script | Purpose |
|---|---|
| `dev` | Vite dev server (port 1420, strict) |
| `build` | Type-check + production bundle |
| `preview` | Serve `dist/` locally |
| `typecheck` | `tsc -b --noEmit` |
| `lint` | ESLint (typescript-eslint + react-hooks) |
| `test` | Vitest (`vitest run`) |
| `tauri` | Tauri CLI passthrough |

## Keybindings

| Action | Shortcut |
|---|---|
| Command palette | `⌘/Ctrl + Shift + P` |
| New document | `⌘/Ctrl + N` |
| Open | `⌘/Ctrl + O` |
| Save | `⌘/Ctrl + S` |
| Close tab | `⌘/Ctrl + W` |
| Toggle sidebar | `⌘/Ctrl + B` |
| Cycle mode | via palette: *Switch Mode (cycle)* |
| Undo / Redo | `⌘/Ctrl + Z` / `⌘/Ctrl + Shift + Z` |

Full map: [`docs/reference/keybindings.md`](../docs/reference/keybindings.md).

## Project structure

```
sparkEditor-main/
  src/
    App.tsx                 # shell wiring: Theme, Tabs, editor routing, palette
    bridge/                 # typed Tauri invoke() wrappers + browser mock
    commands/registry.ts    # central command table (palette + menus + shortcuts)
    editor/
      CodeEditor/           # CodeMirror 6, language detection
      MarkdownEditor/       # CodeMirror 6 + toolbar + live preview (renderMd.ts)
      RichEditor/           # Tiptap surface
    ir/                     # Document/Block/Inline types + ids
    store/documents.ts      # Zustand document store
    shell/                  # TitleBar, SideBar, CommandPalette, SplashScreen
    ui/                     # Button, Dialog, Icon, StatusBar, Toast, etc.
    theme/                  # ThemeProvider, tokens.css, base.css
    motion/                 # Framer Motion re-export
    lib/                    # shiki, themeTokens
  src-tauri/
    src/lib.rs              # HostError, read_file, write_file, read_dir, stat
    Cargo.toml / tauri.conf.json
  public/                   # spark-mark.svg, etc.
  docs/  (repo root)         # Diátaxis docs (tutorials/how-to/reference/explanation)
  designlabs/ (repo root)    # static HTML+CSS prototypes of every UI element
```

## Documentation

| Document | Purpose |
|---|---|
| [`explanation.md`](explanation.md) | Why sparkEditor is shaped this way (this package) |
| [`description.md`](description.md) | 300-char summary for stores/listings |
| [`worklog.md`](worklog.md) | Chronological build log |
| [`changelog/`](changelog/) | Keep-a-Changelog history (SemVer) |
| [`../docs/README.md`](../docs/README.md) | System description (Diátaxis index) |
| [`../docs/explanation/`](../docs/explanation/) | Overview, architecture, data model, process model, … |
| [`../docs/reference/`](../docs/reference/) | Host commands, IR, renderer modules, build config |
| [`../docs/how-to/`](../docs/how-to/) | Add a mode, add a host command, use the watcher |
| [`../designlabs/`](../designlabs/) | Framework-free HTML prototypes + asset manifest |

## Configuration

- **Window** — `src-tauri/tauri.conf.json:13` — 1280×800, `decorations: false`, `titleBarStyle: "Overlay"` (macOS), CSP locked to `self`.
- **Vite** — `vite.config.ts:7` — path aliases (`@ui`, `@shell`, `@ir`, …), port 1420/1421 HMR, Tauri-aware host.
- **TypeScript** — `tsconfig.json` — strict, bundler resolution, aliased paths.
- **Rust profile** — `Cargo.toml:32` — `lto = true`, `opt-level = "s"`, `panic = "abort"` for minimal binary.

## Design labs

Framework-free previews of every UI piece. Open `designlabs/index.html` via `file://` — no build step.

```bash
python3 designlabs/tools/verify_assets.py  # validates manifest, SVG XML, wOF2 magic, hashes
```

## Contributing

1. Read [`docs/explanation/architecture.md`](../docs/explanation/architecture.md) and [`docs/reference/renderer-modules.md`](../docs/reference/renderer-modules.md).
2. Run `npm run typecheck && npm run lint` before opening a PR.
3. Keep the host small — put web-capable logic in the renderer.
4. Document new commands in `docs/reference/host-commands.md` and new UI in `designlabs/`.

## License

MIT. Fonts: Inter & JetBrains Mono (SIL OFL 1.1). Icons: first-party SVGs (`designlabs/assets/icons/`).
