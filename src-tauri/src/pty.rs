/* ============================================================
   sparkEditor · src-tauri/src/pty.rs

   Real terminal sessions. A `portable-pty` child process runs an
   actual login shell; its output is fed through a `vt100` parser
   that keeps the authoritative screen state here in Rust. The
   renderer receives already-resolved cell grids over the
   `pty://frame` event and never has to emulate anything itself.

   This replaces the previous xterm.js + fake-command-table panel.

   Privilege: `PtyPrivilege::Root` re-spawns the shell through
   pkexec (falling back to `sudo -i`) so the OS — not sparkEditor —
   collects the password. No credential ever transits this process.
   ============================================================ */

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::HostError;

/* ---------- Wire types ---------- */

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PtyPrivilege {
    /// A shell running as the current user. The safe default.
    #[default]
    User,
    Root,
}

/// One horizontal run of cells sharing identical styling. Runs keep
/// frames small: a typical 80x24 screen is a few hundred spans rather
/// than 1920 individual cells.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Span {
    /// Column the run starts at (0-based).
    pub col: u16,
    pub text: String,
    /// `#rrggbb`, or `null` for the theme's default foreground.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bg: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub bold: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub italic: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub underline: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub inverse: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Row {
    pub y: u16,
    pub spans: Vec<Span>,
}

/// Mouse reporting the program running in the terminal has turned on.
/// Mirrors `vt100::MouseProtocolMode`; the renderer only needs to know
/// whether *any* reporting is active, but carrying the mode keeps the
/// wire honest if click reporting is added later.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MouseMode {
    None,
    Press,
    PressRelease,
    ButtonMotion,
    AnyMotion,
}

impl From<vt100::MouseProtocolMode> for MouseMode {
    fn from(m: vt100::MouseProtocolMode) -> Self {
        match m {
            vt100::MouseProtocolMode::None => Self::None,
            vt100::MouseProtocolMode::Press => Self::Press,
            vt100::MouseProtocolMode::PressRelease => Self::PressRelease,
            vt100::MouseProtocolMode::ButtonMotion => Self::ButtonMotion,
            vt100::MouseProtocolMode::AnyMotion => Self::AnyMotion,
        }
    }
}

/// How mouse reports must be framed. Mirrors `vt100::MouseProtocolEncoding`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MouseEncoding {
    Default,
    Utf8,
    Sgr,
}

impl From<vt100::MouseProtocolEncoding> for MouseEncoding {
    fn from(e: vt100::MouseProtocolEncoding) -> Self {
        match e {
            vt100::MouseProtocolEncoding::Default => Self::Default,
            vt100::MouseProtocolEncoding::Utf8 => Self::Utf8,
            vt100::MouseProtocolEncoding::Sgr => Self::Sgr,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub id: String,
    pub rows: u16,
    pub cols: u16,
    /// Only rows that changed since the last frame, unless `full`.
    pub lines: Vec<Row>,
    pub full: bool,
    pub cursor_row: u16,
    pub cursor_col: u16,
    pub cursor_visible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// DECCKM. Arrow keys must be sent as SS3 (`ESC O A`) rather than
    /// CSI (`ESC [ A`) while set — readline and vim both rely on this.
    pub application_cursor: bool,
    /// Bracketed paste (DEC 2004): wrap pasted text in ESC[200~ / ESC[201~.
    pub bracketed_paste: bool,
    /// How many rows the view is currently scrolled back.
    pub scrollback: usize,
    /// Rows available above the viewport — the largest `scrollback` the
    /// buffer can currently take. The renderer needs it to size a
    /// scrollbar and to clamp a drag without a round trip per pixel.
    pub scrollback_max: usize,
    /// True while a full-screen program (an editor, a pager, a TUI) owns
    /// the screen. The alternate grid has no scrollback by construction,
    /// so a wheel must be handed to the program instead of moving a
    /// viewport that cannot move.
    pub alternate_screen: bool,
    /// Mouse reporting the program asked for, and how to frame it.
    pub mouse_mode: MouseMode,
    pub mouse_encoding: MouseEncoding,
    /// Frame counter — lets the renderer drop out-of-order deliveries.
    pub seq: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyExit {
    pub id: String,
    pub code: i32,
    /// Set when the session ended because spawning failed outright.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySession {
    pub id: String,
    pub shell: String,
    pub cwd: String,
    pub privilege: PtyPrivilege,
    pub rows: u16,
    pub cols: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootSupport {
    /// A privilege helper exists, so the Root toggle can work.
    pub available: bool,
    /// "pkexec" | "sudo" | "none"
    pub method: String,
    /// True when the process is *already* running as uid 0.
    pub already_root: bool,
}

/* ---------- Title sink ----------

   vt100 reports the window title through `Callbacks::set_window_title`
   (OSC 0/2) rather than exposing it on `Screen`. This sink parks the
   latest value in a shared slot the frame builder can read.
*/

#[derive(Clone, Default)]
struct TitleSink {
    title: Arc<Mutex<Option<String>>>,
}

impl vt100::Callbacks for TitleSink {
    fn set_window_title(&mut self, _: &mut vt100::Screen, title: &[u8]) {
        let text = String::from_utf8_lossy(title).to_string();
        if let Ok(mut slot) = self.title.lock() {
            *slot = if text.is_empty() { None } else { Some(text) };
        }
    }
}

type SessionParser = vt100::Parser<TitleSink>;

/* ---------- Session state ---------- */

struct Session {
    id: String,
    shell: String,
    cwd: String,
    privilege: PtyPrivilege,
    parser: Arc<Mutex<SessionParser>>,
    /// Latest OSC-set window title, written by `TitleSink`.
    title: Arc<Mutex<Option<String>>>,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    /// Set once the reader thread has seen EOF or `kill` was called;
    /// the reader loop and the frame pump both use it to stop.
    closed: Arc<AtomicBool>,
    /// "The parser moved, someone should paint." The reader sets it and
    /// notifies; the frame pump blocks on it. See `spawn_reader`.
    dirty: Arc<Signal>,
    /// Last grid we serialised, used to emit only changed rows.
    last_rows: Mutex<Vec<String>>,
    seq: AtomicU64,
    size: Mutex<(u16, u16)>,
}

/// A flag with a condition variable, so the frame pump can sleep until
/// there is something to do instead of polling.
#[derive(Default)]
struct Signal {
    flag: Mutex<bool>,
    cv: Condvar,
}

impl Signal {
    fn raise(&self) {
        if let Ok(mut f) = self.flag.lock() {
            *f = true;
        }
        // Notified even if the lock was poisoned: a pump waiting on a
        // timeout still wakes, and a missed wake is a stalled terminal.
        self.cv.notify_all();
    }

    /// Clear the flag and report whether it had been raised.
    fn take(&self) -> bool {
        match self.flag.lock() {
            Ok(mut f) => std::mem::replace(&mut *f, false),
            Err(_) => true,
        }
    }
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    next_id: AtomicU64,
}

impl PtyManager {
    fn get(&self, id: &str) -> Result<Arc<Session>, HostError> {
        self.sessions
            .lock()
            .map_err(poisoned)?
            .get(id)
            .cloned()
            .ok_or_else(|| HostError::NotFound {
                path: format!("pty session {id}"),
            })
    }
}

fn poisoned<T>(_: T) -> HostError {
    HostError::Internal {
        message: "pty manager lock poisoned".into(),
    }
}

/* ---------- Colour resolution ----------

   vt100 hands back either a palette index or true colour. The
   renderer wants concrete hex so a frame paints without needing a
   palette of its own; indices 0..15 use the standard xterm ANSI
   palette, 16..255 the 6x6x6 cube + greyscale ramp.
*/

fn ansi_hex(idx: u8) -> String {
    const BASE: [(u8, u8, u8); 16] = [
        (0x00, 0x00, 0x00),
        (0xcd, 0x31, 0x31),
        (0x0d, 0xbc, 0x79),
        (0xe5, 0xe5, 0x10),
        (0x24, 0x72, 0xc8),
        (0xbc, 0x3f, 0xbc),
        (0x11, 0xa8, 0xcd),
        (0xe5, 0xe5, 0xe5),
        (0x66, 0x66, 0x66),
        (0xf1, 0x4c, 0x4c),
        (0x23, 0xd1, 0x8b),
        (0xf5, 0xf5, 0x43),
        (0x3b, 0x8e, 0xea),
        (0xd6, 0x70, 0xd6),
        (0x29, 0xb8, 0xdb),
        (0xff, 0xff, 0xff),
    ];
    let (r, g, b) = if idx < 16 {
        BASE[idx as usize]
    } else if idx < 232 {
        let i = idx - 16;
        let level = |v: u8| -> u8 {
            if v == 0 {
                0
            } else {
                55 + v * 40
            }
        };
        (level(i / 36), level((i % 36) / 6), level(i % 6))
    } else {
        let v = 8 + (idx - 232) * 10;
        (v, v, v)
    };
    format!("#{r:02x}{g:02x}{b:02x}")
}

fn color_hex(c: vt100::Color) -> Option<String> {
    match c {
        vt100::Color::Default => None,
        vt100::Color::Idx(i) => Some(ansi_hex(i)),
        vt100::Color::Rgb(r, g, b) => Some(format!("#{r:02x}{g:02x}{b:02x}")),
    }
}

/* ---------- Grid serialisation ---------- */

/// Build the run-length span list for one screen row, plus a cheap
/// fingerprint used to skip unchanged rows on the next frame.
fn row_spans(screen: &vt100::Screen, y: u16, cols: u16) -> (Vec<Span>, String) {
    let mut spans: Vec<Span> = Vec::new();
    let mut key = String::with_capacity(cols as usize * 2);

    let mut run: Option<Span> = None;
    for x in 0..cols {
        let cell = screen.cell(y, x);
        // A wide glyph occupies two columns; the second is a continuation
        // cell whose contents repeat the same character. Emitting it would
        // render the glyph twice and push the rest of the row right.
        if cell.is_some_and(vt100::Cell::is_wide_continuation) {
            key.push('\u{2}');
            continue;
        }
        let (contents, fg, bg, bold, italic, underline, inverse) = match cell {
            Some(c) => {
                let text = c.contents();
                (
                    if text.is_empty() {
                        " ".to_string()
                    } else {
                        text.to_string()
                    },
                    color_hex(c.fgcolor()),
                    color_hex(c.bgcolor()),
                    c.bold() || c.dim(),
                    c.italic(),
                    c.underline(),
                    c.inverse(),
                )
            }
            None => (" ".to_string(), None, None, false, false, false, false),
        };

        key.push_str(&contents);
        key.push('\u{1}');
        key.push_str(fg.as_deref().unwrap_or("-"));
        key.push_str(bg.as_deref().unwrap_or("-"));
        key.push(match (bold, italic, underline, inverse) {
            (false, false, false, false) => '0',
            _ => '1',
        });

        let same = run.as_ref().is_some_and(|r| {
            r.fg == fg
                && r.bg == bg
                && r.bold == bold
                && r.italic == italic
                && r.underline == underline
                && r.inverse == inverse
        });

        if same {
            // `run` is Some whenever `same` is true.
            if let Some(r) = run.as_mut() {
                r.text.push_str(&contents);
            }
        } else {
            if let Some(r) = run.take() {
                spans.push(r);
            }
            run = Some(Span {
                col: x,
                text: contents,
                fg,
                bg,
                bold,
                italic,
                underline,
                inverse,
            });
        }
    }
    if let Some(r) = run.take() {
        spans.push(r);
    }

    // Trim trailing blanks off the last run when it carries no styling —
    // they repaint as background anyway and are most of a typical row.
    // A styled run (e.g. a selection bar) keeps its blanks: there the
    // background colour is the content.
    if let Some(last) = spans.last_mut() {
        if last.fg.is_none()
            && last.bg.is_none()
            && !last.bold
            && !last.italic
            && !last.underline
            && !last.inverse
        {
            let trimmed = last.text.trim_end_matches(' ');
            if trimmed.is_empty() {
                spans.pop();
            } else if trimmed.len() != last.text.len() {
                last.text.truncate(trimmed.len());
            }
        }
    }

    (spans, key)
}

fn build_frame(session: &Session, force_full: bool) -> Result<Frame, HostError> {
    let mut parser = session.parser.lock().map_err(poisoned)?;
    // vt100 exposes the scrollback *offset* but not the buffer's length.
    // `set_scrollback` clamps to that length and has no other effect, so
    // asking for more than could ever exist and reading the value back is
    // the length; restoring the previous offset leaves the screen as it was.
    let scrollback_max = {
        let screen = parser.screen_mut();
        let current = screen.scrollback();
        screen.set_scrollback(usize::MAX);
        let max = screen.scrollback();
        screen.set_scrollback(current);
        max
    };
    let screen = parser.screen();
    let (rows, cols) = screen.size();

    let mut last = session.last_rows.lock().map_err(poisoned)?;
    let resized = last.len() != rows as usize;
    let full = force_full || resized;
    if resized {
        last.clear();
        last.resize(rows as usize, String::new());
    }

    let mut lines = Vec::new();
    for y in 0..rows {
        let (spans, key) = row_spans(screen, y, cols);
        if full || last[y as usize] != key {
            last[y as usize] = key;
            lines.push(Row { y, spans });
        }
    }

    let (cursor_row, cursor_col) = screen.cursor_position();
    Ok(Frame {
        id: session.id.clone(),
        rows,
        cols,
        lines,
        full,
        cursor_row,
        cursor_col,
        cursor_visible: !screen.hide_cursor(),
        title: session.title.lock().ok().and_then(|t| t.clone()),
        application_cursor: screen.application_cursor(),
        bracketed_paste: screen.bracketed_paste(),
        scrollback: screen.scrollback(),
        scrollback_max,
        alternate_screen: screen.alternate_screen(),
        mouse_mode: screen.mouse_protocol_mode().into(),
        mouse_encoding: screen.mouse_protocol_encoding().into(),
        seq: session.seq.fetch_add(1, Ordering::SeqCst),
    })
}

fn emit_frame(app: &AppHandle, session: &Session, force_full: bool) {
    match build_frame(session, force_full) {
        Ok(frame) => {
            // A frame with no changed rows still matters when the cursor
            // moved, so only skip when nothing at all is pending.
            if frame.lines.is_empty() && !frame.full {
                let _ = app.emit("pty://cursor", &frame);
            } else {
                let _ = app.emit("pty://frame", &frame);
            }
        }
        Err(e) => {
            log_err("build_frame", &e);
        }
    }
}

fn log_err(what: &str, e: &HostError) {
    eprintln!("[pty] {what} failed: {e}");
}

/* ---------- Privilege helpers ---------- */

fn which(bin: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths).any(|dir| {
                let p = dir.join(bin);
                p.is_file()
            })
        })
        .unwrap_or(false)
}

#[cfg(unix)]
fn is_root() -> bool {
    // SAFETY: getuid is always safe; it takes no arguments and cannot fail.
    unsafe { libc_getuid() == 0 }
}

#[cfg(unix)]
extern "C" {
    #[link_name = "getuid"]
    fn libc_getuid() -> u32;
}

#[cfg(not(unix))]
fn is_root() -> bool {
    false
}

fn root_method() -> &'static str {
    if is_root() {
        return "none";
    }
    if cfg!(target_os = "windows") {
        return "none";
    }
    if which("pkexec") {
        "pkexec"
    } else if which("sudo") {
        "sudo"
    } else {
        "none"
    }
}

fn default_shell() -> String {
    if cfg!(target_os = "windows") {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
    }
}

/// Build the command for a session. For `Root` this wraps the shell in
/// pkexec/sudo so the OS runs its own authentication; sparkEditor never
/// sees or forwards a password.
fn build_command(
    shell: &str,
    cwd: &str,
    privilege: PtyPrivilege,
) -> Result<CommandBuilder, HostError> {
    let mut cmd = match privilege {
        PtyPrivilege::User => {
            let mut c = CommandBuilder::new(shell);
            if !cfg!(target_os = "windows") {
                c.arg("-i");
            }
            c
        }
        PtyPrivilege::Root => {
            if is_root() {
                let mut c = CommandBuilder::new(shell);
                if !cfg!(target_os = "windows") {
                    c.arg("-i");
                }
                c
            } else {
                match root_method() {
                    "pkexec" => {
                        let mut c = CommandBuilder::new("pkexec");
                        // Keep the caller's environment out of the elevated
                        // shell; polkit refuses most of it anyway.
                        c.arg("--user");
                        c.arg("root");
                        c.arg(shell);
                        c.arg("-i");
                        c
                    }
                    "sudo" => {
                        // `-i` gives a root login shell; sudo prompts on the
                        // PTY we just allocated, so the user types into the
                        // terminal itself.
                        let mut c = CommandBuilder::new("sudo");
                        c.arg("-i");
                        c
                    }
                    _ => {
                        return Err(HostError::PermissionDenied {
                            path: "root: neither pkexec nor sudo is available".into(),
                        })
                    }
                }
            }
        }
    };

    cmd.cwd(cwd);
    // TERM drives what programs think they can render. xterm-256color is
    // what vt100 models most faithfully.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    Ok(cmd)
}

/* ---------- Commands ---------- */

#[tauri::command]
pub fn pty_root_support() -> RootSupport {
    let already = is_root();
    let method = root_method();
    RootSupport {
        available: already || method != "none",
        method: method.to_string(),
        already_root: already,
    }
}

#[tauri::command]
pub fn pty_default_shell() -> String {
    default_shell()
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    manager: tauri::State<'_, PtyManager>,
    cwd: String,
    rows: Option<u16>,
    cols: Option<u16>,
    shell: Option<String>,
    privilege: Option<PtyPrivilege>,
) -> Result<PtySession, HostError> {
    let rows = rows.unwrap_or(24).max(1);
    let cols = cols.unwrap_or(80).max(1);
    let privilege = privilege.unwrap_or_default();
    let shell = shell.unwrap_or_else(default_shell);

    // A cwd that no longer exists makes the spawn fail with an opaque
    // errno; fall back to home so the terminal always opens.
    let cwd = {
        let p = std::path::Path::new(&cwd);
        if p.is_dir() {
            cwd.clone()
        } else {
            std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .unwrap_or_else(|_| "/".into())
        }
    };

    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| HostError::Internal {
            message: format!("openpty: {e}"),
        })?;

    let cmd = build_command(&shell, &cwd, privilege)?;
    let child = pair.slave.spawn_command(cmd).map_err(|e| {
        // Distinguish "no such shell" from a genuine internal failure so
        // the UI can say something actionable.
        let msg = e.to_string();
        if msg.contains("No such file") {
            HostError::NotFound {
                path: shell.clone(),
            }
        } else {
            HostError::Internal {
                message: format!("spawn {shell}: {msg}"),
            }
        }
    })?;
    // The slave handle must be dropped or the master never sees EOF when
    // the child exits, and the reader thread would hang forever.
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| HostError::Internal {
            message: format!("pty reader: {e}"),
        })?;
    let writer = pair.master.take_writer().map_err(|e| HostError::Internal {
        message: format!("pty writer: {e}"),
    })?;

    let id = format!(
        "pty-{}",
        manager.next_id.fetch_add(1, Ordering::SeqCst) + 1
    );

    let title_sink = TitleSink::default();
    let title_slot = title_sink.title.clone();

    let session = Arc::new(Session {
        id: id.clone(),
        shell: shell.clone(),
        cwd: cwd.clone(),
        privilege,
        parser: Arc::new(Mutex::new(vt100::Parser::new_with_callbacks(
            rows,
            cols,
            5000,
            title_sink,
        ))),
        title: title_slot,
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
        closed: Arc::new(AtomicBool::new(false)),
        dirty: Arc::new(Signal::default()),
        last_rows: Mutex::new(vec![String::new(); rows as usize]),
        seq: AtomicU64::new(0),
        size: Mutex::new((rows, cols)),
    });

    manager
        .sessions
        .lock()
        .map_err(poisoned)?
        .insert(id.clone(), session.clone());

    spawn_reader(app, session.clone(), reader);

    Ok(PtySession {
        id,
        shell,
        cwd,
        privilege,
        rows,
        cols,
    })
}

/// How long a burst of output is allowed to accumulate before it is
/// painted. Long enough to coalesce a `cat` of a large file into a few
/// frames, short enough that a keystroke echoes immediately.
const FRAME_INTERVAL: std::time::Duration = std::time::Duration::from_millis(8);

/// Backstop for the pump's condvar wait. Nothing depends on it — the
/// reader notifies — but a wait that can never time out would hang the
/// thread forever if a notify were ever missed.
const PUMP_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(250);

/// Read PTY output on a dedicated thread and feed the parser.
///
/// Painting is left to a companion thread. Rate limiting from inside the
/// read loop cannot work: the loop blocks in `read`, so the last chunk of
/// a burst — the one that arrives less than 8ms after the previous emit —
/// would sit unpainted until the program happened to write again. That is
/// a shell whose output stops halfway through and only completes when you
/// press a key.
///
/// The pump BLOCKS on a condvar rather than polling. It used to wake
/// every 8ms for the life of the session, which is 125 wakeups a second
/// per open tab whether or not anything had happened — four idle
/// terminals kept the CPU out of its sleep states all day for nothing.
fn spawn_reader(app: AppHandle, session: Arc<Session>, mut reader: Box<dyn Read + Send>) {
    let closed = session.closed.clone();
    let dirty = session.dirty.clone();

    {
        let app = app.clone();
        let session = session.clone();
        let closed = closed.clone();
        let dirty = dirty.clone();
        std::thread::spawn(move || {
            loop {
                // Sleep until the reader says the parser moved, or the
                // session ends. The timeout is only a safety net.
                let woke = {
                    let Ok(mut flag) = dirty.flag.lock() else { break };
                    while !*flag && !closed.load(Ordering::SeqCst) {
                        let Ok((next, _)) = dirty.cv.wait_timeout(flag, PUMP_IDLE_TIMEOUT) else {
                            return;
                        };
                        flag = next;
                    }
                    std::mem::replace(&mut *flag, false)
                };

                if !woke {
                    // Woken by the close, with nothing pending: the
                    // reader's final flush has already happened.
                    break;
                }

                // Let the rest of the burst land in the parser, then take
                // everything that arrived during the wait in one frame.
                std::thread::sleep(FRAME_INTERVAL);
                dirty.take();
                emit_frame(&app, &session, false);
            }
        });
    }

    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];

        loop {
            if closed.load(Ordering::SeqCst) {
                break;
            }
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF — child exited and closed the pty
                Ok(n) => {
                    if let Ok(mut parser) = session.parser.lock() {
                        parser.process(&buf[..n]);
                    }
                    dirty.raise();
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }

        // Flush whatever the last burst produced before announcing exit.
        if dirty.take() {
            emit_frame(&app, &session, false);
        }
        closed.store(true, Ordering::SeqCst);
        // Wake the pump so it sees `closed` and stops, rather than
        // sitting out its timeout.
        dirty.raise();

        let code = session
            .child
            .lock()
            .ok()
            .and_then(|mut c| c.wait().ok())
            .map(|s| s.exit_code() as i32)
            .unwrap_or(-1);

        /* Drop the session from the manager now that it is over.
           Without this a shell you exited stayed in the table for the
           life of the window, holding its master pty fd, its writer and
           a vt100 parser with 5000 lines of scrollback — a leak that
           grew every time someone typed `exit` and left the tab open,
           and that made `pty_list` report shells that no longer ran. */
        if let Some(manager) = app.try_state::<PtyManager>() {
            if let Ok(mut sessions) = manager.sessions.lock() {
                // Only if it is still the same session: an id is never
                // reused, so this can only remove what just ended.
                if sessions
                    .get(&session.id)
                    .is_some_and(|s| Arc::ptr_eq(s, &session))
                {
                    sessions.remove(&session.id);
                }
            }
        }

        let _ = app.emit(
            "pty://exit",
            PtyExit {
                id: session.id.clone(),
                code,
                message: None,
            },
        );
    });
}

#[tauri::command]
pub fn pty_write(
    manager: tauri::State<'_, PtyManager>,
    id: String,
    data: String,
) -> Result<(), HostError> {
    let session = manager.get(&id)?;
    if session.closed.load(Ordering::SeqCst) {
        return Err(HostError::Internal {
            message: "session has exited".into(),
        });
    }
    if let Ok(mut parser) = session.parser.lock() {
        if parser.screen().scrollback() != 0 {
            parser.screen_mut().set_scrollback(0);
        }
    }
    let mut w = session.writer.lock().map_err(poisoned)?;
    w.write_all(data.as_bytes())?;
    w.flush()?;
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    app: AppHandle,
    manager: tauri::State<'_, PtyManager>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), HostError> {
    let session = manager.get(&id)?;
    let rows = rows.max(1);
    let cols = cols.max(1);

    {
        let mut size = session.size.lock().map_err(poisoned)?;
        if *size == (rows, cols) {
            return Ok(());
        }
        *size = (rows, cols);
    }

    session
        .master
        .lock()
        .map_err(poisoned)?
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| HostError::Internal {
            message: format!("resize: {e}"),
        })?;

    session
        .parser
        .lock()
        .map_err(poisoned)?
        .screen_mut()
        .set_size(rows, cols);

    // The grid changed shape — the renderer needs a complete repaint.
    emit_frame(&app, &session, true);
    Ok(())
}

/// Ask for a complete repaint. Used when a terminal view mounts against
/// an already-running session (reopening the panel, popping in/out).
#[tauri::command]
pub fn pty_refresh(
    app: AppHandle,
    manager: tauri::State<'_, PtyManager>,
    id: String,
) -> Result<(), HostError> {
    let session = manager.get(&id)?;
    emit_frame(&app, &session, true);
    Ok(())
}

/// Scroll the visible window back into vt100's scrollback buffer.
/// `delta` is in rows: positive scrolls towards older output.
#[tauri::command]
pub fn pty_scroll(
    app: AppHandle,
    manager: tauri::State<'_, PtyManager>,
    id: String,
    delta: i32,
    absolute: Option<usize>,
) -> Result<usize, HostError> {
    let session = manager.get(&id)?;
    let next = {
        let mut parser = session.parser.lock().map_err(poisoned)?;
        let screen = parser.screen_mut();
        let current = screen.scrollback() as i64;
        let target = match absolute {
            Some(n) => n as i64,
            None => current + delta as i64,
        };
        let clamped = target.max(0) as usize;
        screen.set_scrollback(clamped);
        // set_scrollback clamps internally against the buffer length, so
        // read it back rather than trusting our own arithmetic.
        screen.scrollback()
    };
    // The whole viewport moved — nothing about the previous diff applies.
    if let Ok(mut last) = session.last_rows.lock() {
        for row in last.iter_mut() {
            row.clear();
        }
    }
    emit_frame(&app, &session, true);
    Ok(next)
}

#[tauri::command]
pub fn pty_kill(manager: tauri::State<'_, PtyManager>, id: String) -> Result<(), HostError> {
    let session = {
        let mut sessions = manager.sessions.lock().map_err(poisoned)?;
        sessions.remove(&id)
    };
    let Some(session) = session else {
        return Ok(()); // already gone — killing twice is not an error
    };
    session.closed.store(true, Ordering::SeqCst);
    // Wake the frame pump so it retires now instead of waiting out its
    // timeout on a session nobody is looking at any more.
    session.dirty.raise();
    if let Ok(mut child) = session.child.lock() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

#[tauri::command]
pub fn pty_list(manager: tauri::State<'_, PtyManager>) -> Result<Vec<PtySession>, HostError> {
    let sessions = manager.sessions.lock().map_err(poisoned)?;
    let mut out = Vec::with_capacity(sessions.len());
    for s in sessions.values() {
        let (rows, cols) = *s.size.lock().map_err(poisoned)?;
        out.push(PtySession {
            id: s.id.clone(),
            shell: s.shell.clone(),
            cwd: s.cwd.clone(),
            privilege: s.privilege,
            rows,
            cols,
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// Terminate every live session. Called on app exit so no orphan shells
/// survive the window closing.
pub fn shutdown_all(manager: &PtyManager) {
    let sessions = {
        match manager.sessions.lock() {
            Ok(mut s) => s.drain().map(|(_, v)| v).collect::<Vec<_>>(),
            Err(_) => return,
        }
    };
    for session in sessions {
        session.closed.store(true, Ordering::SeqCst);
        session.dirty.raise();
        if let Ok(mut child) = session.child.lock() {
            let _ = child.kill();
            // Reap it. A killed child that is never waited on stays a
            // zombie for as long as this process lives, and on a slow
            // shutdown that is long enough to notice in `ps`.
            let _ = child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ansi_palette_covers_all_indices() {
        for i in 0u16..=255 {
            let hex = ansi_hex(i as u8);
            assert_eq!(hex.len(), 7, "index {i} produced {hex}");
            assert!(hex.starts_with('#'));
        }
    }

    #[test]
    fn cube_and_greyscale_endpoints() {
        assert_eq!(ansi_hex(16), "#000000");
        assert_eq!(ansi_hex(231), "#ffffff");
        assert_eq!(ansi_hex(232), "#080808");
    }

    #[test]
    fn default_color_is_none() {
        assert!(color_hex(vt100::Color::Default).is_none());
        assert_eq!(
            color_hex(vt100::Color::Rgb(1, 2, 3)).as_deref(),
            Some("#010203")
        );
    }

    #[test]
    fn spans_merge_runs_and_drop_trailing_blanks() {
        let mut parser = vt100::Parser::new(3, 20, 0);
        parser.process(b"hello");
        let screen = parser.screen();
        let (spans, key) = row_spans(screen, 0, 20);
        assert_eq!(spans.len(), 1, "one unstyled run expected: {spans:?}");
        assert_eq!(spans[0].text, "hello");
        assert_eq!(spans[0].col, 0);
        assert!(!key.is_empty());
    }

    /// The whole scrollback path, against the same parser the host runs:
    /// enough output to overflow the screen, then a scroll back, then a
    /// read of what the renderer would paint.
    #[test]
    fn scrollback_moves_the_visible_window() {
        let mut parser = vt100::Parser::new(5, 20, 5000);
        for i in 0..40 {
            parser.process(format!("line{i}\r\n").as_bytes());
        }

        let screen = parser.screen();
        assert_eq!(screen.scrollback(), 0, "starts live");
        let (spans, _) = row_spans(screen, 0, 20);
        assert_eq!(spans[0].text, "line36", "bottom of the buffer: {spans:?}");

        // What build_frame's probe reports as the buffer length.
        let max = {
            let s = parser.screen_mut();
            let cur = s.scrollback();
            s.set_scrollback(usize::MAX);
            let m = s.scrollback();
            s.set_scrollback(cur);
            m
        };
        assert!(max >= 30, "scrollback should have filled up, got {max}");

        // What pty_scroll does with a wheel notch.
        parser.screen_mut().set_scrollback(3);
        assert_eq!(parser.screen().scrollback(), 3);
        let (spans, _) = row_spans(parser.screen(), 0, 20);
        assert_eq!(spans[0].text, "line33", "viewport moved up by 3: {spans:?}");

        // And the jump back to the bottom.
        parser.screen_mut().set_scrollback(0);
        let (spans, _) = row_spans(parser.screen(), 0, 20);
        assert_eq!(spans[0].text, "line36");
    }

    /// The alternate screen keeps no scrollback, which is why a wheel has
    /// to reach the program instead of moving a viewport. Asserting it
    /// here pins the behaviour the renderer's wheel routing depends on.
    #[test]
    fn the_alternate_screen_has_no_scrollback_to_move() {
        let mut parser = vt100::Parser::new(5, 20, 5000);
        for i in 0..40 {
            parser.process(format!("line{i}\r\n").as_bytes());
        }
        assert!(!parser.screen().alternate_screen());

        // DEC 1049: what a full-screen program sends on startup.
        parser.process(b"\x1b[?1049h");
        assert!(parser.screen().alternate_screen());
        for i in 0..40 {
            parser.process(format!("tui{i}\r\n").as_bytes());
        }

        let screen = parser.screen_mut();
        screen.set_scrollback(10);
        assert_eq!(screen.scrollback(), 0, "no history exists to scroll into");

        // Leaving it restores the shell's history untouched.
        parser.process(b"\x1b[?1049l");
        assert!(!parser.screen().alternate_screen());
        parser.screen_mut().set_scrollback(3);
        assert_eq!(parser.screen().scrollback(), 3);
    }

    #[test]
    fn mouse_reporting_reaches_the_frame() {
        let mut parser = vt100::Parser::new(5, 20, 100);
        assert_eq!(MouseMode::from(parser.screen().mouse_protocol_mode()), MouseMode::None);

        // DEC 1002 + 1006: button tracking with SGR encoding.
        parser.process(b"\x1b[?1002h\x1b[?1006h");
        assert_eq!(
            MouseMode::from(parser.screen().mouse_protocol_mode()),
            MouseMode::ButtonMotion
        );
        assert_eq!(
            MouseEncoding::from(parser.screen().mouse_protocol_encoding()),
            MouseEncoding::Sgr
        );
    }

    /// End-to-end: spawn a real shell through the same `build_command`
    /// path the app uses, run a command, and read the result back off the
    /// rendered grid. This is what proves the terminal runs actual
    /// programs rather than the simulated command table it replaced.
    #[test]
    fn spawned_shell_runs_a_real_command() {
        use portable_pty::{NativePtySystem, PtySize, PtySystem};
        use std::io::Read;

        let cwd = std::env::temp_dir().to_string_lossy().to_string();
        let shell = if std::path::Path::new("/bin/sh").exists() {
            "/bin/sh".to_string()
        } else {
            return; // no POSIX shell (Windows CI) — nothing to assert
        };

        let pty = NativePtySystem::default();
        let pair = pty
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        let cmd = build_command(&shell, &cwd, PtyPrivilege::User).expect("build_command");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().expect("reader");
        let mut writer = pair.master.take_writer().expect("writer");

        // A marker the shell prompt cannot accidentally contain.
        writeln!(writer, "echo SPARKPTYOK; exit").expect("write");
        writer.flush().expect("flush");
        // Keep `writer` alive: dropping it closes the master write side and
        // the reader sees immediate EOF before the shell has produced
        // anything.

        let mut parser = vt100::Parser::new(24, 80, 0);
        let mut buf = [0u8; 4096];
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut saw_marker = false;

        while std::time::Instant::now() < deadline {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    parser.process(&buf[..n]);
                    // Read the marker off the RENDERED grid, not the raw
                    // byte stream, so this also covers span building.
                    let screen = parser.screen();
                    let (rows, cols) = screen.size();
                    for y in 0..rows {
                        let (spans, _) = row_spans(screen, y, cols);
                        let line: String = spans.iter().map(|s| s.text.as_str()).collect();
                        // The echoed command line also contains the marker,
                        // but it continues with "; exit". The output line
                        // ends at the marker (a shell prompt may precede it
                        // on the same rendered row).
                        if line.trim_end().ends_with("SPARKPTYOK") {
                            saw_marker = true;
                        }
                    }
                    if saw_marker {
                        break;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }

        let _ = child.kill();
        let _ = child.wait();
        drop(writer);
        assert!(
            saw_marker,
            "shell output never reached the rendered grid; screen was:\n{}",
            parser.screen().contents()
        );
    }

    #[test]
    fn root_command_is_wrapped_in_a_privilege_helper() {
        // The elevated shell must go through pkexec/sudo — never through
        // sparkEditor collecting a password itself.
        if is_root() || root_method() == "none" {
            return;
        }
        let cmd = build_command("/bin/sh", "/tmp", PtyPrivilege::Root).expect("build");
        let program = cmd.get_argv()[0].to_string_lossy().to_string();
        assert!(
            program.ends_with("pkexec") || program.ends_with("sudo"),
            "root sessions must be wrapped by a privilege helper, got {program}"
        );
    }

    #[test]
    fn user_command_runs_the_shell_directly() {
        let cmd = build_command("/bin/sh", "/tmp", PtyPrivilege::User).expect("build");
        let program = cmd.get_argv()[0].to_string_lossy().to_string();
        assert!(program.ends_with("sh"), "got {program}");
    }

    #[test]
    fn blank_row_yields_no_spans() {
        let parser = vt100::Parser::new(3, 20, 0);
        let (spans, _) = row_spans(parser.screen(), 1, 20);
        assert!(spans.is_empty());
    }
}
