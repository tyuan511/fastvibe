//! Native text input belongs to an individual terminal, including its uncommitted IME text.
use crate::terminal_state::Preedit;
use gpui_kit::{
    Bounds, ClipboardItem, Context, EntityInputHandler, EventEmitter, FocusHandle, Font, Pixels,
    Point, ShapedLine, TextRun, UTF16Selection, Window, point, px, size,
};
use std::ops::Range;

pub(in crate::workspace) enum InputEvent {
    Changed,
    Commit(String),
}

pub(in crate::workspace) struct TerminalInput {
    pub preedit: Preedit,
    pub cursor: Option<Bounds<Pixels>>,
    pub viewport: Option<Bounds<Pixels>>,
    pub cell_width: f32,
    pub bracketed_paste: bool,
    pub focus: FocusHandle,
}
impl EventEmitter<InputEvent> for TerminalInput {}

impl TerminalInput {
    pub fn new(focus: FocusHandle) -> Self {
        Self {
            focus,
            preedit: Preedit::default(),
            cursor: None,
            viewport: None,
            cell_width: 7.4,
            bracketed_paste: false,
        }
    }
    fn shaped_preedit(&self, window: &Window) -> ShapedLine {
        let text = self.preedit.text.clone();
        let run = TextRun {
            len: text.len(),
            font: Font {
                family: crate::assets::MONO_FONT.into(),
                ..Default::default()
            },
            ..Default::default()
        };
        window
            .text_system()
            .shape_line(text.into(), px(super::FONT_SIZE), &[run], None)
    }
    pub fn cancel(&mut self, cx: &mut Context<Self>) {
        if !self.preedit.is_empty() {
            self.preedit.clear();
            cx.emit(InputEvent::Changed);
        }
    }
}

impl EntityInputHandler for TerminalInput {
    fn paste(&mut self, item: ClipboardItem, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = item.text() {
            self.cancel(cx);
            let data = crate::terminal_state::paste(&text, self.bracketed_paste);
            cx.emit(InputEvent::Commit(
                String::from_utf8_lossy(&data).into_owned(),
            ));
        }
    }
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        actual: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let (text, range) = self.preedit.text_for(range);
        *actual = Some(range);
        Some(text)
    }
    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.preedit.selected.clone(),
            reversed: false,
        })
    }
    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        (!self.preedit.is_empty()).then(|| 0..self.preedit.len())
    }
    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = self.preedit.finish() {
            cx.emit(InputEvent::Commit(text));
        }
    }
    fn replace_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let committed = self.preedit.commit(range, text);
        if !committed.is_empty() {
            cx.emit(InputEvent::Commit(committed));
        } else {
            cx.emit(InputEvent::Changed);
        }
    }
    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        selected: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.preedit.mark(range, text, selected);
        cx.emit(InputEvent::Changed);
    }
    fn bounds_for_range(
        &mut self,
        range: Range<usize>,
        _: Bounds<Pixels>,
        window: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let cursor = self.cursor?;
        let (x, width) = if self.preedit.is_empty() {
            (cursor.left(), px(self.cell_width))
        } else {
            let line = self.shaped_preedit(window);
            let range = self.preedit.range(range);
            let start = line.x_for_index(range.start);
            let end = line.x_for_index(range.end);
            (
                cursor.left() + start.min(end),
                px(f32::from(end - start).abs()).max(px(self.cell_width)),
            )
        };
        let origin = if let Some(viewport) = self.viewport {
            point(
                x.min(viewport.right() - px(self.cell_width))
                    .max(viewport.left()),
                cursor
                    .top()
                    .min(viewport.bottom() - cursor.size.height)
                    .max(viewport.top()),
            )
        } else {
            point(x, cursor.top())
        };
        Some(Bounds::new(origin, size(width, cursor.size.height)))
    }
    fn character_index_for_point(
        &mut self,
        at: Point<Pixels>,
        window: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        let cursor = self.cursor?;
        if self.preedit.is_empty() {
            return Some(0);
        }
        let line = self.shaped_preedit(window);
        let x = (at.x - cursor.left()).max(px(0.0)).min(line.width);
        let index = line.index_for_x(x).unwrap_or(self.preedit.text.len());
        Some(
            self.preedit
                .text
                .char_indices()
                .take_while(|(byte, _)| *byte < index)
                .map(|(_, c)| c.len_utf16())
                .sum(),
        )
    }
}
