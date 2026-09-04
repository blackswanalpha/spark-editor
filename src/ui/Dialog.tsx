/* ============================================================
   sparkBook · src/ui/Dialog.tsx
   Built on Radix Dialog (a11y: focus trap, ESC, scroll lock).
   ============================================================ */
import * as RD from "@radix-ui/react-dialog";
import { motion, AnimatePresence } from "@motion/index";
import { overlayBackdropVariants, modalVariants } from "@motion/index";
import { Icon } from "./Icon";
import "./Dialog.css";

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  description?: string;
  children: React.ReactNode;
  size?: "sm" | "md" | "lg";
}

export function Dialog({ open, onOpenChange, title, description, children, size = "md" }: DialogProps) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <RD.Portal forceMount>
            <RD.Overlay asChild>
              <motion.div
                className="dialog__backdrop"
                variants={overlayBackdropVariants}
                initial="initial"
                animate="animate"
                exit="exit"
              />
            </RD.Overlay>
            <RD.Content asChild>
              <motion.div
                className={`dialog dialog--${size}`}
                variants={modalVariants}
                initial="initial"
                animate="animate"
                exit="exit"
              >
                {(title || description) && (
                  <header className="dialog__head">
                    {title && <RD.Title className="dialog__title">{title}</RD.Title>}
                    {description && <RD.Description className="dialog__desc">{description}</RD.Description>}
                    <RD.Close asChild>
                      <button className="dialog__close" aria-label="Close">
                        <Icon name="close" size={16} />
                      </button>
                    </RD.Close>
                  </header>
                )}
                <div className="dialog__body">{children}</div>
              </motion.div>
            </RD.Content>
          </RD.Portal>
        )}
      </AnimatePresence>
    </RD.Root>
  );
}

export function DialogFooter({ children }: { children: React.ReactNode }) {
  return <footer className="dialog__foot">{children}</footer>;
}
