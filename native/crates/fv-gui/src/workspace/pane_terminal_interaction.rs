//! Input ordering, selection and history interaction for the active terminal.
use super::{LINE_HEIGHT, TerminalInput, TerminalInputEvent, Workspace, bytes_for};
use crate::terminal_state::{self, Selection};
use fv_protocol::{methods::*, types::*};
use gpui_kit::{
    AppContext as _, ClipboardItem, Context, KeyDownEvent, MouseButton, MouseDownEvent,
    MouseMoveEvent, Pixels, Point, ScrollWheelEvent, Window, px,
};

impl Workspace {
    pub(in crate::workspace) fn sync_terminal_focus(
        &mut self,
        window: &Window,
        cx: &mut Context<Self>,
    ) {
        let active = (!self.side_pane_collapsed && self.terminal_focus.is_focused(window))
            .then(|| {
                self.selected
                    .as_ref()
                    .and_then(|id| self.panes.get(id))
                    .and_then(|pane| pane.active.as_ref())
            })
            .flatten();
        for (tab, view) in &mut self.terminals {
            if active != Some(tab) {
                if let Some(input) = &view.input {
                    input.update(cx, |input, cx| input.cancel(cx));
                }
                view.selecting = false;
                view.autoscroll = 0;
            }
        }
    }

    pub(super) fn ensure_terminal_input(&mut self, tab: &str, cx: &mut Context<Self>) {
        if self
            .terminals
            .get(tab)
            .is_none_or(|view| view.input.is_some())
        {
            return;
        }
        let focus = self.terminal_focus.clone();
        let input = cx.new(|_| TerminalInput::new(focus));
        let owner = tab.to_string();
        cx.subscribe(
            &input,
            move |this, source, event: &TerminalInputEvent, cx| match event {
                TerminalInputEvent::Changed => {
                    if !source.read(cx).preedit.is_empty() {
                        this.terminal_live(&owner, cx);
                    }
                    cx.notify();
                }
                TerminalInputEvent::Commit(text) => {
                    let current = !this.side_pane_collapsed
                        && this.settings.is_none()
                        && this.search_box.is_none()
                        && this.entry_dialog.is_none()
                        && this
                            .selected
                            .as_ref()
                            .and_then(|id| this.panes.get(id))
                            .is_some_and(|pane| pane.active.as_ref() == Some(&owner))
                        && this
                            .terminals
                            .get(&owner)
                            .and_then(|view| view.input.as_ref())
                            .is_some_and(|input| input.entity_id() == source.entity_id());
                    if current {
                        this.write_terminal(&owner, text.as_bytes().to_vec(), cx);
                    }
                }
            },
        )
        .detach();
        if let Some(view) = self.terminals.get_mut(tab) {
            view.input = Some(input);
        }
    }

    pub(in crate::workspace) fn cancel_terminal_compositions(&mut self, cx: &mut Context<Self>) {
        for view in self.terminals.values() {
            if let Some(input) = &view.input {
                input.update(cx, |input, cx| input.cancel(cx));
            }
        }
        self.finish_terminal_selection();
    }

    pub(super) fn terminal_live(&mut self, tab: &str, cx: &mut Context<Self>) {
        if let Some(view) = self.terminals.get_mut(tab)
            && view.offset != 0
        {
            view.offset = 0;
            view.anchor = None;
            view.read_revision = view.read_revision.wrapping_add(1);
            self.poll_terminal(tab.to_string(), cx);
            cx.notify();
        }
    }

    pub(in crate::workspace) fn write_terminal(
        &mut self,
        tab: &str,
        bytes: Vec<u8>,
        cx: &mut Context<Self>,
    ) {
        if bytes.is_empty() {
            return;
        }
        let Some(view) = self.terminals.get_mut(tab) else {
            return;
        };
        if view.frame.as_ref().is_some_and(|f| f.exited) {
            return;
        }
        view.selection = None;
        view.selecting = false;
        view.offset = 0;
        view.anchor = None;
        view.read_revision = view.read_revision.wrapping_add(1);
        view.input_queue.push_back(bytes);
        self.drain_terminal_input(tab.to_string(), cx);
        cx.notify();
    }

    fn drain_terminal_input(&mut self, tab: String, cx: &mut Context<Self>) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(view) = self.terminals.get_mut(&tab) else {
            return;
        };
        if view.writing {
            return;
        }
        let Some(session) = view.session.clone() else {
            return;
        };
        let Some(bytes) = view.input_queue.pop_front() else {
            return;
        };
        view.writing = true;
        cx.spawn(async move |this, cx| {
            let result = backend
                .call::<TerminalWrite>(TerminalWriteParams {
                    id: session.id.clone(),
                    data: String::from_utf8_lossy(&bytes).into_owned(),
                })
                .await;
            this.update(cx, |this, cx| {
                let Some(view) = this.terminals.get_mut(&tab) else {
                    return;
                };
                if view.session.as_ref().is_none_or(|s| s.id != session.id) {
                    return;
                }
                view.writing = false;
                match result {
                    Ok(_) => this.drain_terminal_input(tab, cx),
                    Err(error) => {
                        view.input_queue.clear();
                        view.notice = Some(format!("终端输入失败：{error}"));
                        cx.notify();
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn terminal_key(
        &mut self,
        tab: &str,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let key = &event.keystroke;
        if key.key == "escape" && (self.any_menu_open() || self.entry_dialog.is_some()) {
            if self.any_menu_open() {
                self.close_menus(cx);
            } else {
                self.on_dismiss(&super::super::Dismiss, window, cx);
            }
            window.prevent_default();
            cx.stop_propagation();
            return;
        }
        let modifiers = key.modifiers;
        let shortcut = modifiers.platform || (modifiers.control && modifiers.shift);
        if shortcut && key.key == "c" {
            self.copy_terminal(tab, cx);
        } else if shortcut && key.key == "v" {
            if let Some(text) = cx.read_from_clipboard().and_then(|c| c.text()) {
                let bracketed = self
                    .terminals
                    .get(tab)
                    .and_then(|v| v.frame.as_ref())
                    .is_some_and(|f| f.bracketed_paste);
                if let Some(input) = self.terminals.get(tab).and_then(|v| v.input.clone()) {
                    input.update(cx, |input, cx| input.cancel(cx));
                }
                self.write_terminal(tab, terminal_state::paste(&text, bracketed), cx);
            }
        } else if shortcut && key.key == "a" {
            if let Some(view) = self.terminals.get_mut(tab)
                && let Some(frame) = &view.frame
            {
                view.selection = Some(Selection {
                    epoch: frame.anchor.epoch,
                    start: TerminalPoint {
                        line: frame.anchor.serial as i64 - frame.history as i64,
                        column: 0,
                    },
                    end: TerminalPoint {
                        line: frame.anchor.serial as i64 + frame.rows as i64 - 1,
                        column: frame.cols,
                    },
                });
                cx.notify();
            }
        } else if modifiers.shift
            && matches!(key.key.as_str(), "pageup" | "pagedown" | "home" | "end")
        {
            let rows = self
                .terminals
                .get(tab)
                .and_then(|v| v.frame.as_ref())
                .map_or(24, |f| f.rows as i32);
            let delta = match key.key.as_str() {
                "pageup" => rows - 1,
                "pagedown" => 1 - rows,
                "home" => i32::MAX,
                _ => i32::MIN,
            };
            self.scroll_terminal(tab, delta, cx);
        } else {
            let composing = self
                .terminals
                .get(tab)
                .and_then(|v| v.input.as_ref())
                .is_some_and(|input| !input.read(cx).preedit.is_empty());
            if composing && !modifiers.control && !modifiers.alt && !modifiers.platform {
                return;
            }
            let application = self
                .terminals
                .get(tab)
                .and_then(|v| v.frame.as_ref())
                .is_some_and(|f| f.application_cursor);
            let Some(bytes) = bytes_for(key, application) else {
                return;
            };
            if composing && let Some(input) = self.terminals.get(tab).and_then(|v| v.input.clone())
            {
                input.update(cx, |input, cx| input.cancel(cx));
            }
            self.write_terminal(tab, bytes, cx);
        }
        window.prevent_default();
        cx.stop_propagation();
    }

    fn copy_terminal(&mut self, tab: &str, cx: &mut Context<Self>) {
        let Some(view) = self.terminals.get(tab) else {
            return;
        };
        let Some(params) = view
            .selection
            .as_ref()
            .and_then(|s| s.copy_params(view.session.as_ref()?.id.clone()))
        else {
            return;
        };
        let Some(backend) = self.backend.clone() else {
            return;
        };
        self.terminal_copy_epoch = self.terminal_copy_epoch.wrapping_add(1);
        let epoch = self.terminal_copy_epoch;
        cx.spawn(async move |this, cx| {
            let result = backend.call::<TerminalCopy>(params).await;
            this.update(cx, |this, cx| {
                if this.terminal_copy_epoch != epoch {
                    return;
                }
                match result {
                    Ok(result) => cx.write_to_clipboard(ClipboardItem::new_string(result.text)),
                    Err(error) => {
                        this.notice = Some(super::super::Notice::Failed(format!(
                            "无法复制终端选择：{error}"
                        )));
                        cx.notify();
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    fn scroll_terminal(&mut self, tab: &str, delta: i32, cx: &mut Context<Self>) {
        let Some(view) = self.terminals.get_mut(tab) else {
            return;
        };
        let Some(frame) = &view.frame else {
            return;
        };
        let next = (view.offset as i64 + delta as i64).clamp(0, frame.history as i64) as u32;
        if view.offset == next {
            return;
        }
        view.offset = next;
        view.anchor = Some(frame.anchor);
        view.read_revision = view.read_revision.wrapping_add(1);
        self.poll_terminal(tab.to_string(), cx);
        cx.notify();
    }

    pub(super) fn terminal_wheel(
        &mut self,
        tab: &str,
        event: &ScrollWheelEvent,
        cx: &mut Context<Self>,
    ) {
        let Some(view) = self.terminals.get_mut(tab) else {
            return;
        };
        view.wheel_pixels += f32::from(event.delta.pixel_delta(px(LINE_HEIGHT)).y);
        let lines = (view.wheel_pixels / LINE_HEIGHT).trunc() as i32;
        if lines != 0 {
            view.wheel_pixels -= lines as f32 * LINE_HEIGHT;
            if view.frame.as_ref().is_some_and(|f| f.alternate_screen) && !event.modifiers.shift {
                let application = view.frame.as_ref().is_some_and(|f| f.application_cursor);
                let arrow = if lines > 0 {
                    if application { "\x1bOA" } else { "\x1b[A" }
                } else if application {
                    "\x1bOB"
                } else {
                    "\x1b[B"
                };
                self.write_terminal(
                    tab,
                    arrow
                        .repeat(lines.unsigned_abs().min(32) as usize)
                        .into_bytes(),
                    cx,
                );
            } else {
                self.scroll_terminal(tab, lines, cx);
            }
        }
        cx.stop_propagation();
    }

    fn terminal_hit(&self, tab: &str, at: Point<Pixels>) -> Option<(usize, u16, i8)> {
        let view = self.terminals.get(tab)?;
        let bounds = view.bounds?;
        let frame = view.frame.as_ref()?;
        let y = f32::from(at.y - bounds.top()) - 8.0;
        let row = (y / LINE_HEIGHT)
            .floor()
            .clamp(0.0, frame.rows.saturating_sub(1) as f32) as usize;
        let column = ((f32::from(at.x - bounds.left()) - 8.0) / view.cell_width.max(1.0))
            .round()
            .clamp(0.0, frame.cols as f32) as u16;
        let direction = if y < 0.0 {
            1
        } else if y >= frame.rows as f32 * LINE_HEIGHT {
            -1
        } else {
            0
        };
        Some((row, column, direction))
    }

    pub(super) fn terminal_select(
        &mut self,
        tab: &str,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(input) = self.terminals.get(tab).and_then(|v| v.input.clone()) {
            input.update(cx, |input, cx| input.cancel(cx));
        }
        let Some((row, column, _)) = self.terminal_hit(tab, event.position) else {
            return;
        };
        let Some(view) = self.terminals.get_mut(tab) else {
            return;
        };
        let Some(frame) = &view.frame else {
            return;
        };
        let at = terminal_state::point(frame, row, column);
        if event.click_count >= 3 {
            view.selection = Some(Selection {
                epoch: frame.anchor.epoch,
                start: terminal_state::point(frame, row, 0),
                end: terminal_state::point(frame, row, frame.cols),
            });
        } else if event.click_count == 2 {
            view.selection = Selection::word(frame, row, column.min(frame.cols.saturating_sub(1)));
        } else if event.modifiers.shift
            && let Some(selection) = &mut view.selection
        {
            selection.end = at;
        } else {
            view.selection = Some(Selection {
                epoch: frame.anchor.epoch,
                start: at,
                end: at,
            });
        }
        view.selecting = event.click_count == 1;
        view.drag_column = column;
        view.autoscroll = 0;
        window.focus(&self.terminal_focus, cx);
        window.prevent_default();
        cx.stop_propagation();
        cx.notify();
    }

    pub(in crate::workspace) fn finish_terminal_selection(&mut self) {
        for view in self.terminals.values_mut() {
            view.selecting = false;
            view.autoscroll = 0;
        }
    }

    pub(in crate::workspace) fn terminal_drag_selection(
        &mut self,
        event: &MouseMoveEvent,
        cx: &mut Context<Self>,
    ) {
        if event.pressed_button != Some(MouseButton::Left) {
            return;
        }
        let Some(tab) = self
            .selected
            .as_ref()
            .and_then(|id| self.panes.get(id))
            .and_then(|pane| pane.active.clone())
        else {
            return;
        };
        if self.terminals.get(&tab).is_none_or(|view| !view.selecting) {
            return;
        }
        let Some((row, column, direction)) = self.terminal_hit(&tab, event.position) else {
            return;
        };
        if let Some(view) = self.terminals.get_mut(&tab) {
            if let (Some(frame), Some(selection)) = (&view.frame, &mut view.selection) {
                selection.end = terminal_state::point(frame, row, column);
            }
            view.autoscroll = direction;
            view.drag_column = column;
        }
        if direction != 0 {
            self.terminal_autoscroll(tab, cx);
        }
        cx.notify();
    }

    fn terminal_autoscroll(&mut self, tab: String, cx: &mut Context<Self>) {
        let Some(view) = self.terminals.get_mut(&tab) else {
            return;
        };
        if view.autoscroll_running {
            return;
        }
        view.autoscroll_running = true;
        let session = view.session.as_ref().map(|session| session.id.clone());
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(100))
                    .await;
                let next = this
                    .update(cx, |this, cx| {
                        if this
                            .terminals
                            .get(&tab)
                            .and_then(|view| view.session.as_ref())
                            .map(|s| &s.id)
                            != session.as_ref()
                        {
                            return false;
                        }
                        let active = !this.side_pane_collapsed
                            && this
                                .selected
                                .as_ref()
                                .and_then(|id| this.panes.get(id))
                                .is_some_and(|pane| pane.active.as_ref() == Some(&tab));
                        if !active && let Some(view) = this.terminals.get_mut(&tab) {
                            view.selecting = false;
                            view.autoscroll = 0;
                        }
                        let direction = this
                            .terminals
                            .get(&tab)
                            .filter(|v| v.selecting)
                            .map_or(0, |v| v.autoscroll);
                        if direction == 0 {
                            if let Some(view) = this.terminals.get_mut(&tab) {
                                view.autoscroll_running = false;
                            }
                            return false;
                        }
                        this.scroll_terminal(&tab, direction as i32 * 3, cx);
                        true
                    })
                    .unwrap_or(false);
                if !next {
                    break;
                }
            }
        })
        .detach();
    }
}
