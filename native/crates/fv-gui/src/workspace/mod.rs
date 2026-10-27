//! The main window: sidebar of conversations, the transcript of the open one, and the
//! composer. Everything it knows comes from the server through [`Backend`].

use std::collections::{HashMap, HashSet};

use futures_util::StreamExt as _;
use fv_protocol::methods::*;
use fv_protocol::types::Empty;
use fv_protocol::types::*;
use fv_protocol::{RequestId, ServerNotification, ServerRequest};
use fv_theme::Token;
use gpui_kit::component::input::{InputEvent, InputState, TextareaState};
use gpui_kit::*;

mod about;
mod app_menu;
mod ask;
mod composer;
mod diff;
mod file_mention;
mod header_git;
mod mcp;
mod memory;
mod model_detail;
mod palette;
mod pane;
mod pane_git;
mod pane_office;
mod pane_terminal;
mod pane_web;
mod panel_motion;
mod personalization;
mod projects;
mod provider_test;
mod queue_tray;
mod schedules;
pub mod settings;
mod shortcuts;
mod sidebar;
mod sidebar_actions;
mod skill_picker;
mod skills;
mod subagent_roles;
mod subagents;
mod transcript;
mod usage;

use crate::backend::{Backend, BackendEvent};
use crate::theme::Palette;
use crate::view_model::{Applied, ThreadView};

/// The Electron app's Chinese copy (`locales/zh`), word for word.
pub(crate) fn static_text(english: bool, key: &str) -> &'static str {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    // Per language, then by key: a hit allocates nothing, and the set of keys is fixed at
    // compile time, so what is leaked (one string per key and language) is bounded.
    type Cache = [HashMap<String, &'static str>; 2];
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    let mut cache = CACHE.get_or_init(Default::default).lock().unwrap();
    let table = &mut cache[usize::from(english)];
    if let Some(text) = table.get(key) {
        return text;
    }
    let text = rust_i18n::t!(key, locale = if english { "en" } else { "zh" });
    let text: &'static str = Box::leak(text.into_owned().into_boxed_str());
    table.insert(key.to_string(), text);
    text
}

mod text {
    use super::UiLanguage;

    pub const CHANGED_FILES: &str = "已修改 {n} 个文件";
    pub const QUEUE_SEND_NOW: &str = "立即";
    pub const QUEUE_RESUME: &str = "继续";
    pub const QUEUE_UNIT: &str = "条排队中";
    pub const QUEUE_PAUSED: &str = "上次回复出错，队列已暂停";
    pub const QUEUE_PAUSED_STOPPED: &str = "已停止，队列已暂停";

    /// The locale file key is `text.<name>`; see `locales/app.yml`.
    macro_rules! texts {
        ($($name:ident),* $(,)?) => {
            $(
                pub fn $name(language: UiLanguage) -> String {
                    rust_i18n::t!(concat!("text.", stringify!($name)), locale = locale(language)).into_owned()
                }
            )*
        };
    }

    /// Looks up `key` in `locales/app.yml` for `language`. Placeholders (`%{name}`) are
    /// filled by [`rust_i18n::t!`] at the call site instead.
    pub fn tr(language: UiLanguage, key: &str) -> String {
        rust_i18n::t!(key, locale = locale(language)).into_owned()
    }

    pub fn locale(language: UiLanguage) -> &'static str {
        match language {
            UiLanguage::Chinese => "zh",
            UiLanguage::English => "en",
        }
    }

    texts!(
        new_chat,
        settings,
        placeholder,
        no_model,
        no_model_hint,
        connecting,
        pane_terminal,
        pane_git,
        git_commit,
        edit_hint,
        edit_cancel,
        untitled,
        thinking,
        compacted,
        compacting,
        working,
        processed,
        view_changes
    );
}

enum Status {
    Connecting,
    Ready,
    Failed(String),
}

/// What the composer is saying about the last thing it did.
///
/// A failure is red; a rewind that worked is not. Putting the workspace back is a *good*
/// outcome and draw it as an error taught people to read 「已退回工作区」 as a problem.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum Notice {
    /// Something did not happen. Red, with the reason.
    Failed(String),
    /// Something did happen, and it is worth knowing. Muted, beside a check.
    Done(String),
    /// It happened, but not completely. Amber: the retry runs and the tree is only partly back.
    Partial(String),
}

impl Notice {
    pub(super) fn text(&self) -> &str {
        match self {
            Self::Failed(text) | Self::Done(text) | Self::Partial(text) => text,
        }
    }
}

pub struct Workspace {
    web_views: HashMap<String, pane_web::ContentView>,
    web_drag_blocked: bool,
    office_views: HashMap<String, pane_office::OfficeView>,
    subagents: subagents::Subagents,
    subagent_roles: subagent_roles::RoleSettings,
    schedules_ui: schedules::ScheduleUi,
    palette: Palette,
    backend: Option<Backend>,
    status: Status,
    threads: Vec<Thread>,
    selected: Option<ThreadId>,
    views: HashMap<ThreadId, ThreadView>,
    /// Questions that arrived for a thread whose view is not loaded yet.
    pending_questions: Vec<(RequestId, UserInputRequest)>,
    pending_approvals: Vec<(RequestId, ApprovalRequestParams)>,
    models: Vec<ModelEntry>,
    model_request: u64,
    defaults: ModelDefaults,
    /// The model picked on the empty page, before a conversation exists.
    pending_model: Option<String>,
    pending_thinking: Option<ThinkingLevel>,
    /// The project a new conversation will start in (the composer's 选择项目 chip).
    draft_project: Option<String>,
    project_menu: bool,
    model_menu: bool,
    thinking_menu: bool,
    context_menu: bool,
    compact_pending: HashSet<ThreadId>,
    input: Entity<TextareaState>,
    scroll: ScrollHandle,
    /// How far through each waiting question set the user is.
    ask: HashMap<RequestId, ask::AskProgress>,
    ask_input: Entity<InputState>,
    panel_focus: FocusHandle,
    focused_for: Option<RequestId>,
    approval_menu: bool,
    access_menu: bool,
    /// Turns whose folded process the user opened.
    open_folds: HashSet<String>,
    /// Thoughts and tool calls the user opened, by item id.
    open_items: HashSet<String>,
    /// Projects whose chats the user folded away, by project path.
    sidebar_resize: Option<f32>,
    sidebar_drag_offset: f32,
    pane_drag_offset: f32,
    sidebar_layout: Option<(f32, bool)>,
    sidebar_motion: panel_motion::PanelMotion,
    pane_motion: panel_motion::PanelMotion,
    sidebar_scroll: ScrollHandle,
    sidebar_scroll_direction: i8,
    sidebar_scroll_task: Option<Task<()>>,
    sidebar_drop: Option<(String, String, bool)>,
    navigation: crate::sidebar_state::History,
    sidebar_menu: Option<Point<Pixels>>,
    sidebar_notice: Option<String>,
    dock_badge: u32,
    /// Scroll to the end once the transcript has been laid out (opening a conversation).
    stick_to_bottom: bool,
    /// 设置, while it is open (it covers the workspace, which keeps its state behind it).
    settings: Option<settings::SettingsState>,
    /// ⌘K: the search box, while it is open.
    search_box: Option<Entity<InputState>>,
    /// The turn the composer's next submission rewrites (编辑), if any.
    editing_turn: Option<String>,
    /// The `@` file menu, while the caret is inside a mention.
    mention: Option<file_mention::MentionState>,
    skill_picker: skill_picker::Picker,
    /// A draft the capture fixture puts into the composer before opening the `@` menu.
    pending_fixture_draft: Option<String>,
    /// Files picked from `@`. They travel with the prompt as references, the same way a dropped
    /// file does, so the draft itself does not carry `@path`.
    attached_files: Vec<fv_protocol::types::FileHit>,
    /// The right pane, per conversation: its tabs, the tree it has read and the file on show.
    panes: HashMap<String, pane::PaneState>,
    pane_storage: Option<crate::pane_layout::Storage>,
    pane_save_pending: bool,
    browser_bookmarks: Vec<crate::pane_layout::Bookmark>,
    browser_history: Vec<crate::pane_layout::HistoryEntry>,
    /// The terminal tabs, by tab id: their pty, the frame on screen, and the size last reported.
    terminals: HashMap<String, pane_terminal::TerminalView>,
    /// The keyboard focus a terminal needs before it can take keys.
    terminal_focus: gpui_kit::FocusHandle,
    terminal_copy_epoch: u64,
    /// The 变更 tab's state, per conversation: git is a different reader from the file tree, and
    /// its status, patch and history are not what the tree holds.
    git_views: HashMap<String, pane_git::GitView>,
    /// Whether the pane is collapsed, and how wide it is when it is not. Remembered per client,
    /// not per conversation: the pane's width is a property of the window, not of a chat.
    side_pane_collapsed: bool,
    side_pane_width: f32,
    side_pane_maximized: bool,
    side_pane_resize: Option<f32>,
    /// Actual inner width after window constraints (also used by responsive pane content).
    pane_content_width: f32,
    pane_menu: Option<(Point<Pixels>, Option<String>)>,
    entry_menu: Option<pane::entries::EntryMenu>,
    entry_dialog: Option<pane::entries::EntryDialog>,
    /// The file tree's column while it is being dragged, if it is.
    pane_tree_resize: Option<f32>,
    /// A file the pane was asked to open by a click, which has no `Window` of its own. The next
    /// render performs it — opening a file builds the editor, and that needs one.
    pending_open: Option<(String, String)>,
    /// 回复推荐: the standing guess, mirrored from the thread so a key handler can read it
    /// without borrowing the view.
    compose_suggestion: Option<String>,
    /// The placeholder currently written into the text area, so a frame that changes nothing
    /// writes nothing (and the guessed text is not re-set on every keystroke).
    placeholder_shown: String,
    search_results: palette::SearchResults,
    search_task: Option<Task<()>>,
    search_target: Option<(ThreadId, String)>,
    search_anchor: ScrollAnchor,
    search_jump_pending: bool,
    /// Dev only: send even with no model listed (the echo server has none).
    pub(super) skip_model_check: bool,
    /// Why the last send did not go through, shown above the composer.
    /// What the composer says about the last thing it did: a failure, or the result of a rewind
    /// that worked — the two must not look alike, so each carries its own tone.
    notice: Option<Notice>,
    /// 创建项目 / 编辑项目, while its dialog is open.
    project_dialog: Option<projects::ProjectDialog>,
    /// The folders the user works in, as the server lists them.
    projects: Vec<ProjectInfo>,
    /// The ⋯ menu of a project row: which, and where the pointer was.
    project_row_menu: Option<(String, Point<Pixels>)>,
    /// The right-click menu of a sidebar row: which thread, where the pointer was.
    thread_menu: Option<(ThreadId, Point<Pixels>)>,
    /// A sidebar row being renamed in place.
    rename: Option<(ThreadId, Entity<InputState>)>,
    /// How the app looks, as the server keeps it (shared by every client).
    app_settings: AppSettings,
    /// A settings read started before a write/notification cannot restore its old snapshot.
    app_settings_epoch: u64,
    shortcuts: shortcuts::Runtime,
    /// Whether the app follows `app_settings`; a fixture window keeps the palette it was given.
    live_appearance: bool,
    appearance_dirty: bool,
    /// The language the menu bar was last built in.
    menu_english: bool,
    header_git: header_git::HeaderGit,
    system_dark: bool,
}

impl Workspace {
    pub fn new(
        palette: Palette,
        data_dir: std::path::PathBuf,
        server_bin: Option<std::path::PathBuf>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut this = Self::base(palette, window, cx);
        this.live_appearance = true;
        let layout_path = data_dir.join("gui-workspace.json");
        let recovery = cx
            .background_executor()
            .spawn(async move { crate::pane_layout::Storage::open(layout_path) });
        cx.observe_self(|this, cx| this.schedule_pane_save(cx))
            .detach();
        cx.on_app_quit(|this, cx| {
            let job = this.pane_save_job(cx);
            cx.background_executor().spawn(async move {
                if let Some(job) = job
                    && let Err(error) = job.run()
                {
                    eprintln!("workspace recovery save: {error}");
                }
            })
        })
        .detach();
        cx.on_release(|this, cx| {
            if let Some(job) = this.pane_save_job(cx)
                && let Err(error) = job.run()
            {
                eprintln!("workspace recovery save: {error}");
            }
        })
        .detach();
        let (ready, mut events) = Backend::start(data_dir, server_bin);
        cx.spawn(async move |this, cx| {
            let recovery = recovery.await;
            let backend = ready.await;
            this.update(cx, |this, cx| {
                if let Some(b) = backend {
                    this.backend = Some(b);
                    this.status = Status::Ready;
                    match recovery {
                        Ok(storage) => this.restore_panes(storage),
                        Err(error) => {
                            this.notice = Some(Notice::Failed(tr!(
                                this.english(),
                                "mod.could_not_read_the_saved",
                                error = error
                            )))
                        }
                    }
                    this.refresh_all(cx);
                    if let Some(input) = &this.search_box {
                        let query = input.read(cx).value().trim().to_lowercase();
                        this.search_palette(query, cx);
                    }
                    if let Some(id) = this.selected.clone() {
                        this.select(id, cx);
                    }
                }
                cx.notify();
            })
            .ok();
            while let Some(event) = events.next().await {
                if this
                    .update(cx, |this, cx| this.on_event(event, cx))
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        this
    }

    /// A window drawn from canned data, with no server: for comparing screenshots with the
    /// Electron app's `mock.html`.
    pub fn fixture(
        palette: Palette,
        fixture: crate::fixture::Fixture,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut this = Self::base(palette, window, cx);
        this.status = Status::Ready;
        this.threads = fixture.threads;
        this.draft_project = fixture.draft_project;
        let mut seen = Vec::new();
        for t in &this.threads {
            if let Some(path) = &t.project
                && !seen.contains(path)
            {
                seen.push(path.clone());
            }
        }
        this.projects = seen
            .into_iter()
            .map(|path| ProjectInfo {
                name: transcript::project_name(&path).to_string(),
                path,
                folders: Vec::new(),
            })
            .collect();
        this.models = fixture.models;
        this.defaults = fixture.defaults;
        this.notice = fixture.rewound_notice.map(Notice::Done);
        this.compose_suggestion = fixture.suggestion;
        this.pending_fixture_draft = fixture.draft;
        if let Some(view) = fixture.view {
            this.selected = Some(view.thread.id.clone());
            this.views.insert(view.thread.id.clone(), view);
            this.fixture_header_git(1);
        }
        this
    }

    fn base(palette: Palette, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .submit_on_enter(true)
                .auto_grow(1, 8)
                .placeholder(text::placeholder(UiLanguage::Chinese))
        });
        // The composer has the keyboard from the start, as in the Electron app.
        input.update(cx, |state, cx| state.focus(window, cx));
        cx.subscribe_in(&input, window, |this, _, ev: &InputEvent, window, cx| {
            match ev {
                // Every keystroke can open, narrow or close a `@` mention.
                InputEvent::Change => this.composer_changed(window, cx),
                InputEvent::Focus => this.composer_focus(true, cx),
                InputEvent::Blur => this.composer_focus(false, cx),
                // Enter takes the highlighted file while the `@` menu is open, rather than
                // sending a half-typed path.
                InputEvent::PressEnter {
                    secondary: false,
                    shift: false,
                } if this.app_settings.send_on_enter
                    && !this.accept_skill(window, cx)
                    && !this.accept_mention(window, cx) =>
                {
                    this.send(window, cx)
                }
                _ => {}
            }
        })
        .detach();
        let ask_input = cx.new(|cx| InputState::new(window, cx).placeholder("或自行撰写回复"));
        cx.subscribe_in(
            &ask_input,
            window,
            |this, _, ev: &InputEvent, window, cx| match ev {
                InputEvent::PressEnter { .. } => this.submit_free(window, cx),
                InputEvent::Change => cx.notify(),
                _ => {}
            },
        )
        .detach();
        let scroll = ScrollHandle::new();
        let search_anchor = ScrollAnchor::for_handle(scroll.clone());
        let this = Self {
            web_views: HashMap::new(),
            web_drag_blocked: false,
            office_views: HashMap::new(),
            subagents: Default::default(),
            subagent_roles: Default::default(),
            schedules_ui: Default::default(),
            palette,
            backend: None,
            status: Status::Connecting,
            threads: Vec::new(),
            selected: None,
            views: HashMap::new(),
            pending_questions: Vec::new(),
            pending_approvals: Vec::new(),
            models: Vec::new(),
            model_request: 0,
            defaults: ModelDefaults::default(),
            pending_model: None,
            pending_thinking: None,
            draft_project: None,
            project_menu: false,
            model_menu: false,
            thinking_menu: false,
            context_menu: false,
            compact_pending: HashSet::new(),
            input,
            scroll,
            ask: HashMap::new(),
            ask_input,
            panel_focus: cx.focus_handle(),
            focused_for: None,
            approval_menu: false,
            access_menu: false,
            open_folds: HashSet::new(),
            open_items: HashSet::new(),
            sidebar_resize: None,
            sidebar_drag_offset: 0.0,
            pane_drag_offset: 0.0,
            sidebar_layout: None,
            sidebar_motion: Default::default(),
            pane_motion: Default::default(),
            sidebar_scroll: ScrollHandle::new(),
            sidebar_scroll_direction: 0,
            sidebar_scroll_task: None,
            sidebar_drop: None,
            navigation: Default::default(),
            sidebar_menu: None,
            sidebar_notice: None,
            dock_badge: 0,
            stick_to_bottom: true,
            settings: None,
            search_box: None,
            editing_turn: None,
            mention: None,
            skill_picker: Default::default(),
            pending_fixture_draft: None,
            attached_files: Vec::new(),
            panes: HashMap::new(),
            pane_storage: None,
            pane_save_pending: false,
            browser_bookmarks: Vec::new(),
            browser_history: Vec::new(),
            terminals: HashMap::new(),
            terminal_focus: cx.focus_handle(),
            terminal_copy_epoch: 0,
            git_views: HashMap::new(),
            // Collapsed until something opens a tab in it: an empty 380px column beside the
            // conversation is a column the reader did not ask for, and the Electron pane starts
            // closed for the same reason. A tab appearing (a file, 变更) opens it.
            side_pane_collapsed: true,
            side_pane_width: pane::DEFAULT_WIDTH,
            side_pane_maximized: false,
            side_pane_resize: None,
            pane_content_width: pane::DEFAULT_WIDTH - 16.0,
            pane_menu: None,
            entry_menu: None,
            entry_dialog: None,
            pane_tree_resize: None,
            pending_open: None,
            compose_suggestion: None,
            placeholder_shown: text::placeholder(UiLanguage::Chinese),
            search_results: Default::default(),
            search_task: None,
            search_target: None,
            search_anchor,
            search_jump_pending: false,
            skip_model_check: false,
            notice: None,
            project_dialog: None,
            projects: Vec::new(),
            project_row_menu: None,
            thread_menu: None,
            rename: None,
            app_settings: AppSettings::default(),
            app_settings_epoch: 0,
            shortcuts: shortcuts::Runtime::new(window, cx),
            live_appearance: false,
            appearance_dirty: false,
            menu_english: false,
            header_git: Default::default(),
            system_dark: matches!(
                window.appearance(),
                WindowAppearance::Dark | WindowAppearance::VibrantDark
            ),
        };
        cx.observe_window_appearance(window, |this, window, cx| {
            this.system_dark = matches!(
                window.appearance(),
                WindowAppearance::Dark | WindowAppearance::VibrantDark
            );
            if this.live_appearance {
                this.apply_appearance(window, cx);
            }
        })
        .detach();
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(std::time::Duration::from_secs(1))
                    .await;
                let res = this.update(cx, |this, cx| {
                    let running = this
                        .selected
                        .as_ref()
                        .and_then(|id| this.views.get(id))
                        .is_some_and(|v| v.running);
                    if running {
                        cx.notify();
                    }
                });
                if res.is_err() {
                    break;
                }
            }
        })
        .detach();
        this
    }

    pub fn set_palette(&mut self, palette: Palette, cx: &mut Context<Self>) {
        self.palette = palette;
        cx.notify();
    }

    /// The right-click menu of a sidebar row.
    fn thread_menu_view(&self, window: &Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (id, at) = self.thread_menu.clone()?;
        let at = sidebar_actions::popup_origin(at, 160.0, 176.0, window);
        let thread = self.threads.iter().find(|t| t.id == id)?;
        let p = &self.palette;
        let hover = p.c(Token::Accent);
        let pinned = thread.pinned;
        let item = |key: &'static str, glyph: &'static str, label: &'static str| {
            settings::menu_item(SharedString::from(format!("tm-{key}")), false, hover)
                .child(crate::ui::icon(glyph, 14.0, p.c(Token::MutedForeground)))
                .child(label)
        };
        let fork_id = id.clone();
        let bound = thread.worktree.clone();
        let (rename_id, pin_id, archive_id, delete_id) =
            (id.clone(), id.clone(), id.clone(), id.clone());
        let (worktree_id, unbind_id) = (id.clone(), id);
        let menu = settings::popover(p)
            .absolute()
            .left(at.x)
            .top(at.y)
            .w(px(160.0))
            .child(
                item(
                    "rename",
                    "pencil-edit02",
                    trs!(self.english(), "mod.rename"),
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.begin_rename(rename_id.clone(), window, cx)
                })),
            )
            .child(
                item(
                    "pin",
                    "pin",
                    if pinned {
                        trs!(self.english(), "mod.unpin")
                    } else {
                        trs!(self.english(), "mod.pin")
                    },
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.thread_menu = None;
                    this.update_thread(
                        ThreadUpdateParams {
                            thread_id: pin_id.clone(),
                            title: None,
                            archived: None,
                            pinned: Some(!pinned),
                        },
                        cx,
                    )
                })),
            )
            .child(
                item("archive", "archive04", trs!(self.english(), "mod.archive")).on_click(
                    cx.listener(move |this, _, _, cx| {
                        this.thread_menu = None;
                        this.update_thread(
                            ThreadUpdateParams {
                                thread_id: archive_id.clone(),
                                title: None,
                                archived: Some(true),
                                pinned: None,
                            },
                            cx,
                        )
                    }),
                ),
            )
            .child(
                item(
                    "fork",
                    "message-square-plus",
                    trs!(self.english(), "mod.fork"),
                )
                .on_click(cx.listener(move |this, _, _, cx| this.fork_thread(fork_id.clone(), cx))),
            )
            // One row, because the two states are one question: is this conversation running
            // in its own checkout, and do you want it to? The label says where it is when it
            // is, so the row is a statement and not just a command.
            .child(match bound.is_some() {
                true => item(
                    "worktree",
                    "git-branch",
                    trs!(self.english(), "mod.unbind_isolated_workspace"),
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.thread_menu = None;
                    this.unbind_worktree(unbind_id.clone(), cx)
                })),
                false => item(
                    "worktree",
                    "git-branch",
                    trs!(self.english(), "mod.create_isolated_workspace"),
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.thread_menu = None;
                    this.create_worktree(worktree_id.clone(), cx)
                })),
            })
            .child(
                item("delete", "delete02", trs!(self.english(), "mod.delete"))
                    .text_color(p.c(Token::Destructive))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.confirm_delete_thread(delete_id.clone(), window, cx)
                    })),
            );
        Some(crate::ui::float(menu).into_any_element())
    }

    fn project_row_menu_view(&self, window: &Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (path, at) = self.project_row_menu.clone()?;
        // Wide enough for the longest label *with* its glyph: 8+14+8 of chrome, then nine
        // CJK cells at 14px. The Electron menu is `w-40` because its label is 在访达中显示.
        let width = 180.0;
        let at = sidebar_actions::popup_origin(at, width, 144.0, window);
        let p = &self.palette;
        let hover = p.c(Token::Accent);
        // Every row carries a glyph: `menu_item` is a flex row with an 8px gap, so a row
        // without one starts its text 22px to the left of its neighbours and the menu reads
        // as two lists that happen to share a popover.
        let item = |key: &'static str, glyph: &'static str, label: &'static str| {
            settings::menu_item(SharedString::from(key), false, hover)
                .child(crate::ui::icon(glyph, 14.0, p.c(Token::MutedForeground)))
                .child(label)
        };
        let edit_path = path.clone();
        let reveal_path = path.clone();
        let new_path = path.clone();
        let menu = settings::popover(p)
            .absolute()
            .left(at.x)
            .top(at.y)
            .w(px(width))
            .child(item("pm-new", "message-square-plus", "新对话").on_click(
                cx.listener(move |this, _, _, cx| this.new_chat(Some(new_path.clone()), cx)),
            ))
            .child(
                item(
                    "pm-reveal",
                    "folder-root",
                    trs!(self.english(), "mod.show_in_file_manager"),
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.close_menus(cx);
                    cx.reveal_path(std::path::Path::new(&reveal_path));
                })),
            )
            .child(
                item(
                    "pm-edit",
                    "pencil-edit02",
                    trs!(self.english(), "mod.edit_project"),
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.open_project_dialog(Some(edit_path.clone()), window, cx)
                })),
            )
            .child(
                item(
                    "pm-remove",
                    "delete02",
                    trs!(self.english(), "mod.remove_project"),
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.confirm_remove_project(path.clone(), window, cx)
                })),
            );
        Some(crate::ui::float(menu).into_any_element())
    }

    fn any_menu_open(&self) -> bool {
        self.model_menu
            || self.thinking_menu
            || self.context_menu
            || self.access_menu
            || self.approval_menu
            || self.project_menu
            || self.pane_menu.is_some()
            || self.entry_menu.is_some()
            || self.sidebar_menu.is_some()
            || self.thread_menu.is_some()
            || self.header_git.menu_at.is_some()
            || self.project_row_menu.is_some()
            || self.settings.as_ref().is_some_and(|s| {
                s.default_menu
                    || s.theme_menu.is_some()
                    || s.edit.as_ref().is_some_and(|e| e.protocol_menu)
                    || s.add.as_ref().is_some_and(|a| a.protocol_menu)
            })
    }

    fn close_menus(&mut self, cx: &mut Context<Self>) {
        self.pane_menu = None;
        self.entry_menu = None;
        self.sidebar_menu = None;
        self.model_menu = false;
        self.thinking_menu = false;
        self.context_menu = false;
        self.access_menu = false;
        self.approval_menu = false;
        self.project_menu = false;
        self.thread_menu = None;
        self.header_git.menu_at = None;
        self.project_row_menu = None;
        if let Some(s) = &mut self.settings {
            s.default_menu = false;
            s.default_thinking_menu = false;
            s.theme_menu = None;
            if let Some(e) = &mut s.edit {
                e.protocol_menu = false;
            }
            if let Some(a) = &mut s.add {
                a.protocol_menu = false;
            }
        }
        cx.notify();
    }

    /// Open 设置 at a section (the capture flow and the composer's 管理模型 use it).
    pub fn show_settings(
        &mut self,
        section: settings::Section,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.open_settings(section, window, cx);
    }

    pub fn show_search(&mut self, query: String, window: &mut Window, cx: &mut Context<Self>) {
        self.open_palette(window, cx);
        if let Some(input) = self.search_box.clone() {
            input.update(cx, |st, cx| st.set_value(query, window, cx));
        }
    }

    pub fn show_context_menu(&mut self, cx: &mut Context<Self>) {
        self.close_menus(cx);
        self.context_menu = true;
        cx.notify();
    }

    /// Dev only: open the first project row's menu, to look at what it holds.
    pub fn show_project_row_menu(&mut self, cx: &mut Context<Self>) {
        self.close_menus(cx);
        let path = self
            .projects
            .first()
            .map(|p| p.path.clone())
            .unwrap_or_else(|| "/tmp".into());
        self.project_row_menu = Some((path, point(px(150.0), px(180.0))));
        cx.notify();
    }

    /// Dev only: open every fold, thought and tool call, to look at what is inside.
    pub fn expand_all(&mut self, cx: &mut Context<Self>) {
        for view in self.views.values() {
            for turn in &view.turns {
                self.open_folds.insert(turn.id.clone());
                for item in &turn.items {
                    self.open_items
                        .insert(crate::view_model::item_id(item).to_string());
                }
            }
        }
        cx.notify();
    }

    /// Dev only: open the search.
    pub fn show_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open_palette(window, cx);
    }

    /// Dev only: open the composer's model list, to look at a popup.
    pub fn show_model_menu(&mut self, cx: &mut Context<Self>) {
        self.model_menu = true;
        self.thinking_menu = false;
        cx.notify();
    }

    /// Dev only: open the composer's model list and thinking submenu.
    pub fn show_thinking_menu(&mut self, cx: &mut Context<Self>) {
        self.model_menu = true;
        self.thinking_menu = true;
        cx.notify();
    }

    /// `--settings providers` / `--settings add-provider`, for the capture flow.
    pub fn show_settings_named(&mut self, name: &str, window: &mut Window, cx: &mut Context<Self>) {
        match name {
            "providers" => self.open_settings(settings::Section::Providers, window, cx),
            // Dev capture: the session-model menu with its reasoning flyout open.
            "providers-thinking" => {
                self.open_settings(settings::Section::Providers, window, cx);
                if let Some(s) = &mut self.settings {
                    s.default_menu = true;
                    s.default_thinking_menu = true;
                }
            }
            "archived" => self.open_settings(settings::Section::Archived, window, cx),
            "add-provider" => {
                self.open_settings(settings::Section::Providers, window, cx);
                self.open_add_provider(window, cx);
            }
            _ => self.open_settings(settings::Section::General, window, cx),
        }
    }

    /// Open a conversation by id once the list has loaded (used by the capture flow).
    pub fn open(&mut self, id: ThreadId, cx: &mut Context<Self>) {
        self.select(id, cx);
    }

    // ---- talking to the server

    /// A project's name as the user knows it: the one they gave it, else its folder's.
    pub(super) fn project_label(&self, path: &str) -> String {
        self.projects
            .iter()
            .find(|p| p.path == path)
            .map(|p| p.name.clone())
            .unwrap_or_else(|| transcript::project_name(path).to_string())
    }

    fn refresh_app_settings(&mut self, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        let call = b.call::<SettingsGet>(Empty {});
        let epoch = self.app_settings_epoch;
        cx.spawn(async move |this, cx| {
            if let Ok(s) = call.await {
                this.update(cx, |this, cx| {
                    if this.app_settings_epoch != epoch {
                        return;
                    }
                    this.observe_personalization(&s.custom_system_prompt);
                    this.app_settings = s;
                    this.appearance_dirty = true;
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
    }

    /// Change a shared appearance setting: shown at once, then told to the server.
    pub(super) fn patch_settings(&mut self, patch: AppSettingsPatch, cx: &mut Context<Self>) {
        self.app_settings_epoch = self.app_settings_epoch.wrapping_add(1);
        self.appearance_dirty |= patch.theme_mode.is_some()
            || patch.light_theme.is_some()
            || patch.dark_theme.is_some()
            || patch.glass.is_some();
        self.app_settings.apply(patch.clone());
        cx.notify();
        let Some(b) = self.backend.clone() else {
            return;
        };
        let call = b.call::<SettingsSet>(patch);
        cx.spawn(async move |this, cx| {
            if let Err(e) = call.await {
                this.update(cx, |this, cx| {
                    this.sidebar_notice =
                        Some(tr!(this.english(), "mod.could_not_save_settings_e", e = e));
                    this.refresh_app_settings(cx);
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
    }

    /// Paint the whole app from `app_settings`: the theme and mode, and the window's blur.
    fn apply_appearance(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let prefs = fv_theme::Preferences {
            mode: match self.app_settings.theme_mode {
                ThemeMode::Light => fv_theme::ThemeMode::Light,
                ThemeMode::Dark => fv_theme::ThemeMode::Dark,
                ThemeMode::System => fv_theme::ThemeMode::System,
            },
            light_theme: self.app_settings.light_theme.clone(),
            dark_theme: self.app_settings.dark_theme.clone(),
            glass: self.app_settings.glass,
        };
        let palette = Palette::new(prefs.resolve(self.system_dark, cfg!(target_os = "macos")));
        crate::theme::apply(&palette, cx);
        window.set_background_appearance(crate::vibrancy::background(palette.glass()));
        crate::vibrancy::set(window, palette.glass());
        self.palette = palette;
        cx.notify();
    }

    fn refresh_projects(&mut self, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        let call = b.call::<ProjectList>(Empty {});
        cx.spawn(async move |this, cx| {
            if let Ok(r) = call.await {
                this.update(cx, |this, cx| {
                    this.projects = r.projects;
                    this.refresh_skills(cx);
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
    }

    pub(super) fn remove_project(&mut self, path: String, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        self.project_row_menu = None;
        self.projects.retain(|p| p.path != path);
        if self.draft_project.as_deref() == Some(path.as_str()) {
            self.draft_project = None;
        }
        cx.notify();
        let call = b.call::<ProjectRemove>(ProjectPathParams { path });
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |this, cx| {
                if let Err(e) = result {
                    this.sidebar_notice = Some(tr!(
                        this.english(),
                        "mod.could_not_remove_the_project",
                        e = e
                    ));
                }
                this.refresh_projects(cx);
            })
            .ok();
        })
        .detach();
    }

    /// Rename, archive or pin a thread.
    pub(super) fn update_thread(&mut self, patch: ThreadUpdateParams, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        // The row changes at once; the server's answer and the catalog push confirm it.
        if let Some(t) = self.threads.iter_mut().find(|t| t.id == patch.thread_id) {
            if let Some(title) = &patch.title {
                t.title = title.trim().to_string();
            }
            if let Some(a) = patch.archived {
                t.archived = a;
            }
            if let Some(p) = patch.pinned {
                t.pinned = p;
            }
        }
        if patch.archived == Some(true) && self.selected.as_ref() == Some(&patch.thread_id) {
            self.selected = None;
        }
        cx.notify();
        let call = b.call::<ThreadUpdate>(patch);
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |this, cx| {
                if let Err(e) = result {
                    this.sidebar_notice =
                        Some(tr!(this.english(), "mod.could_not_update_the_chat", e = e));
                }
                this.refresh_threads(cx);
                this.refresh_archived(cx);
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn delete_thread(&mut self, id: ThreadId, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        self.views.remove(&id);
        if self.selected.as_ref() == Some(&id) {
            self.selected = None;
        }
        self.threads.retain(|t| t.id != id);
        cx.notify();
        let call = b.call::<ThreadDelete>(ThreadIdParams {
            thread_id: id.clone(),
        });
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |this, cx| {
                if let Err(e) = result {
                    this.sidebar_notice =
                        Some(tr!(this.english(), "mod.could_not_delete_the_chat", e = e));
                } else {
                    this.forget_pane(&id, cx);
                }
                this.refresh_threads(cx);
                this.refresh_archived(cx);
            })
            .ok();
        })
        .detach();
    }

    /// Start renaming a row in place: an input holding the current title, taken on Enter.
    pub(super) fn begin_rename(
        &mut self,
        id: ThreadId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(title) = self
            .threads
            .iter()
            .find(|t| t.id == id)
            .map(|t| t.title.clone())
        else {
            return;
        };
        let input = cx.new(|cx| InputState::new(window, cx));
        input.update(cx, |st, cx| {
            st.set_value(title, window, cx);
            st.focus(window, cx);
        });
        let target = id.clone();
        cx.subscribe_in(
            &input,
            window,
            move |this, input, ev: &InputEvent, _, cx| match ev {
                InputEvent::PressEnter { .. } => {
                    let title = input.read(cx).value().trim().to_string();
                    this.rename = None;
                    if !title.is_empty() {
                        this.update_thread(
                            ThreadUpdateParams {
                                thread_id: target.clone(),
                                title: Some(title),
                                archived: None,
                                pinned: None,
                            },
                            cx,
                        );
                    }
                    cx.notify();
                }
                // Leaving the field saves what is in it: an empty title is a cancel, not a
                // rename to nothing.
                InputEvent::Blur if this.rename.as_ref().is_some_and(|(id, _)| id == &target) => {
                    let title = input.read(cx).value().trim().to_string();
                    this.rename = None;
                    if !title.is_empty() {
                        this.update_thread(
                            ThreadUpdateParams {
                                thread_id: target.clone(),
                                title: Some(title),
                                archived: None,
                                pinned: None,
                            },
                            cx,
                        );
                    }
                    cx.notify();
                }
                _ => {}
            },
        )
        .detach();
        self.rename = Some((id, input));
        self.thread_menu = None;
        cx.notify();
    }

    fn refresh_all(&mut self, cx: &mut Context<Self>) {
        self.refresh_app_settings(cx);
        self.refresh_subagents(cx);
        self.refresh_schedules(cx);
        // Settings may have been opened before the server answered.
        if self.settings.is_some() {
            self.refresh_providers(cx);
            self.refresh_archived(cx);
            self.refresh_roles(cx);
        }
        self.refresh_threads(cx);
        self.refresh_projects(cx);
        self.refresh_models(cx);
    }

    fn refresh_threads(&mut self, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        let call = b.call::<ThreadList>(ThreadListParams {
            include_archived: false,
        });
        cx.spawn(async move |this, cx| {
            let r = call.await;
            if let Ok(list) = r {
                this.update(cx, |this, cx| {
                    this.threads = list.threads;
                    this.threads
                        .sort_by_key(|t| std::cmp::Reverse(t.updated_at));
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
    }

    fn refresh_models(&mut self, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        self.model_request = self.model_request.wrapping_add(1);
        let request = self.model_request;
        let models = b.call::<ModelList>(Empty {});
        let defaults = b.call::<ModelDefaultsGet>(Empty {});
        cx.spawn(async move |this, cx| {
            let models = models.await.ok();
            let defaults = defaults.await.ok();
            this.update(cx, |this, cx| {
                if this.model_request != request {
                    return;
                }
                if let Some(m) = models {
                    this.models = m.models;
                }
                if let Some(d) = defaults {
                    this.defaults = d;
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn select(&mut self, id: ThreadId, cx: &mut Context<Self>) {
        self.schedules_ui.open = false;
        if self
            .search_target
            .as_ref()
            .is_some_and(|(target, _)| target != &id)
        {
            self.search_target = None;
            self.search_jump_pending = false;
        }
        self.navigation
            .visit(self.selected.clone(), Some(id.clone()));
        self.cancel_terminal_compositions(cx);
        self.selected = Some(id.clone());
        self.dock_badge = 0;
        crate::dock::set(0);
        self.subagents.open = None;
        self.refresh_subagents(cx);
        self.close_menus(cx);
        // A pending edit belongs to the conversation it was started in; switching away abandons
        // it rather than silently rewriting a turn in the chat the user just opened. The words
        // stay in the composer — they are still what the user typed.
        self.cancel_edit(cx);
        cx.notify();
        self.load_view(id, cx);
    }

    fn load_view(&mut self, id: ThreadId, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        let call = b.call::<ThreadResume>(ThreadIdParams {
            thread_id: id.clone(),
        });
        cx.spawn(async move |this, cx| {
            if let Ok(snapshot) = call.await {
                this.update(cx, |this, cx| {
                    let mut view = ThreadView::from_snapshot(snapshot);
                    if let Some(old) = this.views.get(&id) {
                        view.questions = old.questions.clone();
                        view.approvals = old.approvals.clone();
                    }
                    let (mine, rest): (Vec<_>, Vec<_>) =
                        std::mem::take(&mut this.pending_questions)
                            .into_iter()
                            .partition(|(_, q)| q.thread_id == id);
                    this.pending_questions = rest;
                    for (rid, q) in mine {
                        view.ask(rid, q);
                    }
                    let (mine, rest): (Vec<_>, Vec<_>) =
                        std::mem::take(&mut this.pending_approvals)
                            .into_iter()
                            .partition(|(_, a)| a.thread_id == id);
                    this.pending_approvals = rest;
                    for (rid, a) in mine {
                        view.ask_approval(rid, a);
                    }
                    if let Some((target, query)) = &this.search_target
                        && target == &id
                        && this.selected.as_ref() == Some(&id)
                        && let Some(turn) =
                            view.turns.iter().find(|t| palette::turn_matches(t, query))
                    {
                        this.open_folds.insert(turn.id.clone());
                        for item in &turn.items {
                            if matches!(item, Item::ToolCall { .. }) {
                                this.open_items
                                    .insert(crate::view_model::item_id(item).to_string());
                                this.open_items
                                    .insert(format!("run:{}", crate::view_model::item_id(item)));
                            }
                        }
                        this.search_jump_pending = true;
                    }
                    this.views.insert(id, view);
                    this.stick_to_bottom = !this.search_jump_pending;
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
    }

    fn on_event(&mut self, event: BackendEvent, cx: &mut Context<Self>) {
        match event {
            BackendEvent::Connected { version_mismatch } => {
                self.invalidate_provider_checks();
                self.refresh_mcp(cx);
                self.refresh_skills(cx);
                self.invalidate_skill_picker(cx);
                if let Some(settings) = &mut self.settings {
                    settings.memory = Default::default();
                }
                self.refresh_memory(cx);
                self.refresh_usage(cx);
                self.refresh_about(cx);
                if version_mismatch {
                    self.sidebar_notice =
                        Some(trs!(self.english(), "mod.the_app_update_is_not").into());
                    cx.notify();
                }
            }
            BackendEvent::Failed(message) => {
                self.invalidate_provider_checks();
                self.status = Status::Failed(message);
                cx.notify();
            }
            BackendEvent::Request(ServerRequest::UserInput { id, params }) => {
                let thread = params.thread_id.clone();
                match self.views.get_mut(&thread) {
                    Some(view) => view.ask(id, params),
                    None => {
                        // Not loaded yet: load it, then ask again from the snapshot's side.
                        self.load_view(thread.clone(), cx);
                        self.pending_questions.push((id, params));
                    }
                }
                cx.notify();
            }
            BackendEvent::Request(ServerRequest::Approval { id, params }) => {
                let thread = params.thread_id.clone();
                match self.views.get_mut(&thread) {
                    Some(view) => view.ask_approval(id, params),
                    None => {
                        self.load_view(thread.clone(), cx);
                        self.pending_approvals.push((id, params));
                    }
                }
                cx.notify();
            }
            BackendEvent::Notification(note) => {
                match &note {
                    ServerNotification::ThreadStarted(_)
                    | ServerNotification::CatalogChanged(_) => {
                        self.refresh_threads(cx);
                        self.refresh_projects(cx);
                        self.refresh_archived(cx);
                        self.refresh_usage(cx);
                    }
                    ServerNotification::SettingsChanged(s) => {
                        self.app_settings_epoch = self.app_settings_epoch.wrapping_add(1);
                        self.observe_personalization(&s.custom_system_prompt);
                        self.appearance_dirty |= self.app_settings.theme_mode != s.theme_mode
                            || self.app_settings.light_theme != s.light_theme
                            || self.app_settings.dark_theme != s.dark_theme
                            || self.app_settings.glass != s.glass;
                        self.app_settings = s.clone();
                    }
                    ServerNotification::ProvidersChanged(_) => {
                        self.invalidate_provider_checks();
                        self.refresh_model_detail(cx);
                        self.refresh_usage(cx);
                        self.refresh_models(cx);
                        if self.settings.is_some() {
                            self.refresh_providers(cx);
                        }
                    }
                    ServerNotification::SkillsChanged(_) => {
                        self.refresh_skills(cx);
                        self.invalidate_skill_picker(cx);
                    }
                    ServerNotification::SubagentRolesChanged(_) => self.refresh_roles(cx),
                    ServerNotification::SubagentsChanged(_) => self.refresh_subagents(cx),
                    ServerNotification::SchedulesChanged(_) => self.refresh_schedules(cx),
                    ServerNotification::McpChanged(_) => {
                        self.refresh_mcp(cx);
                        self.refresh_roles(cx);
                    }
                    ServerNotification::ModelCatalogChanged(_) => {
                        self.invalidate_provider_checks();
                        self.refresh_about(cx);
                        self.refresh_model_detail(cx);
                    }
                    ServerNotification::UsageChanged(_) => self.refresh_usage(cx),
                    ServerNotification::MemoryChanged(state) => {
                        self.memory_changed(state.clone(), cx)
                    }
                    ServerNotification::TurnCompleted(event)
                        if self.selected.as_deref() != Some(event.thread_id.as_str()) =>
                    {
                        self.dock_badge = self.dock_badge.saturating_add(1);
                        crate::dock::set(self.dock_badge);
                        self.sidebar_notice = Some(match event.body.status {
                            TurnStatus::Completed => {
                                trs!(self.english(), "mod.a_background_chat_finished").into()
                            }
                            TurnStatus::Interrupted => {
                                trs!(self.english(), "mod.a_background_chat_stopped").into()
                            }
                            TurnStatus::Failed => event
                                .body
                                .error
                                .clone()
                                .map(|error| {
                                    tr!(
                                        self.english(),
                                        "mod.a_background_chat_failed_error",
                                        error = error
                                    )
                                })
                                .unwrap_or_else(|| {
                                    trs!(self.english(), "mod.a_background_chat_failed").into()
                                }),
                        });
                    }
                    ServerNotification::WorkspaceEntryChanged(change) => {
                        self.on_entry_changed(change, cx)
                    }
                    _ => {}
                }
                let mut gap = Vec::new();
                for (id, view) in self.views.iter_mut() {
                    if view.apply(&note) == Applied::Gap {
                        gap.push(id.clone());
                    }
                }
                for id in gap {
                    self.load_view(id, cx);
                }
                if matches!(
                    note,
                    ServerNotification::ThreadStatusChanged(_)
                        | ServerNotification::TurnCompleted(_)
                ) {
                    self.refresh_threads(cx);
                }
                if self.search_target.is_none() {
                    self.scroll.scroll_to_bottom();
                }
                self.sync_suggestion();
                cx.notify();
            }
        }
    }

    pub(super) fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let english = self.english();
        if self.entry_dialog.is_some() || self.schedules_ui.open {
            return;
        }
        let text = self.input.read(cx).value().trim().to_string();
        if text.is_empty() {
            return;
        }
        // Editing a turn is a rewrite of it: the reply it produced is discarded and the corrected
        // words run in its place. It cannot be an ordinary send — that would put the correction
        // after the answer it was meant to replace.
        if let Some(turn_id) = self.editing_turn.clone() {
            let (Some(b), Some(id)) = (self.backend.clone(), self.selected.clone()) else {
                return;
            };
            if self.palette_blocked() {
                return;
            }
            self.input
                .update(cx, |state, cx| state.set_value("", window, cx));
            self.editing_turn = None;
            self.notice = None;
            let handle_input = self.input.clone();
            let window_handle = window.window_handle();
            cx.spawn(async move |this, cx| {
                let result = b
                    .call::<TurnRewind>(TurnRewindParams {
                        thread_id: id,
                        turn_id,
                        text: Some(text.clone()),
                        // An edit is about the words; the files the turn changed are the user's
                        // to keep until they ask otherwise.
                        rewind_files: false,
                    })
                    .await;
                if let Err(e) = result {
                    let _ = cx.update_window(window_handle, |_, window, cx| {
                        handle_input.update(cx, |st, cx| {
                            st.set_value(crate::skill_draft::content(text.clone()), window, cx)
                        });
                    });
                    this.update(cx, |this, cx| {
                        this.fail(tr!(this.english(), "mod.could_not_resend_e", e = e), cx);
                        cx.notify();
                    })
                    .ok();
                }
            })
            .detach();
            return;
        }
        // A reply in flight does not block the composer. What happens to the words is codex's
        // order: steer the live run first, and only fall back to the queue when there is no run
        // to steer. Steering is the better default because the model's next decision already
        // contains the correction; queueing waits until it has finished doing it wrong.
        if let Some(id) = self.selected.clone()
            && self.views.get(&id).is_some_and(|v| v.running)
        {
            let Some(b) = self.backend.clone() else {
                return;
            };
            // No live turn id means the reply is in its last instant (or a queued prompt is
            // about to start): there is nothing to steer, so the words go to the queue.
            let Some(expected) = self.views.get(&id).and_then(|v| v.running_turn()) else {
                self.queue_while_running(id, text, window, cx);
                return;
            };
            self.input
                .update(cx, |state, cx| state.set_value("", window, cx));
            self.notice = None;
            let sent_text = self.prompt_with_attachments(&text);
            let handle_input = self.input.clone();
            let window_handle = window.window_handle();
            cx.spawn(async move |this, cx| {
                let steered = b
                    .call::<TurnSteer>(TurnSteerParams {
                        thread_id: id.clone(),
                        expected_turn_id: expected,
                        text: sent_text.clone(),
                    })
                    .await;
                let reason = match steered {
                    Ok(_) => return,
                    // Nothing is running any more: the words become the next prompt, not an
                    // error the user has to retype.
                    Err(fv_client::ClientError::Rpc(e))
                        if e.code == fv_protocol::jsonrpc::code::NO_ACTIVE_TURN =>
                    {
                        None
                    }
                    Err(e) => Some(tr!(english, "mod.could_not_steer_the_reply", e = e)),
                };
                let queued = b
                    .call::<TurnEnqueue>(TurnEnqueueParams {
                        thread_id: id,
                        text: sent_text.clone(),
                    })
                    .await;
                if let Err(e) = queued {
                    let _ = cx.update_window(window_handle, |_, window, cx| {
                        handle_input.update(cx, |st, cx| {
                            st.set_value(crate::skill_draft::content(text.clone()), window, cx)
                        });
                    });
                    this.update(cx, |this, cx| {
                        this.fail(
                            tr!(this.english(), "mod.could_not_queue_the_message", e = e),
                            cx,
                        );
                        cx.notify();
                    })
                    .ok();
                } else if let Some(reason) = reason {
                    // Steering was refused for a reason other than "it just ended": say so, and
                    // that the words are at least queued.
                    this.update(cx, |this, cx| {
                        this.fail(
                            tr!(this.english(), "mod.reason_queued_instead", reason = reason),
                            cx,
                        );
                        cx.notify();
                    })
                    .ok();
                }
            })
            .detach();
            return;
        }
        if self.palette_blocked() {
            return;
        }
        let Some(b) = self.backend.clone() else {
            return;
        };
        // Nothing can be answered without a model: say so, and keep what was typed.
        if self.models.is_empty() && !self.skip_model_check {
            self.fail(trs!(english, "mod.no_model_is_available_yet"), cx);
            cx.notify();
            return;
        }
        self.input
            .update(cx, |state, cx| state.set_value("", window, cx));
        self.notice = None;
        self.search_target = None;
        let selected = self.selected.clone();
        let pending_model = self.pending_model.clone();
        let pending_thinking = self.pending_thinking;
        let project = self.draft_project.clone();
        let no_model = self.defaults.model.is_none() && pending_model.is_none();
        // The files picked with `@` are consumed by the send, whether or not it succeeds: a
        // failed send restores the words, and the reference block is appended again next time.
        // Files picked with `@` travel as a reference block, the way the Electron composer sends
        // them: the model is given paths it can open, and the reader's own sentence stays as they
        // typed it. Built before the spawn because it consumes the attachment list.
        let sent_text = self.prompt_with_attachments(&text);
        let handle_input = self.input.clone();
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            // A send that did not go through puts the words back and says why.
            let fail = |why: String, text: String, this: &WeakEntity<Self>, cx: &mut AsyncApp| {
                let _ = cx.update_window(window_handle, |_, window, cx| {
                    handle_input.update(cx, |st, cx| {
                        st.set_value(crate::skill_draft::content(text), window, cx)
                    });
                });
                this.update(cx, |this, cx| {
                    this.fail(why, cx);
                    cx.notify();
                })
                .ok();
            };
            let id = match selected {
                Some(id) => id,
                None => {
                    // Without a project the server gives the conversation a scratch folder.
                    let started = b
                        .call::<ThreadStart>(ThreadStartParams {
                            cwd: project.clone(),
                            project,
                            model: pending_model,
                            thinking: pending_thinking,
                        })
                        .await;
                    let started = match started {
                        Ok(s) => s,
                        Err(e) => {
                            return fail(
                                tr!(english, "mod.could_not_create_a_chat", e = e),
                                text,
                                &this,
                                cx,
                            );
                        }
                    };
                    let id = started.thread.id.clone();
                    let snapshot = b
                        .call::<ThreadResume>(ThreadIdParams {
                            thread_id: id.clone(),
                        })
                        .await;
                    let snapshot = match snapshot {
                        Ok(s) => s,
                        Err(e) => {
                            return fail(
                                tr!(english, "mod.could_not_open_the_chat", e = e),
                                text,
                                &this,
                                cx,
                            );
                        }
                    };
                    this.update(cx, |this, cx| {
                        pane_web::promote_draft(&mut this.panes, &id);
                        this.navigation
                            .visit(this.selected.clone(), Some(id.clone()));
                        this.selected = Some(id.clone());
                        this.pending_model = None;
                        this.pending_thinking = None;
                        this.views
                            .insert(id.clone(), ThreadView::from_snapshot(snapshot));
                        cx.notify();
                    })
                    .ok();
                    id
                }
            };
            let sent = sent_text.clone();
            let started = b
                .call::<TurnStart>(TurnStartParams {
                    thread_id: id,
                    text: sent,
                })
                .await;
            if let Err(e) = started {
                let why = if no_model {
                    trs!(english, "mod.no_model_is_available_yet").to_string()
                } else {
                    tr!(english, "mod.send_failed_e", e = e)
                };
                fail(why, text, &this, cx);
            }
        })
        .detach();
    }

    /// Bind this conversation to its own checkout, so an experiment does not dirty the tree the
    /// user is working in. The branch and path are the app's to choose; 更多 options come later.
    fn create_worktree(&mut self, id: String, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        cx.spawn(async move |this, cx| {
            let result = b
                .call::<ThreadWorktreeCreate>(ThreadWorktreeCreateParams {
                    thread_id: id.clone(),
                    path: None,
                    branch: None,
                    label: None,
                })
                .await;
            this.update(cx, |this, cx| {
                match result {
                    Ok(answer) => {
                        this.apply_worktree(answer.thread);
                        this.done(trs!(this.english(), "mod.isolated_workspace_created"), cx);
                    }
                    Err(e) => this.fail(
                        tr!(this.english(), "mod.could_not_create_the_isolated", e = e),
                        cx,
                    ),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Return to the project. The checkout stays on disk: an experiment's diff may still be worth
    /// reading, and deleting a directory is not something an "unbind" row should do quietly.
    fn unbind_worktree(&mut self, id: String, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        cx.spawn(async move |this, cx| {
            let result = b
                .call::<ThreadWorktreeUnbind>(ThreadWorktreeUnbindParams {
                    thread_id: id.clone(),
                    remove: false,
                })
                .await;
            this.update(cx, |this, cx| {
                match result {
                    Ok(answer) => {
                        this.apply_worktree(answer.thread);
                        this.done(trs!(this.english(), "mod.back_in_the_project_folder"), cx);
                    }
                    Err(e) => this.fail(
                        tr!(this.english(), "mod.could_not_unbind_the_isolated", e = e),
                        cx,
                    ),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Take a thread the server just changed into the list and the open view.
    fn apply_worktree(&mut self, thread: fv_protocol::types::Thread) {
        if let Some(slot) = self.threads.iter_mut().find(|t| t.id == thread.id) {
            *slot = thread.clone();
        }
        if let Some(view) = self.views.get_mut(&thread.id) {
            view.thread = thread;
        }
    }

    // ---- what a message's hover row can do

    fn copy_text(&mut self, text: String, cx: &mut Context<Self>) {
        cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(text));
        cx.notify();
    }

    /// 重试: ask for that turn again. Its reply is discarded and the same prompt re-sent, which
    /// is the whole meaning of "run this again" in a conversation.
    ///
    /// The workspace is the other half of the question. A retry that leaves the tree alone runs
    /// the prompt against whatever the abandoned attempt already changed — it reads edited files,
    /// or its patch finds the change applied and does nothing — and either way the transcript
    /// looks right. So the user is asked, and "keep my files" is a real answer: they may have
    /// edited things by hand since the prompt.
    fn retry(&mut self, turn_id: String, window: &mut Window, cx: &mut Context<Self>) {
        let answer = window.prompt(
            PromptLevel::Info,
            trs!(self.english(), "mod.retry_this_turn"),
            Some(trs!(self.english(), "mod.this_turn_s_reply_will")),
            &[
                PromptButton::cancel(trs!(self.english(), "mod.cancel")),
                PromptButton::ok(trs!(self.english(), "mod.keep_file_changes")),
                PromptButton::ok(trs!(self.english(), "mod.roll_back_files_and_retry")),
            ],
            cx,
        );
        cx.spawn(async move |this, cx| {
            let Ok(choice) = answer.await else {
                return;
            };
            match choice {
                1 | 2 => {
                    this.update(cx, |this, cx| {
                        this.rewind_turn(turn_id, choice == 2, cx);
                    })
                    .ok();
                }
                _ => {}
            }
        })
        .detach();
    }

    /// The call behind 重试: re-run the turn, with or without putting the workspace back.
    fn rewind_turn(&mut self, turn_id: String, rewind_files: bool, cx: &mut Context<Self>) {
        let (Some(b), Some(id)) = (self.backend.clone(), self.selected.clone()) else {
            return;
        };
        cx.spawn(async move |this, cx| {
            let result = b
                .call::<TurnRewind>(TurnRewindParams {
                    thread_id: id,
                    turn_id,
                    text: None,
                    rewind_files,
                })
                .await;
            match result {
                Ok(answer) => {
                    this.update(cx, |this, cx| {
                        // A rewind that could not put everything back has to say so: the retry is
                        // running, and the tree is only partly where it was.
                        let files = answer.files;
                        if !files.skipped.is_empty() {
                            let names: Vec<&str> = files
                                .skipped
                                .iter()
                                .map(|s| s.path.as_str())
                                .take(5)
                                .collect();
                            this.notice = Some(Notice::Partial(tr!(
                                this.english(),
                                "mod.files_could_not_be_rolled",
                                count = files.skipped.len(),
                                names = names.join("、")
                            )));
                        } else if rewind_files && files.had_checkpoint {
                            this.done(
                                tr!(
                                    this.english(),
                                    "mod.workspace_rolled_back_files_restored",
                                    restored = files.restored,
                                    removed = files.removed
                                ),
                                cx,
                            );
                        }
                        cx.notify();
                    })
                    .ok();
                }
                Err(e) => {
                    this.update(cx, |this, cx| {
                        this.fail(tr!(this.english(), "mod.could_not_retry_e", e = e), cx);
                        cx.notify();
                    })
                    .ok();
                }
            }
        })
        .detach();
    }

    /// 编辑: put the turn's words back in the composer, and remember which turn they came from.
    /// Sending them rewrites that turn instead of adding a new one — otherwise the corrected
    /// prompt would land *after* the reply it was meant to replace.
    fn start_edit(
        &mut self,
        turn_id: String,
        text: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.input.update(cx, |state, cx| {
            state.set_value(crate::skill_draft::content(text), window, cx)
        });
        self.input.update(cx, |state, cx| state.focus(window, cx));
        self.editing_turn = Some(turn_id);
        self.notice = None;
        cx.notify();
    }

    /// The composer's own 取消, which lives in another module.
    pub(super) fn cancel_edit_public(&mut self, cx: &mut Context<Self>) {
        self.cancel_edit(cx);
    }

    /// Leave edit mode: the words stay in the composer, they just stop rewriting a turn.
    pub(super) fn cancel_edit(&mut self, cx: &mut Context<Self>) {
        if self.editing_turn.take().is_some() {
            cx.notify();
        }
    }

    /// Esc leaves edit mode before it closes anything else: what the composer would do next is
    /// the most immediate thing on screen.
    fn editing(&self) -> bool {
        self.editing_turn.is_some()
    }

    /// Show or hide the right pane.
    pub(super) fn toggle_side_pane(&mut self, cx: &mut Context<Self>) {
        self.side_pane_collapsed = !self.side_pane_collapsed;
        self.side_pane_maximized = false;
        self.pane_menu = None;
        cx.notify();
    }

    /// Say something failed, and redraw.
    fn fail(&mut self, text: impl Into<String>, cx: &mut Context<Self>) {
        self.notice = Some(Notice::Failed(text.into()));
        cx.notify();
    }

    /// Say something happened that the user should know, without calling it a problem.
    fn done(&mut self, text: impl Into<String>, cx: &mut Context<Self>) {
        self.notice = Some(Notice::Done(text.into()));
        cx.notify();
    }

    /// Put the words behind the reply in flight, for a run that cannot be steered into.
    fn queue_while_running(
        &mut self,
        id: String,
        text: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        self.input
            .update(cx, |state, cx| state.set_value("", window, cx));
        self.notice = None;
        let sent_text = self.prompt_with_attachments(&text);
        let handle_input = self.input.clone();
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let result = b
                .call::<TurnEnqueue>(TurnEnqueueParams {
                    thread_id: id,
                    text: sent_text.clone(),
                })
                .await;
            if let Err(e) = result {
                let _ = cx.update_window(window_handle, |_, window, cx| {
                    handle_input.update(cx, |st, cx| {
                        st.set_value(crate::skill_draft::content(text.clone()), window, cx)
                    });
                });
                this.update(cx, |this, cx| {
                    this.fail(
                        tr!(this.english(), "mod.could_not_queue_the_message", e = e),
                        cx,
                    );
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
    }

    // ---- the queue behind the reply in flight

    fn queue_remove(&mut self, item_id: String, cx: &mut Context<Self>) {
        let (Some(b), Some(id)) = (self.backend.clone(), self.selected.clone()) else {
            return;
        };
        cx.spawn(async move |_, _| {
            let _ = b
                .call::<TurnQueueRemove>(QueueItemParams {
                    thread_id: id,
                    item_id,
                })
                .await;
        })
        .detach();
    }

    fn queue_send_now(&mut self, item_id: String, cx: &mut Context<Self>) {
        let (Some(b), Some(id)) = (self.backend.clone(), self.selected.clone()) else {
            return;
        };
        cx.spawn(async move |this, cx| {
            let result = b
                .call::<TurnQueueSendNow>(QueueItemParams {
                    thread_id: id,
                    item_id,
                })
                .await;
            if let Err(e) = result {
                this.update(cx, |this, cx| {
                    this.fail(tr!(this.english(), "mod.could_not_send_now_e", e = e), cx);
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
    }

    fn queue_resume(&mut self, cx: &mut Context<Self>) {
        let (Some(b), Some(id)) = (self.backend.clone(), self.selected.clone()) else {
            return;
        };
        cx.spawn(async move |_, _| {
            let _ = b
                .call::<TurnQueueResume>(ThreadIdParams { thread_id: id })
                .await;
        })
        .detach();
    }

    fn palette_blocked(&self) -> bool {
        self.backend.is_none()
            || self
                .selected
                .as_ref()
                .and_then(|id| self.views.get(id))
                .is_some_and(|v| v.running)
    }

    fn interrupt(&mut self, cx: &mut Context<Self>) {
        let (Some(b), Some(id)) = (self.backend.clone(), self.selected.clone()) else {
            return;
        };
        cx.spawn(async move |_, _| {
            let _ = b
                .call::<TurnInterrupt>(ThreadIdParams { thread_id: id })
                .await;
        })
        .detach();
    }

    fn explicit_thinking(&self) -> Option<ThinkingLevel> {
        match self.selected.as_ref() {
            Some(id) => self.views.get(id).and_then(|v| v.thread.thinking),
            None => self.pending_thinking,
        }
    }

    fn current_thinking(&self) -> Option<ThinkingLevel> {
        let requested = self.explicit_thinking().or(self.defaults.thinking);
        self.current_model_label()
            .and_then(|l| self.models.iter().find(|m| m.label == l))
            .map_or(requested, |m| m.model.effective_thinking(requested))
    }

    fn pick_model(&mut self, label: String, cx: &mut Context<Self>) {
        // Changing the model must not silently reset the conversation's chosen effort.
        let thinking = self.explicit_thinking();
        self.thinking_menu = false;
        self.set_conversation_model(Some(label), thinking, cx);
    }

    fn pick_thinking(&mut self, thinking: Option<ThinkingLevel>, cx: &mut Context<Self>) {
        // Preserve an inherited model as inherited, so later default changes still apply.
        let model = match self.selected.as_ref().and_then(|id| self.views.get(id)) {
            Some(v) => v.thread.model.clone(),
            None => self.pending_model.clone(),
        };
        self.set_conversation_model(model, thinking, cx);
    }

    fn set_conversation_model(
        &mut self,
        model: Option<String>,
        thinking: Option<ThinkingLevel>,
        cx: &mut Context<Self>,
    ) {
        self.set_conversation_model_internal(model, thinking, true, cx);
    }

    fn set_conversation_model_internal(
        &mut self,
        model: Option<String>,
        thinking: Option<ThinkingLevel>,
        close_menu: bool,
        cx: &mut Context<Self>,
    ) {
        if close_menu {
            self.model_menu = false;
            self.thinking_menu = false;
        }
        let Some(id) = self.selected.clone() else {
            self.pending_model = model;
            self.pending_thinking = thinking;
            cx.notify();
            return;
        };
        let Some(b) = self.backend.clone() else {
            return;
        };
        let call = b.call::<ThreadModelSet>(ThreadModelParams {
            thread_id: id.clone(),
            model,
            thinking,
        });
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |this, cx| {
                match result {
                    Ok(r) => {
                        if let Some(v) = this.views.get_mut(&id) {
                            v.thread = r.thread.clone();
                        }
                        if let Some(t) = this.threads.iter_mut().find(|t| t.id == id) {
                            *t = r.thread;
                        }
                    }
                    Err(e) => this.fail(
                        tr!(this.english(), "mod.could_not_change_the_model", e = e),
                        cx,
                    ),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    fn compact(&mut self, cx: &mut Context<Self>) {
        self.context_menu = false;
        self.search_target = None;
        let (Some(b), Some(id)) = (self.backend.clone(), self.selected.clone()) else {
            return;
        };
        if self
            .views
            .get(&id)
            .is_none_or(|v| v.running || v.turns.is_empty())
            || !self.compact_pending.insert(id.clone())
        {
            return;
        }
        self.notice = None;
        let call = b.call::<ThreadCompactStart>(ThreadIdParams {
            thread_id: id.clone(),
        });
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |this, cx| {
                this.compact_pending.remove(&id);
                if let Err(e) = result {
                    this.fail(
                        tr!(this.english(), "mod.could_not_compact_the_context", e = e),
                        cx,
                    );
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// Answer an approval card: 允许 / 本次会话允许 / 拒绝.
    pub(super) fn decide(
        &mut self,
        id: RequestId,
        decision: ApprovalDecision,
        cx: &mut Context<Self>,
    ) {
        if let Some(b) = self.backend.clone() {
            let value = serde_json::to_value(ApprovalResponse { decision }).unwrap_or_default();
            b.respond(id.clone(), value);
        }
        // The card goes at once; the server's `resolved` confirms it for everyone else.
        for view in self.views.values_mut() {
            view.approvals.retain(|(i, _)| *i != id);
        }
        cx.notify();
    }

    // ---- what the model in force is called

    fn current_model_label(&self) -> Option<String> {
        let thread = self
            .selected
            .as_ref()
            .and_then(|id| self.views.get(id))
            .and_then(|v| v.thread.model.clone());
        thread
            .or_else(|| self.pending_model.clone())
            .or_else(|| self.defaults.model.clone())
    }
}

#[cfg(test)]
mod text_tests {
    use super::text;
    use fv_protocol::types::UiLanguage;

    #[test]
    fn translated_core_labels_have_stable_chinese_and_english_values() {
        assert_eq!(text::new_chat(UiLanguage::Chinese), "新对话");
        assert_eq!(text::new_chat(UiLanguage::English), "New chat");
        assert_eq!(text::placeholder(UiLanguage::Chinese), "随心输入");
        assert_eq!(text::placeholder(UiLanguage::English), "Ask anything");
        assert_eq!(text::pane_git(UiLanguage::Chinese), "变更");
        assert_eq!(text::pane_git(UiLanguage::English), "Changes");
        assert_eq!(text::working(UiLanguage::English), "Working");
    }
}

// ---- rendering

impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.web_drag_blocked = cx.has_active_drag();
        self.prepare_web_views(cx);
        self.sync_personalization_editor(window, cx);
        self.sync_model_editor(window, cx);
        self.sync_provider_key_clear(window, cx);
        self.sync_shortcut_input(cx);
        let terminal_visible = !self.side_pane_collapsed
            && self.settings.is_none()
            && self.search_box.is_none()
            && self.entry_dialog.is_none()
            && self
                .selected
                .as_ref()
                .and_then(|id| self.panes.get(id))
                .and_then(|pane| pane.active_tab())
                .is_some_and(|tab| matches!(tab.kind, pane::PaneTabKind::Terminal));
        if !terminal_visible && self.terminal_focus.is_focused(window) {
            self.input.update(cx, |input, cx| input.focus(window, cx));
        }
        self.sync_terminal_focus(window, cx);
        self.sync_header_git(cx);
        self.sync_header_git_input(window, cx);
        let english = self.app_settings.language == UiLanguage::English;
        if english != self.menu_english {
            self.menu_english = english;
            app_menu::install(cx, english);
        }
        if self.appearance_dirty {
            self.appearance_dirty = false;
            if self.live_appearance {
                self.apply_appearance(window, cx);
            }
        }
        let now = std::time::Instant::now();
        let viewport = f32::from(window.viewport_size().width);
        let sidebar_width = self.sidebar_resting_width(viewport);
        let sidebar_target = if let Some(drag) = self.sidebar_resize {
            drag.max(0.0)
        } else if self.app_settings.sidebar.collapsed {
            0.0
        } else {
            sidebar_width
        };
        let left_animating =
            self.sidebar_motion
                .update(sidebar_target, self.sidebar_resize.is_some(), now);
        let pane_target = if self.side_pane_collapsed {
            0.0
        } else if self.side_pane_maximized {
            (viewport - sidebar_target).max(0.0)
        } else {
            self.side_pane_resize
                .map(|w| w.max(0.0))
                .unwrap_or(self.side_pane_width.max(pane::MIN_WIDTH))
                .min((viewport * 0.65).max(pane::MIN_WIDTH))
                .min((viewport - self.sidebar_motion.width - 420.0).max(0.0))
        };
        let right_animating =
            self.pane_motion
                .update(pane_target, self.side_pane_resize.is_some(), now);
        if pane_target > 0.0 {
            let inset = if self.side_pane_maximized && !self.app_settings.sidebar.collapsed {
                8.0
            } else {
                16.0
            };
            self.pane_content_width = (pane_target - inset).max(0.0);
        }
        if left_animating || right_animating {
            window.request_animation_frame();
            cx.notify();
        }
        let sidebar_layout = (
            self.sidebar_resize
                .unwrap_or(self.app_settings.sidebar.width),
            self.app_settings.sidebar.collapsed,
        );
        if self.sidebar_layout != Some(sidebar_layout) {
            self.sidebar_layout = Some(sidebar_layout);
            // A peer can change the width too. Refresh all cached clipping regions once
            // layout has adopted the new width, even when no local pointer event occurs.
            window.on_next_frame(|window, _| window.refresh());
        }
        if !cx.has_active_drag() {
            self.sidebar_drop = None;
        }
        self.focus_pending(window, cx);
        // The handle only knows the content's height after a layout, so the jump to the end
        // waits for a frame that has one.
        if !self.schedules_ui.open && self.stick_to_bottom && self.scroll.max_offset().y > px(0.0) {
            self.scroll.scroll_to_bottom();
            self.stick_to_bottom = false;
        } else if !self.schedules_ui.open && self.stick_to_bottom {
            cx.notify();
        }
        if self.search_jump_pending {
            self.search_anchor.scroll_to(window, cx);
            self.search_jump_pending = false;
        }
        let p = self.palette.clone();
        let root = div()
            .relative()
            .size_full()
            .id("workspace-root")
            .on_mouse_move(cx.listener(|this, e: &MouseMoveEvent, window, cx| {
                this.terminal_drag_selection(e, cx);
                if this.side_pane_resize.is_some() && e.pressed_button == Some(MouseButton::Left) {
                    this.side_pane_resize = Some(
                        (f32::from(window.viewport_size().width)
                            - f32::from(e.position.x)
                            - this.pane_drag_offset)
                            .max(0.0),
                    );
                    cx.notify();
                }
                this.move_pane_splitter(e, window, cx);
                if this.sidebar_resize.is_some() {
                    if e.pressed_button == Some(MouseButton::Left) {
                        let max =
                            (f32::from(window.viewport_size().width) * 0.4).clamp(200.0, 480.0);
                        this.sidebar_resize = Some(
                            (f32::from(e.position.x) - this.sidebar_drag_offset).clamp(0.0, max),
                        );
                        window.refresh();
                        cx.notify();
                    } else {
                        this.finish_sidebar_resize(cx);
                        window.refresh();
                    }
                }
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _, window, cx| {
                    this.finish_terminal_selection();
                    this.finish_pane_resize(cx);
                    if this.sidebar_resize.is_some() {
                        this.finish_sidebar_resize(cx);
                        window.refresh();
                    }
                }),
            )
            .on_mouse_up_out(
                MouseButton::Left,
                cx.listener(|this, _, window, cx| {
                    this.finish_terminal_selection();
                    this.finish_pane_resize(cx);
                    if this.sidebar_resize.is_some() {
                        this.finish_sidebar_resize(cx);
                        window.refresh();
                    }
                }),
            )
            .key_context("Workspace")
            .capture_key_up(cx.listener(|this, event: &KeyUpEvent, _, _| {
                this.shortcuts.release(&event.keystroke.key)
            }))
            .on_action(cx.listener(Self::on_new_chat))
            .on_action(cx.listener(Self::on_open_settings))
            .on_action(cx.listener(Self::on_open_search))
            .on_action(cx.listener(|this, _: &app_menu::OpenAbout, window, cx| {
                this.open_settings(settings::Section::About, window, cx)
            }))
            .on_action(
                cx.listener(|_, _: &app_menu::MinimizeWindow, window, _| window.minimize_window()),
            )
            .on_action(cx.listener(|_, _: &app_menu::ZoomWindow, window, _| window.zoom_window()))
            .on_action(cx.listener(Self::on_dismiss))
            .on_action(cx.listener(Self::on_toggle_sidebar))
            .on_action(cx.listener(|this, _: &ToggleSidePane, _, cx| this.toggle_side_pane(cx)))
            .on_action(cx.listener(Self::on_go_back))
            .on_action(cx.listener(Self::on_go_forward))
            .on_action(cx.listener(Self::on_accept_suggestion))
            .on_action(cx.listener(Self::on_save_preview))
            .on_action(cx.listener(Self::on_browser_address))
            .on_action(cx.listener(Self::on_browser_reload))
            .on_action(cx.listener(Self::on_mention_up))
            .on_action(cx.listener(Self::on_mention_down))
            .on_action(cx.listener(Self::on_mention_dismiss))
            .on_action(cx.listener(Self::on_accept_skill))
            .font_family(crate::assets::UI_FONT)
            .bg(p.c(Token::Background))
            .text_color(p.c(Token::Foreground))
            .text_size(px(crate::ui::TEXT_SM));
        let root = if self.settings.is_some() {
            root.child(self.settings_view(window, cx))
        } else {
            let pane = if self.schedules_ui.open {
                None
            } else {
                self.side_pane(window, cx)
            };
            let content = if self.schedules_ui.open {
                self.schedules_page(cx)
            } else {
                self.main(window, cx).into_any_element()
            };
            root.child(
                div()
                    .size_full()
                    .flex()
                    .child(self.sidebar(window, cx))
                    .child(content)
                    .children(pane),
            )
        };
        // While a popup is open, a click anywhere else closes it. The catcher sits under the
        // popups (priority 10) and over everything else.
        let catcher = self.any_menu_open().then(|| {
            deferred(
                div()
                    .id("menu-catcher")
                    .absolute()
                    .inset_0()
                    .occlude()
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, _, _, cx| this.close_menus(cx)),
                    )
                    .on_mouse_down(
                        MouseButton::Right,
                        cx.listener(|this, _, _, cx| this.close_menus(cx)),
                    ),
            )
            .with_priority(5)
        });
        self.prepare_web_views(cx);
        root.children(self.pane_menu_view(window, cx))
            .children(self.entry_menu_view(window, cx))
            .children(self.sidebar_menu_view(window, cx))
            .children(self.header_git_menu_view(window, cx))
            .children(self.sidebar_notice_view(cx))
            .children(self.thread_menu_view(window, cx))
            .children(self.project_dialog_view(cx))
            .children(self.entry_dialog_view(cx))
            .children(self.palette_view(cx))
            .children(self.project_row_menu_view(window, cx))
            .children(self.settings_dialogs(cx))
            .children(self.schedule_dialog(cx))
            .children(self.provider_check_notice(cx))
            .children(catcher)
    }
}

// ---- keyboard

actions!(
    fastvibe,
    [
        Quit,
        NewChat,
        OpenSettings,
        OpenSearch,
        Dismiss,
        ToggleSidebar,
        ToggleSidePane,
        GoBack,
        GoForward,
        AcceptSuggestion,
        SavePreview,
        BrowserAddress,
        BrowserReload,
        MentionUp,
        MentionDown,
        MentionDismiss,
        AcceptSkill
    ]
);

/// A terminal frame for the capture fixture: a prompt, coloured output and the cursor.
///
/// The fixture has no server, so nothing here starts a shell; the frame is laid out by hand in the
/// same shape the server sends.
pub(super) fn terminal_fixture(
    cwd: &str,
    cols: u16,
    rows: u16,
) -> Result<
    (
        fv_protocol::types::TerminalSession,
        fv_protocol::types::TerminalFrame,
    ),
    String,
> {
    use fv_protocol::types::{
        TerminalColor, TerminalFrame, TerminalRow, TerminalSession, TerminalSpan,
    };
    let plain = |text: &str| TerminalSpan {
        text: text.into(),
        ..Default::default()
    };
    let coloured = |text: &str, index: u8, bold: bool| TerminalSpan {
        text: text.into(),
        fg: Some(TerminalColor::Indexed(index)),
        bold,
        ..Default::default()
    };
    let row = |spans: Vec<TerminalSpan>| TerminalRow {
        text: spans.iter().map(|s| s.text.as_str()).collect(),
        spans,
        ..Default::default()
    };
    let dir = cwd.rsplit('/').next().unwrap_or(cwd);
    let prompt = |command: &str| {
        row(vec![
            coloured(dir, 4, true),
            plain(" "),
            coloured("main", 2, false),
            plain(" % "),
            plain(command),
        ])
    };
    let mut lines = vec![
        prompt("printf 'FastVibe native terminal'"),
        row(vec![
            plain("FastVibe native "),
            coloured("terminal", 2, true),
        ]),
        prompt("ls -1 native/crates"),
        row(vec![coloured("fv-agent", 4, true)]),
        row(vec![coloured("fv-gui", 4, true)]),
        row(vec![coloured("fv-server", 4, true)]),
        row(vec![plain("README.md")]),
        prompt(""),
    ];
    let cursor_row = (lines.len() - 1) as u16;
    let cursor_col = lines[lines.len() - 1].text.chars().count() as u16;
    while lines.len() < rows as usize {
        lines.push(TerminalRow::default());
    }
    Ok((
        TerminalSession {
            id: "fixture".into(),
            cwd: cwd.into(),
            cols,
            rows,
        },
        TerminalFrame {
            id: "fixture".into(),
            cwd: cwd.into(),
            cols,
            rows,
            lines,
            cursor_row,
            cursor_col,
            cursor_hidden: false,
            exited: false,
            history: 0,
            offset: 0,
            anchor: Default::default(),
            bracketed_paste: false,
            application_cursor: false,
            alternate_screen: false,
        },
    ))
}

/// Files under `root` that match `query`, ranked by the server's own rules, for the capture
/// fixture. The ranking is the point of the picture, so it is the real one.
pub(super) fn search_files_fixture(root: &str, query: &str) -> Vec<fv_protocol::types::FileHit> {
    fn walk(dir: &std::path::Path, base: &std::path::Path, out: &mut Vec<String>) {
        if out.len() > 8000 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if matches!(name.as_str(), ".git" | "node_modules" | "target") {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            if kind.is_dir() {
                walk(&path, base, out);
            } else if kind.is_file()
                && let Ok(relative) = path.strip_prefix(base)
            {
                out.push(relative.display().to_string());
            }
        }
    }
    let base = std::path::Path::new(root);
    let mut files = Vec::new();
    walk(base, base, &mut files);
    let query = query.to_lowercase();
    let mut scored: Vec<(String, i32)> = files
        .into_iter()
        .map(|file| {
            let lower = file.to_lowercase();
            let name = lower.rsplit('/').next().unwrap_or(&lower).to_string();
            let score = if query.is_empty() {
                100 - lower.split('/').count() as i32
            } else if name.starts_with(&query) {
                800 - name.len() as i32
            } else if let Some(at) = name.find(&query) {
                600 - at as i32
            } else if let Some(at) = lower.find(&query) {
                400 - at as i32
            } else {
                0
            };
            (file, score)
        })
        .filter(|(_, score)| query.is_empty() || *score > 0)
        .collect();
    scored.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    scored
        .into_iter()
        .take(12)
        .map(|(relative, _)| fv_protocol::types::FileHit {
            path: format!("{root}/{relative}"),
            relative,
        })
        .collect()
}

/// Reading the workspace for the capture fixture, which runs without a server.
///
/// This is the same code the server's handler runs, called in-process — the pane's drawing is
/// what a fixture is for, and a fixture that stubbed its own file list would be drawing
/// something nobody can have.
pub(super) fn read_dir_fixture(path: &str) -> Result<Vec<DirEntry>, String> {
    // The protocol type is what the pane draws, so the listing is converted rather than
    // re-shaped: one field list, no second copy to drift.
    let entries = std::fs::read_dir(path).map_err(|e| e.to_string())?;
    let mut out: Vec<DirEntry> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".git" || name == "node_modules" || name == "target" {
            continue;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let kind = if kind.is_dir() {
            EntryKind::Directory
        } else if kind.is_file() {
            EntryKind::File
        } else {
            continue;
        };
        out.push(DirEntry {
            name,
            path: entry.path().display().to_string(),
            kind,
        });
    }
    out.sort_by(|a, b| match (a.kind, b.kind) {
        (EntryKind::Directory, EntryKind::File) => std::cmp::Ordering::Less,
        (EntryKind::File, EntryKind::Directory) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
    Ok(out)
}

/// The preview the fixture shows: the server's own `preview` logic, run in-process.
///
/// A fixture that shaped its own `FilePreview` would be drawing something no real call can
/// produce — a Markdown file typed as code, say — and the capture would be a picture of a bug
/// that does not exist.
pub(super) fn preview_fixture(path: &str) -> FilePreview {
    // The server's module is not a dependency of the GUI, so the one thing the fixture needs is
    // its shape: read the file and let the kind follow from the name, exactly as the server does.
    let name = std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());
    let ext = std::path::Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match std::fs::read_to_string(path) {
        Ok(text) => {
            let kind = match ext.as_str() {
                "md" | "markdown" => FilePreviewKind::Markdown,
                "html" | "htm" => FilePreviewKind::Html,
                "diff" | "patch" => FilePreviewKind::Diff,
                _ => FilePreviewKind::Code,
            };
            FilePreview::Text {
                kind,
                path: path.to_string(),
                name,
                // The same name the server's `code_language` produces for these extensions.
                language: match ext.as_str() {
                    "rs" => Some("rust".to_string()),
                    "ts" | "mts" | "cts" => Some("typescript".to_string()),
                    "tsx" => Some("tsx".to_string()),
                    "js" | "mjs" | "cjs" => Some("javascript".to_string()),
                    "py" => Some("python".to_string()),
                    "sh" | "bash" | "zsh" => Some("shellscript".to_string()),
                    "json" => Some("json".to_string()),
                    "toml" => Some("toml".to_string()),
                    "yaml" | "yml" => Some("yaml".to_string()),
                    _ => None,
                },
                text: text.lines().take(60).collect::<Vec<_>>().join("\n"),
            }
        }
        Err(e) => FilePreview::Error {
            path: path.to_string(),
            name,
            message: "文件不存在".into(),
            reason: PreviewFailure::Missing,
            detail: Some(e.to_string()),
            directory: None,
        },
    }
}

/// `1.4 MB` for a file size, in the app's own compact notation.
pub(super) fn format_bytes(size: u64) -> String {
    const K: f64 = 1024.0;
    let n = size as f64;
    if n >= K * K * K {
        format!("{:.1} GB", n / (K * K * K))
    } else if n >= K * K {
        format!("{:.1} MB", n / (K * K))
    } else if n >= K {
        format!("{:.1} KB", n / K)
    } else {
        format!("{size} B")
    }
}

/// Fixed system/editor actions. Configurable app commands are dispatched per window.
pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("secondary-q", Quit, None),
        KeyBinding::new("escape", Dismiss, None),
        KeyBinding::new("enter", ask::ApproveOnce, Some("ApprovalPanel")),
        // ⌘S saves the file the pane has open. It is a window-level binding, not the editor's:
        // the same key has to work while the pointer is in the tree.
        KeyBinding::new("cmd-s", SavePreview, None),
        KeyBinding::new("ctrl-s", SavePreview, None),
        KeyBinding::new("secondary-l", BrowserAddress, None),
        KeyBinding::new("secondary-r", BrowserReload, None),
    ]);
    // Composer menu keys and empty-draft Tab match at the input's depth; otherwise the
    // input's own cursor/indent actions and global Escape would take precedence.
    cx.bind_keys(skill_picker::bindings());
    // Contextless bindings match the deepest node too; the terminal's null bindings must be
    // registered afterwards to suppress these window-level actions before raw key handling.
    cx.bind_keys(pane_terminal::passthrough_bindings());
    cx.on_action(|_: &Quit, cx| cx.quit());

    app_menu::bind(cx);
    app_menu::install(cx, false);
}

impl Workspace {
    /// Whether the interface is in English: the one question every notice and label asks.
    pub(super) fn english(&self) -> bool {
        self.app_settings.language == UiLanguage::English
    }

    fn on_new_chat(&mut self, _: &NewChat, _: &mut Window, cx: &mut Context<Self>) {
        self.settings = None;
        self.new_chat(None, cx);
        self.close_menus(cx);
    }

    fn on_open_settings(&mut self, _: &OpenSettings, window: &mut Window, cx: &mut Context<Self>) {
        let section = if self.models.is_empty() {
            settings::Section::Providers
        } else {
            settings::Section::General
        };
        self.open_settings(section, window, cx);
    }

    fn on_open_search(&mut self, _: &OpenSearch, window: &mut Window, cx: &mut Context<Self>) {
        self.open_palette(window, cx);
    }

    /// Esc closes the topmost thing: a menu, then a dialog or the search, then 设置.
    /// Mirror the thread's standing suggestion into the field the key handler reads.
    ///
    /// One copy, refreshed whenever a thread event lands, so Tab can take it without borrowing a
    /// view — and it is per chat on screen: switching chats replaces it rather than carrying the
    /// previous conversation's guess into this one.
    fn sync_suggestion(&mut self) {
        self.compose_suggestion = self
            .selected
            .as_ref()
            .and_then(|id| self.views.get(id))
            .and_then(|v| v.suggestion.clone())
            .filter(|text| !text.trim().is_empty());
    }

    /// ↑ / ↓ in the `@` menu: move the highlight, not the caret.
    fn on_mention_up(&mut self, _: &MentionUp, _: &mut Window, cx: &mut Context<Self>) {
        if self.skill_picker.open() {
            self.move_skill(-1, cx);
        } else {
            self.move_mention(-1, cx);
        }
    }

    fn on_mention_down(&mut self, _: &MentionDown, _: &mut Window, cx: &mut Context<Self>) {
        if self.skill_picker.open() {
            self.move_skill(1, cx);
        } else {
            self.move_mention(1, cx);
        }
    }

    /// Escape in the `@` menu: close it and leave the typed `@query` where it is. Escape is how
    /// somebody writes an `@` they did not mean as a reference.
    fn on_mention_dismiss(&mut self, _: &MentionDismiss, _: &mut Window, cx: &mut Context<Self>) {
        if self.skill_picker.open() {
            self.dismiss_skill(cx);
        } else if self.mention.take().is_some() {
            cx.notify();
        }
    }

    fn on_accept_skill(&mut self, _: &AcceptSkill, window: &mut Window, cx: &mut Context<Self>) {
        self.accept_skill(window, cx);
    }

    /// ⌘S: write the pane's open file back.
    fn on_save_preview(&mut self, _: &SavePreview, _: &mut Window, cx: &mut Context<Self>) {
        if self.schedules_ui.open {
            return;
        }
        self.save_preview(cx);
    }

    /// Tab: take 回复推荐 into the composer.
    ///
    /// Only an empty composer offers Tab — with text in it, Tab belongs to the editor (indent).
    fn on_accept_suggestion(
        &mut self,
        _: &AcceptSuggestion,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(text) = self.compose_suggestion.clone() else {
            return;
        };
        // Taking it is a normal edit of the draft, not a send: the user may take it apart first.
        self.input.update(cx, |state, cx| {
            state.set_value(crate::skill_draft::content(text), window, cx)
        });
        self.compose_suggestion = None;
        cx.notify();
    }

    fn on_dismiss(&mut self, _: &Dismiss, window: &mut Window, cx: &mut Context<Self>) {
        if self.dismiss_schedule(cx) {
            return;
        }
        // Esc closes one thing per press, and an edit in the composer is the most immediate of
        // them: the words stay, they just stop replacing a turn the user already sent.
        if self.editing() {
            self.cancel_edit(cx);
        } else if self.rename.take().is_some() || self.sidebar_notice.take().is_some() {
            cx.notify();
        } else if self.project_dialog.is_some() {
            self.project_dialog = None;
            cx.notify();
        } else if self.entry_dialog.is_some() {
            if self
                .entry_dialog
                .as_ref()
                .is_some_and(|dialog| !dialog.busy)
            {
                self.entry_dialog = None;
            }
            cx.notify();
        } else if self.any_menu_open() {
            self.close_menus(cx);
        } else if self.settings.is_none() && self.search_box.is_none() && self.dismiss_pending(cx) {
        } else if self.search_box.is_some() {
            self.close_palette(window, cx);
        } else if let Some(s) = &mut self.settings {
            if s.model_edit.as_mut().is_some_and(|e| e.dismiss_menu()) {
            } else if s.model_edit.is_some() {
                s.model_edit = None;
            } else if s.add.is_some() {
                s.add = None;
            } else if s.add_models.is_some() {
                s.add_models = None;
            } else if s.confirm_delete.is_some() {
                s.confirm_delete = None;
            } else {
                self.settings = None;
                self.input.update(cx, |input, cx| input.focus(window, cx));
            }
            cx.notify();
        }
    }
}

#[cfg(test)]
mod locale_file_tests {
    //! Copy lives in `locales/*.yml`. A key with a missing language silently falls back to
    //! Chinese, and a mistyped key renders as the key itself, so read the files and the
    //! sources themselves rather than trusting the macro.
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};

    type Doc = BTreeMap<String, BTreeMap<String, String>>;

    fn locale_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("locales")
    }

    /// The files are flat (`key:` then `  zh: "…"` / `  en: "…"`), so no YAML parser is needed.
    fn load() -> Doc {
        let mut out = Doc::new();
        for entry in std::fs::read_dir(locale_dir()).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_none_or(|e| e != "yml") {
                continue;
            }
            let mut key = String::new();
            for line in std::fs::read_to_string(&path).unwrap().lines() {
                if line.trim().is_empty() || line.starts_with("_version") {
                    continue;
                }
                if let Some(rest) = line.strip_prefix("  ") {
                    let (lang, text) = rest.split_once(':').expect("lang line");
                    let text = text.trim();
                    let text = serde_json::from_str::<String>(text).unwrap_or_else(|_| text.into());
                    out.get_mut(&key).unwrap().insert(lang.trim().into(), text);
                } else {
                    key = line.trim_end_matches(':').to_string();
                    assert!(
                        out.insert(key.clone(), BTreeMap::new()).is_none(),
                        "{key} is defined twice"
                    );
                }
            }
        }
        out
    }

    #[test]
    fn every_key_has_both_languages() {
        let doc = load();
        assert!(doc.len() > 100);
        for (key, langs) in &doc {
            for lang in ["zh", "en"] {
                let text = langs.get(lang).map(String::as_str).unwrap_or("");
                assert!(!text.trim().is_empty(), "{key} has no {lang} text");
            }
        }
    }

    #[test]
    fn placeholders_agree_between_languages() {
        let names = |text: &str| -> Vec<String> {
            let mut v: Vec<String> = text
                .split("%{")
                .skip(1)
                .filter_map(|r| r.split_once('}'))
                .map(|(n, _)| n.to_string())
                .collect();
            v.sort();
            v
        };
        for (key, langs) in load() {
            assert_eq!(
                names(&langs["zh"]),
                names(&langs["en"]),
                "{key}: placeholders differ"
            );
        }
    }

    /// Every key the code asks for must exist; a miss would show the key on screen.
    #[test]
    fn every_key_used_in_source_exists() {
        let doc = load();
        let mut used = 0;
        let mut stack = vec![Path::new(env!("CARGO_MANIFEST_DIR")).join("src")];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    let src: String = std::fs::read_to_string(&path)
                        .unwrap()
                        .lines()
                        .filter(|l| !l.trim_start().starts_with("//"))
                        .collect::<Vec<_>>()
                        .join("\n");
                    for marker in [
                        "tr!(english, \"",
                        "trs!(english, \"",
                        "tr!(self.english(), \"",
                        "trs!(self.english(), \"",
                        "tr!(this.english(), \"",
                        "trs!(this.english(), \"",
                        "tr(Chinese, \"",
                        "tr(language, \"",
                    ] {
                        for part in src.split(marker).skip(1) {
                            let key = part.split('"').next().unwrap();
                            assert!(
                                doc.contains_key(key),
                                "{}: unknown key {key}",
                                path.display()
                            );
                            used += 1;
                        }
                    }
                    // The menu bar passes its keys through a local `t("…")` closure.
                    for part in src.split("t(\"app_menu.").skip(1) {
                        let key = format!("app_menu.{}", part.split('"').next().unwrap());
                        assert!(
                            doc.contains_key(&key),
                            "{}: unknown key {key}",
                            path.display()
                        );
                        used += 1;
                    }
                }
            }
        }
        assert!(
            used > 400,
            "only {used} keys found; the scan is probably broken"
        );
    }

    #[test]
    fn office_copy_is_unchanged() {
        use super::text;
        use fv_protocol::types::UiLanguage::{Chinese, English};
        assert_eq!(text::tr(Chinese, "office.back"), "返回文件列表");
        assert_eq!(
            text::tr(English, "office.quote_selection"),
            "Quote selection"
        );
        assert_eq!(
            rust_i18n::t!("office.snapshot_failed", locale = "zh", error = "x"),
            "未能更新文档快照：x"
        );
    }

    #[test]
    fn migrated_copy_matches_the_old_inline_text() {
        assert_eq!(trs!(true, "about.bundled"), "bundled");
        assert_eq!(trs!(false, "about.bundled"), "应用内置");
        assert_eq!(
            tr!(
                false,
                "about.catalog_stats",
                models = 3,
                aliases = 5,
                source = "x"
            ),
            "3 个模型 · 5 个名称索引 · x"
        );
        assert_eq!(
            tr!(true, "pane_entries.operation_failed", error = "boom"),
            "Operation failed: boom"
        );
        assert_eq!(
            tr!(false, "pane_entries.operation_failed", error = "boom"),
            "boom"
        );
    }
}
