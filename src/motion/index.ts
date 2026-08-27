/* ============================================================
   sparkEditor · src/motion/index.ts
   Centralized animation primitives.

   This module is the single source of truth for the editor's
   motion language. It wraps framer-motion and re-exports CSS
   variables so any component can pick a duration/easing from
   one place.

   Three layers:
     1. Variants — semantic motion recipes (fade, slide, pop…)
     2. Transitions — easing curves + durations tuned per use
     3. Presets — composition of variants + transitions for
        common UI patterns (modal, toast, splash, etc.)
   ============================================================ */

import type { Transition, Variants } from "framer-motion";

/* ----------------------------------------------------------------
   1. Easings & durations — mirrors tokens.css
   ---------------------------------------------------------------- */
export const ease = {
  standard: [0.2, 0.6, 0.3, 1] as [number, number, number, number],
  spring:   [0.34, 1.56, 0.64, 1] as [number, number, number, number],
  out:      [0.16, 1, 0.3, 1] as [number, number, number, number],
  in:       [0.4, 0, 1, 1] as [number, number, number, number],
  inOut:    [0.4, 0, 0.2, 1] as [number, number, number, number],
};

export const duration = {
  instant: 0.06,
  fast:    0.12,
  med:     0.2,
  slow:    0.32,
  slower:  0.48,
};

export const transition: Record<string, Transition> = {
  fast:   { duration: duration.fast,  ease: ease.standard },
  med:    { duration: duration.med,   ease: ease.standard },
  slow:   { duration: duration.slow,  ease: ease.standard },
  spring: { type: "spring", stiffness: 380, damping: 30, mass: 0.9 },
  springSoft: { type: "spring", stiffness: 220, damping: 26, mass: 1 },
  bounce: { type: "spring", stiffness: 500, damping: 18, mass: 0.7 },
};

/* ----------------------------------------------------------------
   2. Variants — semantic recipes
   ---------------------------------------------------------------- */
export const fadeVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: transition.med },
  exit:    { opacity: 0, transition: transition.fast },
};

export const slideUpVariants: Variants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: transition.med },
  exit:    { opacity: 0, y: 8, transition: transition.fast },
};

export const slideDownVariants: Variants = {
  initial: { opacity: 0, y: -8 },
  animate: { opacity: 1, y: 0, transition: transition.med },
  exit:    { opacity: 0, y: -6, transition: transition.fast },
};

export const slideRightVariants: Variants = {
  initial: { opacity: 0, x: -16 },
  animate: { opacity: 1, x: 0, transition: transition.med },
  exit:    { opacity: 0, x: -10, transition: transition.fast },
};

export const scaleVariants: Variants = {
  initial: { opacity: 0, scale: 0.95 },
  animate: { opacity: 1, scale: 1, transition: transition.spring },
  exit:    { opacity: 0, scale: 0.96, transition: transition.fast },
};

export const popVariants: Variants = {
  initial: { opacity: 0, scale: 0.9 },
  animate: { opacity: 1, scale: 1, transition: transition.bounce },
  exit:    { opacity: 0, scale: 0.9, transition: transition.fast },
};

/* ----------------------------------------------------------------
   3. Presets — composed for common patterns
   ---------------------------------------------------------------- */
export const overlayBackdropVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: duration.med, ease: ease.standard } },
  exit:    { opacity: 0, transition: { duration: duration.fast, ease: ease.standard } },
};

export const modalVariants: Variants = {
  initial: { opacity: 0, scale: 0.96, y: 8 },
  animate: { opacity: 1, scale: 1, y: 0, transition: transition.spring },
  exit:    { opacity: 0, scale: 0.97, y: 4, transition: transition.fast },
};

export const popoverVariants: Variants = {
  initial: { opacity: 0, scale: 0.95, y: -4 },
  animate: { opacity: 1, scale: 1, y: 0, transition: transition.med },
  exit:    { opacity: 0, scale: 0.97, y: -2, transition: transition.fast },
};

export const toastVariants: Variants = {
  initial: { opacity: 0, y: 16, scale: 0.95 },
  animate: { opacity: 1, y: 0, scale: 1, transition: transition.springSoft },
  exit:    { opacity: 0, y: 8, scale: 0.95, transition: transition.fast },
};

export const splashVariants: Variants = {
  initial: { opacity: 1 },
  animate: { opacity: 1 },
  exit:    { opacity: 0, transition: { duration: duration.slower, ease: ease.out } },
};

export const splashLogoVariants: Variants = {
  initial: { opacity: 0, scale: 0.6, rotate: -8 },
  animate: {
    opacity: 1,
    scale: 1,
    rotate: 0,
    transition: { type: "spring", stiffness: 180, damping: 16, mass: 1.1 },
  },
  exit: { opacity: 0, scale: 0.85, transition: { duration: duration.slow, ease: ease.out } },
};

export const splashBarVariants: Variants = {
  initial: { scaleX: 0 },
  animate: { scaleX: 1, transition: { duration: duration.slower, ease: ease.out } },
};

/* ----------------------------------------------------------------
   4. Helpers — micro-interactions
   ---------------------------------------------------------------- */
export const tap = { scale: 0.97 };
export const hover = { scale: 1.02 };
export const buttonPress = { scale: 0.96 };

/* ----------------------------------------------------------------
   5. Stagger utilities — for lists and palettes
   ---------------------------------------------------------------- */
export const staggerParent = (gap = 0.03): Variants => ({
  initial: {},
  animate: { transition: { staggerChildren: gap, delayChildren: 0.04 } },
  exit:    { transition: { staggerChildren: gap, staggerDirection: -1 } },
});

export const staggerItem: Variants = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0, transition: transition.fast },
  exit:    { opacity: 0, y: 2, transition: { duration: duration.fast } },
};

/* ----------------------------------------------------------------
   6. Re-exports
   ---------------------------------------------------------------- */
export {
  motion,
  AnimatePresence,
  useReducedMotion,
  useAnimation,
  useMotionValue,
  useTransform,
} from "framer-motion";

export type { Transition, Variants } from "framer-motion";
