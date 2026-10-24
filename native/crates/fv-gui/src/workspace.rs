//! The main window: sidebar of conversations, the transcript of the open one, and the
//! composer. Everything it knows comes from the server through [`Backend`].

use std::collections::{BTreeMap, HashMap};

use futures_util::StreamExt as _;
use fv_protocol::methods::*;
use fv_protocol::types::Empty;
use fv_protocol::types::*;
use fv_protocol::{RequestId, ServerNotification, ServerRequest};
use fv_theme::Token;
use gpui_kit::component::input::{InputEvent, Textarea, TextareaState};
use gpui_kit::component::text::TextView;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::backend::{Backend, BackendEvent};
use crate::theme::Palette;
use crate::view_model::{Applied, ThreadView};

mod text {
    pub const NEW_CHAT: &str = "新对话";
    pub const CONNECTING: &str = "正在连接…";
    pub const EMPTY_HERO: &str = "想让我做点什么？";
    pub const PLACEHOLDER: &str = "输入消息，Enter 发送，Shift+Enter 换行";
    pub const NO_MODEL: &str = "添加模型";
    pub const NO_MODEL_HINT: &str = "暂无模型";
    pub const THINKING: &str = "思考";
    pub const RUNNING: &str = "运行中";
    pub const COMPACTED: &str = "已压缩上下文";
    pub const STOP: &str = "停止";
    pub const SEND: &str = "发送";
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
    model_menu: bool,
    input: Entity<TextareaState>,
    scroll: ScrollHandle,
    answers: HashMap<RequestId, BTreeMap<String, UserInputAnswer>>,
}

impl Workspace {
    pub fn new(
        palette: Palette,
        data_dir: std::path::PathBuf,
        server_bin: Option<std::path::PathBuf>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(1, 8)
                .placeholder(text::PLACEHOLDER)
        });
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
            model_menu: false,
            input,
            scroll: ScrollHandle::new(),
            answers: HashMap::new(),
        }
    }

    pub fn set_palette(&mut self, palette: Palette, cx: &mut Context<Self>) {
        self.palette = palette;
        cx.notify();
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
                    this.scroll.scroll_to_bottom();
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
                    ServerNotification::ProvidersChanged(_) => self.refresh_models(cx),
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
        cx.spawn(async move |this, cx| {
            let id = match selected {
                Some(id) => id,
                None => {
                    let cwd = std::env::current_dir()
                        .ok()
                        .map(|p| p.display().to_string());
                    let Ok(started) = b
                        .call::<ThreadStart>(ThreadStartParams {
                            cwd,
                            project: None,
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

    fn model_name(&self, label: &str) -> String {
        self.models
            .iter()
            .find(|m| m.label == label)
            .map(|m| m.model.name.clone().unwrap_or_else(|| m.model.id.clone()))
            .unwrap_or_else(|| label.to_string())
    }
}

// ---- rendering

impl Render for Workspace {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = self.palette.clone();
        div()
            .size_full()
            .bg(p.c(Token::Background))
            .text_color(p.c(Token::Foreground))
            .text_size(px(14.0))
            .p(px(8.0))
            .flex()
            .gap(px(8.0))
            .child(self.sidebar(cx))
            .child(self.main(cx))
    }
}

impl Workspace {
    fn sidebar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let p = &self.palette;
        let rows = self.threads.iter().map(|t| {
            let id = t.id.clone();
            let selected = self.selected.as_ref() == Some(&t.id);
            let title = if t.title.trim().is_empty() {
                text::UNTITLED.to_string()
            } else {
                t.title.clone()
            };
            div()
                .id(SharedString::from(format!("thread-{}", t.id)))
                .h(px(32.0))
                .px(px(12.0))
                .flex()
                .items_center()
                .rounded(px(8.0))
                .cursor_pointer()
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .text_color(p.c(Token::SidebarForeground))
                .when(selected, |d| d.bg(p.c(Token::SidebarAccent)))
                .hover(|d| d.bg(p.c(Token::SidebarAccent)))
                .child(title)
                .on_click(cx.listener(move |this, _, _, cx| this.select(id.clone(), cx)))
        });
        div()
            .w(px(260.0))
            .h_full()
            .flex_none()
            .rounded(px(16.0))
            .bg(p.pane())
            .border_1()
            .border_color(p.c(Token::SidebarBorder))
            .pt(px(44.0))
            .px(px(8.0))
            .pb(px(8.0))
            .flex()
            .flex_col()
            .gap(px(2.0))
            .child(
                div()
                    .id("new-chat")
                    .h(px(32.0))
                    .px(px(12.0))
                    .mb(px(6.0))
                    .flex()
                    .items_center()
                    .rounded(px(8.0))
                    .cursor_pointer()
                    .text_color(p.c(Token::SidebarForeground))
                    .hover(|d| d.bg(p.c(Token::SidebarAccent)))
                    .child(text::NEW_CHAT)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.selected = None;
                        cx.notify();
                    })),
            )
            .child(
                div()
                    .id("thread-list")
                    .flex_1()
                    .overflow_y_scroll()
                    .flex()
                    .flex_col()
                    .gap(px(2.0))
                    .children(rows),
            )
    }

    fn main(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let p = &self.palette;
        div()
            .flex_1()
            .min_w_0()
            .h_full()
            .rounded(px(16.0))
            .bg(p.main_pane())
            .border_1()
            .border_color(p.c(Token::Border))
            .flex()
            .flex_col()
            .child(self.transcript(cx))
            .child(self.composer(cx))
    }

    fn transcript(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let p = &self.palette;
        let view = self.selected.as_ref().and_then(|id| self.views.get(id));
        let body = div()
            .w_full()
            .max_w(px(768.0))
            .mx_auto()
            .px(px(16.0))
            .py(px(24.0))
            .flex()
            .flex_col()
            .gap(px(14.0));
        let body = match (&self.status, view) {
            (Status::Failed(m), _) => body.child(
                div()
                    .text_color(p.c(Token::Destructive))
                    .child(SharedString::from(m.clone())),
            ),
            (Status::Connecting, _) => body.child(
                div()
                    .text_color(p.c(Token::MutedForeground))
                    .child(text::CONNECTING),
            ),
            (Status::Ready, None) => body.child(
                div()
                    .pt(px(120.0))
                    .text_size(px(24.0))
                    .text_color(p.c(Token::Foreground))
                    .child(text::EMPTY_HERO),
            ),
            (Status::Ready, Some(view)) => {
                let items = crate::view_model::flat_items(&view.turns)
                    .map(|(_, item)| self.item(item))
                    .collect::<Vec<_>>();
                let questions = view
                    .questions
                    .iter()
                    .map(|(id, q)| self.question(id.clone(), q, cx))
                    .collect::<Vec<_>>();
                body.children(items).children(questions)
            }
        };
        div()
            .id("transcript")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&self.scroll)
            .child(body)
    }

    fn item(&self, item: &Item) -> AnyElement {
        let p = &self.palette;
        match item {
            Item::UserMessage { id, text } => div()
                .id(SharedString::from(format!("u-{id}")))
                .self_end()
                .max_w(relative(0.8))
                .px(px(14.0))
                .py(px(8.0))
                .rounded(px(16.0))
                .bg(p.c(Token::Secondary))
                .text_color(p.c(Token::SecondaryForeground))
                .child(SharedString::from(text.clone()))
                .into_any_element(),
            Item::AgentMessage { id, text } => div()
                .child(TextView::markdown(
                    SharedString::from(format!("a-{id}")),
                    SharedString::from(text.clone()),
                ))
                .into_any_element(),
            Item::Reasoning { id, text } => {
                let first = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
                div()
                    .id(SharedString::from(format!("r-{id}")))
                    .flex()
                    .gap(px(8.0))
                    .text_size(px(14.0))
                    .text_color(p.c(Token::MutedForeground))
                    .overflow_hidden()
                    .child(text::THINKING)
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .whitespace_nowrap()
                            .child(SharedString::from(first.to_string())),
                    )
                    .into_any_element()
            }
            Item::ToolCall {
                id,
                name,
                arguments,
                output,
                is_error,
            } => {
                let summary = tool_summary(name, arguments);
                div()
                    .id(SharedString::from(format!("t-{id}")))
                    .px(px(12.0))
                    .py(px(8.0))
                    .rounded(px(10.0))
                    .border_1()
                    .border_color(p.c(Token::Border))
                    .flex()
                    .gap(px(8.0))
                    .items_center()
                    .text_size(px(14.0))
                    .child(
                        div()
                            .px(px(6.0))
                            .rounded(px(6.0))
                            .bg(p.c(Token::Muted))
                            .text_size(px(12.0))
                            .child(SharedString::from(name.clone())),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .whitespace_nowrap()
                            .text_color(p.c(Token::MutedForeground))
                            .child(SharedString::from(summary)),
                    )
                    .child(
                        div()
                            .text_size(px(12.0))
                            .text_color(if *is_error {
                                p.c(Token::Destructive)
                            } else {
                                p.c(Token::MutedForeground)
                            })
                            .child(if output.is_none() {
                                text::RUNNING
                            } else if *is_error {
                                "失败"
                            } else {
                                "完成"
                            }),
                    )
                    .into_any_element()
            }
            Item::Error { id, message } => div()
                .id(SharedString::from(format!("e-{id}")))
                .px(px(12.0))
                .py(px(8.0))
                .rounded(px(10.0))
                .border_1()
                .border_color(p.c(Token::Destructive).opacity(0.25))
                .bg(p.c(Token::Destructive).opacity(0.05))
                .text_color(p.c(Token::Destructive))
                .child(SharedString::from(message.clone()))
                .into_any_element(),
            Item::ContextCompaction { id } => div()
                .id(SharedString::from(format!("c-{id}")))
                .flex()
                .items_center()
                .gap(px(8.0))
                .text_size(px(12.0))
                .text_color(p.c(Token::MutedForeground))
                .child(div().flex_1().h(px(1.0)).bg(p.c(Token::Border)))
                .child(text::COMPACTED)
                .child(div().flex_1().h(px(1.0)).bg(p.c(Token::Border)))
                .into_any_element(),
        }
    }

    fn question(
        &self,
        request: RequestId,
        q: &UserInputRequest,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = &self.palette;
        let total = q.questions.len();
        let blocks = q.questions.iter().map(|question| {
            let chosen = self
                .answers
                .get(&request)
                .and_then(|a| a.get(&question.id))
                .and_then(|a| a.answers.first().cloned());
            let buttons = question.options.iter().map(|opt| {
                let request = request.clone();
                let qid = question.id.clone();
                let label = opt.label.clone();
                let on = chosen.as_deref() == Some(opt.label.as_str());
                div()
                    .id(SharedString::from(format!("q-{request:?}-{qid}-{label}")))
                    .px(px(10.0))
                    .py(px(4.0))
                    .rounded(px(8.0))
                    .border_1()
                    .border_color(p.c(Token::Border))
                    .cursor_pointer()
                    .when(on, |d| {
                        d.bg(p.c(Token::Primary))
                            .text_color(p.c(Token::PrimaryForeground))
                    })
                    .hover(|d| d.bg(p.c(Token::Accent)))
                    .child(SharedString::from(opt.label.clone()))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.answer(request.clone(), total, qid.clone(), label.clone(), cx)
                    }))
            });
            div()
                .flex()
                .flex_col()
                .gap(px(6.0))
                .child(
                    div()
                        .text_color(p.c(Token::MutedForeground))
                        .text_size(px(12.0))
                        .child(SharedString::from(question.header.clone())),
                )
                .child(SharedString::from(question.question.clone()))
                .child(div().flex().gap(px(6.0)).flex_wrap().children(buttons))
        });
        div()
            .p(px(12.0))
            .rounded(px(12.0))
            .border_1()
            .border_color(p.c(Token::Border))
            .flex()
            .flex_col()
            .gap(px(12.0))
            .children(blocks)
            .into_any_element()
    }

    fn composer(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let p = &self.palette;
        let running = self
            .selected
            .as_ref()
            .and_then(|id| self.views.get(id))
            .is_some_and(|v| v.running);
        let label = self.current_model_label();
        let chip = label
            .as_deref()
            .map(|l| self.model_name(l))
            .unwrap_or_else(|| text::NO_MODEL.to_string());
        let menu = self.model_menu.then(|| {
            let items = self.models.iter().map(|m| {
                let label = m.label.clone();
                let name = m.model.name.clone().unwrap_or_else(|| m.model.id.clone());
                div()
                    .id(SharedString::from(format!("m-{}", m.label)))
                    .px(px(10.0))
                    .py(px(6.0))
                    .rounded(px(8.0))
                    .cursor_pointer()
                    .hover(|d| d.bg(p.c(Token::Accent)))
                    .child(SharedString::from(format!(
                        "{} · {}",
                        m.provider_name, name
                    )))
                    .on_click(cx.listener(move |this, _, _, cx| this.pick_model(label.clone(), cx)))
            });
            div()
                .absolute()
                .bottom(px(40.0))
                .left(px(0.0))
                .min_w(px(260.0))
                .max_h(px(320.0))
                .overflow_hidden()
                .p(px(6.0))
                .rounded(px(12.0))
                .border_1()
                .border_color(p.c(Token::Border))
                .bg(p.get(Token::GlassOverlay).unwrap_or(p.c(Token::Popover)))
                .text_color(p.c(Token::PopoverForeground))
                .flex()
                .flex_col()
                .when(self.models.is_empty(), |d| {
                    d.child(div().px(px(10.0)).py(px(6.0)).child(text::NO_MODEL_HINT))
                })
                .children(items)
        });
        div()
            .w_full()
            .max_w(px(768.0))
            .mx_auto()
            .px(px(16.0))
            .pb(px(16.0))
            .child(
                div()
                    .relative()
                    .rounded(px(16.0))
                    .border_1()
                    .border_color(p.c(Token::Border))
                    .bg(p.c(Token::Card))
                    .p(px(10.0))
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(Textarea::new(&self.input).appearance(false).bordered(false))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .child(
                                div()
                                    .id("model-chip")
                                    .px(px(8.0))
                                    .py(px(4.0))
                                    .rounded(px(8.0))
                                    .cursor_pointer()
                                    .text_size(px(12.0))
                                    .text_color(p.c(Token::MutedForeground))
                                    .hover(|d| d.bg(p.c(Token::Accent)))
                                    .child(SharedString::from(chip))
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.model_menu = !this.model_menu;
                                        cx.notify();
                                    })),
                            )
                            .child(
                                div()
                                    .id("send")
                                    .px(px(12.0))
                                    .py(px(5.0))
                                    .rounded(px(8.0))
                                    .cursor_pointer()
                                    .text_size(px(12.0))
                                    .bg(p.c(Token::Primary))
                                    .text_color(p.c(Token::PrimaryForeground))
                                    .child(if running { text::STOP } else { text::SEND })
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        if running {
                                            this.interrupt(cx);
                                        } else {
                                            this.send(window, cx);
                                        }
                                    })),
                            ),
                    )
                    .children(menu),
            )
    }
}

fn tool_summary(name: &str, args: &serde_json::Value) -> String {
    let field = |k: &str| args.get(k).and_then(|v| v.as_str());
    match name {
        "exec_command" => field("cmd")
            .unwrap_or("")
            .lines()
            .next()
            .unwrap_or("")
            .to_string(),
        "apply_patch" => field("input")
            .and_then(|p| {
                p.lines()
                    .find(|l| l.starts_with("*** ") && !l.contains("Begin"))
            })
            .unwrap_or("")
            .trim_start_matches("*** ")
            .to_string(),
        "view_image" => field("path").unwrap_or("").to_string(),
        _ => args.to_string(),
    }
}
