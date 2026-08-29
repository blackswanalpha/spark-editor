/* ============================================================
   sparkEditor · src/ui/Loader.tsx
   Three loader flavors: spinner, dots, progress bar.
   ============================================================ */
import { motion } from "@motion/index";
import "./Loader.css";

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span
      className="spinner"
      style={{ width: size, height: size }}
      aria-label="Loading"
      role="status"
    />
  );
}

export function Dots({ count = 3 }: { count?: number }) {
  return (
    <span className="dots" role="status" aria-label="Loading">
      {Array.from({ length: count }).map((_, i) => (
        <motion.span
          key={i}
          className="dot"
          animate={{ y: [0, -3, 0], opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.12, ease: "easeInOut" }}
        />
      ))}
    </span>
  );
}

export function ProgressBar({ value, max = 100 }: { value: number; max?: number }) {
  const pct = Math.max(0, Math.min(1, value / max)) * 100;
  return (
    <div className="progress" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
      <motion.div
        className="progress__fill"
        initial={{ width: 0 }}
        animate={{ width: `${pct}%` }}
        transition={{ duration: 0.3, ease: [0.2, 0.6, 0.3, 1] }}
      />
    </div>
  );
}

/**
 * Full-surface waiting overlay for long-running host work on the other
 * side of the IPC bridge (see designlabs/labs/loader.html). Use for
 * indeterminate work where the surrounding UI must appear inert.
 */
export function LoaderOverlay({ message, blocking = false }: { message?: string; blocking?: boolean }) {
  return (
    <motion.div
      className="loader-overlay"
      data-blocking={blocking || undefined}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      role="status"
      aria-live="polite"
      aria-label={message || "Loading"}
    >
      <div className="loader-overlay__box">
        <Spinner size={22} />
        {message && <span className="loader-overlay__msg">{message}</span>}
      </div>
    </motion.div>
  );
}
