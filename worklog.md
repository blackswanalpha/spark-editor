# sparkEditor — Worklog

Chronological build log. Each entry is dated, scoped, and linked to the Changelog where the change was released. Times are EAT (UTC+3).

---

## 2026-08-29 — Release 0.3.2: red theme (+ boot experience from #14)

- **Scope:** `src/theme/{tokens.css,ThemeProvider.tsx}`, `src/shell/{TitleBar.tsx,TitleBar.css,WelcomeWizard.tsx,WelcomeWizard.css}`, `src/lib/{themeTokens.ts,shiki.ts}`, `package.json`, `src-tauri/{tauri.conf.json,Cargo.toml,Cargo.lock}`, `changelog/{CHANGELOG.md,0.3.2.md}`, `worklog.md`.
- **What:** Added the **red** theme (dark crimson: bg #1c0a0e, surfaces #260f13→#57202b, accent #ef5350) across all theme touchpoints — tokens, provider types/ORDER/resolve, TitleBar menu + 6th swatch (3×2 mini-grid fills exactly), welcome-wizard pick + preview swatch, and Shiki registration (`spark-red`, plus the previously missed `spark-amber`; `highlight()` now takes `HighlightThemeId`). Version bumped 0.3.1 → 0.3.2 so the release also ships the boot-experience work merged from `feature/boot-experience-screens` (#14): real-stage splash, welcome wizard + onboarding, loader overlay, and the updater missing-platform fix (release workflow now guarantees `linux-x86_64` in `latest.json`).
- **Decisions:** Red is a dark theme (pairs with navy=dark-blue, amber=light-warm) so the set spans dark blue / light warm / dark red. Amber's missing Shiki registration was fixed in passing while touching the highlight bridge.
- **Verification:** `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`; `cargo update -p spark-editor --offline` synced the lock at 0.3.2.

## 2026-08-28 — Boot experience: splash / loader / first-run setup + updater platform fix

- **Scope:** `src/shell/{SplashScreen,WelcomeWizard,Onboarding,firstRun}.{tsx,ts,css}`, `src/ui/{Loader.tsx,Loader.css}`, `src/App.tsx`, `src/App.css`, `src/version.ts`, `src/bridge/updater.ts`, `src/commands/registry.ts`, `tsconfig.json`, `vite.config.ts`, `.github/workflows/release.yml`, `changelog/CHANGELOG.md`.
- **What:** Ported the boot-experience designlabs (`labs/splash.html`, `labs/loader.html`, `labs/onboarding.html`) to the React shell. Splash stages now track the real boot (theme → IPC → state.json → session → ready), show `v{version}` (`src/version.ts` from `package.json`), and dismiss on boot completion via a `ready` gate instead of a fixed timer. New first-run flow: `spark.onboarded` localStorage flag + `shouldShowWelcome()` (no recents, no docs, never onboarded) opens a 3-step welcome wizard (intro → live theme pick across all 5 themes → ready); the no-docs empty state became `OnboardingScreen` with action cards + recents; re-openable via Help → Show Welcome Screen. `LoaderOverlay` added for indeterminate host work; `prefers-reduced-motion` honoured in loader/wizard/onboarding CSS. Updater: extracted `classifyUpdaterError()` so the missing-`linux-x86_64`-in-`latest.json` failure (`None of the fallback platforms ["linux-x86_64"] …`) is handled as a friendly "No update available for this platform yet" instead of "Update check failed"; release workflow installs `libfuse2`, pins `--bundles appimage,deb` on Linux, and `verify-ota` now fails the release if `latest.json` lacks `linux-x86_64`.
- **Decisions:** First-run flag lives in localStorage (renderer-side analogue of `state.json` first-run defaults per `docs/reference/app-state.md`) — a host-side `app_state_get` bridge is the seam for a future migration. Boot gate (`bootReady`) is computed in `App.tsx` so the splash never lies about progress.
- **Verification:** Reproduced the updater error live (`--log-to-stderr`: `Searching for updater target 'linux-x86_64' in release data` → miss) against the v0.3.1 manifest; `npm run typecheck`, `npm run lint` (no new errors), `npm test` (29 passed incl. new `updater.test.ts` + `firstRun.test.ts`), `npm run tauri build` (.deb 0.3.1 bundled; app boots).

## 2026-08-27 — File explorer port from designlabs

- **Scope:** `src/shell/SideBar.tsx`, `src/shell/SideBar.css`, `src/store/explorer.ts`, `src/bridge/{commands,events}.ts`, `src-tauri/src/lib.rs`, `docs/reference/{renderer-modules,host-commands}.md`, `changelog/CHANGELOG.md`.
- **What:** Ported the designlab file explorer (`designlabs/labs/explorer.html`) to the React shell. Lazy `read_dir` per directory via a new zustand+immer store (`useExplorer`); tree-view keyboard contract (↑↓ →← Enter Home End); toolbar (new file, refresh, collapse, show hidden); loader row; empty-folder state; recents tab preserved. Added host commands `create_file` (refuses to overwrite, returns `FileStat`) and `mkdir` (`mkdir -p`, idempotent) in `src-tauri/src/lib.rs`. Added `watchPath` / `unwatchPath` typed wrappers and `onFileChanged` event subscriber. Explorer folder root sourced from explicit `file.openFolder` first, then falls back to the active document's parent directory.
- **Decisions:** Keep the explorer store separate from the document store — different concern, different lifecycle. Use `window.prompt` for the new-file name this iteration (a proper popover is a follow-up).
- **Verification:** `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`; `cargo check` on `src-tauri/`.

## 2026-08-27 — Documentation pass (README / explanation / description / changelog scaffolding)

- **Scope:** `README.md`, `explanation.md`, `description.md`, `worklog.md`, `changelog/` — `sparkEditor-main/` package.
- **What:** Authored the five artefacts requested for the sparkEditor product surface. `README.md` covers quick-start, architecture sketch, scripts, project structure, and docs map. `explanation.md` (this package) distils why the renderer/host split, the IR, and the file-as-truth tenet exist, with trade-offs and seams. `description.md` is the 300-char store listing (validated to 300 chars). `changelog/` seeded with Keep-a-Changelog `CHANGELOG.md` at `0.1.0`.
- **Files:** `sparkEditor-main/README.md:1`, `sparkEditor-main/explanation.md:1`, `sparkEditor-main/description.md:1`, `sparkEditor-main/changelog/CHANGELOG.md:1`.
- **Notes:** Docs stay consistent with `docs/explanation/{overview,architecture,data-model}.md` and `src/ir/types.ts:14`, `src/bridge/commands.ts:13`, `src/store/documents.ts:50`. Description string length asserted with `python3 -c "len(open(...).read().strip()) == 300"`.

## 2026-08-27 — Renderer shell and document store

- **Scope:** `src/App.tsx`, `src/store/documents.ts`, `src/commands/registry.ts`, `src/bridge/commands.ts`.
- **What:** Wired `App.tsx:40` — `ThemeProvider`, `ToastProvider`, `SplashScreen`, custom `TitleBar` (OS decorations off), `Tabs`, `SideBar`, `StatusBar`, `CommandPalette`. Central command table in `registry.ts:9` consumed by palette, title-bar menu mirror, and keybinding dispatch. Zustand + Immer store (`documents.ts:50`) holds `docs/order/active/history`, per-doc `past/future` capped at 100 snapshots, `setRaw`/`setIr`/`undo`/`redo`, cursor and dirty flag. Bridge (`commands.ts:13`) wraps `invoke()` with browser-only `MEMORY_FS` fallback for Vite-only dev.
- **Decisions:** Store lives in renderer (fast synchronous undo/mode switch); host only sees bytes on save/load. See `explanation.md:5`.
- **Verification:** `npm run typecheck`, `npm run dev` in browser (mock FS), manual `readFile("/welcome.md")` smoke test.

## 2026-08-26 — Editor surfaces

- **Scope:** `src/editor/CodeEditor`, `src/editor/MarkdownEditor`, `src/editor/RichEditor`, `src/editor/editor.css`.
- **What:** Code surface on CodeMirror 6 with `lineNumbers`, `highlightActiveLine`, `bracketMatching`, `history`, `searchKeymap`, language compartment (`extLangFor`), Shiki-bridged `HighlightStyle` via `highlightBridge.ts:10`, and beam `EditorView.updateListener` → `store.setRaw` + cursor sync. Markdown surface adds markdown language, toolbar (H1–H3, bold/italic/link/lists/blockquote/code), `Compartment` for theme, and live preview via `renderMd.ts` (self-contained md→html). Rich surface on Tiptap StarterKit + lowlight. All three read/write the shared IR (`src/ir/types.ts:14`).
- **Open items:** File-watcher `file:changed` event wiring; Rich slash/floating menus (referenced in `designlabs`).

## 2026-08-26 — Theming, motion, and UI primitives

- **Scope:** `src/theme/`, `src/motion/`, `src/ui/`, `src/shell/`.
- **What:** `ThemeProvider.tsx` — three themes (light/dark/system via `prefers-color-scheme`), CSS variables in `tokens.css`/`base.css`. `motion/index.ts` re-exports `framer-motion`. Primitives: `Button`, `Dialog`, `Dropdown`, `Icon`, `Input`, `Kbd`, `Loader`, `Popover`, `StatusBar`, `Tabs`, `Toast`. Shell: `TitleBar` (custom chrome, `decorations: false` in `tauri.conf.json:22`), `SideBar` (recents via `recentsGet/recentsAdd`), `CommandPalette` (Radix Dialog), `SplashScreen`. Framer `AnimatePresence` transitions for sidebar/status/editor.

## 2026-08-25 — Tauri host

- **Scope:** `src-tauri/src/lib.rs`, `src-tauri/src/main.rs`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`.
- **What:** Host exposes `read_file`/`write_file`/`read_dir`/`stat` (`lib.rs:38`) with `HostError` enum (`NotFound`, `PermissionDenied`, `NotUtf8`, `AlreadyExists`, `InvalidPath`, `Internal`) serialized as `{ kind, data }`. Plugins: `dialog`, `fs`, `store`, `os`, `window-state`, `clipboard-manager`, `process`, `log`. Window config: 1280×800, `titleBarStyle: Overlay` (macOS), `hiddenTitle: true`, strict CSP (`default-src 'self'`). Cargo release profile (`Cargo.toml:32`): `lto = true`, `opt-level = "s"`, `panic = "abort"`.
- **Notes:** `recents_*` / `app_state_*` commands staged for session restore; `notify` file-watch planned (self-write suppression).

## 2026-08-25 — IR and project scaffolding

- **Scope:** `src/ir/types.ts`, `src/ir/ids.ts`, `vite.config.ts`, `tsconfig.json`, `package.json`.
- **What:** IR types (`Document: { version: 1, blocks: Block[] }`, `Block` variants, `Inline` marks) — stable `id` per node, regenerated on load so on-disk stays human-diffable. `vite.config.ts:9` path aliases (`@ui`, `@shell`, `@ir`, …), dev server 1420/strictPort, Tauri-aware HMR (1421). Dependencies pinned: CodeMirror 6.35, Tiptap 2.10, Zustand 4.5, Shiki 1.29, Radix UI, Phosphor Icons, Framer Motion.
- **Decisions:** Versioned IR (`version: 1`) leaves room for migrators without persisting ids.

## 2026-08-24 — Docs and design labs

- **Scope:** `docs/` (Diátaxis), `designlabs/`.
- **What:** `docs/explanation/{overview,architecture,data-model,process-model,state-and-persistence}` and `docs/reference/{host-commands,ir,renderer-modules,…}` authored. `designlabs/` — static, build-free HTML+CSS prototypes for all UI elements (app shell, titlebar, sidebar, explorer, palette, dialogs, toasts, markdown/rich/code editors), with local fonts (Inter, JetBrains Mono WOFF2) and SVG icons, `assets/manifest.json` + `tools/verify_assets.py` (XML parse, WOFF2 magic, SHA-256).

---

## Conventions

- New entries go at the top (reverse-chronological). Keep each entry to: date, scope, what, decisions, verification/open items.
- Link code with `path:line` (e.g., `src/ir/types.ts:14`) so the log stays navigable.
- Promote user-visible changes to `changelog/CHANGELOG.md` under the next unreleased heading; cut a version heading on release.
