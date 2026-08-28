/* ============================================================
   sparkEditor · src/ui/ContextMenu.tsx
   Right-click context menu built on Radix ContextMenu
   (a11y: keyboard nav, ESC dismiss, focus management).
   Mirrors Popover/Dropdown visual style and uses the same
   popoverVariants for a consistent enter/exit animation.
   ============================================================ */
import * as RC from "@radix-ui/react-context-menu";
import { motion } from "@motion/index";
import { popoverVariants } from "@motion/index";
import { Icon } from "./Icon";
import "./ContextMenu.css";

export const ContextMenuRoot = RC.Root;
export const ContextMenuTrigger = RC.Trigger;

export interface ContextMenuItemSpec {
  id: string;
  label: string;
  icon?: string;
  shortcut?: string;
  destructive?: boolean;
  disabled?: boolean;
  separator?: false;
}
export interface ContextMenuSeparator { separator: true; id: string; }

export type ContextMenuEntry = ContextMenuItemSpec | ContextMenuSeparator;

export function ContextMenuSurface({
  entries, onSelect,
}: {
  entries: ContextMenuEntry[];
  onSelect: (id: string) => void;
}) {
  return (
    <RC.Portal>
      <RC.Content asChild collisionPadding={6}>
        <motion.div
          className="ctx-menu"
          variants={popoverVariants}
          initial="initial"
          animate="animate"
          exit="exit"
        >
          {entries.map((e) =>
            e.separator ? (
              <RC.Separator key={e.id} className="ctx-sep" />
            ) : (
              <RC.Item
                key={e.id}
                className={`ctx-item ${e.destructive ? "is-danger" : ""}`}
                disabled={e.disabled}
                onSelect={() => onSelect(e.id)}
              >
                {e.icon && <Icon name={e.icon} size={14} className="ctx-item__icon" />}
                <span className="ctx-item__label">{e.label}</span>
                {e.shortcut && <span className="ctx-item__kbd">{e.shortcut}</span>}
              </RC.Item>
            ),
          )}
        </motion.div>
      </RC.Content>
    </RC.Portal>
  );
}

/**
 * Convenience wrapper: a Trigger element + the floating menu.
 * The right-click target element is supplied as `children`
 * (it must forward refs and accept an onContextMenu event).
 */
export function ContextMenu({
  entries, onSelect, children,
}: {
  entries: ContextMenuEntry[];
  onSelect: (id: string) => void;
  children: React.ReactElement;
}) {
  return (
    <RC.Root>
      <RC.Trigger asChild>{children}</RC.Trigger>
      <ContextMenuSurface entries={entries} onSelect={onSelect} />
    </RC.Root>
  );
}
