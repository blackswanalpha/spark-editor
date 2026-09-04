/* ============================================================
   sparkBook · src/shell/Onboarding.tsx
   First-time-setup empty state — ported from
   designlabs/labs/onboarding.html. Shown when no documents are
   open. Cards dispatch the same command ids as the menus; the
   recents list reuses the sidebar's data source.
   ============================================================ */
import { motion } from "@motion/index";
import { Button } from "@ui/Button";
import { Icon } from "@ui/Icon";
import { staggerParent, staggerItem } from "@motion/index";
import { useAppVersion } from "@version";
import "./Onboarding.css";

export interface OnboardingProject {
  id: string;
  name: string;
  rootPath: string | null;
  /** Tabs stored in this project's workspace, shown as a hint of what
      reopening it will bring back. */
  tabCount?: number;
}

export interface OnboardingScreenProps {
  recents: { path: string; name: string }[];
  /** Folders opened before, most-recent-first. Optional so the single
      existing call site stays valid. */
  projects?: OnboardingProject[];
  /** Name of the project currently in front, when there is one. */
  projectName?: string;
  onOpenProject?: (id: string) => void;
  /** Opens the project switcher. */
  onSwitchProject?: () => void;
  onOpenFile: () => void;
  onOpenFolder: () => void;
  onOpenRecent: (path: string) => void;
  onPalette: () => void;
}

export function OnboardingScreen({
  recents,
  projects = [],
  projectName,
  onOpenProject,
  onSwitchProject,
  onOpenFile,
  onOpenFolder,
  onOpenRecent,
  onPalette,
}: OnboardingScreenProps) {
  const version = useAppVersion();
  return (
    <motion.div
      className="onboard"
      role="region"
      aria-label="Welcome to sparkBook"
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
      <motion.div variants={staggerItem} className="onboard__title">
        {projectName ? `No files open in ${projectName}` : "Welcome to sparkBook"}
      </motion.div>
      <motion.p variants={staggerItem} className="onboard__sub">
        {projectName
          ? "Pick a file from the tree on the left. This project remembers its own tabs, tree and terminals, and comes back the way you left it."
          : "Open a folder and it becomes a project — its tabs, tree and terminals are remembered and restored the next time you launch. Nothing is written into your directories."}
      </motion.p>

      <motion.div variants={staggerItem} className="onboard__cards">
        <button className="onboard-card onboard-card--primary" type="button" onClick={onOpenFolder}>
          <Icon name="folder" size={20} className="onboard-card__icon" />
          <strong>{projects.length > 0 ? "New project…" : "Open a folder…"}</strong>
          <small>A folder becomes a project — no setup</small>
        </button>
        {projects.length > 0 && onSwitchProject && (
          <button className="onboard-card" type="button" onClick={onSwitchProject}>
            <Icon name="open" size={20} className="onboard-card__icon" />
            <strong>Switch project…</strong>
            <small>
              {projects.length} folder{projects.length === 1 ? "" : "s"} remembered
            </small>
          </button>
        )}
        <button className="onboard-card" type="button" onClick={onOpenFile}>
          <Icon name="file" size={20} className="onboard-card__icon" />
          <strong>Open file…</strong>
          <small>A single file, without a project</small>
        </button>
      </motion.div>

      {projects.length > 0 && onOpenProject && (
        <motion.div variants={staggerItem} className="onboard__recents">
          <div className="onboard__recents-title">Recent projects</div>
          <ul className="onboard__recents-list">
            {projects.slice(0, 5).map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="onboard__project"
                  onClick={() => onOpenProject(p.id)}
                  title={p.rootPath ?? p.name}
                >
                  <Icon name="folder" size={14} className="onboard__project-icon" />
                  <span className="onboard__project-name">{p.name}</span>
                  {/* A renamed project shows where it points; one still
                      named after its own folder would just repeat itself. */}
                  <span className="onboard__project-path">
                    {p.rootPath && p.rootPath !== p.name ? p.rootPath : ""}
                  </span>
                  {p.tabCount ? (
                    <span className="onboard__project-tabs">
                      {p.tabCount} tab{p.tabCount === 1 ? "" : "s"}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </motion.div>
      )}

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
        <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>O</kbd> to open a folder · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>{" "}
        to switch project · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> for the command palette
      </motion.div>
      <motion.div variants={staggerItem}>
        <Button variant="ghost" icon="command" onClick={onPalette} className="onboard__palette-link">
          Command palette
        </Button>
      </motion.div>
      <motion.div variants={staggerItem} className="onboard__version">v{version}</motion.div>
    </motion.div>
  );
}
