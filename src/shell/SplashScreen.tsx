/* ============================================================
   sparkEditor · src/shell/SplashScreen.tsx
   Boot overlay shown while the renderer initialises.
   Three stages: "Loading assets…" → "Building index…" → "Ready"
   ============================================================ */
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "@motion/index";
import { splashVariants, splashLogoVariants, splashBarVariants } from "@motion/index";
import { ProgressBar } from "@ui/Loader";
import "./SplashScreen.css";

export interface SplashScreenProps {
  /** Force-show the splash. When omitted, auto-hides after `minDuration`. */
  show?: boolean;
  /** Minimum time the splash stays on screen (ms). Default 1100. */
  minDuration?: number;
  /** Called once the splash has finished fading out. */
  onDone?: () => void;
}

const STAGES = [
  "Loading assets…",
  "Building index…",
  "Restoring session…",
  "Ready",
] as const;

export function SplashScreen({ show, minDuration = 1100, onDone }: SplashScreenProps) {
  const [stage, setStage] = useState(0);
  const [progress, setProgress] = useState(0);
  const [internalShow, setInternalShow] = useState(true);

  // Drive stage + progress regardless of "show" prop
  useEffect(() => {
    if (show === false) return;
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const elapsed = t - start;
      const pct = Math.min(1, elapsed / minDuration);
      setProgress(pct);
      if (pct < 0.3) setStage(0);
      else if (pct < 0.55) setStage(1);
      else if (pct < 0.85) setStage(2);
      else setStage(3);
      if (pct < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const t = setTimeout(() => setInternalShow(false), minDuration);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); };
  }, [show, minDuration]);

  const visible = show === true || (show === undefined && internalShow);

  return (
    <AnimatePresence onExitComplete={() => onDone?.()}>
      {visible && (
        <motion.div
          className="splash"
          variants={splashVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          role="status"
          aria-label="Loading sparkEditor"
        >
          {/* Ambient gradient glow */}
          <div className="splash__halo" aria-hidden />

          <motion.div className="splash__inner" variants={splashLogoVariants} initial="initial" animate="animate" exit="exit">
            <img src="/spark-mark.svg" className="splash__mark" alt="" width={56} height={56} />
            <div className="splash__name">sparkEditor</div>
            <div className="splash__tag">The file is the source of truth.</div>
          </motion.div>

          <div className="splash__progress">
            <ProgressBar value={progress * 100} />
          </div>

          <motion.div
            className="splash__stage"
            key={stage}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
          >
            {STAGES[stage]}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
