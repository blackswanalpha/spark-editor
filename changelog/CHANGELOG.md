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

## [0.3.2] — 2026-08-29

### Added
- **Red theme** — `src/theme/tokens.css:294` new `:root[data-theme="red"]` dark crimson theme (bg #1c0a0e, surfaces #260f13→#57202b, accent #ef5350) with WCAG-checked text/contrast pairs and per-theme syntax tokens; `src/theme/ThemeProvider.tsx:12` adds `red` to `ThemeId`/`resolved`/`ORDER`/`resolveTheme` (now 5 themes + system); `src/shell/TitleBar.tsx:25` adds `red` to the theme menu + 6th swatch (3×2 mini-grid now fills exactly); `src/shell/TitleBar.css:95` `.titlebar__swatch--red` #ef5350; `src/shell/WelcomeWizard.tsx:25` adds Red ("Crimson night") to the wizard's theme pick; `src/shell/WelcomeWizard.css:117` swatch preview; `src/lib/themeTokens.ts:43` registers `spark-red` (and the previously missing `spark-amber`) Shiki themes, `src/lib/shiki.ts:20` loads them and `highlight()` accepts `amber`/`red` (`HighlightThemeId`).
- **Splash screen rework** — `src/shell/SplashScreen.tsx` — stages now mirror the real boot sequence (assets → theme → IPC bridge → `state.json` → session restore → ready) with a `v{version}` meta line (`src/version.ts`, sourced from `package.json`); dismissal is gated on actual boot completion (`ready` prop from `App.tsx` boot effect), not a fake timer. Splash moved to the app root (covers the full window; `App.css` `.app` gains `position: relative`).
- **First-time setup** — `src/shell/Onboarding.tsx` + `Onboarding.css` — first-run empty state (welcome cards: New document / Open file… / Open folder…, recents list, palette hint) replacing the old `EmptyState`; `src/shell/WelcomeWizard.tsx` + `WelcomeWizard.css` — 3-step first-run wizard (intro → theme pick (applies live, all 5 themes) → ready), Esc skips, focus moves per step and is restored on close (A11Y-002); `src/shell/firstRun.ts` — `spark.onboarded` localStorage flag + `shouldShowWelcome()` gate (first run only when there are no recents and no docs open); new Help → "Show Welcome Screen" command (`help.welcome` → `spark:help:welcome`).
- **Loader** — `src/ui/Loader.tsx` — `LoaderOverlay` full-surface waiting state (spinner + message, blocking variant) for long-running host work; `prefers-reduced-motion` support in `Loader.css`.

### Changed
- `src/App.tsx` — boot effect sets `bootReady` (gates the splash) and opens the welcome wizard on first run instead of force-loading the sample document; `@version` alias added to `tsconfig.json` + `vite.config.ts`.

### Fixed
- **Updater: missing-platform errors no longer surface as "Update check failed"** — `src/bridge/updater.ts` — error classification extracted to `classifyUpdaterError()` (`no-release` / `no-platform` / `error`); the Tauri error `None of the fallback platforms ["linux-x86_64"] were found in the response 'platforms' object` (published `latest.json` had no Linux entry) is now treated as "No updates — No update available for this platform yet" in both silent and manual checks. Root cause on the release side: `.github/workflows/release.yml` ubuntu leg lacked `libfuse2` and used bundle target `all`, which can silently drop the AppImage updater artifact; now installs `libfuse2`, pins `--bundles appimage,deb` on Linux, and the `verify-ota` job fails the release if `latest.json` lacks `linux-x86_64`.

---

## [0.3.0] - 2026-08-28

### Added
- **Terminal panel** — `src/shell/TerminalPanel.tsx:1` xterm.js (`@xterm/xterm@^6.0.0` + `@xterm/addon-fit@^0.11.0`) with `TerminalPanel.css:1`, cwd derived from explorer selection via `useTerminalCwd()` (selected → `targetCwd` → active doc → root → `/`), floating draggable panel + Document Picture-in-Picture / Tauri `WebviewWindow` / `window.open` pop-out (all OS-level windows, main stays interactive), `src/store/terminal.ts:1` Zustand `useTerminal` (`isOpen/targetCwd/openAt/toggle/setTargetCwd`) + `openTerminalAt(cwd)` / `closeTerminal()` imperative helpers (sync explorer selection + `spark:terminal:open` event), `src/shell/PluginRail.tsx:1` 44px hairline plugin rail left-of-explorer (`PluginRail.css:1`, `border-right: 1px solid var(--border)`) with extensible `PLUGINS` registry (first entry `terminal`), `src/App.tsx:278` `app__rail` layout + `isTerminalWindow()` / `TerminalStandalone` (lazy `TerminalStandaloneInner`, `terminal:?cwd=` query, `postMessage`/`storage`/`terminal:cwd` event sync) for true out-of-window hosting.
- **Explorer context menu** — `src/shell/ExplorerContextMenu.tsx:1` right-click / bubble menu (new file…, new folder…, open in terminal, reveal in OS, cut, copy, paste, rename…, refactor…, delete) filtered by `isDir` + `clipboard` state, rename + delete confirm dialogs (`Dialog`/`Input`/`Button`), `src/ui/ContextMenu.tsx:1` + `ContextMenu.css:1` Radix `ContextMenu` primitive (`ContextMenuEntry` type), `src/shell/SideBar.tsx:1` wires `ExplorerContextMenu` per-row + empty-area + bubble-menu `Open in Terminal` → `openTerminalAt(cwd)` (routes to in-app panel, no external spawn), `src/ui/Icon.tsx:68` new icon entries, `src/ui/Dropdown.tsx`/`Popover.tsx` polish, `src/shell/SideBar.css:1` + `src/App.css:1` rail refinements, `src/editor/SvgEditor/index.tsx:1` minor fixes.
- **Explorer store — clipboard & file ops** — `src/store/explorer.ts:45` adds `clipboard: ClipboardEntry|null` + `ClipboardOp = "copy"|"cut"` + actions `renamePath(path,newName)/moveTo(from,to)/deletePath(path)/copyTo(from,to)/setClipboard(entry)/pasteInto(targetDir)/openInTerminal(cwd)/revealInOS(path)/refactor(path,newName)` (refactor = rename for now, seam for future language-aware moves), eager cache remap for rename/move (parent listing rewrite, `children` key remap `path→to`, `expanded` set remap, `selectedPath` follow), `nextAvailableDest()` probes `stat()` for `name copy` / `name copy (N)` collision avoidance (1000 probes → timestamp fallback), `src/store/explorer.test.ts:1` 5 new tests: `createFile+renamePath updates cache+selection`, `createFolder+deletePath removes entry`, `setClipboard copy → pasteInto produces 'name copy'`, `cut → paste moves+clears clipboard`, `renamePath rejects path separators` (19 total green).
- **Host commands** — `src-tauri/src/lib.rs:191` new `#[tauri::command]`s: `rename(from,to)` (refuse if dest exists, `create_dir_all(parent)`), `delete(path)` (dir → `remove_dir_all`, else `remove_file`), `copy(from,to)` + `copy_dir_recursive(src,dst)` (refuse if dest exists, recursive dir copy), `open_in_terminal(cwd)` (macOS `open -a Terminal <cwd>`, Windows `cmd /C start cmd /K cd /d <cwd>`, Linux probe `x-terminal-emulator|gnome-terminal|konsole|alacritty|xterm` with `--working-directory` variants), `reveal_in_folder(path)` (`open -R` / `explorer /select,` / `xdg-open parent`), `open_with_os(path)` (`open` / `cmd /C start` / `xdg-open`), all registered in `invoke_handler` at `lib.rs:443`; `src-tauri/capabilities/default.json:5` adds `windows: ["main","terminal"]` + `core:window:allow-create|allow-set-focus|allow-show|allow-hide|core:webview:allow-create-webview*` permissions for pop-out windows.
- **Bridge** — `src/bridge/commands.ts:12` wraps `tInvoke` in `Load failed/custom protocol/callback id` fallback (`console.warn` + `mock()` so Vite dev without Tauri stays usable), new typed wrappers `copyPath/openInTerminal/revealInOS/openWithOS`, memory mocks for `rename` (prefix-rename `MEMORY_FS`/`MEMORY_DIRS` keys), `delete` (recursive prefix delete), `copy` (prefix copy), and no-ops for `open_in_terminal/reveal_in_folder/open_with_os`; `src/store/terminal.ts:1` re-exports `openTerminalAt`/`closeTerminal` for non-React callers.

### Changed
- **Deps** — `package.json:73` adds `@xterm/xterm@^6.0.0` + `@xterm/addon-fit@^0.11.0` (2308 insertions, 24 files). `src-tauri/tauri.conf.json:28` `security.csp` → `null` (was `default-src 'self'…` — loosened for xterm `blob:`/inline styles in terminal panel; re-tighten before hardening).
- **CSP** — noted above; OTA `latest.json` endpoint unchanged (`https://github.com/blackswanalpha/spark-editor/releases/latest/download/latest.json`).

## [0.2.2] - 2026-08-28

### Added
- **Amber theme** — `src/theme/ThemeProvider.tsx:12` adds `amber` to `ThemeId`/`ORDER`/`resolveTheme` (now `light|dark|navy|amber|system`, 5-way cycle), `src/theme/tokens.css:244` new `:root[data-theme="amber"]` warm light theme (bg #fffbeb, surfaces #fef3c7→#fcd34d, accent #d97706 amber, shadows warm, syntax warm), `src/shell/TitleBar.tsx:23` adds `amber` to `THEME_OPTIONS` + 5-swatch grid, `src/shell/TitleBar.css:70` `grid-template-columns: repeat(3,1fr)` 20×14 + `.titlebar__swatch--amber` #f59e0b. Selectable via TitleBar theme menu, persisted via `LazyStore`/`localStorage`, cycles via `cycle()` — test OTA via `Help → Check for Updates` after `0.2.2` release.

### Fixed
- **Merge PR #6 / develop workflow** — `src-tauri/tauri.conf.json:71` pubkey corrected to single-line minisign format `dW50…` (was raw 32-byte `RWRa…` which failed `invalid utf-8 at index 5` on `cargo tauri build` with `createUpdaterArtifacts:true`); `src-tauri/Cargo.lock` synced (0.2.1→0.2.2). `.github/workflows/develop.yml:27` `ci` now `if: github.ref == 'refs/heads/develop' || pull_request || workflow_dispatch` (was triggering on `main` push and failing). `.github/workflows/release.yml:85` `verify-ota` now `uses: actions/checkout@v4` (was `not a git repository` + `latest.json not found`).

## [0.2.1] - 2026-08-28

### Fixed
- **OTA signing key** — previous `v0.2.0` key was generated without password and fails at build (`Missing comment in secret key`). Regenerated with password `spark-ota-2025`, `src-tauri/tauri.conf.json:71` pubkey now `RWRaUWew/hvfdKkydjS7CiAtKLfGko9J9MNWe67IUqgn8RobeXHGPW0n` (id `74DF1BFEB067515A`, corrected to single-line `dW50…` in 0.2.2). `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets updated. Verified `cargo tauri signer sign` now succeeds.

### Added
- **Develop workflow** — `.github/workflows/develop.yml:1` — `develop` CI gate, `build-develop-artifact` (deb/AppImage for QA, `createUpdaterArtifacts:false`), and `cut-release` (`workflow_dispatch` → bumps `package.json`/`Cargo.toml`/`tauri.conf.json`, creates `release/*` branch + PR to `main`). `auto-bump` helper for patch/minor/major. See `gitflow.md`.

## [0.2.0] - 2026-08-28

### Added
- **Launch & setup icons** — regenerated `src-tauri/icons/` via `cargo tauri icon` from `_master.png` (1024). Proper desktop assets: `32x32.png`, `64x64.png`, `128x128.png`, `128x128@2x.png` (256), `icon.png` (512), `icon.icns` (macOS, 64 KB), `icon.ico` (Windows). `src-tauri/tauri.conf.json:32` — `bundle.icon` updated, `publisher/category/shortDescription/longDescription` set, `createUpdaterArtifacts: true`, and `linux`/`windows`/`macOS` bundle targets wired so installers create correct desktop shortcuts / Start-Menu entries / `.desktop` files.
- **OTA updates** — `tauri-plugin-updater` (Rust `src-tauri/src/lib.rs:275` + `@tauri-apps/plugin-updater` JS) + `capabilities/{default,desktop}.json` (`updater:default`, `updater:allow-check`, `updater:allow-download-and-install`, `process:allow-restart`). New `src/bridge/updater.ts:1` (`checkForUpdates()`, `checkForUpdatesOnBoot()`) — silent boot check (4 s delay) and manual **Help → Check for Updates…** (`src/commands/registry.ts:336` + `src/App.tsx:229`). `tauri.conf.json:plugins.updater` pubkey `RWQ8g3GffHCTjah…krV` (now superseded in 0.2.1) and endpoint `https://github.com/blackswanalpha/spark-editor/releases/latest/download/latest.json`. CSP extended to GitHub.
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

[Unreleased]: https://github.com/blackswanalpha/spark-editor/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/blackswanalpha/spark-editor/releases/tag/v0.3.0
[0.2.2]: https://github.com/blackswanalpha/spark-editor/releases/tag/v0.2.2
[0.2.1]: https://github.com/blackswanalpha/spark-editor/releases/tag/v0.2.1
[0.2.0]: https://github.com/blackswanalpha/spark-editor/releases/tag/v0.2.0
[0.1.0]: https://github.com/blackswanalpha/spark-editor/releases/tag/v0.1.0
