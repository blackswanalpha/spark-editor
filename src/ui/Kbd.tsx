import { type ReactNode } from "react";
import "./Kbd.css";

export function Kbd({ children, title }: { children: ReactNode; title?: string }) {
  return <kbd className="kbd" title={title}>{children}</kbd>;
}

export function KbdChord({ chord }: { chord: string }) {
  // Replace "Mod" with platform-appropriate modifier (rendered as <kbd>)
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const parts = chord.split("+");
  return (
    <span className="kbd-chord">
      {parts.map((p, i) => (
        <span key={i} style={{ display: "inline-flex", gap: 2 }}>
          {i > 0 && <span className="kbd-plus">+</span>}
          <Kbd>{p === "Mod" ? (isMac ? "⌘" : "Ctrl") : p}</Kbd>
        </span>
      ))}
    </span>
  );
}
