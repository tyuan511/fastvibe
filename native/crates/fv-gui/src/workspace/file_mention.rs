//! The `@` file mention in the composer: which token the caret is inside, and what the draft
//! becomes after a file is picked.
//!
//! Pure, and kept apart from the view for the reason the Electron app keeps
//! `lib/file-mention.ts` apart: the rules are small but each one is a decision, and every one of
//! them is a bug if it is wrong.
//!
//! - **`@` has to open a token** — the start of the draft, whitespace, or a character that cannot
//!   belong to an email's local part. `user@host` and `a.b@c` are ordinary text, and opening a
//!   file list in the middle of an address is the sort of thing nobody asks for and everybody
//!   notices.
//! - **A space ends the mention.** The query runs from the character after `@` to the caret and
//!   may not contain whitespace, so typing `@foo bar` means the list closed after `bar`'s space.
//! - **A picked file becomes an attachment, not text.** The token leaves the draft, because the
//!   file travels as a reference the model is given; leaving `@path` behind would send it twice.
//!   The whitespace the token was padded with collapses to the one space that was already
//!   separating the words around it.

/// The `@query` the caret is inside.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileMention {
    /// Byte index of the `@`.
    pub start: usize,
    /// Byte index of the caret, which is also the end of the query.
    pub end: usize,
    pub query: String,
}

/// The query may not be longer than this; past it the user is not typing a file name.
const MAX_QUERY: usize = 200;

/// A character that can belong to an email's local part. An `@` right after one of these is an
/// address, not a mention.
fn email_local(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '%' | '+' | '-')
}

/// The `@query` at `caret`, or `None` when the caret is not inside one.
///
/// `caret` is a byte offset into `value`, which is what a text area hands over.
pub fn mention_at_caret(value: &str, caret: usize) -> Option<FileMention> {
    let caret = caret.min(value.len());
    // Only look at the text before the caret: what comes after is somebody else's problem until
    // the caret moves there.
    let head = value.get(..caret)?;
    let at = head.rfind('@')?;
    // The `@` has to open the token.
    if let Some(before) = value[..at].chars().next_back()
        && email_local(before)
    {
        return None;
    }
    let query = value.get(at + 1..caret)?;
    if query.chars().count() > MAX_QUERY || query.chars().any(|c| c.is_whitespace() || c == '@') {
        return None;
    }
    Some(FileMention {
        start: at,
        end: caret,
        query: query.to_string(),
    })
}

/// The draft after the mention is replaced by a picked file, and where the caret goes.
pub fn apply(value: &str, mention: &FileMention) -> (String, usize) {
    let before = &value[..mention.start];
    let after = &value[mention.end..];
    // The token was its own word: the space on each side of it becomes the one space that was
    // already separating the words around it, and a space that only padded the token is dropped.
    let both_sides_spaced = before.ends_with(' ') && after.starts_with(' ');
    let after = if both_sides_spaced {
        &after[1..]
    } else {
        after
    };
    let mut next = format!("{before}{after}");
    if before.is_empty() {
        next = next.trim_start_matches([' ', '\t']).to_string();
    }
    if after.is_empty() {
        next = next.trim_end_matches([' ', '\t']).to_string();
    }
    let next_len = next.len();
    let caret = if after.is_empty() {
        next_len
    } else if before.is_empty() {
        0
    } else {
        before.len()
    };
    let caret = caret.min(next_len);
    (next, caret)
}

#[cfg(test)]
mod tests {
    // Explicit, not `use super::*`: the module's own panel code imports gpui's element macros,
    // and pulling them into this scope makes `#[test]` expand against those names.
    use super::{FileMention, MAX_QUERY, apply, mention_at_caret};

    fn tok(value: &str, caret: usize) -> Option<FileMention> {
        mention_at_caret(value, caret)
    }

    #[test]
    fn a_mention_opens_at_a_word_boundary_only() {
        let found = tok("@src", 4).expect("a mention");
        assert_eq!(
            (found.start, found.end, found.query.as_str()),
            (0, 4, "src")
        );
        assert_eq!(tok("look at @src", 12).map(|m| m.query), Some("src".into()));
        // An address is not a mention.
        assert_eq!(tok("user@host", 9), None);
        assert_eq!(tok("a.b@c", 5), None);
        // A space closes it: the caret is past the token, not inside one.
        assert_eq!(tok("@src app.ts", 12), None);
    }

    #[test]
    fn the_query_stops_at_the_caret_not_at_the_end_of_the_draft() {
        // The caret decides, not the end of the draft: at 3 it is right after `src`, and at 5 it
        // has crossed into `app` — which is still the same token, because `/` is not whitespace.
        assert_eq!(tok("@src/app.ts", 3).map(|m| m.query), Some("sr".into()));
        assert_eq!(tok("@src/app.ts", 5).map(|m| m.query), Some("src/".into()));
        assert_eq!(tok("@src/app.ts", 1).map(|m| m.query), Some(String::new()));
    }

    #[test]
    fn an_over_long_or_second_at_is_not_a_file_query() {
        assert_eq!(tok(&format!("@{}", "a".repeat(MAX_QUERY + 1)), 0), None);
        assert_eq!(tok("@a@b", 4), None);
        // Whitespace anywhere between the `@` and the caret means the user left the mention.
        assert_eq!(tok("@a b", 4), None);
    }

    #[test]
    fn picking_a_file_removes_the_token_and_keeps_the_sentence() {
        let value = "please read @src/app";
        let token = tok(value, value.len()).unwrap();
        assert_eq!(apply(value, &token), ("please read".to_string(), 11));

        // A mention in the middle keeps one space, not two.
        let value = "read @src then";
        let token = tok(value, 9).unwrap();
        assert_eq!(apply(value, &token), ("read then".to_string(), 5));

        // A mention on its own leaves an empty draft.
        let value = "@src";
        let token = tok(value, 4).unwrap();
        assert_eq!(apply(value, &token), (String::new(), 0));

        // Leading padding does not leave a leading space behind.
        let value = " @src";
        let token = tok(value, 5).unwrap();
        assert_eq!(apply(value, &token), (String::new(), 0));
    }
}

// ---- the panel the mention opens
//
// The list is the Electron composer's `@` menu: at most twelve rows, the file's name and then the
// directory that tells two same-named files apart, and Enter takes the highlighted one. It hangs
// above the composer because that is where the caret is looking; a popover below it would cover
// the draft.

use fv_protocol::methods::WorkspaceSearchFiles;
use fv_protocol::types::{FileHit, SearchFilesParams};
use fv_theme::Token;
use gpui_kit::component::input::RopeExt as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::Workspace;
use crate::ui::{self, Muted as _, TEXT_XS, icon};

/// The reference block appended to a prompt that carries attached files.
///
/// The same tag the Electron composer uses (`<fastvibe-attachments>`), so a transcript written by
/// either build reads the same way, and a file picked with `@` is handed to the model as a path it
/// can open rather than as text the reader has to parse out of their own sentence.
pub fn attachment_suffix(files: &[fv_protocol::types::FileHit]) -> String {
    if files.is_empty() {
        return String::new();
    }
    let list: Vec<String> = files.iter().map(|f| format!("- {}", f.path)).collect();
    format!(
        "\n\n<fastvibe-attachments>\n{}\n</fastvibe-attachments>",
        list.join("\n")
    )
}

/// What the `@` menu has read, and what the user has selected in it.
#[derive(Default)]
pub struct MentionState {
    /// The token the list belongs to. A list for a different token is stale and is not drawn.
    pub token: Option<FileMention>,
    pub hits: Vec<FileHit>,
    /// Which row Enter would take.
    pub index: usize,
    /// The query `hits` were read for: until it matches the token's, the list is one keystroke
    /// behind and is drawn as "reading" rather than as results.
    pub hits_query: Option<String>,
}

impl Workspace {
    /// Re-read the mentions for the draft's current caret.
    ///
    /// Called on every keystroke in the composer. The token is found here, the files come from the
    /// server (a git work tree can be thousands of files), and a request that is no longer the
    /// newest one is dropped by comparing the query when it lands.
    pub(super) fn refresh_mentions(&mut self, cx: &mut Context<Self>) {
        let value = self.input.read(cx).value().to_string();
        // The caret is the end of the draft as far as this view is concerned: a text area's
        // selection is not exposed here, and a mention is typed at the end in practice.
        let token = mention_at_caret(&value, value.len());
        let Some(token) = token else {
            if self.mention.take().is_some() {
                cx.notify();
            }
            return;
        };
        if self.mention.as_ref().is_some_and(|m| {
            m.token.as_ref() == Some(&token) && m.hits_query.as_deref() == Some(&token.query)
        }) {
            return;
        }
        let Some(cwd) = self
            .selected
            .as_ref()
            .and_then(|id| self.project_root_for(id))
        else {
            // A scratch chat has no project, so there is nothing to list.
            self.mention = None;
            cx.notify();
            return;
        };
        let Some(b) = self.backend.clone() else {
            return;
        };
        let query = token.query.clone();
        if let Some(state) = &mut self.mention {
            state.token = Some(token.clone());
        } else {
            self.mention = Some(MentionState {
                token: Some(token.clone()),
                ..Default::default()
            });
        }
        let other_folders = self
            .selected
            .as_ref()
            .map(|id| self.project_roots_for(id).into_iter().skip(1).collect())
            .unwrap_or_default();
        cx.spawn(async move |this, cx| {
            let result = b
                .call::<WorkspaceSearchFiles>(SearchFilesParams {
                    cwd: Some(cwd),
                    query: Some(query.clone()),
                    other_folders,
                })
                .await;
            this.update(cx, |this, cx| {
                let Some(state) = &mut this.mention else {
                    return;
                };
                // The draft moved on while the files were being read: this answer is for a token
                // nobody is in any more.
                if state.token.as_ref().map(|t| &t.query) != Some(&query) {
                    return;
                }
                state.hits = result.map(|r| r.hits).unwrap_or_default();
                state.hits_query = Some(query);
                state.index = 0;
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// Enter on the highlighted row: the file becomes an attachment and the token leaves the draft.
    pub(super) fn accept_mention(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(state) = &self.mention else {
            return false;
        };
        let (Some(token), Some(hit)) = (state.token.clone(), state.hits.get(state.index).cloned())
        else {
            return false;
        };
        let value = self.input.read(cx).value().to_string();
        let (next, caret) = apply(&value, &token);
        self.input.update(cx, |st, cx| {
            st.set_value(crate::skill_draft::content(next), window, cx);
            let position = st.text().offset_to_position(caret);
            st.set_cursor_position(position, window, cx);
        });
        // The file travels as a reference the model is given, not as text: leaving `@path` behind
        // would send it twice.
        self.attached_files.push(hit.clone());
        self.mention = None;
        cx.notify();
        true
    }

    /// Up / down in the list.
    pub(super) fn move_mention(&mut self, delta: i32, cx: &mut Context<Self>) {
        let Some(state) = &mut self.mention else {
            return;
        };
        if state.hits.is_empty() {
            return;
        }
        let len = state.hits.len() as i32;
        state.index = ((state.index as i32 + delta).rem_euclid(len)) as usize;
        cx.notify();
    }

    /// The prompt as it is actually sent: the typed words, then the files picked with `@`.
    ///
    /// One function so every send path — a turn, a queued prompt, a steer — carries the same
    /// reference block, and a file picked with `@` is never silently dropped by one of them.
    pub(super) fn prompt_with_attachments(&mut self, text: &str) -> String {
        let files = std::mem::take(&mut self.attached_files);
        let suffix = attachment_suffix(&files);
        if suffix.is_empty() {
            text.to_string()
        } else {
            format!("{text}{suffix}")
        }
    }

    /// Draw the `@` menu, or nothing when no mention is open.
    pub(super) fn mention_panel(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let state = self.mention.as_ref()?;
        let p = &self.palette;
        // While the files for the current query are still being read, say so rather than showing
        // the previous query's rows: a list that answers a different question is worse than none.
        let ready = state.hits_query.as_deref() == Some(state.token.as_ref()?.query.as_str());
        let hover = p.c(Token::Accent);
        let mut rows = div().flex().flex_col();
        if !ready {
            rows = rows.child(
                div()
                    .px(px(10.0))
                    .py(px(8.0))
                    .text_size(px(TEXT_XS))
                    .muted(p)
                    .child("正在查找…"),
            );
        } else if state.hits.is_empty() {
            rows = rows.child(
                div()
                    .px(px(10.0))
                    .py(px(8.0))
                    .text_size(px(TEXT_XS))
                    .muted(p)
                    .child("没有匹配的文件"),
            );
        }
        for (index, hit) in state.hits.iter().enumerate() {
            let selected = index == state.index;
            let name = hit.relative.rsplit('/').next().unwrap_or(&hit.relative);
            let dir = hit
                .relative
                .rsplit_once('/')
                .map(|(dir, _)| dir.to_string())
                .unwrap_or_default();
            rows = rows.child(
                div()
                    .id(SharedString::from(format!("mention-{index}")))
                    .h(px(28.0))
                    .px(px(8.0))
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .rounded(px(6.0))
                    .text_size(px(crate::ui::TEXT_SM))
                    .cursor_pointer()
                    .when(selected, |d| d.bg(p.c(Token::SidebarAccent)))
                    .hover(move |d| d.bg(hover))
                    .child(icon("file-01", 13.0, p.c(Token::MutedForeground)))
                    .child(
                        div()
                            .flex_none()
                            .child(SharedString::from(name.to_string())),
                    )
                    // The directory is what tells two same-named files apart.
                    .when(!dir.is_empty(), |d| {
                        d.child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .text_size(px(TEXT_XS))
                                .muted(p)
                                .child(ui::truncate(dir)),
                        )
                    })
                    .on_click(cx.listener(move |this, _, window, cx| {
                        if let Some(state) = &mut this.mention {
                            state.index = index;
                        }
                        this.accept_mention(window, cx);
                    })),
            );
        }
        Some(
            div()
                .mb(px(8.0))
                .rounded(px(12.0))
                .border_1()
                .border_color(p.c(Token::Border))
                .bg(p.overlay())
                .overflow_hidden()
                .child(
                    div()
                        .id("mention-list")
                        // Twelve rows would cover the conversation; the list scrolls instead.
                        .max_h(px(28.0 * 7.0 + 2.0))
                        .overflow_y_scroll()
                        .child(rows),
                )
                .into_any_element(),
        )
    }
}
