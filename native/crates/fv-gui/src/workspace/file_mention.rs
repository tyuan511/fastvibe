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

use crate::ui::px;
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

/// Extensions the transcript draws as a picture rather than as a named file.
fn is_picture(path: &str) -> bool {
    let lower = path.to_lowercase();
    [".png", ".jpg", ".jpeg", ".gif", ".webp"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

/// What a click on an attachment does.
pub(super) enum AttachmentAction {
    /// The composer's own chip: the ✕ beside it is the only control.
    None,
    /// A file a prompt carried: open it in the right pane.
    Open(String),
}

/// One attached file, as the Electron app's `AttachmentChip` draws it.
///
/// **A picture is an 80px square** (`size-20`, rem so it follows 界面字号) with `object-cover`:
/// a pasted screenshot is the size of a chip, not the size of the first screen of the chat, and
/// the whole picture is one click away. Every other file keeps its compact named chip, with the
/// glyph the file tree would give it.
pub(super) fn attachment_chip(
    path: &str,
    name: &str,
    id: SharedString,
    action: AttachmentAction,
    p: &crate::theme::Palette,
    cx: Option<&mut Context<Workspace>>,
) -> AnyElement {
    if is_picture(path) {
        let missing = p.c(Token::MutedForeground);
        // A `PathBuf`, not a string: `img` reads a string as a *bundled* asset name, which a
        // file on disk never is.
        let picture = img(std::path::PathBuf::from(path))
            .size(px(80.0))
            .object_fit(ObjectFit::Cover)
            .rounded(px(12.0))
            .with_fallback(move || {
                // A file that is gone (the temp directory is cleaned out) still says what it
                // was, rather than leaving an empty square with no explanation.
                icon("image01", 16.0, missing).into_any_element()
            });
        let chip = div()
            .id(id)
            .size(px(80.0))
            .flex_none()
            .overflow_hidden()
            .rounded(px(12.0))
            .bg(p.c(Token::Muted).opacity(0.3))
            .child(picture)
            .tooltip({
                let name = name.to_string();
                move |window, cx| {
                    gpui_kit::component::tooltip::Tooltip::new(name.clone()).build(window, cx)
                }
            });
        let Some(cx) = cx else {
            return chip.into_any_element();
        };
        let AttachmentAction::Open(path) = action else {
            return chip.into_any_element();
        };
        let name = name.to_string();
        return chip
            .cursor_pointer()
            .on_click(cx.listener(move |this, _, window, cx| {
                this.open_in_pane(path.clone(), name.clone(), window, cx);
            }))
            .into_any_element();
    }
    let hover = p.c(Token::Accent);
    let chip = div()
        .id(id)
        .h(px(28.0))
        .max_w(px(220.0))
        .px(px(8.0))
        .flex()
        .items_center()
        .gap(px(6.0))
        .rounded(px(8.0))
        .border_1()
        .border_color(p.c(Token::Border))
        .bg(p.c(Token::Muted).opacity(0.5))
        .text_size(px(TEXT_XS))
        .child(
            img(crate::file_icons::path(name, !p.is_dark()))
                .size(px(13.0))
                .flex_none(),
        )
        .child(ui::truncate(name.to_string()))
        .tooltip({
            let path = path.to_string();
            move |window, cx| {
                gpui_kit::component::tooltip::Tooltip::new(path.clone()).build(window, cx)
            }
        });
    let Some(cx) = cx else {
        return chip.into_any_element();
    };
    let AttachmentAction::Open(path) = action else {
        return chip.hover(move |d| d.bg(hover)).into_any_element();
    };
    let name = name.to_string();
    chip.hover(move |d| d.bg(hover))
        .cursor_pointer()
        .on_click(cx.listener(move |this, _, window, cx| {
            this.open_in_pane(path.clone(), name.clone(), window, cx);
        }))
        .into_any_element()
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

    /// Files chosen with 添加附件 or dropped on the card travel exactly like `@` picks: as
    /// references in the reference block, once each.
    pub(super) fn attach_paths(&mut self, paths: &[std::path::PathBuf], cx: &mut Context<Self>) {
        for path in paths.iter().filter(|p| p.is_file()) {
            let abs = path.display().to_string();
            if self.attached_files.iter().any(|f| f.path == abs) {
                continue;
            }
            let relative = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| abs.clone());
            self.attached_files.push(fv_protocol::types::FileHit {
                relative,
                path: abs,
            });
        }
        cx.notify();
    }

    /// 添加附件: the system file picker.
    pub(super) fn pick_attachments(&mut self, cx: &mut Context<Self>) {
        let picked = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: None,
        });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = picked.await else {
                return;
            };
            this.update(cx, |this, cx| this.attach_paths(&paths, cx))
                .ok();
        })
        .detach();
    }

    /// The chips above the text: what will be sent along, each removable.
    pub(super) fn attachment_chips(&self, cx: &mut Context<Self>) -> Option<Div> {
        if self.attached_files.is_empty() {
            return None;
        }
        let p = &self.palette;
        let mut row = div()
            .flex()
            .flex_wrap()
            .items_start()
            .gap(px(8.0))
            .px(px(12.0))
            .pt(px(12.0));
        for (index, file) in self.attached_files.iter().enumerate() {
            row = row.child(self.removable_chip(file, index, cx));
        }
        Some(row)
    }

    /// One composer chip: the file's own glyph — or, for a picture, its thumbnail — with the
    /// remove control in its corner.
    fn removable_chip(
        &self,
        file: &fv_protocol::types::FileHit,
        index: usize,
        cx: &mut Context<Self>,
    ) -> Div {
        let p = &self.palette;
        let english = self.english();
        let hover = p.c(Token::Accent);
        let picture = is_picture(&file.path);
        let remove = div()
            .id(SharedString::from(format!("attachment-remove-{index}")))
            .size(px(18.0))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded_full()
            .cursor_pointer()
            // Above the thumbnail's own hitbox, so the ✕ is the thing a click lands on.
            .when(picture, |d| d.absolute().top(px(-6.0)).right(px(-6.0)))
            .when(picture, |d| {
                d.bg(p.c(Token::Foreground))
                    .shadow_sm()
                    .border_1()
                    .border_color(p.c(Token::Background))
            })
            .when(!picture, |d| d.hover(move |d| d.bg(hover)))
            .tooltip(move |window, cx| {
                gpui_kit::component::tooltip::Tooltip::new(trs!(
                    english,
                    "composer.remove_attachment"
                ))
                .build(window, cx)
            })
            .child(icon(
                "cancel01",
                12.0,
                if picture {
                    p.c(Token::Background)
                } else {
                    p.c(Token::MutedForeground)
                },
            ))
            .on_click(cx.listener(move |this, _, _, cx| {
                if index < this.attached_files.len() {
                    this.attached_files.remove(index);
                }
                cx.notify();
            }));
        div()
            .relative()
            .flex_none()
            .child(attachment_chip(
                &file.path,
                &file.relative,
                SharedString::from(format!("attachment-{index}")),
                AttachmentAction::None,
                p,
                None,
            ))
            .child(remove)
    }

    /// The files a prompt brought along, drawn above it: a picture as its own thumbnail, any
    /// other file as a named chip.
    ///
    /// The prompt itself carries only the words the person wrote (`fv_core::strip_attachment_block`);
    /// this row is the only place the files are shown, in the composer and in the transcript
    /// alike, so a reloaded chat reads the same as the one that was just sent.
    pub(super) fn attachment_row(
        &self,
        files: &[String],
        key: &str,
        cx: &mut Context<Self>,
    ) -> Option<Div> {
        if files.is_empty() {
            return None;
        }
        let p = &self.palette;
        let mut row = div()
            .flex()
            .flex_wrap()
            .items_start()
            .justify_end()
            .gap(px(8.0))
            .mb(px(6.0));
        for (index, path) in files.iter().enumerate() {
            let name = path
                .rsplit('/')
                .next()
                .filter(|name| !name.is_empty())
                .unwrap_or(path)
                .to_string();
            row = row.child(attachment_chip(
                path,
                &name,
                SharedString::from(format!("file-{key}-{index}")),
                AttachmentAction::Open(path.clone()),
                p,
                Some(cx),
            ));
        }
        Some(row)
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
        let english = self.app_settings.language == fv_protocol::types::UiLanguage::English;
        // While the files for the current query are still being read, say so rather than showing
        // the previous query's rows: a list that answers a different question is worse than none.
        let ready = state.hits_query.as_deref() == Some(state.token.as_ref()?.query.as_str());
        let hover = p.c(Token::Muted).opacity(0.6);
        let mut rows = div().flex().flex_col();
        let note = |text: &'static str| {
            div()
                .px(px(12.0))
                .py(px(8.0))
                .text_size(px(crate::ui::TEXT_SM))
                .muted(p)
                .child(text)
        };
        if !ready {
            rows = rows.child(note(trs!(english, "file_mention.searching")));
        } else if state.hits.is_empty() {
            rows = rows.child(note(trs!(english, "file_mention.no_matching_files")));
        }
        for (index, hit) in state.hits.iter().enumerate() {
            let selected = index == state.index;
            let (dir, name) = match hit.relative.rsplit_once('/') {
                Some((dir, name)) => (format!("{dir}/"), name.to_string()),
                None => (String::new(), hit.relative.clone()),
            };
            // `dir/` muted, then the name: the directory is what tells two same-named files apart.
            let label = StyledText::new(format!("{dir}{name}")).with_highlights(
                [
                    (
                        0..dir.len(),
                        HighlightStyle {
                            color: Some(p.c(Token::MutedForeground)),
                            ..Default::default()
                        },
                    ),
                    (
                        dir.len()..dir.len() + name.len(),
                        HighlightStyle {
                            font_weight: Some(FontWeight::MEDIUM),
                            ..Default::default()
                        },
                    ),
                ]
                .into_iter()
                .filter(|(r, _)| !r.is_empty()),
            );
            rows = rows.child(
                div()
                    .id(SharedString::from(format!("mention-{index}")))
                    .px(px(12.0))
                    .py(px(8.0))
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .text_size(px(crate::ui::TEXT_SM))
                    .line_height(px(20.0))
                    .cursor_pointer()
                    .when(selected, |d| d.bg(p.c(Token::Muted)))
                    .when(!selected, |d| d.hover(move |d| d.bg(hover)))
                    .child(
                        img(crate::file_icons::path(&name, !p.is_dark()))
                            .size(px(16.0))
                            .flex_none(),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_ellipsis()
                            .child(label),
                    )
                    // Keep the composer's caret where the token is until the file is applied.
                    .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
                    .on_click(cx.listener(move |this, _, window, cx| {
                        if let Some(state) = &mut this.mention {
                            state.index = index;
                        }
                        this.accept_mention(window, cx);
                    })),
            );
        }
        Some(
            super::settings::popover(p)
                .p(px(0.0))
                .mb(px(8.0))
                .overflow_hidden()
                .child(
                    div()
                        .id("mention-list")
                        // `max-h-72`: the list scrolls rather than covering the conversation.
                        .max_h(px(288.0))
                        .overflow_y_scroll()
                        .child(rows),
                )
                .into_any_element(),
        )
    }
}
