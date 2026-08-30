/* ============================================================
   sparkEditor · src/shell/Terminal/TerminalView.tsx

   The terminal surface. A real shell runs in the Rust host; this
   component owns three jobs and nothing else:

     1. Size — measure the box, convert to rows/cols, tell the host.
     2. Paint — apply row deltas from `pty://frame` into a grid.
     3. Input — encode key/paste events and post them to the pty.

   There is no terminal emulator here. The host already resolved
   every cell's text and colour, so painting is a list of styled
   spans, and a frame that changes three rows repaints three rows.
   ============================================================ */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  encodeKey,
  encodePaste,
  onPtyExit,
  onPtyFrame,
  ptyKill,
  ptyResize,
  ptyScroll,
  ptySpawn,
  ptyWrite,
  PtyUnavailable,
  type PtyFrame,
  type PtyPrivilege,
  type PtySpan,
} from "@bridge/pty";
import { useCellMetrics } from "./useCellMetrics";
import { applyFrame as reduceFrame, emptyGrid, isFresh, type Grid } from "./grid";
import "./TerminalView.css";

const FONT_FAMILY = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace';
const FONT_SIZE = 13;
const LINE_HEIGHT = 1.35;
const PADDING = 8;

export type TerminalStatus =
  | { phase: "starting" }
  | { phase: "running"; shell: string; privilege: PtyPrivilege }
  | { phase: "exited"; code: number; message?: string }
  | { phase: "failed"; message: string };

interface Props {
  cwd: string;
  privilege: PtyPrivilege;
  /** Bumping this restarts the session — used by the Root toggle. */
  restartKey?: number;
  onStatus?: (s: TerminalStatus) => void;
  onTitle?: (title: string | null) => void;
}

export function TerminalView({ cwd, privilege, restartKey = 0, onStatus, onTitle }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);
  const cell = useCellMetrics(FONT_FAMILY, FONT_SIZE, LINE_HEIGHT);

  const [grid, setGrid] = useState<Grid>(() => emptyGrid(24));
  const [size, setSize] = useState({ rows: 24, cols: 80 });
  const [cursor, setCursor] = useState({ row: 0, col: 0, visible: true });
  const [status, setStatus] = useState<TerminalStatus>({ phase: "starting" });
  const [focused, setFocused] = useState(false);
  const [scrolledBack, setScrolledBack] = useState(0);

  const sessionRef = useRef<string | null>(null);
  const modesRef = useRef({ applicationCursor: false, bracketedPaste: false });
  const seqRef = useRef(-1);
  /** Size the host has actually been told about, to avoid redundant IPC. */
  const sentSizeRef = useRef({ rows: 0, cols: 0 });

  /* Callbacks change identity on every parent render; holding them in a
     ref keeps the session effect from tearing down the shell. */
  const onStatusRef = useRef(onStatus);
  const onTitleRef = useRef(onTitle);
  useEffect(() => {
    onStatusRef.current = onStatus;
    onTitleRef.current = onTitle;
  });

  const publishStatus = useCallback((s: TerminalStatus) => {
    setStatus(s);
    onStatusRef.current?.(s);
  }, []);

  /* ---------- Size: box -> rows/cols ---------- */

  const recomputeSize = useCallback(() => {
    const el = hostRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const usableW = box.width - PADDING * 2;
    const usableH = box.height - PADDING * 2;
    if (usableW <= 0 || usableH <= 0) return;
    const cols = Math.max(2, Math.floor(usableW / cell.width));
    const rows = Math.max(1, Math.floor(usableH / cell.height));
    setSize((prev) => (prev.rows === rows && prev.cols === cols ? prev : { rows, cols }));
  }, [cell.width, cell.height]);

  useLayoutEffect(() => {
    recomputeSize();
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => recomputeSize());
    ro.observe(el);
    return () => ro.disconnect();
  }, [recomputeSize]);

  /* ---------- Session lifecycle ----------

     One effect owns the whole session: spawn, subscribe, and on
     teardown kill the shell. `cwd`/`privilege`/`restartKey` changing
     means a different session, so the old one is torn down first.
  */
  useEffect(() => {
    let disposed = false;
    let unlistenFrame: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let spawnedId: string | null = null;

    seqRef.current = -1;
    sentSizeRef.current = { rows: 0, cols: 0 };
    setGrid(emptyGrid(size.rows));
    setScrolledBack(0);
    publishStatus({ phase: "starting" });

    (async () => {
      try {
        // Subscribe before spawning so the shell's first prompt — which
        // can arrive before `ptySpawn` resolves — is never dropped.
        const [uf, ue] = await Promise.all([
          onPtyFrame((frame) => {
            if (disposed || frame.id !== sessionRef.current) return;
            applyFrame(frame);
          }),
          onPtyExit((e) => {
            if (disposed || e.id !== sessionRef.current) return;
            publishStatus({ phase: "exited", code: e.code, message: e.message });
          }),
        ]);
        if (disposed) {
          uf();
          ue();
          return;
        }
        unlistenFrame = uf;
        unlistenExit = ue;

        const session = await ptySpawn({
          cwd,
          rows: size.rows,
          cols: size.cols,
          privilege,
        });
        if (disposed) {
          void ptyKill(session.id).catch(() => {});
          return;
        }
        spawnedId = session.id;
        sessionRef.current = session.id;
        sentSizeRef.current = { rows: session.rows, cols: session.cols };
        publishStatus({ phase: "running", shell: session.shell, privilege: session.privilege });
      } catch (err) {
        if (disposed) return;
        const message =
          err instanceof PtyUnavailable
            ? err.message
            : String((err as { message?: string })?.message ?? err);
        publishStatus({ phase: "failed", message });
      }
    })();

    return () => {
      disposed = true;
      unlistenFrame?.();
      unlistenExit?.();
      const id = spawnedId ?? sessionRef.current;
      if (id) {
        sessionRef.current = null;
        void ptyKill(id).catch(() => {});
      }
    };
    // Size is read at spawn time only; later changes go through pty_resize.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, privilege, restartKey, publishStatus]);

  /* ---------- Frame application ---------- */

  const applyFrame = useCallback((frame: PtyFrame) => {
    if (!isFresh(frame, seqRef.current)) return;
    seqRef.current = frame.seq;

    modesRef.current = {
      applicationCursor: frame.applicationCursor,
      bracketedPaste: frame.bracketedPaste,
    };
    setCursor({ row: frame.cursorRow, col: frame.cursorCol, visible: frame.cursorVisible });
    setScrolledBack(frame.scrollback);
    onTitleRef.current?.(frame.title ?? null);
    setGrid((prev) => reduceFrame(prev, frame));
  }, []);

  /* ---------- Push size changes to the host ---------- */

  useEffect(() => {
    const id = sessionRef.current;
    if (!id || status.phase !== "running") return;
    if (sentSizeRef.current.rows === size.rows && sentSizeRef.current.cols === size.cols) return;
    sentSizeRef.current = { rows: size.rows, cols: size.cols };
    void ptyResize(id, size.rows, size.cols).catch(() => {});
  }, [size.rows, size.cols, status.phase]);

  /* ---------- Input ---------- */

  const send = useCallback((data: string) => {
    const id = sessionRef.current;
    if (!id) return;
    void ptyWrite(id, data).catch(() => {});
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (status.phase !== "running") return;

      // Let the app keep its own clipboard shortcuts. Ctrl+Shift+C/V is
      // the terminal convention precisely because Ctrl+C must reach the
      // shell as SIGINT.
      if (e.ctrlKey && e.shiftKey && (e.key === "C" || e.key === "c")) return;
      if (e.ctrlKey && e.shiftKey && (e.key === "V" || e.key === "v")) return;

      const bytes = encodeKey(e.nativeEvent, modesRef.current);
      if (bytes === null) return;
      e.preventDefault();
      e.stopPropagation();
      send(bytes);
    },
    [send, status.phase],
  );

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      e.preventDefault();
      const text = e.clipboardData.getData("text/plain");
      if (text) send(encodePaste(text, modesRef.current.bracketedPaste));
    },
    [send],
  );

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      const id = sessionRef.current;
      if (!id) return;
      // Three rows per notch matches the platform convention closely
      // enough and keeps long output navigable.
      const delta = e.deltaY > 0 ? -3 : 3;
      void ptyScroll(id, delta).catch(() => {});
    },
    [],
  );

  /* Copy the selection with Ctrl+Shift+C, the terminal convention. */
  const onCopyShortcut = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!(e.ctrlKey && e.shiftKey && (e.key === "C" || e.key === "c"))) return;
    const text = window.getSelection()?.toString() ?? "";
    if (text) void navigator.clipboard?.writeText(text).catch(() => {});
  }, []);

  /* ---------- Render ---------- */

  const gridStyle = useMemo(
    () => ({
      fontFamily: FONT_FAMILY,
      fontSize: `${FONT_SIZE}px`,
      lineHeight: `${cell.height}px`,
      width: `${size.cols * cell.width}px`,
      height: `${size.rows * cell.height}px`,
    }),
    [cell.width, cell.height, size.cols, size.rows],
  );

  const showCursor = cursor.visible && focused && status.phase === "running" && scrolledBack === 0;

  return (
    <div
      ref={hostRef}
      className={`tv ${focused ? "is-focused" : ""}`}
      style={{ padding: PADDING }}
      onWheel={onWheel}
    >
      <div
        ref={screenRef}
        className="tv__screen"
        style={gridStyle}
        tabIndex={0}
        role="textbox"
        aria-multiline="true"
        aria-label="Terminal"
        onKeyDown={(e) => {
          onCopyShortcut(e);
          onKeyDown(e);
        }}
        onPaste={onPaste}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      >
        {grid.map((row, y) => (
          <div key={y} className="tv__row" style={{ top: y * cell.height, height: cell.height }}>
            {row ? row.spans.map((span, i) => <Cell key={i} span={span} cell={cell} />) : null}
          </div>
        ))}

        {showCursor && (
          <div
            className="tv__cursor"
            style={{
              top: cursor.row * cell.height,
              left: cursor.col * cell.width,
              width: cell.width,
              height: cell.height,
            }}
            aria-hidden
          />
        )}
      </div>

      {scrolledBack > 0 && (
        <button
          type="button"
          className="tv__scrollback"
          onClick={() => {
            const id = sessionRef.current;
            if (id) void ptyScroll(id, 0, 0).catch(() => {});
          }}
        >
          {scrolledBack} rows back — jump to latest
        </button>
      )}

      {status.phase !== "running" && <StatusOverlay status={status} />}
    </div>
  );
}

/** One styled run, positioned by column so gaps stay gaps. */
function Cell({ span, cell }: { span: PtySpan; cell: { width: number; height: number } }) {
  const fg = span.inverse ? span.bg : span.fg;
  const bg = span.inverse ? span.fg : span.bg;
  return (
    <span
      className="tv__span"
      style={{
        left: span.col * cell.width,
        color: fg ?? (span.inverse ? "var(--term-bg)" : undefined),
        background: bg ?? (span.inverse ? "var(--term-fg)" : undefined),
        fontWeight: span.bold ? 700 : undefined,
        fontStyle: span.italic ? "italic" : undefined,
        textDecoration: span.underline ? "underline" : undefined,
      }}
    >
      {span.text}
    </span>
  );
}

function StatusOverlay({ status }: { status: TerminalStatus }) {
  switch (status.phase) {
    case "starting":
      return <div className="tv__overlay tv__overlay--quiet">Starting shell…</div>;
    case "exited":
      return (
        <div className="tv__overlay">
          Shell exited{status.code !== 0 ? ` with code ${status.code}` : ""}.
          {status.message ? ` ${status.message}` : ""}
        </div>
      );
    case "failed":
      return <div className="tv__overlay tv__overlay--error">{status.message}</div>;
    case "running":
      return null;
  }
}
