/* ============================================================
   sparkEditor · src/ui/Popover.tsx
   Anchored popover built on Radix. Used for the bubble menu
   and rich-editor slash menu.
   ============================================================ */
import * as RP from "@radix-ui/react-popover";
import { motion, AnimatePresence } from "@motion/index";
import { popoverVariants } from "@motion/index";
import "./Popover.css";

export const Popover = RP.Root;
export const PopoverTrigger = RP.Trigger;
export const PopoverAnchor = RP.Anchor;

export function PopoverContent({
  children, side = "bottom", align = "start", sideOffset = 6, className, ...rest
}: React.ComponentProps<typeof RP.Content> & { children: React.ReactNode }) {
  return (
    <RP.Portal>
      <AnimatePresence>
        <RP.Content
          asChild
          side={side}
          align={align}
          sideOffset={sideOffset}
          {...rest}
        >
          <motion.div
            className={["popover", className].filter(Boolean).join(" ")}
            variants={popoverVariants}
            initial="initial"
            animate="animate"
            exit="exit"
          >
            {children}
          </motion.div>
        </RP.Content>
      </AnimatePresence>
    </RP.Portal>
  );
}
