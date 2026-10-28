//! The right pane: the Electron app's `side-pane.tsx`, `side-pane-files.tsx` and the file tree.
//!
//! One pane, several tabs, and the files tab is the one that exists so far. What the pane must get
//! right is not its content but its edges:
//!
//! - **A tab belongs to a conversation.** Switching chats does not carry another chat's open file
//!   into this one: a file the user was reading in chat A is not what chat B is about. So the tab
//!   set is per conversation, and the pane draws only the open chat's tabs.
//! - **The pane is a column, not an overlay.** It takes width from the conversation column and
//!   gives it back when collapsed, which is why the width is a setting rather than a constant.
//! - **A tree remembers where it was.** Expanded folders and the open file survive a collapse, a
//!   chat switch and a restart, so reopening the pane does not walk the user back down the tree.
//! - **The tree is lazy.** A directory is read when it is expanded, not when the pane opens: a
//!   repository root with 2000 entries would otherwise be 2000 rows nobody asked for.

use std::collections::{HashMap, HashSet};

use crate::ui::px;
use fv_protocol::methods::*;
use fv_protocol::types::*;
use fv_theme::Token;
use gpui_kit::component::input::{Editor, EditorState};
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::Workspace;
use crate::ui::{self, Muted as _, TEXT_SM, TEXT_XS, icon, icon_button, icon_button_xs};

#[path = "pane_entries.rs"]
pub(super) mod entries;
#[path = "pane_persistence.rs"]
mod persistence;

/// A tab id. The pane has no other identity to key a tab by — two files can share a name.
pub(super) fn new_tab_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    format!(
        "tab-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

/// The text the pane may write back, or `None` when saving it would replace the file with
/// something else.
///
/// A preview that extracted text from a document is not that document: writing the extraction back
/// would destroy it. So only the kinds whose text *is* the file are editable — code, a diff, a
/// Markdown file with a Markdown extension, and HTML.
fn editable_text(preview: &FilePreview) -> Option<String> {
    match preview {
        FilePreview::Text {
            kind, path, text, ..
        } => match kind {
            FilePreviewKind::Code | FilePreviewKind::Diff | FilePreviewKind::Html => {
                Some(text.clone())
            }
            // A `.md` written by a tool is the file; a `.docx` rendered to Markdown is not. The
            // extension is what tells them apart.
            FilePreviewKind::Markdown if markdown_extension(path) => Some(text.clone()),
            _ => None,
        },
        _ => None,
    }
}

/// Whether `editable_text` would return something, without copying the text.
fn is_editable(preview: &FilePreview) -> bool {
    match preview {
        FilePreview::Text { kind, path, .. } => match kind {
            FilePreviewKind::Code | FilePreviewKind::Diff | FilePreviewKind::Html => true,
            FilePreviewKind::Markdown => markdown_extension(path),
            _ => false,
        },
        _ => false,
    }
}

fn markdown_extension(path: &str) -> bool {
    let ext = std::path::Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    ext == "md" || ext == "markdown"
}

fn preview_path(preview: Option<&FilePreview>) -> Option<String> {
    match preview? {
        FilePreview::Text { path, .. }
        | FilePreview::Media { path, .. }
        | FilePreview::Office { path, .. }
        | FilePreview::Unsupported { path, .. }
        | FilePreview::Binary { path, .. }
        | FilePreview::Table { path, .. }
        | FilePreview::Error { path, .. } => Some(path.clone()),
    }
}

/// The rows of one directory level, in the tree's own spacing.
fn tree_body(rows: Vec<AnyElement>) -> Div {
    div().child(
        div()
            .flex()
            .flex_col()
            .gap(px(0.0))
            .py(px(6.0))
            .children(rows),
    )
}

/// The conversation column keeps at least this much width; the pane takes the rest, up to its own
/// remembered width.
/// Below this the tree and the preview swap instead of sitting side by side — the Electron
/// pane's `@min-[32rem]/files`, and the reason its default width shows one thing at a time.
const SIDE_BY_SIDE_MIN: f32 = 512.0;
/// Width required before offering two diff columns.
pub(super) const SPLIT_MIN_WIDTH: f32 = 640.0;

/// The narrowest the pane may be dragged. Below this the diff and the tree stop being readable.
pub const MIN_WIDTH: f32 = 280.0;
/// The narrowest a pane nobody has sized opens at.
pub const DEFAULT_WIDTH: f32 = 380.0;
/// A pane nobody has sized takes this share of the room right of the sidebar, so a web page or a
/// diff gets more of a wide window instead of the same 380px on every screen.
const AUTO_SHARE: f32 = 0.45;

/// The width of a pane the user has not dragged.
pub(super) fn auto_width(viewport: f32, sidebar: f32) -> f32 {
    ((viewport - sidebar).max(0.0) * AUTO_SHARE).max(DEFAULT_WIDTH)
}
/// The file list's column inside the pane, as the Electron pane keeps it.
const TREE_WIDTH: f32 = 224.0;
const TREE_MIN: f32 = 120.0;

/// One open tab; the same strip holds file views, Git and terminal sessions.
#[derive(Clone, Debug, PartialEq)]
pub struct PaneTab {
    pub id: String,
    pub kind: PaneTabKind,
    pub title: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PaneTabKind {
    /// A file the user opened from the tree, a chip or the resources list.
    Files {
        path: String,
    },
    /// A terminal in the conversation's working directory.
    Terminal,
    Browser {
        url: String,
    },
    /// 变更: git's two layers, one file's patch, and the commit box.
    Git,
}

/// The pane's state for one conversation.
pub struct PaneState {
    pub tabs: Vec<PaneTab>,
    pub active: Option<String>,
    /// Directories whose children have been read, by absolute path.
    pub listings: HashMap<String, Vec<DirEntry>>,
    loading: HashSet<String>,
    listing_epoch: u64,
    pub expanded: HashSet<String>,
    /// The file the preview is showing, if any.
    pub preview: Option<FilePreview>,
    pub show_preview: bool,
    restoring: bool,
    preview_loading: Option<(String, u64)>,
    preview_epoch: u64,
    /// Text the editor holds, once it has been edited (absent until then, so the file's own bytes
    /// are what a save would write back).
    pub draft: Option<String>,
    /// A failure the pane says in its own words — a save that did not land, a directory that
    /// could not be read.
    pub notice: Option<String>,
    /// Whether the preview is showing the source rather than the rendered view. A Markdown file
    /// opens rendered (it is a document), code opens as source (it is not).
    pub editing: bool,
    /// The file's text as it was read, which is what "unchanged" means for the dirty mark.
    pub baseline: Option<String>,
    /// The editor for the open file. Rebuilt when the file changes, because a text area holds its
    /// own value and the pane must not push a different file's text into it.
    /// The code editor for the open file. `EditorState`, not `TextareaState`: languages, line
    /// numbers, folding, indent guides and the LSP hooks exist on that kind only.
    pub editor: Option<Entity<EditorState>>,
    /// The directory being dragged over, for the splitter.
    pub tree_width: f32,
    /// The open Markdown file's text as a `SharedString`, keyed by path and length. `TextView`
    /// recognises unchanged text by allocation, so it must be the same one every frame.
    markdown_source: Option<(String, usize, SharedString)>,
    saved_files: HashMap<String, FileViewState>,
}

impl Default for PaneState {
    fn default() -> Self {
        Self {
            tabs: Vec::new(),
            active: None,
            listings: HashMap::new(),
            loading: HashSet::new(),
            listing_epoch: 0,
            expanded: HashSet::new(),
            preview: None,
            show_preview: false,
            restoring: false,
            preview_loading: None,
            preview_epoch: 0,
            draft: None,
            notice: None,
            editing: false,
            baseline: None,
            editor: None,
            tree_width: TREE_WIDTH,
            markdown_source: None,
            saved_files: HashMap::new(),
        }
    }
}

#[derive(Default)]
struct FileViewState {
    preview: Option<FilePreview>,
    show_preview: bool,
    restoring: bool,
    draft: Option<String>,
    editing: bool,
    baseline: Option<String>,
    editor: Option<Entity<EditorState>>,
}

impl PaneState {
    pub(super) fn activate(&mut self, id: String) {
        if self.active.as_ref() == Some(&id) {
            return;
        }
        if let Some(old) = self.active.take() {
            self.saved_files.insert(
                old,
                FileViewState {
                    preview: self.preview.take(),
                    show_preview: self.show_preview,
                    restoring: self.restoring,
                    draft: self.draft.take(),
                    editing: self.editing,
                    baseline: self.baseline.take(),
                    editor: self.editor.take(),
                },
            );
        }
        let next = self.saved_files.remove(&id).unwrap_or_default();
        self.preview = next.preview;
        self.show_preview = next.show_preview;
        self.restoring = next.restoring;
        self.preview_epoch = self.preview_epoch.wrapping_add(1);
        self.preview_loading = None;
        self.draft = next.draft;
        self.editing = next.editing;
        self.baseline = next.baseline;
        self.editor = next.editor;
        self.active = Some(id);
    }

    pub fn active_tab(&self) -> Option<&PaneTab> {
        let id = self.active.as_ref()?;
        self.tabs.iter().find(|t| &t.id == id)
    }
}

impl Workspace {
    /// Dev only: open the `@` menu over a draft, for the capture fixture.
    ///
    /// The hits come from the same ranking the server runs, over this checkout's real files: a
    /// fixture with invented file names would be a picture of a menu nobody can get.
    pub fn open_mention_for_fixture(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(draft) = self.pending_fixture_draft.take() else {
            return;
        };
        self.input
            .update(cx, |state, cx| state.set_value(draft.clone(), window, cx));
        let Some(root) = self
            .selected
            .as_ref()
            .and_then(|id| self.project_root_for(id))
        else {
            return;
        };
        let token = super::file_mention::mention_at_caret(&draft, draft.len());
        let Some(token) = token else {
            return;
        };
        let hits = crate::workspace::search_files_fixture(&root, &token.query);
        self.mention = Some(super::file_mention::MentionState {
            token: Some(token.clone()),
            hits,
            index: 1,
            hits_query: Some(token.query),
        });
        cx.notify();
    }

    /// Dev only: exercise the shell's real empty/maximised/collapsed states for visual QA.
    pub fn show_panel_fixture(&mut self, mode: &str, cx: &mut Context<Self>) {
        self.side_pane_collapsed = mode == "panels-collapsed";
        self.side_pane_maximized = mode == "pane-maximized";
        if mode == "panels-collapsed" || mode == "pane-maximized" {
            self.app_settings.sidebar.collapsed = true;
        }
        cx.notify();
    }

    /// Dev only: open the pane on the conversation's directory, for the capture fixture.
    pub fn open_pane_for_fixture(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(conversation) = self.selected.clone() else {
            return;
        };
        let Some(root) = self.project_root_for(&conversation) else {
            return;
        };
        self.side_pane_collapsed = false;
        let english = self.app_settings.language == UiLanguage::English;
        let state = self.panes.entry(conversation.clone()).or_default();
        state.tabs.push(PaneTab {
            id: new_tab_id(),
            kind: PaneTabKind::Files { path: root.clone() },
            title: trs!(english, "pane.files").into(),
        });
        state.active = state.tabs.first().map(|t| t.id.clone());
        state.expanded.insert(root.clone());
        // The fixture has no server, so the tree is read from disk directly: the pane's drawing
        // is what is being looked at, not the call that fills it.
        if let Ok(listed) = crate::workspace::read_dir_fixture(&root) {
            state.listings.insert(root.clone(), listed);
        }
        for entry in ["crates", "src", "docs"] {
            let dir = format!("{root}/{entry}");
            if let Ok(listed) = crate::workspace::read_dir_fixture(&dir) {
                state.expanded.insert(dir.clone());
                state.listings.insert(dir, listed);
            }
        }
        // The fixture shows the source view: the editor, the toggle and the dirty dot are what
        // the capture is for, and a rendered-only screenshot would show none of them.
        // `FV_FIXTURE_FILE=none` leaves the tree on its own (Electron's `?pane=files`); any other
        // value is a path under the project to preview instead of the manifest.
        let file = std::env::var("FV_FIXTURE_FILE").unwrap_or_else(|_| "native/Cargo.toml".into());
        if file == "none" {
            return;
        }
        let preview = crate::workspace::preview_fixture(&format!("{root}/{file}"));
        self.adopt_preview(&conversation, preview, window, cx);
        if let Some(state) = self.panes.get_mut(&conversation)
            && file == "native/Cargo.toml"
        {
            state.editing = true;
        }
    }

    /// The animated outer column clips a fixed-width frame, just like Electron's panel-frame.
    pub(super) fn side_pane(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let visible = self.pane_motion.width;
        if visible <= 0.0 {
            return None;
        }
        let conversation = self.selected.clone().unwrap_or_else(|| "__draft__".into());
        self.ensure_restored_pane(&conversation, window, cx);
        let p = self.palette.clone();
        let against_sidebar = self.side_pane_maximized && !self.app_settings.sidebar.collapsed;
        let width = self.pane_content_width + if against_sidebar { 8.0 } else { 16.0 };
        let root = self.project_root_for(&conversation);
        let state = self.panes.entry(conversation.clone()).or_default();
        let tabs = state.tabs.clone();
        let active = state.active.clone();
        let has_tabs = !tabs.is_empty();
        let mut strip = div()
            .id("pane-tabs-viewport")
            .flex()
            .items_center()
            .gap(px(4.0))
            .h(px(28.0))
            .min_w_0()
            .max_w_full()
            .overflow_x_scroll();
        for tab in &tabs {
            let selected = active.as_deref() == Some(tab.id.as_str());
            let id = tab.id.clone();
            let close_id = id.clone();
            let middle_id = id.clone();
            let menu_id = id.clone();
            let glyph = match tab.kind {
                PaneTabKind::Files { .. } => "folder01",
                PaneTabKind::Git => "git-compare",
                PaneTabKind::Terminal => "terminal",
                PaneTabKind::Browser { .. } => "chrome",
            };
            strip = strip.child(
                div()
                    .id(SharedString::from(format!("pane-tab-{id}")))
                    .h(px(28.0))
                    .min_w(px(60.0))
                    .max_w(px(160.0))
                    .flex_none()
                    .px(px(6.0))
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .rounded(px(8.0))
                    .text_size(px(TEXT_XS))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(p.c(if selected {
                        Token::Foreground
                    } else {
                        Token::MutedForeground
                    }))
                    .when(selected, |d| d.bg(p.c(Token::Muted)))
                    .hover(|d| d.bg(p.c(Token::Muted)))
                    .cursor_pointer()
                    .child(match &tab.kind {
                        PaneTabKind::Files { path }
                            if !path.is_empty() && root.as_deref() != Some(path.as_str()) =>
                        {
                            img(crate::file_icons::path(
                                path.rsplit('/').next().unwrap_or(path),
                                !p.is_dark(),
                            ))
                            .size(px(14.0))
                            .flex_none()
                            .into_any_element()
                        }
                        _ => icon(
                            glyph,
                            14.0,
                            p.c(if selected {
                                Token::Foreground
                            } else {
                                Token::MutedForeground
                            }),
                        )
                        .into_any_element(),
                    })
                    .child(ui::truncate(tab.title.clone()).flex_1())
                    .child(
                        div()
                            .id(SharedString::from(format!("pane-close-{close_id}")))
                            .size(px(16.0))
                            .flex_none()
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(4.0))
                            .hover(|d| d.bg(p.c(Token::Background)))
                            .child(icon("cancel01", 12.0, p.c(Token::MutedForeground)))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                cx.stop_propagation();
                                this.close_pane_tab(&close_id, window, cx);
                            })),
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.activate_pane_tab(&id, window, cx)
                    }))
                    .on_mouse_down(
                        MouseButton::Middle,
                        cx.listener(move |this, _, window, cx| {
                            window.prevent_default();
                            cx.stop_propagation();
                            this.close_pane_tab(&middle_id, window, cx);
                        }),
                    )
                    .on_mouse_down(
                        MouseButton::Right,
                        cx.listener(move |this, event: &MouseDownEvent, _, cx| {
                            this.close_menus(cx);
                            this.pane_menu = Some((event.position, Some(menu_id.clone())));
                            cx.stop_propagation();
                            cx.notify();
                        }),
                    ),
            );
        }
        let active_tab = self
            .panes
            .get(&conversation)
            .and_then(|s| s.active_tab())
            .cloned();
        let body = match active_tab.as_ref() {
            Some(PaneTab {
                id,
                kind: PaneTabKind::Browser { url },
                ..
            }) => self.browser_body(id, url, window, cx),
            Some(PaneTab {
                kind: PaneTabKind::Files { .. },
                ..
            }) => self.files_body(&conversation, window, cx),
            Some(PaneTab {
                kind: PaneTabKind::Git,
                ..
            }) => self.git_body(window, cx),
            Some(PaneTab {
                id,
                kind: PaneTabKind::Terminal,
                ..
            }) => {
                let id = id.clone();
                // The pty has to be told the grid the reader is looking at, and this is the only
                // place both the tab and the pane's real size exist.
                self.terminal_body(&id, window, cx)
            }
            None => self.pane_launcher(cx).into_any_element(),
        };
        let lead = self.side_pane_maximized && self.app_settings.sidebar.collapsed;
        let english = self.app_settings.language == UiLanguage::English;
        let header = div()
            .h(px(44.0))
            .flex_none()
            .px(px(8.0))
            .flex()
            .items_center()
            .gap(px(4.0))
            .when(has_tabs, |d| {
                d.border_b_1().border_color(p.c(Token::Border))
            })
            .when(lead && cfg!(target_os = "macos"), |d| d.pl(px(88.0)))
            .when(lead, |d| {
                d.child(
                    icon_button("pane-expand-sidebar", "panel-left-open", &p)
                        .aria_label(trs!(english, "pane.expand_sidebar"))
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.on_toggle_sidebar(&super::ToggleSidebar, window, cx)
                        })),
                )
                .child(
                    icon_button("pane-new-chat", "message-square-plus", &p)
                        .aria_label(trs!(english, "pane.new_chat"))
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.on_new_chat(&super::NewChat, window, cx)
                        })),
                )
            })
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .gap(px(4.0))
                    .when(has_tabs, |d| {
                        d.child(strip).child(
                            icon_button_xs("pane-add-tab", "add01", &p)
                                .border_1()
                                .border_color(p.c(Token::Border))
                                .aria_label(trs!(english, "pane.add_panel"))
                                .tooltip(move |window, cx| {
                                    Tooltip::new(trs!(english, "pane.add_panel")).build(window, cx)
                                })
                                .on_click(cx.listener(|this, e: &ClickEvent, _, cx| {
                                    let at = e.position();
                                    this.close_menus(cx);
                                    this.pane_menu = Some((at, None));
                                    cx.notify();
                                })),
                        )
                    }),
            )
            .child(
                icon_button(
                    "pane-maximize",
                    if self.side_pane_maximized {
                        "arrow-shrink01"
                    } else {
                        "full-screen"
                    },
                    &p,
                )
                .aria_label(if self.side_pane_maximized {
                    trs!(english, "pane.restore_side_panel")
                } else {
                    trs!(english, "pane.maximize_side_panel")
                })
                .on_click(cx.listener(|this, _, _, cx| {
                    this.side_pane_maximized = !this.side_pane_maximized;
                    cx.notify();
                })),
            )
            .child(
                icon_button("pane-collapse", "panel-right-close", &p)
                    .aria_label(trs!(english, "pane.collapse_side_panel"))
                    .tooltip(move |window, cx| {
                        Tooltip::new(trs!(english, "pane.collapse_side_panel_b")).build(window, cx)
                    })
                    .on_click(cx.listener(|this, _, _, cx| this.toggle_side_pane(cx))),
            );
        let frame = div()
            .w(px(width))
            .h_full()
            .flex_none()
            .p(px(8.0))
            .when(against_sidebar, |d| d.pl(px(0.0)))
            .child(
                div()
                    .id("side-pane-frame")
                    .relative()
                    .size_full()
                    .rounded(px(16.0))
                    .bg(p.pane())
                    .overflow_hidden()
                    .flex()
                    .flex_col()
                    .child(header)
                    .child(div().flex_1().min_h_0().child(body))
                    .child(ui::glass_surface(16.0, &p))
                    .child(
                        div()
                            .absolute()
                            .inset_0()
                            .rounded(px(16.0))
                            .border_1()
                            .border_color(p.c(Token::SidebarBorder)),
                    ),
            );
        Some(
            div()
                .id("side-pane")
                .relative()
                .w(px(visible))
                .flex_none()
                .h_full()
                .overflow_hidden()
                .child(frame)
                .when(
                    !self.side_pane_collapsed && !self.side_pane_maximized,
                    |d| {
                        d.child(
                            div()
                                .id("pane-resizer")
                                .group("pane-resizer")
                                .child(ui::panel_grip(
                                    "pane-resizer",
                                    self.side_pane_resize.is_some(),
                                    &p,
                                ))
                                .absolute()
                                .left(px(4.0))
                                .top(px(24.0))
                                .bottom(px(24.0))
                                .w(px(8.0))
                                .cursor_col_resize()
                                .role(Role::Splitter)
                                .aria_label("调整侧边面板宽度")
                                .on_mouse_down(
                                    MouseButton::Left,
                                    cx.listener(|this, event: &MouseDownEvent, window, cx| {
                                        this.pane_drag_offset =
                                            f32::from(window.viewport_size().width)
                                                - f32::from(event.position.x)
                                                - this.pane_motion.width;
                                        this.side_pane_resize = Some(this.pane_motion.width);
                                        window.prevent_default();
                                        cx.stop_propagation();
                                        cx.notify();
                                    }),
                                )
                                .on_click(cx.listener(|this, e: &ClickEvent, _, cx| {
                                    if super::sidebar_actions::is_width_reset(e) {
                                        this.side_pane_width = None;
                                        cx.notify();
                                    }
                                })),
                        )
                    },
                )
                .into_any_element(),
        )
    }

    fn pane_launcher(&self, cx: &mut Context<Self>) -> Stateful<Div> {
        let p = &self.palette;
        let wide = self.pane_content_width >= 480.0;
        let available = (self.pane_content_width - 40.0).max(0.0);
        let content_width = available.min(if wide { 544.0 } else { 320.0 });
        let columns = if wide {
            ((content_width + 8.0) / 152.0).floor().max(1.0) as usize
        } else {
            1
        };
        let card_width = (content_width - (columns - 1) as f32 * 8.0) / columns as f32;
        let mut cards = div().w_full().flex().flex_wrap().gap(px(8.0));
        for (key, glyph, label) in self.pane_catalog() {
            cards =
                cards.child(
                    div()
                        .id(SharedString::from(format!("pane-open-{key}")))
                        .w(px(card_width))
                        .h(px(if wide { 88.0 } else { 48.0 }))
                        .flex_none()
                        .px(px(12.0))
                        .flex()
                        .items_center()
                        .gap(px(if wide { 6.0 } else { 12.0 }))
                        .rounded(px(12.0))
                        .bg(p.c(Token::Muted))
                        .hover(|d| d.bg(p.c(Token::Accent)))
                        .text_size(px(TEXT_SM))
                        .font_weight(FontWeight::MEDIUM)
                        .cursor_pointer()
                        .when(wide, |d| d.flex_col().justify_center())
                        .child(icon(glyph, 16.0, p.c(Token::MutedForeground)))
                        .child(ui::truncate(label))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.open_pane_kind(key, window, cx)
                        })),
                );
        }
        let notice = self
            .panes
            .get(self.selected.as_deref().unwrap_or("__draft__"))
            .and_then(|s| s.notice.clone());
        div()
            .id("pane-launcher")
            .size_full()
            .overflow_y_scroll()
            .flex()
            .items_center()
            .justify_center()
            .px(px(20.0))
            .py(px(40.0))
            .child(
                div()
                    .w(px(content_width))
                    .flex_none()
                    .flex()
                    .flex_col()
                    .gap(px(20.0))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .items_center()
                            .gap(px(8.0))
                            .child(
                                div()
                                    .text_size(px(20.0))
                                    .line_height(px(28.0))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(if self.app_settings.language == UiLanguage::English {
                                        "Open a panel"
                                    } else {
                                        "打开标签页"
                                    }),
                            )
                            .child(
                                div()
                                    .text_size(px(TEXT_SM))
                                    .line_height(px(20.0))
                                    .text_color(p.c(Token::MutedForeground))
                                    .child(if self.app_settings.language == UiLanguage::English {
                                        "Choose a panel to open in the sidebar."
                                    } else {
                                        "选择要在侧边面板中打开的标签。"
                                    }),
                            ),
                    )
                    .child(cards)
                    .children(notice.map(|notice| {
                        div()
                            .text_size(px(TEXT_XS))
                            .text_color(p.c(Token::MutedForeground))
                            .child(SharedString::from(notice))
                    })),
            )
    }

    fn pane_catalog(&self) -> Vec<(&'static str, &'static str, String)> {
        let english = self.app_settings.language == UiLanguage::English;
        let mut items = Vec::new();
        if self.selected.is_some() {
            items.push((
                "chat",
                "message-square",
                trs!(english, "pane.auxiliary_chat").into(),
            ));
        }
        items.push(("files", "folder01", trs!(english, "pane.files").into()));
        if !self
            .panes
            .get(self.selected.as_deref().unwrap_or("__draft__"))
            .is_some_and(|s| s.tabs.iter().any(|t| t.kind == PaneTabKind::Git))
        {
            items.push(("git", "git-compare", trs!(english, "pane.changes").into()));
        }
        items.push((
            "terminal",
            "terminal",
            trs!(english, "pane.terminal").into(),
        ));
        items.push(("browser", "chrome", trs!(english, "pane.browser").into()));
        items
    }

    fn open_pane_kind(&mut self, kind: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.pane_menu = None;
        let english = self.app_settings.language == UiLanguage::English;
        match kind {
            "chat" => {
                self.open_auxiliary_chat(cx);
            }
            "git" => self.open_git_tab(window, cx),
            "terminal" => self.open_terminal_tab(cx),
            "browser" => {
                let owner = self.selected.clone().unwrap_or_else(|| "__draft__".into());
                self.open_browser_tab(&owner, "about:blank", cx);
            }
            "files" => {
                let conversation = self.selected.clone().unwrap_or_else(|| "__draft__".into());
                let path = self.project_root_for(&conversation).unwrap_or_default();
                let state = self.panes.entry(conversation).or_default();
                state.expanded.insert(path.clone());
                let id = new_tab_id();
                state.tabs.push(PaneTab {
                    id: id.clone(),
                    kind: PaneTabKind::Files { path },
                    title: trs!(english, "pane.files").into(),
                });
                state.activate(id);
            }
            _ => {
                let state = self
                    .panes
                    .entry(self.selected.clone().unwrap_or_else(|| "__draft__".into()))
                    .or_default();
                state.notice = Some(format!(
                    "{}{}",
                    match kind {
                        "chat" => trs!(english, "pane.auxiliary_chat"),
                        "browser" => trs!(english, "pane.browser"),
                        _ => trs!(english, "pane.terminal"),
                    },
                    trs!(english, "pane.is_being_ported")
                ));
            }
        }
        cx.notify();
    }

    fn activate_pane_tab(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.cancel_terminal_compositions(cx);
        let conversation = self.selected.clone().unwrap_or_else(|| "__draft__".into());
        let Some(state) = self.panes.get_mut(&conversation) else {
            return;
        };
        state.activate(id.to_string());
        let path = if state.preview.is_none() && state.show_preview {
            match state.active_tab() {
                Some(PaneTab {
                    kind: PaneTabKind::Files { path },
                    ..
                }) => Some(path.clone()),
                _ => None,
            }
        } else {
            None
        };
        if let Some(path) = path {
            let is_root = self.project_root_for(&conversation).as_deref() == Some(&path);
            if !path.is_empty() && !is_root {
                self.load_preview(path, window, cx);
            }
        }
        cx.notify();
    }

    fn close_pane_tab(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let conversation = self.selected.clone().unwrap_or_else(|| "__draft__".into());
        self.close_office(id, cx);
        self.web_views.remove(id);
        self.web_views.remove(&super::pane_web::preview_key(id));
        if let Some(view) = self.terminals.remove(id)
            && let (Some(session), Some(backend)) = (view.session, self.backend.clone())
        {
            cx.spawn(async move |_, _| {
                let _ = backend
                    .call::<TerminalKill>(TerminalIdParams { id: session.id })
                    .await;
            })
            .detach();
        }
        let next = if let Some(state) = self.panes.get_mut(&conversation) {
            let index = state.tabs.iter().position(|t| t.id == id).unwrap_or(0);
            state.tabs.retain(|t| t.id != id);
            state.saved_files.remove(id);
            if state.active.as_deref() == Some(id) {
                state.active = None;
                state.preview = None;
                state.show_preview = false;
                state.preview_epoch = state.preview_epoch.wrapping_add(1);
                state.preview_loading = None;
                state.editor = None;
                state.baseline = None;
                state.draft = None;
                state
                    .tabs
                    .get(index.min(state.tabs.len().saturating_sub(1)))
                    .map(|t| t.id.clone())
            } else {
                None
            }
        } else {
            None
        };
        if let Some(next) = next {
            self.activate_pane_tab(&next, window, cx);
        }
        cx.notify();
    }

    pub(super) fn pane_menu_view(
        &self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let (at, tab) = self.pane_menu.clone()?;
        let at = super::sidebar_actions::popup_origin(at, 176.0, 180.0, window);
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let mut menu = super::settings::popover(p)
            .absolute()
            .left(at.x)
            .top(at.y)
            .w(px(176.0));
        if let Some(id) = tab {
            for (index, label) in [
                trs!(english, "pane.close_tab"),
                trs!(english, "pane.close_other_tabs"),
                trs!(english, "pane.close_all_tabs"),
            ]
            .into_iter()
            .enumerate()
            {
                let id = id.clone();
                menu = menu.child(
                    super::settings::menu_item(
                        SharedString::from(format!("pane-menu-{index}")),
                        false,
                        p.c(Token::Accent),
                    )
                    .child(label)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.close_menus(cx);
                        if index == 0 {
                            this.close_pane_tab(&id, window, cx);
                        } else {
                            let key = this.selected.as_deref().unwrap_or("__draft__");
                            let ids = this
                                .panes
                                .get(key)
                                .map(|s| {
                                    s.tabs
                                        .iter()
                                        .filter(|t| index == 2 || t.id != id)
                                        .map(|t| t.id.clone())
                                        .collect::<Vec<_>>()
                                })
                                .unwrap_or_default();
                            for id in ids {
                                this.close_pane_tab(&id, window, cx);
                            }
                        }
                    })),
                );
            }
        } else {
            for (key, glyph, label) in self.pane_catalog() {
                menu =
                    menu.child(
                        super::settings::menu_item(
                            SharedString::from(format!("pane-add-{key}")),
                            false,
                            p.c(Token::Accent),
                        )
                        .child(icon(glyph, 16.0, p.c(Token::MutedForeground)))
                        .child(label)
                        .on_click(cx.listener(
                            move |this, _, window, cx| this.open_pane_kind(key, window, cx),
                        )),
                    );
            }
        }
        Some(ui::float(menu).into_any_element())
    }

    pub(super) fn finish_pane_resize(&mut self, cx: &mut Context<Self>) {
        if let Some(width) = self.side_pane_resize.take() {
            self.side_pane_collapsed = width < MIN_WIDTH / 2.0;
            if !self.side_pane_collapsed {
                self.side_pane_width = Some(width.max(MIN_WIDTH));
            }
            cx.notify();
        }
        if self.pane_tree_resize.take().is_some() {
            cx.notify();
        }
    }

    pub(super) fn move_pane_splitter(
        &mut self,
        e: &MouseMoveEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(start) = self.pane_tree_resize else {
            return;
        };
        if e.pressed_button != Some(MouseButton::Left) {
            self.finish_pane_resize(cx);
            return;
        }
        let width =
            (f32::from(e.position.x) - start).clamp(TREE_MIN, self.pane_content_width * 0.75);
        if let Some(key) = self.selected.as_ref() {
            if self
                .panes
                .get(key)
                .and_then(|s| s.active_tab())
                .is_some_and(|t| t.kind == PaneTabKind::Git)
            {
                if let Some(state) = self.git_views.get_mut(key) {
                    state.tree_width = width;
                }
            } else if let Some(state) = self.panes.get_mut(key) {
                state.tree_width = width;
            }
        }
        window.refresh();
        cx.notify();
    }

    fn pane_empty(&self) -> impl IntoElement {
        div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .px(px(32.0))
            .text_size(px(TEXT_XS))
            .text_color(self.palette.c(Token::MutedForeground))
            .child(if self.app_settings.language == UiLanguage::English {
                "Select a file"
            } else {
                "选择一个文件"
            })
    }

    fn pane_placeholder(&self, what: &str) -> impl IntoElement {
        let p = &self.palette;
        div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .muted(p)
            .text_size(px(TEXT_SM))
            .child(SharedString::from(what.to_string()))
    }

    /// Open a file in the pane, creating its tab if this conversation does not have one.
    pub(super) fn open_in_pane(
        &mut self,
        path: String,
        title: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(conversation) = self.selected.clone() else {
            return;
        };
        self.side_pane_collapsed = false;
        let state = self.panes.entry(conversation.clone()).or_default();
        // One tab per file: opening the same path twice focuses the tab that is already there
        // rather than stacking two views of one file.
        if let Some(existing) = state
            .tabs
            .iter()
            .find(|t| matches!(&t.kind, PaneTabKind::Files { path: p } if p == &path))
        {
            let id = existing.id.clone();
            state.activate(id);
        } else {
            let id = new_tab_id();
            state.tabs.push(PaneTab {
                id: id.clone(),
                kind: PaneTabKind::Files { path: path.clone() },
                title,
            });
            state.activate(id);
        }
        state.show_preview = true;
        if state.preview.is_none() {
            self.load_preview(path, window, cx);
        }
        cx.notify();
    }

    /// Take a freshly read file into the pane: remember what "unchanged" means, build the editor,
    /// and choose the view the way the Electron pane does.
    ///
    /// **Code and diffs open on their source; Markdown and HTML open rendered.** A document is
    /// meant to be read, a source file is meant to be edited, and the toggle in the header is
    /// there for the other case.
    fn adopt_preview(
        &mut self,
        conversation: &str,
        preview: FilePreview,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // The text may have changed without changing length.
        if let Some(state) = self.panes.get_mut(conversation) {
            state.markdown_source = None;
        }
        let baseline = editable_text(&preview);
        let editing = match &preview {
            FilePreview::Text { kind, .. } => {
                matches!(kind, FilePreviewKind::Code | FilePreviewKind::Diff)
            }
            _ => false,
        };
        let text = baseline.clone().unwrap_or_default();
        // The highlighter's name for the language, from the preview the server produced — it is
        // the same name the transcript's code blocks use, so one file looks the same in both.
        let language = match &preview {
            FilePreview::Text { language, .. } => language.clone(),
            _ => None,
        };
        let editor = baseline
            .as_ref()
            .map(|_| self.make_file_editor(text, language, window, cx));
        if let Some(state) = self.panes.get_mut(conversation) {
            state.preview = Some(preview);
            state.show_preview = true;
            state.preview_loading = None;
            state.baseline = baseline;
            state.editing = if state.restoring {
                state.editing
            } else {
                editing
            };
            state.restoring = false;
            state.editor = editor;
            state.draft = None;
            state.notice = None;
        }
    }

    /// Write the editor's text back to the file.
    pub(super) fn save_preview(&mut self, cx: &mut Context<Self>) {
        let Some(conversation) = self.selected.clone() else {
            return;
        };
        let Some(state) = self.panes.get(&conversation) else {
            return;
        };
        if !state.show_preview {
            return;
        }
        let (Some(path), Some(editor)) =
            (preview_path(state.preview.as_ref()), state.editor.clone())
        else {
            return;
        };
        let Some(b) = self.backend.clone() else {
            return;
        };
        let text = editor.read(cx).value().to_string();
        let tab = state.active.clone();
        cx.spawn(async move |this, cx| {
            let result = b
                .call::<WorkspaceWriteFile>(WriteFileParams {
                    path: path.clone(),
                    text: text.clone(),
                    cwd: None,
                })
                .await;
            this.update(cx, |this, cx| {
                let english = this.english();
                if let Some(state) = this.panes.get_mut(&conversation) {
                    match result {
                        Ok(_) => {
                            // A save can finish after a tab switch, rename, delete or reload.
                            // Only the exact view whose bytes were sent gains this baseline.
                            if state.active == tab
                                && preview_path(state.preview.as_ref()).as_deref()
                                    == Some(path.as_str())
                                && state.editor.as_ref().is_some_and(|current| {
                                    current.entity_id() == editor.entity_id()
                                })
                            {
                                state.baseline = Some(text.clone());
                                if let Some(FilePreview::Text { text: content, .. }) =
                                    &mut state.preview
                                {
                                    *content = text;
                                }
                            } else if let Some(saved) =
                                tab.as_ref().and_then(|id| state.saved_files.get_mut(id))
                                && preview_path(saved.preview.as_ref()).as_deref()
                                    == Some(path.as_str())
                                && saved.editor.as_ref().is_some_and(|current| {
                                    current.entity_id() == editor.entity_id()
                                })
                            {
                                saved.baseline = Some(text.clone());
                                if let Some(FilePreview::Text { text: content, .. }) =
                                    &mut saved.preview
                                {
                                    *content = text;
                                }
                            }
                            state.notice = None;
                        }
                        Err(e) => {
                            state.notice = Some(tr!(
                                english,
                                "pane.could_not_save_path_e",
                                path = path,
                                e = e
                            ))
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Read one file for the preview.
    pub(super) fn load_preview(
        &mut self,
        path: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        let Some(conversation) = self.selected.clone() else {
            return;
        };
        let Some(state) = self.panes.get_mut(&conversation) else {
            return;
        };
        if state
            .preview_loading
            .as_ref()
            .is_some_and(|(pending, _)| pending == &path)
        {
            return;
        }
        state.preview_epoch = state.preview_epoch.wrapping_add(1);
        let epoch = state.preview_epoch;
        let tab = state.active.clone();
        state.preview_loading = Some((path.clone(), epoch));
        let window_handle = window.window_handle();
        // The entity itself: applying the reply needs a `Context<Self>` (building the editor is a
        // child entity), and `update_window` only hands `&mut App`.
        let handle = cx.entity().downgrade();
        cx.spawn(async move |_, cx| {
            let result = b
                .call::<WorkspacePreview>(PreviewParams {
                    path: path.clone(),
                    cwd: None,
                })
                .await;
            let _ = cx.update_window(window_handle, |_, window, cx| {
                let _ = handle.update(cx, |this, cx| {
                    // The conversation may have changed while the file was being read; a preview
                    // must land in the chat that asked for it, or not at all.
                    let current = this.panes.get(&conversation).is_some_and(|state| {
                        state.active == tab && state.preview_epoch == epoch && state.show_preview
                            && state.active_tab().is_some_and(|tab| matches!(&tab.kind, PaneTabKind::Files { path: current } if current == &path))
                    });
                    if !current {
                        if let Some(state) = this.panes.get_mut(&conversation)
                            && state.preview_loading.as_ref().is_some_and(|(_, pending_epoch)| *pending_epoch == epoch)
                        { state.preview_loading = None; }
                        return;
                    }
                    if this.selected.as_ref() != Some(&conversation) {
                        if let Some(state) = this.panes.get_mut(&conversation) { state.preview_loading = None; }
                        return;
                    }
                    let preview = match result {
                        Ok(preview) => preview,
                        Err(e) => FilePreview::Error {
                            path: path.clone(),
                            name: String::new(),
                            message: tr!(this.english(), "pane.could_not_read_this_file", e = e),
                            reason: PreviewFailure::Unknown,
                            detail: None,
                            directory: None,
                        },
                    };
                    this.adopt_preview(&conversation, preview, window, cx);
                    cx.notify();
                });
            });
        })
        .detach();
    }

    /// Read a directory's children into the tree.
    pub(super) fn load_dir(&mut self, path: String, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        let Some(conversation) = self.selected.clone() else {
            return;
        };
        let Some(state) = self.panes.get_mut(&conversation) else {
            return;
        };
        if state.listings.contains_key(&path) || !state.loading.insert(path.clone()) {
            return;
        }
        let epoch = state.listing_epoch;
        cx.spawn(async move |this, cx| {
            let result = b
                .call::<WorkspaceReadDir>(ReadDirParams {
                    path: path.clone(),
                    cwd: None,
                })
                .await;
            this.update(cx, |this, cx| {
                let english = this.english();
                if let Some(state) = this.panes.get_mut(&conversation) {
                    if state.listing_epoch != epoch {
                        return;
                    }
                    state.loading.remove(&path);
                    match result {
                        Ok(listed) => {
                            state.listings.insert(path.clone(), listed.entries);
                        }
                        Err(e) => {
                            state.notice =
                                Some(tr!(english, "pane.could_not_read_this_folder", e = e))
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}

/// The files tab: the tree on the left, the preview on the right, and a splitter between them.
impl Workspace {
    fn files_body(
        &mut self,
        conversation: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        // A click on a tree row has no `Window`, so it parks the request; this is where one
        // exists. One frame later is indistinguishable from immediate to the reader.
        if let Some((path, title)) = self.pending_open.take() {
            self.open_in_pane(path, title, window, cx);
        }
        let p = self.palette.clone();
        let Some(root) = self.project_root_for(conversation) else {
            return self
                .pane_placeholder(if self.app_settings.language == UiLanguage::English {
                    "This chat has no working directory"
                } else {
                    "这个对话没有工作目录"
                })
                .into_any_element();
        };
        let roots = self.project_roots_for(conversation);
        // The root is read on first draw; every child directory is read when it is expanded.
        let needs_root = self
            .panes
            .get(conversation)
            .is_some_and(|s| !s.listings.contains_key(&root));
        if needs_root {
            self.load_dir(root.clone(), cx);
        }
        let mut directories = roots.clone();
        if let Some(state) = self.panes.get(conversation) {
            directories.extend(state.expanded.iter().cloned());
        }
        for path in directories {
            self.load_dir(path, cx);
        }
        let (entries, tree_width, notice, preview, markdown) = {
            let state = self.panes.entry(conversation.to_string()).or_default();
            // Markdown is drawn from a cached `SharedString`, so the preview handed to the body
            // carries no copy of the text: cloning a large file every frame is what a scroll paid.
            let markdown = if state.show_preview
                && let Some(FilePreview::Text {
                    kind: FilePreviewKind::Markdown,
                    path,
                    text,
                    ..
                }) = &state.preview
            {
                match &state.markdown_source {
                    Some((p, len, source)) if p == path && *len == text.len() => {
                        Some(source.clone())
                    }
                    _ => {
                        let source = SharedString::from(text.clone());
                        state.markdown_source = Some((path.clone(), text.len(), source.clone()));
                        Some(source)
                    }
                }
            } else {
                None
            };
            let preview = state.show_preview.then(|| match &state.preview {
                Some(FilePreview::Text {
                    kind: FilePreviewKind::Markdown,
                    path,
                    name,
                    language,
                    ..
                }) => Some(FilePreview::Text {
                    kind: FilePreviewKind::Markdown,
                    path: path.clone(),
                    name: name.clone(),
                    language: language.clone(),
                    text: String::new(),
                }),
                other => other.clone(),
            });
            (
                state.listings.get(&root).cloned().unwrap_or_default(),
                // While the splitter is held, the dragged width wins: the stored one is where it
                // started, and writing every move to the store would be a write per frame.
                state
                    .tree_width
                    .clamp(TREE_MIN, (0.75 * self.pane_content_width).max(TREE_MIN)),
                state.notice.clone(),
                preview.flatten(),
                markdown,
            )
        };
        // A pane narrower than 32rem swaps the two instead of squeezing them: at 380px a
        // side-by-side tree and preview leaves the file about 150px wide, which is not a preview.
        // This is the Electron pane's own rule (`@min-[32rem]/files`), and the default width is
        // below it — so the tree is what the pane shows until the user widens it.
        let side_by_side = self.side_pane_width_side_by_side();
        let showing_file = preview.is_some() && !side_by_side;
        let editing = self.panes.get(conversation).is_some_and(|s| s.editing);
        let is_markdown_text = markdown.is_some();
        let intrinsic_scroll = matches!(
            &preview,
            Some(FilePreview::Media { .. } | FilePreview::Office { .. })
        ) || matches!(
            &preview,
            Some(FilePreview::Text {
                kind: FilePreviewKind::Html,
                ..
            })
        ) || (editing && preview.as_ref().is_some_and(is_editable))
            || (!editing && is_markdown_text);
        let preview_body = self.preview_body(preview, markdown, cx);

        // The rows are elements, so the two branches below can each put them in their own scroll
        // container. A `Div` is not cloneable; a `Vec<AnyElement>` is the shared part.
        let root_open = self
            .panes
            .get(conversation)
            .is_some_and(|s| s.expanded.contains(&root));
        let root_name = std::path::Path::new(&root)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| root.clone());
        // One folder: the tree starts at its children — the project directory is not a row.
        // Several: each folder is a card (`chat-tree-card`) with its own disclosure, the first
        // one marked 主, and its rows inside it.
        let mut tree_rows: Vec<AnyElement> = Vec::new();
        if roots.len() <= 1 {
            for entry in entries.iter() {
                tree_rows.extend(self.tree_row(entry, &root, 0, false, cx));
            }
        } else {
            for (index, folder) in roots.iter().enumerate() {
                let open = if index == 0 {
                    root_open
                } else {
                    self.panes
                        .get(conversation)
                        .is_some_and(|s| s.expanded.contains(folder))
                };
                let label = if index == 0 {
                    root_name.clone()
                } else {
                    std::path::Path::new(folder)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string()
                };
                let (toggle, context) = (folder.clone(), folder.clone());
                let tooltip = folder.clone();
                let mut card = div()
                    .mx(px(4.0))
                    .mt(px(if index == 0 { 0.0 } else { 4.0 }))
                    .child(
                        div()
                            .id(SharedString::from(format!("pane-root-{folder}")))
                            .h(px(32.0))
                            .px(px(8.0))
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .rounded(px(8.0))
                            .bg(p.c(Token::Muted).opacity(0.6))
                            .text_size(px(TEXT_SM))
                            .font_weight(FontWeight::MEDIUM)
                            .cursor_pointer()
                            .hover(|d| d.bg(p.c(Token::Muted)))
                            .tooltip(move |window, cx| {
                                gpui_kit::component::tooltip::Tooltip::new(tooltip.clone())
                                    .build(window, cx)
                            })
                            .child(ui::chevron(open, 12.0, p.c(Token::MutedForeground)))
                            .child(
                                img(crate::file_icons::folder_path(&label, open, !p.is_dark()))
                                    .size(px(16.0))
                                    .flex_none(),
                            )
                            .child(ui::truncate(label).flex_1())
                            .when(index == 0, |d| {
                                d.child(
                                    div()
                                        .flex_none()
                                        .text_size(px(TEXT_XS))
                                        .font_weight(FontWeight::NORMAL)
                                        .muted(&p)
                                        .child(
                                            if self.app_settings.language == UiLanguage::English {
                                                "Primary"
                                            } else {
                                                "主"
                                            },
                                        ),
                                )
                            })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.toggle_dir(toggle.clone(), cx)
                            }))
                            .on_mouse_down(
                                MouseButton::Right,
                                cx.listener(move |this, event: &MouseDownEvent, _, cx| {
                                    cx.stop_propagation();
                                    this.open_entry_menu(
                                        entries::EntryMenu {
                                            at: event.position,
                                            root: context.clone(),
                                            path: context.clone(),
                                            kind: EntryKind::Directory,
                                            is_root: true,
                                        },
                                        cx,
                                    );
                                }),
                            ),
                    );
                if open {
                    let listed: Vec<DirEntry> = if index == 0 {
                        entries.clone()
                    } else {
                        self.panes
                            .get(conversation)
                            .and_then(|s| s.listings.get(folder))
                            .cloned()
                            .unwrap_or_default()
                    };
                    for entry in listed.iter() {
                        card = card.children(self.tree_row(entry, folder, 1, true, cx));
                    }
                }
                tree_rows.push(card.into_any_element());
            }
        }
        // Three cases, and only one of them can own the tree: `Div` is not cloneable, so the
        // branches are built from what they need rather than from a shared half-built column.
        let columns = if side_by_side {
            div()
                .flex_1()
                .min_h_0()
                .flex()
                .child(
                    div()
                        .relative()
                        .w(px(tree_width))
                        .flex_none()
                        .h_full()
                        .child(
                            div()
                                .id("pane-tree")
                                .size_full()
                                .overflow_y_scroll()
                                .border_r_1()
                                .border_color(p.c(Token::SidebarBorder))
                                .child(tree_body(tree_rows)),
                        )
                        .child(self.tree_splitter(cx)),
                )
                .child(
                    div()
                        .id("pane-preview")
                        .flex_1()
                        .min_w_0()
                        .h_full()
                        .when(!intrinsic_scroll, |d| d.overflow_y_scroll())
                        .child(preview_body),
                )
        } else if showing_file {
            // Narrow: the file takes the pane, and 返回 in its header goes back to the tree.
            // Nothing is squeezed into a column too small to read.
            // No scroll container of its own: the editor scrolls itself, and a scroll box
            // measures its children by their content — an editor inside one collapses to its
            // minimum height instead of filling the pane.
            div().flex_1().min_h_0().flex().flex_col().child(
                div()
                    .id("pane-preview")
                    .flex_1()
                    .min_w_0()
                    .min_h_0()
                    .when(!intrinsic_scroll, |d| d.overflow_y_scroll())
                    .child(preview_body),
            )
        } else {
            div().flex_1().min_h_0().flex().child(
                div()
                    .id("pane-tree")
                    .size_full()
                    .overflow_y_scroll()
                    .child(tree_body(tree_rows)),
            )
        };

        div()
            .size_full()
            .flex()
            .flex_col()
            .child(columns)
            .children(notice.map(|notice| {
                div()
                    .px(px(10.0))
                    .py(px(6.0))
                    .text_size(px(TEXT_XS))
                    .text_color(p.c(Token::Warning))
                    .border_t_1()
                    .border_color(p.c(Token::SidebarBorder))
                    .child(SharedString::from(notice))
            }))
            .into_any_element()
    }

    /// One tree row and, when it is an expanded directory, its children (`chat-tree-row`): no
    /// chevron, a 14px icon, and one indent guide per level drawn through the parent's icon.
    ///
    /// `card` is a row inside a multi-folder card, whose first indent slot is wider so the
    /// children sit under the card's own (larger, chevron-pushed) folder icon.
    fn tree_row(
        &self,
        entry: &DirEntry,
        root: &str,
        depth: usize,
        card: bool,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let p = &self.palette;
        let hover = p.c(Token::Foreground).opacity(0.075);
        let Some(conversation) = self.selected.clone() else {
            return Vec::new();
        };
        let state = self.panes.get(&conversation);
        let expanded = state.is_some_and(|s| s.expanded.contains(&entry.path));
        let open = state
            .and_then(|s| s.active_tab())
            .is_some_and(|t| matches!(&t.kind, PaneTabKind::Files { path } if path == &entry.path));
        let is_dir = entry.kind == EntryKind::Directory;
        let path = entry.path.clone();
        let name = entry.name.clone();
        let (context_path, context_root, context_kind) =
            (entry.path.clone(), root.to_string(), entry.kind);
        // `--tree-indent` 0.75rem, `--tree-gap` 0.375rem, `--tree-icon` 0.875rem: the guide sits
        // `indent - gap - icon / 2` before its slot's trailing edge, i.e. 1px past it.
        let mut guides = div().h_full().flex_none().flex().ml(px(-2.0));
        for level in 0..depth {
            let width = if level == 0 && card { 18.0 } else { 12.0 };
            guides = guides.child(
                div().relative().w(px(width)).h_full().child(
                    div()
                        .absolute()
                        .top_0()
                        .bottom_0()
                        .right(px(-1.0))
                        .w(px(1.0))
                        .bg(p.c(Token::Foreground).opacity(0.12)),
                ),
            );
        }
        let row = div()
            .id(SharedString::from(format!("tree-{}", entry.path)))
            .h(px(24.0))
            .w_full()
            .px(px(8.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .text_size(px(TEXT_XS))
            .cursor_pointer()
            .when(open, |d| d.bg(p.c(Token::Foreground).opacity(0.1)))
            .hover(move |d| d.bg(hover))
            .child(guides)
            .child(if is_dir {
                img(crate::file_icons::folder_path(
                    &name,
                    expanded,
                    !p.is_dark(),
                ))
                .size(px(14.0))
                .flex_none()
                .into_any_element()
            } else {
                img(crate::file_icons::path(&name, !p.is_dark()))
                    .size(px(14.0))
                    .flex_none()
                    .into_any_element()
            })
            .child(ui::truncate(name.clone()).flex_1())
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(move |this, event: &MouseDownEvent, _, cx| {
                    cx.stop_propagation();
                    this.open_entry_menu(
                        entries::EntryMenu {
                            at: event.position,
                            root: context_root.clone(),
                            path: context_path.clone(),
                            kind: context_kind,
                            is_root: false,
                        },
                        cx,
                    );
                }),
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                if is_dir {
                    this.toggle_dir(path.clone(), cx);
                } else {
                    // A click handler has no `Window`, and opening a file needs one (the editor
                    // is a child entity). The request is parked and the next render performs it,
                    // which is one frame later and indistinguishable to the reader.
                    this.pending_open = Some((path.clone(), name.clone()));
                    cx.notify();
                }
            }));
        let mut rows = vec![row.into_any_element()];
        if is_dir && expanded {
            let children = self
                .panes
                .get(&conversation)
                .and_then(|s| s.listings.get(&entry.path))
                .cloned()
                .unwrap_or_default();
            for child in children {
                rows.extend(self.tree_row(&child, root, depth + 1, card, cx));
            }
        }
        rows
    }

    fn toggle_dir(&mut self, path: String, cx: &mut Context<Self>) {
        let Some(conversation) = self.selected.clone() else {
            return;
        };
        let (now_expanded, known) = {
            let Some(state) = self.panes.get_mut(&conversation) else {
                return;
            };
            let now_expanded = if state.expanded.contains(&path) {
                state.expanded.remove(&path);
                false
            } else {
                state.expanded.insert(path.clone());
                true
            };
            (now_expanded, state.listings.contains_key(&path))
        };
        if now_expanded && !known {
            self.load_dir(path, cx);
        }
        cx.notify();
    }

    /// The handle that resizes the tree's column. It sits on the tree's edge, not between the two
    /// columns: a column 2px wider than its content would show a gap.
    fn tree_splitter(&self, cx: &mut Context<Self>) -> Stateful<Div> {
        div()
            .id("pane-tree-splitter")
            .absolute()
            .right_0()
            .top_0()
            .bottom_0()
            .w(px(8.0))
            .cursor_col_resize()
            .role(Role::Splitter)
            .aria_label(trs!(self.english(), "pane.resize_file_tree"))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, cx| {
                    // The stored width is the drag's starting point; from here the pointer decides.
                    let width = this
                        .selected
                        .as_ref()
                        .and_then(|id| this.panes.get(id))
                        .map(|s| s.tree_width)
                        .unwrap_or(TREE_WIDTH);
                    this.pane_tree_resize = Some(f32::from(window.mouse_position().x) - width);
                    window.prevent_default();
                    cx.stop_propagation();
                    cx.notify();
                }),
            )
    }

    /// The conversation's working directory, which is what the tree is rooted at.
    pub(super) fn project_root_for(&self, conversation: &str) -> Option<String> {
        self.views
            .get(conversation)
            .and_then(|v| v.thread.cwd.clone())
            .or_else(|| {
                self.threads
                    .iter()
                    .find(|t| t.id == conversation)
                    .and_then(|t| t.cwd.clone())
            })
    }

    pub(super) fn project_roots_for(&self, conversation: &str) -> Vec<String> {
        let Some(primary) = self.project_root_for(conversation) else {
            return Vec::new();
        };
        let thread = self
            .views
            .get(conversation)
            .map(|v| &v.thread)
            .or_else(|| self.threads.iter().find(|t| t.id == conversation));
        let project = thread
            .and_then(|thread| thread.project.as_ref())
            .and_then(|path| self.projects.iter().find(|project| &project.path == path));
        let mut roots = vec![primary];
        if let Some(project) = project {
            for folder in &project.folders {
                if !roots.contains(folder) {
                    roots.push(folder.clone());
                }
            }
        }
        roots
    }

    /// What the pane draws for a file: each kind has its own view, and a failure says what to do.
    /// Whether the pane is wide enough for the tree and the file side by side.
    fn side_pane_width_side_by_side(&self) -> bool {
        self.pane_content_width >= SIDE_BY_SIDE_MIN
    }

    fn preview_body(
        &mut self,
        preview: Option<FilePreview>,
        markdown: Option<SharedString>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = self.palette.clone();
        // In the narrow layout the preview owns the pane, so its header carries 返回.
        let back = !self.side_pane_width_side_by_side();
        let Some(preview) = preview else {
            return self.pane_empty().into_any_element();
        };
        match preview {
            FilePreview::Text {
                kind,
                path,
                name,
                text,
                ..
            } => {
                // Code and diffs open on their source; Markdown and HTML open rendered. A
                // document is meant to be read, a source file is meant to be edited, and the
                // toggle in the header is there for the other case.
                let editable = is_editable(&FilePreview::Text {
                    kind,
                    path: path.clone(),
                    name: name.clone(),
                    language: None,
                    text: String::new(),
                });
                let editing = self
                    .selected
                    .as_ref()
                    .and_then(|id| self.panes.get(id))
                    .is_some_and(|s| s.editing);
                let editor = self
                    .selected
                    .as_ref()
                    .and_then(|id| self.panes.get(id))
                    .and_then(|s| s.editor.clone());
                let dirty = self.selected.as_ref().is_some_and(|id| {
                    self.panes.get(id).is_some_and(|s| {
                        s.editor.as_ref().is_some_and(|e| {
                            s.baseline.as_deref() != Some(e.read(cx).value().as_ref())
                        })
                    })
                });

                let shows_editor = editing && editable && editor.is_some();
                let body: AnyElement = match (editing && editable, editor) {
                    (true, Some(editor)) => {
                        // The editor draws its own gutter, so the pane adds none: one number per
                        // line of the file, laid out with the text it belongs to and scrolled
                        // with it.
                        // The editor fills the pane rather than sizing itself to its rows: an
                        // `Input` asks for its row count, and a 500-line file would then be a
                        // 500-row element inside a scroll container — the scroll belongs to the
                        // editor, so the file scrolls with its gutter.
                        div()
                            .id("pane-editor")
                            .size_full()
                            .text_size(px(TEXT_SM))
                            .font_family(crate::assets::MONO_FONT)
                            .child(
                                Editor::new(&editor)
                                    .bordered(false)
                                    .rounded(px(0.0))
                                    .h(relative(1.0)),
                            )
                            .into_any_element()
                    }
                    _ if kind == FilePreviewKind::Html => {
                        self.document_body(&path, Some(&text), None, None, cx)
                    }
                    _ if kind == FilePreviewKind::Markdown => {
                        // Virtualised: the view lays out and paints only the blocks on screen and
                        // owns the scroll, instead of laying out the whole file every frame.
                        let source = markdown.clone().unwrap_or_default();
                        div()
                            .size_full()
                            .px(px(14.0))
                            .py(px(10.0))
                            .text_size(px(TEXT_SM))
                            .line_height(px(24.0))
                            .child(
                                crate::markdown::view(
                                    SharedString::from(format!("pane-md-{path}")),
                                    source,
                                    &p,
                                )
                                .scrollable(true),
                            )
                            .into_any_element()
                    }
                    _ => self.code_view(&text).into_any_element(),
                };
                let toggle = editable.then(|| {
                    let next = !editing;
                    icon_button_xs(
                        "pane-source-toggle",
                        if editing { "view" } else { "source-code" },
                        &p,
                    )
                    .aria_label(if editing { "预览" } else { "查看源码" })
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(conversation) = this.selected.clone()
                            && let Some(state) = this.panes.get_mut(&conversation)
                        {
                            state.editing = next;
                            cx.notify();
                        }
                    }))
                });
                // `h_full` on the column, and `flex_1` on the body: an editor fills its parent, so
                // a column that sizes itself to its content leaves the editor two rows tall.
                // The column takes the preview box's height, and the body takes what the header
                // leaves. `min_h_0` on the body is what lets it shrink instead of pushing the
                // column taller — without it a 500-line editor makes the pane as tall as the file.
                //
                // And the body is what scrolls, for everything that is not itself a scrollable
                // box. A scroll container measures its *direct* children's boxes, and this column
                // is `h_full` — so the pane's own `overflow_y_scroll` sees a child exactly as tall
                // as the pane and finds nothing to scroll, while the Markdown or source text inside
                // it is clipped by the body with no scroll of its own: the file simply ended at the
                // bottom edge and the rest was unreachable. The header stays outside the scroll
                // (the git pane's list is the same `flex_1` + `min_h_0` + `overflow_y_scroll`), and
                // the two bodies that own their scroll — the editor, and a document drawn by a
                // webview — must not be put inside a second one, which would measure them by their
                // content and collapse them.
                let body_owns_scroll = shows_editor
                    || kind == FilePreviewKind::Html
                    || (kind == FilePreviewKind::Markdown && !shows_editor);
                div()
                    .h_full()
                    .w_full()
                    .flex()
                    .flex_col()
                    .child(self.preview_head_with(&name, back, dirty, toggle, cx))
                    .child(preview_body_box(body_owns_scroll).child(body))
                    .into_any_element()
            }
            FilePreview::Table {
                name,
                rows,
                truncated,
                total_rows,
                ..
            } => {
                let mut table = div().flex().flex_col().text_size(px(TEXT_SM));
                for (index, row) in rows.iter().enumerate() {
                    let mut line = div()
                        .flex()
                        .gap(px(12.0))
                        .px(px(12.0))
                        .py(px(3.0))
                        .when(index == 0, |d| {
                            d.bg(p.c(Token::Muted)).font_weight(FontWeight::MEDIUM)
                        })
                        .when(index % 2 == 1 && index > 0, |d| {
                            d.bg(p.c(Token::Muted).opacity(0.4))
                        });
                    for cell in row {
                        line = line.child(
                            div()
                                .w(px(140.0))
                                .flex_none()
                                .min_w_0()
                                .overflow_hidden()
                                .text_ellipsis()
                                .whitespace_nowrap()
                                .child(SharedString::from(cell.clone())),
                        );
                    }
                    table = table.child(line);
                }
                div()
                    .flex()
                    .flex_col()
                    .child(self.preview_head(&name, back, cx))
                    .child(table)
                    .children(truncated.then(|| {
                        div()
                            .px(px(12.0))
                            .py(px(6.0))
                            .text_size(px(TEXT_XS))
                            .muted(&p)
                            .child(SharedString::from(
                                if self.app_settings.language == UiLanguage::English {
                                    format!("Showing first {} of {total_rows} rows", rows.len())
                                } else {
                                    format!("只显示前 {} 行，共 {total_rows} 行", rows.len())
                                },
                            ))
                    }))
                    .into_any_element()
            }
            FilePreview::Media {
                path,
                name,
                mime_type,
                ..
            } => {
                let body = self.document_body(&path, None, Some(&mime_type), None, cx);
                let refresh = icon_button_xs("refresh-media-preview", "refresh", &p)
                    .aria_label(if self.app_settings.language == UiLanguage::English {
                        "Refresh preview"
                    } else {
                        "刷新预览"
                    })
                    .on_click(cx.listener(move |this, _, window, cx| {
                        if let Some(tab) = this
                            .selected
                            .as_ref()
                            .and_then(|id| this.panes.get(id))
                            .and_then(|p| p.active.as_ref())
                        {
                            this.web_views.remove(&super::pane_web::preview_key(tab));
                        }
                        this.load_preview(path.clone(), window, cx);
                    }));
                div()
                    .size_full()
                    .flex()
                    .flex_col()
                    .child(self.preview_head_with(&name, back, false, Some(refresh), cx))
                    .child(div().flex_1().min_h_0().child(body))
                    .into_any_element()
            }
            FilePreview::Office {
                path, name, format, ..
            } => self.office_body(&path, &name, format, back, cx),
            FilePreview::Binary { name, size, .. } => div()
                .flex()
                .flex_col()
                .child(self.preview_head(&name, back, cx))
                .child(div().p(px(12.0)).muted(&p).text_size(px(TEXT_SM)).child(
                    SharedString::from(if self.app_settings.language == UiLanguage::English {
                        format!(
                            "Binary file cannot be previewed ({})",
                            super::format_bytes(size)
                        )
                    } else {
                        format!("这是二进制文件，无法预览（{}）", super::format_bytes(size))
                    }),
                ))
                .into_any_element(),
            FilePreview::Unsupported {
                path, name, format, ..
            } => div()
                .flex()
                .flex_col()
                .child(self.preview_head(&name, back, cx))
                .child(div().p(px(12.0)).muted(&p).text_size(px(TEXT_SM)).child(
                    SharedString::from(if self.app_settings.language == UiLanguage::English {
                        format!("{format} cannot be previewed")
                    } else {
                        format!("{format} 无法预览")
                    }),
                ))
                .children(url::Url::from_file_path(&path).ok().map(|url| {
                    div()
                        .id("unsupported-open-external")
                        .px(px(12.))
                        .text_size(px(TEXT_SM))
                        .cursor_pointer()
                        .child(if self.app_settings.language == UiLanguage::English {
                            "Open with system app"
                        } else {
                            "用系统应用打开"
                        })
                        .on_click(move |_, _, cx| cx.open_url(url.as_str()))
                }))
                .into_any_element(),
            FilePreview::Error {
                path,
                name,
                message,
                reason,
                detail,
                directory,
            } => {
                // `PreviewFailure` in Electron's `preview-panel.tsx`: a conclusion, one line on
                // what it means, the path, and the ways out that still make sense.
                let english = self.app_settings.language == UiLanguage::English;
                let (glyph, title, hint) = match (reason, english) {
                    (PreviewFailure::Missing, false) => (
                        "file-not-found",
                        "文件不存在",
                        Some("这个路径下没有文件，它可能已被移动、重命名或删除。"),
                    ),
                    (PreviewFailure::Missing, true) => (
                        "file-not-found",
                        "File not found",
                        Some(
                            "Nothing is at this path — it may have been moved, renamed or deleted.",
                        ),
                    ),
                    (PreviewFailure::Permission, false) => (
                        "lock",
                        "没有读取权限",
                        Some("文件可能属于其他用户，或被系统保护。"),
                    ),
                    (PreviewFailure::Permission, true) => (
                        "lock",
                        "No read permission",
                        Some("The file belongs to another user or is protected by the system."),
                    ),
                    (PreviewFailure::NotAFile, false) => (
                        "folder01",
                        "这是一个文件夹",
                        Some("它是一个目录，选择一个文件才能预览。"),
                    ),
                    (PreviewFailure::NotAFile, true) => (
                        "folder01",
                        "This is a folder",
                        Some("That path is a directory. Pick a file inside it to preview."),
                    ),
                    (PreviewFailure::Unknown, false) => ("alert-circle", "无法预览这个文件", None),
                    (PreviewFailure::Unknown, true) => {
                        ("alert-circle", "Can't preview this file", None)
                    }
                };
                let unknown = reason == PreviewFailure::Unknown;
                let folder = directory.clone().or_else(|| {
                    std::path::Path::new(&path)
                        .parent()
                        .map(|d| d.display().to_string())
                });
                let local = !path.starts_with("remote:");
                let button =
                    |id: &'static str, glyph: &'static str, label: &'static str, outline: bool| {
                        div()
                            .id(id)
                            .h(px(24.0))
                            .px(px(8.0))
                            .flex()
                            .items_center()
                            .gap(px(4.0))
                            .rounded(px(6.0))
                            .when(outline, |d| {
                                d.border_1()
                                    .border_color(p.c(Token::Border))
                                    .bg(p.c(Token::Background))
                            })
                            .text_size(px(TEXT_XS))
                            .font_weight(FontWeight::MEDIUM)
                            .cursor_pointer()
                            .hover(|d| d.bg(p.c(Token::Muted)))
                            .child(icon(glyph, 14.0, p.c(Token::Foreground)))
                            .child(label)
                    };
                let retry_path = path.clone();
                let copy_path = path.clone();
                let body = div()
                    .min_h(px(160.0))
                    .flex()
                    .flex_col()
                    .items_start()
                    .justify_center()
                    .gap(px(12.0))
                    .px(px(16.0))
                    .py(px(24.0))
                    .child(
                        div()
                            .w_full()
                            .min_w_0()
                            .flex()
                            .items_start()
                            .gap(px(12.0))
                            .child(
                                div()
                                    .size(px(36.0))
                                    .flex_none()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded(px(8.0))
                                    .bg(p.c(Token::Muted))
                                    .child(icon(glyph, 20.0, p.c(Token::MutedForeground))),
                            )
                            .child(
                                div()
                                    .min_w_0()
                                    .flex_1()
                                    .child(
                                        div()
                                            .text_size(px(TEXT_SM))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(p.c(Token::Foreground))
                                            .child(title),
                                    )
                                    .child(
                                        div()
                                            .mt(px(2.0))
                                            .text_size(px(TEXT_XS))
                                            .line_height(px(20.0))
                                            .muted(&p)
                                            .child(SharedString::from(
                                                hint.map(str::to_string).unwrap_or(message),
                                            )),
                                    ),
                            ),
                    )
                    .when(!path.is_empty(), |d| {
                        d.child(
                            div()
                                .max_w_full()
                                .px(px(8.0))
                                .py(px(4.0))
                                .rounded(px(6.0))
                                .bg(p.c(Token::Muted).opacity(0.6))
                                .font_family(crate::assets::MONO_FONT)
                                .text_size(px(TEXT_XS))
                                .muted(&p)
                                .child(SharedString::from(path.clone())),
                        )
                    })
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .gap(px(8.0))
                            .child(
                                button(
                                    "preview-retry",
                                    "refresh",
                                    if english { "Retry" } else { "重试" },
                                    true,
                                )
                                .on_click(cx.listener(
                                    move |this, _, window, cx| {
                                        this.load_preview(retry_path.clone(), window, cx);
                                    },
                                )),
                            )
                            .children(folder.filter(|_| local).map(|folder| {
                                button(
                                    "preview-open-folder",
                                    "folder-open",
                                    if english {
                                        "Open containing folder"
                                    } else {
                                        "打开所在文件夹"
                                    },
                                    true,
                                )
                                .on_click(move |_, _, cx| {
                                    cx.reveal_path(std::path::Path::new(&folder));
                                })
                            }))
                            .when(!path.is_empty(), |d| {
                                d.child(
                                    button(
                                        "preview-copy-path",
                                        "copy01",
                                        if english {
                                            "Copy full path"
                                        } else {
                                            "复制完整路径"
                                        },
                                        false,
                                    )
                                    .on_click(
                                        move |_, _, cx| {
                                            cx.write_to_clipboard(
                                                gpui_kit::ClipboardItem::new_string(
                                                    copy_path.clone(),
                                                ),
                                            );
                                        },
                                    ),
                                )
                            }),
                    )
                    .children(detail.filter(|_| unknown).map(|detail| {
                        div()
                            .max_w(px(448.0))
                            .text_size(px(TEXT_XS))
                            .text_color(p.c(Token::MutedForeground).opacity(0.7))
                            .child(SharedString::from(detail))
                    }));
                div()
                    .size_full()
                    .flex()
                    .flex_col()
                    .child(self.preview_head(&name, back, cx))
                    .child(body)
                    .into_any_element()
            }
        }
    }

    /// The strip above a preview. In the narrow layout it also carries 返回, because the file has
    /// taken the whole pane and the tree is otherwise unreachable.
    /// The strip above a preview, with the file's own controls at its end.
    fn preview_head_with(
        &self,
        name: &str,
        back: bool,
        dirty: bool,
        toggle: Option<Stateful<Div>>,
        cx: &mut Context<Self>,
    ) -> Div {
        let p = &self.palette;
        self.preview_head(name, back, cx)
            // An unsaved edit is a dot, not a word: the header already says where the file is, and
            // a label would push the path out of the row.
            .children(dirty.then(|| {
                div()
                    .size(px(6.0))
                    .flex_none()
                    .rounded_full()
                    .bg(p.c(Token::Warning))
            }))
            .children(toggle)
    }

    pub(super) fn preview_head(&self, name: &str, back: bool, cx: &mut Context<Self>) -> Div {
        let p = &self.palette;
        div()
            .h(px(40.0))
            .flex_none()
            .px(px(8.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .border_b_1()
            .border_color(p.c(Token::SidebarBorder))
            .text_size(px(TEXT_XS))
            .muted(p)
            .children(back.then(|| {
                icon_button_xs("pane-back-to-tree", "arrow-left01", p).on_click(cx.listener(
                    |this, _, _, cx| {
                        // Closing the preview is going back to the tree; the tab stays.
                        if let Some(conversation) = this.selected.clone()
                            && let Some(state) = this.panes.get_mut(&conversation)
                        {
                            state.show_preview = false;
                            state.preview_epoch = state.preview_epoch.wrapping_add(1);
                            state.preview_loading = None;
                            cx.notify();
                        }
                    },
                ))
            }))
            .child(self.preview_crumbs(name))
    }

    /// The open file's path as `FileBreadcrumb` draws it: one segment per folder under the project
    /// (a folder glyph, muted), `/` between them, and the file last with its own icon. Folders
    /// give up width first; the file's name is the last thing to shrink.
    fn preview_crumbs(&self, name: &str) -> Div {
        let p = &self.palette;
        let path = self
            .selected
            .as_ref()
            .and_then(|id| self.panes.get(id))
            .and_then(|s| preview_path(s.preview.as_ref()))
            .unwrap_or_else(|| name.to_string());
        let root = self
            .selected
            .as_ref()
            .and_then(|id| self.project_root_for(id))
            .unwrap_or_default();
        let relative = if !root.is_empty() {
            path.strip_prefix(&format!("{}/", root.trim_end_matches('/')))
                .unwrap_or(&path)
        } else {
            &path
        };
        let parts: Vec<&str> = relative
            .split('/')
            .filter(|part| !part.is_empty())
            .collect();
        let mut crumbs = div()
            .flex_1()
            .min_w_0()
            .flex()
            .items_center()
            .overflow_hidden()
            .whitespace_nowrap()
            .text_size(px(TEXT_XS));
        for (index, part) in parts.iter().enumerate() {
            let file = index + 1 == parts.len();
            if index > 0 {
                crumbs = crumbs.child(
                    div()
                        .flex_none()
                        .text_color(p.c(Token::MutedForeground))
                        .child("/"),
                );
            }
            crumbs = crumbs.child(
                div()
                    .min_w(px(if file { 48.0 } else { 20.0 }))
                    .flex_shrink(if file { 1.0 } else { 2.0 })
                    .flex()
                    .items_center()
                    .gap(px(4.0))
                    .overflow_hidden()
                    .rounded(px(3.0))
                    .px(px(3.0))
                    .text_color(if file {
                        p.c(Token::Foreground)
                    } else {
                        p.c(Token::MutedForeground)
                    })
                    .child(if file {
                        img(crate::file_icons::path(part, !p.is_dark()))
                            .size(px(14.0))
                            .flex_none()
                            .into_any_element()
                    } else {
                        icon("folder01", 14.0, p.c(Token::MutedForeground)).into_any_element()
                    })
                    .child(
                        div()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_ellipsis()
                            .child(SharedString::from(part.to_string())),
                    ),
            );
        }
        crumbs
    }

    /// Monospace text with its line numbers. The highlighter comes later; the shape of the view
    /// (a gutter that does not scroll away) is what the pane needs first.
    fn code_view(&self, text: &str) -> Div {
        let p = &self.palette;
        let mut lines = div().flex().flex_col().py(px(6.0));
        for (index, line) in text.lines().take(4000).enumerate() {
            lines = lines.child(
                div()
                    .flex()
                    .gap(px(10.0))
                    .px(px(10.0))
                    .child(
                        div()
                            .w(px(34.0))
                            .flex_none()
                            .text_color(p.c(Token::MutedForeground).opacity(0.6))
                            .child(SharedString::from((index + 1).to_string())),
                    )
                    // Wrapped, not cut: a preview that shows eight characters of every line is
                    // not a preview. Default text wraps, and `min_w_0` is what lets it.
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(SharedString::from(line.to_string())),
                    ),
            );
        }
        div()
            .text_size(px(TEXT_SM))
            .line_height(px(20.0))
            .font_family(crate::assets::MONO_FONT)
            .child(lines)
    }
}

/// The box a file preview's body sits in: what the header leaves, and — unless the body is
/// itself a scrollable box — the thing that scrolls.
///
/// A GPUI scroll container measures its *direct* children's boxes, not what spills out of them.
/// The preview's column is `h_full` (see `preview_body`), so the pane's own scroll container sees
/// a child exactly as tall as itself and finds nothing to scroll; a Markdown file longer than the
/// pane was then simply cut off at the bottom edge, with no way to reach the rest. Putting the
/// scroll on this box — `flex_1` + `min_h_0`, so it has a definite height, over a body that sizes
/// itself to the file — is what makes it scroll, and it is the same three lines the git pane's
/// file list uses. The header stays outside it, so the path keeps its place.
///
/// `owns_scroll` is for the two bodies that fill the pane and scroll themselves: the editor (an
/// `Input` that asks for its row count) and a document drawn by a webview. Wrapping either in a
/// second scroll box would measure it by its content and collapse it.
pub(crate) fn preview_body_box(owns_scroll: bool) -> Stateful<Div> {
    div()
        .id("pane-preview-body")
        .flex_1()
        .min_h_0()
        .w_full()
        .when(!owns_scroll, |d| d.overflow_y_scroll())
}

#[cfg(test)]
mod width_tests {
    use super::{DEFAULT_WIDTH, auto_width};

    #[test]
    fn an_unsized_pane_grows_with_the_window_but_never_below_the_old_default() {
        assert_eq!(auto_width(1100.0, 300.0), DEFAULT_WIDTH);
        assert_eq!(auto_width(1900.0, 300.0), 720.0);
        assert!(auto_width(2560.0, 300.0) > auto_width(1900.0, 300.0));
        assert_eq!(auto_width(200.0, 300.0), DEFAULT_WIDTH);
    }
}

#[cfg(test)]
mod preview_scroll_tests {
    use super::preview_body_box;
    // Explicit imports, never `use gpui_kit::*`: the Kit's glob re-exports GPUI's `test` macro
    // too, and the `#[test]` that macro generates would then expand itself forever.
    use gpui_kit::gpui;
    use gpui_kit::prelude::FluentBuilder as _;
    use gpui_kit::{
        AppContext, Context, InteractiveElement, IntoElement, Modifiers, ParentElement,
        PlatformInput, Render, ScrollDelta, ScrollHandle, ScrollWheelEvent,
        StatefulInteractiveElement, Styled, TestAppContext, TouchPhase, Window, div, point, px,
    };

    /// The pane's preview column, reduced to the boxes that decide whether a file can be read to
    /// its end: a fixed-height scroll container, an `h_full` column, a 40px header, and the body
    /// under test with a 1200px document in it. Both handles are attached by the test, so nothing
    /// about how the app measures its scroll is being imitated — only the layout is.
    struct Fixture {
        pane: ScrollHandle,
        body: ScrollHandle,
        owns_scroll: bool,
        body_fills: bool,
    }

    impl Render for Fixture {
        fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
            let body = div()
                .when(self.body_fills, |d| d.size_full())
                .when(!self.body_fills, |d| d.w_full().h(px(1200.0)));
            div().size(px(400.0)).child(
                div()
                    .id("pane-preview")
                    .size_full()
                    .overflow_y_scroll()
                    .track_scroll(&self.pane)
                    .child(
                        div()
                            .h_full()
                            .w_full()
                            .flex()
                            .flex_col()
                            .child(div().h(px(40.0)).w_full().flex_none())
                            .child(
                                preview_body_box(self.owns_scroll)
                                    .track_scroll(&self.body)
                                    .child(body),
                            ),
                    ),
            )
        }
    }

    fn draw(cx: &mut TestAppContext, fixture: Fixture) -> gpui::AnyWindowHandle {
        let window: gpui::AnyWindowHandle = cx.add_window(move |_, _| fixture).into();
        cx.update_window(window, |_, window, cx| window.draw(cx).clear(cx))
            .expect("draw the preview fixture");
        window
    }

    /// A real wheel gesture over the middle of the body (200, 200 is inside it in every case),
    /// then a frame to apply it. What is asserted afterwards is the handle's own offset, so the
    /// test asks the same question a person does: did the file move when I scrolled?
    fn scroll_over_body(cx: &mut TestAppContext, window: gpui::AnyWindowHandle) {
        cx.update_window(window, |_, window, cx| {
            window.dispatch_event(
                PlatformInput::ScrollWheel(ScrollWheelEvent {
                    position: point(px(200.0), px(200.0)),
                    delta: ScrollDelta::Pixels(point(px(0.0), px(-240.0))),
                    modifiers: Modifiers::default(),
                    touch_phase: TouchPhase::default(),
                }),
                cx,
            );
            window.draw(cx).clear(cx);
        })
        .expect("scroll the preview body");
    }

    /// Markdown and source text: the wheel moves the file.
    #[gpui::test]
    fn a_content_sized_preview_body_scrolls(cx: &mut TestAppContext) {
        let pane = ScrollHandle::new();
        let body = ScrollHandle::new();
        let window = draw(
            cx,
            Fixture {
                pane: pane.clone(),
                body: body.clone(),
                owns_scroll: false,
                body_fills: false,
            },
        );
        // 400 of pane less 40 of header: the 1200px document leaves the body 840 to give.
        assert_eq!(
            body.max_offset().y.abs(),
            px(840.0),
            "the body must be scrollable to the bottom of the file"
        );
        scroll_over_body(cx, window);
        assert_eq!(body.offset().y, px(-240.0), "the wheel must move the file");
        // The pane box above it never scrolls: the column is `h_full`, so it measures a child
        // exactly as tall as itself and finds nothing to give. That is why the scroll could not
        // live there, and why it silently did nothing before this was fixed.
        assert_eq!(pane.max_offset().y, px(0.0));
        assert_eq!(pane.offset().y, px(0.0));
    }

    /// The editor and a rendered document scroll themselves: a second scroll box around them would
    /// measure them by their content and collapse them.
    #[gpui::test]
    fn a_body_that_owns_its_scroll_is_not_wrapped_in_another(cx: &mut TestAppContext) {
        let pane = ScrollHandle::new();
        let body = ScrollHandle::new();
        let window = draw(
            cx,
            Fixture {
                pane: pane.clone(),
                body: body.clone(),
                owns_scroll: true,
                body_fills: true,
            },
        );
        scroll_over_body(cx, window);
        assert_eq!(
            body.offset().y,
            px(0.0),
            "a body that owns its scroll must not be given a second one"
        );
        assert_eq!(pane.offset().y, px(0.0));
    }
}

#[cfg(test)]
mod tab_tests {
    use super::PaneState;
    #[test]
    fn changing_tabs_restores_the_file_draft_and_preview_mode() {
        let mut state = PaneState::default();
        state.activate("first".into());
        state.draft = Some("unsaved text".into());
        state.baseline = Some("original text".into());
        state.editing = true;
        state.activate("git".into());
        assert!(state.draft.is_none() && !state.editing);
        state.activate("first".into());
        assert_eq!(state.draft.as_deref(), Some("unsaved text"));
        assert_eq!(state.baseline.as_deref(), Some("original text"));
        assert!(state.editing);
        state.activate("first".into());
        assert_eq!(state.draft.as_deref(), Some("unsaved text"));
    }
}
