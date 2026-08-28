/* ============================================================
   sparkEditor · src/shell/PluginRail.tsx
   Hairline plugin rail pinned left-of-explorer.
   - 44px wide, icons-only vertical strip
   - Hairline right border (1px solid var(--border))
   - Extensible plugin registry (first item is terminal)
   - Terminal opens a PiP (Document Picture-in-Picture) or fallback dialog
   ============================================================ */
import { useCallback } from "react";
import { Icon } from "@ui/Icon";
import { useTerminal } from "@store/terminal";
import "./PluginRail.css";
import { TerminalDialog } from "./TerminalPanel";

export type RailId = "terminal";

interface PluginDef {
  id: RailId;
  label: string;
  icon: string;
}

const PLUGINS: PluginDef[] = [
  { id: "terminal", label: "Terminal", icon: "terminal" },
];

export function PluginRail() {
  const isOpen = useTerminal((s) => s.isOpen);
  const toggle = useTerminal((s) => s.toggle);
  const open = useTerminal((s) => s.open);
  const close = useTerminal((s) => s.close);

  const active: RailId | null = isOpen ? "terminal" : null;

  const onSelect = useCallback((id: RailId) => {
    if (id === "terminal") {
      toggle();
      return;
    }
  }, [toggle]);

  return (
    <>
      <nav className="plugin-rail" aria-label="Plugins">
        <div className="plugin-rail__inner">
          {PLUGINS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`plugin-rail__btn ${active === p.id ? "is-active" : ""}`}
              aria-label={p.label}
              aria-pressed={active === p.id}
              title={p.label}
              onClick={() => onSelect(p.id)}
            >
              <Icon name={p.icon} size={18} />
            </button>
          ))}
          <div className="plugin-rail__spacer" aria-hidden />
        </div>
      </nav>

      <TerminalDialog open={isOpen} onOpenChange={(o) => { if (o) open(); else close(); }} />
    </>
  );
}
