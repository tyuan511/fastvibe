//! The main window: sidebar of conversations, the transcript of the open one, and the
//! composer. Everything it knows comes from the server through [`Backend`].

use std::collections::{BTreeMap, HashMap, HashSet};

use futures_util::StreamExt as _;
use fv_protocol::methods::*;
use fv_protocol::types::Empty;
use fv_protocol::types::*;
use fv_protocol::{RequestId, ServerNotification, ServerRequest};
use fv_theme::Token;
use gpui_kit::component::input::{InputEvent, InputState, TextareaState};
use gpui_kit::*;

mod composer;
mod palette;
pub mod settings;
mod sidebar;
mod transcript;

use crate::backend::{Backend, BackendEvent};
use crate::theme::Palette;
use crate::view_model::{Applied, ThreadView};

/// The Electron app's Chinese copy (`locales/zh`), word for word.
mod text {
    pub const NEW_CHAT: &str = "新对话";
    pub const PLUGINS: &str = "插件";
    pub const TASKS: &str = "定时任务";
    pub const PROJECTS: &str = "项目";
    pub const NO_PROJECTS: &str = "暂无项目";
    pub const CHATS: &str = "聊天";
    pub const EMPTY_CHATS: &str = "暂无对话";
    pub const SETTINGS: &str = "设置";
    pub const CONNECTING: &str = "正在连接…";
    pub const PLACEHOLDER: &str = "随心输入";
    pub const NO_MODEL: &str = "添加模型";
    pub const NO_MODEL_HINT: &str = "暂无模型";
    pub const THINKING: &str = "思考";
    pub const COMPACTED: &str = "已压缩上下文";
    pub const COMPACTING: &str = "正在压缩上下文";
    pub const WORKING: &str = "正在工作";
    pub const CHANGED_FILES: &str = "已修改 {n} 个文件";
    pub const VIEW_CHANGES: &str = "查看变更";
    pub const PROCESSED: &str = "已处理";
    pub const UNTITLED: &str = "新对话";
}

enum Status {
    Connecting,
    Ready,
    Failed(String),
}

pub struct Workspace {
    palette: Palette,
    backend: Option<Backend>,
    status: Status,
    threads: Vec<Thread>,
    selected: Option<ThreadId>,
    views: HashMap<ThreadId, ThreadView>,
    /// Questions that arrived for a thread whose view is not loaded yet.
    pending_questions: Vec<(RequestId, UserInputRequest)>,
    models: Vec<ModelEntry>,
    defaults: ModelDefaults,
    /// The model picked on the empty page, before a conversation exists.
    pending_model: Option<String>,
    /// The project a new conversation will start in (the composer's 选择项目 chip).
    draft_project: Option<String>,
    project_menu: bool,
    model_menu: bool,
    input: Entity<TextareaState>,
    scroll: ScrollHandle,
    answers: HashMap<RequestId, BTreeMap<String, UserInputAnswer>>,
    /// Turns whose folded process the user opened.
    open_folds: HashSet<String>,
    /// Thoughts and tool calls the user opened, by item id.
    open_items: HashSet<String>,
    /// Projects whose chats the user folded away, by project path.
    closed_projects: HashSet<String>,
    /// Scroll to the end once the transcript has been laid out (opening a conversation).
    stick_to_bottom: bool,
    /// 设置, while it is open (it covers the workspace, which keeps its state behind it).
    settings: Option<settings::SettingsState>,
    /// ⌘K: the search box, while it is open.
    search_box: Option<Entity<InputState>>,
    /// Dev only: send even with no model listed (the echo server has none).
    pub(super) skip_model_check: bool,
    /// Why the last send did not go through, shown above the composer.
    send_error: Option<String>,
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
    /// Whether the app follows `app_settings`; a fixture window keeps the palette it was given.
    live_appearance: bool,
    appearance_dirty: bool,
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
        let (ready, mut events) = Backend::start(data_dir, server_bin);
        cx.spawn(async move |this, cx| {
            let backend = ready.await;
            this.update(cx, |this, cx| {
                if let Some(b) = backend {
                    this.backend = Some(b);
                    this.status = Status::Ready;
                    this.refresh_all(cx);
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
            })
            .collect();
        this.models = fixture.models;
        this.defaults = fixture.defaults;
        if let Some(view) = fixture.view {
            this.selected = Some(view.thread.id.clone());
            this.views.insert(view.thread.id.clone(), view);
        }
        this
    }

    fn base(palette: Palette, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(1, 8)
                .placeholder(text::PLACEHOLDER)
        });
        // The composer has the keyboard from the start, as in the Electron app.
        input.update(cx, |state, cx| state.focus(window, cx));
        cx.subscribe_in(&input, window, |this, _, ev: &InputEvent, window, cx| {
            if let InputEvent::PressEnter {
                secondary: false,
                shift: false,
            } = ev
            {
                this.send(window, cx);
            }
        })
        .detach();
        let this = Self {
            palette,
            backend: None,
            status: Status::Connecting,
            threads: Vec::new(),
            selected: None,
            views: HashMap::new(),
            pending_questions: Vec::new(),
            models: Vec::new(),
            defaults: ModelDefaults::default(),
            pending_model: None,
            draft_project: None,
            project_menu: false,
            model_menu: false,
            input,
            scroll: ScrollHandle::new(),
            answers: HashMap::new(),
            open_folds: HashSet::new(),
            open_items: HashSet::new(),
            closed_projects: HashSet::new(),
            stick_to_bottom: true,
            settings: None,
            search_box: None,
            skip_model_check: false,
            send_error: None,
            projects: Vec::new(),
            project_row_menu: None,
            thread_menu: None,
            rename: None,
            app_settings: AppSettings::default(),
            live_appearance: false,
            appearance_dirty: false,
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
        this
    }

    pub fn set_palette(&mut self, palette: Palette, cx: &mut Context<Self>) {
        self.palette = palette;
        cx.notify();
    }

    /// The right-click menu of a sidebar row.
    fn thread_menu_view(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (id, at) = self.thread_menu.clone()?;
        let thread = self.threads.iter().find(|t| t.id == id)?;
        let p = &self.palette;
        let hover = p.c(Token::Accent);
        let pinned = thread.pinned;
        let item = |key: &'static str, glyph: &'static str, label: &'static str| {
            settings::menu_item(SharedString::from(format!("tm-{key}")), false, hover)
                .child(crate::ui::icon(glyph, 14.0, p.c(Token::MutedForeground)))
                .child(label)
        };
        let (rename_id, pin_id, archive_id) = (id.clone(), id.clone(), id);
        let menu = settings::popover(p)
            .absolute()
            .left(at.x)
            .top(at.y)
            .w(px(160.0))
            .child(
                item("rename", "pencil-edit02", "重命名").on_click(cx.listener(
                    move |this, _, window, cx| this.begin_rename(rename_id.clone(), window, cx),
                )),
            )
            .child(
                item("pin", "pin", if pinned { "取消置顶" } else { "置顶" }).on_click(cx.listener(
                    move |this, _, _, cx| {
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
                    },
                )),
            )
            .child(item("archive", "archive04", "归档").on_click(cx.listener(
                move |this, _, _, cx| {
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
                },
            )));
        Some(crate::ui::float(menu).into_any_element())
    }

    fn project_row_menu_view(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (path, at) = self.project_row_menu.clone()?;
        let p = &self.palette;
        let hover = p.c(Token::Accent);
        let menu = settings::popover(p)
            .absolute()
            .left(at.x)
            .top(at.y)
            .w(px(160.0))
            .child(
                settings::menu_item(SharedString::from("pm-remove"), false, hover)
                    .child(crate::ui::icon(
                        "delete02",
                        14.0,
                        p.c(Token::MutedForeground),
                    ))
                    .child("移除项目")
                    .on_click(
                        cx.listener(move |this, _, _, cx| this.remove_project(path.clone(), cx)),
                    ),
            );
        Some(crate::ui::float(menu).into_any_element())
    }

    fn any_menu_open(&self) -> bool {
        self.model_menu
            || self.project_menu
            || self.thread_menu.is_some()
            || self.project_row_menu.is_some()
            || self.settings.as_ref().is_some_and(|s| {
                s.default_menu
                    || s.theme_menu.is_some()
                    || s.edit.as_ref().is_some_and(|e| e.protocol_menu)
                    || s.add.as_ref().is_some_and(|a| a.protocol_menu)
            })
    }

    fn close_menus(&mut self, cx: &mut Context<Self>) {
        self.model_menu = false;
        self.project_menu = false;
        self.thread_menu = None;
        self.project_row_menu = None;
        if let Some(s) = &mut self.settings {
            s.default_menu = false;
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
        cx.notify();
    }

    /// `--settings providers` / `--settings add-provider`, for the capture flow.
    pub fn show_settings_named(&mut self, name: &str, window: &mut Window, cx: &mut Context<Self>) {
        match name {
            "providers" => self.open_settings(settings::Section::Providers, window, cx),
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
        self.selected = Some(id.clone());
        if self.backend.is_some() {
            self.select(id, cx);
        }
    }

    // ---- talking to the server

    fn refresh_app_settings(&mut self, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        let call = b.call::<SettingsGet>(Empty {});
        cx.spawn(async move |this, cx| {
            if let Ok(s) = call.await {
                this.update(cx, |this, cx| {
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
        self.app_settings.apply(patch.clone());
        self.appearance_dirty = true;
        cx.notify();
        let Some(b) = self.backend.clone() else {
            return;
        };
        let call = b.call::<SettingsSet>(patch);
        cx.spawn(async move |_, _| {
            let _ = call.await;
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
        window.set_background_appearance(if palette.glass() {
            WindowBackgroundAppearance::Blurred
        } else {
            WindowBackgroundAppearance::Opaque
        });
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
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
    }

    /// 添加项目: pick a folder with the system's own dialog and list it.
    pub(super) fn add_project(&mut self, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        let picked = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("添加项目".into()),
        });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = picked.await else {
                return;
            };
            let Some(path) = paths.into_iter().next() else {
                return;
            };
            let call = b.call::<ProjectAdd>(ProjectPathParams {
                path: path.display().to_string(),
            });
            if let Ok(project) = call.await {
                this.update(cx, |this, cx| {
                    // The new chat page starts in it, so the next message lands there.
                    this.selected = None;
                    this.draft_project = Some(project.path);
                    this.refresh_projects(cx);
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
            let _ = call.await;
            this.update(cx, |this, cx| this.refresh_projects(cx)).ok();
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
            let _ = call.await;
            this.update(cx, |this, cx| {
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
        let call = b.call::<ThreadDelete>(ThreadIdParams { thread_id: id });
        cx.spawn(async move |this, cx| {
            let _ = call.await;
            this.update(cx, |this, cx| {
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
                InputEvent::Blur => {
                    this.rename = None;
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
        // Settings may have been opened before the server answered.
        if self.settings.is_some() {
            self.refresh_providers(cx);
            self.refresh_archived(cx);
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
        let models = b.call::<ModelList>(Empty {});
        let defaults = b.call::<ModelDefaultsGet>(Empty {});
        cx.spawn(async move |this, cx| {
            let models = models.await.ok();
            let defaults = defaults.await.ok();
            this.update(cx, |this, cx| {
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
        self.selected = Some(id.clone());
        self.model_menu = false;
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
                    }
                    let (mine, rest): (Vec<_>, Vec<_>) =
                        std::mem::take(&mut this.pending_questions)
                            .into_iter()
                            .partition(|(_, q)| q.thread_id == id);
                    this.pending_questions = rest;
                    for (rid, q) in mine {
                        view.ask(rid, q);
                    }
                    this.views.insert(id, view);
                    this.stick_to_bottom = true;
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
    }

    fn on_event(&mut self, event: BackendEvent, cx: &mut Context<Self>) {
        match event {
            BackendEvent::Connected { .. } => {}
            BackendEvent::Failed(message) => {
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
            BackendEvent::Notification(note) => {
                match &note {
                    ServerNotification::ThreadStarted(_)
                    | ServerNotification::CatalogChanged(_) => {
                        self.refresh_threads(cx);
                        self.refresh_projects(cx);
                        self.refresh_archived(cx);
                    }
                    ServerNotification::SettingsChanged(s) => {
                        self.app_settings = s.clone();
                        self.appearance_dirty = true;
                    }
                    ServerNotification::ProvidersChanged(_) => {
                        self.refresh_models(cx);
                        if self.settings.is_some() {
                            self.refresh_providers(cx);
                        }
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
                self.scroll.scroll_to_bottom();
                cx.notify();
            }
        }
    }

    pub(super) fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.input.read(cx).value().trim().to_string();
        if text.is_empty() || self.palette_blocked() {
            return;
        }
        let Some(b) = self.backend.clone() else {
            return;
        };
        // Nothing can be answered without a model: say so, and keep what was typed.
        if self.models.is_empty() && !self.skip_model_check {
            self.send_error = Some("还没有可用的模型：先到 设置 → 模型与默认 添加供应商。".into());
            cx.notify();
            return;
        }
        self.input
            .update(cx, |state, cx| state.set_value("", window, cx));
        self.send_error = None;
        let selected = self.selected.clone();
        let pending_model = self.pending_model.clone();
        let project = self.draft_project.clone();
        let no_model = self.defaults.model.is_none() && pending_model.is_none();
        let handle_input = self.input.clone();
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            // A send that did not go through puts the words back and says why.
            let fail = |why: String, text: String, this: &WeakEntity<Self>, cx: &mut AsyncApp| {
                let _ = cx.update_window(window_handle, |_, window, cx| {
                    handle_input.update(cx, |st, cx| st.set_value(text, window, cx));
                });
                this.update(cx, |this, cx| {
                    this.send_error = Some(why);
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
                            thinking: None,
                        })
                        .await;
                    let started = match started {
                        Ok(s) => s,
                        Err(e) => return fail(format!("无法新建对话：{e}"), text, &this, cx),
                    };
                    let id = started.thread.id.clone();
                    let snapshot = b
                        .call::<ThreadResume>(ThreadIdParams {
                            thread_id: id.clone(),
                        })
                        .await;
                    let snapshot = match snapshot {
                        Ok(s) => s,
                        Err(e) => return fail(format!("无法打开对话：{e}"), text, &this, cx),
                    };
                    this.update(cx, |this, cx| {
                        this.selected = Some(id.clone());
                        this.pending_model = None;
                        this.views
                            .insert(id.clone(), ThreadView::from_snapshot(snapshot));
                        cx.notify();
                    })
                    .ok();
                    id
                }
            };
            let started = b
                .call::<TurnStart>(TurnStartParams {
                    thread_id: id,
                    text: text.clone(),
                })
                .await;
            if let Err(e) = started {
                let why = if no_model {
                    "还没有可用的模型：先到 设置 → 模型与默认 添加供应商。".to_string()
                } else {
                    format!("发送失败：{e}")
                };
                fail(why, text, &this, cx);
            }
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

    fn pick_model(&mut self, label: String, cx: &mut Context<Self>) {
        self.model_menu = false;
        let Some(id) = self.selected.clone() else {
            self.pending_model = Some(label);
            cx.notify();
            return;
        };
        let Some(b) = self.backend.clone() else {
            return;
        };
        let call = b.call::<ThreadModelSet>(ThreadModelParams {
            thread_id: id.clone(),
            model: Some(label),
            thinking: None,
        });
        cx.spawn(async move |this, cx| {
            if let Ok(r) = call.await {
                this.update(cx, |this, cx| {
                    if let Some(v) = this.views.get_mut(&id) {
                        v.thread = r.thread.clone();
                    }
                    if let Some(t) = this.threads.iter_mut().find(|t| t.id == id) {
                        *t = r.thread;
                    }
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
        cx.notify();
    }

    fn answer(
        &mut self,
        request: RequestId,
        view_questions: usize,
        question: String,
        choice: String,
        cx: &mut Context<Self>,
    ) {
        let entry = self.answers.entry(request.clone()).or_default();
        entry.insert(
            question,
            UserInputAnswer {
                answers: vec![choice],
            },
        );
        if entry.len() >= view_questions
            && let Some(b) = self.backend.clone()
        {
            let answers = self.answers.remove(&request).unwrap_or_default();
            let value = serde_json::to_value(UserInputResponse { answers }).unwrap_or_default();
            b.respond(request, value);
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

// ---- rendering

impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.appearance_dirty {
            self.appearance_dirty = false;
            if self.live_appearance {
                self.apply_appearance(window, cx);
            }
        }
        // The handle only knows the content's height after a layout, so the jump to the end
        // waits for a frame that has one.
        if self.stick_to_bottom && self.scroll.max_offset().y > px(0.0) {
            self.scroll.scroll_to_bottom();
            self.stick_to_bottom = false;
        } else if self.stick_to_bottom {
            cx.notify();
        }
        let p = self.palette.clone();
        let root = div()
            .relative()
            .size_full()
            .key_context("Workspace")
            .on_action(cx.listener(Self::on_new_chat))
            .on_action(cx.listener(Self::on_open_settings))
            .on_action(cx.listener(Self::on_open_search))
            .on_action(cx.listener(Self::on_dismiss))
            .font_family(crate::assets::UI_FONT)
            .bg(p.c(Token::Background))
            .text_color(p.c(Token::Foreground))
            .text_size(px(crate::ui::TEXT_SM));
        let root = if self.settings.is_some() {
            root.child(self.settings_view(window, cx))
        } else {
            root.child(
                div()
                    .size_full()
                    .flex()
                    .child(self.sidebar(cx))
                    .child(self.main(window, cx)),
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
        root.children(self.thread_menu_view(cx))
            .children(self.palette_view(cx))
            .children(self.project_row_menu_view(cx))
            .children(self.settings_dialogs(cx))
            .children(catcher)
    }
}

// ---- keyboard

actions!(fastvibe, [Quit, NewChat, OpenSettings, OpenSearch, Dismiss]);

/// Bind the app's shortcuts. The Electron app's: ⌘N new chat, ⌘, settings, ⌘K search.
pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-q", Quit, None),
        KeyBinding::new("cmd-n", NewChat, None),
        KeyBinding::new("cmd-,", OpenSettings, None),
        KeyBinding::new("cmd-k", OpenSearch, None),
        KeyBinding::new("escape", Dismiss, None),
    ]);
    cx.on_action(|_: &Quit, cx| cx.quit());
    cx.set_menus(vec![Menu {
        name: "FastVibe".into(),
        items: vec![
            MenuItem::action("新对话", NewChat),
            MenuItem::action("搜索…", OpenSearch),
            MenuItem::action("设置…", OpenSettings),
            MenuItem::separator(),
            MenuItem::action("退出 FastVibe", Quit),
        ],
        disabled: false,
    }]);
}

impl Workspace {
    fn on_new_chat(&mut self, _: &NewChat, _: &mut Window, cx: &mut Context<Self>) {
        self.settings = None;
        self.selected = None;
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
    fn on_dismiss(&mut self, _: &Dismiss, window: &mut Window, cx: &mut Context<Self>) {
        if self.any_menu_open() {
            self.close_menus(cx);
        } else if self.search_box.is_some() {
            self.close_palette(window, cx);
        } else if let Some(s) = &mut self.settings {
            if s.add.is_some() {
                s.add = None;
            } else if s.add_models.is_some() {
                s.add_models = None;
            } else if s.confirm_delete.is_some() {
                s.confirm_delete = None;
            } else {
                self.settings = None;
            }
            cx.notify();
        }
    }
}
