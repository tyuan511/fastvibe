//! Terminal selection and IME state, independent of the window system.
use fv_protocol::types::{TerminalCopyParams, TerminalFrame, TerminalPoint, TerminalRow};
use std::ops::Range;
use unicode_width::UnicodeWidthChar;

/// A glyph occupies an emulator cell, even if several Unicode scalars make up that cell.
pub fn glyphs(row: &TerminalRow) -> Vec<(String, u16, u16)> {
    let mut out: Vec<(String, u16, u16)> = Vec::new();
    let mut column = 0;
    for (i, c) in row.text.chars().enumerate() {
        let width = row
            .widths
            .get(i)
            .copied()
            .unwrap_or_else(|| c.width().unwrap_or(0) as u8) as u16;
        if width == 0
            && let Some((text, _, _)) = out.last_mut()
        {
            text.push(c);
            continue;
        }
        out.push((c.to_string(), column, width));
        column += width;
    }
    out
}

pub fn point(frame: &TerminalFrame, row: usize, column: u16) -> TerminalPoint {
    TerminalPoint {
        line: frame.anchor.serial as i64 - frame.offset as i64
            + row.min(frame.rows.saturating_sub(1) as usize) as i64,
        column: column.min(frame.cols),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Selection {
    pub epoch: u64,
    pub start: TerminalPoint,
    pub end: TerminalPoint,
}

impl Selection {
    pub fn range(&self) -> (TerminalPoint, TerminalPoint) {
        if self.start <= self.end {
            (self.start, self.end)
        } else {
            (self.end, self.start)
        }
    }
    pub fn columns(&self, line: i64, cols: u16) -> Range<u16> {
        let (start, end) = self.range();
        if line < start.line || line > end.line {
            return 0..0;
        }
        (if line == start.line { start.column } else { 0 })..(if line == end.line {
            end.column
        } else {
            cols
        })
    }
    pub fn copy_params(&self, id: String) -> Option<TerminalCopyParams> {
        (self.start != self.end).then_some(TerminalCopyParams {
            id,
            epoch: self.epoch,
            start: self.start,
            end: self.end,
        })
    }
    pub fn valid_for(&self, frame: &TerminalFrame) -> bool {
        let (start, end) = self.range();
        self.epoch == frame.anchor.epoch
            && start.line >= frame.anchor.serial as i64 - frame.history as i64
            && end.line < frame.anchor.serial as i64 + frame.rows as i64
    }
    pub fn word(frame: &TerminalFrame, row: usize, column: u16) -> Option<Self> {
        let cells = glyphs(frame.lines.get(row)?);
        let index = cells
            .iter()
            .position(|(_, at, width)| *at <= column && column < at + width)?;
        let class = |text: &str| {
            let c = text.chars().next().unwrap_or(' ');
            if c.is_whitespace() {
                0
            } else if c.is_alphanumeric() || c == '_' {
                1
            } else {
                2
            }
        };
        let target = class(&cells[index].0);
        let mut start = index;
        let mut end = index + 1;
        while start > 0 && class(&cells[start - 1].0) == target {
            start -= 1;
        }
        while end < cells.len() && class(&cells[end].0) == target {
            end += 1;
        }
        Some(Self {
            epoch: frame.anchor.epoch,
            start: point(frame, row, cells[start].1),
            end: point(frame, row, cells[end - 1].1 + cells[end - 1].2),
        })
    }
}

/// The terminal cannot edit text already sent to the PTY. Only in-flight composition is local.
#[derive(Default, Debug)]
pub struct Preedit {
    pub text: String,
    pub selected: Range<usize>,
}

fn byte_at(text: &str, utf16: usize, end: bool) -> usize {
    let mut offset = 0;
    for (byte, c) in text.char_indices() {
        if offset >= utf16 {
            return byte;
        }
        if offset + c.len_utf16() > utf16 {
            return if end { byte + c.len_utf8() } else { byte };
        }
        offset += c.len_utf16();
    }
    text.len()
}

impl Preedit {
    pub fn len(&self) -> usize {
        self.text.encode_utf16().count()
    }
    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }
    pub fn clear(&mut self) {
        self.text.clear();
        self.selected = 0..0;
    }
    pub fn finish(&mut self) -> Option<String> {
        self.selected = 0..0;
        if self.text.is_empty() {
            return None;
        }
        Some(std::mem::take(&mut self.text))
    }
    pub fn range(&self, range: Range<usize>) -> Range<usize> {
        let start = range.start.min(range.end).min(self.len());
        let end = range.start.max(range.end).min(self.len());
        let first = byte_at(&self.text, start, false);
        // An insertion in a surrogate pair snaps before the scalar, never deletes that scalar.
        first..if start == end {
            first
        } else {
            byte_at(&self.text, end, true)
        }
    }
    pub fn text_for(&self, range: Range<usize>) -> (String, Range<usize>) {
        let bytes = self.range(range);
        let actual = self.text[..bytes.start].encode_utf16().count()
            ..self.text[..bytes.end].encode_utf16().count();
        (self.text[bytes].to_string(), actual)
    }
    fn replace(&mut self, range: Option<Range<usize>>, text: &str) -> usize {
        let bytes = self.range(range.unwrap_or(0..self.len()));
        let start = self.text[..bytes.start].encode_utf16().count();
        self.text.replace_range(bytes, text);
        start
    }
    pub fn mark(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        selected: Option<Range<usize>>,
    ) {
        let start = self.replace(range, text);
        let length = text.encode_utf16().count();
        let selected = selected.unwrap_or(length..length);
        self.selected = (start + selected.start.min(selected.end).min(length))
            ..(start + selected.start.max(selected.end).min(length));
    }
    pub fn commit(&mut self, range: Option<Range<usize>>, text: &str) -> String {
        self.replace(range, text);
        self.finish().unwrap_or_default()
    }
}

pub fn paste(text: &str, bracketed: bool) -> Vec<u8> {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    if bracketed {
        // A pasted end marker must not turn the remainder into executable terminal input.
        format!("\x1b[200~{}\x1b[201~", text.replace('\x1b', "")).into_bytes()
    } else {
        text.replace('\n', "\r").into_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::{Preedit, glyphs, paste};
    use fv_protocol::types::TerminalRow;

    #[test]
    fn ime_keeps_marked_text_local_until_one_commit() {
        let mut input = Preedit::default();
        input.mark(None, "ni", None);
        input.mark(None, "你好🦀", Some(2..4));
        assert_eq!(input.len(), 4);
        assert_eq!(input.selected, 2..4);
        assert_eq!(input.commit(None, "你好"), "你好");
        assert!(input.is_empty());
        assert_eq!(input.commit(None, "!"), "!");
        input.mark(None, "确认", None);
        assert_eq!(input.finish().as_deref(), Some("确认"));
        assert!(
            input.finish().is_none(),
            "unmark after a commit must not send the text twice"
        );
    }

    #[test]
    fn utf16_ranges_never_split_surrogates_or_utf8() {
        let mut input = Preedit::default();
        input.mark(None, "A🦀中", None);
        assert_eq!(input.text_for(2..3), ("🦀".into(), 1..3));
        input.mark(Some(1..3), "你", Some(0..1));
        assert_eq!(input.text, "A你中");
        assert_eq!(input.selected, 1..2);
        input.clear();
        assert_eq!(input.text_for(99..100), (String::new(), 0..0));
    }

    #[test]
    fn pasted_end_markers_cannot_escape_bracketed_paste() {
        assert_eq!(paste("a\r\nb\nc", false), b"a\rb\rc");
        assert_eq!(
            paste("a\x1b[201~\r\nb", true),
            b"\x1b[200~a[201~\nb\x1b[201~"
        );
    }

    #[test]
    fn cells_keep_cjk_emoji_and_combining_marks_at_emulator_columns() {
        let row = TerminalRow {
            text: "中e\u{301}🦀".into(),
            widths: vec![2, 1, 0, 2],
            ..Default::default()
        };
        assert_eq!(
            glyphs(&row),
            vec![
                ("中".into(), 0, 2),
                ("e\u{301}".into(), 2, 1),
                ("🦀".into(), 3, 2)
            ]
        );
    }

    #[test]
    fn word_selection_uses_cell_columns_and_survives_new_output_until_evicted() {
        use super::Selection;
        use fv_protocol::types::{TerminalAnchor, TerminalFrame};
        let mut frame = TerminalFrame {
            id: "pty".into(),
            cwd: "/".into(),
            cols: 7,
            rows: 1,
            lines: vec![TerminalRow {
                text: "你e\u{301} hi!".into(),
                widths: vec![2, 1, 0, 1, 1, 1, 1],
                ..Default::default()
            }],
            cursor_row: 0,
            cursor_col: 0,
            cursor_hidden: false,
            exited: false,
            history: 10,
            offset: 3,
            anchor: TerminalAnchor {
                epoch: 2,
                serial: 10,
            },
            bracketed_paste: false,
            application_cursor: false,
            alternate_screen: false,
        };
        let word = Selection::word(&frame, 0, 1).unwrap();
        assert_eq!(word.start.line, 7);
        assert_eq!(word.columns(7, 7), 0..3);
        assert_eq!(word.columns(6, 7), 0..0);
        let punctuation = Selection::word(&frame, 0, 6).unwrap();
        assert_eq!(punctuation.columns(7, 7), 6..7);
        frame.anchor.serial = 14;
        frame.history = 14;
        frame.offset = 7;
        assert!(word.valid_for(&frame));
        frame.anchor.serial = 30;
        frame.history = 10;
        assert!(!word.valid_for(&frame));
        frame.anchor.serial = 10;
        frame.history = 10;
        frame.anchor.epoch += 1;
        assert!(!word.valid_for(&frame));
    }
}
