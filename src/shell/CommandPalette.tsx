/* ============================================================
   sparkEditor · src/shell/CommandPalette.tsx
   Ctrl+Shift+P command palette.  Built as a small listbox
   with a single text input and a virtualisable list.  Items
   come from the central registry.
   ============================================================ */
import { useEffect, useMemo, useRef, useState } from "react";
import * as RD from "@radix-ui/react-dialog";
import { motion, AnimatePresence } from "@motion/index";
import { overlayBackdropVariants, modalVariants, staggerParent, staggerItem } from "@motion/index";
import { Input } from "@ui/Input";
import { Icon } from "@ui/Icon";
import type { CommandSpec } from "@commands/registry";
import "./CommandPalette.css";

export function CommandPalette({
  open, onOpenChange, commands,
}: { open: boolean; onOpenChange: (v: boolean) => void; commands: CommandSpec[] }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle
      ? commands.filter((c) => (c.title + " " + (c.keywords || []).join(" ")).toLowerCase().includes(needle))
      : commands;
    return list.slice(0, 50);
  }, [q, commands]);

  useEffect(() => { setActive(0); }, [q, open]);

  // Keyboard nav
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(items.length - 1, i + 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
      else if (e.key === "Enter") { e.preventDefault(); items[active]?.run(); onOpenChange(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, items, active, onOpenChange]);

  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <RD.Portal forceMount>
            <RD.Overlay asChild>
              <motion.div className="cp__backdrop"
                variants={overlayBackdropVariants} initial="initial" animate="animate" exit="exit" />
            </RD.Overlay>
            <RD.Content asChild>
              <motion.div
                className="cp"
                variants={modalVariants} initial="initial" animate="animate" exit="exit"
                aria-label="Command palette"
              >
                <div className="cp__search">
                  <Input
                    autoFocus
                    leadingIcon="search"
                    placeholder="Type a command…"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    aria-label="Search commands"
                  />
                </div>
                <div className="cp__list" ref={listRef} role="listbox" aria-activedescendant={`cp-item-${active}`}>
                  <motion.ul variants={staggerParent()} initial="initial" animate="animate">
                    {items.length === 0 && (
                      <li className="cp__empty">No commands match “{q}”.</li>
                    )}
                    {items.map((c, i) => (
                      <motion.li
                        id={`cp-item-${i}`}
                        key={c.id}
                        variants={staggerItem}
                        className={`cp__item ${i === active ? "is-active" : ""}`}
                        role="option"
                        aria-selected={i === active}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => { c.run(); onOpenChange(false); }}
                      >
                        <Icon name={c.icon || "command"} size={14} className="cp__icon" />
                        <span className="cp__title">{c.title}</span>
                        {c.category && <span className="cp__cat">{c.category}</span>}
                        {c.shortcut && <kbd className="cp__kbd">{c.shortcut}</kbd>}
                      </motion.li>
                    ))}
                  </motion.ul>
                </div>
                <footer className="cp__foot">
                  <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
                  <span><kbd>↵</kbd> run</span>
                  <span><kbd>Esc</kbd> close</span>
                </footer>
              </motion.div>
            </RD.Content>
          </RD.Portal>
        )}
      </AnimatePresence>
    </RD.Root>
  );
}
