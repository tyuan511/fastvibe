use fastvibe_core::{
    harness::{AgentEvent, HarnessId, ModelSpec, default_harnesses},
    repository::{Message, MessageRepository, Repository, Snapshot},
};
use gpui_kit::component::{
    ActiveTheme, Icon, Sizable, TitleBar,
    button::{Button, ButtonVariants},
    input::{Input, InputEvent, InputState},
    menu::{DropdownMenu, PopupMenuItem},
    scroll::ScrollableElement,
};
use gpui_kit::{prelude::FluentBuilder, *};
use gpui_kit_assets::IconName as AssetIconName;
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    rc::Rc,
};
use uuid::Uuid;

const SIDEBAR_WIDTH: Pixels = px(280.);

pub struct App {
    repo: Rc<Repository>,
    snapshot: Snapshot,
    messages: Vec<Message>,
    catalogs: HashMap<HarnessId, Vec<ModelSpec>>,
    draft: Entity<InputState>,
    error: Option<String>,
    expanded_projects: HashSet<Uuid>,
    _draft_subscription: Subscription,
}

impl App {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let repo =
            Rc::new(Repository::open(data_path()).expect("failed to open FastVibe database"));
        let snapshot = repo.snapshot().expect("failed to read FastVibe snapshot");
        let messages = active_messages(&repo, &snapshot);
        let catalogs = default_harnesses()
            .into_iter()
            .map(|harness| (harness.id(), harness.model_catalog()))
            .collect();
        let draft =
            cx.new(|cx| InputState::new(window, cx).placeholder("发送消息，或按 ⌘ Enter 发送"));
        let subscription = cx.subscribe(&draft, |this, input, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                if let Some(session) = this.active() {
                    let _ = this
                        .repo
                        .draft(session.id, input.read(cx).value().to_string());
                    this.refresh();
                }
                cx.notify();
            }
        });
        for harness in default_harnesses() {
            let id = harness.id();
            let receiver = harness.discover_models();
            let weak = cx.entity().downgrade();
            cx.spawn_in(window, async move |_, cx| {
                if let Ok(Ok(models)) = receiver.recv().await {
                    let _ = weak.update(cx, |this, cx| {
                        this.catalogs.insert(id, models);
                        cx.notify();
                    });
                }
            })
            .detach();
        }
        let expanded_projects = snapshot.active_project.into_iter().collect();
        Self {
            repo,
            snapshot,
            messages,
            catalogs,
            draft,
            error: None,
            expanded_projects,
            _draft_subscription: subscription,
        }
    }

    fn active(&self) -> Option<fastvibe_core::Session> {
        self.snapshot
            .sessions
            .iter()
            .find(|session| Some(session.id) == self.snapshot.active_session)
            .cloned()
    }

    fn refresh(&mut self) {
        if let Ok(snapshot) = self.repo.snapshot() {
            self.messages = active_messages(&self.repo, &snapshot);
            self.snapshot = snapshot;
        }
    }

    fn select_session(&mut self, id: Uuid, cx: &mut Context<Self>) {
        match self
            .repo
            .select_session(id)
            .and_then(|_| self.repo.snapshot())
        {
            Ok(snapshot) => {
                self.messages = active_messages(&self.repo, &snapshot);
                self.snapshot = snapshot;
                cx.notify();
            }
            Err(error) => self.error = Some(error.to_string()),
        }
    }

    fn toggle_project(&mut self, id: Uuid, cx: &mut Context<Self>) {
        if !self.expanded_projects.insert(id) {
            self.expanded_projects.remove(&id);
        }
        if self.snapshot.active_project != Some(id) {
            if let Err(error) = self.repo.select_project(id) {
                self.error = Some(error.to_string());
            } else {
                self.refresh();
            }
        }
        cx.notify();
    }

    fn new_chat(&mut self, cx: &mut Context<Self>) {
        let Some(project) = self.snapshot.active_project else {
            self.error = Some("请先添加项目".into());
            cx.notify();
            return;
        };
        match self
            .repo
            .create_session(project)
            .and_then(|id| self.repo.snapshot().map(|snapshot| (id, snapshot)))
        {
            Ok((id, snapshot)) => {
                self.snapshot = snapshot;
                self.messages = active_messages(&self.repo, &self.snapshot);
                let _ = self.repo.select_session(id);
                self.refresh();
                cx.notify();
            }
            Err(error) => self.error = Some(error.to_string()),
        }
    }

    fn choose_model(&mut self, harness: HarnessId, model: String, cx: &mut Context<Self>) {
        let Some(session) = self.active() else { return };
        let effort = session.reasoning;
        match self.repo.selection(session.id, harness, model, effort) {
            Ok(()) => {
                self.refresh();
                cx.notify();
            }
            Err(error) => {
                self.error = Some(error.to_string());
                cx.notify();
            }
        }
    }

    fn submit(&mut self, cx: &mut Context<Self>) {
        let Some(session) = self.active() else { return };
        let Ok(prepared) = self.repo.prepare(session.id, &session.draft) else {
            return;
        };
        let Some(harness) = default_harnesses()
            .into_iter()
            .find(|harness| harness.id() == prepared.harness)
        else {
            return;
        };
        let run = harness.run(prepared.request);
        let run_id = prepared.run_id;
        let path = data_path();
        std::thread::spawn(move || {
            let Ok(repo) = Repository::open(path) else {
                return;
            };
            while let Ok(event) = run.events.recv_blocking() {
                let finished = matches!(event, AgentEvent::Finished { .. });
                let _ = repo.apply(run_id, &event);
                if finished {
                    break;
                }
            }
        });
        self.refresh();
        cx.notify();
    }

    fn model_button(&self, weak: WeakEntity<Self>) -> impl IntoElement {
        let session = self.active();
        let harness = session
            .as_ref()
            .map(|s| s.harness)
            .unwrap_or(HarnessId::Codex);
        let current = session
            .as_ref()
            .map(|s| s.model.clone())
            .unwrap_or_else(|| "default".into());
        let label = self
            .catalogs
            .get(&harness)
            .and_then(|models| models.iter().find(|model| model.id == current))
            .map(|model| model.label.clone())
            .unwrap_or_else(|| current.clone());
        let models = self.catalogs.get(&harness).cloned().unwrap_or_default();
        Button::new("model-picker")
            .small()
            .ghost()
            .label(label)
            .dropdown_menu(move |mut menu, _, _| {
                menu = menu.max_h(px(360.)).scrollable(true);
                for model in models.clone() {
                    let weak = weak.clone();
                    let id = model.id.clone();
                    menu = menu.item(PopupMenuItem::new(model.label).on_click(move |_, _, cx| {
                        let _ =
                            weak.update(cx, |this, cx| this.choose_model(harness, id.clone(), cx));
                    }));
                }
                menu
            })
    }

    fn harness_button(&self, weak: WeakEntity<Self>) -> impl IntoElement {
        let current = self
            .active()
            .map(|session| session.harness)
            .unwrap_or(HarnessId::Codex);
        Button::new("harness-picker")
            .small()
            .ghost()
            .label(current.label())
            .dropdown_menu(move |mut menu, _, _| {
                menu = menu.scrollable(false);
                for harness in [HarnessId::Codex, HarnessId::ClaudeCode] {
                    let weak = weak.clone();
                    menu = menu.item(PopupMenuItem::new(harness.label()).on_click(
                        move |_, _, cx| {
                            let _ = weak.update(cx, |this, cx| {
                                this.choose_model(harness, "default".into(), cx)
                            });
                        },
                    ));
                }
                menu
            })
    }
}

impl Render for App {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let projects = self.snapshot.projects.clone();
        let sessions = self.snapshot.sessions.clone();
        let active_session = self.snapshot.active_session;
        let expanded_projects = self.expanded_projects.clone();
        let messages = self.messages.clone();
        let weak = cx.entity().downgrade();
        let submit = cx.listener(|this, _, _, cx| this.submit(cx));
        let error = self.error.clone();
        let model_button = self.model_button(cx.entity().downgrade());
        let harness_button = self.harness_button(cx.entity().downgrade());
        let titlebar_foreground = cx.theme().sidebar_foreground;
        let logo_background = cx.theme().primary;
        let logo_foreground = cx.theme().primary_foreground;

        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(
                TitleBar::new().child(
                    div()
                        .w(SIDEBAR_WIDTH)
                        .h_full()
                        .flex()
                        .items_center()
                        .justify_between()
                        .pr_3()
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap_2()
                                .child(
                                    div()
                                        .size(px(22.))
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .rounded(px(6.))
                                        .bg(logo_background)
                                        .child(
                                            Icon::new(AssetIconName::Bot)
                                                .small()
                                                .text_color(logo_foreground),
                                        ),
                                )
                                .child(
                                    div()
                                        .text_sm()
                                        .text_color(titlebar_foreground)
                                        .child("FastVibe"),
                                ),
                        )
                        .child(
                            Button::new("search")
                                .ghost()
                                .small()
                                .icon(AssetIconName::Search),
                        ),
                ),
            )
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .child(sidebar(
                        projects,
                        sessions,
                        active_session,
                        expanded_projects,
                        weak.clone(),
                        cx,
                    ))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .child(
                                div()
                                    .flex_1()
                                    .min_h_0()
                                    .overflow_y_scrollbar()
                                    .p_6()
                                    .children(messages.into_iter().map(message_row)),
                            )
                            .child(
                                div()
                                    .p_4()
                                    .border_t_1()
                                    .border_color(cx.theme().border)
                                    .child(
                                        div()
                                            .flex()
                                            .items_center()
                                            .gap_2()
                                            .child(Input::new(&self.draft).flex_1())
                                            .child(harness_button)
                                            .child(model_button)
                                            .child(
                                                Button::new("send")
                                                    .primary()
                                                    .label("发送")
                                                    .on_click(submit),
                                            ),
                                    ),
                            ),
                    ),
            )
            .when_some(error, |view, error| {
                view.child(
                    div()
                        .absolute()
                        .bottom_4()
                        .left_4()
                        .right_4()
                        .p_3()
                        .bg(cx.theme().danger)
                        .text_color(cx.theme().danger_foreground)
                        .rounded_md()
                        .child(error),
                )
            })
    }
}

fn sidebar(
    projects: Vec<fastvibe_core::Project>,
    sessions: Vec<fastvibe_core::Session>,
    active_session: Option<Uuid>,
    expanded_projects: HashSet<Uuid>,
    weak: WeakEntity<App>,
    cx: &mut Context<App>,
) -> impl IntoElement {
    let row_foreground = cx.theme().sidebar_foreground;
    let row_hover = cx.theme().sidebar_accent;
    let active_row = cx.theme().sidebar_accent;
    let mut view = div()
        .w(SIDEBAR_WIDTH)
        .flex_shrink_0()
        .flex()
        .flex_col()
        .border_r_1()
        .border_color(cx.theme().sidebar_border)
        .bg(cx.theme().sidebar)
        .p_3()
        .gap_1();
    view = view.child(
        div()
            .id("new-chat")
            .h(px(34.))
            .w_full()
            .flex()
            .items_center()
            .gap_2()
            .rounded_md()
            .px_2()
            .text_sm()
            .text_color(row_foreground)
            .hover(|style| style.bg(row_hover))
            .child(Icon::new(AssetIconName::SquarePen).small())
            .child("新对话")
            .on_click(cx.listener(|this, _, _, cx| this.new_chat(cx))),
    );
    let add_project = weak.clone();
    view = view.child(
        div()
            .id("projects-header")
            .group("projects-header")
            .h(px(32.))
            .flex()
            .items_center()
            .justify_between()
            .px_2()
            .mt_3()
            .text_sm()
            .text_color(cx.theme().muted_foreground)
            .child("项目")
            .child(
                Button::new("add-project")
                    .ghost()
                    .xsmall()
                    .icon(AssetIconName::Plus)
                    .invisible()
                    .group_hover("projects-header", |style| style.visible())
                    .on_click(move |_, _, cx| {
                        let _ = add_project.update(cx, |this, cx| {
                            this.error = Some("项目选择器即将接入".into());
                            cx.notify();
                        });
                    }),
            ),
    );
    let mut project_tree = div()
        .flex_1()
        .min_h_0()
        .flex()
        .flex_col()
        .gap_0()
        .overflow_y_scrollbar();
    for project in projects.into_iter().filter(|project| !project.archived) {
        let project_id = project.id;
        let is_expanded = expanded_projects.contains(&project_id);
        let project_toggle = weak.clone();
        project_tree = project_tree.child(
            div()
                .id(SharedString::from(format!("project-{project_id}")))
                .h(px(32.))
                .w_full()
                .flex()
                .items_center()
                .gap_2()
                .px_2()
                .rounded_md()
                .text_sm()
                .text_color(row_foreground)
                .hover(|style| style.bg(row_hover))
                .child(Icon::new(if is_expanded {
                    AssetIconName::FolderOpen
                } else {
                    AssetIconName::Folder
                }))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .child(project.name),
                )
                .on_click(move |_, _, cx| {
                    let _ =
                        project_toggle.update(cx, |this, cx| this.toggle_project(project_id, cx));
                }),
        );
        if is_expanded {
            for session in sessions
                .iter()
                .filter(|session| session.project_id == project_id && !session.archived)
            {
                let id = session.id;
                let session_select = weak.clone();
                project_tree = project_tree.child(
                    div()
                        .id(SharedString::from(format!("session-{id}")))
                        .h(px(30.))
                        .w_full()
                        .flex()
                        .items_center()
                        .pl_8()
                        .pr_2()
                        .rounded_md()
                        .text_sm()
                        .text_color(row_foreground)
                        .hover(|style| style.bg(row_hover))
                        .when(active_session == Some(id), |row| row.bg(active_row))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_ellipsis()
                                .child(session.title.clone()),
                        )
                        .when(active_session == Some(id), |button| {
                            button.text_color(cx.theme().sidebar_accent_foreground)
                        })
                        .on_click(move |_, _, cx| {
                            let _ =
                                session_select.update(cx, |this, cx| this.select_session(id, cx));
                        }),
                );
            }
        }
    }
    view = view.child(project_tree);
    view
}

fn message_row(message: Message) -> impl IntoElement {
    div()
        .flex()
        .flex_col()
        .gap_1()
        .pb_4()
        .child(div().text_sm().child(message.content))
}

fn active_messages(repo: &Repository, snapshot: &Snapshot) -> Vec<Message> {
    snapshot
        .active_session
        .and_then(|id| repo.messages(id).ok())
        .unwrap_or_default()
}

fn data_path() -> PathBuf {
    std::env::var_os("FASTVIBE_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_else(|| ".".into()))
                .join(".fastvibe-app")
        })
        .join("fastvibe.db")
}
