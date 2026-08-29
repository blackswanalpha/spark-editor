/* ============================================================
   sparkEditor · src/shell/Onboarding.tsx
   First-time-setup empty state — ported from
   designlabs/labs/onboarding.html. Shown when no documents are
   open. Cards dispatch the same command ids as the menus; the
   recents list reuses the sidebar's data source.
   ============================================================ */
import { motion } from "@motion/index";
import { Button } from "@ui/Button";
import { Icon } from "@ui/Icon";
import { staggerParent, staggerItem } from "@motion/index";
import { APP_VERSION } from "@version";
import "./Onboarding.css";

export interface OnboardingScreenProps {
  recents: { path: string; name: string }[];
  onCreate: () => void;
  onOpenFile: () => void;
  onOpenFolder: () => void;
  onOpenRecent: (path: string) => void;
  onPalette: () => void;
}

export function OnboardingScreen({
  recents,
  onCreate,
  onOpenFile,
  onOpenFolder,
  onOpenRecent,
  onPalette,
}: OnboardingScreenProps) {
  return (
    <motion.div
      className="onboard"
      role="region"
      aria-label="Welcome to sparkEditor"
      variants={staggerParent(0.05)}
      initial="initial"
      animate="animate"
    >
      <motion.img
        variants={staggerItem}
        className="onboard__logo"
        src="/spark-mark.svg"
        alt=""
        width={64}
        height={64}
      />
      <motion.div variants={staggerItem} className="onboard__title">Welcome to sparkEditor</motion.div>
      <motion.p variants={staggerItem} className="onboard__sub">
        One window for markdown, rich text, and code. The file on disk is the source of truth —
        no proprietary format, no lock-in. Start something new, or pick up where you left off.
      </motion.p>

      <motion.div variants={staggerItem} className="onboard__cards">
        <button className="onboard-card" type="button" onClick={onCreate}>
          <Icon name="plus" size={20} className="onboard-card__icon" />
          <strong>New document</strong>
          <small>Start an untitled markdown file</small>
        </button>
        <button className="onboard-card" type="button" onClick={onOpenFile}>
          <Icon name="file" size={20} className="onboard-card__icon" />
          <strong>Open file…</strong>
          <small>Native dialog runs on the host</small>
        </button>
        <button className="onboard-card" type="button" onClick={onOpenFolder}>
          <Icon name="folder-open" size={20} className="onboard-card__icon" />
          <strong>Open folder…</strong>
          <small>Explore a directory tree</small>
        </button>
      </motion.div>

      <motion.div variants={staggerItem} className="onboard__recents">
        <div className="onboard__recents-title">Recent files</div>
        {recents.length === 0 ? (
          <div className="onboard__recents-empty">
            No recent files yet — everything you open will appear here (capped at 25).
          </div>
        ) : (
          <ul className="onboard__recents-list">
            {recents.slice(0, 5).map((r) => (
              <li key={r.path}>
                <button type="button" className="onboard__recent" onClick={() => onOpenRecent(r.path)} title={r.path}>
                  {r.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </motion.div>

      <motion.div variants={staggerItem} className="onboard__hint">
        <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>O</kbd> to open a folder · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>{" "}
        for the command palette
      </motion.div>
      <motion.div variants={staggerItem}>
        <Button variant="ghost" icon="command" onClick={onPalette} className="onboard__palette-link">
          Command palette
        </Button>
      </motion.div>
      <motion.div variants={staggerItem} className="onboard__version">v{APP_VERSION}</motion.div>
    </motion.div>
  );
}
