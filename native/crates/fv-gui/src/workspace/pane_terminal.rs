//! The terminal tab: a grid of characters, a cursor, and the keys that go to the shell.
//!
//! **The screen is drawn from a parsed frame, not from a byte stream.** The server owns a real pty
//! and a terminal emulator (`fv-server/src/terminal.rs`), so what arrives here is "this grid, this
//! cursor" — which is why a client that connected late, or reconnected, shows the right screen
//! with no replay, and why `vim` and `less` work at all.
//!
//! What the pane still has to get right is the part only it can do:
//!
//! - **Keystrokes are the terminal's, not the text editor's.** `on_key_down` sends the bytes an
//!   xterm would (`\r` for Return, `\x7f` for Backspace, `\x1b[A` for Up), with Ctrl mapping to
//!   `0x01…0x1a`. A text field would eat Tab, the arrows and Ctrl-C before the shell saw them.
//! - **Size follows the pane.** A shell wraps its output at the width it was told, so resizing the
//!   pane without telling the pty is how a terminal comes to look garbled.
//! - **A frame is polled, not pushed.** A shell writes whenever it likes, but only the terminal on
//!   screen has a reader; polling at the frame interval is what keeps one hidden tab from pushing
//!   thousands of events nobody draws. Every read returns the parsed screen as it stands.
//! - **A shell that exited keeps its screen.** The last lines are usually the reason somebody
//!   opened the tab, so the pane says 「已结束」 over the grid rather than clearing it.

use fv_protocol::methods::*;
use fv_protocol::types::*;
use fv_theme::Token;
use gpui_kit::*;

use super::pane::{PaneTab, PaneTabKind};
use super::{Workspace, text};
use crate::terminal_state::{self, Selection};
use crate::theme::Palette;
use crate::ui::{Muted as _, TEXT_XS};
#[path = "pane_terminal_interaction.rs"]
mod interaction;
#[path = "pane_terminal_input.rs"]
mod native_input;
use native_input::{InputEvent as TerminalInputEvent, TerminalInput};

/// How often the terminal on screen asks the server for its frame.
const POLL: std::time::Duration = std::time::Duration::from_millis(60);
/// A monospace cell at `text-xs`: the pane computes its grid from these.
const CELL_WIDTH: f32 = 7.4;
const LINE_HEIGHT: f32 = 17.0;
const FONT_SIZE: f32 = 12.0;

/// These two global workspace actions would otherwise consume the key before low-level
/// terminal handling runs. NoAction suppresses those bindings in the terminal context only.
pub(super) fn passthrough_bindings() -> [KeyBinding; 2] {
    [
        KeyBinding::new("escape", NoAction {}, Some("Terminal")),
        KeyBinding::new("ctrl-s", NoAction {}, Some("Terminal")),
    ]
}

/// One terminal the pane is showing.
#[derive(Default)]
pub struct TerminalView {
    pub session: Option<TerminalSession>,
    /// The frame on screen, and the one before it (for the 「已结束」 transition).
    pub frame: Option<TerminalFrame>,
    /// The last failure, said in the pane rather than swallowed.
    pub notice: Option<String>,
    /// The size the server was last told, so a resize is sent once rather than per frame.
    pub reported: Option<(u16, u16)>,
    pub(super) last_size_sent: Option<(u16, u16)>,
    pub(super) resizing: bool,
    /// Take keyboard focus on the next draw: a new terminal should be typeable at once.
    pub focus: bool,
    /// At most one read/timer is in flight per tab, even when a render also resumes polling.
    pub polling: bool,
    pub(super) input: Option<Entity<TerminalInput>>,
    pub(super) cell_width: f32,
    pub(super) bounds: Option<Bounds<Pixels>>,
    pub(super) offset: u32,
    pub(super) anchor: Option<TerminalAnchor>,
    pub(super) read_revision: u64,
    pub(super) rendered_revision: u64,
    pub(super) selection: Option<Selection>,
    pub(super) selecting: bool,
    pub(super) autoscroll: i8,
    pub(super) autoscroll_running: bool,
    pub(super) drag_column: u16,
    pub(super) wheel_pixels: f32,
    pub(super) input_queue: std::collections::VecDeque<Vec<u8>>,
    pub(super) writing: bool,
}

fn bytes_for(keystroke: &Keystroke, application: bool) -> Option<Vec<u8>> {
    let modifiers = &keystroke.modifiers;
    let key = keystroke.key.as_str();
    let (ctrl, alt) = (modifiers.control, modifiers.alt);
    // Command shortcuts belong to the app (paste is handled before this), never to the shell.
    if modifiers.platform {
        return None;
    }
    let named: Option<&[u8]> = match key {
        "enter" | "return" => Some(b"\r"),
        "backspace" => Some(b"\x7f"),
        "tab" if modifiers.shift => Some(b"\x1b[Z"),
        "tab" => Some(b"\t"),
        "escape" => Some(b"\x1b"),
        "up" => Some(b"\x1b[A"),
        "down" => Some(b"\x1b[B"),
        "right" => Some(b"\x1b[C"),
        "left" => Some(b"\x1b[D"),
        "home" => Some(b"\x1b[H"),
        "end" => Some(b"\x1b[F"),
        "pageup" => Some(b"\x1b[5~"),
        "pagedown" => Some(b"\x1b[6~"),
        "delete" => Some(b"\x1b[3~"),

        _ => None,
    };
    if let Some(bytes) = named {
        if let Some(final_char) = match key {
            "up" => Some('A'),
            "down" => Some('B'),
            "right" => Some('C'),
            "left" => Some('D'),
            "home" => Some('H'),
            "end" => Some('F'),
            _ => None,
        } {
            let modifier = 1 + u8::from(modifiers.shift) + 2 * u8::from(alt) + 4 * u8::from(ctrl);
            return Some(if modifier > 1 {
                format!("\x1b[1;{modifier}{final_char}").into_bytes()
            } else if application {
                format!("\x1bO{final_char}").into_bytes()
            } else {
                bytes.to_vec()
            });
        }
        // Alt prefixes with Escape, which is how every terminal sends Meta.
        let mut out = Vec::new();
        if alt && !bytes.starts_with(b"\x1b") {
            out.push(0x1b);
        }
        out.extend_from_slice(bytes);
        return Some(out);
    }
    if ctrl {
        // Ctrl-A is 0x01 … Ctrl-Z is 0x1a, the same arithmetic xterm uses.
        let byte = match key {
            "space" | "@" => 0,
            "[" => 0x1b,
            "\\" => 0x1c,
            "]" => 0x1d,
            "/" | "_" => 0x1f,
            k if k.len() == 1 && k.as_bytes()[0].is_ascii_alphabetic() => {
                k.as_bytes()[0].to_ascii_lowercase() - b'a' + 1
            }
            _ => return None,
        };
        return Some(if alt { vec![0x1b, byte] } else { vec![byte] });
    }
    // Ordinary text goes through EntityInputHandler, including dead keys and IME commits.
    if !alt {
        return None;
    }
    let typed = keystroke
        .key_char
        .as_deref()
        .filter(|c| !c.is_empty())
        .or_else(|| (key.chars().count() == 1).then_some(key))?;
    let mut out = vec![0x1b];
    out.extend_from_slice(if key.chars().count() == 1 { key } else { typed }.as_bytes());
    Some(out)
}

/// The xterm palette: the 16 ANSI colours (tuned to read on the theme's background), the 6×6×6
/// cube and the grey ramp.
fn ansi_color(index: u8, dark: bool) -> Hsla {
    const DARK: [u32; 16] = [
        0x45475a, 0xf38ba8, 0xa6e3a1, 0xf9e2af, 0x89b4fa, 0xf5c2e7, 0x94e2d5, 0xbac2de, 0x6c7086,
        0xf38ba8, 0xa6e3a1, 0xf9e2af, 0x89b4fa, 0xf5c2e7, 0x94e2d5, 0xcdd6f4,
    ];
    const LIGHT: [u32; 16] = [
        0x24292f, 0xcf222e, 0x1a7f37, 0x9a6700, 0x0969da, 0x8250df, 0x1b7c83, 0x6e7781, 0x57606a,
        0xa40e26, 0x2da44e, 0xbf8700, 0x218bff, 0xa475f9, 0x3192aa, 0x8c959f,
    ];
    let i = index as u32;
    let hex = if i < 16 {
        (if dark { DARK } else { LIGHT })[i as usize]
    } else if i < 232 {
        let n = i - 16;
        let level = |v: u32| if v == 0 { 0 } else { 55 + v * 40 };
        (level(n / 36) << 16) | (level(n / 6 % 6) << 8) | level(n % 6)
    } else {
        let v = 8 + (i - 232) * 10;
        (v << 16) | (v << 8) | v
    };
    rgb(hex).into()
}

fn resolve(color: Option<TerminalColor>, default: Hsla, dark: bool) -> Hsla {
    match color {
        None => default,
        Some(TerminalColor::Indexed(i)) => ansi_color(i, dark),
        Some(TerminalColor::Rgb(r, g, b)) => {
            rgb((u32::from(r) << 16) | (u32::from(g) << 8) | u32::from(b)).into()
        }
    }
}

/// Shape each emulator glyph at its cell position. Fallback CJK/emoji font advances must
/// never move the next cell or the mouse/IME cursor away from the PTY's coordinates.
fn paint_grid(
    frame: &TerminalFrame,
    bounds: Bounds<Pixels>,
    cell_width: f32,
    selection: Option<&Selection>,
    focused: bool,
    p: &Palette,
    window: &mut Window,
) -> Vec<(ShapedLine, Point<Pixels>, Option<PaintQuad>)> {
    let default = TerminalSpan::default();
    let mut painted = Vec::new();
    for (row_index, row) in frame.lines.iter().enumerate() {
        let line = terminal_state::point(frame, row_index, 0).line;
        let selected = selection
            .map(|s| s.columns(line, frame.cols))
            .unwrap_or(0..0);
        let (mut byte, mut span_index, mut span_end) =
            (0, 0, row.spans.first().map_or(0, |s| s.text.len()));
        for (text, column, width) in terminal_state::glyphs(row) {
            while byte >= span_end && span_index + 1 < row.spans.len() {
                span_index += 1;
                span_end += row.spans[span_index].text.len();
            }
            let span = row.spans.get(span_index).unwrap_or(&default);
            byte += text.len();
            let (base_fg, base_bg) = (p.c(Token::Foreground), p.c(Token::Background));
            let mut fg = resolve(span.fg, base_fg, p.is_dark());
            let mut bg = resolve(span.bg, base_bg, p.is_dark());
            if span.inverse {
                std::mem::swap(&mut fg, &mut bg);
            }
            if span.dim {
                fg = fg.opacity(0.6);
            }
            let cursor = !frame.cursor_hidden
                && focused
                && row_index == frame.cursor_row as usize
                && column <= frame.cursor_col
                && frame.cursor_col < column + width;
            let is_selected = column < selected.end && column + width > selected.start;
            let has_background = span.bg.is_some() || span.inverse || cursor || is_selected;
            if cursor {
                std::mem::swap(&mut fg, &mut bg);
            }
            if is_selected {
                bg = p.c(Token::Accent);
                fg = p.c(Token::AccentForeground);
            }
            let origin = point(
                bounds.left() + px(8.0 + column as f32 * cell_width),
                bounds.top() + px(8.0 + row_index as f32 * LINE_HEIGHT),
            );
            let background = has_background.then(|| {
                fill(
                    Bounds::new(origin, size(px(width as f32 * cell_width), px(LINE_HEIGHT))),
                    bg,
                )
            });
            let font = Font {
                family: crate::assets::MONO_FONT.into(),
                weight: if span.bold {
                    FontWeight::BOLD
                } else {
                    FontWeight::NORMAL
                },
                style: if span.italic {
                    FontStyle::Italic
                } else {
                    FontStyle::Normal
                },
                ..Default::default()
            };
            let display = if span.hidden { " ".to_string() } else { text };
            let run = TextRun {
                len: display.len(),
                font,
                color: fg,
                underline: span.underline.then_some(UnderlineStyle {
                    thickness: px(1.0),
                    color: Some(fg),
                    wavy: false,
                }),
                strikethrough: span.strikethrough.then_some(StrikethroughStyle {
                    thickness: px(1.0),
                    color: Some(fg),
                }),
                ..Default::default()
            };
            let shaped =
                window
                    .text_system()
                    .shape_line(display.into(), px(FONT_SIZE), &[run], None);
            painted.push((shaped, origin, background));
        }
    }
    painted
}

impl Workspace {
    /// Dev only: a terminal already running, for the capture fixture.
    ///
    /// The fixture has no server, so the pty is started here by the same code the server's handler
    /// runs — a fixture that faked a frame would be a picture of a terminal nobody can have.
    pub fn open_terminal_for_fixture(&mut self, cx: &mut Context<Self>) {
        let Some(conversation) = self.selected.clone() else {
            return;
        };
        let Some(cwd) = self.project_root_for(&conversation) else {
            return;
        };
        self.side_pane_collapsed = false;
        let tab_id = super::pane::new_tab_id();
        {
            let state = self.panes.entry(conversation).or_default();
            state.tabs.push(PaneTab {
                id: tab_id.clone(),
                kind: PaneTabKind::Terminal,
                title: text::pane_terminal(self.app_settings.language).to_string(),
            });
            state.active = Some(tab_id.clone());
        }
        let (cols, rows) = (96u16, 30u16);
        let started = crate::workspace::terminal_fixture(&cwd, cols, rows);
        match started {
            Ok((session, frame)) => {
                self.terminals.insert(
                    tab_id,
                    TerminalView {
                        session: Some(session),
                        frame: Some(frame),
                        reported: Some((cols, rows)),
                        focus: false,
                        polling: false,
                        notice: None,
                        ..Default::default()
                    },
                );
            }
            Err(e) => {
                self.terminals.insert(
                    tab_id,
                    TerminalView {
                        notice: Some(e),
                        ..Default::default()
                    },
                );
            }
        }
        cx.notify();
    }

    /// Open a terminal tab in the conversation's directory.
    pub(super) fn open_terminal_tab(&mut self, cx: &mut Context<Self>) {
        let Some(conversation) = self.selected.clone() else {
            return;
        };
        if self.project_root_for(&conversation).is_none() || self.backend.is_none() {
            return;
        }
        self.side_pane_collapsed = false;
        let id = super::pane::new_tab_id();
        {
            let state = self.panes.entry(conversation.clone()).or_default();
            state.tabs.push(PaneTab {
                id: id.clone(),
                kind: PaneTabKind::Terminal,
                title: text::pane_terminal(self.app_settings.language).to_string(),
            });
            state.activate(id.clone());
        }
        self.start_terminal_tab(id, cx);
        cx.notify();
    }

    fn start_terminal_tab(&mut self, id: String, cx: &mut Context<Self>) {
        let Some(conversation) = self.panes.iter().find_map(|(conversation, pane)| {
            pane.tabs
                .iter()
                .any(|tab| tab.id == id)
                .then(|| conversation.clone())
        }) else {
            return;
        };
        let old = self
            .terminals
            .get(&id)
            .and_then(|view| view.session.clone());
        let Some(cwd) = old
            .as_ref()
            .map(|session| session.cwd.clone())
            .or_else(|| self.project_root_for(&conversation))
        else {
            return;
        };
        let Some(b) = self.backend.clone() else {
            return;
        };
        self.terminals.insert(id.clone(), TerminalView::default());
        // A grid of 80×24 is the terminal's own default; the pane reports its real size as soon as
        // it is laid out, which is one frame later.
        let (cols, rows) = (80u16, 24u16);
        cx.spawn(async move |this, cx| {
            if let Some(old) = old {
                let _ = b
                    .call::<TerminalKill>(TerminalIdParams { id: old.id })
                    .await;
            }
            let opened = b
                .call::<TerminalStart>(TerminalStartParams {
                    cwd,
                    cols: Some(cols),
                    rows: Some(rows),
                })
                .await;
            let still_open = this
                .update(cx, |this, _| {
                    this.panes
                        .get(&conversation)
                        .is_some_and(|state| state.tabs.iter().any(|tab| tab.id == id))
                })
                .unwrap_or(false);
            if !still_open {
                if let Ok(session) = opened {
                    let _ = b
                        .call::<TerminalKill>(TerminalIdParams { id: session.id })
                        .await;
                }
                return;
            }
            this.update(cx, |this, cx| {
                match opened {
                    Ok(session) => {
                        this.terminals.insert(
                            id.clone(),
                            TerminalView {
                                session: Some(session),
                                reported: Some((cols, rows)),
                                focus: true,
                                ..Default::default()
                            },
                        );
                        this.poll_terminal(id, cx);
                    }
                    Err(e) => {
                        this.terminals.insert(
                            id.clone(),
                            TerminalView {
                                notice: Some(format!("无法打开终端：{e}")),
                                ..Default::default()
                            },
                        );
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Read one frame, then schedule the next while this tab is still the one on screen.
    pub(super) fn poll_terminal(&mut self, tab_id: String, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        let Some(view) = self.terminals.get_mut(&tab_id) else {
            return;
        };
        if view.polling
            || view.notice.is_some()
            || (view.frame.as_ref().is_some_and(|f| f.exited)
                && view.read_revision == view.rendered_revision)
        {
            return;
        }
        let Some(session) = view.session.clone() else {
            return;
        };
        view.polling = true;
        let revision = view.read_revision;
        let params = TerminalReadParams {
            id: session.id.clone(),
            offset: view.offset,
            anchor: view.anchor,
        };
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(POLL).await;
            let read = b.call::<TerminalRead>(params).await;
            let alive = this
                .update(cx, |this, cx| {
                    let visible = !this.side_pane_collapsed
                        && this
                            .selected
                            .as_ref()
                            .and_then(|id| this.panes.get(id))
                            .is_some_and(|pane| pane.active.as_ref() == Some(&tab_id));
                    let Some(view) = this.terminals.get_mut(&tab_id) else {
                        return false;
                    };
                    if view
                        .session
                        .as_ref()
                        .is_none_or(|current| current.id != session.id)
                    {
                        return false;
                    }
                    view.polling = false;
                    if view.read_revision != revision {
                        return visible;
                    }
                    match read {
                        Ok(frame) => {
                            if view
                                .reported
                                .is_some_and(|size| size != (frame.cols, frame.rows))
                            {
                                return visible;
                            }
                            let changed = view.frame.as_ref() != Some(&frame);
                            view.offset = frame.offset;
                            view.anchor = Some(frame.anchor);
                            view.rendered_revision = revision;
                            if view
                                .selection
                                .as_ref()
                                .is_some_and(|s| !s.valid_for(&frame))
                            {
                                view.selection = None;
                                view.selecting = false;
                            }
                            if view.selecting
                                && view.autoscroll != 0
                                && let Some(selection) = &mut view.selection
                            {
                                selection.end = terminal_state::point(
                                    &frame,
                                    if view.autoscroll > 0 {
                                        0
                                    } else {
                                        frame.rows.saturating_sub(1) as usize
                                    },
                                    view.drag_column,
                                );
                            }
                            let exited = frame.exited;
                            view.frame = Some(frame);
                            if changed {
                                cx.notify();
                            }
                            visible && !exited
                        }
                        Err(e) => {
                            view.notice = Some(format!("无法读取原终端会话：{e}"));
                            cx.notify();
                            false
                        }
                    }
                })
                .unwrap_or(false);
            if alive {
                this.update(cx, |this, cx| this.poll_terminal(tab_id, cx))
                    .ok();
            }
        })
        .detach();
    }

    /// Coalesce resize requests while retaining their order. An older resize cannot run after
    /// the newest one and leave the PTY permanently at a size the GUI no longer reports.
    pub(super) fn report_terminal_size(
        &mut self,
        tab_id: &str,
        cols: u16,
        rows: u16,
        cx: &mut Context<Self>,
    ) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(view) = self.terminals.get_mut(tab_id) else {
            return;
        };
        if view.reported != Some((cols, rows)) {
            view.reported = Some((cols, rows));
            view.read_revision = view.read_revision.wrapping_add(1);
        }
        if view.resizing || view.last_size_sent == Some((cols, rows)) {
            return;
        }
        let Some(session) = view.session.clone() else {
            return;
        };
        view.resizing = true;
        view.last_size_sent = Some((cols, rows));
        let tab = tab_id.to_string();
        cx.spawn(async move |this, cx| {
            let result = backend
                .call::<TerminalResize>(TerminalResizeParams {
                    id: session.id.clone(),
                    cols,
                    rows,
                })
                .await;
            this.update(cx, |this, cx| {
                let Some(view) = this.terminals.get_mut(&tab) else {
                    return;
                };
                if view
                    .session
                    .as_ref()
                    .is_none_or(|current| current.id != session.id)
                {
                    return;
                }
                view.resizing = false;
                if let Err(error) = result {
                    view.last_size_sent = None;
                    view.notice = Some(format!("无法调整终端尺寸：{error}"));
                    cx.notify();
                    return;
                }
                if let Some((new_cols, new_rows)) = view.reported
                    && (new_cols, new_rows) != (cols, rows)
                {
                    this.report_terminal_size(&tab, new_cols, new_rows, cx);
                } else {
                    this.poll_terminal(tab.clone(), cx);
                }
            })
            .ok();
        })
        .detach();
    }

    /// The terminal tab's body.
    pub(super) fn terminal_body(
        &mut self,
        tab_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.poll_terminal(tab_id.to_string(), cx);
        let p = self.palette.clone();
        let (frame, notice) = match self.terminals.get(tab_id) {
            Some(view) => (view.frame.clone(), view.notice.clone()),
            None => (None, None),
        };
        if let Some(notice) = notice {
            let retry = tab_id.to_string();
            return div()
                .p(px(12.0))
                .text_size(px(TEXT_XS))
                .text_color(p.c(Token::Warning))
                .flex()
                .flex_col()
                .gap(px(12.0))
                .child(SharedString::from(notice))
                .child(
                    div()
                        .id("terminal-reopen")
                        .cursor_pointer()
                        .child(if self.app_settings.language == UiLanguage::English {
                            "Reopen terminal"
                        } else {
                            "重开终端"
                        })
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.start_terminal_tab(retry.clone(), cx);
                            cx.notify();
                        })),
                )
                .into_any_element();
        }
        let Some(frame) = frame else {
            return div()
                .p(px(12.0))
                .text_size(px(TEXT_XS))
                .muted(&p)
                .child(if self.app_settings.language == UiLanguage::English {
                    "Starting terminal…"
                } else {
                    "正在启动终端…"
                })
                .into_any_element();
        };

        self.ensure_terminal_input(tab_id, cx);
        let input = self
            .terminals
            .get(tab_id)
            .and_then(|v| v.input.clone())
            .expect("terminal input");
        if self
            .terminals
            .get_mut(tab_id)
            .is_some_and(|v| std::mem::take(&mut v.focus))
        {
            window.focus(&self.terminal_focus, cx);
        }
        let focused = self.terminal_focus.is_focused(window);
        let font = Font {
            family: crate::assets::MONO_FONT.into(),
            ..Default::default()
        };
        let cell_width = window
            .text_system()
            .advance(window.text_system().resolve_font(&font), px(FONT_SIZE), 'M')
            .map(|s| f32::from(s.width))
            .unwrap_or(CELL_WIDTH)
            .max(1.0);
        let selection = self.terminals.get(tab_id).and_then(|v| v.selection.clone());
        let composition = input.read(cx).preedit.text.clone();
        let (cursor_row, cursor_col) = (frame.cursor_row, frame.cursor_col);
        let native_bracketed_paste = frame.bracketed_paste;
        let terminal_frame = frame.clone();
        let grid_palette = p.clone();
        let tab = tab_id.to_string();
        let measure_tab = tab.clone();
        let key_tab = tab.clone();
        let mouse_tab = tab.clone();
        let wheel_tab = tab.clone();
        let live_tab = tab.clone();
        let reopen_tab = tab;
        let workspace = cx.entity().downgrade();
        let grid = canvas(
            move |bounds, window, cx| {
                workspace
                    .update(cx, |this, cx| {
                        if let Some(view) = this.terminals.get_mut(&measure_tab) {
                            view.bounds = Some(bounds);
                            view.cell_width = cell_width;
                        }
                        this.sync_terminal_size(
                            &measure_tab,
                            f32::from(bounds.size.width),
                            f32::from(bounds.size.height),
                            cx,
                        );
                    })
                    .ok();
                paint_grid(
                    &terminal_frame,
                    bounds,
                    cell_width,
                    selection.as_ref(),
                    focused,
                    &grid_palette,
                    window,
                )
            },
            move |bounds, painted, window, cx| {
                let cursor = Bounds::new(
                    point(
                        bounds.left() + px(8.0 + cursor_col as f32 * cell_width),
                        bounds.top() + px(8.0 + cursor_row as f32 * LINE_HEIGHT),
                    ),
                    size(px(cell_width), px(LINE_HEIGHT)),
                );
                input.update(cx, |input, _| {
                    input.cursor = Some(cursor);
                    input.viewport = Some(bounds);
                    input.cell_width = cell_width;
                    input.bracketed_paste = native_bracketed_paste;
                });
                let focus = input.read(cx).focus.clone();
                window.handle_input(&focus, ElementInputHandler::new(bounds, input.clone()), cx);
                for (line, origin, background) in painted {
                    if let Some(background) = background {
                        window.paint_quad(background);
                    }
                    let _ = line.paint(origin, px(LINE_HEIGHT), TextAlign::Left, None, window, cx);
                }
            },
        )
        .absolute()
        .inset_0();
        div()
            .id("terminal")
            .size_full()
            .flex()
            .flex_col()
            .bg(p.c(Token::Background))
            .track_focus(&self.terminal_focus)
            .key_context("Terminal")
            .on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
                this.terminal_key(&key_tab, event, window, cx)
            }))
            .child(
                div()
                    .id("terminal-grid")
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .min_w_0()
                    .overflow_hidden()
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                            this.terminal_select(&mouse_tab, event, window, cx)
                        }),
                    )
                    .on_scroll_wheel(cx.listener(move |this, event: &ScrollWheelEvent, _, cx| {
                        this.terminal_wheel(&wheel_tab, event, cx)
                    }))
                    .child(grid)
                    .children(
                        (focused && !composition.is_empty() && frame.offset == 0).then(|| {
                            div()
                                .absolute()
                                .left(px(8.0 + cursor_col as f32 * cell_width))
                                .top(px(8.0 + cursor_row as f32 * LINE_HEIGHT))
                                .bg(p.c(Token::Background))
                                .text_color(p.c(Token::Foreground))
                                .font_family(crate::assets::MONO_FONT)
                                .text_size(px(FONT_SIZE))
                                .line_height(px(LINE_HEIGHT))
                                .whitespace_nowrap()
                                .underline()
                                .child(SharedString::from(composition))
                        }),
                    )
                    .children((frame.offset > 0).then(|| {
                        div()
                            .id("terminal-live")
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(|_, _, _, cx| cx.stop_propagation()),
                            )
                            .absolute()
                            .right(px(8.0))
                            .top(px(4.0))
                            .px(px(6.0))
                            .py(px(3.0))
                            .rounded(px(4.0))
                            .bg(p.c(Token::Muted))
                            .text_size(px(TEXT_XS))
                            .cursor_pointer()
                            .child(SharedString::from(
                                if self.app_settings.language == UiLanguage::English {
                                    format!("Back to latest ({} lines)", frame.offset)
                                } else {
                                    format!("回到最新（{} 行）", frame.offset)
                                },
                            ))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.terminal_live(&live_tab, cx);
                            }))
                    })),
            )
            .children(frame.exited.then(|| {
                div()
                    .flex_none()
                    .px(px(10.0))
                    .py(px(4.0))
                    .border_t_1()
                    .border_color(p.c(Token::Border))
                    .text_size(px(TEXT_XS))
                    .muted(&p)
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    .child(if self.app_settings.language == UiLanguage::English {
                        "Exited"
                    } else {
                        "已结束"
                    })
                    .child(
                        div()
                            .id("terminal-reopen-exited")
                            .cursor_pointer()
                            .child(if self.app_settings.language == UiLanguage::English {
                                "Reopen terminal"
                            } else {
                                "重开终端"
                            })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.start_terminal_tab(reopen_tab.clone(), cx);
                                cx.notify();
                            })),
                    )
            }))
            .into_any_element()
    }

    /// Report the pane's grid to the pty, so the shell wraps where the reader sees it wrap.
    ///
    /// Called from the render pass, which is the only place the pane's real size exists. The call
    /// is a no-op unless the size changed, so a frame that draws the same grid sends nothing.
    pub(super) fn sync_terminal_size(
        &mut self,
        tab_id: &str,
        width: f32,
        height: f32,
        cx: &mut Context<Self>,
    ) {
        let cell_width = self
            .terminals
            .get(tab_id)
            .map_or(CELL_WIDTH, |v| v.cell_width.max(1.0));
        let cols = ((width - 16.0) / cell_width).floor().clamp(2.0, 1024.0) as u16;
        let rows = ((height - 16.0) / LINE_HEIGHT).floor().clamp(1.0, 512.0) as u16;
        self.report_terminal_size(tab_id, cols, rows, cx);
    }
}

#[cfg(test)]
mod keyboard_tests {
    use super::bytes_for;
    use gpui_kit::Keystroke;

    #[test]
    fn ordinary_text_is_left_to_native_ime_and_control_input_is_encoded_once() {
        let key = |s| Keystroke::parse(s).unwrap();
        for text in ["a", "shift-a", "中", "space", "cmd-c"] {
            assert!(bytes_for(&key(text), false).is_none(), "{text}");
        }
        assert_eq!(bytes_for(&key("ctrl-c"), false).unwrap(), b"\x03");
        assert_eq!(bytes_for(&key("ctrl-space"), false).unwrap(), b"\0");
        assert_eq!(bytes_for(&key("alt-b"), false).unwrap(), b"\x1bb");
        assert_eq!(bytes_for(&key("shift-tab"), false).unwrap(), b"\x1b[Z");
    }

    #[test]
    fn cursor_keys_honor_application_mode_and_xterm_modifiers() {
        let key = |s| Keystroke::parse(s).unwrap();
        assert_eq!(bytes_for(&key("up"), false).unwrap(), b"\x1b[A");
        assert_eq!(bytes_for(&key("up"), true).unwrap(), b"\x1bOA");
        assert_eq!(
            bytes_for(&key("ctrl-shift-left"), true).unwrap(),
            b"\x1b[1;6D"
        );
        assert_eq!(bytes_for(&key("alt-right"), false).unwrap(), b"\x1b[1;3C");
    }

    #[test]
    fn global_escape_and_save_bindings_do_not_steal_terminal_input() {
        use super::super::{Dismiss, SavePreview};
        use gpui_kit::{KeyBinding, KeyContext, Keymap};
        let mut map = Keymap::default();
        map.add_bindings([
            KeyBinding::new("escape", Dismiss, None),
            KeyBinding::new("ctrl-s", SavePreview, None),
        ]);
        map.add_bindings(super::passthrough_bindings());
        let workspace = KeyContext::parse("Workspace").unwrap();
        let terminal = KeyContext::parse("Terminal").unwrap();
        for key in ["escape", "ctrl-s"] {
            let stroke = Keystroke::parse(key).unwrap();
            assert_eq!(
                map.bindings_for_input(
                    std::slice::from_ref(&stroke),
                    std::slice::from_ref(&workspace)
                )
                .0
                .len(),
                1
            );
            let (bindings, pending) = map.bindings_for_input(
                std::slice::from_ref(&stroke),
                &[workspace.clone(), terminal.clone()],
            );
            assert!(
                bindings.is_empty() && !pending,
                "{key} must reach terminal_key"
            );
        }
    }
}
