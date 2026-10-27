//! A compact child-task tray plus protocol-backed limits and lifecycle controls.
use super::{
    Workspace,
    settings::{card, outline_button, switch},
};
use crate::ui::{Muted as _, TEXT_SM, TEXT_XS, truncate};
use fv_protocol::methods::*;
use fv_protocol::subagents::*;
use fv_protocol::types::{Empty, UiLanguage};
use fv_theme::Token;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use std::collections::HashSet;

#[derive(Default)]
pub(super) struct Subagents {
    agents: Vec<Subagent>,
    config: SubagentConfig,
    config_loaded: bool,
    loading: bool,
    dirty: bool,
    epoch: u64,
    busy: HashSet<String>,
    saving: bool,
    error: Option<String>,
    pub(super) open: Option<String>,
}
fn label(a: &Subagent, english: bool) -> &'static str {
    if a.waiting_for_input {
        return if english {
            "Waiting for input"
        } else {
            "等待输入"
        };
    }
    match a.status {
        SubagentStatus::Idle => {
            if english {
                "Idle"
            } else {
                "待命"
            }
        }
        SubagentStatus::Running => {
            if english {
                "Running"
            } else {
                "执行中"
            }
        }
        SubagentStatus::Completed => {
            if english {
                "Completed"
            } else {
                "已完成"
            }
        }
        SubagentStatus::Interrupted => {
            if english {
                "Stopped"
            } else {
                "已停止"
            }
        }
        SubagentStatus::Failed => {
            if english {
                "Failed"
            } else {
                "失败"
            }
        }
        SubagentStatus::Closed => {
            if english {
                "Closed"
            } else {
                "已关闭"
            }
        }
    }
}
impl Workspace {
    /// The side pane's auxiliary chat reuses a real child thread. It never creates
    /// a second transcript store: the model's `spawn_agent` path remains the
    /// single owner of child creation and all existing question/approval handling.
    pub(super) fn open_auxiliary_chat(&mut self, cx: &mut Context<Self>) {
        let Some(child) = self
            .subagents
            .agents
            .iter()
            .find(|a| a.status != SubagentStatus::Closed)
            .map(|a| a.agent_id.clone())
        else {
            self.subagents.error=Some("当前对话还没有辅助对话；让 Agent 使用 spawn_agent 创建一个子任务后即可在这里打开。".into());
            cx.notify();
            return;
        };
        self.settings = None;
        self.select(child, cx);
    }

    pub(super) fn refresh_subagents(&mut self, cx: &mut Context<Self>) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        if self.subagents.loading {
            self.subagents.dirty = true;
            return;
        }
        self.subagents.loading = true;
        let epoch = self.subagents.epoch;
        let thread = self.selected.clone();
        cx.spawn(async move |this, cx| {
            let agents = backend.call::<SubagentList>(SubagentListParams {
                thread_id: thread.clone(),
            });
            let config = backend.call::<SubagentConfigGet>(Empty {});
            let (agents, config) = futures_util::join!(agents, config);
            let _ = this.update(cx, |this, cx| {
                let s = &mut this.subagents;
                s.loading = false;
                if s.epoch == epoch && this.selected == thread {
                    match agents {
                        Ok(list) => s.agents = list.agents,
                        Err(e) => s.error = Some(e.to_string()),
                    }
                    match config {
                        Ok(config) if !s.saving => {
                            s.config = config;
                            s.config_loaded = true;
                        }
                        Err(e) => s.error = Some(e.to_string()),
                        _ => {}
                    }
                } else {
                    s.dirty = true;
                }
                if std::mem::take(&mut s.dirty) {
                    this.refresh_subagents(cx);
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn save_subagent_config(&mut self, value: SubagentConfig, cx: &mut Context<Self>) {
        if self.subagents.saving || !self.subagents.config_loaded {
            return;
        }
        let Some(backend) = self.backend.clone() else {
            return;
        };
        self.subagents.saving = true;
        self.subagents.error = None;
        self.subagents.epoch = self.subagents.epoch.wrapping_add(1);
        cx.spawn(async move |this, cx| {
            let result = backend.call::<SubagentConfigSet>(value).await;
            let _ = this.update(cx, |this, cx| {
                this.subagents.saving = false;
                this.subagents.epoch = this.subagents.epoch.wrapping_add(1);
                match result {
                    Ok(value) => this.subagents.config = value,
                    Err(e) => this.subagents.error = Some(e.to_string()),
                }
                this.refresh_subagents(cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn stop_children(&mut self, root: String, cx: &mut Context<Self>) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        cx.spawn(async move |this, cx| {
            let result = backend
                .call::<TurnInterrupt>(fv_protocol::types::ThreadIdParams { thread_id: root })
                .await;
            let _ = this.update(cx, |this, cx| {
                if let Err(e) = result {
                    this.subagents.error = Some(e.to_string());
                }
                this.refresh_subagents(cx);
                cx.notify();
            });
        })
        .detach();
    }
    fn child_action(&mut self, id: String, reopen: bool, cx: &mut Context<Self>) {
        if self.subagents.busy.contains(&id) {
            return;
        }
        let Some(backend) = self.backend.clone() else {
            return;
        };
        self.subagents.busy.insert(id.clone());
        self.subagents.error = None;
        self.subagents.epoch = self.subagents.epoch.wrapping_add(1);
        cx.spawn(async move |this, cx| {
            let params = SubagentIdParams {
                agent_id: id.clone(),
            };
            let result = if reopen {
                backend.call::<SubagentResume>(params).await
            } else {
                backend.call::<SubagentClose>(params).await
            };
            let _ = this.update(cx, |this, cx| {
                this.subagents.busy.remove(&id);
                this.subagents.epoch = this.subagents.epoch.wrapping_add(1);
                if let Err(e) = result {
                    this.subagents.error = Some(e.to_string());
                }
                this.refresh_subagents(cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn child_rows(&self, rows: Vec<Subagent>, cx: &mut Context<Self>) -> Div {
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let mut list = div().flex().flex_col().gap(px(4.0));
        for agent in rows {
            let id = agent.agent_id.clone();
            let open_id = id.clone();
            let reopen = agent.status == SubagentStatus::Closed;
            let busy = self.subagents.busy.contains(&id);
            list = list.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(
                        div()
                            .id(SharedString::from(format!("child-open-{id}")))
                            .flex_1()
                            .min_w_0()
                            .cursor_pointer()
                            .child(
                                div()
                                    .text_size(px(TEXT_SM))
                                    .child(truncate(agent.task.clone())),
                            )
                            .child(div().text_size(px(TEXT_XS)).muted(p).child(format!(
                                    "{}{}{}",
                                    label(&agent, english),
                                    agent
                                        .role
                                        .as_ref()
                                        .map(|r| format!(" · {}", r.name))
                                        .unwrap_or_default(),
                                    if agent.fork_context {
                                        if english {
                                            " · inherited context"
                                        } else {
                                            " · 继承上下文"
                                        }
                                    } else {
                                        ""
                                    }
                                )))
                            .children(agent.error.as_ref().map(|e| {
                                div()
                                    .text_size(px(TEXT_XS))
                                    .text_color(p.c(Token::Destructive))
                                    .child(e.clone())
                            }))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.settings = None;
                                this.select(open_id.clone(), cx);
                            })),
                    )
                    .child(
                        outline_button(SharedString::from(format!("child-close-{id}")), p)
                            .when(busy, |d| d.opacity(0.5))
                            .child(if busy {
                                if english {
                                    "Please wait…"
                                } else {
                                    "请稍候…"
                                }
                            } else if reopen {
                                if english { "Resume" } else { "恢复" }
                            } else {
                                if english { "Close" } else { "关闭" }
                            })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.child_action(id.clone(), reopen, cx)
                            })),
                    ),
            );
        }
        list
    }
    pub(super) fn subagents_pane(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        if !self.subagents.config_loaded {
            return div()
                .text_size(px(TEXT_SM))
                .muted(p)
                .child(self.subagents.error.clone().unwrap_or_else(|| {
                    if english {
                        "Loading sub-agent settings…"
                    } else {
                        "正在读取子 Agent 设置…"
                    }
                    .into()
                }))
                .into_any_element();
        }
        let config = self.subagents.config.clone();
        let mut toggled = config.clone();
        toggled.enabled = !toggled.enabled;
        let mut limits = div().flex().items_center().gap(px(6.0)).child(if english {
            "Max per conversation"
        } else {
            "每个对话最多"
        });
        for count in [1, 3, 6, 12, 16] {
            let mut value = config.clone();
            value.max_agents = count;
            limits = limits.child(
                outline_button(SharedString::from(format!("agents-max-{count}")), p)
                    .when(config.max_agents == count, |d| d.bg(p.c(Token::Accent)))
                    .child(count.to_string())
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.save_subagent_config(value.clone(), cx)
                    })),
            );
        }
        let mut depth = div().flex().items_center().gap(px(6.0)).child(if english {
            "Delegation depth"
        } else {
            "委派层数"
        });
        for count in [1, 2, 3] {
            let mut value = config.clone();
            value.max_depth = count;
            depth = depth.child(
                outline_button(SharedString::from(format!("agents-depth-{count}")), p)
                    .when(config.max_depth == count, |d| d.bg(p.c(Token::Accent)))
                    .child(count.to_string())
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.save_subagent_config(value.clone(), cx)
                    })),
            );
        }
        div().flex().flex_col().gap(px(16.0)).text_size(px(TEXT_SM))
            .child(card(p).p(px(16.0)).gap(px(16.0))
                .child(div().flex().items_center().justify_between().child(if english { "Allow sub-agents" } else { "允许子 Agent" })
                    .child(switch("agents-enabled".into(), config.enabled, p).on_click(cx.listener(move |this, _, _, cx| this.save_subagent_config(toggled.clone(), cx)))))
                .child(div().text_size(px(TEXT_XS)).muted(p).child(if english { "Sub-agents can use an independent context or fork the parent, inheriting its project, skills, and model. They share the workspace; stopping the parent stops its children. Closed tasks remain available to inspect or resume." } else { "子 Agent 可使用独立上下文或派生父对话，并继承项目、技能与模型配置。共享工作区；父任务停止会停止其子任务。关闭后可查看记录或显式恢复。" }))
                .child(limits).child(depth)
                .child(div().text_size(px(TEXT_XS)).muted(p).child(if english { "The limit counts non-closed sub-agents. Closing one frees a slot; changing the limit does not interrupt existing tasks." } else { "上限计算未关闭的子 Agent。关闭释放名额；修改限制不会中断已有任务。" })))
            .child(self.roles_pane(cx))
            .children(self.subagents.error.as_ref().map(|e| div().text_color(p.c(Token::Destructive)).child(e.clone())))
            .child(card(p).p(px(16.0)).gap(px(10.0)).child(if self.selected.is_some() { if english { "Subtasks in this conversation" } else { "当前对话的子任务" } } else { if english { "Recent subtasks (up to 100)" } else { "最近的子任务（最多 100 条）" } })
                .when(self.subagents.agents.is_empty(), |d| d.child(div().muted(p).child(if self.subagents.loading { if english { "Loading…" } else { "正在读取…" } } else { if english { "No subtasks" } else { "暂无子任务" } })))
                .child(self.child_rows(self.subagents.agents.clone(), cx)))
            .into_any_element()
    }
    pub(super) fn subagent_tray(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let selected = self.selected.as_ref()?;
        let child = self
            .subagents
            .agents
            .iter()
            .find(|a| &a.agent_id == selected);
        let root = child.map(|a| &a.root_thread_id).unwrap_or(selected);
        let agents: Vec<_> = self
            .subagents
            .agents
            .iter()
            .filter(|a| &a.root_thread_id == root)
            .cloned()
            .collect();
        if agents.is_empty() {
            return None;
        }
        let count = agents
            .iter()
            .filter(|a| a.status == SubagentStatus::Running)
            .count();
        let waiting = agents.iter().filter(|a| a.waiting_for_input).count();
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let root_id = root.clone();
        let fold_id = root.clone();
        let stop_id = root.clone();
        let open = self.subagents.open.as_ref() == Some(root);
        let mut tray = div()
            .mb(px(8.0))
            .rounded(px(12.0))
            .border_1()
            .border_color(p.c(Token::Border))
            .bg(p.c(Token::Card))
            .flex()
            .flex_col()
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .px(px(10.0))
                    .py(px(6.0))
                    .child(
                        div()
                            .id("child-tray-toggle")
                            .cursor_pointer()
                            .flex_1()
                            .text_size(px(TEXT_XS))
                            .child(format!(
                                "{}{} · {count} {}{}",
                                if open { "⌄" } else { "›" },
                                if english { " Subtasks" } else { " 子任务" },
                                if english { "running" } else { "个执行中" },
                                if waiting > 0 {
                                    if english {
                                        format!(" · {waiting} waiting")
                                    } else {
                                        format!(" · {waiting} 个等待输入")
                                    }
                                } else {
                                    String::new()
                                }
                            ))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.subagents.open =
                                    if open { None } else { Some(fold_id.clone()) };
                                cx.notify();
                            })),
                    )
                    .when(count > 0, |d| {
                        d.child(
                            outline_button("child-stop-all", p)
                                .child(if english { "Stop all" } else { "停止全部" })
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.stop_children(stop_id.clone(), cx)
                                })),
                        )
                    })
                    .children(child.map(|_| {
                        outline_button("child-back", p)
                            .child(if english {
                                "Back to main chat"
                            } else {
                                "返回主对话"
                            })
                            .on_click(
                                cx.listener(move |this, _, _, cx| this.select(root_id.clone(), cx)),
                            )
                    })),
            );
        if let Some(error) = &self.subagents.error {
            tray = tray.child(
                div()
                    .px(px(10.0))
                    .pb(px(6.0))
                    .text_size(px(TEXT_XS))
                    .text_color(p.c(Token::Destructive))
                    .child(error.clone()),
            );
        }
        if open {
            tray = tray.child(
                div()
                    .id("child-tray-list")
                    .max_h(px(220.0))
                    .overflow_y_scroll()
                    .p(px(10.0))
                    .child(self.child_rows(agents, cx)),
            );
        }
        Some(tray.into_any_element())
    }
}
