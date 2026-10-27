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
    div().px(px(4.0)).child(
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
/// How wide it opens the first time.
pub const DEFAULT_WIDTH: f32 = 380.0;
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
            title: if english { "Files" } else { "文件" }.into(),
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
        let preview = crate::workspace::preview_fixture(&format!("{root}/native/Cargo.toml"));
        self.adopt_preview(&conversation, preview, window, cx);
        if let Some(state) = self.panes.get_mut(&conversation) {
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
                        .aria_label(if english {
                            "Expand sidebar"
                        } else {
                            "展开侧边栏"
                        })
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.on_toggle_sidebar(&super::ToggleSidebar, window, cx)
                        })),
                )
                .child(
                    icon_button("pane-new-chat", "message-square-plus", &p)
                        .aria_label(if english { "New chat" } else { "新对话" })
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
                                .aria_label(if english { "Add panel" } else { "新增标签" })
                                .tooltip(move |window, cx| {
                                    Tooltip::new(if english { "Add panel" } else { "新增标签" })
                                        .build(window, cx)
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
                    if english {
                        "Restore side panel"
                    } else {
                        "还原侧边面板"
                    }
                } else {
                    if english {
                        "Maximize side panel"
                    } else {
                        "最大化侧边面板"
                    }
                })
                .on_click(cx.listener(|this, _, _, cx| {
                    this.side_pane_maximized = !this.side_pane_maximized;
                    cx.notify();
                })),
            )
            .child(
                icon_button("pane-collapse", "panel-right-close", &p)
                    .aria_label(if english {
                        "Collapse side panel"
                    } else {
                        "收起侧边面板"
                    })
                    .tooltip(move |window, cx| {
                        Tooltip::new(if english {
                            "Collapse side panel  ⌃⌥B"
                        } else {
                            "收起侧边面板  ⌃⌥B"
                        })
                        .build(window, cx)
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
                                        this.side_pane_width = DEFAULT_WIDTH;
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
                if english {
                    "Auxiliary chat"
                } else {
                    "辅助对话"
                }
                .into(),
            ));
        }
        items.push((
            "files",
            "folder01",
            if english { "Files" } else { "文件" }.into(),
        ));
        if !self
            .panes
            .get(self.selected.as_deref().unwrap_or("__draft__"))
            .is_some_and(|s| s.tabs.iter().any(|t| t.kind == PaneTabKind::Git))
        {
            items.push((
                "git",
                "git-compare",
                if english { "Changes" } else { "变更" }.into(),
            ));
        }
        items.push((
            "terminal",
            "terminal",
            if english { "Terminal" } else { "终端" }.into(),
        ));
        items.push((
            "browser",
            "chrome",
            if english { "Browser" } else { "浏览器" }.into(),
        ));
        items
    }

    fn open_pane_kind(&mut self, kind: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.pane_menu = None;
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
                    title: "文件".into(),
                });
                state.activate(id);
            }
            _ => {
                let state = self
                    .panes
                    .entry(self.selected.clone().unwrap_or_else(|| "__draft__".into()))
                    .or_default();
                state.notice = Some(format!(
                    "{}功能正在移植中",
                    match kind {
                        "chat" => "辅助对话",
                        "browser" => "浏览器",
                        _ => "终端",
                    }
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
                if english { "Close tab" } else { "关闭标签" },
                if english {
                    "Close other tabs"
                } else {
                    "关闭其他标签"
                },
                if english {
                    "Close all tabs"
                } else {
                    "关闭所有标签"
                },
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
                self.side_pane_width = width.max(MIN_WIDTH);
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
                        Err(e) => state.notice = Some(format!("保存「{path}」失败：{e}")),
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
                            message: format!("无法读取这个文件：{e}"),
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
                if let Some(state) = this.panes.get_mut(&conversation) {
                    if state.listing_epoch != epoch {
                        return;
                    }
                    state.loading.remove(&path);
                    match result {
                        Ok(listed) => {
                            state.listings.insert(path.clone(), listed.entries);
                        }
                        Err(e) => state.notice = Some(format!("无法读取这个文件夹：{e}")),
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
                .pane_placeholder("这个对话没有工作目录")
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
        let (entries, tree_width, notice, preview) = {
            let state = self.panes.entry(conversation.to_string()).or_default();
            (
                state.listings.get(&root).cloned().unwrap_or_default(),
                // While the splitter is held, the dragged width wins: the stored one is where it
                // started, and writing every move to the store would be a write per frame.
                state
                    .tree_width
                    .clamp(TREE_MIN, (0.75 * self.pane_content_width).max(TREE_MIN)),
                state.notice.clone(),
                state.show_preview.then(|| state.preview.clone()).flatten(),
            )
        };
        // A pane narrower than 32rem swaps the two instead of squeezing them: at 380px a
        // side-by-side tree and preview leaves the file about 150px wide, which is not a preview.
        // This is the Electron pane's own rule (`@min-[32rem]/files`), and the default width is
        // below it — so the tree is what the pane shows until the user widens it.
        let side_by_side = self.side_pane_width_side_by_side();
        let showing_file = preview.is_some() && !side_by_side;
        let editing = self.panes.get(conversation).is_some_and(|s| s.editing);
        let intrinsic_scroll = matches!(
            &preview,
            Some(FilePreview::Media { .. } | FilePreview::Office { .. })
        ) || matches!(
            &preview,
            Some(FilePreview::Text {
                kind: FilePreviewKind::Html,
                ..
            })
        ) || (editing
            && preview.as_ref().is_some_and(|p| editable_text(p).is_some()));
        let preview_body = self.preview_body(preview, cx);

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
        let root_context = root.clone();
        let root_toggle = root.clone();
        let mut tree_rows: Vec<AnyElement> = vec![
            div()
                .id("pane-root-folder")
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
                .child(ui::chevron(root_open, 12.0, p.c(Token::MutedForeground)))
                .child(
                    img(crate::file_icons::folder_path(
                        &root_name,
                        root_open,
                        !p.is_dark(),
                    ))
                    .size(px(16.0))
                    .flex_none(),
                )
                .child(ui::truncate(root_name).flex_1())
                .child(
                    div()
                        .text_size(px(TEXT_XS))
                        .font_weight(FontWeight::NORMAL)
                        .muted(&p)
                        .child(if self.app_settings.language == UiLanguage::English {
                            "Main"
                        } else {
                            "主"
                        }),
                )
                .on_mouse_down(
                    MouseButton::Right,
                    cx.listener(move |this, event: &MouseDownEvent, _, cx| {
                        cx.stop_propagation();
                        this.open_entry_menu(
                            entries::EntryMenu {
                                at: event.position,
                                root: root_context.clone(),
                                path: root_context.clone(),
                                kind: EntryKind::Directory,
                                is_root: true,
                            },
                            cx,
                        );
                    }),
                )
                .on_click(
                    cx.listener(move |this, _, _, cx| this.toggle_dir(root_toggle.clone(), cx)),
                )
                .into_any_element(),
        ];
        if root_open {
            for entry in entries.iter() {
                tree_rows.extend(self.tree_row(entry, &root, 0, cx));
            }
        }
        for folder in roots.iter().skip(1) {
            let open = self
                .panes
                .get(conversation)
                .is_some_and(|s| s.expanded.contains(folder));
            let label = std::path::Path::new(folder)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let (toggle, context) = (folder.clone(), folder.clone());
            tree_rows.push(
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
                    .child(ui::chevron(open, 12.0, p.c(Token::MutedForeground)))
                    .child(
                        img(crate::file_icons::folder_path(&label, open, !p.is_dark()))
                            .size(px(16.0))
                            .flex_none(),
                    )
                    .child(ui::truncate(label))
                    .on_click(
                        cx.listener(move |this, _, _, cx| this.toggle_dir(toggle.clone(), cx)),
                    )
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
                    )
                    .into_any_element(),
            );
            if open {
                for entry in self
                    .panes
                    .get(conversation)
                    .and_then(|s| s.listings.get(folder))
                    .into_iter()
                    .flatten()
                {
                    tree_rows.extend(self.tree_row(entry, folder, 0, cx));
                }
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

    /// One tree row and, when it is an expanded directory, its children.
    fn tree_row(
        &self,
        entry: &DirEntry,
        root: &str,
        depth: usize,
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
        let row = div()
            .id(SharedString::from(format!("tree-{}", entry.path)))
            .h(px(24.0))
            .pl(px(8.0 + depth as f32 * 12.0))
            .pr(px(8.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .text_size(px(TEXT_XS))
            .cursor_pointer()
            .when(open, |d| d.bg(p.c(Token::Foreground).opacity(0.1)))
            .hover(move |d| d.bg(hover))
            .children(is_dir.then(|| ui::chevron(expanded, 12.0, p.c(Token::MutedForeground))))
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
            .child(ui::truncate(name.clone()))
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
                rows.extend(self.tree_row(&child, root, depth + 1, cx));
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
            .aria_label("调整文件树宽度")
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

    fn preview_body(&mut self, preview: Option<FilePreview>, cx: &mut Context<Self>) -> AnyElement {
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
                let editable = editable_text(&FilePreview::Text {
                    kind,
                    path: path.clone(),
                    name: name.clone(),
                    language: None,
                    text: text.clone(),
                })
                .is_some();
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
                    _ if kind == FilePreviewKind::Markdown => div()
                        .px(px(14.0))
                        .py(px(10.0))
                        .text_size(px(TEXT_SM))
                        .line_height(px(24.0))
                        .child(crate::markdown::view(
                            SharedString::from(format!("pane-md-{path}")),
                            SharedString::from(text.clone()),
                            &p,
                        ))
                        .into_any_element(),
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
                div()
                    .h_full()
                    .w_full()
                    .flex()
                    .flex_col()
                    .child(self.preview_head_with(&name, back, dirty, toggle, cx))
                    .child(div().flex_1().min_h_0().w_full().child(body))
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
                            .child(SharedString::from(format!(
                                "只显示前 {} 行，共 {total_rows} 行",
                                rows.len()
                            )))
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
                    .aria_label("刷新预览")
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
                name,
                message,
                detail,
                directory,
                ..
            } => {
                let _ = cx;
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .p(px(16.0))
                    .child(
                        div()
                            .text_size(px(TEXT_SM))
                            .text_color(p.c(Token::Foreground))
                            .child(SharedString::from(message)),
                    )
                    .child(
                        div()
                            .muted(&p)
                            .text_size(px(TEXT_XS))
                            .child(SharedString::from(name)),
                    )
                    .children(directory.clone().into_iter().map(|dir| {
                        div()
                            .muted(&p)
                            .text_size(px(TEXT_XS))
                            .child(SharedString::from(dir))
                    }))
                    .children(detail.map(|detail| {
                        div()
                            .text_size(px(TEXT_XS))
                            .font_family(crate::assets::MONO_FONT)
                            .muted(&p)
                            .child(SharedString::from(detail))
                    }))
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
            .child(div().flex_1())
            .children(toggle)
    }

    fn preview_head(&self, name: &str, back: bool, cx: &mut Context<Self>) -> Div {
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
            .child(ui::truncate(
                self.selected
                    .as_ref()
                    .and_then(|id| self.panes.get(id))
                    .and_then(|s| preview_path(s.preview.as_ref()))
                    .map(|path| {
                        let root = self
                            .selected
                            .as_ref()
                            .and_then(|id| self.project_root_for(id))
                            .unwrap_or_default();
                        path.strip_prefix(&format!("{root}/"))
                            .unwrap_or(&path)
                            .replace('/', "  /  ")
                    })
                    .unwrap_or_else(|| name.to_string()),
            ))
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
