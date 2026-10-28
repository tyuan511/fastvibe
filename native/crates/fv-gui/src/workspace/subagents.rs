//! A compact child-task tray plus protocol-backed limits and lifecycle controls.
use super::{
    Workspace,
    personalization::{group, outline_sm, rich_row, select_trigger},
    settings::{menu_item, outline_button, popover, setting_row, switch},
};
use crate::ui::px;
use crate::ui::{Muted as _, TEXT_SM, TEXT_XS, icon, truncate};
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
    /// Which count select in 设置 → 子 Agent is open (0 the per-chat limit, 1 the depth).
    menu: Option<u8>,
}
fn label(a: &Subagent, english: bool) -> &'static str {
    if a.waiting_for_input {
        return trs!(english, "subagents.waiting_for_input");
    }
    match a.status {
        SubagentStatus::Idle => {
            trs!(english, "subagents.idle")
        }
        SubagentStatus::Running => {
            trs!(english, "subagents.running")
        }
        SubagentStatus::Completed => {
            trs!(english, "subagents.completed")
        }
        SubagentStatus::Interrupted => {
            trs!(english, "subagents.stopped")
        }
        SubagentStatus::Failed => {
            trs!(english, "subagents.failed")
        }
        SubagentStatus::Closed => {
            trs!(english, "subagents.closed")
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
            self.subagents.error =
                Some(trs!(self.english(), "subagents.this_chat_has_no_side").into());
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
                                        trs!(english, "subagents.inherited_context")
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
                                trs!(english, "subagents.please_wait")
                            } else if reopen {
                                trs!(english, "subagents.resume")
                            } else {
                                trs!(english, "subagents.close")
                            })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.child_action(id.clone(), reopen, cx)
                            })),
                    ),
            );
        }
        list
    }
    /// 设置 → 子 Agent's subtask list: one `SettingsRow` per child, its action on the right.
    fn subtask_rows(&self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let p = &self.palette;
        let english = self.english();
        let mut rows = Vec::new();
        for (i, agent) in self.subagents.agents.iter().enumerate() {
            let id = agent.agent_id.clone();
            let open_id = id.clone();
            let reopen = agent.status == SubagentStatus::Closed;
            let busy = self.subagents.busy.contains(&id);
            let meta = format!(
                "{}{}{}",
                label(agent, english),
                agent
                    .role
                    .as_ref()
                    .map(|r| format!(" · {}", r.name))
                    .unwrap_or_default(),
                if agent.fork_context {
                    trs!(english, "subagents.inherited_context")
                } else {
                    ""
                }
            );
            let desc = div().flex().flex_col().gap(px(2.0)).child(meta).children(
                agent
                    .error
                    .as_ref()
                    .map(|e| div().text_color(p.c(Token::Destructive)).child(e.clone())),
            );
            rows.push(
                rich_row(
                    div()
                        .id(SharedString::from(format!("child-open-{id}")))
                        .cursor_pointer()
                        .child(truncate(agent.task.clone()))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.settings = None;
                            this.select(open_id.clone(), cx);
                        })),
                    Some(desc.into_any_element()),
                    i > 0,
                    p,
                    outline_sm(SharedString::from(format!("child-close-{id}")), p)
                        .when(busy, |d| d.opacity(0.5))
                        .child(if busy {
                            trs!(english, "subagents.please_wait")
                        } else if reopen {
                            trs!(english, "subagents.resume")
                        } else {
                            trs!(english, "subagents.close")
                        })
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.child_action(id.clone(), reopen, cx)
                        })),
                )
                .into_any_element(),
            );
        }
        if rows.is_empty() {
            rows.push(
                div()
                    .px(px(16.0))
                    .py(px(12.0))
                    .text_size(px(TEXT_SM))
                    .muted(p)
                    .child(if self.subagents.loading {
                        trs!(english, "subagents.loading")
                    } else {
                        trs!(english, "subagents.no_subtasks")
                    })
                    .into_any_element(),
            );
        }
        rows
    }

    /// A `Select` over a few counts, saving the config on pick.
    fn count_select(
        &self,
        which: u8,
        values: &[u32],
        current: u32,
        apply: fn(&mut SubagentConfig, u32),
        cx: &mut Context<Self>,
    ) -> Div {
        let p = &self.palette;
        let open = self.subagents.menu == Some(which);
        let hover = p.c(Token::Muted);
        let mut menu = popover(p)
            .absolute()
            .top(px(34.0))
            .right(px(0.0))
            .w(px(176.0));
        for &count in values {
            let mut value = self.subagents.config.clone();
            apply(&mut value, count);
            menu = menu.child(
                menu_item(
                    SharedString::from(format!("agents-{which}-{count}")),
                    current == count,
                    hover,
                )
                .justify_between()
                .child(count.to_string())
                .when(current == count, |d| {
                    d.child(icon("tick02", 14.0, p.c(Token::Foreground)))
                })
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.subagents.menu = None;
                    this.save_subagent_config(value.clone(), cx)
                })),
            );
        }
        div()
            .relative()
            .child(
                select_trigger(
                    SharedString::from(format!("agents-select-{which}")),
                    current.to_string(),
                    176.0,
                    p,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.subagents.menu = if this.subagents.menu == Some(which) {
                        None
                    } else {
                        Some(which)
                    };
                    cx.notify();
                })),
            )
            .when(open, |d| d.child(crate::ui::float(menu)))
    }

    pub(super) fn subagents_pane(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = &self.palette;
        let english = self.english();
        // The capture harness has no host; it draws the defaults a fresh install answers with.
        let loaded =
            self.subagents.config_loaded || (cfg!(feature = "capture") && self.backend.is_none());
        if !loaded {
            return div()
                .text_size(px(TEXT_SM))
                .muted(p)
                .child(self.subagents.error.clone().unwrap_or_else(|| {
                    trs!(english, "subagents.loading_sub_agent_settings").into()
                }))
                .into_any_element();
        }
        let config = self.subagents.config.clone();
        let mut toggled = config.clone();
        toggled.enabled = !toggled.enabled;
        let settings = group(
            None,
            p,
            [
                setting_row(
                    trs!(english, "subagents.allow_sub_agents"),
                    trs!(english, "subagents.allow_desc"),
                    false,
                    p,
                    switch("agents-enabled".into(), config.enabled, p).on_click(cx.listener(
                        move |this, _, _, cx| this.save_subagent_config(toggled.clone(), cx),
                    )),
                )
                .into_any_element(),
                setting_row(
                    trs!(english, "subagents.max_per_conversation"),
                    trs!(english, "subagents.max_desc"),
                    true,
                    p,
                    self.count_select(
                        0,
                        &[1, 3, 6, 12, 16],
                        config.max_agents,
                        |c, n| c.max_agents = n,
                        cx,
                    ),
                )
                .into_any_element(),
                setting_row(
                    trs!(english, "subagents.delegation_depth"),
                    trs!(english, "subagents.depth_desc"),
                    true,
                    p,
                    self.count_select(1, &[1, 2, 3], config.max_depth, |c, n| c.max_depth = n, cx),
                )
                .into_any_element(),
            ],
        );
        div()
            .flex()
            .flex_col()
            .gap(px(28.0))
            .child(settings)
            .child(self.roles_pane(cx))
            .children(self.subagents.error.as_ref().map(|e| {
                div()
                    .text_size(px(TEXT_SM))
                    .text_color(p.c(Token::Destructive))
                    .child(e.clone())
            }))
            .child(group(
                Some(if self.selected.is_some() {
                    trs!(english, "subagents.subtasks_in_this_conversation")
                } else {
                    trs!(english, "subagents.recent_subtasks_up_to_100")
                }),
                p,
                self.subtask_rows(cx),
            ))
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
                                trs!(english, "subagents.subtasks"),
                                trs!(english, "subagents.running_2"),
                                if waiting > 0 {
                                    tr!(english, "subagents.waiting_waiting", waiting = waiting)
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
                                .child(trs!(english, "subagents.stop_all"))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.stop_children(stop_id.clone(), cx)
                                })),
                        )
                    })
                    .children(child.map(|_| {
                        outline_button("child-back", p)
                            .child(trs!(english, "subagents.back_to_main_chat"))
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
