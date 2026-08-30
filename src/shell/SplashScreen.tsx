/* ============================================================
   sparkEditor · src/shell/SplashScreen.tsx
   Boot overlay shown while the renderer initialises.
   Stages mirror the boot sequence (docs/explanation/
   state-and-persistence.md): assets → theme → IPC bridge →
   state.json → session restore → ready.

   The splash dismisses only when BOTH conditions hold:
     • the minimum-duration animation ran out, and
     • `ready` is not false (when the caller passes `ready`,
       boot completion gates the fade — no fake progress).
   ============================================================ */
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "@motion/index";
import { splashVariants, splashLogoVariants } from "@motion/index";
import { ProgressBar } from "@ui/Loader";
import { useAppVersion } from "@version";
import "./SplashScreen.css";

export interface SplashScreenProps {
  /** Force-show the splash. When omitted, auto-hides after `minDuration`. */
  show?: boolean;
  /**
   * Boot-completion gate from the caller. While `false` the splash stays
   * on screen even after `minDuration`. Omit for a pure timer splash.
   */
  ready?: boolean;
  /** Minimum time the splash stays on screen (ms). Default 1100. */
  minDuration?: number;
  /** Called once the splash has finished fading out. */
  onDone?: () => void;
}

const STAGES = [
  "loading assets…",
  "applying theme…",
  "connecting IPC bridge…",
  "reading state.json…",
  "restoring session…",
  "ready",
] as const;

export function SplashScreen({ show, ready, minDuration = 1100, onDone }: SplashScreenProps) {
  const version = useAppVersion();
  const [stage, setStage] = useState(0);
  const [progress, setProgress] = useState(0);
  const [timerDone, setTimerDone] = useState(false);
  const [internalShow, setInternalShow] = useState(true);

  // Drive stage + progress regardless of the "show" prop
  useEffect(() => {
    if (show === false) return;
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const elapsed = t - start;
      const pct = Math.min(1, elapsed / minDuration);
      setProgress(pct);
      if (pct < 0.2) setStage(0);
      else if (pct < 0.4) setStage(1);
      else if (pct < 0.6) setStage(2);
      else if (pct < 0.8) setStage(3);
      else if (pct < 1) setStage(4);
      else setStage(5);
      if (pct < 1) raf = requestAnimationFrame(tick);
      else setTimerDone(true);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [show, minDuration]);

  const bootDone = ready !== false;

  /* Hide once the minimum-duration animation has run out AND the
     caller reports boot complete (when the `ready` gate is used). */
  useEffect(() => {
    if (show === undefined && timerDone && bootDone) setInternalShow(false);
  }, [show, timerDone, bootDone]);

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
            v{version} · {STAGES[stage]}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
