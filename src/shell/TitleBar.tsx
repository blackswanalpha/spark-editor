/* ============================================================
   sparkBook · src/shell/TitleBar.tsx
   Custom window title bar — REPLACES the OS default chrome.
   - Left:  app mark + document title (with • dirty marker)
   - Right: theme switcher + window controls (min, max, close)
   The window controls are wired through Tauri when available
   and fall back to no-ops in plain Vite preview.
   ============================================================ */
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@bridge/commands";
import { Icon } from "@ui/Icon";
import { useTheme } from "@theme/ThemeProvider";
import { motion, tap } from "@motion/index";
import { Popover, PopoverTrigger, PopoverContent } from "@ui/Popover";
import "./TitleBar.css";

export interface TitleBarProps {
  title?: string;
  dirty?: boolean;
  platform?: "macos" | "windows" | "linux";
}

type ThemeId = "light" | "dark" | "navy" | "amber" | "red" | "system";

const THEME_OPTIONS: { id: ThemeId; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "navy", label: "Navy" },
  { id: "amber", label: "Amber" },
  { id: "red", label: "Red" },
  { id: "system", label: "System" },
];

export function TitleBar({ title = "Untitled", dirty, platform = "windows" }: TitleBarProps) {
  const { theme, setTheme, resolved } = useTheme();
  const [isMax, setIsMax] = useState(false);

  // Sync the OS window title so it always matches the renderer's view
  useEffect(() => {
    const full = `${dirty ? "• " : ""}${title} — sparkBook`;
    try { document.title = full; } catch {}
    // getCurrentWindow() reads window.__TAURI_INTERNALS__.metadata and
    // THROWS outside Tauri — the optional call cannot catch that, so the
    // whole TitleBar was crashing the shell under `npm run dev`.
    if (!isTauri) return;
    try {
      getCurrentWindow().setTitle(full).catch(() => {});
    } catch {
      /* host not reachable — the document title above is enough */
    }
  }, [title, dirty]);

  const isMac = platform === "macos";

  // Window control handlers — Tauri-aware, with safe fallbacks
  const min = () => {
    if (!isTauri) return;
    try { getCurrentWindow().minimize().catch(() => {}); } catch {}
  };
  const tog = async () => {
    if (!isTauri) return;
    try {
      const w = getCurrentWindow();
      if (!w) return;
      const m = await w.isMaximized();
      if (m) { await w.unmaximize(); setIsMax(false); }
      else   { await w.maximize();   setIsMax(true);  }
    } catch {}
  };
  /* Route through the shell rather than closing directly: App owns the
     unsaved-changes guard and the workspace flush, and both were being
     skipped when this button called window.close() itself. */
  const close = () => window.dispatchEvent(new CustomEvent("spark:window:close:request"));

  return (
    <div className={`titlebar titlebar--${platform}`} data-tauri-drag-region>
      {/* Left: app mark + title */}
      <div className="titlebar__left" data-tauri-drag-region>
        {isMac && <div className="titlebar__mac-spacer" />}
        <img className="titlebar__mark" src="/spark-mark.svg" alt="" width={16} height={16} />
        <span className="titlebar__title">
          {dirty && <span className="titlebar__dot" aria-label="unsaved">•</span>}
          {title}
        </span>
      </div>

      {/* Right: theme + window controls */}
      <div className="titlebar__right">
        <Popover>
          <PopoverTrigger asChild>
            <motion.button
              className="titlebar__iconbtn"
              whileTap={tap}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              aria-label={`Theme: ${theme}`}
              title={`Theme: ${theme}`}
            >
              <span className="titlebar__swatches" aria-hidden="true">
                <span className={`titlebar__swatch titlebar__swatch--light${theme === "light" ? " titlebar__swatch--active" : ""}`} />
                <span className={`titlebar__swatch titlebar__swatch--dark${theme === "dark" ? " titlebar__swatch--active" : ""}`} />
                <span className={`titlebar__swatch titlebar__swatch--navy${theme === "navy" ? " titlebar__swatch--active" : ""}`} />
                <span className={`titlebar__swatch titlebar__swatch--amber${theme === "amber" ? " titlebar__swatch--active" : ""}`} />
                <span className={`titlebar__swatch titlebar__swatch--red${theme === "red" ? " titlebar__swatch--active" : ""}`} />
                <span className={`titlebar__swatch titlebar__swatch--system${theme === "system" ? " titlebar__swatch--active" : ""}`} />
              </span>
            </motion.button>
          </PopoverTrigger>
          <PopoverContent className="titlebar__theme-menu" side="bottom" align="end" sideOffset={6}>
            {THEME_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`titlebar__theme-item${theme === opt.id ? " titlebar__theme-item--active" : ""}`}
                onClick={() => setTheme(opt.id)}
              >
                <span className={`titlebar__swatch titlebar__swatch--${opt.id} titlebar__theme-item__chip`} aria-hidden="true" />
                <span className="titlebar__theme-item__label">{opt.label}</span>
              </button>
            ))}
          </PopoverContent>
        </Popover>

        {!isMac && (
          <>
            <motion.button className="titlebar__iconbtn" whileTap={tap} onClick={min} aria-label="Minimize">
              <Icon name="minimize" size={12} />
            </motion.button>
            <motion.button className="titlebar__iconbtn" whileTap={tap} onClick={tog} aria-label={isMax ? "Restore" : "Maximize"}>
              <Icon name={isMax ? "restore" : "maximize"} size={12} />
            </motion.button>
            <motion.button
              className="titlebar__iconbtn titlebar__iconbtn--close"
              whileTap={tap}
              onClick={close}
              aria-label="Close"
            >
              <Icon name="close" size={12} />
            </motion.button>
          </>
        )}
      </div>

      {/* Dev hint */}
      <span className="visually-hidden">Theme resolved to {resolved}</span>
    </div>
  );
}
