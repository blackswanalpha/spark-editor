/* ============================================================
   sparkEditor · src/ui/Tabs.tsx
   Document tab strip used by the editor shell.
   Uses a subtle "underline-on-active" visual; pills optional.
   ============================================================ */
import { motion } from "@motion/index";
import { Icon } from "./Icon";
import "./Tabs.css";

export interface Tab {
  id: string;
  label: string;
  icon?: string;
  dirty?: boolean;
  closable?: boolean;
}

export function Tabs({
  tabs, activeId, onSelect, onClose,
}: {
  tabs: Tab[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose?: (id: string) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => {
        const active = t.id === activeId;
        return (
          <motion.button
            key={t.id}
            role="tab"
            aria-selected={active}
            className={`tab ${active ? "is-active" : ""}`}
            onClick={() => onSelect(t.id)}
            whileTap={{ scale: 0.98 }}
          >
            {active && (
              <motion.span
                layoutId="tab-underline"
                className="tab__underline"
                transition={{ type: "spring", stiffness: 380, damping: 30 }}
              />
            )}
            {t.icon && <Icon name={t.icon} size={14} />}
            <span className="tab__label">
              {t.dirty && <span className="tab__dot" aria-label="unsaved">•</span>}
              {t.label}
            </span>
            {t.closable && onClose && (
              <span
                role="button"
                aria-label="Close tab"
                className="tab__close"
                onClick={(e) => { e.stopPropagation(); onClose(t.id); }}
              >
                <Icon name="close" size={12} />
              </span>
            )}
          </motion.button>
        );
      })}
    </div>
  );
}
