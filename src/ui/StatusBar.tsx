/* ============================================================
   sparkBook · src/ui/StatusBar.tsx
   Status bar segments: mode, language, encoding, Ln:Col.
   ============================================================ */
import "./StatusBar.css";

import type { DocMode } from "@store/documents";
export function StatusBar({
  mode, language, encoding, line, col, dirty, onModeClick,
}: {
  mode: DocMode;
  language?: string;
  encoding?: string;
  line: number;
  col: number;
  dirty?: boolean;
  onModeClick?: () => void;
}) {
  return (
    <footer className="statusbar" role="contentinfo">
      <button className="status__seg status__mode" onClick={onModeClick} aria-label="Switch mode">
        <span className={`status__chip status__chip--${mode}`}>{mode}</span>
        {language && <span className="status__lang">{language}</span>}
      </button>
      <span className="status__spacer" />
      <span className="status__seg">{encoding ?? "UTF-8"}</span>
      <span className="status__seg">Ln {line}, Col {col}</span>
      {dirty && <span className="status__seg status__seg--dirty">●</span>}
    </footer>
  );
}
