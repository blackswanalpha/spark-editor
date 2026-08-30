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
  encodeArrow,
  encodeKey,
  encodePaste,
  encodeWheelMouse,
  onPtyExit,
  onPtyFrame,
  ptyKill,
  ptyRefresh,
  ptyResize,
  ptyScroll,
  ptySpawn,
  ptyWrite,
  PtyUnavailable,
  type PtyFrame,
  type PtyMouseEncoding,
  type PtyMouseMode,
  type PtyPrivilege,
  type PtySpan,
} from "@bridge/pty";
import { useSettings } from "@store/settings";
import { useCellMetrics } from "./useCellMetrics";
import { applyFrame as reduceFrame, emptyGrid, isFresh, type Grid } from "./grid";
import {
  offsetForThumbFraction,
  scrollIntentForKey,
  thumbGeometry,
  wheelRows,
} from "./scroll";
import "./TerminalView.css";

const FONT_FAMILY = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace';
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

  /* Typography and scroll feel come from Settings → Terminal. Changing
     the font size changes the cell, which changes rows/cols, which the
     size effect below reports to the host — so the shell always agrees
     with what is on screen. */
  const fontSize = useSettings((s) => s.settings.terminal.fontSize);
  const lineHeight = useSettings((s) => s.settings.terminal.lineHeight);
  const cursorStyle = useSettings((s) => s.settings.terminal.cursorStyle);
  const cursorBlink = useSettings((s) => s.settings.terminal.cursorBlink);
  const scrollRows = useSettings((s) => s.settings.terminal.scrollRows);

  const cell = useCellMetrics(FONT_FAMILY, fontSize, lineHeight);

  const [grid, setGrid] = useState<Grid>(() => emptyGrid(24));
  const [size, setSize] = useState({ rows: 24, cols: 80 });
  const [cursor, setCursor] = useState({ row: 0, col: 0, visible: true });
  const [status, setStatus] = useState<TerminalStatus>({ phase: "starting" });
  const [focused, setFocused] = useState(false);
  const [scrolledBack, setScrolledBack] = useState(0);
  const [scrollMax, setScrollMax] = useState(0);

  const sessionRef = useRef<string | null>(null);
  const modesRef = useRef({
    applicationCursor: false,
    bracketedPaste: false,
    alternateScreen: false,
    mouseMode: "none" as PtyMouseMode,
    mouseEncoding: "default" as PtyMouseEncoding,
  });
  const seqRef = useRef(-1);
  /** Size the host has actually been told about, to avoid redundant IPC. */
  const sentSizeRef = useRef({ rows: 0, cols: 0 });
  /** Coalesced scroll intent — see the viewport scrolling section below. */
  const scrollRef = useRef<{ pending: number; absolute: number | null; busy: boolean }>({
    pending: 0,
    absolute: null,
    busy: false,
  });
  const scrollWarnedRef = useRef(false);

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

  /** Whether the box had a size last time it was measured. */
  const visibleRef = useRef(false);

  const recomputeSize = useCallback(() => {
    const el = hostRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const usableW = box.width - PADDING * 2;
    const usableH = box.height - PADDING * 2;
    if (usableW <= 0 || usableH <= 0) {
      visibleRef.current = false;
      return;
    }
    // Inactive tabs are `hidden`, so a box going from nothing to
    // something is this session coming to the front — the moment the
    // surface has to take the keyboard, or typing lands nowhere and the
    // terminal looks dead.
    if (!visibleRef.current) {
      visibleRef.current = true;
      screenRef.current?.focus({ preventScroll: true });
    }
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
    setScrollMax(0);
    scrollRef.current = { pending: 0, absolute: null, busy: false };
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

        // Subscribing early is not enough on its own: frames that arrive
        // before `ptySpawn` resolves carry an id this side does not know
        // yet, so the handler discards them. Everything after that is a
        // delta against rows the host already considers painted, which
        // would leave the first prompt missing until something else
        // rewrote its row. One full repaint closes that window.
        void ptyRefresh(session.id).catch(() => {});
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
      alternateScreen: frame.alternateScreen ?? false,
      mouseMode: frame.mouseMode ?? "none",
      mouseEncoding: frame.mouseEncoding ?? "default",
    };
    setCursor({ row: frame.cursorRow, col: frame.cursorCol, visible: frame.cursorVisible });
    setScrolledBack(frame.scrollback);
    // A host that predates `scrollbackMax` (a dev build mid-rebuild)
    // would otherwise poison the scrollbar geometry with NaN.
    setScrollMax(Number.isFinite(frame.scrollbackMax) ? frame.scrollbackMax : 0);
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

  /* ---------- Input ----------

     `send` sits above the scrolling section because a wheel is input
     too whenever a full-screen program owns the screen. */

  const send = useCallback((data: string) => {
    const id = sessionRef.current;
    if (!id) return;
    void ptyWrite(id, data).catch(() => {});
  }, []);

  /* ---------- Viewport scrolling ----------

     A step through history is a round trip: the host moves its window
     into vt100's scrollback and answers with a full frame. A trackpad
     produces those far faster than the channel can carry them, so
     gestures accumulate into one pending count with a single request in
     flight, and the sub-row remainder is kept so a slow drag still
     eventually moves a row. An absolute jump supersedes whatever
     relative movement was queued behind it.
  */
  const scrollFailed = useCallback((err: unknown) => {
    // One line, once per session: a scroll that cannot reach the host is
    // a real fault, and silently swallowing it is how "the terminal does
    // not scroll" becomes undiagnosable.
    if (scrollWarnedRef.current) return;
    scrollWarnedRef.current = true;
    console.warn("[terminal] scroll request failed", err);
  }, []);

  const pumpScroll = useCallback(() => {
    const st = scrollRef.current;
    if (st.busy) return;
    const id = sessionRef.current;
    if (!id) {
      st.pending = 0;
      st.absolute = null;
      return;
    }

    let call: Promise<number>;
    if (st.absolute !== null) {
      const target = st.absolute;
      st.absolute = null;
      st.pending = 0;
      call = ptyScroll(id, 0, target);
    } else {
      const whole = Math.trunc(st.pending);
      if (whole === 0) return;
      st.pending -= whole;
      call = ptyScroll(id, whole);
    }

    st.busy = true;
    void call
      .catch(scrollFailed)
      .finally(() => {
        st.busy = false;
        pumpScroll();
      });
  }, [scrollFailed]);

  const scrollBy = useCallback(
    (rows: number) => {
      if (!Number.isFinite(rows) || rows === 0) return;
      scrollRef.current.pending += rows;
      pumpScroll();
    },
    [pumpScroll],
  );

  const scrollTo = useCallback(
    (offset: number) => {
      if (!Number.isFinite(offset)) return;
      scrollRef.current.absolute = Math.max(0, Math.round(offset));
      pumpScroll();
    },
    [pumpScroll],
  );

  /* A wheel notch has three possible destinations, and picking the wrong
     one is why scrolling appears dead inside a full-screen program:

       1. The program turned mouse reporting on — hand it the wheel and
          let it scroll itself. This is the only thing that works in a TUI.
       2. The alternate screen is up with no mouse reporting — send arrow
          keys, which is what xterm's alternateScroll does for `less`.
       3. Otherwise the normal screen has real scrollback to move through.

     Only case 3 has a viewport to move; the first two must reach the tty,
     because the alternate grid keeps no history for anyone to scroll. */
  const wheelAccumRef = useRef(0);

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      const rows = wheelRows(e.deltaY, e.deltaMode, {
        rowsPerNotch: scrollRows,
        cellHeight: cell.height,
        viewportRows: size.rows,
      });
      if (rows === 0) return;

      // Whole steps only, with the remainder carried, so a trackpad's
      // sub-row deltas still add up to movement instead of vanishing.
      wheelAccumRef.current += rows;
      const steps = Math.trunc(wheelAccumRef.current);
      if (steps === 0) return;
      wheelAccumRef.current -= steps;

      const modes = modesRef.current;
      if (!modes.alternateScreen && modes.mouseMode === "none") {
        scrollBy(steps);
        return;
      }

      // One event must not fire off a screenful of keystrokes.
      const count = Math.min(Math.abs(steps), Math.max(1, size.rows));
      const up = steps > 0;

      if (modes.mouseMode !== "none") {
        const box = screenRef.current?.getBoundingClientRect();
        const col = box ? Math.floor((e.clientX - box.left) / cell.width) : 0;
        const row = box ? Math.floor((e.clientY - box.top) / cell.height) : 0;
        const report = encodeWheelMouse(
          {
            up,
            col: Math.min(Math.max(col, 0), size.cols - 1),
            row: Math.min(Math.max(row, 0), size.rows - 1),
            shift: e.shiftKey,
            alt: e.altKey,
            ctrl: e.ctrlKey,
          },
          modes.mouseEncoding,
        );
        send(report.repeat(count));
        return;
      }

      send(encodeArrow(up ? "up" : "down", modes.applicationCursor).repeat(count));
    },
    [scrollBy, send, scrollRows, cell.height, cell.width, size.rows, size.cols],
  );

  /* Dragging the scrollbar: the pointer marks the middle of the thumb,
     so a grab does not jump the viewport by half a screen. */
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const dragTo = useCallback(
    (clientY: number) => {
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      if (rect.height <= 0) return;
      const { height } = thumbGeometry(scrolledBack, scrollMax, size.rows);
      const raw = (clientY - rect.top) / rect.height - height / 2;
      const frac = Math.min(1 - height, Math.max(0, raw));
      scrollTo(offsetForThumbFraction(frac, scrollMax, size.rows));
    },
    [scrollTo, scrolledBack, scrollMax, size.rows],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (status.phase !== "running") return;

      // Let the app keep its own clipboard shortcuts. Ctrl+Shift+C/V is
      // the terminal convention precisely because Ctrl+C must reach the
      // shell as SIGINT.
      if (e.ctrlKey && e.shiftKey && (e.key === "C" || e.key === "c")) return;
      if (e.ctrlKey && e.shiftKey && (e.key === "V" || e.key === "v")) return;

      // Shift+PageUp/PageDown/Home/End move the viewport, not the shell.
      // Bare PageUp still goes to the tty: pagers and editors bind it.
      const intent = scrollIntentForKey(e.nativeEvent, {
        viewportRows: size.rows,
        scrollbackMax: scrollMax,
      });
      if (intent) {
        e.preventDefault();
        e.stopPropagation();
        if ("delta" in intent) scrollBy(intent.delta);
        else scrollTo(intent.absolute);
        return;
      }

      const bytes = encodeKey(e.nativeEvent, modesRef.current);
      if (bytes === null) return;
      e.preventDefault();
      e.stopPropagation();
      send(bytes);
    },
    [send, status.phase, size.rows, scrollMax, scrollBy, scrollTo],
  );

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      e.preventDefault();
      const text = e.clipboardData.getData("text/plain");
      if (text) send(encodePaste(text, modesRef.current.bracketedPaste));
    },
    [send],
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
      fontSize: `${fontSize}px`,
      lineHeight: `${cell.height}px`,
      width: `${size.cols * cell.width}px`,
      height: `${size.rows * cell.height}px`,
    }),
    [cell.width, cell.height, size.cols, size.rows, fontSize],
  );

  const thumb = useMemo(
    () => thumbGeometry(scrolledBack, scrollMax, size.rows),
    [scrolledBack, scrollMax, size.rows],
  );

  const showCursor = cursor.visible && focused && status.phase === "running" && scrolledBack === 0;

  return (
    <div
      ref={hostRef}
      className={`tv ${focused ? "is-focused" : ""}`}
      style={{ padding: PADDING }}
      onWheel={onWheel}
      onPointerDown={(e) => {
        // The grid does not fill the box: there is padding around it, and
        // short rows leave the right-hand side empty. Clicking any of that
        // must still put the keyboard on the terminal.
        if (e.target === e.currentTarget) screenRef.current?.focus({ preventScroll: true });
      }}
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
            className={`tv__cursor tv__cursor--${cursorStyle} ${cursorBlink ? "is-blinking" : ""}`}
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

      {scrollMax > 0 && (
        <div
          ref={trackRef}
          className={`tv__scrollbar ${scrolledBack > 0 ? "is-active" : ""}`}
          aria-hidden
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            draggingRef.current = true;
            dragTo(e.clientY);
          }}
          onPointerMove={(e) => {
            if (draggingRef.current) dragTo(e.clientY);
          }}
          onPointerUp={(e) => {
            draggingRef.current = false;
            e.currentTarget.releasePointerCapture(e.pointerId);
          }}
          onPointerCancel={() => {
            draggingRef.current = false;
          }}
        >
          <div
            className="tv__thumb"
            style={{ top: `${thumb.top * 100}%`, height: `${thumb.height * 100}%` }}
          />
        </div>
      )}

      {scrolledBack > 0 && (
        <button type="button" className="tv__scrollback" onClick={() => scrollTo(0)}>
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
