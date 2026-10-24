//! The main window: sidebar of conversations, the transcript of the open one, and the
//! composer. Everything it knows comes from the server through [`Backend`].

use std::collections::{BTreeMap, HashMap, HashSet};

use futures_util::StreamExt as _;
use fv_protocol::methods::*;
use fv_protocol::types::Empty;
use fv_protocol::types::*;
use fv_protocol::{RequestId, ServerNotification, ServerRequest};
use fv_theme::Token;
use gpui_kit::component::input::{InputEvent, TextareaState};
use gpui_kit::*;

mod composer;
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
    /// Projects whose chats the user folded away, by project path.
    closed_projects: HashSet<String>,
    /// Scroll to the end once the transcript has been laid out (opening a conversation).
    stick_to_bottom: bool,
    /// 设置, while it is open (it covers the workspace, which keeps its state behind it).
    settings: Option<settings::SettingsState>,
}

impl Workspace {
    pub fn new(
        palette: Palette,
        data_dir: std::path::PathBuf,
        server_bin: Option<std::path::PathBuf>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let this = Self::base(palette, window, cx);
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
        Self {
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
            closed_projects: HashSet::new(),
            stick_to_bottom: true,
            settings: None,
        }
    }

    pub fn set_palette(&mut self, palette: Palette, cx: &mut Context<Self>) {
        self.palette = palette;
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

    /// `--settings providers` / `--settings add-provider`, for the capture flow.
    pub fn show_settings_named(&mut self, name: &str, window: &mut Window, cx: &mut Context<Self>) {
        match name {
            "providers" => self.open_settings(settings::Section::Providers, window, cx),
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

    fn refresh_all(&mut self, cx: &mut Context<Self>) {
        self.refresh_threads(cx);
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
                    | ServerNotification::CatalogChanged(_) => self.refresh_threads(cx),
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

    fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.input.read(cx).value().trim().to_string();
        if text.is_empty() || self.palette_blocked() {
            return;
        }
        let Some(b) = self.backend.clone() else {
            return;
        };
        self.input
            .update(cx, |state, cx| state.set_value("", window, cx));
        let selected = self.selected.clone();
        let pending_model = self.pending_model.clone();
        let project = self.draft_project.clone();
        cx.spawn(async move |this, cx| {
            let id = match selected {
                Some(id) => id,
                None => {
                    // Without a project the server gives the conversation a scratch folder.
                    let Ok(started) = b
                        .call::<ThreadStart>(ThreadStartParams {
                            cwd: project.clone(),
                            project,
                            model: pending_model,
                            thinking: None,
                        })
                        .await
                    else {
                        return;
                    };
                    let id = started.thread.id.clone();
                    let Ok(snapshot) = b
                        .call::<ThreadResume>(ThreadIdParams {
                            thread_id: id.clone(),
                        })
                        .await
                    else {
                        return;
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
            let _ = b
                .call::<TurnStart>(TurnStartParams {
                    thread_id: id,
                    text,
                })
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
        root.children(self.settings_dialogs(cx))
    }
}
