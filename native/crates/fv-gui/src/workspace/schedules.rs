//! Schedule cards and dialogs use the shared protocol; the GUI never owns a timer or run.
use super::{
    Workspace,
    settings::{card, dialog_card, dialog_foot, dialog_head, modal, outline_button, switch},
};
use crate::ui::{Muted as _, TEXT_SM, TEXT_XS, truncate};
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
fn date(at: Option<i64>) -> String {
    at.and_then(DateTime::<Utc>::from_timestamp_millis)
        .map(|d| {
            d.with_timezone(&zone().parse::<Tz>().unwrap_or(chrono_tz::UTC))
                .format("%Y-%m-%d %H:%M")
                .to_string()
        })
        .unwrap_or_else(|| "—".into())
}
fn status(s: ScheduleRunStatus) -> &'static str {
    match s {
        ScheduleRunStatus::Queued => "排队中",
        ScheduleRunStatus::Running => "执行中",
        ScheduleRunStatus::Completed => "已完成",
        ScheduleRunStatus::Failed => "失败",
        ScheduleRunStatus::Stopped => "已停止",
        ScheduleRunStatus::Interrupted => "已中断",
        ScheduleRunStatus::Missed => "已错过",
    }
}
fn rule_label(rule: &ScheduleRule) -> String {
    match rule {
        ScheduleRule::Once { at } => format!(
            "单次 · {}",
            date(
                DateTime::parse_from_rfc3339(at)
                    .ok()
                    .map(|d| d.timestamp_millis())
            )
        ),
        ScheduleRule::Daily { time, time_zone } => format!("每天 {time} · {time_zone}"),
        ScheduleRule::Weekly {
            time,
            time_zone,
            days,
        } => format!(
            "每周 {} {time} · {time_zone}",
            days.iter()
                .map(|d| ["日", "一", "二", "三", "四", "五", "六"]
                    .get(*d as usize)
                    .copied()
                    .unwrap_or("?"))
                .collect::<Vec<_>>()
                .join("、")
        ),
    }
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
    seconds: Entity<InputState>,
    original_once: Option<(ScheduleRule, String, String, String)>,
    kind: Kind,
    days: Vec<u32>,
    project: Option<String>,
    model: Option<String>,
    enabled: bool,
    policy: MissedPolicy,
    thinking: Option<fv_protocol::types::ThinkingLevel>,
    project_menu: bool,
    model_menu: bool,
}
fn input(label: &str, value: &str, window: &mut Window, cx: &mut App) -> Entity<InputState> {
    let e = cx.new(|cx| InputState::new(window, cx).placeholder(label.to_string()));
    e.update(cx, |s, cx| s.set_value(value.to_string(), window, cx));
    e
}
impl Editor {
    fn new(task: Option<ScheduledTask>, window: &mut Window, cx: &mut App) -> Self {
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
                .placeholder("每次运行需要完成什么")
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
                "任务名称",
                task.as_ref()
                    .map(|t| t.definition.name.as_str())
                    .unwrap_or(""),
                window,
                cx,
            ),
            prompt,
            day: input("YYYY-MM-DD", &day, window, cx),
            time: input("HH:MM", &time, window, cx),
            zone: input("时区，如 Asia/Shanghai", &tz, window, cx),
            seconds: input(
                "最长运行时间（秒）",
                &task
                    .as_ref()
                    .map(|t| t.definition.max_run_seconds)
                    .unwrap_or(3600)
                    .to_string(),
                window,
                cx,
            ),
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
            project_menu: false,
            model_menu: false,
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
        let max_run_seconds = self
            .seconds
            .read(cx)
            .value()
            .trim()
            .parse()
            .map_err(|_| "运行时限请填写秒数。")?;
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
        self.schedules_ui.editor = Some(Editor::new(task, window, cx));
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
                            this.schedules_ui.notice =
                                Some("已保存，保存期间的新修改仍在草稿中。".into());
                        }
                    }
                    Err(error) => {
                        this.schedules_ui.error = Some(format!("保存失败，草稿已保留：{error}"))
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
        let mut grid = div()
            .id("schedules-grid")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .p(px(20.0))
            .flex()
            .flex_wrap()
            .content_start()
            .gap(px(14.0));
        if let Some(snapshot) = &s.snapshot {
            for task in &snapshot.tasks {
                let task = task.clone();
                let details = task.id.clone();
                let edit = task.clone();
                let run = task.clone();
                let toggle = task.clone();
                let stop = task.clone();
                let active = snapshot.active.as_ref().filter(|r| r.task_id == task.id);
                let queued = snapshot.queued.iter().any(|r| r.task_id == task.id);
                let label = active
                    .map(|r| {
                        if r.stopping {
                            if english {
                                "Stopping…"
                            } else {
                                "正在停止…"
                            }
                        } else if r.waiting_for_input {
                            if english {
                                "Waiting for input"
                            } else {
                                "等待输入"
                            }
                        } else {
                            if english { "Running" } else { "执行中" }
                        }
                    })
                    .unwrap_or(if queued {
                        if english { "Queued" } else { "排队中" }
                    } else if task.enabled {
                        if english { "Enabled" } else { "已启用" }
                    } else {
                        if english { "Disabled" } else { "未启用" }
                    });
                let busy = s.busy.contains(&task.id);
                let mut actions = div()
                    .flex()
                    .flex_wrap()
                    .gap(px(6.0))
                    .child(
                        outline_button(SharedString::from(format!("schedule-run-{}", task.id)), p)
                            .when(busy, |d| d.opacity(0.5))
                            .child(if english { "Run now" } else { "立即运行" })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.schedule_action(run.clone(), Action::Run, cx)
                            })),
                    )
                    .child(
                        outline_button(SharedString::from(format!("schedule-edit-{}", task.id)), p)
                            .child(if english { "Edit" } else { "编辑" })
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.edit_schedule(Some(edit.clone()), window, cx)
                            })),
                    )
                    .child(
                        outline_button(
                            SharedString::from(format!("schedule-toggle-{}", task.id)),
                            p,
                        )
                        .child(if task.enabled {
                            if english { "Pause" } else { "暂停" }
                        } else if english {
                            "Enable"
                        } else {
                            "启用"
                        })
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.schedule_action(toggle.clone(), Action::Toggle, cx)
                        })),
                    );
                if active.is_some() || queued {
                    actions = actions.child(
                        outline_button(SharedString::from(format!("schedule-stop-{}", task.id)), p)
                            .child(if english {
                                "Stop / cancel queue"
                            } else {
                                "停止 / 取消排队"
                            })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.schedule_action(stop.clone(), Action::Stop, cx)
                            })),
                    );
                }
                grid = grid.child(
                    card(p)
                        .w(px(310.0))
                        .h_auto()
                        .p(px(16.0))
                        .gap(px(10.0))
                        .child(
                            div()
                                .id(SharedString::from(format!("schedule-details-{}", task.id)))
                                .cursor_pointer()
                                .child(
                                    div()
                                        .flex()
                                        .justify_between()
                                        .gap(px(8.0))
                                        .child(
                                            div()
                                                .flex_1()
                                                .min_w_0()
                                                .child(truncate(task.definition.name.clone())),
                                        )
                                        .child(div().text_size(px(TEXT_XS)).muted(p).child(label)),
                                )
                                .child(
                                    div()
                                        .text_size(px(TEXT_XS))
                                        .muted(p)
                                        .child(rule_label(&task.definition.rule)),
                                )
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.schedules_ui.detail = Some(details.clone());
                                    this.schedules_ui.history = None;
                                    this.schedules_ui.confirm_delete = None;
                                    this.refresh_schedule_history(0, cx);
                                    cx.notify();
                                })),
                        )
                        .child(div().text_size(px(TEXT_XS)).muted(p).child(if english {
                            format!("Next: {}", date(task.next_run_at))
                        } else {
                            format!("下次：{}", date(task.next_run_at))
                        }))
                        .child(div().text_size(px(TEXT_XS)).muted(p).child(if english {
                            format!(
                                "Last: {} · {}",
                                date(task.last_run_at),
                                task.last_status.map(status).unwrap_or("Not run yet")
                            )
                        } else {
                            format!(
                                "上次：{} · {}",
                                date(task.last_run_at),
                                task.last_status.map(status).unwrap_or("尚未执行")
                            )
                        }))
                        .child(actions),
                );
            }
            if snapshot.tasks.is_empty() {
                grid = grid.child(
                    div()
                        .w_full()
                        .py(px(40.0))
                        .muted(p)
                        .child(if english { "No scheduled tasks yet. Create one and the background service will keep its run chats." } else { "暂无定时任务。创建后，后台服务会按计划执行并保留运行对话。" }),
                );
            }
        } else {
            grid = grid.child(div().muted(p).child(if english {
                "Loading schedules…"
            } else {
                "正在读取定时任务…"
            }));
        }
        let mut page=div().flex_1().min_w_0().h_full().flex().flex_col().text_size(px(TEXT_SM))
            .child(div().h(px(64.0)).flex_none().px(px(20.0)).flex().items_center().justify_between().child(if english { "Schedules" } else { "定时任务" })
                .child(div().flex().gap(px(8.0)).child(outline_button("schedule-back",p).child(if english { "Back to chat" } else { "返回对话" }).on_click(cx.listener(|this,_,window,cx|this.close_schedules(window,cx))))
                    .child(outline_button("schedule-new",p).child(if english { "New task" } else { "新建任务" }).on_click(cx.listener(|this,_,window,cx|this.edit_schedule(None,window,cx))))))
            .child(div().px(px(20.0)).pb(px(10.0)).text_size(px(TEXT_XS)).muted(p).child(if english { "The background service keeps running after the window closes. One task runs at a time; queued runs use a saved configuration snapshot." } else { "关闭窗口后仍由后台服务执行。一次运行一个任务；排队时保存配置快照，后续编辑只影响之后的执行。" }))
            .children(s.error.as_ref().map(|e|div().px(px(20.0)).pb(px(10.0)).text_color(p.c(Token::Destructive)).child(e.clone())))
            .child(grid);
        if let Some(focus) = &s.focus {
            page = page.track_focus(focus);
        }
        page.into_any_element()
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
        let task = snapshot.tasks.iter().find(|t| &t.id == id)?;
        let p = &self.palette;
        let mut body = div()
            .id("schedule-history")
            .max_h(px(440.0))
            .overflow_y_scroll()
            .p(px(20.0))
            .flex()
            .flex_col()
            .gap(px(12.0));
        body = body
            .child(div().child(rule_label(&task.definition.rule)))
            .child(div().text_size(px(TEXT_XS)).muted(p).child(
                "每次运行使用独立对话。保留最近 500 条全局运行历史，删除任务不会删除运行对话。",
            ));
        if let Some(history) = &self.schedules_ui.history {
            for run in &history.runs {
                let mut row = div()
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .border_b_1()
                    .border_color(p.c(Token::Border))
                    .pb(px(10.0))
                    .child(format!(
                        "{} · {} · 版本 {}",
                        status(run.status),
                        if run.manual { "手动" } else { "计划" },
                        run.task_version
                    ))
                    .child(div().text_size(px(TEXT_XS)).muted(p).child(format!(
                        "计划 {} / 开始 {} / 结束 {}",
                        date(Some(run.scheduled_at)),
                        date(run.started_at),
                        date(run.ended_at)
                    )))
                    .children(run.error.as_ref().map(|e| {
                        div()
                            .text_size(px(TEXT_XS))
                            .text_color(p.c(Token::Destructive))
                            .child(e.clone())
                    }));
                if !run.result.is_empty() {
                    row = row.child(
                        div()
                            .text_size(px(TEXT_XS))
                            .muted(p)
                            .child(truncate(run.result.chars().take(160).collect::<String>())),
                    );
                }
                if let Some(thread) = &run.thread_id {
                    let thread = thread.clone();
                    row = row.child(
                        outline_button(
                            SharedString::from(format!("schedule-output-{}", run.id)),
                            p,
                        )
                        .child(if run.waiting_for_input {
                            "查看并回答"
                        } else {
                            "打开运行对话"
                        })
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.schedules_ui.detail = None;
                            this.select(thread.clone(), cx);
                        })),
                    );
                }
                body = body.child(row);
            }
            if history.runs.is_empty() {
                body = body.child(div().muted(p).child("暂无运行记录"));
            }
            let prev = history.offset.saturating_sub(30);
            let next = history.offset + 30;
            body = body.child(
                div()
                    .flex()
                    .justify_between()
                    .gap(px(8.0))
                    .child(format!(
                        "{} / {}",
                        history.offset + history.runs.len() as u32,
                        history.total
                    ))
                    .when(history.offset > 0, |d| {
                        d.child(
                            outline_button("schedule-history-prev", p)
                                .child("上一页")
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.refresh_schedule_history(prev, cx)
                                })),
                        )
                    })
                    .when(next < history.total, |d| {
                        d.child(
                            outline_button("schedule-history-next", p)
                                .child("下一页")
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.refresh_schedule_history(next, cx)
                                })),
                        )
                    }),
            );
        } else {
            body = body.child("正在读取历史…");
        }
        let remove = task.clone();
        let confirm = self
            .schedules_ui
            .confirm_delete
            .as_ref()
            .is_some_and(|(id, _)| id == &task.id);
        let card = dialog_card(p, 650.0)
            .child(dialog_head(&task.definition.name, "运行历史", p))
            .child(body)
            .children(self.schedules_ui.error.as_ref().map(|e| {
                div()
                    .px(px(20.0))
                    .text_color(p.c(Token::Destructive))
                    .child(e.clone())
            }))
            .child(
                div()
                    .px(px(20.0))
                    .py(px(12.0))
                    .flex()
                    .justify_between()
                    .child(
                        outline_button("schedule-delete", p)
                            .child(if confirm {
                                "确认删除任务（保留对话）"
                            } else {
                                "删除任务"
                            })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.schedule_action(remove.clone(), Action::Delete, cx)
                            })),
                    )
                    .child(
                        outline_button("schedule-history-close", p)
                            .child("关闭")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.schedules_ui.detail = None;
                                cx.notify();
                            })),
                    ),
            );
        Some(modal(card, p, cx, |this| {
            this.schedules_ui.detail = None;
        }))
    }
    pub(super) fn dismiss_schedule(&mut self, cx: &mut Context<Self>) -> bool {
        if !self.schedules_ui.open || self.settings.is_some() {
            return false;
        }
        if let Some(e) = &mut self.schedules_ui.editor {
            if e.model_menu || e.project_menu {
                e.model_menu = false;
                e.project_menu = false;
            } else {
                self.schedules_ui.editor = None;
            }
        } else if self.schedules_ui.detail.is_some() {
            self.schedules_ui.detail = None;
        } else {
            return false;
        }
        cx.notify();
        true
    }
    fn schedule_editor(&self, e: &Editor, cx: &mut Context<Self>) -> AnyElement {
        use fv_protocol::types::ThinkingLevel;
        let p = &self.palette;
        let mut form = div()
            .id("schedule-form")
            .max_h(px(480.0))
            .overflow_y_scroll()
            .p(px(20.0))
            .flex()
            .flex_col()
            .gap(px(10.0))
            .child("任务名称")
            .child(Input::new(&e.name))
            .child("任务内容")
            .child(Textarea::new(&e.prompt).aria_label("任务内容"));
        let mut kinds = div().flex().gap(px(6.0));
        for (i, (kind, label)) in [
            (Kind::Once, "单次"),
            (Kind::Daily, "每天"),
            (Kind::Weekly, "每周"),
        ]
        .into_iter()
        .enumerate()
        {
            kinds = kinds.child(
                outline_button(SharedString::from(format!("schedule-kind-{i}")), p)
                    .when(e.kind == kind, |d| d.bg(p.c(Token::Accent)))
                    .child(label)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(e) = &mut this.schedules_ui.editor {
                            e.kind = kind;
                        }
                        cx.notify();
                    })),
            );
        }
        form = form.child("执行时间").child(kinds);
        if e.kind == Kind::Once {
            form = form.child(Input::new(&e.day));
        }
        form = form.child(Input::new(&e.time)).child(Input::new(&e.zone));
        if e.kind == Kind::Weekly {
            let mut weekdays = div().flex().gap(px(5.0));
            for (i, label) in ["日", "一", "二", "三", "四", "五", "六"]
                .into_iter()
                .enumerate()
            {
                let day = i as u32;
                weekdays = weekdays.child(
                    outline_button(SharedString::from(format!("schedule-weekday-{i}")), p)
                        .when(e.days.contains(&day), |d| d.bg(p.c(Token::Accent)))
                        .child(label)
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
            form = form.child(weekdays);
        }
        let project_label = e
            .project
            .as_ref()
            .map(|path| {
                self.projects
                    .iter()
                    .find(|p| &p.path == path)
                    .map(|p| p.name.clone())
                    .unwrap_or_else(|| format!("项目不可用：{path}"))
            })
            .unwrap_or_else(|| "独立临时工作目录".into());
        form = form.child("工作目录").child(
            outline_button("schedule-project", p)
                .child(project_label)
                .on_click(cx.listener(|this, _, _, cx| {
                    if let Some(e) = &mut this.schedules_ui.editor {
                        e.project_menu = !e.project_menu;
                        e.model_menu = false;
                    }
                    cx.notify();
                })),
        );
        if e.project_menu {
            let mut choices = div()
                .id("schedule-project-list")
                .max_h(px(150.0))
                .overflow_y_scroll()
                .flex()
                .flex_col()
                .gap(px(4.0));
            for (i, (value, label)) in std::iter::once((None, "独立临时工作目录".to_string()))
                .chain(
                    self.projects
                        .iter()
                        .map(|p| (Some(p.path.clone()), p.name.clone())),
                )
                .enumerate()
            {
                choices = choices.child(
                    outline_button(
                        SharedString::from(format!("schedule-project-choice-{i}")),
                        p,
                    )
                    .child(label)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(e) = &mut this.schedules_ui.editor {
                            e.project = value.clone();
                            e.project_menu = false;
                        }
                        cx.notify();
                    })),
                );
            }
            form = form.child(choices);
        }
        let model_label = e
            .model
            .as_ref()
            .map(|id| {
                self.models
                    .iter()
                    .find(|m| &m.label == id)
                    .map(|m| format!("{} / {}", m.provider_name, m.model.id))
                    .unwrap_or_else(|| format!("模型不可用：{id}"))
            })
            .unwrap_or_else(|| "使用默认模型".into());
        form = form.child("模型").child(
            outline_button("schedule-model", p)
                .child(model_label)
                .on_click(cx.listener(|this, _, _, cx| {
                    if let Some(e) = &mut this.schedules_ui.editor {
                        e.model_menu = !e.model_menu;
                        e.project_menu = false;
                    }
                    cx.notify();
                })),
        );
        if e.model_menu {
            let mut choices = div()
                .id("schedule-model-list")
                .max_h(px(150.0))
                .overflow_y_scroll()
                .flex()
                .flex_col()
                .gap(px(4.0));
            for (i, (value, label)) in std::iter::once((None, "使用默认模型".to_string()))
                .chain(self.models.iter().map(|m| {
                    (
                        Some(m.label.clone()),
                        format!("{} / {}", m.provider_name, m.model.id),
                    )
                }))
                .enumerate()
            {
                choices = choices.child(
                    outline_button(SharedString::from(format!("schedule-model-choice-{i}")), p)
                        .child(label)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(e) = &mut this.schedules_ui.editor {
                                e.model = value.clone();
                                e.model_menu = false;
                            }
                            cx.notify();
                        })),
                );
            }
            form = form.child(choices);
        }
        let mut thinking = div().flex().flex_wrap().gap(px(4.0));
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
                outline_button(SharedString::from(format!("schedule-thinking-{i}")), p)
                    .when(e.thinking == value, |d| d.bg(p.c(Token::Accent)))
                    .child(
                        value
                            .map(super::composer::thinking_label)
                            .unwrap_or("默认思考强度"),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(e) = &mut this.schedules_ui.editor {
                            e.thinking = value;
                        }
                        cx.notify();
                    })),
            );
        }
        form = form
            .child(thinking)
            .child("最长运行时间（秒，1–86400）")
            .child(Input::new(&e.seconds))
            .child("错过执行时间时");
        for (i, (policy, label)) in [
            (MissedPolicy::RunLatest, "24 小时内补跑最近一次"),
            (MissedPolicy::Skip, "延迟超过 1 分钟则跳过"),
        ]
        .into_iter()
        .enumerate()
        {
            form = form.child(
                outline_button(SharedString::from(format!("schedule-policy-{i}")), p)
                    .when(e.policy == policy, |d| d.bg(p.c(Token::Accent)))
                    .child(label)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(e) = &mut this.schedules_ui.editor {
                            e.policy = policy;
                        }
                        cx.notify();
                    })),
            );
        }
        form=form.child(div().flex().items_center().justify_between().child("启用计划")
            .child(switch("schedule-enabled".into(),e.enabled,p).on_click(cx.listener(|this,_,_,cx|{if let Some(e)=&mut this.schedules_ui.editor{e.enabled = !e.enabled;}cx.notify();}))))
            .child(div().text_size(px(TEXT_XS)).muted(p).child("暂停会取消排队，不会停止正在运行的任务。每次运行使用独立对话；排队之后的编辑只影响后续运行。"));
        if let Some(error) = &self.schedules_ui.error {
            form = form.child(
                div()
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
                        .child("任务已在其他位置更新。当前草稿已保留，重新载入会替换草稿。"),
                )
                .child(
                    outline_button("schedule-reload", p)
                        .child("重新载入最新配置")
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.edit_schedule(Some(latest.clone()), window, cx)
                        })),
                );
        }
        let saving = self.schedules_ui.saving;
        modal(
            dialog_card(p, 650.0)
                .child(dialog_head(
                    if e.id.is_some() {
                        "编辑定时任务"
                    } else {
                        "新建定时任务"
                    },
                    "由本机后台服务按时执行",
                    p,
                ))
                .child(form)
                .child(dialog_foot(
                    p,
                    cx,
                    |this, cx| {
                        this.schedules_ui.editor = None;
                        cx.notify();
                    },
                    if saving { "正在保存…" } else { "保存" },
                    |this, _, cx| this.save_schedule(cx),
                    saving || self.backend.is_none(),
                )),
            p,
            cx,
            |this| {
                this.schedules_ui.editor = None;
            },
        )
    }
}
