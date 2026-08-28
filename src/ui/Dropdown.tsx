/* ============================================================
   sparkEditor · src/ui/Dropdown.tsx
   Menu primitive built on Radix DropdownMenu (a11y + keyboard).
   ============================================================ */
import * as RD from "@radix-ui/react-dropdown-menu";
import { motion } from "@motion/index";
import { popoverVariants } from "@motion/index";
import { Icon } from "./Icon";
import "./Dropdown.css";

export const DropdownRoot = RD.Root;
export const DropdownTrigger = RD.Trigger;

export interface DropdownItemSpec {
  id: string;
  label: string;
  icon?: string;
  shortcut?: string;
  destructive?: boolean;
  disabled?: boolean;
  separator?: false;
}
export interface DropdownSeparator { separator: true; id: string; }

export type DropdownEntry = DropdownItemSpec | DropdownSeparator;

export function DropdownContent({
  entries, onSelect, align = "start", sideOffset = 4,
}: {
  entries: DropdownEntry[];
  onSelect: (id: string) => void;
  align?: "start" | "center" | "end";
  sideOffset?: number;
}) {
  return (
    <RD.Portal>
      <RD.Content asChild align={align} sideOffset={sideOffset}>
        <motion.div
          className="dd-menu"
          variants={popoverVariants}
          initial="initial"
          animate="animate"
          exit="exit"
        >
          {entries.map((e) =>
            e.separator ? (
              <RD.Separator key={e.id} className="dd-sep" />
            ) : (
              <RD.Item
                key={e.id}
                className={`dd-item ${e.destructive ? "is-danger" : ""}`}
                disabled={e.disabled}
                onSelect={() => onSelect(e.id)}
              >
                {e.icon && <Icon name={e.icon} size={14} className="dd-item__icon" />}
                <span className="dd-item__label">{e.label}</span>
                {e.shortcut && <span className="dd-item__kbd">{e.shortcut}</span>}
              </RD.Item>
            ),
          )}
        </motion.div>
      </RD.Content>
    </RD.Portal>
  );
}
