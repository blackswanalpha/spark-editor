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
