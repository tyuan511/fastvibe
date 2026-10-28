//! Schedule cards and dialogs use the shared protocol; the GUI never owns a timer or run.
use super::model_menu::{PickerRow, picker_row_view, picker_rows, provider_groups};
use super::{
    Workspace,
    settings::{dialog_card, modal, switch},
};
use crate::ui::px;
use crate::ui::{Muted as _, TEXT_SM, TEXT_XS, icon, truncate};
use chrono::{DateTime, Days, LocalResult, NaiveDate, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use fv_protocol::methods::ScheduleHistory;
use fv_protocol::schedules::ScheduleHistory as History;
use fv_protocol::{
    methods::*,
    schedules::*,
    types::{Empty, UiLanguage},
};
use fv_theme::Token;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    component::input::{Input, InputState, Textarea, TextareaState},
    *,
};
use std::collections::HashSet;
fn ticket() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}
fn zone() -> String {
    iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".into())
}
fn now() -> DateTime<Utc> {
    DateTime::from_timestamp_millis(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
    )
    .unwrap()
}
#[derive(Default)]
pub(super) struct ScheduleUi {
    pub(super) open: bool,
    focus: Option<FocusHandle>,
    snapshot: Option<ScheduleSnapshot>,
    loading: bool,
    dirty: bool,
    epoch: u64,
    busy: HashSet<String>,
    editor: Option<Editor>,
    saving: bool,
    error: Option<String>,
    notice: Option<String>,
    detail: Option<String>,
    history: Option<History>,
    history_ticket: u64,
    confirm_delete: Option<(String, u64)>,
    /// The card grid's laid-out width, in design px, for its auto-fill column count.
    grid_width: std::rc::Rc<std::cell::Cell<f32>>,
    /// The window's height in design px, for the dialog's `max-h-[88vh]`.
    viewport_height: std::rc::Rc<std::cell::Cell<f32>>,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Menu {
    Project,
    Model,
    Limit,
    Policy,
    Kind,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Once,
    Daily,
    Weekly,
}
struct Editor {
    session: u64,
    id: Option<String>,
    version: Option<u64>,
    name: Entity<InputState>,
    prompt: Entity<TextareaState>,
    day: Entity<InputState>,
    time: Entity<InputState>,
    zone: Entity<InputState>,
    limit: u32,
    original_once: Option<(ScheduleRule, String, String, String)>,
    kind: Kind,
    days: Vec<u32>,
    project: Option<String>,
    model: Option<String>,
    enabled: bool,
    policy: MissedPolicy,
    thinking: Option<fv_protocol::types::ThinkingLevel>,
    /// The select whose options are unfolded under it.
    menu: Option<Menu>,
    /// Which provider is unfolded under `model_menu`. The schedule form lists its choices inline,
    /// so its second level opens under its provider rather than beside it.
    model_open: Option<String>,
}
fn input(label: &str, value: &str, window: &mut Window, cx: &mut App) -> Entity<InputState> {
    let e = cx.new(|cx| InputState::new(window, cx).placeholder(label.to_string()));
    e.update(cx, |s, cx| s.set_value(value.to_string(), window, cx));
    e
}
impl Editor {
    fn new(task: Option<ScheduledTask>, english: bool, window: &mut Window, cx: &mut App) -> Self {
        let timezone = zone();
        let local = now().with_timezone(&timezone.parse::<Tz>().unwrap_or(chrono_tz::UTC));
        let mut day = local
            .date_naive()
            .checked_add_days(Days::new(1))
            .unwrap()
            .to_string();
        let mut time = "09:00".to_string();
        let mut tz = timezone;
        let mut kind = Kind::Daily;
        let mut days = vec![1, 2, 3, 4, 5];
        if let Some(task) = &task {
            match &task.definition.rule {
                ScheduleRule::Once { at } => {
                    kind = Kind::Once;
                    if let Ok(at) = DateTime::parse_from_rfc3339(at) {
                        let at = at.with_timezone(&tz.parse::<Tz>().unwrap_or(chrono_tz::UTC));
                        day = at.format("%Y-%m-%d").to_string();
                        time = at.format("%H:%M").to_string();
                    }
                }
                ScheduleRule::Daily {
                    time: at,
                    time_zone,
                } => {
                    time = at.clone();
                    tz = time_zone.clone();
                }
                ScheduleRule::Weekly {
                    time: at,
                    time_zone,
                    days: selected,
                } => {
                    kind = Kind::Weekly;
                    time = at.clone();
                    tz = time_zone.clone();
                    days = selected.clone();
                }
            }
        }
        let prompt = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(4, 12)
                .placeholder(trs!(english, "schedules.page.prompt_placeholder"))
        });
        if let Some(task) = &task {
            prompt.update(cx, |s, cx| {
                s.set_value(task.definition.prompt.clone(), window, cx)
            });
        }
        Self {
            session: ticket(),
            id: task.as_ref().map(|t| t.id.clone()),
            version: task.as_ref().map(|t| t.version),
            name: input(
                trs!(english, "schedules.page.name_placeholder"),
                task.as_ref()
                    .map(|t| t.definition.name.as_str())
                    .unwrap_or(""),
                window,
                cx,
            ),
            prompt,
            day: input("YYYY-MM-DD", &day, window, cx),
            time: input("HH:MM", &time, window, cx),
            zone: input(
                trs!(english, "schedules.time_zone_e_g_asia"),
                &tz,
                window,
                cx,
            ),
            limit: task
                .as_ref()
                .map(|t| t.definition.max_run_seconds)
                .unwrap_or(3600),
            original_once: task
                .as_ref()
                .filter(|t| matches!(t.definition.rule, ScheduleRule::Once { .. }))
                .map(|t| {
                    (
                        t.definition.rule.clone(),
                        day.clone(),
                        time.clone(),
                        tz.clone(),
                    )
                }),
            kind,
            days,
            project: task.as_ref().and_then(|t| t.definition.project.clone()),
            model: task.as_ref().and_then(|t| t.definition.model.clone()),
            thinking: task.as_ref().and_then(|t| t.definition.thinking),
            enabled: task.as_ref().map(|t| t.enabled).unwrap_or(true),
            policy: task
                .as_ref()
                .map(|t| t.definition.missed_policy)
                .unwrap_or_default(),
            menu: None,
            model_open: None,
        }
    }
    fn definition(&self, cx: &App) -> Result<ScheduleDefinition, String> {
        let time = self.time.read(cx).value().trim().to_string();
        let time_zone = self.zone.read(cx).value().trim().to_string();
        let rule = match self.kind {
            Kind::Once
                if self
                    .original_once
                    .as_ref()
                    .is_some_and(|(_, day, clock, zone)| {
                        day == self.day.read(cx).value().trim()
                            && clock == &time
                            && zone == &time_zone
                    }) =>
            {
                self.original_once.as_ref().unwrap().0.clone()
            }
            Kind::Once => {
                let date = NaiveDate::parse_from_str(self.day.read(cx).value().trim(), "%Y-%m-%d")
                    .map_err(|_| "日期请填写 YYYY-MM-DD。")?;
                let clock =
                    NaiveTime::parse_from_str(&time, "%H:%M").map_err(|_| "时间请填写 HH:MM。")?;
                let zone = time_zone
                    .parse::<Tz>()
                    .map_err(|_| "请选择有效的 IANA 时区。")?;
                let at = match zone.from_local_datetime(&date.and_time(clock)) {
                    LocalResult::Single(d) => d,
                    LocalResult::Ambiguous(a, b) => a.min(b),
                    LocalResult::None => {
                        return Err("该时间在所选时区不存在，请选择其他时间。".into());
                    }
                };
                ScheduleRule::Once {
                    at: at.to_rfc3339(),
                }
            }
            Kind::Daily => ScheduleRule::Daily { time, time_zone },
            Kind::Weekly => ScheduleRule::Weekly {
                time,
                time_zone,
                days: self.days.clone(),
            },
        };
        let max_run_seconds = self.limit;
        Ok(ScheduleDefinition {
            name: self.name.read(cx).value().trim().into(),
            prompt: self.prompt.read(cx).value().to_string(),
            project: self.project.clone(),
            model: self.model.clone(),
            thinking: self.thinking,
            rule,
            max_run_seconds,
            missed_policy: self.policy,
        })
    }
}
#[derive(Clone, Copy)]
enum Action {
    Run,
    Stop,
    Toggle,
    Delete,
}
impl Workspace {
    pub(super) fn open_schedules(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.settings = None;
        self.close_menus(cx);
        self.cancel_edit(cx);
        self.cancel_terminal_compositions(cx);
        self.schedules_ui.open = true;
        if self.schedules_ui.focus.is_none() {
            self.schedules_ui.focus = Some(cx.focus_handle());
        }
        self.schedules_ui.focus.as_ref().unwrap().focus(window, cx);
        self.refresh_schedules(cx);
        self.refresh_projects(cx);
        self.refresh_models(cx);
        cx.notify();
    }
    fn close_schedules(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.schedules_ui.open = false;
        self.schedules_ui.editor = None;
        self.schedules_ui.detail = None;
        self.input.update(cx, |s, cx| s.focus(window, cx));
        cx.notify();
    }
    pub(super) fn refresh_schedules(&mut self, cx: &mut Context<Self>) {
        if !self.schedules_ui.open {
            return;
        }
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let s = &mut self.schedules_ui;
        if s.loading {
            s.dirty = true;
            return;
        }
        s.loading = true;
        let epoch = s.epoch;
        cx.spawn(async move |this, cx| {
            let result = backend.call::<ScheduleList>(Empty {}).await;
            let _ = this.update(cx, |this, cx| {
                let s = &mut this.schedules_ui;
                s.loading = false;
                if s.epoch == epoch {
                    match result {
                        Ok(snapshot) => s.snapshot = Some(snapshot),
                        Err(e) => s.error = Some(e.to_string()),
                    }
                } else {
                    s.dirty = true;
                }
                if std::mem::take(&mut s.dirty) {
                    this.refresh_schedules(cx);
                }
                if this.schedules_ui.detail.is_some() {
                    let offset = this
                        .schedules_ui
                        .history
                        .as_ref()
                        .map(|h| h.offset)
                        .unwrap_or(0);
                    this.refresh_schedule_history(offset, cx);
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn refresh_schedule_history(&mut self, offset: u32, cx: &mut Context<Self>) {
        let Some(id) = self.schedules_ui.detail.clone() else {
            return;
        };
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let request = ticket();
        self.schedules_ui.history_ticket = request;
        cx.spawn(async move |this, cx| {
            let result = backend
                .call::<ScheduleHistory>(ScheduleHistoryParams {
                    task_id: id.clone(),
                    offset,
                    limit: Some(30),
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                let s = &mut this.schedules_ui;
                if s.detail.as_ref() != Some(&id) || s.history_ticket != request {
                    return;
                }
                match result {
                    Ok(history) => s.history = Some(history),
                    Err(e) => s.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn edit_schedule(
        &mut self,
        task: Option<ScheduledTask>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.schedules_ui.saving {
            return;
        }
        self.schedules_ui.editor = Some(Editor::new(
            task,
            self.app_settings.language == UiLanguage::English,
            window,
            cx,
        ));
        self.schedules_ui.detail = None;
        self.schedules_ui.error = None;
        self.schedules_ui.notice = None;
        cx.notify();
    }
    fn save_schedule(&mut self, cx: &mut Context<Self>) {
        if self.schedules_ui.saving {
            return;
        }
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(e) = &self.schedules_ui.editor else {
            return;
        };
        let definition = match e.definition(cx) {
            Ok(d) => d,
            Err(error) => {
                self.schedules_ui.error = Some(error);
                cx.notify();
                return;
            }
        };
        let session = e.session;
        let enabled = e.enabled;
        let request = ScheduleUpsertParams {
            task_id: e.id.clone(),
            expected_version: e.version,
            definition: definition.clone(),
            enabled,
        };
        self.schedules_ui.saving = true;
        self.schedules_ui.epoch = ticket();
        self.schedules_ui.error = None;
        cx.spawn(async move |this, cx| {
            let result = backend.call::<ScheduleUpsert>(request).await;
            let _ = this.update(cx, |this, cx| {
                this.schedules_ui.saving = false;
                this.schedules_ui.epoch = ticket();
                match result {
                    Ok(task) => {
                        let pristine = this
                            .schedules_ui
                            .editor
                            .as_ref()
                            .filter(|e| e.session == session)
                            .is_some_and(|e| {
                                e.enabled == enabled
                                    && e.definition(cx).ok().as_ref() == Some(&definition)
                            });
                        if let Some(e) = this
                            .schedules_ui
                            .editor
                            .as_mut()
                            .filter(|e| e.session == session)
                        {
                            e.id = Some(task.id.clone());
                            e.version = Some(task.version);
                        }
                        if pristine {
                            this.schedules_ui.editor = None;
                        } else {
                            this.schedules_ui.notice = Some(
                                trs!(this.english(), "schedules.saved_edits_made_while_saving")
                                    .into(),
                            );
                        }
                    }
                    Err(error) => {
                        this.schedules_ui.error = Some(tr!(
                            this.english(),
                            "schedules.save_failed_the_draft_was",
                            error = error
                        ))
                    }
                }
                this.refresh_schedules(cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn schedule_action(&mut self, task: ScheduledTask, action: Action, cx: &mut Context<Self>) {
        if self.schedules_ui.busy.contains(&task.id) {
            return;
        }
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let delete_version = if matches!(action, Action::Delete) {
            match &self.schedules_ui.confirm_delete {
                Some((id, version)) if id == &task.id => Some(*version),
                _ => {
                    self.schedules_ui.confirm_delete = Some((task.id, task.version));
                    cx.notify();
                    return;
                }
            }
        } else {
            None
        };
        let id = task.id.clone();
        self.schedules_ui.busy.insert(id.clone());
        self.schedules_ui.error = None;
        self.schedules_ui.epoch = ticket();
        cx.spawn(async move |this, cx| {
            let result = match action {
                Action::Run => backend
                    .call::<ScheduleRunNow>(ScheduleIdParams {
                        task_id: id.clone(),
                    })
                    .await
                    .map(|_| ()),
                Action::Stop => backend
                    .call::<ScheduleStop>(ScheduleIdParams {
                        task_id: id.clone(),
                    })
                    .await
                    .map(|_| ()),
                Action::Toggle => backend
                    .call::<ScheduleUpsert>(ScheduleUpsertParams {
                        task_id: Some(id.clone()),
                        expected_version: Some(task.version),
                        definition: task.definition,
                        enabled: !task.enabled,
                    })
                    .await
                    .map(|_| ()),
                Action::Delete => backend
                    .call::<ScheduleDelete>(ScheduleDeleteParams {
                        task_id: id.clone(),
                        expected_version: delete_version.unwrap(),
                    })
                    .await
                    .map(|_| ()),
            };
            let _ = this.update(cx, |this, cx| {
                let s = &mut this.schedules_ui;
                s.busy.remove(&id);
                s.epoch = ticket();
                s.confirm_delete = None;
                match result {
                    Ok(()) => {
                        if matches!(action, Action::Delete) && s.detail.as_ref() == Some(&id) {
                            s.detail = None;
                            s.history = None;
                        }
                    }
                    Err(e) => s.error = Some(e.to_string()),
                }
                this.refresh_schedules(cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    pub(super) fn schedules_page(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = &self.palette;
        let s = &self.schedules_ui;
        let english = self.app_settings.language == UiLanguage::English;
        let collapsed = self.app_settings.sidebar.collapsed;
        // `grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3`, from the width last laid out.
        let width = s.grid_width.get();
        let cols = (((width + 12.0) / (240.0 + 12.0)).floor() as usize).max(1);
        let card_w = if width > 0.0 {
            (width - 12.0 * (cols as f32 - 1.0)) / cols as f32
        } else {
            240.0
        };
        let measured = s.grid_width.clone();
        let recorder = canvas(
            move |bounds, window: &mut Window, _| {
                let w = f32::from(bounds.size.width) / f32::from(window.rem_size()) * 16.0;
                if (measured.get() - w).abs() > 0.5 {
                    measured.set(w);
                    window.refresh();
                }
            },
            |_, _, _, _| {},
        )
        .absolute()
        .inset_0();
        let body: AnyElement = match &s.snapshot {
            None => div()
                .py(px(64.0))
                .flex()
                .justify_center()
                .child(crate::ui::spinner(
                    "schedules-loading",
                    16.0,
                    p.c(Token::MutedForeground),
                ))
                .into_any_element(),
            Some(snapshot) if snapshot.tasks.is_empty() => div()
                .py(px(64.0))
                .flex()
                .flex_col()
                .items_center()
                .gap(px(16.0))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .items_center()
                        .gap(px(8.0))
                        .child(
                            div()
                                .mb(px(8.0))
                                .size(px(32.0))
                                .rounded(px(8.0))
                                .bg(p.c(Token::Muted))
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(icon("clock01", 16.0, p.c(Token::Foreground))),
                        )
                        .child(
                            div()
                                .text_size(px(TEXT_SM))
                                .font_weight(FontWeight::MEDIUM)
                                .child(trs!(english, "schedules.page.empty_title")),
                        )
                        .child(
                            div()
                                .text_size(px(TEXT_SM))
                                .line_height(px(20.0))
                                .muted(p)
                                .child(trs!(english, "schedules.page.empty_desc")),
                        ),
                )
                .child(
                    button("schedule-empty-new", Btn::Primary, false, p)
                        .h(px(32.0))
                        .child(icon("add01", 16.0, p.c(Token::PrimaryForeground)))
                        .child(trs!(english, "schedules.page.new"))
                        .on_click(
                            cx.listener(|this, _, window, cx| this.edit_schedule(None, window, cx)),
                        ),
                )
                .into_any_element(),
            Some(snapshot) => {
                let mut tasks = snapshot.tasks.clone();
                tasks.sort_by(|a, b| {
                    b.enabled
                        .cmp(&a.enabled)
                        .then(
                            a.next_run_at
                                .unwrap_or(i64::MAX)
                                .cmp(&b.next_run_at.unwrap_or(i64::MAX)),
                        )
                        .then(a.definition.name.cmp(&b.definition.name))
                });
                let mut grid = div().relative().w_full().flex().flex_wrap().gap(px(12.0));
                for task in tasks {
                    let (status, variant) = task_status(&task, snapshot, english);
                    let running = snapshot
                        .active
                        .as_ref()
                        .is_some_and(|r| r.task_id == task.id);
                    let open = task.id.clone();
                    let summary = summary(&task.definition.rule, english);
                    let hover_border = p.c(Token::Primary).opacity(0.3);
                    let hover_bg = p.c(Token::Muted).opacity(0.2);
                    grid = grid.child(
                        div()
                            .id(SharedString::from(format!("schedule-card-{}", task.id)))
                            .w(px(card_w))
                            .flex_none()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(10.0))
                            .p(px(12.0))
                            .rounded(px(12.0))
                            .border_1()
                            .border_color(p.c(Token::Border))
                            .bg(p.c(Token::Card).opacity(0.8))
                            .cursor_pointer()
                            .hover(move |d| d.border_color(hover_border).bg(hover_bg))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(10.0))
                                    .min_w_0()
                                    .child(
                                        div()
                                            .size(px(36.0))
                                            .flex_none()
                                            .rounded(px(12.0))
                                            .bg(p.c(Token::Info).opacity(0.1))
                                            .border_1()
                                            .border_color(p.c(Token::Info).opacity(0.15))
                                            .flex()
                                            .items_center()
                                            .justify_center()
                                            .child(if running {
                                                crate::ui::spinner(
                                                    SharedString::from(format!(
                                                        "schedule-spin-{}",
                                                        task.id
                                                    )),
                                                    16.0,
                                                    p.c(Token::Info),
                                                )
                                                .into_any_element()
                                            } else {
                                                icon("clock01", 20.0, p.c(Token::Info))
                                                    .into_any_element()
                                            }),
                                    )
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w_0()
                                            .flex()
                                            .flex_col()
                                            .child(
                                                truncate(task.definition.name.clone())
                                                    .text_size(px(TEXT_SM))
                                                    .line_height(px(20.0))
                                                    .font_weight(FontWeight::MEDIUM),
                                            )
                                            .child(
                                                truncate(summary)
                                                    .text_size(px(TEXT_XS))
                                                    .line_height(px(16.0))
                                                    .muted(p),
                                            ),
                                    ),
                            )
                            .child(
                                div()
                                    .min_h(px(32.0))
                                    .text_size(px(TEXT_XS))
                                    .line_height(px(16.0))
                                    .line_clamp(2)
                                    .muted(p)
                                    .child(task.definition.prompt.clone()),
                            )
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .gap(px(8.0))
                                    .child(
                                        truncate(format!(
                                            "{} {}",
                                            trs!(english, "schedules.page.next"),
                                            when(
                                                task.enabled.then_some(task.next_run_at).flatten(),
                                                english
                                            )
                                        ))
                                        .flex_1()
                                        .text_size(px(TEXT_XS))
                                        .line_height(px(16.0))
                                        .muted(p),
                                    )
                                    .child(badge(status, variant, p)),
                            )
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.schedules_ui.detail = Some(open.clone());
                                this.schedules_ui.history = None;
                                this.schedules_ui.confirm_delete = None;
                                this.schedules_ui.error = None;
                                this.refresh_schedule_history(0, cx);
                                cx.notify();
                            })),
                    );
                }
                grid.child(recorder).into_any_element()
            }
        };
        let mac = cfg!(target_os = "macos");
        let viewport = s.viewport_height.clone();
        let viewport_recorder = canvas(
            move |_, window: &mut Window, _| {
                let h =
                    f32::from(window.viewport_size().height) / f32::from(window.rem_size()) * 16.0;
                if (viewport.get() - h).abs() > 0.5 {
                    viewport.set(h);
                    window.refresh();
                }
            },
            |_, _, _, _| {},
        )
        .absolute()
        .size_0();
        let mut page = div()
            .relative()
            .child(viewport_recorder)
            .flex_1()
            .min_w_0()
            .h_full()
            .flex()
            .flex_col()
            .text_size(px(TEXT_SM))
            .child(
                // `pt-4` below the 8px the conversation column keeps at the top.
                div().flex_none().pt(px(24.0)).child(
                    div()
                        .mx_auto()
                        .w_full()
                        .max_w(px(1024.0))
                        .px(px(24.0))
                        .pb(px(12.0))
                        .flex()
                        .items_start()
                        .gap(px(4.0))
                        .when(collapsed, |d| {
                            d.when(mac, |d| d.pl(px(96.0))).child(
                                crate::ui::icon_button(
                                    "schedules-expand-sidebar",
                                    "panel-left-open",
                                    p,
                                )
                                .mt(px(2.0))
                                .on_click(cx.listener(
                                    |this, _, window, cx| {
                                        this.on_toggle_sidebar(&super::ToggleSidebar, window, cx)
                                    },
                                )),
                            )
                        })
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .flex_col()
                                .gap(px(4.0))
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap(px(8.0))
                                        .child(
                                            truncate(trs!(english, "schedules.page.title"))
                                                .flex_1()
                                                .text_size(px(20.0))
                                                .line_height(px(28.0))
                                                .font_weight(FontWeight::MEDIUM),
                                        )
                                        .child(
                                            button("schedule-new", Btn::Primary, false, p)
                                                .child(icon(
                                                    "add01",
                                                    14.0,
                                                    p.c(Token::PrimaryForeground),
                                                ))
                                                .child(trs!(english, "schedules.page.new"))
                                                .on_click(cx.listener(|this, _, window, cx| {
                                                    this.edit_schedule(None, window, cx)
                                                })),
                                        ),
                                )
                                .child(
                                    div()
                                        .text_size(px(TEXT_SM))
                                        .line_height(px(20.0))
                                        .muted(p)
                                        .child(trs!(english, "schedules.page.lifetime")),
                                ),
                        ),
                ),
            )
            .child(
                div()
                    .id("schedules-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(
                        div()
                            .mx_auto()
                            .w_full()
                            .max_w(px(1024.0))
                            .px(px(24.0))
                            .pt(px(4.0))
                            .pb(px(40.0))
                            .flex()
                            .flex_col()
                            .gap(px(20.0))
                            .children(
                                s.error
                                    .as_ref()
                                    .filter(|_| s.detail.is_none() && s.editor.is_none())
                                    .map(|e| {
                                        div()
                                            .text_size(px(TEXT_SM))
                                            .text_color(p.c(Token::Destructive))
                                            .child(e.clone())
                                    }),
                            )
                            .child(body),
                    ),
            );
        if let Some(focus) = &s.focus {
            page = page.track_focus(focus);
        }
        page.into_any_element()
    }

    /// `DialogContent sm:max-w-3xl`: a title row with the close ✕, then the body.
    fn schedule_dialog_frame(
        &self,
        title: AnyElement,
        body: AnyElement,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = &self.palette;
        let card = dialog_card(p, 768.0)
            .relative()
            .max_h(px(match self.schedules_ui.viewport_height.get() {
                h if h > 0.0 => h * 0.88,
                _ => 600.0,
            }))
            .p(px(16.0))
            .gap(px(16.0))
            .text_size(px(TEXT_SM))
            .child(div().pr(px(32.0)).child(title))
            .child(
                div()
                    .id("schedule-dialog-body")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(body),
            )
            .child(
                crate::ui::icon_button("schedule-dialog-close", "cancel01", p)
                    .absolute()
                    .top(px(8.0))
                    .right(px(8.0))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.close_schedule_dialog();
                        cx.notify();
                    })),
            );
        modal(card, p, cx, |this| this.close_schedule_dialog())
    }

    fn close_schedule_dialog(&mut self) {
        let s = &mut self.schedules_ui;
        if s.saving {
            return;
        }
        // Cancelling an edit returns to the task it came from, as the Electron form does.
        if let Some(e) = s.editor.take() {
            s.detail = e.id;
        } else {
            s.detail = None;
        }
        s.error = None;
        s.confirm_delete = None;
    }

    pub(super) fn schedule_dialog(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.schedules_ui.open || self.settings.is_some() {
            return None;
        }
        if let Some(editor) = &self.schedules_ui.editor {
            return Some(self.schedule_editor(editor, cx));
        }
        let id = self.schedules_ui.detail.as_ref()?;
        let snapshot = self.schedules_ui.snapshot.as_ref()?;
        let task = snapshot.tasks.iter().find(|t| &t.id == id)?.clone();
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let (status, variant) = task_status(&task, snapshot, english);
        let running = snapshot
            .active
            .as_ref()
            .is_some_and(|r| r.task_id == task.id);
        let queued = !running && snapshot.queued.iter().any(|r| r.task_id == task.id);
        let busy = self.schedules_ui.busy.contains(&task.id);
        let title = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(8.0))
            .child(
                truncate(task.definition.name.clone())
                    .min_w_0()
                    .text_size(px(16.0))
                    .line_height(px(16.0))
                    .font_weight(FontWeight::MEDIUM),
            )
            .child(badge(status, variant, p))
            .into_any_element();

        let edit = task.clone();
        let toggle = task.clone();
        let act = task.clone();
        let remove = task.clone();
        let once_past = match &task.definition.rule {
            ScheduleRule::Once { at } => DateTime::parse_from_rfc3339(at)
                .map(|d| d.timestamp_millis() <= now().timestamp_millis())
                .unwrap_or(true),
            _ => false,
        };
        let mut actions = div().flex().flex_wrap().gap(px(8.0)).child(
            button("schedule-edit", Btn::Outline, busy, p)
                .child(icon("pencil-edit02", 14.0, p.c(Token::Foreground)))
                .child(trs!(english, "schedules.edit"))
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.edit_schedule(Some(edit.clone()), window, cx)
                })),
        );
        if task.enabled || !once_past {
            actions = actions.child(
                button("schedule-toggle", Btn::Outline, busy, p)
                    .child(icon(
                        if task.enabled { "pause" } else { "play" },
                        14.0,
                        p.c(Token::Foreground),
                    ))
                    .child(if task.enabled {
                        trs!(english, "schedules.pause")
                    } else {
                        trs!(english, "schedules.page.resume")
                    })
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.schedule_action(toggle.clone(), Action::Toggle, cx)
                    })),
            );
        }
        actions = if running || queued {
            actions.child(
                button("schedule-stop", Btn::Outline, busy, p)
                    .child(icon("stop", 14.0, p.c(Token::Foreground)))
                    .child(if running {
                        trs!(english, "schedules.page.stop")
                    } else {
                        trs!(english, "schedules.page.cancel_queued")
                    })
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.schedule_action(act.clone(), Action::Stop, cx)
                    })),
            )
        } else {
            actions.child(
                button("schedule-run", Btn::Primary, busy, p)
                    .child(icon("play", 14.0, p.c(Token::PrimaryForeground)))
                    .child(trs!(english, "schedules.run_now"))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.schedule_action(act.clone(), Action::Run, cx)
                    })),
            )
        };
        actions = actions.child(
            button("schedule-delete", Btn::Destructive, busy, p)
                .child(icon("delete02", 14.0, p.c(Token::Destructive)))
                .child(trs!(english, "schedules.page.delete"))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.schedules_ui.confirm_delete = Some((remove.id.clone(), remove.version));
                    cx.notify();
                })),
        );

        let project = task
            .definition
            .project
            .as_ref()
            .map(|path| {
                self.projects
                    .iter()
                    .find(|p| &p.path == path)
                    .map(|p| p.name.clone())
                    .unwrap_or_else(|| path.clone())
            })
            .unwrap_or_else(|| trs!(english, "schedules.page.project_scratch").into());
        let model = task.definition.model.as_ref().map(|id| {
            self.models
                .iter()
                .find(|m| &m.label == id)
                .map(|m| format!("{} / {}", m.provider_name, m.model.id))
                .unwrap_or_else(|| id.clone())
        });
        let mut facts: Vec<(&'static str, String)> = vec![
            (
                trs!(english, "schedules.page.time_limit"),
                duration_label(task.definition.max_run_seconds, english),
            ),
            (
                trs!(english, "schedules.page.missed_policy"),
                match task.definition.missed_policy {
                    MissedPolicy::Skip => trs!(english, "schedules.page.missed_skip"),
                    MissedPolicy::RunLatest => trs!(english, "schedules.page.missed_run_latest"),
                }
                .into(),
            ),
            (trs!(english, "schedules.page.project"), project),
        ];
        if let Some(model) = model {
            facts.push((trs!(english, "schedules.model"), model));
        }
        facts.push((
            trs!(english, "schedules.page.next"),
            when(task.enabled.then_some(task.next_run_at).flatten(), english),
        ));
        facts.push((
            trs!(english, "schedules.page.last"),
            when(task.last_run_at, english),
        ));
        let mut grid = div().flex().flex_wrap().gap_y(px(12.0));
        for (label, value) in facts {
            grid = grid.child(
                div()
                    .w(relative(0.5))
                    .pr(px(12.0))
                    .flex()
                    .flex_col()
                    .gap(px(2.0))
                    .child(
                        div()
                            .text_size(px(TEXT_XS))
                            .line_height(px(16.0))
                            .muted(p)
                            .child(label),
                    )
                    .child(truncate(value).text_size(px(TEXT_SM)).line_height(px(20.0))),
            );
        }

        let mut history = div().flex().flex_col().gap(px(8.0)).child(
            div()
                .text_size(px(TEXT_SM))
                .font_weight(FontWeight::MEDIUM)
                .child(trs!(english, "schedules.page.history")),
        );
        match &self.schedules_ui.history {
            None => {
                history = history.child(
                    div()
                        .muted(p)
                        .child(trs!(english, "schedules.page.history_loading")),
                )
            }
            Some(h) if h.runs.is_empty() => {
                history = history.child(
                    div()
                        .rounded(px(12.0))
                        .border_1()
                        .border_dashed()
                        .border_color(p.c(Token::Border))
                        .px(px(12.0))
                        .py(px(32.0))
                        .flex()
                        .justify_center()
                        .muted(p)
                        .child(trs!(english, "schedules.page.history_empty")),
                )
            }
            Some(h) => {
                let mut runs = h.runs.clone();
                runs.sort_by(|a, b| b.scheduled_at.cmp(&a.scheduled_at).then(b.id.cmp(&a.id)));
                for run in runs {
                    let status = run_status(&run, english);
                    let times = [
                        run.started_at.map(|t| {
                            tr!(
                                english,
                                "schedules.page.started_at",
                                time = when(Some(t), english)
                            )
                        }),
                        run.ended_at.map(|t| {
                            tr!(
                                english,
                                "schedules.page.ended_at",
                                time = when(Some(t), english)
                            )
                        }),
                    ]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(" · ");
                    let mut row = div()
                        .flex()
                        .flex_col()
                        .gap(px(6.0))
                        .rounded(px(12.0))
                        .border_1()
                        .border_color(p.c(Token::Border))
                        .px(px(12.0))
                        .py(px(10.0))
                        .child(
                            div()
                                .flex()
                                .flex_wrap()
                                .items_center()
                                .gap(px(8.0))
                                .child(badge(status.0, status.1, p))
                                .when(run.manual, |d| {
                                    d.child(badge(
                                        trs!(english, "schedules.manual"),
                                        BadgeKind::Outline,
                                        p,
                                    ))
                                })
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .text_size(px(TEXT_XS))
                                        .muted(p)
                                        .child(tr!(
                                            english,
                                            "schedules.page.scheduled_at",
                                            time = when(Some(run.scheduled_at), english)
                                        )),
                                ),
                        )
                        .when(!times.is_empty(), |d| {
                            d.child(div().text_size(px(TEXT_XS)).muted(p).child(times))
                        })
                        .children(run.error.as_ref().map(|e| {
                            div()
                                .text_size(px(TEXT_XS))
                                .text_color(p.c(Token::Destructive))
                                .child(e.clone())
                        }));
                    if let Some(thread) = &run.thread_id {
                        let thread = thread.clone();
                        row = row.child(
                            div()
                                .id(SharedString::from(format!("schedule-output-{}", run.id)))
                                .text_size(px(12.8))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(p.c(Token::Primary))
                                .cursor_pointer()
                                .hover(|d| d.underline())
                                .child(if run.waiting_for_input {
                                    trs!(english, "schedules.view_and_answer")
                                } else {
                                    trs!(english, "schedules.page.open_conversation")
                                })
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.schedules_ui.detail = None;
                                    this.close_schedules(window, cx);
                                    this.select(thread.clone(), cx);
                                })),
                        );
                    }
                    history = history.child(row);
                }
                let prev = h.offset.saturating_sub(30);
                let next = h.offset + 30;
                if h.offset > 0 || next < h.total {
                    history = history.child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(8.0))
                            .text_size(px(TEXT_XS))
                            .muted(p)
                            .child(format!("{} / {}", h.offset + h.runs.len() as u32, h.total))
                            .child(
                                div()
                                    .flex()
                                    .gap(px(8.0))
                                    .when(h.offset > 0, |d| {
                                        d.child(
                                            button("schedule-history-prev", Btn::Outline, false, p)
                                                .child(trs!(english, "schedules.previous"))
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.refresh_schedule_history(prev, cx)
                                                })),
                                        )
                                    })
                                    .when(next < h.total, |d| {
                                        d.child(
                                            button("schedule-history-next", Btn::Outline, false, p)
                                                .child(trs!(english, "schedules.next"))
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.refresh_schedule_history(next, cx)
                                                })),
                                        )
                                    }),
                            ),
                    );
                }
            }
        }

        let body = div()
            .flex()
            .flex_col()
            .gap(px(20.0))
            .child(
                div()
                    .muted(p)
                    .child(summary(&task.definition.rule, english)),
            )
            .when(queued, |d| {
                d.child(
                    div()
                        .text_color(p.c(Token::Warning))
                        .child(trs!(english, "schedules.page.queue_reason")),
                )
            })
            .child(actions)
            .children(
                self.schedules_ui
                    .error
                    .as_ref()
                    .map(|e| div().text_color(p.c(Token::Destructive)).child(e.clone())),
            )
            .child(grid)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .child(
                        div()
                            .font_weight(FontWeight::MEDIUM)
                            .child(trs!(english, "schedules.page.prompt")),
                    )
                    .child(
                        div()
                            .rounded(px(12.0))
                            .border_1()
                            .border_color(p.c(Token::Border))
                            .bg(p.c(Token::Muted).opacity(0.4))
                            .px(px(12.0))
                            .py(px(8.0))
                            .child(task.definition.prompt.clone()),
                    ),
            )
            .child(history)
            .into_any_element();
        let dialog = self.schedule_dialog_frame(title, body, cx);
        let confirm = self
            .schedules_ui
            .confirm_delete
            .as_ref()
            .filter(|(id, _)| id == &task.id)
            .map(|_| self.schedule_delete_alert(&task, cx));
        Some(
            div()
                .absolute()
                .inset_0()
                .child(dialog)
                .children(confirm)
                .into_any_element(),
        )
    }

    /// `AlertDialog`: the delete confirmation over the task's own dialog.
    fn schedule_delete_alert(&self, task: &ScheduledTask, cx: &mut Context<Self>) -> AnyElement {
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let busy = self.schedules_ui.busy.contains(&task.id);
        let remove = task.clone();
        let card = dialog_card(p, 384.0)
            .p(px(16.0))
            .gap(px(16.0))
            .text_size(px(TEXT_SM))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(
                        div()
                            .text_size(px(16.0))
                            .font_weight(FontWeight::MEDIUM)
                            .child(trs!(english, "schedules.page.delete_title")),
                    )
                    .child(div().muted(p).child(tr!(
                        english,
                        "schedules.page.delete_desc",
                        name = task.definition.name.clone()
                    ))),
            )
            .child(
                div()
                    .mx(px(-16.0))
                    .mb(px(-16.0))
                    .p(px(16.0))
                    .flex()
                    .justify_end()
                    .gap(px(8.0))
                    .border_t_1()
                    .border_color(p.c(Token::Border))
                    .bg(p.c(Token::Muted).opacity(0.5))
                    .rounded_b(px(16.0))
                    .child(
                        button("schedule-delete-cancel", Btn::Outline, busy, p)
                            .h(px(32.0))
                            .child(trs!(english, "schedules.page.cancel"))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.schedules_ui.confirm_delete = None;
                                cx.notify();
                            })),
                    )
                    .child(
                        button("schedule-delete-confirm", Btn::Destructive, busy, p)
                            .h(px(32.0))
                            .child(trs!(english, "schedules.page.delete"))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.schedule_action(remove.clone(), Action::Delete, cx)
                            })),
                    ),
            );
        modal(card, p, cx, |this| this.schedules_ui.confirm_delete = None)
    }

    pub(super) fn dismiss_schedule(&mut self, cx: &mut Context<Self>) -> bool {
        if !self.schedules_ui.open || self.settings.is_some() {
            return false;
        }
        if let Some(e) = &mut self.schedules_ui.editor
            && e.menu.is_some()
        {
            e.menu = None;
            e.model_open = None;
        } else if self.schedules_ui.confirm_delete.is_some() {
            self.schedules_ui.confirm_delete = None;
        } else if self.schedules_ui.editor.is_some() || self.schedules_ui.detail.is_some() {
            self.close_schedule_dialog();
        } else {
            return false;
        }
        cx.notify();
        true
    }

    fn schedule_editor(&self, e: &Editor, cx: &mut Context<Self>) -> AnyElement {
        use fv_protocol::types::ThinkingLevel;
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let saving = self.schedules_ui.saving;
        let toggle = |menu: Menu| {
            cx.listener(
                move |this: &mut Self, _: &ClickEvent, _: &mut Window, cx: &mut Context<Self>| {
                    if let Some(e) = &mut this.schedules_ui.editor {
                        e.menu = if e.menu == Some(menu) {
                            None
                        } else {
                            Some(menu)
                        };
                        e.model_open = None;
                    }
                    cx.notify();
                },
            )
        };
        let mut form = div().flex().flex_col().gap(px(16.0));
        form = form
            .child(field(
                trs!(english, "schedules.page.name"),
                Input::new(&e.name).into_any_element(),
                None,
                p,
            ))
            .child(field(
                trs!(english, "schedules.page.prompt"),
                Textarea::new(&e.prompt)
                    .aria_label(trs!(english, "schedules.page.prompt"))
                    .into_any_element(),
                None,
                p,
            ));

        // 项目
        let project_label = e
            .project
            .as_ref()
            .map(|path| {
                self.projects
                    .iter()
                    .find(|p| &p.path == path)
                    .map(|p| p.name.clone())
                    .unwrap_or_else(|| tr!(english, "schedules.page.project_missing", path = path))
            })
            .unwrap_or_else(|| trs!(english, "schedules.page.project_scratch").into());
        let mut project = div().flex().flex_col().gap(px(4.0)).child(
            select_trigger(
                "schedule-project",
                project_label,
                e.menu == Some(Menu::Project),
                p,
            )
            .on_click(toggle(Menu::Project)),
        );
        if e.menu == Some(Menu::Project) {
            let mut list = options(p, "schedule-project-list");
            for (i, (value, label)) in std::iter::once((
                None,
                trs!(english, "schedules.page.project_scratch").to_string(),
            ))
            .chain(
                self.projects
                    .iter()
                    .map(|p| (Some(p.path.clone()), p.name.clone())),
            )
            .enumerate()
            {
                let selected = e.project == value;
                list = list.child(
                    option(
                        SharedString::from(format!("schedule-project-choice-{i}")),
                        label,
                        selected,
                        p,
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(e) = &mut this.schedules_ui.editor {
                            e.project = value.clone();
                            e.menu = None;
                        }
                        cx.notify();
                    })),
                );
            }
            project = project.child(list);
        }
        form = form.child(field(
            trs!(english, "schedules.page.project"),
            project.into_any_element(),
            Some(trs!(english, "schedules.page.project_hint")),
            p,
        ));

        // 模型 and 思考强度: native-only, the task's own model choice.
        let model_label = e
            .model
            .as_ref()
            .map(|id| {
                self.models
                    .iter()
                    .find(|m| &m.label == id)
                    .map(|m| format!("{} / {}", m.provider_name, m.model.id))
                    .unwrap_or_else(|| tr!(english, "schedules.model_unavailable_id", id = id))
            })
            .unwrap_or_else(|| trs!(english, "schedules.use_default_model").into());
        let mut model = div().flex().flex_col().gap(px(4.0)).child(
            select_trigger(
                "schedule-model",
                model_label,
                e.menu == Some(Menu::Model),
                p,
            )
            .on_click(toggle(Menu::Model)),
        );
        if e.menu == Some(Menu::Model) {
            let mut list = options(p, "schedule-model-list").max_h(px(240.0));
            list = list.child(
                option(
                    "schedule-model-inherit".into(),
                    trs!(english, "schedules.use_default_model").into(),
                    e.model.is_none(),
                    p,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    if let Some(e) = &mut this.schedules_ui.editor {
                        e.model = None;
                        e.menu = None;
                    }
                    cx.notify();
                })),
            );
            // A task picks one model out of every provider's, so the list folds by provider the
            // same way the composer's chip does — inline here, because this picker lives in a form.
            let open = e.model_open.clone();
            let current = e.model.clone();
            for row in picker_rows(
                &provider_groups(&self.models),
                open.as_deref(),
                current.as_deref(),
            ) {
                let view = picker_row_view("schedule-model", &row, p);
                list = list.child(match row {
                    PickerRow::Provider { id, .. } => {
                        view.on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(e) = &mut this.schedules_ui.editor {
                                e.model_open = if e.model_open.as_deref() == Some(id.as_str()) {
                                    None
                                } else {
                                    Some(id.clone())
                                };
                            }
                            cx.notify();
                        }))
                    }
                    PickerRow::Model { label, .. } => {
                        view.on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(e) = &mut this.schedules_ui.editor {
                                e.model = Some(label.clone());
                                e.menu = None;
                                e.model_open = None;
                            }
                            cx.notify();
                        }))
                    }
                });
            }
            model = model.child(list);
        }
        let mut thinking = div().flex().flex_wrap().gap(px(8.0));
        for (i, value) in [
            None,
            Some(ThinkingLevel::Minimal),
            Some(ThinkingLevel::Low),
            Some(ThinkingLevel::Medium),
            Some(ThinkingLevel::High),
            Some(ThinkingLevel::Xhigh),
            Some(ThinkingLevel::Max),
        ]
        .into_iter()
        .enumerate()
        {
            thinking = thinking.child(
                chip(
                    SharedString::from(format!("schedule-thinking-{i}")),
                    e.thinking == value,
                    p,
                )
                .child(
                    value
                        .map(|level| super::composer::thinking_label_in(level, english))
                        .unwrap_or(trs!(english, "schedules.default_thinking")),
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    if let Some(e) = &mut this.schedules_ui.editor {
                        e.thinking = value;
                    }
                    cx.notify();
                })),
            );
        }

        // 执行时限
        let mut limits = vec![e.limit, 300, 900, 1800, 3600, 7200, 21600, 86400];
        limits.sort_unstable();
        limits.dedup();
        let mut limit = div().flex().flex_col().gap(px(4.0)).child(
            select_trigger(
                "schedule-limit",
                duration_label(e.limit, english),
                e.menu == Some(Menu::Limit),
                p,
            )
            .on_click(toggle(Menu::Limit)),
        );
        if e.menu == Some(Menu::Limit) {
            let mut list = options(p, "schedule-limit-list");
            for seconds in limits {
                list = list.child(
                    option(
                        SharedString::from(format!("schedule-limit-{seconds}")),
                        duration_label(seconds, english),
                        seconds == e.limit,
                        p,
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(e) = &mut this.schedules_ui.editor {
                            e.limit = seconds;
                            e.menu = None;
                        }
                        cx.notify();
                    })),
                );
            }
            limit = limit.child(list);
        }
        form = form.child(field(
            trs!(english, "schedules.page.time_limit"),
            limit.into_any_element(),
            None,
            p,
        ));

        // 错过时间后
        let policy_label = |policy: MissedPolicy| match policy {
            MissedPolicy::RunLatest => trs!(english, "schedules.page.missed_run_latest"),
            MissedPolicy::Skip => trs!(english, "schedules.page.missed_skip"),
        };
        let mut policy = div().flex().flex_col().gap(px(4.0)).child(
            select_trigger(
                "schedule-policy",
                policy_label(e.policy).into(),
                e.menu == Some(Menu::Policy),
                p,
            )
            .on_click(toggle(Menu::Policy)),
        );
        if e.menu == Some(Menu::Policy) {
            let mut list = options(p, "schedule-policy-list");
            for (i, value) in [MissedPolicy::RunLatest, MissedPolicy::Skip]
                .into_iter()
                .enumerate()
            {
                list = list.child(
                    option(
                        SharedString::from(format!("schedule-policy-{i}")),
                        policy_label(value).into(),
                        e.policy == value,
                        p,
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(e) = &mut this.schedules_ui.editor {
                            e.policy = value;
                            e.menu = None;
                        }
                        cx.notify();
                    })),
                );
            }
            policy = policy.child(list);
        }
        form = form.child(field(
            trs!(english, "schedules.page.missed_policy"),
            policy.into_any_element(),
            None,
            p,
        ));

        // 重复
        let kind_label = |kind: Kind| match kind {
            Kind::Once => trs!(english, "schedules.page.kind_once"),
            Kind::Daily => trs!(english, "schedules.daily"),
            Kind::Weekly => trs!(english, "schedules.weekly"),
        };
        let mut kind = div().flex().flex_col().gap(px(4.0)).child(
            select_trigger(
                "schedule-kind",
                kind_label(e.kind).into(),
                e.menu == Some(Menu::Kind),
                p,
            )
            .on_click(toggle(Menu::Kind)),
        );
        if e.menu == Some(Menu::Kind) {
            let mut list = options(p, "schedule-kind-list");
            for (i, value) in [Kind::Once, Kind::Daily, Kind::Weekly]
                .into_iter()
                .enumerate()
            {
                list = list.child(
                    option(
                        SharedString::from(format!("schedule-kind-{i}")),
                        kind_label(value).into(),
                        e.kind == value,
                        p,
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(e) = &mut this.schedules_ui.editor {
                            e.kind = value;
                            e.menu = None;
                        }
                        cx.notify();
                    })),
                );
            }
            kind = kind.child(list);
        }
        form = form.child(field(
            trs!(english, "schedules.page.kind"),
            kind.into_any_element(),
            None,
            p,
        ));

        let half = |label: &'static str, control: AnyElement| {
            div()
                .flex_1()
                .min_w_0()
                .child(field(label, control, None, p))
        };
        if e.kind == Kind::Once {
            form = form.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .child(
                        div()
                            .flex()
                            .gap(px(16.0))
                            .child(half(
                                trs!(english, "schedules.page.date"),
                                Input::new(&e.day).into_any_element(),
                            ))
                            .child(half(
                                trs!(english, "schedules.page.time"),
                                Input::new(&e.time).into_any_element(),
                            ))
                            .child(half(
                                trs!(english, "schedules.page.time_zone"),
                                Input::new(&e.zone).into_any_element(),
                            )),
                    )
                    .child(
                        div()
                            .text_size(px(TEXT_XS))
                            .muted(p)
                            .child(trs!(english, "schedules.page.at_hint")),
                    ),
            );
        } else {
            form = form.child(
                div()
                    .flex()
                    .gap(px(16.0))
                    .child(half(
                        trs!(english, "schedules.page.time"),
                        Input::new(&e.time).into_any_element(),
                    ))
                    .child(half(
                        trs!(english, "schedules.page.time_zone"),
                        Input::new(&e.zone).into_any_element(),
                    )),
            );
        }
        if e.kind == Kind::Weekly {
            let mut weekdays = div().flex().flex_wrap().gap(px(8.0));
            for day in [1u32, 2, 3, 4, 5, 6, 0] {
                let checked = e.days.contains(&day);
                weekdays = weekdays.child(
                    div()
                        .id(SharedString::from(format!("schedule-weekday-{day}")))
                        .h(px(32.0))
                        .px(px(10.0))
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .rounded(px(8.0))
                        .border_1()
                        .cursor_pointer()
                        .when(checked, |d| {
                            d.border_color(p.c(Token::Primary).opacity(0.4))
                                .bg(p.c(Token::Primary).opacity(0.1))
                        })
                        .when(!checked, |d| d.border_color(p.c(Token::Border)))
                        .child(super::settings::checkbox(checked, p))
                        .child(weekday(day, english))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(e) = &mut this.schedules_ui.editor {
                                if e.days.contains(&day) {
                                    e.days.retain(|d| *d != day);
                                } else {
                                    e.days.push(day);
                                    e.days.sort_unstable();
                                }
                            }
                            cx.notify();
                        })),
                );
            }
            form = form.child(field(
                trs!(english, "schedules.page.days"),
                weekdays.into_any_element(),
                None,
                p,
            ));
        }
        // Native-only: the task's own model and thinking, after what Electron asks.
        form = form
            .child(field(
                trs!(english, "schedules.model"),
                model.into_any_element(),
                None,
                p,
            ))
            .child(field(
                trs!(english, "schedules.page.thinking"),
                thinking.into_any_element(),
                None,
                p,
            ));
        form = form.child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(12.0))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(2.0))
                        .child(
                            div()
                                .font_weight(FontWeight::MEDIUM)
                                .child(trs!(english, "schedules.enable_schedule")),
                        )
                        .child(
                            div()
                                .text_size(px(TEXT_XS))
                                .muted(p)
                                .child(trs!(english, "schedules.pausing_cancels_queued_runs_but")),
                        ),
                )
                .child(
                    switch("schedule-enabled".into(), e.enabled, p).on_click(cx.listener(
                        |this, _, _, cx| {
                            if let Some(e) = &mut this.schedules_ui.editor {
                                e.enabled = !e.enabled;
                            }
                            cx.notify();
                        },
                    )),
                ),
        );
        if let Some(error) = &self.schedules_ui.error {
            form = form.child(
                div()
                    .text_size(px(TEXT_XS))
                    .text_color(p.c(Token::Destructive))
                    .child(error.clone()),
            );
        }
        if let Some(notice) = &self.schedules_ui.notice {
            form = form.child(div().muted(p).child(notice.clone()));
        }
        if let Some(latest) = e.id.as_ref().and_then(|id| {
            self.schedules_ui
                .snapshot
                .as_ref()?
                .tasks
                .iter()
                .find(|t| &t.id == id)
        }) && Some(latest.version) != e.version
        {
            let latest = latest.clone();
            form = form
                .child(
                    div()
                        .muted(p)
                        .child(trs!(english, "schedules.this_task_changed_elsewhere_your")),
                )
                .child(
                    div().flex().child(
                        button("schedule-reload", Btn::Outline, false, p)
                            .child(trs!(english, "schedules.reload_latest_configuration"))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.edit_schedule(Some(latest.clone()), window, cx)
                            })),
                    ),
                );
        }
        let disabled = saving || self.backend.is_none();
        form = form.child(
            div()
                .pt(px(4.0))
                .flex()
                .flex_wrap()
                .gap(px(8.0))
                .child(
                    button("schedule-save", Btn::Primary, disabled, p)
                        .h(px(32.0))
                        .child(if saving {
                            trs!(english, "schedules.page.saving")
                        } else {
                            trs!(english, "schedules.page.save")
                        })
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if !disabled {
                                this.save_schedule(cx)
                            }
                        })),
                )
                .child(
                    button("schedule-cancel", Btn::Outline, saving, p)
                        .h(px(32.0))
                        .child(trs!(english, "schedules.page.cancel"))
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.close_schedule_dialog();
                            cx.notify();
                        })),
                ),
        );
        let title = div()
            .text_size(px(16.0))
            .line_height(px(16.0))
            .font_weight(FontWeight::MEDIUM)
            .child(if e.id.is_some() {
                trs!(english, "schedules.page.edit_title")
            } else {
                trs!(english, "schedules.page.new")
            })
            .into_any_element();
        self.schedule_dialog_frame(title, form.into_any_element(), cx)
    }
}

// ---- pieces shared by the page and its dialogs

#[derive(Clone, Copy, PartialEq, Eq)]
enum Btn {
    Primary,
    Outline,
    Destructive,
}

/// `Button size="sm"`: 28px tall, 10px across, a 14px glyph.
fn button(
    id: impl Into<ElementId>,
    kind: Btn,
    disabled: bool,
    p: &crate::theme::Palette,
) -> Stateful<Div> {
    let (bg, fg, hover) = match kind {
        Btn::Primary => (
            p.c(Token::Primary),
            p.c(Token::PrimaryForeground),
            p.c(Token::Primary).opacity(0.8),
        ),
        Btn::Outline => (
            p.c(Token::Background),
            p.c(Token::Foreground),
            p.c(Token::Muted),
        ),
        Btn::Destructive => (
            p.c(Token::Destructive).opacity(0.1),
            p.c(Token::Destructive),
            p.c(Token::Destructive).opacity(0.2),
        ),
    };
    div()
        .id(id)
        .h(px(28.0))
        .px(px(10.0))
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .gap(px(4.0))
        .rounded(px(8.0))
        .border_1()
        .border_color(if kind == Btn::Outline {
            p.c(Token::Border)
        } else {
            hsla(0.0, 0.0, 0.0, 0.0)
        })
        .bg(bg)
        .text_color(fg)
        .text_size(px(12.8))
        .font_weight(FontWeight::MEDIUM)
        .when(disabled, |d| d.opacity(0.5))
        .when(!disabled, move |d| {
            d.cursor_pointer().hover(move |d| d.bg(hover))
        })
}

#[derive(Clone, Copy)]
enum BadgeKind {
    Default,
    Secondary,
    Destructive,
    Outline,
}

/// `Badge`: a 20px pill of `text-xs font-medium`.
fn badge(text: &'static str, kind: BadgeKind, p: &crate::theme::Palette) -> Div {
    let (bg, fg) = match kind {
        BadgeKind::Default => (p.c(Token::Primary), p.c(Token::PrimaryForeground)),
        BadgeKind::Secondary => (p.c(Token::Secondary), p.c(Token::SecondaryForeground)),
        BadgeKind::Destructive => (
            p.c(Token::Destructive).opacity(0.1),
            p.c(Token::Destructive),
        ),
        BadgeKind::Outline => (hsla(0.0, 0.0, 0.0, 0.0), p.c(Token::Foreground)),
    };
    div()
        .h(px(20.0))
        .px(px(8.0))
        .flex()
        .flex_none()
        .items_center()
        .rounded_full()
        .border_1()
        .border_color(if matches!(kind, BadgeKind::Outline) {
            p.c(Token::Border)
        } else {
            hsla(0.0, 0.0, 0.0, 0.0)
        })
        .bg(bg)
        .text_color(fg)
        .text_size(px(TEXT_XS))
        .font_weight(FontWeight::MEDIUM)
        .child(text)
}

fn status_badge(key: &str, english: bool) -> (&'static str, BadgeKind) {
    let kind = match key {
        "failed" | "interrupted" => BadgeKind::Destructive,
        "running" | "stopping" | "waiting" => BadgeKind::Default,
        _ => BadgeKind::Secondary,
    };
    let text = match key {
        "running" => trs!(english, "schedules.page.status.running"),
        "completed" => trs!(english, "schedules.page.status.completed"),
        "failed" => trs!(english, "schedules.page.status.failed"),
        "stopped" => trs!(english, "schedules.page.status.stopped"),
        "interrupted" => trs!(english, "schedules.page.status.interrupted"),
        "missed" => trs!(english, "schedules.page.status.missed"),
        "paused" => trs!(english, "schedules.page.status.paused"),
        "queued" => trs!(english, "schedules.page.status.queued"),
        "stopping" => trs!(english, "schedules.page.status.stopping"),
        "waiting" => trs!(english, "schedules.page.status.waiting"),
        _ => trs!(english, "schedules.page.status.scheduled"),
    };
    (text, kind)
}

/// `TaskBadge`: what the task is doing now, not how its last run went.
fn task_status(
    task: &ScheduledTask,
    snapshot: &ScheduleSnapshot,
    english: bool,
) -> (&'static str, BadgeKind) {
    if let Some(run) = snapshot.active.as_ref().filter(|r| r.task_id == task.id) {
        return status_badge(
            if run.stopping {
                "stopping"
            } else if run.waiting_for_input {
                "waiting"
            } else {
                "running"
            },
            english,
        );
    }
    if snapshot.queued.iter().any(|r| r.task_id == task.id) {
        return status_badge("queued", english);
    }
    if !task.enabled {
        if matches!(task.definition.rule, ScheduleRule::Once { .. })
            && let Some(last) = task.last_status.filter(|s| s.terminal())
        {
            return status_badge(last.as_str(), english);
        }
        return status_badge("paused", english);
    }
    status_badge("scheduled", english)
}

fn run_status(run: &ScheduledRun, english: bool) -> (&'static str, BadgeKind) {
    if run.status == ScheduleRunStatus::Running && run.waiting_for_input {
        return status_badge("waiting", english);
    }
    status_badge(run.status.as_str(), english)
}

/// `toLocaleString(…, { dateStyle: "medium", timeStyle: "short" })`.
fn when(at: Option<i64>, english: bool) -> String {
    let Some(at) = at.and_then(DateTime::<Utc>::from_timestamp_millis) else {
        return "—".into();
    };
    let local = at.with_timezone(&zone().parse::<Tz>().unwrap_or(chrono_tz::UTC));
    if english {
        local.format("%b %-d, %Y, %-I:%M %p").to_string()
    } else {
        local.format("%Y年%-m月%-d日 %H:%M").to_string()
    }
}

fn weekday(day: u32, english: bool) -> &'static str {
    let zh = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    let en = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    (if english { en } else { zh })
        .get(day as usize)
        .copied()
        .unwrap_or("?")
}

/// `scheduleSummary`: 每天 09:00（Asia/Shanghai）.
fn summary(rule: &ScheduleRule, english: bool) -> String {
    match rule {
        ScheduleRule::Once { at } => tr!(
            english,
            "schedules.page.summary_once",
            time = DateTime::parse_from_rfc3339(at)
                .map(|d| when(Some(d.timestamp_millis()), english))
                .unwrap_or_else(|_| at.clone())
        ),
        ScheduleRule::Daily { time, time_zone } => {
            tr!(
                english,
                "schedules.page.summary_daily",
                time = time,
                zone = time_zone
            )
        }
        ScheduleRule::Weekly {
            time,
            time_zone,
            days,
        } => {
            let days = [1u32, 2, 3, 4, 5, 6, 0]
                .into_iter()
                .filter(|d| days.contains(d))
                .map(|d| weekday(d, english))
                .collect::<Vec<_>>()
                .join(if english { ", " } else { "、" });
            tr!(
                english,
                "schedules.page.summary_weekly",
                days = days,
                time = time,
                zone = time_zone
            )
        }
    }
}

fn duration_label(seconds: u32, english: bool) -> String {
    if seconds.is_multiple_of(60) {
        tr!(english, "schedules.page.minutes", count = seconds / 60)
    } else {
        tr!(english, "schedules.page.seconds", count = seconds)
    }
}

/// A form `Field`: `Label`, the control, then a hint.
fn field(
    label: &'static str,
    control: AnyElement,
    hint: Option<&'static str>,
    p: &crate::theme::Palette,
) -> Div {
    div()
        .flex()
        .flex_col()
        .gap(px(6.0))
        .child(
            div()
                .text_size(px(TEXT_SM))
                .line_height(px(14.0))
                .font_weight(FontWeight::MEDIUM)
                .child(label),
        )
        .child(control)
        .children(hint.map(|h| div().text_size(px(TEXT_XS)).muted(p).child(h)))
}

/// `SelectTrigger className="w-full"`: an input-shaped row with the value and ⇕.
fn select_trigger(
    id: impl Into<ElementId>,
    value: String,
    open: bool,
    p: &crate::theme::Palette,
) -> Stateful<Div> {
    div()
        .id(id)
        .w_full()
        .h(px(32.0))
        .pl(px(10.0))
        .pr(px(8.0))
        .flex()
        .items_center()
        .gap(px(6.0))
        .rounded(px(8.0))
        .border_1()
        .border_color(if open {
            p.c(Token::Ring)
        } else {
            p.c(Token::Input)
        })
        .cursor_pointer()
        .text_size(px(TEXT_SM))
        .child(truncate(value).flex_1())
        .child(icon("unfold-more", 16.0, p.c(Token::MutedForeground)))
}

/// `SelectContent`, laid in the form under its trigger.
fn options(p: &crate::theme::Palette, id: &'static str) -> Stateful<Div> {
    div()
        .id(id)
        .max_h(px(200.0))
        .overflow_y_scroll()
        .p(px(4.0))
        .rounded(px(10.0))
        .border_1()
        .border_color(p.c(Token::Border))
        .bg(p.overlay())
        .shadow_md()
        .flex()
        .flex_col()
}

fn option(
    id: SharedString,
    label: String,
    selected: bool,
    p: &crate::theme::Palette,
) -> Stateful<Div> {
    let hover = p.c(Token::Accent);
    div()
        .id(id)
        .min_h(px(32.0))
        .pl(px(8.0))
        .pr(px(8.0))
        .flex()
        .items_center()
        .gap(px(8.0))
        .rounded(px(6.0))
        .cursor_pointer()
        .hover(move |d| d.bg(hover))
        .child(truncate(label).flex_1())
        .when(selected, |d| {
            d.child(icon("tick02", 14.0, p.c(Token::Foreground)))
        })
}

/// A toggle chip for the native-only thinking choice.
fn chip(id: SharedString, on: bool, p: &crate::theme::Palette) -> Stateful<Div> {
    div()
        .id(id)
        .h(px(28.0))
        .px(px(10.0))
        .flex()
        .items_center()
        .rounded(px(8.0))
        .border_1()
        .cursor_pointer()
        .text_size(px(12.8))
        .when(on, |d| {
            d.border_color(p.c(Token::Primary).opacity(0.4))
                .bg(p.c(Token::Primary).opacity(0.1))
        })
        .when(!on, |d| d.border_color(p.c(Token::Border)))
}

impl Workspace {
    /// Dev only (`--fixture schedules[-empty|-detail|-new]`): the 定时任务 page over sample tasks,
    /// the shape of the Electron mock's `?tasks=sample#/tasks`. No backend is involved.
    pub fn show_schedules_fixture(
        &mut self,
        mode: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.open_schedules(window, cx);
        let at = now().timestamp_millis();
        let task = |id: &str,
                    name: &str,
                    prompt: &str,
                    rule: ScheduleRule,
                    next: i64,
                    last: Option<i64>| ScheduledTask {
            id: id.into(),
            version: 1,
            definition: ScheduleDefinition {
                name: name.into(),
                prompt: prompt.into(),
                project: None,
                model: None,
                thinking: None,
                rule,
                max_run_seconds: 3600,
                missed_policy: MissedPolicy::RunLatest,
            },
            enabled: true,
            created_at: at - 86_400_000,
            updated_at: at,
            next_run_at: Some(next),
            last_run_at: last,
            last_status: last.map(|_| ScheduleRunStatus::Completed),
        };
        let tasks = if mode == "schedules-empty" {
            Vec::new()
        } else {
            vec![
                task(
                    "fixture-daily",
                    "每日整理项目",
                    "整理昨天的开发记录，生成今日待办摘要。",
                    ScheduleRule::Daily {
                        time: "09:00".into(),
                        time_zone: "Asia/Shanghai".into(),
                    },
                    at + 3_600_000,
                    Some(at - 86_400_000),
                ),
                task(
                    "fixture-weekly",
                    "每周总结",
                    "总结本周的改动与待解决问题。",
                    ScheduleRule::Weekly {
                        time: "17:00".into(),
                        time_zone: "Asia/Shanghai".into(),
                        days: vec![5],
                    },
                    at + 86_400_000,
                    None,
                ),
            ]
        };
        self.schedules_ui.snapshot = Some(ScheduleSnapshot {
            revision: 1,
            tasks,
            active: None,
            queued: Vec::new(),
        });
        match mode {
            "schedules-detail" => {
                self.schedules_ui.detail = Some("fixture-daily".into());
                self.schedules_ui.history = Some(History {
                    runs: vec![ScheduledRun {
                        id: "fixture-run".into(),
                        task_id: "fixture-daily".into(),
                        task_name: "每日整理项目".into(),
                        task_version: 1,
                        scheduled_at: at - 86_400_000,
                        started_at: Some(at - 86_400_000),
                        ended_at: Some(at - 86_400_000 + 15_000),
                        manual: false,
                        status: ScheduleRunStatus::Completed,
                        stopping: false,
                        waiting_for_input: false,
                        thread_id: Some("preview-conversation".into()),
                        error: None,
                        result: String::new(),
                    }],
                    total: 1,
                    offset: 0,
                });
            }
            "schedules-new" => self.edit_schedule(None, window, cx),
            "schedules-edit" => {
                let task = self
                    .schedules_ui
                    .snapshot
                    .as_ref()
                    .and_then(|s| s.tasks.get(1).cloned());
                self.edit_schedule(task, window, cx)
            }
            _ => {}
        }
        cx.notify();
    }
}
