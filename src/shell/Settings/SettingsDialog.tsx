/* ============================================================
   sparkBook · src/shell/Settings/SettingsDialog.tsx

   Settings, opened from the gear at the bottom of the plugin rail
   or from the command palette ("Settings").

   Every control writes straight through to the store, which
   persists and broadcasts. There is no Save button and no draft
   copy: a preference you can see the effect of is easier to judge
   than one you have to commit to first, and the pop-out terminal
   window picks the change up over the same broadcast.

   Position and size live here rather than in CSS. Centring a fixed
   box with `transform: translate(-50%, -50%)` cannot survive this
   dialog: the entrance animation writes `transform` for its scale
   and slide, so the centring only held once the animation settled
   on the identity transform and CSS took over again. Sizing the
   sheet in JS gives the drag somewhere to start from and leaves
   `transform` entirely to the animation.
   ============================================================ */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as RD from "@radix-ui/react-dialog";
import { motion, AnimatePresence } from "@motion/index";
import { overlayBackdropVariants, modalVariants } from "@motion/index";
import { Icon } from "@ui/Icon";
import { useTheme, type ThemeId } from "@theme/ThemeProvider";
import {
  useSettings,
  MOBILE_PRESETS,
  LIMITS,
  type Density,
  type TerminalCursorStyle,
} from "@store/settings";
import "./SettingsDialog.css";

type SectionId = "appearance" | "editor" | "terminal";

/* Preferred sheet size, and how much of a small window it may take. */
const MAX_W = 680;
const MAX_H = 560;
const EDGE = 8;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function centred(): Rect {
  const vw = typeof window === "undefined" ? MAX_W : window.innerWidth;
  const vh = typeof window === "undefined" ? MAX_H : window.innerHeight;
  const w = Math.min(Math.round(vw * 0.94), MAX_W);
  const h = Math.min(Math.round(vh * 0.82), MAX_H);
  return { w, h, x: Math.max(EDGE, Math.round((vw - w) / 2)), y: Math.max(EDGE, Math.round((vh - h) / 2)) };
}

/** Keep enough of the sheet on screen to grab and to close. */
function clampToViewport(r: Rect): Rect {
  const w = Math.min(r.w, window.innerWidth - EDGE * 2);
  const h = Math.min(r.h, window.innerHeight - EDGE * 2);
  return {
    w,
    h,
    x: Math.max(EDGE - w + 120, Math.min(r.x, window.innerWidth - 120)),
    y: Math.max(EDGE, Math.min(r.y, window.innerHeight - 48)),
  };
}

const SECTIONS: { id: SectionId; label: string; icon: string }[] = [
  { id: "appearance", label: "Appearance", icon: "palette" },
  { id: "editor", label: "Editor", icon: "typography" },
  { id: "terminal", label: "Terminal", icon: "terminal" },
];

const THEMES: { id: ThemeId; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "navy", label: "Navy" },
  { id: "amber", label: "Amber" },
  { id: "red", label: "Red" },
];

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [section, setSection] = useState<SectionId>("appearance");

  /* Survives close/reopen: a dialog you moved should be where you left
     it next time, not back in the middle. */
  const [rect, setRect] = useState<Rect>(centred);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onResize = () => setRect((r) => clampToViewport(r));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open]);

  const onHeaderPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // The close button lives in the header; dragging must not swallow it.
      if ((e.target as HTMLElement).closest("button")) return;
      dragRef.current = { dx: e.clientX - rect.x, dy: e.clientY - rect.y };
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // Capture is an optimisation — without it the drag still tracks
        // pointermove on the header, it just stops if you outrun it.
      }
    },
    [rect.x, rect.y],
  );

  const onHeaderPointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    setRect((r) => clampToViewport({ ...r, x: e.clientX - drag.dx, y: e.clientY - drag.dy }));
  }, []);

  const endDrag = useCallback((e: React.PointerEvent) => {
    dragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  }, []);

  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <RD.Portal forceMount>
            <RD.Overlay asChild>
              <motion.div
                className="dialog__backdrop"
                variants={overlayBackdropVariants}
                initial="initial"
                animate="animate"
                exit="exit"
              />
            </RD.Overlay>
            <RD.Content asChild>
              <motion.div
                className="settings"
                variants={modalVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                aria-label="Settings"
                style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
              >
                {/* Title and description share one header so the sheet has
                    exactly two rows to lay out — as three grid children the
                    description took the 1fr and pushed the sections to the
                    bottom of an empty sheet — and so there is one thing to
                    drag by. */}
                <header
                  className="settings__head"
                  onPointerDown={onHeaderPointerDown}
                  onPointerMove={onHeaderPointerMove}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                >
                  <RD.Title className="settings__title">Settings</RD.Title>
                  <RD.Description className="settings__desc">
                    Saved as you change them.
                  </RD.Description>
                  <RD.Close asChild>
                    <button className="settings__close" aria-label="Close settings">
                      <Icon name="close" size={16} />
                    </button>
                  </RD.Close>
                </header>

                <div className="settings__layout">
                  <nav className="settings__nav" aria-label="Settings sections">
                    {SECTIONS.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className={`settings__navItem ${section === s.id ? "is-active" : ""}`}
                        aria-current={section === s.id}
                        onClick={() => setSection(s.id)}
                      >
                        <Icon name={s.icon} size={15} />
                        <span>{s.label}</span>
                      </button>
                    ))}
                  </nav>

                  <div className="settings__pane">
                    {section === "appearance" && <AppearancePane />}
                    {section === "editor" && <EditorPane />}
                    {section === "terminal" && <TerminalPane />}
                  </div>
                </div>
              </motion.div>
            </RD.Content>
          </RD.Portal>
        )}
      </AnimatePresence>
    </RD.Root>
  );
}

/* ---------- Panes ---------- */

function AppearancePane() {
  const { theme, setTheme } = useTheme();
  const a = useSettings((s) => s.settings.appearance);
  const set = useSettings((s) => s.setAppearance);
  const reset = useSettings((s) => s.resetSection);

  return (
    <Pane title="Appearance" onReset={() => reset("appearance")}>
      <Row label="Theme" hint="Navy, amber and red never follow the system setting.">
        <Segmented
          value={theme}
          options={THEMES.map((t) => ({ value: t.id, label: t.label }))}
          onChange={(v) => setTheme(v as ThemeId)}
          wrap
        />
      </Row>

      <Row label="Density" hint="Compact tightens the chrome, not the text you are editing.">
        <Segmented
          value={a.density}
          options={[
            { value: "comfortable", label: "Comfortable" },
            { value: "compact", label: "Compact" },
          ]}
          onChange={(v) => set({ density: v as Density })}
        />
      </Row>

      <Row label="Interface text" hint={`${Math.round(a.uiFontScale * 100)}% of the base scale`}>
        <Slider
          value={a.uiFontScale}
          min={LIMITS.uiFontScale[0]}
          max={LIMITS.uiFontScale[1]}
          step={0.05}
          onChange={(v) => set({ uiFontScale: v })}
        />
      </Row>
    </Pane>
  );
}

function EditorPane() {
  const e = useSettings((s) => s.settings.editor);
  const set = useSettings((s) => s.setEditor);
  const reset = useSettings((s) => s.resetSection);

  return (
    <Pane title="Editor" onReset={() => reset("editor")}>
      <Row label="Font size" hint={`${e.fontSize}px`}>
        <Slider
          value={e.fontSize}
          min={LIMITS.editorFontSize[0]}
          max={LIMITS.editorFontSize[1]}
          step={0.5}
          onChange={(v) => set({ fontSize: v })}
        />
      </Row>

      <Row label="Tab size">
        <Segmented
          value={String(e.tabSize)}
          options={[
            { value: "2", label: "2" },
            { value: "4", label: "4" },
            { value: "8", label: "8" },
          ]}
          onChange={(v) => set({ tabSize: Number(v) })}
        />
      </Row>

      <Row label="Word wrap" hint="The default for newly opened files.">
        <Toggle checked={e.wordWrap} onChange={(v) => set({ wordWrap: v })} label="Word wrap" />
      </Row>

      <Row label="Line numbers">
        <Toggle
          checked={e.lineNumbers}
          onChange={(v) => set({ lineNumbers: v })}
          label="Line numbers"
        />
      </Row>
    </Pane>
  );
}

function TerminalPane() {
  const t = useSettings((s) => s.settings.terminal);
  const set = useSettings((s) => s.setTerminal);
  const reset = useSettings((s) => s.resetSection);

  const activePreset = MOBILE_PRESETS.find(
    (p) => p.w === t.mobileWidth && p.h === t.mobileHeight,
  );

  return (
    <Pane title="Terminal" onReset={() => reset("terminal")}>
      <Row label="Font size" hint={`${t.fontSize}px — changes the column count`}>
        <Slider
          value={t.fontSize}
          min={LIMITS.terminalFontSize[0]}
          max={LIMITS.terminalFontSize[1]}
          step={0.5}
          onChange={(v) => set({ fontSize: v })}
        />
      </Row>

      <Row label="Line height" hint={`${t.lineHeight.toFixed(2)}×`}>
        <Slider
          value={t.lineHeight}
          min={LIMITS.terminalLineHeight[0]}
          max={LIMITS.terminalLineHeight[1]}
          step={0.05}
          onChange={(v) => set({ lineHeight: v })}
        />
      </Row>

      <Row label="Cursor">
        <Segmented
          value={t.cursorStyle}
          options={[
            { value: "block", label: "Block" },
            { value: "bar", label: "Bar" },
            { value: "underline", label: "Underline" },
          ]}
          onChange={(v) => set({ cursorStyle: v as TerminalCursorStyle })}
        />
      </Row>

      <Row label="Blink cursor">
        <Toggle
          checked={t.cursorBlink}
          onChange={(v) => set({ cursorBlink: v })}
          label="Blink cursor"
        />
      </Row>

      <Row label="Scroll step" hint={`${t.scrollRows} rows per wheel notch`}>
        <Slider
          value={t.scrollRows}
          min={LIMITS.scrollRows[0]}
          max={LIMITS.scrollRows[1]}
          step={1}
          onChange={(v) => set({ scrollRows: v })}
        />
      </Row>

      <Row
        label="Open as"
        hint="Root sessions respawn through pkexec or sudo; your OS asks for the password."
      >
        <Segmented
          value={t.defaultPrivilege}
          options={[
            { value: "user", label: "User" },
            { value: "root", label: "Root" },
          ]}
          onChange={(v) => set({ defaultPrivilege: v === "root" ? "root" : "user" })}
        />
      </Row>

      <Row
        label="Mobile view"
        hint={`${t.mobileWidth}×${t.mobileHeight}${activePreset ? ` · ${activePreset.label}` : " · custom"}`}
      >
        <div className="settings__stack">
          <Segmented
            value={activePreset?.id ?? "custom"}
            options={[
              ...MOBILE_PRESETS.map((p) => ({ value: p.id, label: p.label })),
              ...(activePreset ? [] : [{ value: "custom", label: "Custom" }]),
            ]}
            onChange={(v) => {
              const p = MOBILE_PRESETS.find((x) => x.id === v);
              if (p) set({ mobileWidth: p.w, mobileHeight: p.h });
            }}
            wrap
          />
          <div className="settings__dims">
            <NumberField
              label="W"
              value={t.mobileWidth}
              min={LIMITS.mobileWidth[0]}
              max={LIMITS.mobileWidth[1]}
              onChange={(v) => set({ mobileWidth: v })}
            />
            <span className="settings__times" aria-hidden>
              ×
            </span>
            <NumberField
              label="H"
              value={t.mobileHeight}
              min={LIMITS.mobileHeight[0]}
              max={LIMITS.mobileHeight[1]}
              onChange={(v) => set({ mobileHeight: v })}
            />
          </div>
        </div>
      </Row>
    </Pane>
  );
}

/* ---------- Building blocks ---------- */

function Pane({
  title,
  onReset,
  children,
}: {
  title: string;
  onReset: () => void;
  children: ReactNode;
}) {
  return (
    <section className="settings__section" aria-label={title}>
      <header className="settings__sectionHead">
        <h3 className="settings__sectionTitle">{title}</h3>
        <button type="button" className="settings__reset" onClick={onReset}>
          <Icon name="reset" size={13} />
          <span>Reset</span>
        </button>
      </header>
      {children}
    </section>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="settings__row">
      <div className="settings__rowLabel">
        <span className="settings__label">{label}</span>
        {hint && <span className="settings__hint">{hint}</span>}
      </div>
      <div className="settings__control">{children}</div>
    </div>
  );
}

function Segmented({
  value,
  options,
  onChange,
  wrap,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  wrap?: boolean;
}) {
  return (
    <div className={`seg ${wrap ? "seg--wrap" : ""}`} role="group">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`seg__item ${value === o.value ? "is-active" : ""}`}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`switch ${checked ? "is-on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch__knob" aria-hidden />
    </button>
  );
}

function Slider({
  value,
  min,
  max,
  step,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <input
      type="range"
      className="settings__slider"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="settings__num">
      <span className="settings__numLabel">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={1}
        onChange={(e) => {
          const n = Number(e.target.value);
          // The store clamps too; guarding here stops an empty field from
          // being read as 0 and snapping the control to the minimum.
          if (Number.isFinite(n) && e.target.value !== "") onChange(n);
        }}
      />
    </label>
  );
}
