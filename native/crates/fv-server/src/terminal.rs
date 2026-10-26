//! The side pane's shells: a real pty per terminal (`portable-pty`), with its screen parsed on this
//! side by `alacritty_terminal`.
//!
//! **The screen is parsed here, not on the client.** A shell writes bytes, and what those bytes
//! mean — cursor moves, colours, clearing half a line, an alternate screen for `vim` — is a
//! terminal emulator. Drawing the raw stream would need the same emulator in the client, and then
//! a reconnecting client would have to replay the whole session to arrive at the screen it should
//! show. Holding the parsed screen here means a client asks for "the grid" and gets it in one
//! message, whatever happened before it connected.
//!
//! The Electron app's `main/engine/terminal-sessions.ts` is the spec, and these rules are its:
//!
//! - **The pty is a real one**, so `vim`, `less` and a shell's own line editor behave. There is no
//!   pipe fallback: a fallback that cannot resize is a terminal that wraps its output at whatever
//!   size it started at, which reads as garbled text and was reported as exactly that.
//! - **A client polls for the frame; nothing is pushed.** A shell writes whenever it likes, but only
//!   the terminal on screen is being drawn, so pushing every chunk would cross the protocol for
//!   tabs nobody is looking at. The reader thread only feeds the parser, and `read` answers with the
//!   grid as it stands — which is also what makes a reconnecting client's first read correct.
//! - **`TERM=xterm-256color`, `COLORTERM=truecolor`**, so programs emit the colours the pane can
//!   draw rather than falling back to eight.
//! - **The shell is the user's `$SHELL`**, started as a login shell in the conversation's
//!   directory, because that is the shell and the environment they get in their own terminal.
//!
//! One thing is deliberately *not* the Electron behaviour: the fallback. macOS `script` cannot
//! give a pty (`tcgetattr` on a pipe fails), so a machine without a working pty reports that it
//! cannot start a terminal rather than pretending to.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{Color, Processor};
use fv_protocol::ErrorObject;
use fv_protocol::jsonrpc::code;
use fv_protocol::types::*;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};

/// Scrollback the screen keeps, so a reader can scroll up after a long build.
const SCROLLBACK: usize = 5_000;

/// The grid size `alacritty_terminal` is told about.
struct Size {
    cols: usize,
    rows: usize,
}

impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.rows
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

type Writer = Arc<Mutex<Box<dyn Write + Send>>>;

/// Replies the emulator owes the program (cursor position, device attributes, …) go back down the
/// pty. A shell that asked and never hears back waits for it, so dropping them hangs prompts.
#[derive(Clone)]
struct Replies(Writer);

impl EventListener for Replies {
    fn send_event(&self, event: Event) {
        if let Event::PtyWrite(text) = event
            && let Ok(mut writer) = self.0.lock()
        {
            let _ = writer.write_all(text.as_bytes());
            let _ = writer.flush();
        }
    }
}

struct Screen {
    term: Term<Replies>,
    anchor: TerminalAnchor,
    history_identity: u64,
}
impl std::ops::Deref for Screen {
    type Target = Term<Replies>;
    fn deref(&self) -> &Self::Target {
        &self.term
    }
}
impl std::ops::DerefMut for Screen {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.term
    }
}
impl Screen {
    fn new(term: Term<Replies>) -> Self {
        let history_identity = term.grid().scrollback_identity();
        Self {
            term,
            anchor: TerminalAnchor::default(),
            history_identity,
        }
    }
    fn sync_anchor(&mut self) {
        let identity = self.grid().scrollback_identity();
        if identity != self.history_identity {
            self.anchor.epoch = self.anchor.epoch.wrapping_add(1);
            self.history_identity = identity;
        }
        self.anchor.serial = self.grid().scrollback_serial();
    }
    fn advance(&mut self, processor: &mut Processor, bytes: &[u8]) {
        processor.advance(&mut self.term, bytes);
        self.sync_anchor();
    }
    fn resize(&mut self, size: Size) {
        if self.grid().columns() != size.cols || self.grid().screen_lines() != size.rows {
            self.term.resize(size);
            self.anchor.epoch = self.anchor.epoch.wrapping_add(1);
            self.sync_anchor();
        }
    }
}

fn invalid(message: impl Into<String>) -> ErrorObject {
    ErrorObject::new(code::INVALID_PARAMS, message)
}

fn failed(message: impl Into<String>) -> ErrorObject {
    ErrorObject::new(code::INTERNAL_ERROR, message)
}

/// One shell: its pty, its parsed screen, and the bytes that have not been pushed yet.
struct Session {
    writer: Writer,
    master: Box<dyn MasterPty + Send>,
    /// Behind a mutex only because `try_wait` needs `&mut self`: whether the shell is gone is
    /// asked on every frame, and a shell that exited keeps its screen readable.
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    /// Set by the reader thread when the pty closes, which is the authoritative "the shell is
    /// gone" signal: a process can be reaped before its output has been read.
    exited: Arc<std::sync::atomic::AtomicBool>,
    screen: Arc<Mutex<Screen>>,
    cols: u16,
    rows: u16,
    cwd: String,
}

pub struct Terminals {
    sessions: Mutex<HashMap<String, Session>>,
}

impl Default for Terminals {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

impl Terminals {
    /// GUI disconnects do not end these shells. They must also prevent an automatic daemon
    /// replacement, even when no conversation turn is running.
    pub fn has_running(&self) -> bool {
        self.sessions
            .lock()
            .map(|sessions| {
                sessions
                    .values()
                    .any(|session| !session.exited.load(std::sync::atomic::Ordering::Acquire))
            })
            .unwrap_or(true)
    }

    /// Start a shell in `cwd`.
    ///
    /// The returned id names it for every later call. A size below two columns or one row is
    /// refused by `portable-pty`, so the defaults are used instead of passing a nonsense size
    /// through.
    pub fn start(
        &self,
        cwd: &str,
        cols: Option<u16>,
        rows: Option<u16>,
    ) -> Result<TerminalSession, ErrorObject> {
        if cols.is_some_and(|c| c > 1024) || rows.is_some_and(|r| r > 512) {
            return Err(invalid("终端尺寸过大"));
        }
        let cols = cols.filter(|c| *c > 1).unwrap_or(80);
        let rows = rows.filter(|r| *r > 0).unwrap_or(24);
        let shell = fv_env::user_shell();
        let dir = if cwd.trim().is_empty() {
            std::env::var("HOME").unwrap_or_else(|_| ".".into())
        } else {
            cwd.to_string()
        };
        if !std::path::Path::new(&dir).is_dir() {
            return Err(invalid(format!("目录不存在：{dir}")));
        }

        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| failed(format!("无法创建终端：{e}")))?;

        let mut command = CommandBuilder::new(&shell);
        for (name, value) in fv_env::snapshot() {
            command.env(name, value);
        }
        // A login shell, so the user's own profile is read: without it `PATH`, aliases and their
        // prompt are all missing, which is not the terminal they asked for.
        command.arg("-l");
        command.cwd(&dir);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        let child: Box<dyn Child + Send + Sync> = pair
            .slave
            .spawn_command(command)
            .map_err(|e| failed(format!("无法启动终端：{e}")))?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| failed(format!("无法读取终端输出：{e}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| failed(format!("无法写入终端：{e}")))?;

        let writer: Writer = Arc::new(Mutex::new(writer));
        let term = Term::new(
            Config {
                scrolling_history: SCROLLBACK,
                ..Config::default()
            },
            &Size {
                cols: cols as usize,
                rows: rows as usize,
            },
            Replies(writer.clone()),
        );
        let screen = Arc::new(Mutex::new(Screen::new(term)));
        // Set when the pty closes, which is the authoritative "the shell is gone": a process can
        // be reaped before its last output has been read.
        let exited = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let reader_screen = screen.clone();
        let reader_exited = exited.clone();

        // A thread per terminal reads the pty: it blocks, and the process it belongs to exits when
        // the shell does, so there is nothing to cancel beyond dropping the reader.
        std::thread::Builder::new()
            .name("fv-terminal".into())
            .spawn(move || {
                let mut buffer = [0u8; 8192];
                let mut processor: Processor = Processor::new();
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(n) => {
                            if let Ok(mut term) = reader_screen.lock() {
                                term.advance(&mut processor, &buffer[..n]);
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
                reader_exited.store(true, std::sync::atomic::Ordering::Relaxed);
            })
            .map_err(|e| failed(format!("无法启动终端读取线程：{e}")))?;

        let id = uuid::Uuid::new_v4().to_string();
        let session = Session {
            writer,
            master: pair.master,
            child: Arc::new(Mutex::new(child)),
            exited,
            screen,
            cols,
            rows,
            cwd: dir.clone(),
        };
        self.sessions.lock().unwrap().insert(id.clone(), session);
        Ok(TerminalSession {
            id,
            cwd: dir,
            cols,
            rows,
        })
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), ErrorObject> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(id)
            .ok_or_else(|| invalid("这个终端已经结束"))?;
        let mut writer = session.writer.lock().unwrap();
        writer
            .write_all(data.as_bytes())
            .map_err(|e| failed(format!("无法写入终端：{e}")))?;
        writer.flush().map_err(|e| failed(format!("{e}")))?;
        Ok(())
    }

    /// Resize both the screen and the pty, in that order: the screen is what the client sees next,
    /// and a pty resized first would emit a prompt for a size the grid does not have yet.
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), ErrorObject> {
        if !(2..=1024).contains(&cols) || !(1..=512).contains(&rows) {
            return Err(invalid("终端尺寸无效"));
        }
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(id)
            .ok_or_else(|| invalid("这个终端已经结束"))?;
        if let Ok(mut term) = session.screen.lock() {
            term.resize(Size {
                cols: cols as usize,
                rows: rows as usize,
            });
        }
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| failed(format!("无法调整终端尺寸：{e}")))?;
        session.cols = cols;
        session.rows = rows;
        Ok(())
    }

    /// The screen as the client should draw it: every row, the cursor, and whether the shell is
    /// still running.
    #[cfg(test)]
    pub fn read(&self, id: &str) -> Result<TerminalFrame, ErrorObject> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(id)
            .ok_or_else(|| invalid("这个终端已经结束"))?;
        read_frame(
            session,
            &TerminalReadParams {
                id: id.into(),
                offset: 0,
                anchor: None,
            },
        )
    }

    pub fn read_view(&self, params: &TerminalReadParams) -> Result<TerminalFrame, ErrorObject> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(&params.id)
            .ok_or_else(|| invalid("这个终端已经结束"))?;
        read_frame(session, params)
    }

    pub fn copy(&self, params: &TerminalCopyParams) -> Result<String, ErrorObject> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(&params.id)
            .ok_or_else(|| invalid("这个终端已经结束"))?;
        let screen = session.screen.lock().map_err(|_| failed("无法读取终端"))?;
        selected_text(&screen, params)
    }

    pub fn kill(&self, id: &str) {
        let mut sessions = self.sessions.lock().unwrap();
        let Some(session) = sessions.remove(id) else {
            return;
        };
        if let Ok(mut child) = session.child.lock() {
            let _ = child.kill();
        }
    }

    #[cfg(test)]
    pub fn has(&self, id: &str) -> bool {
        self.sessions.lock().unwrap().contains_key(id)
    }
}

/// A pty outlives the state that owns it, so dropping `Terminals` has to kill every child: a
/// shell left behind keeps its tty and any port it started open, with nothing left to stop it.
impl Drop for Terminals {
    fn drop(&mut self) {
        let sessions = match self.sessions.lock() {
            Ok(sessions) => sessions,
            // A poisoned lock is the one case where nothing can be done safely.
            Err(_) => return,
        };
        for session in sessions.values() {
            if let Ok(mut child) = session.child.lock() {
                let _ = child.kill();
            }
        }
    }
}

fn color_of(color: Color) -> Option<TerminalColor> {
    match color {
        Color::Spec(rgb) => Some(TerminalColor::Rgb(rgb.r, rgb.g, rgb.b)),
        Color::Indexed(i) => Some(TerminalColor::Indexed(i)),
        Color::Named(named) => match named as usize {
            n @ 0..=15 => Some(TerminalColor::Indexed(n as u8)),
            // The dim variants follow the foreground, black … white.
            n @ 259..=266 => Some(TerminalColor::Indexed((n - 259) as u8)),
            // Foreground, background, cursor and their bright/dim forms are the theme's.
            _ => None,
        },
    }
}

fn style_of(cell: &Cell) -> TerminalSpan {
    let flags = cell.flags;
    TerminalSpan {
        text: String::new(),
        fg: color_of(cell.fg),
        bg: color_of(cell.bg),
        bold: flags.contains(Flags::BOLD),
        dim: flags.contains(Flags::DIM),
        italic: flags.contains(Flags::ITALIC),
        underline: flags.intersects(Flags::ALL_UNDERLINES),
        inverse: flags.contains(Flags::INVERSE),
        hidden: flags.contains(Flags::HIDDEN),
        strikethrough: flags.contains(Flags::STRIKEOUT),
    }
}

fn same_style(a: &TerminalSpan, b: &TerminalSpan) -> bool {
    (
        a.fg,
        a.bg,
        a.bold,
        a.dim,
        a.italic,
        a.underline,
        a.inverse,
        a.hidden,
        a.strikethrough,
    ) == (
        b.fg,
        b.bg,
        b.bold,
        b.dim,
        b.italic,
        b.underline,
        b.inverse,
        b.hidden,
        b.strikethrough,
    )
}

fn read_row(screen: &Screen, row: i32) -> TerminalRow {
    let grid = screen.grid();
    let cols = grid.columns();
    let mut line = TerminalRow {
        wrapped: grid[Line(row)][Column(cols - 1)]
            .flags
            .contains(Flags::WRAPLINE),
        ..Default::default()
    };
    for col in 0..cols {
        let cell = &grid[Line(row)][Column(col)];
        if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
            continue;
        }
        let mut piece = String::new();
        piece.push(
            if cell.c == '\0' || cell.flags.contains(Flags::LEADING_WIDE_CHAR_SPACER) {
                ' '
            } else {
                cell.c
            },
        );
        line.widths.push(if cell.flags.contains(Flags::WIDE_CHAR) {
            2
        } else {
            1
        });
        for extra in cell.zerowidth().into_iter().flatten() {
            piece.push(*extra);
            line.widths.push(0);
        }
        line.text.push_str(&piece);
        let style = style_of(cell);
        match line.spans.last_mut() {
            Some(last) if same_style(last, &style) => last.text.push_str(&piece),
            _ => line.spans.push(TerminalSpan {
                text: piece,
                ..style
            }),
        }
    }
    line
}

fn read_frame(
    session: &Session,
    params: &TerminalReadParams,
) -> Result<TerminalFrame, ErrorObject> {
    let screen = session.screen.lock().map_err(|_| failed("无法读取终端"))?;
    let grid = screen.grid();
    let history = grid.history_size();
    let mut offset = params.offset as usize;
    if offset > 0
        && let Some(anchor) = params.anchor
    {
        if anchor.epoch != screen.anchor.epoch || anchor.serial > screen.anchor.serial {
            offset = 0;
        } else {
            offset = offset.saturating_add((screen.anchor.serial - anchor.serial) as usize);
        }
    }
    offset = offset.min(history);
    let rows = grid.screen_lines() as u16;
    let cols = grid.columns() as u16;
    let lines = (0..rows as i32)
        .map(|row| read_row(&screen, row - offset as i32))
        .collect();
    let cursor = grid.cursor.point;
    let mode = screen.mode();
    Ok(TerminalFrame {
        id: params.id.clone(),
        cwd: session.cwd.clone(),
        cols,
        rows,
        lines,
        cursor_row: cursor.line.0.max(0) as u16,
        cursor_col: cursor.column.0 as u16,
        cursor_hidden: offset > 0 || !mode.contains(TermMode::SHOW_CURSOR),
        exited: session.exited.load(std::sync::atomic::Ordering::Relaxed),
        history: history as u32,
        offset: offset as u32,
        anchor: screen.anchor,
        bracketed_paste: mode.contains(TermMode::BRACKETED_PASTE),
        application_cursor: mode.contains(TermMode::APP_CURSOR),
        alternate_screen: mode.contains(TermMode::ALT_SCREEN),
    })
}

fn selected_text(screen: &Screen, params: &TerminalCopyParams) -> Result<String, ErrorObject> {
    if params.epoch != screen.anchor.epoch {
        return Err(invalid("终端尺寸或屏幕已变化，请重新选择"));
    }
    let (start, end) = if params.start <= params.end {
        (params.start, params.end)
    } else {
        (params.end, params.start)
    };
    let grid = screen.grid();
    let serial = i64::try_from(screen.anchor.serial).map_err(|_| invalid("终端历史已过期"))?;
    let first = serial - grid.history_size() as i64;
    let last = serial + grid.screen_lines() as i64 - 1;
    if start.line < first
        || end.line > last
        || start.column as usize > grid.columns()
        || end.column as usize > grid.columns()
    {
        return Err(invalid("所选终端历史已被新的输出替换，请重新选择"));
    }
    if start == end {
        return Ok(String::new());
    }
    let mut text = String::new();
    for line in start.line..=end.line {
        let row = &grid[Line((line - serial) as i32)];
        let wrapped = row[Column(grid.columns() - 1)]
            .flags
            .contains(Flags::WRAPLINE);
        let from = if line == start.line {
            start.column as usize
        } else {
            0
        };
        let to = if line == end.line {
            end.column as usize
        } else {
            grid.columns()
        };
        // Let the emulator apply its actual tab stops, wide glyph and combining-character
        // rules. Copying raw cells would duplicate the blank padding following a stored TAB.
        // A leading wide spacer is only wrapping padding, not part of the selected text.
        let to = if to == grid.columns()
            && row[Column(to - 1)]
                .flags
                .contains(Flags::LEADING_WIDE_CHAR_SPACER)
        {
            to - 1
        } else {
            to
        };
        if from < to {
            let line = Line((line - serial) as i32);
            text.push_str(&screen.bounds_to_string(
                alacritty_terminal::index::Point::new(line, Column(from)),
                alacritty_terminal::index::Point::new(line, Column(to - 1)),
            ));
        }
        if line < end.line && !wrapped {
            text.push('\n');
        }
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen(cols: usize, rows: usize) -> Screen {
        let writer: Writer = Arc::new(Mutex::new(Box::new(Vec::<u8>::new())));
        Screen::new(Term::new(
            Config {
                scrolling_history: SCROLLBACK,
                ..Default::default()
            },
            &Size { cols, rows },
            Replies(writer),
        ))
    }

    fn selection(screen: &Screen, start: (i64, u16), end: (i64, u16)) -> TerminalCopyParams {
        TerminalCopyParams {
            id: String::new(),
            epoch: screen.anchor.epoch,
            start: TerminalPoint {
                line: start.0,
                column: start.1,
            },
            end: TerminalPoint {
                line: end.0,
                column: end.1,
            },
        }
    }

    #[test]
    fn history_coordinates_keep_advancing_after_the_ring_is_full() {
        let mut screen = screen(16, 3);
        let mut parser = Processor::new();
        let text: String = (0..8000).map(|i| format!("line{i}\r\n")).collect();
        screen.advance(&mut parser, text.as_bytes());
        assert_eq!(screen.grid().history_size(), 5000);
        assert_eq!(
            screen.anchor,
            TerminalAnchor {
                epoch: 0,
                serial: 7998
            }
        );
        assert!(read_row(&screen, -1).text.starts_with("line7997"));
        assert!(read_row(&screen, 0).text.starts_with("line7998"));
        assert!(selected_text(&screen, &selection(&screen, (0, 0), (0, 4))).is_err());
        assert_eq!(
            screen.grid().display_offset(),
            0,
            "client viewports never mutate the shared grid"
        );
    }

    #[test]
    fn a_selection_stays_on_the_same_history_line_as_more_output_arrives() {
        let mut screen = screen(16, 3);
        let mut parser = Processor::new();
        screen.advance(&mut parser, b"one\r\ntwo\r\nthree\r\nfour\r\n");
        let selected = selection(&screen, (1, 0), (1, 16));
        assert_eq!(selected_text(&screen, &selected).unwrap(), "two");
        screen.advance(&mut parser, b"five\r\nsix\r\n");
        assert_eq!(selected_text(&screen, &selected).unwrap(), "two");
    }

    #[test]
    fn a_partial_scroll_region_never_advances_history_coordinates() {
        let mut screen = screen(16, 4);
        let mut parser = Processor::new();
        screen.advance(&mut parser, b"one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n");
        let before = screen.anchor;
        let selected = selection(&screen, (0, 0), (0, 16));
        screen.advance(&mut parser, b"\x1b[2;4r\x1b[4;1H\x1b[2S\n\n\n");
        assert_eq!(screen.anchor, before);
        assert_eq!(selected_text(&screen, &selected).unwrap(), "one");
        assert_eq!(
            selected_text(
                &screen,
                &selection(
                    &screen,
                    (before.serial as i64, 1),
                    (before.serial as i64, 1)
                )
            )
            .unwrap(),
            ""
        );
    }

    #[test]
    fn copying_wraps_keeps_explicit_newlines_and_joins_soft_wraps() {
        let mut screen = screen(6, 4);
        screen.advance(&mut Processor::new(), b"abcdefghi\r\nj");
        assert!(read_row(&screen, 0).wrapped);
        assert_eq!(
            selected_text(&screen, &selection(&screen, (0, 0), (2, 1))).unwrap(),
            "abcdefghi\nj"
        );
        assert_eq!(
            selected_text(&screen, &selection(&screen, (2, 1), (0, 0))).unwrap(),
            "abcdefghi\nj"
        );
        let mut spaces = self::screen(4, 3);
        spaces.advance(&mut Processor::new(), b"ab  cd");
        assert_eq!(
            selected_text(&spaces, &selection(&spaces, (0, 0), (1, 2))).unwrap(),
            "ab  cd"
        );
        let mut wide = self::screen(4, 3);
        wide.advance(&mut Processor::new(), "abc中".as_bytes());
        assert_eq!(
            selected_text(&wide, &selection(&wide, (0, 0), (1, 2))).unwrap(),
            "abc中"
        );
    }

    #[test]
    fn copying_tabs_uses_the_emulators_tab_stops_without_duplicating_padding() {
        let mut screen = screen(24, 3);
        screen.advance(&mut Processor::new(), b"a\tb\tc");
        assert_eq!(
            selected_text(&screen, &selection(&screen, (0, 0), (0, 17))).unwrap(),
            "a\tb\tc"
        );
        // A selection beginning within a tab's padding copies only the selected cells.
        assert_eq!(
            selected_text(&screen, &selection(&screen, (0, 5), (0, 9))).unwrap(),
            "   b"
        );
        // Clear default tab stops, install one at column 5, then return to the start.
        let mut custom = self::screen(16, 3);
        custom.advance(&mut Processor::new(), b"\x1b[3g\x1b[6G\x1bH\ra\tb");
        assert_eq!(
            selected_text(&custom, &selection(&custom, (0, 0), (0, 6))).unwrap(),
            "a\tb"
        );
    }

    #[test]
    fn wide_and_combining_glyphs_keep_exact_columns_and_copy_whole_cells() {
        let mut screen = screen(8, 3);
        screen.advance(&mut Processor::new(), "中e\u{301}🦀".as_bytes());
        let row = read_row(&screen, 0);
        assert_eq!(row.widths.len(), row.text.chars().count());
        assert_eq!(row.widths.iter().map(|n| *n as usize).sum::<usize>(), 8);
        assert_eq!(&row.widths[..4], &[2, 1, 0, 2]);
        assert_eq!(
            selected_text(&screen, &selection(&screen, (0, 1), (0, 5))).unwrap(),
            "中e\u{301}🦀"
        );
        let mut wrapped = self::screen(4, 3);
        wrapped.advance(&mut Processor::new(), "abc中".as_bytes());
        assert_eq!(read_row(&wrapped, 0).widths.iter().sum::<u8>(), 4);
        assert!(read_row(&wrapped, 0).wrapped);
    }

    #[test]
    fn resize_alternate_screen_and_history_reset_invalidate_selections() {
        let mut screen = screen(8, 3);
        let mut parser = Processor::new();
        screen.advance(&mut parser, b"a\r\nb\r\nc\r\nd\r\n");
        let selected = selection(&screen, (0, 0), (0, 1));
        screen.advance(&mut parser, b"\x1b[3J");
        assert!(selected_text(&screen, &selected).is_err());
        let old = screen.anchor;
        screen.advance(&mut parser, b"\x1b[?1049h");
        assert_ne!(old.epoch, screen.anchor.epoch);
        let old = screen.anchor;
        screen.resize(Size { cols: 10, rows: 3 });
        assert_ne!(old.epoch, screen.anchor.epoch);
    }

    #[test]
    fn rgb_background_hidden_strike_and_input_modes_reach_the_frame_source() {
        let mut screen = screen(8, 3);
        screen.advance(
            &mut Processor::new(),
            b"\x1b[38;2;1;2;3;48;5;25;8;9mX\x1b[?2004h\x1b[?1h",
        );
        let row = read_row(&screen, 0);
        let style = &row.spans[0];
        assert_eq!(style.fg, Some(TerminalColor::Rgb(1, 2, 3)));
        assert_eq!(style.bg, Some(TerminalColor::Indexed(25)));
        assert!(style.hidden && style.strikethrough);
        assert!(
            screen
                .mode()
                .contains(TermMode::BRACKETED_PASTE | TermMode::APP_CURSOR)
        );
    }

    fn terminals() -> Terminals {
        Terminals::default()
    }

    /// A real pty, a real shell: the only test that proves `vim` and a line editor would work is
    /// one that runs a shell.
    #[test]
    fn a_shell_runs_in_a_pty_and_its_output_reaches_the_screen() {
        let terminals = terminals();
        let dir = tempfile::tempdir().unwrap();
        let started = terminals
            .start(&dir.path().display().to_string(), Some(80), Some(24))
            .expect("a pty");
        // A command whose output cannot be faked by a pipe: `tty` answers a device name only when
        // there is a terminal on stdin.
        // The shell has to finish starting before it reads anything: a login shell sources the
        // user's profile first. Waiting for a prompt is what a person does too.
        std::thread::sleep(std::time::Duration::from_millis(1200));
        terminals
            .write(&started.id, "printf 'MARK-%s\\n' \"$(tty | cut -c1-9)\"\n")
            .unwrap();
        let mut seen = String::new();
        for _ in 0..40 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            let frame = terminals.read(&started.id).unwrap();
            seen = frame
                .lines
                .iter()
                .map(|row| row.text.trim_end().to_string())
                .collect::<Vec<_>>()
                .join("\n");
            if seen.contains("MARK-/dev/") {
                break;
            }
        }
        assert!(
            seen.contains("MARK-/dev/"),
            "a pty answers /dev/… for tty, a pipe would say 'not a tty':\n{seen}"
        );
        assert_eq!(
            (started.cols, started.rows),
            (80, 24),
            "the size asked for is the size given"
        );
        drop(terminals);
    }

    #[test]
    fn colours_reach_the_client_as_styled_spans() {
        let terminals = terminals();
        let dir = tempfile::tempdir().unwrap();
        let started = terminals
            .start(&dir.path().display().to_string(), Some(80), Some(24))
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1200));
        terminals
            .write(&started.id, "printf '\\033[1;31mRED\\033[0m plain\\n'\n")
            .unwrap();
        let mut found = false;
        for _ in 0..40 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            let frame = terminals.read(&started.id).unwrap();
            found = frame.lines.iter().flat_map(|l| &l.spans).any(|span| {
                span.text.starts_with("RED")
                    && span.fg == Some(TerminalColor::Indexed(1))
                    && span.bold
            });
            if found {
                break;
            }
        }
        assert!(found, "SGR 1;31 is a bold ANSI red span");
    }

    #[test]
    fn resizing_changes_the_grid_the_client_reads() {
        let terminals = terminals();
        let dir = tempfile::tempdir().unwrap();
        let started = terminals
            .start(&dir.path().display().to_string(), Some(80), Some(24))
            .unwrap();
        terminals.resize(&started.id, 100, 30).unwrap();
        let frame = terminals.read(&started.id).unwrap();
        assert_eq!((frame.cols, frame.rows), (100, 30));
        // A size a terminal cannot have is refused rather than passed on.
        assert!(terminals.resize(&started.id, 1, 30).is_err());
        drop(terminals);
    }

    #[test]
    fn a_terminal_that_was_never_started_is_an_error_not_a_panic() {
        let terminals = terminals();
        assert!(terminals.read("nope").is_err());
        assert!(terminals.write("nope", "ls\n").is_err());
    }

    #[test]
    fn a_directory_that_does_not_exist_is_refused() {
        let terminals = terminals();
        assert!(
            terminals.start("/definitely/not/here", None, None).is_err(),
            "a shell has to start somewhere real"
        );
    }

    #[test]
    fn killing_a_terminal_makes_later_calls_fail_instead_of_writing_to_a_dead_shell() {
        let terminals = terminals();
        let dir = tempfile::tempdir().unwrap();
        let started = terminals
            .start(&dir.path().display().to_string(), None, None)
            .unwrap();
        terminals.kill(&started.id);
        assert!(!terminals.has(&started.id));
        assert!(terminals.write(&started.id, "ls\n").is_err());
    }
}
