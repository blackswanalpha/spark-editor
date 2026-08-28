# Changelog

All notable changes to **sparkEditor** are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Dates are `YYYY-MM-DD` (EAT). See `../worklog.md` for the day-to-day build log and `../explanation.md` for design rationale.

---

## [Unreleased]

### Added
- Nothing yet.

### Changed
- Nothing yet.

### Fixed
- Nothing yet.

---

## [0.2.0] - 2026-08-28

### Added
- **Launch & setup icons** — regenerated `src-tauri/icons/` via `cargo tauri icon` from `_master.png` (1024). Proper desktop assets: `32x32.png`, `64x64.png`, `128x128.png`, `128x128@2x.png` (256), `icon.png` (512), `icon.icns` (macOS, 64 KB), `icon.ico` (Windows). `src-tauri/tauri.conf.json:32` — `bundle.icon` updated, `publisher/category/shortDescription/longDescription` set, `createUpdaterArtifacts: true`, and `linux`/`windows`/`macOS` bundle targets wired so installers create correct desktop shortcuts / Start-Menu entries / `.desktop` files.
- **OTA updates** — `tauri-plugin-updater` (Rust `src-tauri/src/lib.rs:275` + `@tauri-apps/plugin-updater` JS) + `capabilities/{default,desktop}.json` (`updater:default`, `updater:allow-check`, `updater:allow-download-and-install`, `process:allow-restart`). New `src/bridge/updater.ts:1` (`checkForUpdates()`, `checkForUpdatesOnBoot()`) — silent boot check (4 s delay) and manual **Help → Check for Updates…** (`src/commands/registry.ts:336` + `src/App.tsx:229`). `tauri.conf.json:plugins.updater` pubkey `RWQ8g3GffHCTjah…krV` and endpoint `https://github.com/blackswanalpha/spark-editor/releases/latest/download/latest.json`. CSP extended to GitHub.
- **File explorer** — `src/shell/SideBar.tsx` ports the designlab (`designlabs/labs/explorer.html`) to React. Lazy `read_dir` per directory, keyboard navigation (↑↓→← Enter Home End), toolbar (new file / refresh / collapse / show hidden), recents tab preserved, A11Y-004 tree-view contract.
- **Explorer store** — `src/store/explorer.ts` — zustand + immer, lazy `children` cache, `setRoot` / `toggleDir` / `refresh` / `collapseAll` / `setSelected` / `createFile` actions, `subscribeToFileChanges` wires host `file:changed` events to tree refresh.
- **Host commands** — `create_file(path, contents?)` (refuses to overwrite, returns `FileStat`) and `mkdir(path)` (`mkdir -p`, idempotent) added to `src-tauri/src/lib.rs`. Wrappers in `src/bridge/commands.ts`. Browser mocks in `MEMORY_FS` / `MEMORY_DIRS`. Docs: `docs/reference/host-commands.md`.
- **File-watcher bridge** — `watchPath` / `unwatchPath` typed wrappers and `onFileChanged` event subscriber in `src/bridge/{commands,events}.ts`. Browser mock returns a fake `WatchId` and a no-op unlisten.
- **New editor surfaces** — `src/editor/HtmlPreview/` (live HTML preview, `bundle.ts`) and `src/editor/SvgEditor/` (SVG canvas, `model.ts`).
- **Save flows** — `src/shell/SaveAsModal.tsx` + `src/shell/UnsavedChangesModal.tsx` (with `UnsavedChangesModal.test.tsx`, `documents.test.ts`), `src/store/documents.ts` `saveDocument`/`saveDocumentAs` + dirty guard, wired in `src/App.tsx` and `src/shell/SideBar`.
- **CodeEditor language map** — `src/editor/CodeEditor/languages.ts` expanded to cover JS/TS/Python/Markdown/CSS/Go/Rust/SQL/YAML/JSON/HTML with Shiki bridge (`highlightBridge.ts`), `CodeEditor.css` refinements.
- **UX polish** — `src/App.tsx` MenuBar integration + explorer root sync, `src/ui/Icon.tsx` / `DartIcon.tsx` / `LangLogo.tsx`, `src/shell/SideBar.css` refinements, `src/commands/registry.ts` help/docs/about/devtools.

### Changed
- **CodeEditor** — `src/editor/CodeEditor/index.tsx` lint fixes, language compartment wiring.
- **StatusBar** — `src/ui/StatusBar.tsx` minor alignment.
- **Tauri host** — `src-tauri/src/lib.rs` `read_file_base64` + `WriteReceipt`/`FileStat` handling updates.

### Fixed
- `src-tauri/icons/icon.icns` was a misnamed PNG (11 KB) — regenerated as proper ICNS (64 KB). `icon.ico` regenerated correctly.

---

## [0.1.0] - 2026-08-27

Initial public scaffolding. Usable in Vite (browser mock FS) and via Tauri when the Rust toolchain is present.

### Added
- **App shell** — `src/App.tsx:40` — `ThemeProvider` (light/dark/system) + `ToastProvider` + `SplashScreen` + custom `TitleBar` (`decorations: false`, `titleBarStyle: Overlay` on macOS) + `Tabs` + `SideBar` (recents) + `StatusBar` + `CommandPalette` with Framer Motion transitions.
- **Document store** — `src/store/documents.ts:50` — Zustand + Immer, `docs/order/active/history`, per-doc undo/redo (cap 100), `setRaw`/`setIr`/`setMode`/`setCursor`/`markClean`, cursor tracking.
- **Command registry** — `src/commands/registry.ts:26` — `buildCommands()` table consumed by palette, title-bar menu mirror, and global keybindings (`⌘/Ctrl+Shift+P`, `⌘/Ctrl+N/O/S/W/B/Z`).
- **Bridge** — `src/bridge/commands.ts:13` — typed `invoke()` wrappers (`read_file`, `write_file`, `read_dir`, `stat`, `recents_*`, `app_state_*`) with browser-only `MEMORY_FS` fallback (`welcome.md`, `notes.md`, `hello.ts`, `README.md`).
- **IR** — `src/ir/types.ts:14` — `Document { version: 1, blocks: Block[] }`, `Block` (paragraph/heading/blockquote/list/code/thematic/html), `Inline` marks, `ListItem`; stable `id` per node (`src/ir/ids.ts`).
- **Markdown surface** — `src/editor/MarkdownEditor/index.tsx:24` — CodeMirror 6 + `lang-markdown`, toolbar, `Compartment` theme, live preview via `renderMd.ts`.
- **Code surface** — `src/editor/CodeEditor/index.tsx:32` — CodeMirror 6 + gutter, `bracketMatching`, `foldGutter`, `highlightSelectionMatches`, language compartment (`js/ts/py/md`), Shiki-bridged `HighlightStyle` (`highlightBridge.ts`).
- **Rich surface** — `src/editor/RichEditor/index.tsx` — Tiptap StarterKit + lowlight code blocks, link extension.
- **Theming & motion** — `src/theme/` (`tokens.css`, `base.css`, `ThemeProvider.tsx`) + `src/motion/index.ts` (Framer Motion re-export).
- **UI primitives** — `src/ui/` — `Button`, `Dialog`, `Dropdown`, `Icon` (Phosphor), `Input`, `Kbd`, `Loader`, `Popover`, `StatusBar`, `Tabs`, `Toast` (Radix primitives).
- **Tauri host** — `src-tauri/src/lib.rs:38` — `HostError` (`NotFound`, `PermissionDenied`, `NotUtf8`, `IsADirectory`, `AlreadyExists`, `InvalidPath`, `Internal`) + commands `read_file`, `write_file` (returns `WriteReceipt`), `read_dir`, `stat`; plugins `dialog`, `fs`, `store`, `os`, `window-state`, `clipboard-manager`, `process`, `log`.
- **Config** — `vite.config.ts:7` (aliases `@ui/@shell/@ir/...`, port 1420/1421), `tsconfig.json` (strict), `tauri.conf.json:13` (1280×800, CSP `default-src 'self'`), `Cargo.toml:32` (release `lto`, `opt-level s`).
- **Documentation** — `README.md`, `explanation.md`, `description.md` (300 chars), `worklog.md`, `changelog/` (this file); `../docs/` (Diátaxis: tutorials/how-to/reference/explanation) + `../designlabs/` (static HTML prototypes + `verify_assets.py`).
- **Packaging** — `package.json:2` `spark-editor@0.1.0`, scripts `dev/build/preview/typecheck/lint/test/tauri`.

### Known limitations
- File watcher (`notify` → `file:changed`) not yet wired; self-write suppression planned.
- Rich slash/floating menus staged in `designlabs` but not fully wired in `RichEditor`.
- Session restore (`app_data_dir/recents.json`, window geometry) — host commands exist, renderer boot wiring is best-effort.
- Single window, single user, local files only — no sync, no LSP/DAP, no collaboration (by design — see `explanation.md:7`).

[Unreleased]: https://github.com/blackswanalpha/spark-editor/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/blackswanalpha/spark-editor/releases/tag/v0.2.0
[0.1.0]: https://github.com/blackswanalpha/spark-editor/releases/tag/v0.1.0
