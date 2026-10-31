//! 会话资源: the conversation's own facts, docked beside the reading column (or, on a window
//! without the room, in a popover under the header button). The five groups are the Electron
//! panel's: 环境, 任务清单, 子代理, 最近产出, 工作区变更 — a flat list of rows separated by
//! hairlines, not a stack of cards.
//!
//! Everything the panel shows is read from state the app already holds (the thread view, the
//! subagent registry, the git poller); the only reader of its own is the per-root git status,
//! refreshed while the panel is visible. Native has no DAG, so that group does not exist here.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use super::Workspace;
use crate::ui::px;
use crate::ui::{Muted as _, TEXT_SM, TEXT_XS, icon, icon_button_xs, truncate};
use crate::view_model::ThreadView;
use fv_protocol::methods::WorkspaceGitStatus;
use fv_protocol::subagents::{Subagent, SubagentStatus};
use fv_protocol::types::{AppSettingsPatch, CwdParams, GitStatus, Item, PlanStatus};
use fv_theme::Token;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

/// The panel's fixed width, both presentations (Electron's `w-[300px]`).
const WIDTH: f32 = 300.0;
/// How often the 工作区变更 rows are re-read while the panel is on screen — the header chip's
/// own 5s cadence, so the two never disagree for long.
const GIT_REFRESH: Duration = Duration::from_secs(5);

/// Which collapsible group a row belongs to. A group the reader has not touched is open, except
/// the todo list (Electron's `defaultOpen={false}`).
const SEC_ENVIRONMENT: &str = "environment";
const SEC_TODOS: &str = "todos";
const SEC_AGENTS: &str = "agents";
const SEC_OUTPUTS: &str = "outputs";
const SEC_CHANGES: &str = "changes";
/// The 「已结束 n 项」 fold inside 子代理.
const SEC_FINISHED_AGENTS: &str = "finished-agents";

#[derive(Default)]
pub(super) struct Resources {
    /// The conversation whose transient popover is open (the narrow form).
    popover_for: Option<String>,
    /// Whether the last render found room for the docked panel. Kept so the git tick can ask
    /// without a window of its own.
    docked: bool,
    /// Which collapsible groups are open.
    open: HashSet<&'static str>,
    /// 「展开更多（n）」 inside 子代理 / 已结束 / 最近产出.
    more_agents: bool,
    more_finished_agents: bool,
    more_outputs: bool,
    /// Per-root git status, keyed by the repository root.
    git: HashMap<String, GitStatus>,
    git_loaded_at: Option<Instant>,
    git_epoch: u64,
    /// 「已复制路径」 shown for a moment after the working-directory row is copied.
    copied_at: Option<Instant>,
}

impl Resources {
    pub(super) fn new() -> Self {
        Self {
            open: HashSet::from([SEC_ENVIRONMENT, SEC_AGENTS, SEC_OUTPUTS, SEC_CHANGES]),
            ..Default::default()
        }
    }

    pub(super) fn conversation_changed(&mut self) {
        self.popover_for = None;
        self.git.clear();
        self.git_loaded_at = None;
        self.git_epoch = self.git_epoch.wrapping_add(1);
    }

    fn section_open(&self, key: &str, _default: bool) -> bool {
        if key == SEC_TODOS {
            // The todo list starts collapsed, and its toggle only ever flips this key.
            self.open.contains(SEC_TODOS)
        } else {
            self.open.contains(key)
        }
    }

    fn toggle_section(&mut self, key: &'static str) {
        if !self.open.remove(key) {
            self.open.insert(key);
        }
    }
}

/// One file the conversation produced, with the turn that produced it (for 跳转到消息).
struct OutputEntry {
    path: String,
    turn: usize,
    item: String,
}

impl Workspace {
    // ---- visibility

    /// A conversation is on screen with its view loaded; the panel is meaningless without it.
    fn resources_enabled(&self) -> bool {
        self.selected
            .as_ref()
            .is_some_and(|id| self.views.contains_key(id))
    }

    /// The conversation column has room for a centred 48rem body plus the 300px panel and a
    /// 1rem inset in each gutter — Electron's `calc(50rem + 600px)` probe, which scales with
    /// the interface font size exactly as the rem-sized probe there does.
    fn resources_docked(&self, viewport: f32) -> bool {
        let column = (viewport - self.sidebar_motion.width - self.pane_motion.width).max(0.0);
        let font = self.app_settings.ui_font_size as f32;
        column >= 50.0 * font + 600.0
    }

    /// The docked panel is drawn (the saved preference is on and there is a conversation).
    fn resources_show_docked(&self) -> bool {
        self.resources_enabled() && self.app_settings.resource_panel_open
    }

    /// The transient popover is open for the conversation on screen.
    pub(super) fn resources_popover_open(&self) -> bool {
        self.resources_enabled()
            && self
                .resources
                .popover_for
                .as_ref()
                .is_some_and(|id| Some(id) == self.selected.as_ref())
    }

    /// Anything of the panel is visible: the git reader only runs while it is.
    fn resources_visible(&self) -> bool {
        (self.resources_show_docked() && self.resources.docked) || self.resources_popover_open()
    }

    // ---- interactions

    /// The header button: the docked form is the preference itself; the popover form opens for
    /// this conversation and remembers that it was wanted. Only deliberate presses write the
    /// setting — navigation and layout changes dismiss transiently.
    pub(super) fn toggle_resources(&mut self, viewport: f32, cx: &mut Context<Self>) {
        if !self.resources_enabled() {
            return;
        }
        let docked = self.resources_docked(viewport);
        if docked {
            self.remember_resources_open(!self.app_settings.resource_panel_open, cx);
        } else if self.resources_popover_open() {
            self.resources.popover_for = None;
            self.remember_resources_open(false, cx);
        } else {
            let id = self.selected.clone().expect("checked above");
            self.resources.popover_for = Some(id);
            self.remember_resources_open(true, cx);
            self.load_resources_git(cx);
            cx.notify();
        }
    }

    /// An intentional close (Escape, a click outside, the trigger): the preference records it,
    /// so a window that had the room does not bring the panel back on its own.
    pub(super) fn close_resources_popover(&mut self, persist: bool, cx: &mut Context<Self>) {
        if self.resources.popover_for.take().is_some() && persist {
            self.remember_resources_open(false, cx);
        }
        cx.notify();
    }

    fn remember_resources_open(&mut self, value: bool, cx: &mut Context<Self>) {
        if self.app_settings.resource_panel_open != value {
            self.patch_settings(
                AppSettingsPatch {
                    resource_panel_open: Some(value),
                    ..Default::default()
                },
                cx,
            );
        }
    }

    /// A click anywhere outside the popover: the same deliberate close as Escape.
    pub(super) fn outside_press(&mut self, cx: &mut Context<Self>) {
        if self.resources_popover_open() {
            self.close_resources_popover(true, cx);
        }
        self.close_menus(cx);
    }

    /// 跳转到消息: scroll the transcript to the turn that produced a file, its folds opened so
    /// the call is visible. The maximised pane steps down first, as the Electron jump does.
    fn resources_jump(&mut self, turn_id: String, cx: &mut Context<Self>) {
        let Some(id) = self.selected.clone() else {
            return;
        };
        if self.side_pane_maximized {
            self.side_pane_maximized = false;
        }
        let Some(view) = self.views.get(&id) else {
            return;
        };
        let Some(turn) = view.turns.iter().find(|t| t.id == turn_id) else {
            return;
        };
        self.open_folds.insert(turn.id.clone());
        for item in &turn.items {
            if matches!(item, Item::ToolCall { .. }) {
                self.open_items
                    .insert(crate::view_model::item_id(item).to_string());
                self.open_items
                    .insert(format!("run:{}", crate::view_model::item_id(item)));
            }
        }
        self.jump_turn = Some((id, turn_id));
        self.search_jump_pending = true;
        self.resources.popover_for = None;
        cx.notify();
    }

    /// The git poller's tick: while the panel is visible, keep 工作区变更 and the branch row
    /// current; invisible, it reads nothing.
    pub(super) fn resources_git_tick(&mut self, cx: &mut Context<Self>) {
        if !self.resources_visible() {
            return;
        }
        if self
            .resources
            .git_loaded_at
            .is_none_or(|at| at.elapsed() >= GIT_REFRESH)
        {
            self.load_resources_git(cx);
        }
    }

    /// Read every root of the conversation on screen once; a late answer for a conversation the
    /// user has already left is dropped.
    fn load_resources_git(&mut self, cx: &mut Context<Self>) {
        let (Some(id), Some(backend)) = (self.selected.clone(), self.backend.clone()) else {
            return;
        };
        let roots = self.project_roots_for(&id);
        if roots.is_empty() {
            return;
        }
        self.resources.git_loaded_at = Some(Instant::now());
        let epoch = self.resources.git_epoch.wrapping_add(1);
        self.resources.git_epoch = epoch;
        // Roots no longer part of the conversation are dropped rather than read again.
        self.resources.git.retain(|root, _| roots.contains(root));
        cx.spawn(async move |this, cx| {
            let reads = roots
                .into_iter()
                .map(|root| {
                    let backend = backend.clone();
                    async move {
                        let status = backend
                            .call::<WorkspaceGitStatus>(CwdParams { cwd: root.clone() })
                            .await;
                        (root, status)
                    }
                })
                .collect::<Vec<_>>();
            let results = futures_util::future::join_all(reads).await;
            this.update(cx, |this, cx| {
                if this.resources.git_epoch != epoch || this.selected.as_deref() != Some(&id) {
                    return;
                }
                for (root, status) in results {
                    if let Ok(status) = status {
                        this.resources.git.insert(root, status);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn refresh_resource_repositories(&mut self, cx: &mut Context<Self>) {
        if self.resources_visible() {
            self.load_resources_git(cx);
        }
    }

    // ---- data

    /// The checklist the panel may draw, under the same rule as the composer's panel: the run is
    /// still working, the list belongs to the newest turn (a newer prompt closes it), and
    /// something is still open.
    fn resources_todo<'a>(
        &self,
        view: &'a ThreadView,
    ) -> Option<&'a fv_protocol::types::PlanUpdated> {
        let plan = view.plan.as_ref()?;
        let current_turn = view.turns.last()?;
        if current_turn.id != plan.turn_id || !view.running {
            return None;
        }
        let open = plan
            .plan
            .iter()
            .any(|s| !matches!(s.status, PlanStatus::Completed));
        open.then_some(plan)
    }

    /// The conversation's child agents, as the registry lists them for this root. Native's
    /// registry is server-backed and refreshed on every conversation switch, so it is the one
    /// source (the Electron panel also reads the transcript because its registry is volatile).
    fn resources_agents(&self) -> Vec<Subagent> {
        let Some(selected) = self.selected.as_ref() else {
            return Vec::new();
        };
        let root = self
            .subagents
            .agents
            .iter()
            .find(|a| &a.agent_id == selected)
            .map(|a| &a.root_thread_id)
            .unwrap_or(selected);
        self.subagents
            .agents
            .iter()
            .filter(|a| &a.root_thread_id == root)
            .cloned()
            .collect()
    }

    /// The files this conversation produced, newest first: successful edit/write calls and the
    /// paths they named, relative paths resolved against the conversation's directory. The same
    /// source the turn's own change chips read (`apply_patch`), plus the write-shaped names a
    /// tool or an MCP server may use.
    fn resources_outputs(&self, view: &ThreadView) -> Vec<OutputEntry> {
        crate::conversation_resources::outputs(&view.turns, view.thread.cwd.as_deref())
            .into_iter()
            .filter_map(|output| {
                let turn = view.turns.iter().position(|turn| turn.id == output.turn)?;
                Some(OutputEntry {
                    item: output.path.clone(),
                    path: output.path,
                    turn,
                })
            })
            .collect()
    }

    // ---- rendering

    /// The panel's two presentations, as children of the conversation column: the docked card
    /// (absolute, top-right of the column) and, when there is no room, the popover under the
    /// header button. Also clears the transient popover when the room appears or disappears.
    pub(super) fn resources_elements(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let viewport = f32::from(window.viewport_size().width);
        let docked = self.resources_docked(viewport);
        if docked != self.resources.docked {
            self.resources.docked = docked;
            self.resources.popover_for = None;
        }
        if !self.resources_enabled() {
            self.resources.popover_for = None;
            return Vec::new();
        }
        self.resources_git_tick(cx);
        if !docked && self.resources_popover_open() && self.resources.git_loaded_at.is_none() {
            self.load_resources_git(cx);
        }
        let mut out = Vec::new();
        if docked && self.resources_show_docked() {
            let height = f32::from(window.viewport_size().height);
            out.push(self.resources_card(height, false, cx).into_any_element());
        }
        if !docked && self.resources_popover_open() {
            let height = f32::from(window.viewport_size().height);
            out.push(crate::ui::float(self.resources_card(height, true, cx)).into_any_element());
        }
        if let Some(at) = self.resources.copied_at
            && at.elapsed() < Duration::from_millis(1500)
        {
            out.push(self.resources_copied_notice(cx).into_any_element());
        }
        out
    }

    /// One panel surface: the body with its five groups inside a 300px column, the scroll capped
    /// at `min(75vh, 42rem)` exactly as the Electron panel caps it.
    fn resources_card(
        &mut self,
        viewport_height: f32,
        popover: bool,
        cx: &mut Context<Self>,
    ) -> Div {
        let p = self.palette.clone();
        let max_h = (viewport_height * 0.75).min(672.0);
        let fill = if popover { p.overlay() } else { p.pane() };
        let card = div()
            .id("resources-panel")
            .role(Role::Complementary)
            .aria_label(trs!(self.english(), "resources.title"))
            .w(px(WIDTH))
            .max_w(relative(1.0))
            .flex_none()
            .flex()
            .flex_col()
            .overflow_hidden()
            .bg(fill)
            .text_color(p.c(Token::SidebarForeground))
            .text_size(px(TEXT_SM));
        let card = if popover {
            card.rounded(px(14.0))
                .border_1()
                .border_color(p.c(Token::Border))
        } else {
            card.rounded(px(14.0))
                .border_1()
                .border_color(p.c(Token::SidebarBorder).opacity(
                    if p.get(Token::GlassShade).is_some() {
                        0.0
                    } else {
                        1.0
                    },
                ))
        };
        let position = if popover {
            div().absolute().top(px(52.0)).right(px(8.0))
        } else {
            div().absolute().top(px(48.0)).right(px(16.0))
        };
        position
            .max_h(px((viewport_height - 64.0).max(0.0)))
            .flex()
            .flex_col()
            .occlude()
            .child(
                card.child(
                    div()
                        .id("resources-scroll")
                        .min_h_0()
                        .max_h(px(max_h))
                        .overflow_y_scroll()
                        .px(px(12.0))
                        .py(px(8.0))
                        .flex()
                        .flex_col()
                        .child(self.resources_body(cx)),
                ),
            )
    }

    /// The 「已复制路径」 note that follows a copy, bottom-right of the column for a moment.
    fn resources_copied_notice(&self, cx: &mut Context<Self>) -> Deferred {
        let p = self.palette.clone();
        let english = self.english();
        let note = crate::ui::overlay_surface(div(), 10.0, &p)
            .absolute()
            .bottom(px(24.0))
            .right(px(16.0))
            .px(px(10.0))
            .py(px(6.0))
            .text_color(p.c(Token::PopoverForeground))
            .text_size(px(TEXT_XS))
            .child(trs!(english, "resources.copied"));
        let _ = cx;
        deferred(note.occlude()).with_priority(10)
    }

    /// The five groups, top to bottom, separated by hairlines.
    fn resources_body(&mut self, cx: &mut Context<Self>) -> Div {
        let p = self.palette.clone();
        let english = self.english();
        let id = self.selected.clone();
        let owned_view = id.as_ref().and_then(|id| self.views.get(id)).cloned();
        let view = owned_view.as_ref();
        let mut body = div().w_full().flex().flex_col();

        // 环境: host, working directory, branch.
        let thread = view.map(|v| v.thread.clone());
        if let Some(thread) = thread.clone() {
            let mut section = self.resources_section(
                SEC_ENVIRONMENT,
                trs!(english, "resources.environment"),
                None,
                true,
                cx,
            );
            if self.resources.section_open(SEC_ENVIRONMENT, true) {
                section = section
                    .child(self.resources_host_row())
                    .children(
                        thread
                            .cwd
                            .clone()
                            .map(|cwd| self.resources_cwd_row(cwd, cx)),
                    )
                    .children(self.resources_branch_row(&thread, cx));
            }
            body = body.child(section);
        }

        // 任务清单.
        if let Some(view) = view
            && let Some(plan) = self.resources_todo(view)
        {
            let done = plan
                .plan
                .iter()
                .filter(|s| matches!(s.status, PlanStatus::Completed))
                .count();
            let summary: String = tr!(
                english,
                "resources.progress",
                done = done,
                total = plan.plan.len()
            );
            let mut section = self.resources_section(
                SEC_TODOS,
                trs!(english, "resources.todos"),
                Some(summary),
                false,
                cx,
            );
            if !self.resources.section_open(SEC_TODOS, false) {
                if let Some(current) = active_plan_step(&plan.plan) {
                    section =
                        section.child(plan_step_row("resources-todo-current", current, &p, true));
                }
            } else {
                let mut rows = div().px(px(8.0)).flex().flex_col().gap(px(2.0));
                for (n, step) in plan.plan.iter().enumerate() {
                    rows = rows.child(plan_step_row(
                        SharedString::from(format!("resources-todo-{n}")),
                        step,
                        &p,
                        false,
                    ));
                }
                section = section.child(rows);
            }
            body = body.child(section);
        }

        // 子代理.
        let agents = self.resources_agents();
        if !agents.is_empty() {
            let (active, finished): (Vec<_>, Vec<_>) =
                agents.into_iter().partition(|a| !agent_finished(a));
            let mut section = self.resources_section(
                SEC_AGENTS,
                trs!(english, "resources.agents"),
                Some(active.len().to_string()),
                true,
                cx,
            );
            if self.resources.section_open(SEC_AGENTS, true) {
                let shown = if self.resources.more_agents {
                    active.len()
                } else {
                    active.len().min(5)
                };
                for agent in active.iter().take(shown) {
                    section = section.child(self.resources_agent_row(agent, cx));
                }
                if active.len() > 5 {
                    section = section.child(self.resources_more_row(
                        "resources-more-agents",
                        active.len() - 5,
                        self.resources.more_agents,
                        &p,
                        cx,
                    ));
                }
                if !finished.is_empty() {
                    let fold_key = SEC_FINISHED_AGENTS;
                    let fold_open = self.resources.open.contains(fold_key);
                    let count = finished.len();
                    let mut fold = div().id("resources-finished").flex().flex_col().child(
                        div()
                            .id("resources-finished-toggle")
                            .min_h(px(32.0))
                            .px(px(8.0))
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .rounded(px(6.0))
                            .cursor_pointer()
                            .hover({
                                let hover = p.c(Token::SidebarAccent);
                                move |d| d.bg(hover)
                            })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.resources.toggle_section(SEC_FINISHED_AGENTS);
                                cx.notify();
                            }))
                            .child(crate::ui::chevron(
                                fold_open,
                                12.0,
                                p.c(Token::MutedForeground).opacity(0.6),
                            ))
                            .child(div().text_size(px(TEXT_XS)).muted(&p).child(tr!(
                                english,
                                "resources.finished",
                                count = count
                            ))),
                    );
                    if fold_open {
                        let shown = if self.resources.more_finished_agents {
                            finished.len()
                        } else {
                            finished.len().min(5)
                        };
                        let mut rows = div().flex().flex_col();
                        for agent in finished.iter().take(shown) {
                            rows = rows.child(self.resources_agent_row(agent, cx));
                        }
                        fold = fold.child(rows);
                        if finished.len() > 5 {
                            fold = fold.child(self.resources_more_row(
                                "resources-more-finished",
                                finished.len() - 5,
                                self.resources.more_finished_agents,
                                &p,
                                cx,
                            ));
                        }
                    }
                    section = section.child(fold);
                }
            }
            body = body.child(section);
        }

        // 最近产出.
        if let Some(view) = view {
            let outputs = self.resources_outputs(view);
            if !outputs.is_empty() {
                let total = outputs.len();
                let mut section = self.resources_section(
                    SEC_OUTPUTS,
                    trs!(english, "resources.outputs"),
                    Some(total.to_string()),
                    true,
                    cx,
                );
                if self.resources.section_open(SEC_OUTPUTS, true) {
                    let shown = if self.resources.more_outputs {
                        total
                    } else {
                        total.min(5)
                    };
                    for output in outputs.iter().take(shown) {
                        section = section.child(self.resources_output_row(output, cx));
                    }
                    if total > 5 {
                        section = section.child(self.resources_more_row(
                            "resources-more-outputs",
                            total - 5,
                            self.resources.more_outputs,
                            &p,
                            cx,
                        ));
                    }
                }
                body = body.child(section);
            }
        }

        // 工作区变更.
        if let Some(id) = id.as_ref() {
            let roots = self.project_roots_for(id);
            let rows: Vec<(String, GitStatus)> = roots
                .iter()
                .filter_map(|root| {
                    self.resources
                        .git
                        .get(root)
                        .map(|s| (root.clone(), s.clone()))
                })
                .filter(|(_, s)| s.is_repository)
                .collect();
            if !rows.is_empty() {
                let mut section = self.resources_section(
                    SEC_CHANGES,
                    trs!(english, "resources.changes"),
                    None,
                    true,
                    cx,
                );
                if self.resources.section_open(SEC_CHANGES, true) {
                    for (root, status) in rows {
                        section = section.child(self.resources_repo_row(&root, &status, cx));
                    }
                }
                body = body.child(section);
            }
        }

        body
    }

    /// One group's header (title, right-aligned summary, the turning chevron) and whatever is
    /// inside it. `default` is the open state before the reader has touched the group.
    fn resources_section(
        &mut self,
        key: &'static str,
        title: &'static str,
        summary: Option<String>,
        default: bool,
        cx: &mut Context<Self>,
    ) -> Div {
        let p = self.palette.clone();
        let open = self.resources.section_open(key, default);
        let mut section = div()
            .when(key != SEC_ENVIRONMENT, |d| {
                d.border_t_1()
                    .border_color(p.c(Token::SidebarBorder).opacity(0.5))
            })
            .py(px(8.0))
            .flex()
            .flex_col()
            .child(
                div()
                    .id(SharedString::from(format!("resources-section-{key}")))
                    .min_h(px(32.0))
                    .w_full()
                    .px(px(8.0))
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .rounded(px(6.0))
                    .cursor_pointer()
                    .text_color(p.c(Token::MutedForeground))
                    .hover({
                        let hover = p.c(Token::SidebarAccent);
                        move |d| d.bg(hover)
                    })
                    .child(div().flex_1().min_w_0().child(truncate(title)))
                    .children(summary.map(|s| {
                        div()
                            .text_size(px(TEXT_XS))
                            .font_family(crate::assets::MONO_FONT)
                            .child(s)
                    }))
                    .child(crate::ui::chevron(
                        open,
                        12.0,
                        p.c(Token::MutedForeground).opacity(0.6),
                    ))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.resources.toggle_section(key);
                        cx.notify();
                    })),
            );
        if open {
            section = section.child(div().flex().flex_col().mt(px(2.0)).mb(px(2.0)));
        }
        section
    }

    fn resources_host_row(&self) -> Div {
        let p = &self.palette;
        div()
            .flex()
            .items_center()
            .gap(px(8.0))
            .min_h(px(32.0))
            .px(px(8.0))
            .py(px(6.0))
            .child(icon("computer", 16.0, p.c(Token::MutedForeground)))
            .child(truncate(self.ssh_host.as_ref().map_or_else(
                || trs!(self.english(), "resources.local").to_string(),
                |host| format!("{host} (SSH)"),
            )))
    }

    /// The working directory: click copies it; the copy is confirmed by the note in the corner.
    fn resources_cwd_row(&mut self, cwd: String, cx: &mut Context<Self>) -> Stateful<Div> {
        let p = self.palette.clone();
        let copy = cwd.clone();
        div()
            .id("resources-cwd")
            .min_h(px(32.0))
            .w_full()
            .px(px(8.0))
            .py(px(6.0))
            .flex()
            .items_center()
            .gap(px(8.0))
            .rounded(px(6.0))
            .cursor_pointer()
            .tooltip({
                let text = cwd.clone();
                move |window, cx| {
                    gpui_kit::component::tooltip::Tooltip::new(text.clone()).build(window, cx)
                }
            })
            .hover({
                let hover = p.c(Token::SidebarAccent);
                move |d| d.bg(hover)
            })
            .child(icon("folder01", 16.0, p.c(Token::MutedForeground)))
            .child(truncate(cwd.clone()).flex_1())
            .child(icon(
                "copy01",
                14.0,
                p.c(Token::MutedForeground).opacity(0.6),
            ))
            .on_click(cx.listener(move |this, _, _, cx| {
                cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(copy.clone()));
                this.resources.copied_at = Some(Instant::now());
                cx.notify();
                let clear = cx.spawn(async move |this, cx| {
                    cx.background_executor()
                        .timer(Duration::from_millis(1600))
                        .await;
                    this.update(cx, |this, cx| {
                        this.resources.copied_at = None;
                        cx.notify();
                    })
                    .ok();
                });
                clear.detach();
            }))
    }

    /// The branch row: it opens the changes view on this repository, and names the isolated
    /// checkout when the conversation runs in one.
    fn resources_branch_row(
        &mut self,
        thread: &fv_protocol::types::Thread,
        cx: &mut Context<Self>,
    ) -> Option<Stateful<Div>> {
        let cwd = thread.cwd.clone()?;
        let status = self.resources.git.get(&cwd).or_else(|| {
            self.header_git
                .status
                .as_ref()
                .filter(|_| self.header_git.cwd.as_deref() == Some(cwd.as_str()))
        })?;
        let branch = status
            .is_repository
            .then(|| status.branch.clone())
            .flatten()?;
        let p = self.palette.clone();
        let open_cwd = cwd.clone();
        Some(
            div()
                .id("resources-branch")
                .min_h(px(32.0))
                .w_full()
                .px(px(8.0))
                .py(px(6.0))
                .flex()
                .items_center()
                .gap(px(8.0))
                .rounded(px(6.0))
                .cursor_pointer()
                .hover({
                    let hover = p.c(Token::SidebarAccent);
                    move |d| d.bg(hover)
                })
                .child(icon("git-branch", 16.0, p.c(Token::MutedForeground)))
                .child(truncate(branch).flex_1())
                .children(thread.worktree.as_ref().map(|_| {
                    div()
                        .ml_4()
                        .flex_none()
                        .text_size(px(TEXT_XS))
                        .muted(&p)
                        .child(trs!(self.english(), "resources.worktree"))
                }))
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.resources_open_git(open_cwd.clone(), window, cx);
                })),
        )
    }

    /// A repository of 工作区变更: its name, branch and change count, opening the changes view.
    fn resources_repo_row(
        &mut self,
        root: &str,
        status: &GitStatus,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let p = self.palette.clone();
        let english = self.english();
        let name = root.rsplit('/').next().unwrap_or(root).to_string();
        let branch = status.branch.clone().unwrap_or_else(|| "HEAD".into());
        let counts: String = if status.changed > 0 {
            tr!(english, "resources.changed_count", count = status.changed)
        } else {
            trs!(english, "resources.clean").into()
        };
        let meta = format!("{branch} · {counts}");
        let open_root = root.to_string();
        let status = status.clone();
        div()
            .id(SharedString::from(format!(
                "resources-repo-{}",
                root.replace('/', "_")
            )))
            .min_h(px(32.0))
            .w_full()
            .px(px(8.0))
            .py(px(6.0))
            .flex()
            .items_center()
            .gap(px(8.0))
            .rounded(px(6.0))
            .cursor_pointer()
            .tooltip({
                let text = root.to_string();
                move |window, cx| {
                    gpui_kit::component::tooltip::Tooltip::new(text.clone()).build(window, cx)
                }
            })
            .hover({
                let hover = p.c(Token::SidebarAccent);
                move |d| d.bg(hover)
            })
            .child(icon("git-compare", 16.0, p.c(Token::MutedForeground)))
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .child(truncate(name).text_size(px(TEXT_SM)))
                    .child(truncate(meta).text_size(px(TEXT_XS)).muted(&p)),
            )
            .children((status.changed > 0).then(|| {
                div()
                    .flex_none()
                    .flex()
                    .gap(px(6.0))
                    .text_size(px(TEXT_XS))
                    .font_family(crate::assets::MONO_FONT)
                    .child(
                        div()
                            .text_color(p.c(Token::Success))
                            .child(format!("+{}", status.additions)),
                    )
                    .child(
                        div()
                            .text_color(p.c(Token::Destructive))
                            .child(format!("-{}", status.deletions)),
                    )
            }))
            .on_click(cx.listener(move |this, _, window, cx| {
                this.resources_open_git(open_root.clone(), window, cx);
            }))
    }

    /// Open the changes view on one repository: select it in this conversation's git view, then
    /// open the tab (which follows the selected repository).
    fn resources_open_git(&mut self, root: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(conversation) = self.selected.clone() else {
            return;
        };
        let view = self.git_views.entry(conversation).or_default();
        view.set_transcript_owner(None);
        view.select(&root);
        self.resources.popover_for = None;
        self.open_git_tab(window, cx);
    }

    /// One child agent: role, brief, status. A live run sweeps; a waiting or failed one is
    /// warning-tinted. Clicking it switches to the run, as the tray below the composer does.
    fn resources_agent_row(&mut self, agent: &Subagent, cx: &mut Context<Self>) -> Stateful<Div> {
        let p = self.palette.clone();
        let english = self.english();
        let waiting = agent.waiting_for_input;
        let live = !waiting && agent.status == SubagentStatus::Running;
        let attention = waiting || agent.status == SubagentStatus::Failed;
        let label = super::subagents::label(agent, english);
        let name = agent
            .role
            .as_ref()
            .map(|r| r.name.clone())
            .unwrap_or_else(|| trs!(english, "subagents.subagent").to_string());
        let glyph_color = if attention {
            p.c(Token::Warning)
        } else {
            p.c(Token::MutedForeground)
        };
        let open_id = agent.agent_id.clone();
        div()
            .id(SharedString::from(format!(
                "resources-agent-{}",
                agent.agent_id.replace('/', "_")
            )))
            .min_h(px(32.0))
            .w_full()
            .px(px(8.0))
            .py(px(6.0))
            .flex()
            .items_center()
            .gap(px(8.0))
            .rounded(px(6.0))
            .cursor_pointer()
            .tooltip({
                let text = agent.task.clone();
                move |window, cx| {
                    gpui_kit::component::tooltip::Tooltip::new(text.clone()).build(window, cx)
                }
            })
            .hover({
                let hover = p.c(Token::SidebarAccent);
                move |d| d.bg(hover)
            })
            .child(if live {
                crate::ui::spinner(
                    SharedString::from(format!(
                        "resources-agent-run-{}",
                        agent.agent_id.replace('/', "_")
                    )),
                    14.0,
                    p.c(Token::MutedForeground),
                )
                .into_any_element()
            } else {
                icon("bot", 16.0, glyph_color).into_any_element()
            })
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .child(truncate(name).text_size(px(TEXT_SM)))
                    .children((!agent.task.is_empty()).then(|| {
                        truncate(agent.task.clone())
                            .text_size(px(TEXT_XS))
                            .muted(&p)
                    })),
            )
            .child(
                div()
                    .flex_none()
                    .text_size(px(TEXT_XS))
                    .text_color(if attention {
                        p.c(Token::Warning)
                    } else {
                        p.c(Token::MutedForeground)
                    })
                    .child(label),
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                this.resources.popover_for = None;
                this.select(open_id.clone(), cx);
            }))
    }

    /// One produced file: icon and name; the arrow beside it jumps to the message that made it.
    fn resources_output_row(
        &mut self,
        output: &OutputEntry,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let p = self.palette.clone();
        let name = output
            .path
            .rsplit('/')
            .next()
            .unwrap_or(&output.path)
            .to_string();
        let path = output.path.clone();
        let open_path = output.path.clone();
        let turn_id = self
            .selected
            .as_ref()
            .and_then(|id| self.views.get(id))
            .and_then(|view| view.turns.get(output.turn))
            .map(|t| t.id.clone());
        let jump_turn = turn_id.clone();
        let english = self.english();
        div()
            .id(SharedString::from(format!(
                "resources-output-{}",
                output.item.replace('/', "_")
            )))
            .flex()
            .items_center()
            .min_w_0()
            .rounded(px(6.0))
            .group("resources-output")
            .hover({
                let hover = p.c(Token::SidebarAccent);
                move |d| d.bg(hover)
            })
            .child(
                div()
                    .id(SharedString::from(format!(
                        "resources-output-open-{}",
                        output.item.replace('/', "_")
                    )))
                    .flex_1()
                    .min_w_0()
                    .min_h(px(32.0))
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .px(px(8.0))
                    .cursor_pointer()
                    .tooltip(move |window, cx| {
                        gpui_kit::component::tooltip::Tooltip::new(path.clone()).build(window, cx)
                    })
                    .on_click(cx.listener(move |this, _, _, cx| {
                        let (name, path) = (
                            open_path
                                .rsplit('/')
                                .next()
                                .unwrap_or(&open_path)
                                .to_string(),
                            open_path.clone(),
                        );
                        this.resources.popover_for = None;
                        this.pending_open = Some((path, name));
                        cx.notify();
                    }))
                    .child(
                        img(crate::file_icons::path(&name, !p.is_dark()))
                            .size(px(16.0))
                            .flex_none(),
                    )
                    .child(truncate(name)),
            )
            .children(jump_turn.map(|turn| {
                let turn_id = turn.clone();
                icon_button_xs("resources-jump", "arrow-right01", &p)
                    .tooltip(move |window, cx| {
                        gpui_kit::component::tooltip::Tooltip::new(trs!(english, "resources.jump"))
                            .build(window, cx)
                    })
                    .opacity(0.6)
                    .opacity(0.0)
                    .group_hover("resources-output", |d| d.opacity(1.0))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.resources_jump(turn_id.clone(), cx);
                    }))
            }))
    }

    /// 「展开更多（n）」 / 「收起」.
    fn resources_more_row(
        &mut self,
        id: &'static str,
        count: usize,
        expanded: bool,
        p: &crate::theme::Palette,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let english = self.english();
        let p = p.clone();
        let which = match id {
            "resources-more-agents" => 0,
            "resources-more-finished" => 1,
            _ => 2,
        };
        let label: String = if expanded {
            trs!(english, "resources.less").into()
        } else {
            tr!(english, "resources.more", count = count)
        };
        div()
            .id(id)
            .w_full()
            .min_h(px(28.0))
            .px(px(8.0))
            .flex()
            .items_center()
            .rounded(px(6.0))
            .cursor_pointer()
            .text_size(px(TEXT_XS))
            .muted(&p)
            .hover({
                let hover = p.c(Token::SidebarAccent);
                move |d| d.bg(hover)
            })
            .child(label)
            .on_click(cx.listener(move |this, _, _, cx| {
                let value = !this.resources_more_state(which);
                this.resources_set_more_state(which, value);
                cx.notify();
            }))
    }

    fn resources_more_state(&self, which: u8) -> bool {
        match which {
            0 => self.resources.more_agents,
            1 => self.resources.more_finished_agents,
            _ => self.resources.more_outputs,
        }
    }

    fn resources_set_more_state(&mut self, which: u8, value: bool) {
        match which {
            0 => self.resources.more_agents = value,
            1 => self.resources.more_finished_agents = value,
            _ => self.resources.more_outputs = value,
        }
    }
}

/// The step the agent is on: what is in progress, else the next pending one.
fn active_plan_step(
    steps: &[fv_protocol::types::PlanStep],
) -> Option<&fv_protocol::types::PlanStep> {
    steps
        .iter()
        .find(|s| matches!(s.status, PlanStatus::InProgress))
        .or_else(|| {
            steps
                .iter()
                .find(|s| matches!(s.status, PlanStatus::Pending))
        })
}

/// A step of the checklist: ticked, sweeping (the one in play, while the chat works), or an open
/// circle, and the step's words on one line.
fn plan_step_row(
    id: impl Into<ElementId>,
    step: &fv_protocol::types::PlanStep,
    p: &crate::theme::Palette,
    working: bool,
) -> Stateful<Div> {
    let id: ElementId = id.into();
    let done = matches!(step.status, PlanStatus::Completed);
    let active = matches!(step.status, PlanStatus::InProgress);
    let glyph = if done {
        icon("tick02", 12.0, p.c(Token::MutedForeground)).into_any_element()
    } else if active && working {
        crate::ui::spinner(
            SharedString::from(format!("{id:?}-run")),
            12.0,
            p.c(Token::MutedForeground),
        )
        .into_any_element()
    } else {
        div()
            .size(px(8.0))
            .flex_none()
            .rounded_full()
            .when(active, |d| d.bg(p.c(Token::Primary)))
            .border_1()
            .border_color(p.c(Token::MutedForeground).opacity(0.6))
            .into_any_element()
    };
    div()
        .id(id)
        .flex()
        .items_start()
        .gap(px(8.0))
        .min_h(px(28.0))
        .py(px(4.0))
        .child(
            div()
                .flex_none()
                .size(px(16.0))
                .flex()
                .items_center()
                .justify_center()
                .child(glyph),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .text_size(px(TEXT_SM))
                .when(done, |d| d.muted(p))
                .line_height(px(20.0))
                .child(step.step.clone()),
        )
}

/// A run of the 子代理 group that is over: its result has been delivered or it was stopped.
fn agent_finished(a: &Subagent) -> bool {
    matches!(
        a.status,
        SubagentStatus::Completed | SubagentStatus::Interrupted | SubagentStatus::Closed
    )
}
